from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import FakeMotion, FakeResponse, FakeRobot, RoutingOpener
from test_robot_commands import NOW, command

from reachy_homebrain.motion import MotionError
from reachy_homebrain.perception import (
    PerceptionError,
    PresenceMonitor,
    SnapshotService,
    TrackingCoordinator,
)
from reachy_homebrain.robot import RobotController
from reachy_homebrain.tts import TtsCancelled, TtsPlayer


class BlockingMotionRobot(FakeRobot):
    def __init__(self) -> None:
        super().__init__()
        self.motion_started = threading.Event()
        self.motion_cancelled = threading.Event()
        self.motion_release = threading.Event()
        self.goto_count = 0

    def goto_target(self, **kwargs):
        self.goto_count += 1
        self._record("goto_target", kwargs)
        self.motion_started.set()
        self.motion_release.wait(2.0)

    def cancel_move(self) -> None:
        self._record("cancel_move")
        self.motion_cancelled.set()
        self.motion_release.set()


def make_motion_controller(robot: FakeRobot) -> RobotController:
    controller = RobotController(robot, now_ms=lambda: NOW, motion=FakeMotion(robot))
    controller.configure_privacy(
        camera_enabled=True,
        speech_direction_enabled=True,
        face_tracking_default=False,
    )
    return controller


def test_stop_preempts_active_motion_and_cancels_queued_motion() -> None:
    robot = BlockingMotionRobot()
    controller = make_motion_controller(robot)
    with ThreadPoolExecutor(max_workers=3) as pool:
        active = pool.submit(controller.execute_message, command("active", "look", {"direction": "left"}))
        assert robot.motion_started.wait(1.0)
        queued = pool.submit(controller.execute_message, command("queued", "look", {"direction": "right"}))
        stopped = controller.execute_message(command("stop", "stop"))
        assert stopped["status"] == "completed"
        assert robot.motion_cancelled.is_set()
        assert active.result(timeout=1.0)["status"] == "cancelled"
        assert queued.result(timeout=1.0)["status"] == "cancelled"
    assert robot.goto_count == 1


def test_wire_arrival_generation_prevents_task_scheduler_reordering() -> None:
    robot = BlockingMotionRobot()
    controller = make_motion_controller(robot)
    old_epoch = controller.admit_arrival(stop=False)
    stop_epoch = controller.admit_arrival(stop=True)
    late_worker_message = command("arrived-first", "look", {"direction": "left"})
    late_worker_message["_homebrainArrivalEpoch"] = old_epoch
    result = controller.execute_message(late_worker_message)
    assert result["status"] == "cancelled"
    assert robot.goto_count == 0
    stop_message = command("arrived-stop", "stop")
    stop_message["_homebrainArrivalEpoch"] = stop_epoch
    assert controller.execute_message(stop_message)["status"] == "completed"


def test_concurrent_duplicate_id_executes_hardware_once() -> None:
    robot = BlockingMotionRobot()
    controller = make_motion_controller(robot)
    payload = command("same-id", "look", {"direction": "left"})
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(controller.execute_message, payload)
        assert robot.motion_started.wait(1.0)
        second = pool.submit(controller.execute_message, payload)
        robot.motion_release.set()
        first_result = first.result(timeout=1.0)
        second_result = second.result(timeout=1.0)
    assert first_result["status"] == "completed"
    assert second_result["status"] == "completed"
    assert second_result["duplicate"] is True
    assert robot.goto_count == 1


