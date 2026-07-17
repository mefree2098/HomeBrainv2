from __future__ import annotations

import json
from typing import Any

import pytest
from conftest import FakeMotion, FakeRobot

from reachy_homebrain.client import HomeBrainClient, PrivacyConfigurationError
from reachy_homebrain.protocol import ProtocolError
from reachy_homebrain.robot import RobotController


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed: tuple[int, str] | None = None

    async def send(self, value: str) -> None:
        self.sent.append(json.loads(value))

    async def close(self, *, code: int, reason: str) -> None:
        self.closed = (code, reason)


class FakeTts:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def play(self, text: str, voice: str) -> dict[str, Any]:
        self.calls.append((text, voice))
        return {"played": True, "bytes": 42, "format": "wav"}


class FakeWakeRuntime:
    def __init__(self) -> None:
        self.configs = []
        self.suspended = False

    def configure(self, config):
        self.configs.append(config)
        return self.health()

    def health(self):
        return {"state": "ready", "models": ["Anna"], "error": None}

    def suspend(self):
        self.suspended = True

    def resume(self):
        self.suspended = False

    def process_pcm(self, _pcm):
        return []


def make_client(config, robot: FakeRobot, **kwargs):
    controller = RobotController(
        robot,
        now_ms=lambda: 1_700_000_000_000,
        motion=FakeMotion(robot),
    )
    client = HomeBrainClient(config, robot, controller, FakeTts(), **kwargs)
    websocket = FakeWebSocket()
    client.websocket = websocket
    return client, websocket


@pytest.mark.asyncio
async def test_auth_success_reports_status_without_promoting_pending_release(config, robot) -> None:
    wake = FakeWakeRuntime()
    healthy: list[bool] = []
    client, websocket = make_client(
        config,
        robot,
        wake_word=wake,
        health_callback=lambda *_identity: healthy.append(True),
    )
    await client.handle_message(
        {
            "type": "auth_success",
            "config": {
                "wakeWords": ["Anna"],
                "wakeWord": {"assets": []},
                "robot": {
                    "settings": {
                        "microphoneEnabled": True,
                        "wakeWordEnabled": True,
                        "speechDirectionEnabled": True,
                    }
                },
            },
        }
    )
    types = [message["type"] for message in websocket.sent]
    assert types == ["status_update", "robot_state", "robot_capabilities"]
    assert websocket.sent[1]["state"]["activeApp"] == "reachy-homebrain-app"
    assert "wake_word" in websocket.sent[2]["capabilities"]
    assert healthy == []
    assert client._wake_config_tail is not None
    await client._wake_config_tail
    assert wake.configs


@pytest.mark.asyncio
async def test_wake_detection_transitions_to_chunked_command_session(config, robot) -> None:
    wake = FakeWakeRuntime()
    client, websocket = make_client(config, robot, wake_word=wake)
    client.authenticated.set()
    await client._apply_robot_config({"microphoneEnabled": True, "wakeWordEnabled": True})
    client._pre_roll.append(b"\x01\x00" * 20)
    await client.notify_wake_word("Anna", 0.91)
    assert websocket.sent[-1]["type"] == "wake_word_detected"
    assert wake.suspended is True
    capture_grant_id = "12345678-1234-4123-8123-123456789abc"
    await client.handle_message(
        {
            "type": "wake_word_ack",
            "timeout": 2_000,
            "captureGrantId": capture_grant_id,
        }
    )
    sent_types = [message["type"] for message in websocket.sent]
    assert "audio_data" in sent_types
    start = next(message for message in websocket.sent if message.get("isStart"))
    assert start["sampleRate"] == 16_000
    assert start["channels"] == 1
    assert start["format"] == "S16LE"
    assert start["sessionId"] == capture_grant_id
    assert start["captureGrantId"] == capture_grant_id
    assert any(message.get("preRoll") for message in websocket.sent)
    await client._finish_audio_session()
    assert websocket.sent[-2]["isFinal"] is True
    assert websocket.sent[-1]["event"] == "voice_session_completed"
    assert wake.suspended is False


