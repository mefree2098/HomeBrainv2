"""Resilient authenticated HomeBrain voice-WebSocket client."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import platform
import random
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .audio import AudioFormatError, PcmRingBuffer, float_audio_to_pcm16_mono
from .config import HomeBrainConfig
from .metadata import version_report
from .package_stage import PackageStageError, PackageStager
from .perception import PresenceMonitor, SnapshotService
from .protocol import ProtocolError, authentication_message, parse_message, utc_timestamp
from .releases import ReleaseError, ReleaseManager
from .robot import RobotController
from .tts import TtsCancelled, TtsError, TtsPlayer
from .version import __version__
from .wakeword import WakeWordRuntime

LOGGER = logging.getLogger(__name__)


class AuthenticationRejected(RuntimeError):
    """HomeBrain rejected the persisted device token."""


class PrivacyConfigurationError(RuntimeError):
    """Reachy's physical privacy state could not be confirmed."""


@dataclass(slots=True)
class _AudioSession:
    session_id: str
    capture_grant_id: str
    deadline: float
    sequence: int = 0


class HomeBrainClient:
    """Own the HomeBrain connection while delegating all hardware access to adapters."""

    def __init__(
        self,
        config: HomeBrainConfig,
        robot: Any,
        controller: RobotController,
        tts: TtsPlayer,
        *,
        connector: Callable[[str], Any] | None = None,
        random_source: random.Random | None = None,
        release_callback: Callable[[str], None] | None = None,
        package_stager: PackageStager | None = None,
        wake_word: WakeWordRuntime | None = None,
        presence: PresenceMonitor | None = None,
        snapshot: SnapshotService | None = None,
        release_manager: ReleaseManager | None = None,
        health_callback: Callable[[str, str, str], dict[str, Any]] | None = None,
        daemon_status_provider: Callable[[], dict[str, Any]] | None = None,
    ):
        self.config = config
        self.robot = robot
        self.controller = controller
        self.tts = tts
        self.connector = connector
        # Pseudo-randomness is used only to jitter reconnect delays, never for credentials.
        self.random = random_source or random.Random()  # nosec B311
        self.release_callback = release_callback
        self.package_stager = package_stager
        self.wake_word = wake_word
        self.presence = presence
        self.snapshot = snapshot
        self.release_manager = release_manager
        self.health_callback = health_callback
        self.daemon_status_provider = daemon_status_provider
        self._daemon_status_lock = threading.Lock()
        self._daemon_status: dict[str, Any] | None = None
        self._daemon_status_at = 0.0
        self._shutdown_policy_lock = threading.Lock()
        self._safe_shutdown_applied = False
        self._update_quiescing = False
        self._prepared_release: tuple[str, str, str] | None = None
        self.websocket: Any = None
        self.auth_accepted = asyncio.Event()
        self.authenticated = asyncio.Event()
        self._send_lock = asyncio.Lock()
        self._tts_lock = asyncio.Lock()
        self._audio_session: _AudioSession | None = None
        self._audio_recording_lock = threading.Lock()
        self._audio_recording_active = False
        self._audio_recording_generation = 0
        self._consumed_capture_grants: OrderedDict[str, None] = OrderedDict()
        pre_roll_bytes = int(16_000 * 2 * config.audio_preroll_ms / 1_000)
        self._pre_roll = PcmRingBuffer(pre_roll_bytes)
        self._remote_config: dict[str, Any] = {}
        self._privacy: dict[str, bool] = {
            "wakeWordEnabled": False,
            "microphoneEnabled": False,
            "cameraEnabled": False,
            "presenceDetectionEnabled": False,
            "snapshotEnabled": False,
            "speechDirectionEnabled": False,
            "faceTrackingDefault": False,
        }
        self._privacy_fault: str | None = None
        self._privacy_transition = False
        self._connected_at = 0.0
        self._status_interval_s = config.status_interval_s
        self._last_heartbeat_ack: str | None = None
        self._last_interaction: str | None = None
        self._closed = False
        self._wake_rearm_task: asyncio.Task[None] | None = None
        self._message_tasks: set[asyncio.Task[None]] = set()
        self._config_tail: asyncio.Task[None] | None = None
        self._config_sequence = 0
        self._wake_config_tail: asyncio.Task[None] | None = None
        self._wake_config_sequence = 0
        self._wake_config_pending: int | None = None
        self.stats: dict[str, int] = {
            "connections": 0,
            "reconnects": 0,
            "messagesReceived": 0,
            "messagesSent": 0,
            "audioBytesSent": 0,
            "wakeWordsDetected": 0,
            "robotCommands": 0,
            "robotCommandErrors": 0,
            "ttsPlayed": 0,
            "errors": 0,
        }

    def _connection_context(self) -> Any:
        if self.connector is not None:
            return self.connector(self.config.voice_websocket_url)
        try:  # websockets 13+
            from websockets.asyncio.client import connect
        except ImportError:  # pragma: no cover - compatibility for websockets 12
            from websockets import connect
        return connect(
            self.config.voice_websocket_url,
            open_timeout=10,
            close_timeout=5,
            ping_interval=20,
            ping_timeout=20,
            max_size=1_048_576,
            compression=None,
        )

    def _package_report(self) -> dict[str, Any]:
        package = version_report(
            self.package_stager.receipt_path if self.package_stager is not None else None
        )
        if self.release_manager is not None:
            package["releaseStatus"] = self.release_manager.report()
        daemon = self._daemon_report()
        if daemon is not None:
            package["daemon"] = daemon
        return package

    def _daemon_report(self) -> dict[str, Any] | None:
        if self.daemon_status_provider is None:
            return None
        with self._daemon_status_lock:
            now = time.monotonic()
            if self._daemon_status is not None and now - self._daemon_status_at < 15.0:
                return dict(self._daemon_status)
            try:
                candidate = self.daemon_status_provider()
                if not isinstance(candidate, dict) or set(candidate) != {
                    "daemonVersion",
                    "wireless",
                    "simulation",
                    "state",
                }:
                    raise ValueError("invalid daemon status shape")
                if candidate["daemonVersion"] is not None and not isinstance(candidate["daemonVersion"], str):
                    raise ValueError("invalid daemon version")
                if not isinstance(candidate["wireless"], bool):
                    raise ValueError("invalid daemon wireless flag")
                if candidate["simulation"] is not None and not isinstance(candidate["simulation"], bool):
                    raise ValueError("invalid daemon simulation flag")
                if not isinstance(candidate["state"], str):
                    raise ValueError("invalid daemon state")
                # Round-trip ensures injected/provider values are bounded finite JSON.
                encoded = json.dumps(candidate, allow_nan=False, separators=(",", ":"))
                if len(encoded.encode("utf-8")) > 512:
                    raise ValueError("daemon status exceeded the safety limit")
                self._daemon_status = json.loads(encoded)
                self._daemon_status_at = now
            except Exception as exc:
                LOGGER.warning("Reachy daemon status unavailable: %s", type(exc).__name__)
            return dict(self._daemon_status) if self._daemon_status is not None else None

    async def run(self, stop_event: threading.Event) -> None:
        """Reconnect until the managed app is stopped or authentication is rejected."""

        delay = self.config.reconnect_initial_s
        first_attempt = True
        try:
            while not stop_event.is_set() and not self._closed:
                was_authenticated = False
                try:
                    async with self._connection_context() as websocket:
                        self.websocket = websocket
                        self._connected_at = time.monotonic()
                        self.stats["connections"] += 1
                        self.auth_accepted.clear()
                        self.authenticated.clear()
                        await self._reset_privacy_fail_closed()
                        package = await asyncio.to_thread(self._package_report)
                        initial_state = await asyncio.to_thread(self.controller.state)
                        await self._send(
                            authentication_message(
                                device_token=self.config.device_token,
                                unit_id=self.config.unit_id,
                                version=__version__,
                                capabilities=self.capability_ids(),
                                capability_metadata=self.controller.capabilities,
                                package=package,
                                wake_detector=self.wake_word.health()
                                if self.wake_word is not None
                                else {"state": "unavailable"},
                                state=initial_state,
                            ),
                            require_auth=False,
                        )
                        await self._serve_connection(websocket, stop_event)
                        was_authenticated = self.authenticated.is_set()
                        delay = self.config.reconnect_initial_s
                except AuthenticationRejected:
                    raise
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.stats["errors"] += 1
                    LOGGER.warning("HomeBrain connection interrupted: %s", type(exc).__name__)
                finally:
                    was_authenticated = was_authenticated or self.authenticated.is_set()
                    self.auth_accepted.clear()
                    self.authenticated.clear()
                    try:
                        await self._reset_privacy_fail_closed()
                    except PrivacyConfigurationError:
                        # Remain disconnected and retry the physical OFF transition
                        # before authentication on the next backoff iteration.
                        LOGGER.error("Reachy privacy OFF retry will run before reconnect")
                    self.websocket = None
                    self._audio_session = None
                    if was_authenticated and not stop_event.is_set() and not self._closed:
                        self.controller.apply_safe_policy(self.config.safe_disconnect)

                if stop_event.is_set() or self._closed:
                    break
                if not first_attempt:
                    self.stats["reconnects"] += 1
                first_attempt = False
                jittered = delay * self.random.uniform(0.8, 1.2)
                await self._interruptible_sleep(jittered, stop_event)
                delay = min(self.config.reconnect_max_s, delay * 2)
        finally:
            self.authenticated.clear()
            self.auth_accepted.clear()
            self.websocket = None

    async def _serve_connection(self, websocket: Any, stop_event: threading.Event) -> None:
        tasks = {
            asyncio.create_task(self._receive_loop(websocket), name="homebrain-receive"),
            asyncio.create_task(self._heartbeat_loop(), name="homebrain-heartbeat"),
            asyncio.create_task(self._status_loop(), name="homebrain-status"),
            asyncio.create_task(self._audio_loop(stop_event), name="reachy-audio"),
            asyncio.create_task(self._presence_loop(), name="reachy-presence"),
            asyncio.create_task(self._wait_for_stop(stop_event), name="managed-app-stop"),
            asyncio.create_task(self._auth_timeout(), name="homebrain-auth-timeout"),
        }
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            if task.cancelled():
                continue
            error = task.exception()
            if error is not None:
                raise error

    async def _auth_timeout(self) -> None:
        try:
            await asyncio.wait_for(self.auth_accepted.wait(), timeout=12.0)
        except TimeoutError as exc:
            raise TimeoutError("HomeBrain authentication timed out") from exc
        await asyncio.Future()

    async def _wait_for_stop(self, stop_event: threading.Event) -> None:
        while not stop_event.is_set() and not self._closed:
            await asyncio.sleep(0.1)

    async def _interruptible_sleep(self, seconds: float, stop_event: threading.Event) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not stop_event.is_set() and not self._closed:
            await asyncio.sleep(min(0.2, max(0.0, deadline - time.monotonic())))

    async def _receive_loop(self, websocket: Any) -> None:
        try:
            async for raw in websocket:
                self.stats["messagesReceived"] += 1
                try:
                    message = parse_message(raw)
                    if message["type"] == "auth_success":
                        # This only cancels the protocol timeout. Operational audio
                        # remains gated until fail-closed privacy config is applied.
                        self.auth_accepted.set()
                    # Hardware motions and playback may block in the SDK. Dispatch
                    # them without blocking the reader so an emergency stop can be
                    # received and sent to cancel_move/stop_playing immediately.
                    if message["type"] in {
                        "robot_command",
                        "reachy_command",
                        "tts_response",
                        "command_processing",
                        "config_update",
                        "robot_config_update",
                        "auth_success",
                        "app_management",
                        "reachy_app_management",
                    }:
                        await self._dispatch_responsive(message)
                    else:
                        await self.handle_message(message)
                except ProtocolError as exc:
                    self.stats["errors"] += 1
                    LOGGER.warning("Rejected malformed HomeBrain message: %s", exc)
        finally:
            tasks = list(self._message_tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self._message_tasks.clear()

    async def _dispatch_responsive(self, message: dict[str, Any]) -> None:
        message = dict(message)
        action = message.get("action")
        nested = message.get("command")
        if isinstance(nested, dict):
            action = nested.get("action")
        is_stop = str(action).strip().lower() == "stop"
        is_config = message["type"] in {"auth_success", "config_update", "robot_config_update"}
        config_tasks = sum(task.get_name().startswith("reachy-config-") for task in self._message_tasks)
        if is_config and config_tasks >= 8:
            # Configuration must bypass ordinary operation saturation so OFF is
            # never starved, but the bypass itself must remain memory-bounded.
            # Tear down fail-closed; run() retries physical OFF before reauth.
            self._disable_software_privacy()
            close = getattr(self.websocket, "close", None)
            if callable(close):
                with contextlib.suppress(Exception):
                    result = close(code=1008, reason="configuration queue limit")
                    if hasattr(result, "__await__"):
                        await result
            raise ProtocolError("configuration queue limit exceeded")
        if len(self._message_tasks) >= 16 and not is_stop and not is_config:
            if message["type"] in {"robot_command", "reachy_command"}:
                command_id = (
                    nested.get("id", nested.get("commandId", message.get("commandId", "")))
                    if isinstance(nested, dict)
                    else message.get("commandId", "")
                )
                await self._send(
                    {
                        "type": "robot_command_result",
                        "commandId": str(command_id)[:128],
                        "action": str(action)[:64],
                        "success": False,
                        "status": "rejected",
                        "error": {"code": "busy", "message": "robot operation limit reached"},
                        "completedAt": utc_timestamp(),
                    }
                )
                return
            if message["type"] in {"app_management", "reachy_app_management"}:
                await self._send(
                    {
                        "type": "app_management_result",
                        "action": message.get("action"),
                        "requestId": message.get("requestId"),
                        "success": False,
                        "status": "failed",
                        "error": "companion operation limit reached",
                    }
                )
                return
            raise ProtocolError("too many robot operations are already in progress")
        if message["type"] in {"robot_command", "reachy_command"}:
            message["_homebrainArrivalEpoch"] = self.controller.admit_arrival(stop=is_stop)
            motion_token = self.controller.admit_motion_arrival(stop=is_stop)
            if motion_token is not None:
                message["_homebrainMotionToken"] = motion_token
            if is_stop:
                invalidate = getattr(self.tts, "invalidate", None)
                if callable(invalidate):
                    invalidate()
        elif message["type"] in {"tts_response", "command_processing"}:
            generation = getattr(self.tts, "generation", None)
            if callable(generation):
                message["_homebrainTtsGeneration"] = generation()
        if is_config:
            self._config_sequence += 1
            message["_homebrainConfigSequence"] = self._config_sequence
            previous = self._config_tail
            task = asyncio.create_task(
                self._run_ordered_config(previous, message),
                name=f"reachy-config-{self._config_sequence}",
            )
            self._config_tail = task
        else:
            task = asyncio.create_task(self.handle_message(message), name=f"reachy-message-{message['type']}")
        self._message_tasks.add(task)
        task.add_done_callback(self._message_task_done)

    async def _run_ordered_config(self, previous: asyncio.Task[None] | None, message: dict[str, Any]) -> None:
        try:
            if previous is not None:
                prior_result = await asyncio.gather(previous, return_exceptions=True)
                if prior_result and isinstance(prior_result[0], PrivacyConfigurationError):
                    raise PrivacyConfigurationError(
                        "an earlier physical privacy transition failed"
                    ) from prior_result[0]
            await self.handle_message(message)
        except PrivacyConfigurationError:
            websocket = self.websocket
            close = getattr(websocket, "close", None)
            if callable(close):
                with contextlib.suppress(Exception):
                    result = close(code=1011, reason="Reachy privacy state unconfirmed")
                    if hasattr(result, "__await__"):
                        await result
            raise

    def _message_task_done(self, task: asyncio.Task[None]) -> None:
        self._message_tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self.stats["errors"] += 1
            LOGGER.warning("Reachy background message failed: %s", type(error).__name__)

    async def _send(self, message: dict[str, Any], *, require_auth: bool = True) -> None:
        if require_auth and not self.authenticated.is_set():
            raise ConnectionError("HomeBrain session is not authenticated")
        if self.websocket is None:
            raise ConnectionError("HomeBrain WebSocket is unavailable")
        encoded = json.dumps(message, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode()) > 1_048_576:
            raise ProtocolError("outgoing message exceeded the safety limit")
        async with self._send_lock:
            await self.websocket.send(encoded)
        self.stats["messagesSent"] += 1

    async def handle_message(self, message: dict[str, Any]) -> None:
        kind = message["type"]
        if kind == "welcome":
            return
        if kind == "auth_success":
            self.auth_accepted.set()
            raw_config = message.get("config")
            wake_config_sequence = self._begin_wake_config(raw_config)
            await self._apply_remote_config(raw_config, configure_wake=False)
            self.authenticated.set()
            await self.send_status(reason="authenticated")
            await self.send_capabilities()
            self._schedule_wake_config(raw_config, wake_config_sequence)
            return
        if kind == "auth_failed":
            raise AuthenticationRejected("HomeBrain rejected the Reachy device credentials")
        if not self.authenticated.is_set():
            raise ProtocolError(f"received {kind} before authentication completed")
        if kind == "config_update":
            raw_config = message.get("config")
            wake_config_sequence = self._begin_wake_config(raw_config)
            await self._apply_remote_config(raw_config, configure_wake=False)
            await self.send_status(reason="config_updated")
            await self.send_capabilities()
            self._schedule_wake_config(raw_config, wake_config_sequence)
        elif kind == "heartbeat_ack":
            self._last_heartbeat_ack = str(message.get("timestamp") or utc_timestamp())
        elif kind == "status_request":
            request_id = message.get("requestId")
            if request_id is not None and (
                not isinstance(request_id, str) or not 1 <= len(request_id) <= 128
            ):
                raise ProtocolError("status_request requestId is invalid")
            await self.send_status(reason="requested", request_id=request_id)
        elif kind == "wake_word_ack":
            timeout_ms = message.get("timeout", 5_000)
            if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int, float)):
                timeout_ms = 5_000
            capture_grant_id = self._validate_capture_grant(message)
            await self._begin_audio_session(float(timeout_ms) / 1_000, capture_grant_id)
        elif kind == "command_processing":
            if self._update_quiescing:
                return
            acknowledgment = message.get("acknowledgmentText")
            if isinstance(acknowledgment, str) and acknowledgment.strip():
                await self._play_tts(
                    acknowledgment,
                    message.get("voice", "default"),
                    "acknowledgment",
                    expected_generation=message.get("_homebrainTtsGeneration"),
                )
        elif kind == "tts_response":
            if self._update_quiescing:
                return
            text = message.get("text")
            if not isinstance(text, str) or not text.strip():
                raise ProtocolError("tts_response did not include text")
            await self._play_tts(
                text,
                message.get("voice", "default"),
                "response",
                expected_generation=message.get("_homebrainTtsGeneration"),
            )
        elif kind in {"robot_command", "reachy_command"}:
            await self._handle_robot_command(message)
        elif kind == "robot_config_update":
            await self._apply_robot_config(message.get("settings"))
            await self.send_status(reason="robot_config_updated")
        elif kind in {"app_management", "reachy_app_management"}:
            await self._handle_app_management(message)
        elif kind in {
            "audio_received",
            "command_error",
            "audio_error",
            "error",
        }:
            if kind == "audio_error":
                await self._finish_audio_session()
            if kind in {"command_error", "audio_error", "error"}:
                self.stats["errors"] += 1
                LOGGER.warning("HomeBrain reported %s", kind)
        elif kind == "update_available":
            version = message.get("version")
            if not isinstance(version, str) or not 1 <= len(version) <= 80:
                raise ProtocolError("update_available did not include a valid version")
            await self._send(
                {
                    "type": "update_status",
                    "status": "available",
                    "version": version,
                    "currentVersion": __version__,
                    "strategy": "managed-app-release",
                }
            )
        else:
            LOGGER.debug("Ignoring unsupported HomeBrain message type %s", kind)

    async def _apply_remote_config(self, raw: Any, *, configure_wake: bool = True) -> None:
        if not isinstance(raw, dict):
            return
        sanitized: dict[str, Any] = {}
        wake_words = raw.get("wakeWords")
        if isinstance(wake_words, list):
            sanitized["wakeWords"] = [str(item)[:80] for item in wake_words[:16]]
        wake_word = raw.get("wakeWord")
        if isinstance(wake_word, dict):
            sanitized["wakeWord"] = {
                "enabled": [str(item)[:80] for item in wake_word.get("enabled", [])[:16]]
                if isinstance(wake_word.get("enabled"), list)
                else [],
                "debounceMs": max(250, min(int(wake_word.get("debounceMs", 1_500)), 10_000))
                if isinstance(wake_word.get("debounceMs", 1_500), (int, float))
                else 1_500,
            }
        for source, target in (("volume", "volume"), ("microphoneSensitivity", "microphoneSensitivity")):
            value = raw.get(source)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                sanitized[target] = max(0, min(100, round(value)))
        self._remote_config = sanitized
        if configure_wake and self.wake_word is not None:
            await asyncio.to_thread(self.wake_word.configure, raw)
        robot_config = raw.get("robot")
        if isinstance(robot_config, dict):
            robot_settings = robot_config.get("settings")
            if isinstance(robot_settings, dict):
                sanitized["robot"] = {"settings": dict(robot_settings)}
                await self._apply_robot_config(robot_settings)

    def _begin_wake_config(self, raw: Any) -> int | None:
        if self.wake_word is None or not isinstance(raw, dict):
            return None
        self._wake_config_sequence += 1
        self._wake_config_pending = self._wake_config_sequence
        self.wake_word.suspend()
        return self._wake_config_sequence

    def _schedule_wake_config(self, raw: Any, sequence: int | None) -> None:
        if self.wake_word is None or not isinstance(raw, dict) or sequence is None:
            return
        previous = self._wake_config_tail

        async def configure() -> None:
            if previous is not None:
                await asyncio.gather(previous, return_exceptions=True)
            health: dict[str, Any] | None = None
            try:
                result = await asyncio.to_thread(self.wake_word.configure, raw)
                health = result if isinstance(result, dict) else None
            except Exception as exc:
                self.stats["errors"] += 1
                LOGGER.warning("Reachy wake-word configuration failed: %s", type(exc).__name__)
            if sequence != self._wake_config_sequence:
                return
            self._wake_config_pending = None
            if (
                health is not None
                and health.get("state") == "ready"
                and self.authenticated.is_set()
                and self._privacy_fault is None
                and self._privacy["microphoneEnabled"]
                and self._privacy["wakeWordEnabled"]
            ):
                self.wake_word.resume()
            else:
                self.wake_word.suspend()
            if self.authenticated.is_set() and self.websocket is not None:
                await self.send_status(reason="wake_configured")

        task = asyncio.create_task(configure(), name="reachy-wake-config")
        self._wake_config_tail = task

    async def _reset_privacy_fail_closed(self) -> None:
        settings = {key: False for key in self._privacy}
        await self._apply_robot_config(settings)

    async def _heartbeat_loop(self) -> None:
        await self.authenticated.wait()
        while True:
            await asyncio.sleep(self.config.heartbeat_interval_s)
            uptime = max(0, int(time.monotonic() - self._connected_at))
            await self._send(
                {
                    "type": "heartbeat",
                    "unitId": self.config.unit_id,
                    "status": "online",
                    "firmwareVersion": __version__,
                    "uptime": uptime,
                    "batteryLevel": None,
                    "stats": dict(self.stats),
                    "lastInteraction": self._last_interaction,
                }
            )

    async def _status_loop(self) -> None:
        await self.authenticated.wait()
        while True:
            await asyncio.sleep(self._status_interval_s)
            await self.send_status(reason="periodic")

    async def send_status(self, *, reason: str, request_id: str | None = None) -> None:
        state = await asyncio.to_thread(self.controller.state)
        package = await asyncio.to_thread(self._package_report)
        await self._send(
            {
                "type": "status_update",
                "status": "online",
                **({"requestId": request_id} if request_id is not None else {}),
                "settings": {
                    "reachy": {
                        "unitId": self.config.unit_id,
                        "connected": True,
                        "version": __version__,
                        "package": package,
                        "python": platform.python_version(),
                        "reason": reason,
                        "capabilities": self.controller.capabilities,
                        "state": state,
                        "remoteConfig": self._remote_config,
                        "privacyFault": self._privacy_fault,
                        "wakeWord": self.wake_word.health()
                        if self.wake_word is not None
                        else {
                            "state": "unavailable",
                            "models": [],
                            "error": "wake-word runtime was not initialized",
                        },
                        "lastHeartbeatAck": self._last_heartbeat_ack,
                    }
                },
            }
        )
        await self._send(
            {
                "type": "robot_state",
                "unitId": self.config.unit_id,
                "protocolVersion": 1,
                **({"requestId": request_id} if request_id is not None else {}),
                "reason": reason,
                "state": state,
                "wakeDetector": self.wake_word.health()
                if self.wake_word is not None
                else {"state": "unavailable"},
                "appVersion": __version__,
                "package": package,
            }
        )

    def capability_ids(self) -> list[str]:
        media = getattr(self.robot, "media", None)
        values: list[str] = []
        if all(callable(getattr(self.robot, method, None)) for method in ("goto_target", "cancel_move")):
            values.extend(["head_motion", "antennas"])
        if callable(getattr(self.robot, "set_target_body_yaw", None)):
            values.append("body_rotation")
        if all(
            callable(getattr(media, method, None))
            for method in ("start_recording", "stop_recording", "get_audio_sample")
        ):
            values.append("audio_input")
        if callable(getattr(media, "play_sound", None)) and (
            callable(getattr(media, "stop_playing", None)) or callable(getattr(media, "clear_player", None))
        ):
            values.append("audio_output")
        if callable(getattr(media, "get_DoA", None)):
            values.append("speech_direction")
        if all(
            callable(getattr(self.robot, method, None))
            for method in ("start_head_tracking", "stop_head_tracking")
        ):
            values.append("face_tracking")
            if callable(getattr(self.robot, "get_tracked_face", None)):
                values.append("presence_detection")
        if callable(getattr(media, "get_frame_jpeg", None)):
            values.extend(["camera", "snapshot"])
        if self.wake_word is not None and self.wake_word.health().get("state") == "ready":
            values.append("wake_word")
        return values

    async def send_capabilities(self) -> None:
        package = await asyncio.to_thread(self._package_report)
        await self._send(
            {
                "type": "robot_capabilities",
                "unitId": self.config.unit_id,
                "protocolVersion": 1,
                "capabilities": self.capability_ids(),
                "metadata": self.controller.capabilities,
                "wakeDetector": self.wake_word.health()
                if self.wake_word is not None
                else {"state": "unavailable"},
                "appVersion": __version__,
                "package": package,
            }
        )

    async def emit_event(self, name: str, data: dict[str, Any]) -> None:
        if name not in {
            "online",
            "offline",
            "motion_completed",
            "motion_failed",
            "motion_stopped",
            "voice_session_started",
            "voice_session_completed",
            "error",
            "person_present",
            "person_cleared",
        }:
            raise ProtocolError("robot event is not allowlisted")
        await self._send({"type": "robot_event", "event": name, "timestamp": utc_timestamp(), "data": data})

    def _disable_software_privacy(self) -> None:
        self._audio_recording_generation += 1
        self._privacy.update({key: False for key in self._privacy})
        self._pre_roll.clear()
        self._audio_session = None
        if self._wake_rearm_task is not None:
            self._wake_rearm_task.cancel()
            self._wake_rearm_task = None
        if self.wake_word is not None:
            with contextlib.suppress(Exception):
                self.wake_word.suspend()

    def _set_audio_recording_sync(
        self,
        enabled: bool,
        *,
        force: bool = False,
        generation: int | None = None,
    ) -> bool:
        """Serialize microphone pipeline transitions and retain ambiguous ON state."""

        with self._audio_recording_lock:
            media = getattr(self.robot, "media", None)
            if enabled:
                if (
                    generation != self._audio_recording_generation
                    or self._privacy_transition
                    or self._privacy_fault is not None
                    or not self.authenticated.is_set()
                    or not self._privacy["microphoneEnabled"]
                ):
                    return False
                if self._audio_recording_active:
                    return True
                start = getattr(media, "start_recording", None)
                if not callable(start):
                    raise RuntimeError("Reachy audio input start is unavailable")
                # A start adapter may raise after partially activating hardware. Keep
                # the state ON/unknown until a later stop call positively succeeds.
                self._audio_recording_active = True
                start()
                return True

            stop = getattr(media, "stop_recording", None)
            if not callable(stop):
                if self._audio_recording_active:
                    raise RuntimeError("Reachy audio input stop is unavailable")
                return True
            if not force and not self._audio_recording_active:
                return True
            stop()
            self._audio_recording_active = False
            return True

    async def _set_audio_recording(
        self,
        enabled: bool,
        *,
        force: bool = False,
        generation: int | None = None,
    ) -> bool:
        return await asyncio.to_thread(
            self._set_audio_recording_sync,
            enabled,
            force=force,
            generation=generation,
        )

    async def _force_physical_privacy_off(self, *, stop_outputs: bool) -> list[Exception]:
        """Attempt every independent OFF adapter even when an earlier adapter fails."""

        errors: list[Exception] = []

        async def attempt(function: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
            try:
                await asyncio.to_thread(function, *args, **kwargs)
            except Exception as exc:
                errors.append(exc)

        try:
            # Always invoke the physical adapter, even if our local state says OFF:
            # a prior start may have failed after partially activating capture.
            await self._set_audio_recording(False, force=True)
        except Exception as exc:
            errors.append(exc)
        if self.snapshot is not None:
            await attempt(
                self.snapshot.configure,
                camera_enabled=False,
                snapshot_enabled=False,
            )
        if self.presence is not None:
            await attempt(self.presence.configure, False)
        await attempt(
            self.controller.configure_privacy,
            camera_enabled=False,
            speech_direction_enabled=False,
            face_tracking_default=False,
        )
        if stop_outputs:
            stop_tts = getattr(self.tts, "stop", None)
            if callable(stop_tts):
                await attempt(stop_tts)
            await attempt(
                self.controller.apply_operational_settings,
                {"idleMotionEnabled": False},
            )
        return errors

    async def _latch_privacy_fault(self, cause: Exception) -> None:
        self._disable_software_privacy()
        self._privacy_fault = "physical privacy state could not be confirmed"
        self._remote_config["privacyFault"] = self._privacy_fault
        self.stats["errors"] += 1
        invalidate = getattr(self.tts, "invalidate", None)
        if callable(invalidate):
            with contextlib.suppress(Exception):
                invalidate()
        was_authenticated = self.authenticated.is_set()
        if was_authenticated:
            with contextlib.suppress(Exception):
                await self.emit_event(
                    "error",
                    {"component": "privacy", "message": self._privacy_fault},
                )
            with contextlib.suppress(Exception):
                await self.send_status(reason="privacy_config_failed")
        self.authenticated.clear()
        LOGGER.error("Reachy privacy configuration failed closed: %s", type(cause).__name__)

    async def _apply_robot_config(self, settings: Any) -> None:
        if not isinstance(settings, dict):
            return
        keys = tuple(self._privacy)
        updated = {key: settings.get(key) is True for key in keys}
        camera_enabled = updated["cameraEnabled"]
        self._privacy_transition = True
        self._disable_software_privacy()
        try:
            off_errors = await self._force_physical_privacy_off(stop_outputs=False)
            if off_errors:
                raise PrivacyConfigurationError(
                    "Reachy's prior physical privacy state could not be disabled"
                ) from off_errors[0]
            await asyncio.to_thread(
                self.controller.configure_privacy,
                camera_enabled=camera_enabled,
                speech_direction_enabled=updated["speechDirectionEnabled"],
                face_tracking_default=updated["faceTrackingDefault"],
            )
            if self.presence is not None:
                await asyncio.to_thread(
                    self.presence.configure,
                    camera_enabled and updated["presenceDetectionEnabled"],
                )
            if self.snapshot is not None:
                await asyncio.to_thread(
                    self.snapshot.configure,
                    camera_enabled=camera_enabled,
                    snapshot_enabled=updated["snapshotEnabled"],
                )
            operational = await asyncio.to_thread(
                self.controller.apply_operational_settings,
                settings,
            )
            status_interval_s = self._status_interval_s
            telemetry_ms = settings.get("telemetryIntervalMs")
            if isinstance(telemetry_ms, (int, float)) and not isinstance(telemetry_ms, bool):
                status_interval_s = max(5.0, min(300.0, float(telemetry_ms) / 1_000))
                operational["telemetryIntervalMs"] = round(status_interval_s * 1_000)
            if (
                updated["microphoneEnabled"]
                and updated["wakeWordEnabled"]
                and self.wake_word is not None
                and self._wake_config_pending is None
            ):
                self.wake_word.resume()
            self._status_interval_s = status_interval_s
            self._privacy.update(updated)
            self._remote_config["appliedRobotSettings"] = operational
            self._remote_config.pop("privacyFault", None)
            self._privacy_fault = None
        except Exception as exc:
            await self._force_physical_privacy_off(stop_outputs=True)
            await self._latch_privacy_fault(exc)
            raise PrivacyConfigurationError("Reachy's physical privacy state could not be confirmed") from exc
        finally:
            self._privacy_transition = False

    async def _presence_loop(self) -> None:
        await self.authenticated.wait()
        while True:
            if self.presence is not None:
                change = await asyncio.to_thread(self.presence.poll)
                if change is not None:
                    event = "person_present" if change["present"] else "person_cleared"
                    await self.emit_event(event, change)
            await asyncio.sleep(0.25)

    async def notify_wake_word(self, wake_word: str, confidence: float) -> None:
        """Report a detection from a lightweight detector or explicit local trigger."""

        if (
            not self.authenticated.is_set()
            or self._audio_session is not None
            or not self._privacy["microphoneEnabled"]
            or not self._privacy["wakeWordEnabled"]
        ):
            return
        word = str(wake_word).strip()[:80]
        if not word:
            raise ProtocolError("wake word cannot be empty")
        score = max(0.0, min(1.0, float(confidence)))
        self.stats["wakeWordsDetected"] += 1
        self._last_interaction = utc_timestamp()
        await self._send(
            {
                "type": "wake_word_detected",
                "wakeWord": word,
                "confidence": score,
                "timestamp": self._last_interaction,
            }
        )
        if self.wake_word is not None:
            self.wake_word.suspend()
            if self._wake_rearm_task is not None:
                self._wake_rearm_task.cancel()
            self._wake_rearm_task = asyncio.create_task(self._rearm_wake_word_after(10.0))

    async def _rearm_wake_word_after(self, delay_s: float) -> None:
        await asyncio.sleep(delay_s)
        if (
            self._audio_session is None
            and self.wake_word is not None
            and self._privacy_fault is None
            and self._privacy["microphoneEnabled"]
            and self._privacy["wakeWordEnabled"]
        ):
            self.wake_word.resume()

    def _validate_capture_grant(self, message: dict[str, Any]) -> str:
        capture_grant_id = message.get("captureGrantId")
        if (
            not isinstance(capture_grant_id, str)
            or not 16 <= len(capture_grant_id) <= 128
            or capture_grant_id.strip() != capture_grant_id
            or any(ord(character) < 32 or ord(character) == 127 for character in capture_grant_id)
        ):
            raise ProtocolError("wake_word_ack did not include a valid captureGrantId")
        acknowledged_session_id = message.get("sessionId")
        if acknowledged_session_id is not None and acknowledged_session_id != capture_grant_id:
            raise ProtocolError("wake_word_ack sessionId did not match captureGrantId")
        if capture_grant_id in self._consumed_capture_grants:
            raise ProtocolError("wake_word_ack captureGrantId was replayed")
        self._consumed_capture_grants[capture_grant_id] = None
        while len(self._consumed_capture_grants) > 256:
            self._consumed_capture_grants.popitem(last=False)
        return capture_grant_id

    async def _begin_audio_session(
        self,
        requested_seconds: float,
        capture_grant_id: str,
    ) -> None:
        if not self._privacy["microphoneEnabled"]:
            self._pre_roll.clear()
            return
        if self._audio_session is not None:
            raise ProtocolError("an audio session is already active")
        duration = max(1.0, min(requested_seconds, self.config.command_audio_max_s))
        session = _AudioSession(
            capture_grant_id,
            capture_grant_id,
            time.monotonic() + duration,
        )
        self._audio_session = session
        if self.wake_word is not None:
            self.wake_word.suspend()
        await self._send(
            {
                "type": "audio_data",
                "sessionId": session.session_id,
                "captureGrantId": session.capture_grant_id,
                "isStart": True,
                "sampleRate": 16_000,
                "channels": 1,
                "format": "S16LE",
            }
        )
        pre_roll = self._pre_roll.snapshot()
        if pre_roll:
            await self._send_audio_chunk(pre_roll, pre_roll=True)
        await self.emit_event(
            "voice_session_started", {"sessionId": session.session_id, "timeoutS": duration}
        )

    async def _send_audio_chunk(self, chunk: bytes, *, pre_roll: bool = False) -> None:
        session = self._audio_session
        if session is None or not chunk:
            return
        message = {
            "type": "audio_data",
            "sessionId": session.session_id,
            "sequence": session.sequence,
            "audioData": base64.b64encode(chunk).decode("ascii"),
            "sampleRate": 16_000,
            "channels": 1,
            "format": "S16LE",
        }
        if pre_roll:
            message["preRoll"] = True
        session.sequence += 1
        await self._send(message)
        self.stats["audioBytesSent"] += len(chunk)

    async def _finish_audio_session(self) -> None:
        session = self._audio_session
        if session is None:
            return
        self._audio_session = None
        await self._send(
            {
                "type": "audio_data",
                "sessionId": session.session_id,
                "sequence": session.sequence,
                "isFinal": True,
            }
        )
        await self.emit_event(
            "voice_session_completed", {"sessionId": session.session_id, "chunks": session.sequence}
        )
        if (
            self.wake_word is not None
            and self._privacy_fault is None
            and self._privacy["microphoneEnabled"]
            and self._privacy["wakeWordEnabled"]
        ):
            await asyncio.sleep(0.25)
            self.wake_word.resume()

    async def _audio_loop(self, stop_event: threading.Event) -> None:
        media = getattr(self.robot, "media", None)
        start = getattr(media, "start_recording", None)
        get_sample = getattr(media, "get_audio_sample", None)
        if not callable(start) or not callable(get_sample):
            raise RuntimeError("Reachy gstreamer audio input is unavailable")
        sample_rate_getter = getattr(media, "get_input_audio_samplerate", None)
        sample_rate = int(sample_rate_getter()) if callable(sample_rate_getter) else 16_000
        if sample_rate != 16_000:
            raise AudioFormatError(f"Reachy input rate {sample_rate} Hz is unsupported; expected 16000 Hz")
        try:
            while not stop_event.is_set() and not self._closed:
                microphone_enabled = (
                    self.authenticated.is_set()
                    and self._privacy_fault is None
                    and not self._privacy_transition
                    and self._privacy["microphoneEnabled"]
                )
                if not microphone_enabled:
                    self._pre_roll.clear()
                    self._audio_session = None
                    await asyncio.sleep(0.01)
                    continue
                generation = self._audio_recording_generation
                if not await self._set_audio_recording(True, generation=generation):
                    await asyncio.sleep(0.01)
                    continue
                sample = get_sample()
                if sample is not None:
                    try:
                        pcm = float_audio_to_pcm16_mono(sample, input_sample_rate=sample_rate)
                    except AudioFormatError:
                        self.stats["errors"] += 1
                        await asyncio.sleep(0.01)
                        continue
                    self._pre_roll.append(pcm)
                    if self._audio_session is not None:
                        await self._send_audio_chunk(pcm)
                    elif (
                        self.authenticated.is_set()
                        and self._privacy["wakeWordEnabled"]
                        and self.wake_word is not None
                    ):
                        detections = await asyncio.to_thread(self.wake_word.process_pcm, pcm)
                        if detections:
                            detection = detections[0]
                            await self.notify_wake_word(detection.label, detection.confidence)
                if self._audio_session is not None and time.monotonic() >= self._audio_session.deadline:
                    await self._finish_audio_session()
                if sample is None:
                    await asyncio.sleep(0.01)
                else:
                    await asyncio.sleep(0)
        finally:
            if self._audio_session is not None and self.authenticated.is_set():
                with contextlib.suppress(Exception):
                    await self._finish_audio_session()
            if self._audio_recording_active:
                with contextlib.suppress(Exception):
                    await self._set_audio_recording(False)

    async def _play_tts(
        self,
        text: str,
        voice: Any,
        purpose: str,
        *,
        expected_generation: Any = None,
    ) -> None:
        if self._privacy_fault is not None or self._privacy_transition:
            LOGGER.warning("Dropped TTS while Reachy privacy state is unconfirmed")
            return
        voice_id = voice if isinstance(voice, str) else "default"
        generation_getter = getattr(self.tts, "generation", None)
        generation = (
            expected_generation
            if isinstance(expected_generation, int) and not isinstance(expected_generation, bool)
            else generation_getter()
            if callable(generation_getter)
            else None
        )
        async with self._tts_lock:
            try:
                if generation is None:
                    result = await asyncio.to_thread(self.tts.play, text, voice_id)
                else:
                    result = await asyncio.to_thread(
                        self.tts.play,
                        text,
                        voice_id,
                        expected_generation=generation,
                    )
                self.stats["ttsPlayed"] += 1
                await self._send(
                    {
                        "type": "status_update",
                        "status": "online",
                        "settings": {
                            "reachyTts": {"purpose": purpose, "playedAt": utc_timestamp(), **result}
                        },
                    }
                )
            except TtsCancelled:
                LOGGER.info("Dropped TTS invalidated by a stop command")
            except TtsError as exc:
                self.stats["errors"] += 1
                LOGGER.warning("TTS playback failed: %s", exc)
                await self.emit_event("error", {"component": "tts", "message": str(exc)})

    async def _handle_robot_command(self, message: dict[str, Any]) -> None:
        nested = message.get("command")
        action = nested.get("action") if isinstance(nested, dict) else message.get("action", nested)
        normalized_action = str(action).strip().lower()
        command_id = (
            nested.get("id", nested.get("commandId", message.get("commandId", "")))
            if isinstance(nested, dict)
            else message.get("commandId", "")
        )
        if (self._privacy_fault is not None or self._privacy_transition) and normalized_action != "stop":
            await self._send(
                {
                    "type": "robot_command_result",
                    "commandId": str(command_id)[:128],
                    "action": str(action)[:64],
                    "success": False,
                    "status": "rejected",
                    "error": {
                        "code": "privacy_fault",
                        "message": "robot privacy state is unconfirmed; only stop is allowed",
                    },
                    "completedAt": utc_timestamp(),
                }
            )
            return
        if self._update_quiescing and normalized_action != "stop":
            await self._send(
                {
                    "type": "robot_command_result",
                    "commandId": str(command_id)[:128],
                    "action": str(action)[:64],
                    "success": False,
                    "status": "rejected",
                    "error": {
                        "code": "app_update_prepared",
                        "message": "robot is quiesced for a managed app update",
                    },
                    "completedAt": utc_timestamp(),
                }
            )
            return
        if normalized_action == "stop":
            stop_tts = getattr(self.tts, "stop", None)
            if callable(stop_tts):
                try:
                    await asyncio.to_thread(stop_tts)
                except Exception:
                    self.stats["errors"] += 1
                    LOGGER.warning("Reachy TTS stop failed; continuing physical motion stop")
            if self.presence is not None:
                try:
                    await asyncio.to_thread(self.presence.emergency_stop)
                except Exception:
                    self.stats["errors"] += 1
                    LOGGER.warning("Reachy presence stop failed; continuing physical motion stop")
        result = await asyncio.to_thread(self.controller.execute_message, message)
        self.stats["robotCommands"] += 1
        self._last_interaction = utc_timestamp()
        if not result.get("success"):
            self.stats["robotCommandErrors"] += 1
        await self._send(result)
        result_action = result.get("action")
        if result_action == "stop" or result.get("status") == "cancelled":
            await self.emit_event("motion_stopped", result)
        elif result_action in self.controller.MOTION_ACTIONS:
            event = "motion_completed" if result.get("success") else "motion_failed"
            await self.emit_event(event, result)

    async def _handle_app_management(self, message: dict[str, Any]) -> None:
        """Prepare for an external managed-app update; never modify code in-place."""

        action = message.get("action")
        request_id = message.get("requestId")
        if action not in {
            "check_update",
            "package_stage",
            "prepare_update",
            "confirm_update",
            "rollback",
            "release",
        }:
            raise ProtocolError("app-management action is not allowlisted")
        if request_id is not None and (not isinstance(request_id, str) or len(request_id) > 128):
            raise ProtocolError("app-management request id is invalid")
        if action == "check_update":
            await self._send(
                {
                    "type": "app_management_result",
                    "requestId": request_id,
                    "action": action,
                    "success": True,
                    "package": await asyncio.to_thread(self._package_report),
                }
            )
            return
        if action == "package_stage":
            manifest_url = message.get("manifestUrl")
            if not isinstance(request_id, str) or not request_id:
                raise ProtocolError("package_stage requires requestId")
            if self.package_stager is None:
                result = {
                    "type": "app_management_result",
                    "action": action,
                    "requestId": request_id,
                    "success": False,
                    "status": "failed",
                    "error": "package staging is unavailable",
                }
            else:
                try:
                    staged = await asyncio.to_thread(
                        self.package_stager.stage,
                        manifest_url,
                        request_id=request_id,
                    )
                    result = {
                        "type": "app_management_result",
                        "action": action,
                        "requestId": request_id,
                        "success": True,
                        "status": "staged",
                        "version": staged.version,
                        "aggregateSha256": staged.aggregate_sha256,
                    }
                except PackageStageError as exc:
                    result = {
                        "type": "app_management_result",
                        "action": action,
                        "requestId": request_id,
                        "success": False,
                        "status": "failed",
                        "error": str(exc),
                    }
            await self._send(result)
            return
        if action == "rollback":
            version = message.get("version")
            aggregate = message.get("aggregateSha256")
            if self.release_manager is None:
                result = {
                    "type": "app_management_result",
                    "action": action,
                    "requestId": request_id,
                    "success": False,
                    "status": "failed",
                    "error": "release manager is unavailable",
                }
            else:
                try:
                    if (
                        not isinstance(request_id, str)
                        or not request_id
                        or not isinstance(version, str)
                        or not isinstance(aggregate, str)
                    ):
                        raise ReleaseError("rollback requires requestId, version, and aggregateSha256")
                    report = await asyncio.to_thread(
                        self.release_manager.rollback,
                        request_id,
                        version,
                        aggregate,
                    )
                    result = {
                        "type": "app_management_result",
                        "action": action,
                        "requestId": request_id,
                        "success": True,
                        "status": "rolled_back",
                        **report,
                        "version": version,
                        "aggregateSha256": aggregate,
                    }
                except ReleaseError as exc:
                    result = {
                        "type": "app_management_result",
                        "action": action,
                        "requestId": request_id,
                        "success": False,
                        "status": "failed",
                        "error": str(exc),
                    }
            await self._send(result)
            if result["success"]:
                with self._shutdown_policy_lock:
                    self._safe_shutdown_applied = False
                    self._update_quiescing = False
                    self._prepared_release = None
            return
        if action == "confirm_update":
            version = message.get("version")
            aggregate = message.get("aggregateSha256")
            if (
                not isinstance(request_id, str)
                or not request_id
                or not isinstance(version, str)
                or not isinstance(aggregate, str)
                or self.health_callback is None
            ):
                raise ProtocolError(
                    "confirm_update requires requestId, version, aggregateSha256, and a pending launcher"
                )
            try:
                await asyncio.to_thread(self.health_callback, request_id, version, aggregate)
                result = {
                    "type": "app_management_result",
                    "action": action,
                    "requestId": request_id,
                    "success": True,
                    "status": "confirmed",
                    "version": version,
                    "aggregateSha256": aggregate,
                }
            except ReleaseError as exc:
                result = {
                    "type": "app_management_result",
                    "action": action,
                    "requestId": request_id,
                    "success": False,
                    "status": "failed",
                    "error": str(exc),
                }
            await self._send(result)
            return
        if action == "prepare_update":
            aggregate = message.get("aggregateSha256")
            version = message.get("version")
            if (
                self.release_manager is None
                or not isinstance(request_id, str)
                or not request_id
                or not isinstance(version, str)
                or not isinstance(aggregate, str)
            ):
                raise ProtocolError(
                    "prepare_update requires a release manager, requestId, version, and aggregateSha256"
                )
            try:
                pending = await asyncio.to_thread(
                    self.release_manager.prepare_update,
                    request_id,
                    version,
                    aggregate,
                )
            except ReleaseError as exc:
                await self._send(
                    {
                        "type": "update_status",
                        "requestId": request_id,
                        "action": action,
                        "status": "failed",
                        "success": False,
                        "error": str(exc),
                    }
                )
                return
            with self._shutdown_policy_lock:
                self._update_quiescing = True
            try:
                await asyncio.to_thread(self._apply_safe_shutdown_once)
            except Exception:
                self.stats["errors"] += 1
                await self._send(
                    {
                        "type": "update_status",
                        "requestId": request_id,
                        "action": action,
                        "status": "failed",
                        "success": False,
                        "error": "Reachy physical safe policy could not be confirmed",
                    }
                )
                return
            with self._shutdown_policy_lock:
                self._prepared_release = (request_id, version, aggregate)
            await self._send(
                {
                    "type": "update_status",
                    "requestId": request_id,
                    "action": action,
                    "status": "prepared",
                    "success": True,
                    "version": pending["version"],
                    "aggregateSha256": pending["aggregateSha256"],
                }
            )
            return
        if self.release_callback is None:
            await self._send(
                {
                    "type": "app_management_result",
                    "requestId": request_id,
                    "action": action,
                    "success": False,
                    "error": "managed app release callback is unavailable",
                }
            )
            return
        parent_request_id = message.get("parentRequestId")
        version = message.get("version")
        aggregate = message.get("aggregateSha256")
        with self._shutdown_policy_lock:
            prepared = self._prepared_release
        if (
            not isinstance(parent_request_id, str)
            or not isinstance(version, str)
            or not isinstance(aggregate, str)
            or prepared != (parent_request_id, version, aggregate)
            or self.release_manager is None
        ):
            await self._send(
                {
                    "type": "app_management_result",
                    "requestId": request_id,
                    "parentRequestId": parent_request_id,
                    "action": action,
                    "success": False,
                    "status": "failed",
                    "error": "release does not match the safely prepared runtime",
                }
            )
            return
        try:
            await asyncio.to_thread(
                self.release_manager.authorize_launch,
                parent_request_id,
                version,
                aggregate,
            )
        except ReleaseError as exc:
            await self._send(
                {
                    "type": "app_management_result",
                    "requestId": request_id,
                    "parentRequestId": parent_request_id,
                    "action": action,
                    "success": False,
                    "status": "failed",
                    "error": str(exc),
                }
            )
            return
        # The pending pointer and physical safe state are durable/complete before
        # acknowledging. Only this correlated release asks the managed app to exit.
        await self._send(
            {
                "type": "app_management_result",
                "requestId": request_id,
                "parentRequestId": parent_request_id,
                "action": action,
                "status": "releasing",
                "success": True,
                "version": version,
                "aggregateSha256": aggregate,
            }
        )
        self.release_callback(action)

    @property
    def safe_shutdown_applied(self) -> bool:
        with self._shutdown_policy_lock:
            return self._safe_shutdown_applied

    def _apply_safe_shutdown_once(self) -> None:
        with self._shutdown_policy_lock:
            if self._safe_shutdown_applied:
                return
        self.controller.apply_safe_policy(
            self.config.safe_shutdown,
            require_confirmation=True,
        )
        with self._shutdown_policy_lock:
            self._safe_shutdown_applied = True

    async def close(self) -> None:
        self._closed = True
        if self._wake_rearm_task is not None:
            self._wake_rearm_task.cancel()
        if self._audio_session is not None and self.authenticated.is_set():
            with contextlib.suppress(Exception):
                await self._finish_audio_session()
        websocket = self.websocket
        if websocket is not None:
            close = getattr(websocket, "close", None)
            if callable(close):
                with contextlib.suppress(Exception):
                    result = close(code=1000, reason="managed app stopping")
                    if asyncio.iscoroutine(result):
                        await result