def test_privacy_configuration_does_not_wait_for_motion_lock_and_camera_off_clears_tracking() -> None:
    robot = BlockingMotionRobot()
    tracking = TrackingCoordinator(robot)
    controller = RobotController(
        robot,
        now_ms=lambda: NOW,
        tracking=tracking,
        motion=FakeMotion(robot),
    )
    presence = PresenceMonitor(robot, tracking=tracking)
    controller.configure_privacy(
        camera_enabled=True,
        speech_direction_enabled=True,
        face_tracking_default=True,
    )
    presence.configure(True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        motion = pool.submit(controller.execute_message, command("active", "look", {"direction": "left"}))
        assert robot.motion_started.wait(1.0)
        privacy = pool.submit(
            controller.configure_privacy,
            camera_enabled=False,
            speech_direction_enabled=False,
            face_tracking_default=False,
        )
        privacy.result(timeout=0.5)
        robot.motion_release.set()
        motion.result(timeout=1.0)
    presence.configure(False)
    assert tracking.active is False
    assert any(name == "stop_head_tracking" for name, _ in robot.calls)


def test_tracking_owners_do_not_stop_each_other() -> None:
    robot = FakeRobot()
    tracking = TrackingCoordinator(robot)
    tracking.configure_camera(True)
    presence = PresenceMonitor(robot, tracking=tracking)
    controller = RobotController(
        robot,
        now_ms=lambda: NOW,
        tracking=tracking,
        motion=FakeMotion(robot),
    )
    controller.configure_privacy(
        camera_enabled=True,
        speech_direction_enabled=True,
        face_tracking_default=False,
    )
    presence.configure(True)
    assert tracking.active
    controller.execute_message(command("face-on", "start_face_tracking"))
    stop_count = sum(name == "stop_head_tracking" for name, _ in robot.calls)
    presence.configure(False)
    assert tracking.active
    assert sum(name == "stop_head_tracking" for name, _ in robot.calls) == stop_count
    controller.execute_message(command("face-off", "stop_face_tracking"))
    assert not tracking.active


def test_tracking_off_fails_closed_and_retries_when_stop_adapter_is_missing() -> None:
    class StartOnlyRobot:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def start_head_tracking(self, *, weight: float) -> None:
            self.calls.append(f"start:{weight}")

    robot = StartOnlyRobot()
    tracking = TrackingCoordinator(robot)
    tracking.configure_camera(True)
    tracking.request("privacy-test", 0.5)
    with pytest.raises(PerceptionError, match="could not be stopped"):
        tracking.configure_camera(False)

    robot.stop_head_tracking = lambda: robot.calls.append("stop")
    tracking.configure_camera(False)
    assert robot.calls == ["start:0.5", "stop"]


def test_snapshot_permission_rejects_before_camera_access(config, robot) -> None:
    service = SnapshotService(config, robot, opener=RoutingOpener({}))
    with pytest.raises(PerceptionError, match="disabled"):
        service.capture_and_upload("blocked", 85)
    assert not any(name == "get_frame_jpeg" for name, _ in robot.media.calls)


def test_tts_download_finishing_after_stop_never_starts_playback(config, robot, tmp_path) -> None:
    started = threading.Event()
    release = threading.Event()
    url = config.tts_url()

    class BlockingResponse(FakeResponse):
        def read(self, amount: int = -1) -> bytes:
            started.set()
            release.wait(2.0)
            return super().read(amount)

    opener = RoutingOpener(
        {
            url: BlockingResponse(
                b"RIFF\x00\x00\x00\x00WAVEaudio",
                url=url,
                headers={"Content-Type": "audio/wav"},
            )
        }
    )
    player = TtsPlayer(config, robot, opener=opener, temp_root=tmp_path)
    generation = player.generation()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(player.play, "Late", expected_generation=generation)
        assert started.wait(1.0)
        player.stop()
        release.set()
        with pytest.raises(TtsCancelled):
            future.result(timeout=1.0)
    assert not any(name == "play_sound" for name, _ in robot.media.calls)
    assert any(name == "stop_playing" for name, _ in robot.media.calls)
    assert any(name == "disable_wobbling" for name, _ in robot.calls)


def test_tts_stop_disables_wobble_even_when_audio_stop_fails(config, robot, tmp_path) -> None:
    def fail_stop() -> None:
        robot.media.calls.append(("stop_playing", None))
        raise RuntimeError("audio player failure")

    robot.media.stop_playing = fail_stop
    player = TtsPlayer(config, robot, opener=RoutingOpener({}), temp_root=tmp_path)
    with pytest.raises(Exception, match="could not be stopped"):
        player.stop()
    assert any(name == "disable_wobbling" for name, _ in robot.calls)


def test_emergency_stop_clears_wobble_and_all_tracking_owners_despite_other_failure() -> None:
    robot = FakeRobot()
    tracking = TrackingCoordinator(robot)
    controller = RobotController(
        robot,
        now_ms=lambda: NOW,
        tracking=tracking,
        motion=FakeMotion(robot),
    )
    controller.configure_privacy(
        camera_enabled=True,
        speech_direction_enabled=True,
        face_tracking_default=True,
    )
    presence = PresenceMonitor(robot, tracking=tracking)
    presence.configure(True)
    controller.execute_message(command("face-on", "start_face_tracking"))
    controller.apply_operational_settings({"idleMotionEnabled": True})

    def fail_cancel() -> None:
        robot._record("cancel_move")
        raise RuntimeError("uploaded move cancellation failed")

    robot.cancel_move = fail_cancel
    result = controller.execute_message(command("stop-all", "stop"))
    assert result["status"] == "failed"
    call_names = [name for name, _ in robot.calls]
    assert "cancel_move" in call_names
    assert "disable_wobbling" in call_names
    assert "stop_head_tracking" in call_names
    state = controller.state()
    assert state["activeMotion"] is None
    assert state["faceTracking"] is False
    assert state["idleMotionEnabled"] is False


def test_required_safe_policy_raises_when_even_fallback_stop_is_unconfirmed() -> None:
    robot = FakeRobot()
    controller = RobotController(robot, now_ms=lambda: NOW, motion=FakeMotion(robot))

    def fail_cancel() -> None:
        raise RuntimeError("simulated physical cancellation failure")

    robot.cancel_move = fail_cancel
    with pytest.raises(MotionError, match="safe policy could not be confirmed"):
        controller.apply_safe_policy("stop", require_confirmation=True)


def test_capabilities_are_truthful_for_partial_sdk(config) -> None:
    class PartialRobot:
        media = type("Media", (), {"play_sound": lambda *_: None})()

    robot = PartialRobot()
    controller = RobotController(robot)
    from reachy_homebrain.client import HomeBrainClient

    client = HomeBrainClient(config, robot, controller, object())
    assert client.capability_ids() == []
    assert controller.capabilities["actions"] == ["stop"]