@pytest.mark.asyncio
async def test_wake_capture_grant_is_required_bound_and_one_shot(config, robot) -> None:
    client, websocket = make_client(config, robot)
    client.authenticated.set()
    await client._apply_robot_config({"microphoneEnabled": True})

    with pytest.raises(ProtocolError, match="captureGrantId"):
        await client.handle_message({"type": "wake_word_ack", "timeout": 2_000})
    grant = "abcdefab-cdef-4abc-8def-abcdefabcdef"
    with pytest.raises(ProtocolError, match="did not match"):
        await client.handle_message(
            {
                "type": "wake_word_ack",
                "captureGrantId": grant,
                "sessionId": "different-session-id",
            }
        )
    await client.handle_message({"type": "wake_word_ack", "timeout": 2_000, "captureGrantId": grant})
    start = websocket.sent[-2]
    assert start["type"] == "audio_data"
    assert start["isStart"] is True
    assert start["sessionId"] == grant
    assert start["captureGrantId"] == grant
    await client._finish_audio_session()
    with pytest.raises(ProtocolError, match="replayed"):
        await client.handle_message({"type": "wake_word_ack", "timeout": 2_000, "captureGrantId": grant})
    assert sum(message.get("isStart") is True for message in websocket.sent) == 1


@pytest.mark.asyncio
async def test_confirm_update_is_correlated_and_is_only_health_promotion(config, robot) -> None:
    calls: list[tuple[str, str, str]] = []

    def confirm(request_id: str, version: str, digest: str):
        calls.append((request_id, version, digest))
        return {"version": version, "aggregateSha256": digest}

    client, websocket = make_client(config, robot, health_callback=confirm)
    client.authenticated.set()
    digest = "a" * 64
    await client.handle_message(
        {
            "type": "app_management",
            "action": "confirm_update",
            "requestId": "update-1",
            "version": "0.2.0",
            "aggregateSha256": digest,
        }
    )
    assert calls == [("update-1", "0.2.0", digest)]
    assert websocket.sent[-1] == {
        "type": "app_management_result",
        "action": "confirm_update",
        "requestId": "update-1",
        "success": True,
        "status": "confirmed",
        "version": "0.2.0",
        "aggregateSha256": digest,
    }


@pytest.mark.asyncio
async def test_microphone_runtime_gate_starts_stops_and_clears_preroll(config, robot) -> None:
    import asyncio
    import threading

    client, websocket = make_client(config, robot, wake_word=FakeWakeRuntime())
    client.authenticated.set()
    stop_event = threading.Event()
    task = asyncio.create_task(client._audio_loop(stop_event))
    await asyncio.sleep(0.03)
    assert not any(name == "start_recording" for name, _ in robot.media.calls)

    await client._apply_robot_config({"microphoneEnabled": True, "wakeWordEnabled": True})
    await asyncio.sleep(0.03)
    assert any(name == "start_recording" for name, _ in robot.media.calls)
    client._pre_roll.append(b"private audio")

    await client._apply_robot_config({"microphoneEnabled": False, "wakeWordEnabled": False})
    await asyncio.sleep(0.03)
    await client.notify_wake_word("Anna", 0.99)
    assert len(client._pre_roll) == 0
    assert any(name == "stop_recording" for name, _ in robot.media.calls)
    assert not any(message.get("type") == "wake_word_detected" for message in websocket.sent)
    stop_event.set()
    await task


@pytest.mark.asyncio
async def test_robot_command_result_uses_terminal_status_and_canonical_event(config, robot) -> None:
    client, websocket = make_client(config, robot)
    client.authenticated.set()
    await client.handle_message(
        {
            "type": "robot_command",
            "protocolVersion": 1,
            "command": {
                "id": "stop-1",
                "action": "stop",
                "parameters": {},
                "issuedAt": 1_700_000_000_000,
                "ttlMs": 5000,
            },
        }
    )
    assert websocket.sent[-2]["type"] == "robot_command_result"
    assert websocket.sent[-2]["status"] == "completed"
    assert websocket.sent[-1]["event"] == "motion_stopped"


@pytest.mark.asyncio
async def test_tts_response_uses_homebrain_player(config, robot) -> None:
    client, websocket = make_client(config, robot)
    client.authenticated.set()
    await client.handle_message({"type": "tts_response", "text": "Done", "voice": "voice-1"})
    assert client.tts.calls == [("Done", "voice-1")]
    assert websocket.sent[-1]["settings"]["reachyTts"]["played"] is True


