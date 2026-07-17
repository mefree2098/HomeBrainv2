from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from reachy_homebrain.config import HomeBrainConfig


class FakeHeaders(dict):
    def get(self, key: str, default: Any = None) -> Any:
        for candidate, value in self.items():
            if candidate.lower() == key.lower():
                return value
        return default


class FakeResponse:
    def __init__(
        self,
        body: bytes | dict[str, Any],
        *,
        url: str = "https://homebrain.test/resource",
        headers: dict[str, str] | None = None,
    ):
        self.body = json.dumps(body).encode() if isinstance(body, dict) else body
        self.url = url
        self.headers = FakeHeaders(headers or {})

    def read(self, amount: int = -1) -> bytes:
        return self.body if amount < 0 else self.body[:amount]

    def geturl(self) -> str:
        return self.url

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: Any) -> None:
        return None


class RoutingOpener:
    def __init__(self, routes: dict[str, FakeResponse | bytes | dict[str, Any]]):
        self.routes = routes
        self.requests: list[Any] = []

    def __call__(self, request: Any, timeout: float = 0) -> FakeResponse:
        self.requests.append(request)
        value = self.routes[request.full_url]
        if isinstance(value, FakeResponse):
            value.url = request.full_url if value.url.endswith("/resource") else value.url
            return value
        return FakeResponse(value, url=request.full_url)


class FakeMedia:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.samples: list[Any] = []
        self.doa: tuple[float, bool] | None = (1.2, True)
        self.jpeg = b"\xff\xd8jpeg\xff\xd9"

    def start_recording(self) -> None:
        self.calls.append(("start_recording", None))

    def stop_recording(self) -> None:
        self.calls.append(("stop_recording", None))

    def get_audio_sample(self) -> Any:
        return self.samples.pop(0) if self.samples else None

    def get_input_audio_samplerate(self) -> int:
        return 16_000

    def play_sound(self, path: str) -> None:
        self.calls.append(("play_sound", path))

    def clear_player(self) -> None:
        self.calls.append(("clear_player", None))

    def stop_playing(self) -> None:
        self.calls.append(("stop_playing", None))

    def get_DoA(self) -> tuple[float, bool] | None:
        return self.doa

    def get_frame_jpeg(self) -> bytes:
        self.calls.append(("get_frame_jpeg", None))
        return self.jpeg


class FakeRobot:
    def __init__(self) -> None:
        self.media = FakeMedia()
        self.calls: list[tuple[str, Any]] = []
        self.client = type("Client", (), {"port": 8000})()
        self.face: Any = None

    def _record(self, name: str, value: Any = None) -> None:
        self.calls.append((name, value))

    def goto_target(self, **kwargs: Any) -> None:
        self._record("goto_target", kwargs)

    def look_at_world(self, *args: Any, **kwargs: Any) -> None:
        self._record("look_at_world", (args, kwargs))

    def set_target_body_yaw(self, value: float) -> None:
        self._record("set_target_body_yaw", value)

    def cancel_move(self) -> None:
        self._record("cancel_move")

    def goto_sleep(self) -> None:
        self._record("goto_sleep")

    def wake_up(self) -> None:
        self._record("wake_up")

    def enable_motors(self) -> None:
        self._record("enable_motors")

    def disable_motors(self) -> None:
        self._record("disable_motors")

    def enable_gravity_compensation(self) -> None:
        self._record("enable_gravity_compensation")

    def start_head_tracking(self, weight: float = 1.0) -> None:
        self._record("start_head_tracking", weight)

    def stop_head_tracking(self) -> None:
        self._record("stop_head_tracking")

    def get_tracked_face(self, wait: bool = False) -> Any:
        return self.face

    def enable_wobbling(self) -> None:
        self._record("enable_wobbling")

    def disable_wobbling(self) -> None:
        self._record("disable_wobbling")

    def get_current_head_pose(self) -> np.ndarray:
        return np.eye(4)

    def get_present_antenna_joint_positions(self) -> list[float]:
        return [0.1, -0.1]


class FakeMotion:
    """SDK-shaped test adapter for the cancellable daemon motion service."""

    def __init__(self, robot: FakeRobot):
        self.robot = robot
        self.generation = 0

    def goto(self, **kwargs: Any) -> dict[str, Any]:
        kwargs.pop("token", None)
        self.robot.goto_target(**kwargs)
        return {"uuid": "00000000-0000-0000-0000-000000000001", "completed": True}

    def wake(self, **_kwargs: Any) -> dict[str, Any]:
        self.robot.wake_up()
        return {"uuid": "00000000-0000-0000-0000-000000000002", "completed": True}

    def sleep(self, **_kwargs: Any) -> dict[str, Any]:
        self.robot.goto_sleep()
        return {"uuid": "00000000-0000-0000-0000-000000000003", "completed": True}

    def stop(self) -> dict[str, Any]:
        self.generation += 1
        self.robot.cancel_move()
        return {"cancelled": True, "uuid": "00000000-0000-0000-0000-000000000001"}

    def admit(self) -> int:
        return self.generation

    def invalidate(self) -> int:
        self.generation += 1
        return self.generation


@pytest.fixture
def config() -> HomeBrainConfig:
    return HomeBrainConfig.from_mapping(
        {
            "hub_url": "https://homebrain.test",
            "unit_id": "0123456789abcdef",
            "device_id": "507f1f77bcf86cd799439011",
            "device_token": "device-secret-token",
        }
    )


@pytest.fixture
def robot() -> FakeRobot:
    return FakeRobot()


@pytest.fixture
def temp_path(tmp_path: Path) -> Path:
    return tmp_path
