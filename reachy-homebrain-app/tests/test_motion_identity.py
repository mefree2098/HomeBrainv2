from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import pytest
from conftest import FakeResponse, RoutingOpener
from test_robot_commands import NOW, command

from reachy_homebrain.identity import (
    DaemonStatusError,
    HardwareIdentityError,
    read_daemon_status,
    read_hardware_id,
)
from reachy_homebrain.motion import LocalMotionService, MotionCancelled, MotionError
from reachy_homebrain.robot import RobotController

MOVE_UUID = "00000000-0000-0000-0000-000000000001"


class FakeEvents:
    def __init__(self, messages: list[Any]):
        self.messages = [
            json.dumps(message) if isinstance(message, dict) else message for message in messages
        ]

    def __enter__(self) -> FakeEvents:
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def recv(self, timeout: float) -> str:
        del timeout
        if not self.messages:
            raise TimeoutError
        value = self.messages.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


@pytest.mark.parametrize(
    ("terminal", "error"),
    [
        ("move_completed", None),
        ("move_cancelled", MotionCancelled),
        ("move_failed", MotionError),
    ],
)
def test_motion_waits_for_truthful_daemon_terminal_event(robot, terminal, error) -> None:
    url = "http://127.0.0.1:8000/api/move/goto"
    opener = RoutingOpener({url: FakeResponse({"uuid": MOVE_UUID}, url=url)})
    service = LocalMotionService(
        robot,
        opener=opener,
        event_connector=lambda _url: FakeEvents(
            [
                {"type": "move_started", "uuid": MOVE_UUID},
                {"type": terminal, "uuid": MOVE_UUID},
            ]
        ),
    )
    if error is None:
        result = service.goto(head=np.eye(4), duration=0.2)
        assert result == {"uuid": MOVE_UUID, "completed": True}
    else:
        with pytest.raises(error):
            service.goto(head=np.eye(4), duration=0.2)
    payload = json.loads(opener.requests[0].data)
    assert payload["head_pose"] == {"m": np.eye(4).flatten().tolist()}


def test_invalidated_motion_never_reaches_daemon(robot) -> None:
    opener = RoutingOpener({})
    service = LocalMotionService(
        robot,
        opener=opener,
        event_connector=lambda _url: FakeEvents([]),
    )
    token = service.admit()
    service.invalidate()
    with pytest.raises(MotionCancelled, match="before daemon admission"):
        service.goto(head=np.eye(4), duration=0.2, token=token)
    assert opener.requests == []


def test_stop_closes_blocked_admission_race_and_confirms_daemon_cancel(robot) -> None:
    post_started = threading.Event()
    allow_post = threading.Event()
    requests: list[Any] = []

    def opener(request, timeout=0):
        del timeout
        requests.append(request)
        if request.full_url.endswith("/goto"):
            post_started.set()
            allow_post.wait(2.0)
            return FakeResponse({"uuid": MOVE_UUID}, url=request.full_url)
        if request.full_url.endswith("/stop"):
            return FakeResponse({"message": f"Stopped move with UUID: {MOVE_UUID}"}, url=request.full_url)
        raise AssertionError(request.full_url)

    service = LocalMotionService(
        robot,
        opener=opener,
        event_connector=lambda _url: FakeEvents([]),
    )
    token = service.admit()
    with ThreadPoolExecutor(max_workers=2) as pool:
        motion = pool.submit(service.goto, head=np.eye(4), duration=0.2, token=token)
        assert post_started.wait(1.0)
        stopped = pool.submit(service.stop)
        allow_post.set()
        with pytest.raises(MotionCancelled, match="being admitted"):
            motion.result(timeout=1.0)
        assert stopped.result(timeout=1.0)["cancelled"] is False
    assert [request.full_url.rsplit("/", 1)[-1] for request in requests] == ["goto", "stop"]


def test_wake_and_sleep_use_official_cancellable_daemon_routes(robot) -> None:
    wake_url = "http://127.0.0.1:8000/api/move/play/wake_up"
    sleep_url = "http://127.0.0.1:8000/api/move/play/goto_sleep"
    opener = RoutingOpener(
        {
            wake_url: FakeResponse({"uuid": MOVE_UUID}, url=wake_url),
            sleep_url: FakeResponse({"uuid": MOVE_UUID}, url=sleep_url),
        }
    )
    service = LocalMotionService(
        robot,
        opener=opener,
        event_connector=lambda _url: FakeEvents([{"type": "move_completed", "uuid": MOVE_UUID}]),
    )
    assert service.wake()["completed"] is True
    assert service.sleep()["completed"] is True
    assert [request.full_url for request in opener.requests] == [wake_url, sleep_url]


@pytest.mark.parametrize(
    "bad_event",
    [
        RuntimeError("websocket closed"),
        "{not-json",
        {"type": "unknown", "uuid": MOVE_UUID},
    ],
)
def test_nonterminal_event_failure_cancels_exact_daemon_move(robot, bad_event) -> None:
    goto_url = "http://127.0.0.1:8000/api/move/goto"
    stop_url = "http://127.0.0.1:8000/api/move/stop"
    opener = RoutingOpener(
        {
            goto_url: FakeResponse({"uuid": MOVE_UUID}, url=goto_url),
            stop_url: FakeResponse({"message": "stopped"}, url=stop_url),
        }
    )
    service = LocalMotionService(
        robot,
        opener=opener,
        event_connector=lambda _url: FakeEvents([{"type": "move_started", "uuid": MOVE_UUID}, bad_event]),
    )
    with pytest.raises((RuntimeError, MotionError)):
        service.goto(head=np.eye(4), duration=0.2)
    assert [request.full_url for request in opener.requests] == [goto_url, stop_url]