@pytest.mark.asyncio
async def test_status_reports_only_sanitized_cached_daemon_observability(config, robot) -> None:
    calls = 0

    def daemon_status():
        nonlocal calls
        calls += 1
        return {
            "daemonVersion": "1.9.0",
            "wireless": True,
            "simulation": False,
            "state": "running",
        }

    client, websocket = make_client(config, robot, daemon_status_provider=daemon_status)
    client.authenticated.set()
    await client.send_status(reason="daemon_observability")
    await client.send_capabilities()
    expected = {
        "daemonVersion": "1.9.0",
        "wireless": True,
        "simulation": False,
        "state": "running",
    }
    assert websocket.sent[-3]["settings"]["reachy"]["package"]["daemon"] == expected
    assert websocket.sent[-2]["package"]["daemon"] == expected
    assert websocket.sent[-1]["package"]["daemon"] == expected
    assert calls == 1


@pytest.mark.asyncio
async def test_event_wire_names_are_backend_allowlisted(config, robot) -> None:
    client, websocket = make_client(config, robot)
    client.authenticated.set()
    for name in ("motion_completed", "person_present", "voice_session_started", "error"):
        await client.emit_event(name, {})
    assert [item["event"] for item in websocket.sent] == [
        "motion_completed",
        "person_present",
        "voice_session_started",
        "error",
    ]


@pytest.mark.asyncio
async def test_prepare_is_safe_before_ack_and_only_correlated_release_stops(config, robot) -> None:
    digest = "a" * 64
    order: list[str] = []

    class OrderedWebSocket(FakeWebSocket):
        async def send(self, value: str) -> None:
            payload = json.loads(value)
            order.append(f"send:{payload.get('action')}:{payload.get('status')}")
            self.sent.append(payload)

    class FakeReleaseManager:
        def prepare_update(self, request_id, version, aggregate):
            order.append("arm")
            return {
                "requestId": request_id,
                "version": version,
                "aggregateSha256": aggregate,
            }

        def authorize_launch(self, request_id, version, aggregate):
            assert (request_id, version, aggregate) == ("update-1", "0.2.0", digest)
            order.append("authorize")
            return {}

        def report(self):
            return {"version": None, "aggregateSha256": None, "pending": None}

    stopped: list[str] = []
    client, _ = make_client(
        config,
        robot,
        release_manager=FakeReleaseManager(),
        release_callback=lambda reason: (order.append("stop"), stopped.append(reason)),
    )
    websocket = OrderedWebSocket()
    client.websocket = websocket
    client.authenticated.set()
    original_safe = client.controller.apply_safe_policy

    def safe(policy, **kwargs):
        order.append("safe")
        original_safe(policy, **kwargs)

    client.controller.apply_safe_policy = safe
    await client.handle_message(
        {
            "type": "app_management",
            "action": "prepare_update",
            "requestId": "update-1",
            "version": "0.2.0",
            "aggregateSha256": digest,
        }
    )
    assert order == ["arm", "safe", "send:prepare_update:prepared"]
    assert stopped == []
    assert client.safe_shutdown_applied is True

    await client.handle_message(
        {
            "type": "app_management",
            "action": "release",
            "requestId": "release-1",
            "parentRequestId": "update-1",
            "version": "0.2.0",
            "aggregateSha256": digest,
        }
    )
    assert order[-3:] == ["authorize", "send:release:releasing", "stop"]
    assert stopped == ["release"]
    assert websocket.sent[-1]["parentRequestId"] == "update-1"


