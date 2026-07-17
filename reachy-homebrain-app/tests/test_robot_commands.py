from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest
from conftest import FakeMotion, FakeRobot

from reachy_homebrain.robot import RobotController

NOW = 1_700_000_000_000


def command(command_id: str, action: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "type": "robot_command",
        "protocolVersion": 1,
        "command": {
            "id": command_id,
            "action": action,
            "parameters": parameters or {},
            "issuedAt": NOW,
            "ttlMs": 5_000,
        },
    }


@pytest.fixture
def controller(robot: FakeRobot) -> RobotController:
    value = RobotController(
        robot,
        now_ms=lambda: NOW,
        snapshot_hook=lambda command_id, quality: {"snapshot": {"id": command_id, "quality": quality}},
        release_hook=lambda command_id: robot._record("release", command_id),
        volume_hook=lambda kind, volume: {"kind": kind, "volume": volume},
        motion=FakeMotion(robot),
    )
    value.configure_privacy(
        camera_enabled=True,
        speech_direction_enabled=True,
        face_tracking_default=False,
    )
    return value


@pytest.mark.parametrize(
    ("action", "parameters"),
    [
        ("wake", {}),
        ("sleep", {}),
        ("neutral", {}),
        ("stop", {}),
        ("look", {"direction": "left", "durationMs": 300}),
        ("look", {"direction": "speaker"}),
        ("set_antennas", {"position": "curious", "durationMs": 300}),
        ("set_body_yaw", {"angleDeg": 90}),
        ("set_motor_mode", {"mode": "gravity_compensation"}),
        ("play_emotion", {"emotion": "happy"}),
        ("play_move", {"move": "nod", "durationMs": 600}),
        ("start_face_tracking", {}),
        ("stop_face_tracking", {}),
        ("set_volume", {"volume": 200}),
        ("set_microphone_volume", {"volume": -5}),
        ("snapshot", {"quality": 90}),
        ("release_app", {}),
    ],
)
def test_every_canonical_action_completes(
    controller: RobotController, action: str, parameters: dict[str, Any]
) -> None:
    identity = "-".join(f"{key}-{value}" for key, value in sorted(parameters.items())) or "none"
    result = controller.execute_message(command(f"id-{action}-{identity}", action, parameters))
    assert result["status"] == "completed", result
    assert result["success"] is True


def test_asymmetric_antenna_preset_uses_sdk_right_left_order(
    controller: RobotController, robot: FakeRobot
) -> None:
    result = controller.execute_message(command("antenna-order", "set_antennas", {"position": "curious"}))
    assert result["status"] == "completed"
    kwargs = [value for name, value in robot.calls if name == "goto_target"][-1]
    # API labels curious=(left 40°, right 5°); SDK array must be [right, left].
    assert np.rad2deg(kwargs["antennas"]).tolist() == pytest.approx([5.0, 40.0])


def test_body_yaw_is_clamped_to_homebrain_contract(controller: RobotController, robot: FakeRobot) -> None:
    controller.execute_message(command("body-limit", "set_body_yaw", {"angleDeg": 999}))
    value = [value for name, value in robot.calls if name == "goto_target"][-1]
    assert math.degrees(value["body_yaw"]) == pytest.approx(45.0)


def test_idempotent_duplicate_does_not_repeat_motion(controller: RobotController, robot: FakeRobot) -> None:
    payload = command("same", "look", {"direction": "right"})
    first = controller.execute_message(payload)
    call_count = len(robot.calls)
    second = controller.execute_message(payload)
    assert first["status"] == "completed"
    assert second["duplicate"] is True
    assert len(robot.calls) == call_count


def test_reused_id_with_different_payload_is_rejected(controller: RobotController) -> None:
    controller.execute_message(command("collision", "stop"))
    result = controller.execute_message(command("collision", "wake"))
    assert result["status"] == "rejected"
    assert result["error"]["code"] == "idempotency_conflict"


def test_expired_command_never_touches_robot(robot: FakeRobot) -> None:
    controller = RobotController(robot, now_ms=lambda: NOW + 10_000)
    result = controller.execute_message(command("expired", "wake"))
    assert result["status"] == "rejected"
    assert robot.calls == []


def test_unknown_action_is_rejected(controller: RobotController) -> None:
    result = controller.execute_message(command("unsafe", "invoke_python", {"code": "bad"}))
    assert result["status"] == "rejected"


def test_state_exposes_canonical_doa_and_awake_fields(controller: RobotController, robot: FakeRobot) -> None:
    robot.media.doa = (math.pi / 2, True)
    state = controller.state()
    assert state["awake"] is True
    assert state["activeApp"] == "reachy-homebrain-app"
    assert state["speechDirection"] == pytest.approx(90.0)
    assert state["speechDetected"] is True
