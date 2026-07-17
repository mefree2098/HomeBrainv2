"""Strict semantic command adapter for Reachy Mini SDK 1.9+."""

from __future__ import annotations

import json
import math
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any, ClassVar

import numpy as np

from .motion import MotionCancelled, MotionError
from .perception import PerceptionError, TrackingCoordinator
from .protocol import IdempotencyCache, ProtocolError, RobotCommand, utc_timestamp
from .sdk_compat import create_head_pose


class RobotCommandError(RuntimeError):
    """A semantic command is unsupported or unsafe."""


def _finite_number(
    parameters: Mapping[str, Any],
    name: str,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    raw = parameters.get(name, default)
    if isinstance(raw, bool):
        raise RobotCommandError(f"{name} must be numeric")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise RobotCommandError(f"{name} must be numeric") from exc
    if not math.isfinite(value):
        raise RobotCommandError(f"{name} must be finite")
    return max(minimum, min(maximum, value))


def _head_pose(*, roll_deg: float = 0, pitch_deg: float = 0, yaw_deg: float = 0) -> np.ndarray:
    if create_head_pose is not None:  # pragma: no cover - exercised with the real SDK
        return create_head_pose(
            roll=roll_deg,
            pitch=pitch_deg,
            yaw=yaw_deg,
            degrees=True,
            mm=False,
        )

    # SDK-free test fallback using a conventional Z-Y-X rotation matrix.
    roll, pitch, yaw = np.deg2rad([roll_deg, pitch_deg, yaw_deg])
    cr, sr = math.cos(roll), math.sin(roll)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cy, sy = math.cos(yaw), math.sin(yaw)
    rotation = np.array(
        [
            [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
            [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
            [-sp, cp * sr, cp * cr],
        ],
        dtype=np.float64,
    )
    pose = np.eye(4, dtype=np.float64)
    pose[:3, :3] = rotation
    return pose


def _json_safe(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


class RobotController:
    """Allowlisted, clamped, serialized access to a managed Reachy Mini instance."""

    ACTIONS = frozenset(
        {
            "stop",
            "sleep",
            "wake",
            "neutral",
            "look",
            "look_at_speaker",
            "set_antennas",
            "set_body_yaw",
            "set_motor_mode",
            "play_emotion",
            "play_move",
            "start_face_tracking",
            "stop_face_tracking",
            "set_volume",
            "set_microphone_volume",
            "snapshot",
            "release_app",
        }
    )
    EMOTIONS = frozenset({"happy", "sad", "curious", "listening", "speaking", "alert", "neutral"})
    MOTOR_MODES = frozenset({"enabled", "disabled", "gravity_compensation"})
    MOVES = frozenset({"nod", "shake_head", "greet", "celebrate", "dance", "yes", "no"})
    MOTION_ACTIONS = frozenset(
        {
            "sleep",
            "wake",
            "neutral",
            "look",
            "look_at_speaker",
            "set_antennas",
            "set_body_yaw",
            "set_motor_mode",
            "play_emotion",
            "play_move",
        }
    )
    _ALIASES: ClassVar[dict[str, str]] = {
        "antennas": "set_antennas",
        "body_yaw": "set_body_yaw",
        "motor_mode": "set_motor_mode",
        "emotion": "play_emotion",
    }

    def __init__(
        self,
        robot: Any,
        *,
        default_ttl_ms: int = 5_000,
        max_ttl_ms: int = 30_000,
        emotion_hook: Callable[[str, Mapping[str, Any]], bool] | None = None,
        snapshot_hook: Callable[[str, int], Mapping[str, Any]] | None = None,
        release_hook: Callable[[str], None] | None = None,
        volume_hook: Callable[[str, int], Mapping[str, Any]] | None = None,
        tracking: TrackingCoordinator | None = None,
        motion: Any | None = None,
        now_ms: Callable[[], int] | None = None,
    ):
        self.robot = robot
        self.default_ttl_ms = default_ttl_ms
        self.max_ttl_ms = max_ttl_ms
        self.emotion_hook = emotion_hook
        self.snapshot_hook = snapshot_hook
        self.release_hook = release_hook
        self.volume_hook = volume_hook
        self.tracking = tracking or TrackingCoordinator(robot)
        self.motion = motion
        self._motion_context = threading.local()
        self._now_ms = now_ms or (lambda: int(time.time() * 1_000))
        self._cache = IdempotencyCache(512)
        self._cache_lock = threading.Lock()
        self._inflight: dict[str, tuple[str, threading.Event]] = {}
        self._lock = threading.RLock()
        self._privacy_lock = threading.RLock()
        self._cancel_lock = threading.Lock()
        self._cancel_epoch = 0
        self.motor_mode = "unknown"
        self.sleeping = False
        self.face_tracking = False
        self.camera_enabled = False
        self.speech_direction_enabled = False
        self.last_action: str | None = None
        self.last_action_at: str | None = None
        self.active_motion: str | None = None
        self.default_emotion = "neutral"
        self.idle_motion_enabled = False
        self.vision_mode = "off"
        self._applied_volumes: dict[str, int] = {}

    def apply_operational_settings(self, settings: Mapping[str, Any]) -> dict[str, Any]:
        """Apply non-privacy settings that the server persists for this robot."""

        applied: dict[str, Any] = {}
        for field, kind in (("speakerVolume", "speaker"), ("microphoneVolume", "microphone")):
            raw = settings.get(field)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                continue
            volume = round(max(0.0, min(100.0, float(raw))))
            if self.volume_hook is not None and self._applied_volumes.get(kind) != volume:
                self.volume_hook(kind, volume)
                self._applied_volumes[kind] = volume
            applied[field] = volume
        idle = settings.get("idleMotionEnabled")
        if isinstance(idle, bool) and idle != self.idle_motion_enabled:
            method = getattr(self.robot, "enable_wobbling" if idle else "disable_wobbling", None)
            if callable(method):
                method()
            self.idle_motion_enabled = idle
            applied["idleMotionEnabled"] = idle
        emotion = settings.get("defaultEmotion")
        if isinstance(emotion, str) and emotion.strip().lower() in self.EMOTIONS:
            self.default_emotion = emotion.strip().lower()
            applied["defaultEmotion"] = self.default_emotion
        vision_mode = settings.get("visionMode")
        if isinstance(vision_mode, str) and vision_mode in {"off", "on_demand", "presence_only"}:
            self.vision_mode = vision_mode
            applied["visionMode"] = vision_mode
        return applied

    def configure_privacy(
        self,
        *,
        camera_enabled: bool,
        speech_direction_enabled: bool,
        face_tracking_default: bool,
    ) -> None:
        """Apply fail-closed camera/DoA policy and the configured tracking default."""

        with self._privacy_lock:
            self.camera_enabled = camera_enabled is True
            self.speech_direction_enabled = speech_direction_enabled is True
            self.tracking.configure_camera(self.camera_enabled)
            if self.camera_enabled and face_tracking_default is True:
                self.tracking.request("face_default", 1.0)
            else:
                self.tracking.release("face_default")
            self.face_tracking = self.tracking.active

    @property
    def supported_actions(self) -> frozenset[str]:
        media = getattr(self.robot, "media", None)
        actions = {"stop"}
        if self.motion is not None:
            actions.add("sleep")
            actions.add("wake")
            actions.update(
                {
                    "neutral",
                    "look",
                    "set_antennas",
                    "set_body_yaw",
                    "play_emotion",
                    "play_move",
                }
            )
            if callable(getattr(media, "get_DoA", None)):
                actions.add("look_at_speaker")
        if all(
            callable(getattr(self.robot, method, None))
            for method in ("enable_motors", "disable_motors", "enable_gravity_compensation")
        ):
            actions.add("set_motor_mode")
        if all(
            callable(getattr(self.robot, method, None))
            for method in ("start_head_tracking", "stop_head_tracking")
        ):
            actions.update({"start_face_tracking", "stop_face_tracking"})
        if self.volume_hook is not None:
            actions.update({"set_volume", "set_microphone_volume"})
        if self.snapshot_hook is not None and callable(getattr(media, "get_frame_jpeg", None)):
            actions.add("snapshot")
        if self.release_hook is not None:
            actions.add("release_app")
        return frozenset(actions)

    @property
    def capabilities(self) -> dict[str, Any]:
        return {
            "kind": "reachy-mini-wireless",
            "actions": sorted(self.supported_actions),
            "emotions": sorted(self.EMOTIONS),
            "moves": sorted(self.MOVES),
            "motorModes": sorted(self.MOTOR_MODES),
            "audio": {
                "inputSampleRate": 16_000,
                "inputChannels": 2,
                "homeBrainFormat": "S16LE",
                "homeBrainChannels": 1,
                "ttsPlayback": True,
            },
            "cameraStreaming": False,
            "rawJointControl": False,
            "commandTtl": True,
            "idempotentCommands": True,
        }

    def parse_command(self, message: Mapping[str, Any]) -> RobotCommand:
        command = RobotCommand.from_message(
            message,
            default_ttl_ms=self.default_ttl_ms,
            max_ttl_ms=self.max_ttl_ms,
            now_ms=self._now_ms(),
        )
        alias = self._ALIASES.get(command.action)
        return replace(command, action=alias) if alias is not None else command

    def execute_message(self, message: Mapping[str, Any]) -> dict[str, Any]:
        try:
            command = self.parse_command(message)
        except ProtocolError as exc:
            return {
                "type": "robot_command_result",
                "commandId": str(message.get("commandId", ""))[:128],
                "success": False,
                "status": "rejected",
                "error": {"code": "invalid_command", "message": str(exc)},
                "completedAt": utc_timestamp(),
            }
        arrival_epoch = message.get("_homebrainArrivalEpoch")
        if isinstance(arrival_epoch, bool) or not isinstance(arrival_epoch, int):
            arrival_epoch = None
        motion_token = message.get("_homebrainMotionToken")
        if isinstance(motion_token, bool) or not isinstance(motion_token, int):
            motion_token = None
        return self.execute(
            command,
            arrival_epoch=arrival_epoch,
            motion_token=motion_token,
        )

    def admit_arrival(self, *, stop: bool) -> int:
        """Stamp wire order before asynchronous worker scheduling can reorder it."""

        with self._cancel_lock:
            if stop:
                self._cancel_epoch += 1
            return self._cancel_epoch

    def admit_motion_arrival(self, *, stop: bool) -> int | None:
        if self.motion is None:
            return None
        method = getattr(self.motion, "invalidate" if stop else "admit", None)
        return int(method()) if callable(method) else None

    def execute(
        self,
        command: RobotCommand,
        *,
        arrival_epoch: int | None = None,
        motion_token: int | None = None,
    ) -> dict[str, Any]:
        fingerprint = command.fingerprint()
        wait_for: threading.Event | None = None
        with self._cache_lock:
            try:
                cached = self._cache.get(command)
            except ProtocolError as exc:
                return self._failure(command, "idempotency_conflict", str(exc))
            if cached is not None:
                cached["duplicate"] = True
                return cached
            if command.is_expired(now_ms=self._now_ms()):
                result = self._failure(command, "expired", "command TTL elapsed before execution")
                self._cache.put(command, result)
                return result
            if command.action not in self.supported_actions:
                result = self._failure(command, "unsupported_action", "robot action is not allowlisted")
                self._cache.put(command, result)
                return result
            if command.action in self.MOTION_ACTIONS:
                raw_duration_ms = command.parameters.get("durationMs")
                raw_duration_s = command.parameters.get("durationS")
                requested_ms: float | None = None
                if isinstance(raw_duration_ms, (int, float)) and not isinstance(raw_duration_ms, bool):
                    requested_ms = float(raw_duration_ms)
                elif isinstance(raw_duration_s, (int, float)) and not isinstance(raw_duration_s, bool):
                    requested_ms = float(raw_duration_s) * 1_000
                remaining_ms = command.issued_at_ms + command.ttl_ms - self._now_ms()
                if requested_ms is not None and requested_ms > remaining_ms:
                    result = self._failure(
                        command,
                        "rejected",
                        "motion duration exceeds the command TTL",
                    )
                    self._cache.put(command, result)
                    return result
            inflight = self._inflight.get(command.command_id)
            if inflight is not None:
                inflight_fingerprint, wait_for = inflight
                if inflight_fingerprint != fingerprint:
                    return self._failure(
                        command,
                        "idempotency_conflict",
                        "command id was reused with different parameters",
                    )
            else:
                self._inflight[command.command_id] = (fingerprint, threading.Event())
        if wait_for is not None:
            if not wait_for.wait(timeout=self.max_ttl_ms / 1_000 + 5.0):
                return self._failure(command, "hardware_error", "duplicate command wait timed out")
            with self._cache_lock:
                cached = self._cache.get(command)
            if cached is None:
                return self._failure(command, "hardware_error", "duplicate command result is unavailable")
            cached["duplicate"] = True
            return cached
        if command.action == "stop":
            started_epoch = self.admit_arrival(stop=True) if arrival_epoch is None else arrival_epoch
            result = self._execute_action(command, started_epoch, motion_token=None)
        else:
            queued_epoch = self.admit_arrival(stop=False) if arrival_epoch is None else arrival_epoch
            with self._lock:
                with self._cancel_lock:
                    cancelled_while_queued = self._cancel_epoch != queued_epoch
                if cancelled_while_queued:
                    result = self._failure(
                        command,
                        "cancelled",
                        "command was cancelled by stop before execution",
                    )
                elif command.is_expired(now_ms=self._now_ms()):
                    result = self._failure(
                        command,
                        "expired",
                        "command TTL elapsed while waiting to execute",
                    )
                else:
                    result = self._execute_action(command, queued_epoch, motion_token=motion_token)
        with self._cache_lock:
            self._cache.put(command, result)
            inflight = self._inflight.pop(command.command_id, None)
            if inflight is not None:
                inflight[1].set()
        return result

    def _execute_action(
        self,
        command: RobotCommand,
        started_epoch: int,
        *,
        motion_token: int | None,
    ) -> dict[str, Any]:
        handlers = {
            "stop": self._stop,
            "sleep": self._sleep,
            "wake": self._wake,
            "neutral": self._neutral,
            "look": self._look,
            "look_at_speaker": self._look_at_speaker,
            "set_antennas": self._antennas,
            "set_body_yaw": self._body_yaw,
            "set_motor_mode": self._motor_mode,
            "play_emotion": self._emotion,
            "play_move": self._play_move,
            "start_face_tracking": self._start_face_tracking,
            "stop_face_tracking": self._stop_face_tracking,
            "set_volume": self._set_volume,
            "set_microphone_volume": self._set_microphone_volume,
        }
        is_motion = command.action in self.MOTION_ACTIONS
        if is_motion:
            self.active_motion = command.action
            if motion_token is None and self.motion is not None:
                admit = getattr(self.motion, "admit", None)
                motion_token = int(admit()) if callable(admit) else None
            self._motion_context.token = motion_token
        try:
            if command.action == "snapshot":
                details = self._snapshot(command.command_id, command.parameters)
            elif command.action == "release_app":
                details = self._release_app(command.command_id, command.parameters)
            else:
                details = handlers[command.action](command.parameters)
            self.last_action = command.action
            self.last_action_at = utc_timestamp()
            with self._cancel_lock:
                cancelled = command.action in self.MOTION_ACTIONS and self._cancel_epoch != started_epoch
            if cancelled:
                result = {
                    "type": "robot_command_result",
                    "commandId": command.command_id,
                    "action": command.action,
                    "success": False,
                    "status": "cancelled",
                    "error": {
                        "code": "cancelled",
                        "message": "motion was cancelled by a stop command",
                    },
                    "completedAt": self.last_action_at,
                }
            else:
                result = {
                    "type": "robot_command_result",
                    "commandId": command.command_id,
                    "action": command.action,
                    "success": True,
                    "status": "completed",
                    "details": details,
                    "completedAt": self.last_action_at,
                }
        except MotionCancelled as exc:
            result = self._failure(command, "cancelled", str(exc))
        except MotionError:
            result = self._failure(
                command,
                "hardware_error",
                "Reachy Mini could not confirm the physical motion state",
            )
        except (RobotCommandError, ValueError, TypeError) as exc:
            result = self._failure(command, "rejected", str(exc))
        except Exception:
            # SDK internals can include serial/transport details; do not send them over the wire.
            result = self._failure(command, "hardware_error", "Reachy Mini could not complete the action")
        finally:
            if is_motion:
                self.active_motion = None
                if hasattr(self._motion_context, "token"):
                    del self._motion_context.token
        return result

    def _failure(self, command: RobotCommand, code: str, message: str) -> dict[str, Any]:
        if code == "cancelled":
            status = "cancelled"
        elif code in {"expired", "unsupported_action", "rejected", "idempotency_conflict"}:
            status = "rejected"
        else:
            status = "failed"
        return {
            "type": "robot_command_result",
            "commandId": command.command_id,
            "action": command.action,
            "success": False,
            "status": status,
            "error": {"code": code, "message": message},
            "completedAt": utc_timestamp(),
        }

    def _duration(self, parameters: Mapping[str, Any], default: float = 0.8) -> float:
        if "durationMs" in parameters:
            raw = parameters.get("durationMs")
            if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(float(raw)):
                raise RobotCommandError("durationMs must be finite and numeric")
            if not 100 <= float(raw) <= 5_000:
                raise RobotCommandError("durationMs must be between 100 and 5000")
            return float(raw) / 1_000
        raw = parameters.get("durationS", default)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(float(raw)):
            raise RobotCommandError("durationS must be finite and numeric")
        if not 0.1 <= float(raw) <= 5.0:
            raise RobotCommandError("durationS must be between 0.1 and 5.0")
        return float(raw)

    def _current_motion_token(self) -> int | None:
        value = getattr(self._motion_context, "token", None)
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def _stop(self, _parameters: Mapping[str, Any]) -> dict[str, Any]:
        motion_result: dict[str, Any] = {"cancelled": False, "uuid": None}
        motion_error: Exception | None = None
        if self.motion is not None:
            try:
                motion_result = dict(self.motion.stop())
            except Exception as exc:
                motion_error = exc
        self._stop_local_outputs()
        if motion_error is not None:
            raise MotionError("physical motion cancellation could not be confirmed") from motion_error
        return {"stopped": True, "motion": motion_result}

    def _stop_local_outputs(self) -> None:
        """Stop SDK-uploaded moves and audio without invalidating daemon admission."""

        errors: list[Exception] = []
        cancel = getattr(self.robot, "cancel_move", None)
        if callable(cancel):
            try:
                cancel()
            except Exception as exc:
                errors.append(exc)
        media = getattr(self.robot, "media", None)
        stop_playing = getattr(media, "stop_playing", None)
        if callable(stop_playing):
            try:
                stop_playing()
            except Exception as exc:
                errors.append(exc)
        else:
            clear = getattr(media, "clear_player", None)
            if callable(clear):
                try:
                    clear()
                except Exception as exc:
                    errors.append(exc)
        disable_wobbling = getattr(self.robot, "disable_wobbling", None)
        if callable(disable_wobbling):
            try:
                disable_wobbling()
                self.idle_motion_enabled = False
            except Exception as exc:
                errors.append(exc)
        try:
            self.tracking.stop_all()
            self.face_tracking = False
        except Exception as exc:
            errors.append(exc)
        if errors:
            raise MotionError("local playback or autonomous wobbling could not be stopped") from errors[0]

    def _sleep(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        if self.motion is None:
            raise RobotCommandError("cancellable sleep is unavailable")
        motion_token = self._current_motion_token()
        if motion_token is None:
            # Direct fail-safe calls can overlap a daemon task, so cancel it first
            # and then stamp the new sleep admission. Protocol commands already
            # hold the controller lock and retain their arrival-time token.
            self._stop(parameters)
            motion_token = self.motion.admit()
        else:
            self._stop_local_outputs()
        self.motion.sleep(token=motion_token)
        self.sleeping = True
        return {"sleeping": True}

    def _wake(self, _parameters: Mapping[str, Any]) -> dict[str, Any]:
        enable = getattr(self.robot, "enable_motors", None)
        if callable(enable):
            enable()
            self.motor_mode = "enabled"
        if self.motion is None:
            raise RobotCommandError("cancellable wake is unavailable")
        self.motion.wake(token=self._current_motion_token())
        self.sleeping = False
        return {"sleeping": False, "motorMode": self.motor_mode}

    def _neutral(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        if self.motion is None:
            raise RobotCommandError("cancellable neutral movement is unavailable")
        duration = self._duration(parameters, 1.0)
        self.motion.goto(
            head=_head_pose(),
            antennas=np.array([0.0, 0.0], dtype=np.float64),
            body_yaw=0.0,
            duration=duration,
            token=self._current_motion_token(),
        )
        self.sleeping = False
        return {"pose": "neutral", "durationS": duration}

    def _look(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        duration = self._duration(parameters)
        direction = parameters.get("direction")
        if direction is not None:
            if direction == "speaker":
                return self._look_at_speaker(parameters)
            orientations = {
                "left": (-35.0, 0.0),
                "right": (35.0, 0.0),
                "up": (0.0, -22.0),
                "down": (0.0, 22.0),
                "center": (0.0, 0.0),
            }
            if direction not in orientations:
                raise RobotCommandError("look direction must be left, right, up, down, center, or speaker")
            yaw_value, pitch_value = orientations[str(direction)]
            parameters = {**parameters, "yawDeg": yaw_value, "pitchDeg": pitch_value}
        if any(key in parameters for key in ("xM", "yM", "zM")):
            raise RobotCommandError("world-space look is not supported by the cancellable transport")

        yaw = _finite_number(parameters, "yawDeg", 0.0, -65.0, 65.0)
        pitch = _finite_number(parameters, "pitchDeg", 0.0, -40.0, 40.0)
        roll = _finite_number(parameters, "rollDeg", 0.0, -40.0, 40.0)
        if self.motion is None:
            raise RobotCommandError("cancellable look movement is unavailable")
        self.motion.goto(
            head=_head_pose(roll_deg=roll, pitch_deg=pitch, yaw_deg=yaw),
            body_yaw=None,
            duration=duration,
            token=self._current_motion_token(),
        )
        return {
            "orientationDeg": {"yaw": yaw, "pitch": pitch, "roll": roll},
            "durationS": duration,
        }

    def _look_at_speaker(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        if not self.speech_direction_enabled:
            raise RobotCommandError("speech direction is disabled by HomeBrain privacy settings")
        media = getattr(self.robot, "media", None)
        getter = getattr(media, "get_DoA", None)
        if not callable(getter):
            raise RobotCommandError("direction-of-arrival is unavailable")
        reading = getter()
        if not isinstance(reading, tuple) or len(reading) < 2 or reading[0] is None:
            raise RobotCommandError("no direction-of-arrival reading is available")
        angle, speech_detected = reading[:2]
        if not speech_detected:
            raise RobotCommandError("no active speaker was detected")
        yaw = max(-65.0, min(65.0, math.degrees(float(angle) - math.pi / 2)))
        merged = dict(parameters)
        merged.pop("direction", None)
        merged["yawDeg"] = yaw
        merged.setdefault("pitchDeg", 0.0)
        details = self._look(merged)
        details["speechDetected"] = True
        return details

    def _antennas(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        duration = self._duration(parameters, 0.5)
        position = parameters.get("position")
        presets = {
            "neutral": (0.0, 0.0),
            "up": (55.0, 55.0),
            "down": (-40.0, -40.0),
            "happy": (35.0, -35.0),
            "sad": (-25.0, 25.0),
            "curious": (40.0, 5.0),
        }
        if position is not None:
            if position not in presets:
                raise RobotCommandError("antenna position is not allowlisted")
            left, right = presets[str(position)]
        else:
            # Legacy compatibility is deliberately bounded and never advertised.
            left = _finite_number(parameters, "leftDeg", 0.0, -90.0, 90.0)
            right = _finite_number(parameters, "rightDeg", 0.0, -90.0, 90.0)
        if self.motion is None:
            raise RobotCommandError("cancellable antenna movement is unavailable")
        # Reachy SDK v1.9 orders its antenna array [right, left].
        self.motion.goto(
            antennas=np.deg2rad([right, left]),
            body_yaw=None,
            duration=duration,
            token=self._current_motion_token(),
        )
        return {
            "position": position,
            "anglesDeg": {"left": left, "right": right},
            "durationMs": round(duration * 1_000),
        }

    def _body_yaw(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        field = "angleDeg" if "angleDeg" in parameters else "yawDeg"
        yaw = _finite_number(parameters, field, 0.0, -45.0, 45.0)
        if self.motion is None:
            raise RobotCommandError("cancellable body yaw is unavailable")
        duration = self._duration(parameters, 0.8)
        self.motion.goto(
            body_yaw=math.radians(yaw),
            duration=duration,
            token=self._current_motion_token(),
        )
        return {"yawDeg": yaw, "durationMs": round(duration * 1_000)}

    def _motor_mode(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        mode = str(parameters.get("mode", "")).strip().lower()
        if mode not in self.MOTOR_MODES:
            raise RobotCommandError("motor mode must be enabled, disabled, or gravity_compensation")
        if mode == "enabled":
            method = getattr(self.robot, "enable_motors", None)
        elif mode == "disabled":
            self._stop(parameters)
            method = getattr(self.robot, "disable_motors", None)
        else:
            method = getattr(self.robot, "enable_gravity_compensation", None)
        if not callable(method):
            raise RobotCommandError(f"motor mode {mode} is unavailable")
        method()
        self.motor_mode = mode
        return {"motorMode": mode}

    def _emotion(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        name = str(parameters.get("emotion", parameters.get("name", ""))).strip().lower()
        if name not in self.EMOTIONS:
            raise RobotCommandError("emotion is not allowlisted")
        if self.emotion_hook is not None and self.emotion_hook(name, parameters):
            return {"emotion": name, "source": "hook"}
        if name == "neutral":
            details = self._neutral(parameters)
        else:
            presets = {
                "happy": (-7.0, 0.0, 0.0, 35.0, -35.0),
                "sad": (13.0, 0.0, 0.0, -25.0, 25.0),
                "curious": (-3.0, 9.0, 12.0, 40.0, 5.0),
                "listening": (0.0, 0.0, 0.0, 30.0, 30.0),
                "speaking": (-4.0, 0.0, 0.0, 20.0, -20.0),
                "alert": (-8.0, 0.0, 0.0, 55.0, 55.0),
            }
            pitch, roll, yaw, left, right = presets[name]
            duration = self._duration(parameters, 0.55)
            if self.motion is None:
                raise RobotCommandError("cancellable emotion movement is unavailable")
            self.motion.goto(
                head=_head_pose(roll_deg=roll, pitch_deg=pitch, yaw_deg=yaw),
                antennas=np.deg2rad([right, left]),
                body_yaw=None,
                duration=duration,
                token=self._current_motion_token(),
            )
            details = {"durationS": duration}
        return {"emotion": name, "source": "built-in", **details}

    def _play_move(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        name = str(parameters.get("move", "")).strip().lower()
        if name not in self.MOVES:
            raise RobotCommandError("move is not allowlisted")
        total = self._duration(parameters, 1.0)
        if self.motion is None:
            raise RobotCommandError("cancellable movement is unavailable")
        # Small deterministic gestures avoid downloading or executing arbitrary move assets.
        sequence: dict[str, list[tuple[float, float, float, float, float]]] = {
            "nod": [(0, -16, 0, 0, 0), (0, 14, 0, 0, 0), (0, 0, 0, 0, 0)],
            "yes": [(0, -16, 0, 0, 0), (0, 14, 0, 0, 0), (0, 0, 0, 0, 0)],
            "shake_head": [(0, 0, -24, 0, 0), (0, 0, 24, 0, 0), (0, 0, 0, 0, 0)],
            "no": [(0, 0, -24, 0, 0), (0, 0, 24, 0, 0), (0, 0, 0, 0, 0)],
            "greet": [(0, -6, -12, 50, -10), (0, -6, 12, -10, 50), (0, 0, 0, 0, 0)],
            "celebrate": [(-8, -8, 0, 55, -55), (8, -8, 0, -55, 55), (0, 0, 0, 0, 0)],
            "dance": [(-10, -4, -18, 45, -30), (10, -4, 18, -30, 45), (0, 0, 0, 0, 0)],
        }
        steps = sequence[name]
        step_duration = max(0.1, total / len(steps))
        for roll, pitch, yaw, left, right in steps:
            self.motion.goto(
                head=_head_pose(roll_deg=roll, pitch_deg=pitch, yaw_deg=yaw),
                antennas=np.deg2rad([right, left]),
                body_yaw=None,
                duration=step_duration,
                token=self._current_motion_token(),
            )
        return {"move": name, "durationMs": round(step_duration * len(steps) * 1_000)}

    def _set_volume(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        return self._volume("speaker", parameters)

    def _set_microphone_volume(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        return self._volume("microphone", parameters)

    def _volume(self, kind: str, parameters: Mapping[str, Any]) -> dict[str, Any]:
        volume = round(_finite_number(parameters, "volume", 50.0, 0.0, 100.0))
        if self.volume_hook is None:
            raise RobotCommandError(f"{kind} volume control is unavailable")
        return dict(self.volume_hook(kind, volume))

    def _snapshot(self, command_id: str, parameters: Mapping[str, Any]) -> dict[str, Any]:
        quality = round(_finite_number(parameters, "quality", 85.0, 10.0, 95.0))
        if self.snapshot_hook is None:
            raise RobotCommandError("snapshot is unavailable")
        return dict(self.snapshot_hook(command_id, quality))

    def _release_app(self, command_id: str, _parameters: Mapping[str, Any]) -> dict[str, Any]:
        if self.release_hook is None:
            raise RobotCommandError("managed app release is unavailable")
        self.apply_safe_policy("sleep")
        self.release_hook(command_id)
        return {"released": True}

    def _start_face_tracking(self, parameters: Mapping[str, Any]) -> dict[str, Any]:
        if not self.camera_enabled:
            raise RobotCommandError("camera access is disabled by HomeBrain privacy settings")
        weight = _finite_number(parameters, "weight", 1.0, 0.0, 1.0)
        try:
            self.tracking.request("explicit", weight)
        except PerceptionError as exc:
            raise RobotCommandError(str(exc)) from exc
        self.face_tracking = self.tracking.active
        return {"faceTracking": True, "weight": weight}

    def _stop_face_tracking(self, _parameters: Mapping[str, Any]) -> dict[str, Any]:
        self.tracking.release("explicit")
        self.face_tracking = self.tracking.active
        return {"faceTracking": self.face_tracking}

    def state(self) -> dict[str, Any]:
        self.face_tracking = self.tracking.active
        state: dict[str, Any] = {
            "mode": self.motor_mode,
            "awake": not self.sleeping,
            "activeMotion": self.active_motion,
            "activeApp": "reachy-homebrain-app",
            "motorMode": self.motor_mode,
            "sleeping": self.sleeping,
            "faceTracking": self.face_tracking,
            "cameraEnabled": self.camera_enabled,
            "speechDirectionEnabled": self.speech_direction_enabled,
            "lastAction": self.last_action,
            "lastActionAt": self.last_action_at,
            "defaultEmotion": self.default_emotion,
            "idleMotionEnabled": self.idle_motion_enabled,
            "visionMode": self.vision_mode,
        }
        getters = {
            "headPose": "get_current_head_pose",
            "antennasRad": "get_present_antenna_joint_positions",
        }
        for field, method_name in getters.items():
            method = getattr(self.robot, method_name, None)
            if callable(method):
                try:
                    state[field] = _json_safe(method())
                except Exception:
                    state[f"{field}Available"] = False
        doa = getattr(getattr(self.robot, "media", None), "get_DoA", None)
        if self.speech_direction_enabled and callable(doa):
            try:
                reading = doa()
                if isinstance(reading, tuple) and len(reading) >= 2 and reading[0] is not None:
                    angle = max(0.0, min(math.pi, float(reading[0])))
                    # Canonical server fields are flat degrees + speech boolean.
                    state["speechDirection"] = max(0.0, min(180.0, math.degrees(angle)))
                    state["speechDetected"] = bool(reading[1])
            except Exception:
                state["speechDirectionAvailable"] = False
        # Round-trip catches accidental non-finite or SDK-specific values before transport.
        return json.loads(json.dumps(state, allow_nan=False))

    def apply_safe_policy(self, policy: str, *, require_confirmation: bool = False) -> None:
        """Reach a safe pose, optionally requiring a confirmed fallback stop."""

        first_error: Exception | None = None
        try:
            if policy == "sleep":
                self._sleep({})
            elif policy == "neutral" and self.motor_mode != "disabled":
                self._stop({})
                self._neutral({"durationS": 1.0})
            else:
                self._stop({})
        except Exception as exc:
            first_error = exc
            try:
                self._stop({})
            except Exception as fallback_error:
                if require_confirmation:
                    raise MotionError("Reachy safe policy could not be confirmed") from fallback_error
        if require_confirmation and first_error is not None:
            # The requested pose failed, but a confirmed emergency stop is a safe
            # terminal substitute and therefore satisfies the prepare barrier.
            return