@pytest.mark.asyncio
async def test_prepare_never_acknowledges_an_unconfirmed_physical_safe_policy(config, robot) -> None:
    digest = "a" * 64

    class FakeReleaseManager:
        def prepare_update(self, request_id, version, aggregate):
            return {
                "requestId": request_id,
                "version": version,
                "aggregateSha256": aggregate,
            }

        def report(self):
            return {"version": None, "aggregateSha256": None, "pending": None}

    client, websocket = make_client(
        config,
        robot,
        release_manager=FakeReleaseManager(),
        release_callback=lambda _reason: pytest.fail("failed prepare must not release"),
    )
    client.authenticated.set()

    def fail_safe_policy(_policy, **_kwargs):
        raise RuntimeError("simulated unconfirmed physical state")

    client.controller.apply_safe_policy = fail_safe_policy
    await client.handle_message(
        {
            "type": "app_management",
            "action": "prepare_update",
            "requestId": "update-unsafe",
            "version": "0.2.0",
            "aggregateSha256": digest,
        }
    )
    assert websocket.sent[-1] == {
        "type": "update_status",
        "requestId": "update-unsafe",
        "action": "prepare_update",
        "status": "failed",
        "success": False,
        "error": "Reachy physical safe policy could not be confirmed",
    }
    assert client.safe_shutdown_applied is False
    assert client._prepared_release is None


@pytest.mark.asyncio
async def test_release_mismatch_is_rejected_without_stopping(config, robot) -> None:
    class FakeReleaseManager:
        def report(self):
            return {"version": None, "aggregateSha256": None, "pending": None}

    stopped: list[str] = []
    client, websocket = make_client(
        config,
        robot,
        release_manager=FakeReleaseManager(),
        release_callback=stopped.append,
    )
    client.authenticated.set()
    await client.handle_message(
        {
            "type": "app_management",
            "action": "release",
            "requestId": "release-1",
            "parentRequestId": "unknown-update",
            "version": "0.2.0",
            "aggregateSha256": "a" * 64,
        }
    )
    assert websocket.sent[-1]["success"] is False
    assert stopped == []


@pytest.mark.asyncio
async def test_robot_privacy_updates_apply_in_exact_wire_order(config, robot) -> None:
    import asyncio
    import threading

    client, _ = make_client(config, robot)
    client.authenticated.set()
    started = threading.Event()
    release = threading.Event()
    original = client.controller.configure_privacy

    def blocked_configure(**settings):
        if settings["camera_enabled"]:
            started.set()
            release.wait(2.0)
        return original(**settings)

    client.controller.configure_privacy = blocked_configure
    await client._dispatch_responsive(
        {
            "type": "robot_config_update",
            "settings": {
                "microphoneEnabled": True,
                "cameraEnabled": True,
                "presenceDetectionEnabled": True,
                "snapshotEnabled": True,
            },
        }
    )
    assert await asyncio.to_thread(started.wait, 1.0)
    await client._dispatch_responsive(
        {
            "type": "robot_config_update",
            "settings": {
                "microphoneEnabled": False,
                "cameraEnabled": False,
                "presenceDetectionEnabled": False,
                "snapshotEnabled": False,
            },
        }
    )
    release.set()
    assert client._config_tail is not None
    await client._config_tail
    assert client._privacy["microphoneEnabled"] is False
    assert client._privacy["cameraEnabled"] is False
    assert client.controller.state()["cameraEnabled"] is False
    tracking_calls = [
        name for name, _ in robot.calls if name in {"start_head_tracking", "stop_head_tracking"}
    ]
    assert not tracking_calls or tracking_calls[-1] == "stop_head_tracking"


@pytest.mark.asyncio
async def test_privacy_off_has_reserved_admission_when_operation_queue_is_saturated(config, robot) -> None:
    import asyncio

    client, _ = make_client(config, robot)
    client.authenticated.set()
    await client._apply_robot_config(
        {
            "microphoneEnabled": True,
            "cameraEnabled": True,
            "presenceDetectionEnabled": True,
        }
    )
    blockers = {asyncio.create_task(asyncio.sleep(60)) for _ in range(16)}
    client._message_tasks.update(blockers)
    await client._dispatch_responsive(
        {
            "type": "robot_config_update",
            "settings": {
                "microphoneEnabled": False,
                "cameraEnabled": False,
                "presenceDetectionEnabled": False,
            },
        }
    )
    assert client._config_tail is not None
    await client._config_tail
    assert client._privacy["microphoneEnabled"] is False
    assert client.controller.state()["cameraEnabled"] is False
    for task in blockers:
        task.cancel()
    await asyncio.gather(*blockers, return_exceptions=True)