def test_failed_cancellation_preserves_uuid_for_later_emergency_stop_retry(robot) -> None:
    goto_url = "http://127.0.0.1:8000/api/move/goto"
    stop_url = "http://127.0.0.1:8000/api/move/stop"
    running_url = "http://127.0.0.1:8000/api/move/running"
    stop_attempts = 0
    goto_attempts = 0

    def opener(request, timeout=0):
        nonlocal goto_attempts, stop_attempts
        del timeout
        if request.full_url == goto_url:
            goto_attempts += 1
            return FakeResponse({"uuid": MOVE_UUID}, url=goto_url)
        if request.full_url == running_url:
            return FakeResponse(json.dumps([{"uuid": MOVE_UUID}]).encode(), url=running_url)
        if request.full_url == stop_url:
            stop_attempts += 1
            if stop_attempts == 1:
                raise OSError("temporary local failure")
            return FakeResponse({"message": "stopped"}, url=stop_url)
        raise AssertionError(request.full_url)

    service = LocalMotionService(
        robot,
        opener=opener,
        event_connector=lambda _url: FakeEvents([RuntimeError("websocket closed")]),
    )
    with pytest.raises(MotionError, match="cancellation could not be confirmed"):
        service.goto(head=np.eye(4), duration=0.2)
    with pytest.raises(MotionError, match="unresolved daemon motion"):
        service.goto(head=np.eye(4), duration=0.2)
    assert goto_attempts == 1
    assert stop_attempts == 1
    assert service.stop() == {"cancelled": True, "uuid": MOVE_UUID}
    assert stop_attempts == 2


def test_controller_sleep_reaches_daemon_without_self_cancelling(robot) -> None:
    sleep_url = "http://127.0.0.1:8000/api/move/play/goto_sleep"
    opener = RoutingOpener({sleep_url: FakeResponse({"uuid": MOVE_UUID}, url=sleep_url)})
    service = LocalMotionService(
        robot,
        opener=opener,
        event_connector=lambda _url: FakeEvents([{"type": "move_completed", "uuid": MOVE_UUID}]),
    )
    controller = RobotController(robot, motion=service, now_ms=lambda: NOW)
    result = controller.execute_message(command("sleep-1", "sleep"))
    assert result["status"] == "completed"
    assert [request.full_url for request in opener.requests] == [sleep_url]


def test_hardware_identity_is_loopback_only_bounded_and_redirect_free(robot) -> None:
    url = "http://127.0.0.1:8000/api/daemon/hardware-id"
    opener = RoutingOpener(
        {
            url: FakeResponse(
                {"hardware_id": "0123456789abcdef"},
                url=url,
                headers={"Content-Type": "application/json"},
            )
        }
    )
    assert read_hardware_id(robot=robot, opener=opener) == "0123456789abcdef"
    assert opener.requests[0].full_url == url

    redirect = RoutingOpener(
        {
            url: FakeResponse(
                {"hardware_id": "0123456789abcdef"},
                url="http://attacker.invalid/hardware-id",
                headers={"Content-Type": "application/json"},
            )
        }
    )
    with pytest.raises(HardwareIdentityError, match="redirect"):
        read_hardware_id(robot=robot, opener=redirect)


@pytest.mark.parametrize("hardware_id", [None, "", "ABCDEF0123456789", "a" * 17, "../../secret"])
def test_hardware_identity_rejects_non_official_values(robot, hardware_id) -> None:
    url = "http://127.0.0.1:8000/api/daemon/hardware-id"
    opener = RoutingOpener({url: FakeResponse({"hardware_id": hardware_id}, url=url)})
    with pytest.raises(HardwareIdentityError):
        read_hardware_id(robot=robot, opener=opener)


def test_daemon_status_is_loopback_redirect_free_and_strictly_sanitized(robot) -> None:
    url = "http://127.0.0.1:8000/api/daemon/status"
    opener = RoutingOpener(
        {
            url: FakeResponse(
                {
                    "type": "daemon_status",
                    "version": "1.9.0",
                    "wireless_version": True,
                    "simulation_enabled": False,
                    "state": "running",
                    "hardware_id": "0123456789abcdef",
                    "robot_name": "private-local-name",
                    "wlan_ip": "192.168.1.2",
                    "error": "must not leave the robot",
                },
                url=url,
                headers={"Content-Type": "application/json"},
            )
        }
    )
    assert read_daemon_status(
        robot=robot,
        opener=opener,
        expected_hardware_id="0123456789abcdef",
    ) == {
        "daemonVersion": "1.9.0",
        "wireless": True,
        "simulation": False,
        "state": "running",
    }
    assert opener.requests[0].full_url == url

    redirect = RoutingOpener(
        {
            url: FakeResponse(
                {
                    "version": "1.9.0",
                    "wireless_version": True,
                    "simulation_enabled": False,
                    "state": "running",
                },
                url="http://attacker.invalid/status",
            )
        }
    )
    with pytest.raises(DaemonStatusError, match="redirect"):
        read_daemon_status(robot=robot, opener=redirect)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("wireless_version", "true"),
        ("simulation_enabled", 1),
        ("state", "unknown"),
        ("version", "x" * 81),
        ("hardware_id", "fedcba9876543210"),
    ],
)
def test_daemon_status_rejects_malformed_observability_fields(robot, field, value) -> None:
    url = "http://127.0.0.1:8000/api/daemon/status"
    payload = {
        "version": "1.9.0",
        "wireless_version": True,
        "simulation_enabled": False,
        "state": "running",
        "hardware_id": "0123456789abcdef",
    }
    payload[field] = value
    opener = RoutingOpener({url: FakeResponse(payload, url=url)})
    with pytest.raises(DaemonStatusError):
        read_daemon_status(
            robot=robot,
            opener=opener,
            expected_hardware_id="0123456789abcdef",
        )