@pytest.mark.asyncio
async def test_configuration_bypass_is_bounded_and_disconnects_fail_closed(config, robot) -> None:
    import asyncio

    client, websocket = make_client(config, robot)
    client.authenticated.set()
    client._privacy["microphoneEnabled"] = True
    blockers = {asyncio.create_task(asyncio.sleep(60), name=f"reachy-config-{index}") for index in range(8)}
    client._message_tasks.update(blockers)
    with pytest.raises(ProtocolError, match="queue limit"):
        await client._dispatch_responsive(
            {
                "type": "robot_config_update",
                "settings": {"microphoneEnabled": False},
            }
        )
    assert client._privacy["microphoneEnabled"] is False
    assert websocket.closed == (1008, "configuration queue limit")
    for task in blockers:
        task.cancel()
    await asyncio.gather(*blockers, return_exceptions=True)


@pytest.mark.asyncio
async def test_auth_acceptance_is_not_blocked_by_slow_wake_assets_and_privacy_is_fresh(config, robot) -> None:
    import asyncio
    import threading

    class BlockingWake(FakeWakeRuntime):
        def __init__(self):
            super().__init__()
            self.started = threading.Event()
            self.release = threading.Event()

        def configure(self, config):
            self.started.set()
            self.release.wait(2.0)
            return super().configure(config)

    wake = BlockingWake()
    client, _ = make_client(config, robot, wake_word=wake)
    client._privacy["microphoneEnabled"] = True
    client._privacy["cameraEnabled"] = True
    await client._reset_privacy_fail_closed()
    await client.handle_message(
        {
            "type": "auth_success",
            "config": {
                "wakeWord": {"assets": []},
                "robot": {
                    "settings": {
                        "microphoneEnabled": False,
                        "cameraEnabled": False,
                    }
                },
            },
        }
    )
    assert client.auth_accepted.is_set()
    assert client.authenticated.is_set()
    assert client._privacy["microphoneEnabled"] is False
    assert client.controller.state()["cameraEnabled"] is False
    assert await asyncio.to_thread(wake.started.wait, 1.0)
    assert client._wake_config_tail is not None and not client._wake_config_tail.done()
    assert wake.suspended is True
    wake.release.set()
    await client._wake_config_tail
    assert wake.suspended is True


@pytest.mark.asyncio
async def test_physical_privacy_disable_failure_latches_disconnects_and_requires_retry(config, robot) -> None:
    client, websocket = make_client(config, robot)
    client.authenticated.set()
    await client._apply_robot_config(
        {
            "cameraEnabled": True,
            "presenceDetectionEnabled": True,
            "faceTrackingDefault": True,
            "microphoneEnabled": True,
            "wakeWordEnabled": True,
        }
    )
    assert any(name == "start_head_tracking" for name, _ in robot.calls)

    original_stop = robot.stop_head_tracking

    def fail_stop() -> None:
        raise RuntimeError("simulated physical stop failure")

    robot.stop_head_tracking = fail_stop
    start_count = sum(name == "start_head_tracking" for name, _ in robot.calls)
    await client._dispatch_responsive(
        {
            "type": "robot_config_update",
            "settings": {
                "cameraEnabled": False,
                "presenceDetectionEnabled": False,
                "faceTrackingDefault": False,
                "microphoneEnabled": False,
                "wakeWordEnabled": False,
            },
        }
    )
    failed_off = client._config_tail
    assert failed_off is not None
    await client._dispatch_responsive(
        {
            "type": "robot_config_update",
            "settings": {
                "cameraEnabled": True,
                "presenceDetectionEnabled": True,
                "faceTrackingDefault": True,
                "microphoneEnabled": True,
                "wakeWordEnabled": True,
            },
        }
    )
    queued_enable = client._config_tail
    assert queued_enable is not None
    with pytest.raises(PrivacyConfigurationError, match="could not be confirmed"):
        await failed_off
    with pytest.raises(PrivacyConfigurationError, match="earlier physical privacy transition"):
        await queued_enable

    assert client._privacy_fault == "physical privacy state could not be confirmed"
    assert all(value is False for value in client._privacy.values())
    assert not client.authenticated.is_set()
    assert websocket.closed == (1011, "Reachy privacy state unconfirmed")
    assert sum(name == "start_head_tracking" for name, _ in robot.calls) == start_count
    assert any(
        message.get("settings", {}).get("reachy", {}).get("reason") == "privacy_config_failed"
        for message in websocket.sent
    )
    assert not any(
        message.get("settings", {}).get("reachy", {}).get("reason") == "robot_config_updated"
        for message in websocket.sent
    )

    client.authenticated.set()
    await client._handle_robot_command(
        {
            "type": "robot_command",
            "protocolVersion": 1,
            "command": {
                "id": "blocked-by-privacy-fault",
                "action": "look",
                "parameters": {"direction": "left"},
            },
        }
    )
    assert websocket.sent[-1]["error"]["code"] == "privacy_fault"
    assert not any(name == "goto_target" and value is not None for name, value in robot.calls)

    robot.stop_head_tracking = original_stop
    await client._apply_robot_config(
        {
            "cameraEnabled": False,
            "presenceDetectionEnabled": False,
            "faceTrackingDefault": False,
            "microphoneEnabled": False,
            "wakeWordEnabled": False,
        }
    )
    assert client._privacy_fault is None
    assert "privacyFault" not in client._remote_config
    assert client.controller.state()["cameraEnabled"] is False


@pytest.mark.asyncio
async def test_microphone_stop_failure_faults_closed_until_confirmed_retry(config, robot) -> None:
    import asyncio
    import threading

    client, websocket = make_client(config, robot, wake_word=FakeWakeRuntime())
    client.authenticated.set()
    stop_event = threading.Event()
    audio_task = asyncio.create_task(client._audio_loop(stop_event))
    await client._apply_robot_config({"microphoneEnabled": True, "wakeWordEnabled": True})
    for _ in range(50):
        if client._audio_recording_active:
            break
        await asyncio.sleep(0.01)
    assert client._audio_recording_active is True
    assert any(name == "start_recording" for name, _ in robot.media.calls)

    original_stop = robot.media.stop_recording

    def fail_stop() -> None:
        robot.media.calls.append(("stop_recording_failed", None))
        raise RuntimeError("simulated microphone stop failure")

    robot.media.stop_recording = fail_stop
    await client._dispatch_responsive(
        {
            "type": "robot_config_update",
            "settings": {"microphoneEnabled": False, "wakeWordEnabled": False},
        }
    )
    failed_off = client._config_tail
    assert failed_off is not None
    with pytest.raises(PrivacyConfigurationError, match="could not be confirmed"):
        await failed_off

    assert client._audio_recording_active is True
    assert client._privacy_fault == "physical privacy state could not be confirmed"
    assert all(value is False for value in client._privacy.values())
    assert not client.authenticated.is_set()
    assert websocket.closed == (1011, "Reachy privacy state unconfirmed")
    assert len(client._pre_roll) == 0
    assert client._audio_session is None

    client.authenticated.set()
    await client._handle_robot_command(
        {
            "type": "robot_command",
            "protocolVersion": 1,
            "command": {
                "id": "blocked-by-microphone-privacy-fault",
                "action": "look",
                "parameters": {"direction": "left"},
            },
        }
    )
    assert websocket.sent[-1]["error"]["code"] == "privacy_fault"
    await client.notify_wake_word("Anna", 0.99)
    assert not any(message.get("type") == "wake_word_detected" for message in websocket.sent)

    robot.media.stop_recording = original_stop
    await client._apply_robot_config({"microphoneEnabled": False, "wakeWordEnabled": False})
    assert client._audio_recording_active is False
    assert client._privacy_fault is None
    assert "privacyFault" not in client._remote_config

    stop_event.set()
    await audio_task


@pytest.mark.asyncio
async def test_stale_microphone_start_is_rejected_after_privacy_gate_closes(config, robot) -> None:
    client, _ = make_client(config, robot)
    client.authenticated.set()
    await client._apply_robot_config({"microphoneEnabled": True})
    stale_generation = client._audio_recording_generation
    client._disable_software_privacy()

    started = await client._set_audio_recording(True, generation=stale_generation)

    assert started is False
    assert client._audio_recording_active is False
    assert not any(name == "start_recording" for name, _ in robot.media.calls)
