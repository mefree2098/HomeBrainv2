from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from conftest import FakeResponse, RoutingOpener

from reachy_homebrain.config import HomeBrainConfig
from reachy_homebrain.perception import (
    LocalVolumeService,
    PerceptionError,
    PresenceMonitor,
    SnapshotService,
)
from reachy_homebrain.tts import TtsError, TtsPlayer


def test_device_authenticated_tts_is_played_through_sdk(config, robot, tmp_path) -> None:
    url = config.tts_url()
    opener = RoutingOpener(
        {url: FakeResponse(b"RIFF\x00\x00\x00\x00WAVEaudio", url=url, headers={"Content-Type": "audio/wav"})}
    )
    player = TtsPlayer(config, robot, opener=opener, temp_root=tmp_path)
    result = player.play("Hello", "voice-1")
    assert result["played"] is True
    assert opener.requests[0].get_header("X-homebrain-device-token") == "device-secret-token"
    assert opener.requests[0].method == "POST"
    assert json.loads(opener.requests[0].data) == {"text": "Hello", "voiceId": "voice-1"}
    playback = [value for name, value in robot.media.calls if name == "play_sound"][-1]
    assert Path(playback).is_file()
    player.close()


def test_tts_rejects_non_audio(config, robot, tmp_path) -> None:
    url = config.tts_url()
    opener = RoutingOpener({url: FakeResponse(b"not audio", url=url, headers={"Content-Type": "text/plain"})})
    player = TtsPlayer(config, robot, opener=opener, temp_root=tmp_path)
    with pytest.raises(TtsError, match="audio Content-Type"):
        player.play("Hello")


def test_tts_default_transport_never_follows_token_bearing_redirect(robot, tmp_path) -> None:
    requests: list[tuple[str, str | None]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            requests.append((self.path, self.headers.get("X-HomeBrain-Device-Token")))
            self.send_response(302)
            self.send_header("Location", "/stolen")
            self.end_headers()

        def do_GET(self) -> None:
            requests.append((self.path, self.headers.get("X-HomeBrain-Device-Token")))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.end_headers()
            self.wfile.write(b"RIFF\x00\x00\x00\x00WAVEaudio")

        def log_message(self, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        config = HomeBrainConfig.from_mapping(
            {
                "hub_url": f"http://127.0.0.1:{server.server_port}",
                "allow_insecure_http": True,
                "unit_id": "0123456789abcdef",
                "device_id": "device-1",
                "device_token": "redirect-secret",
            }
        )
        player = TtsPlayer(config, robot, temp_root=tmp_path)
        with pytest.raises(TtsError, match="HTTP 302"):
            player.play("Do not leak me")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert requests == [
        ("/api/remote-devices/device-1/tts", "redirect-secret"),
    ]


def test_tts_contract_rejects_text_above_server_limit(config, robot, tmp_path) -> None:
    player = TtsPlayer(config, robot, opener=RoutingOpener({}), temp_root=tmp_path)
    with pytest.raises(TtsError, match="1000"):
        player.play("x" * 1_001)
    assert player.opener.requests == []


def test_snapshot_is_transient_bounded_and_authenticated(config, robot) -> None:
    snapshot_id = "snapshot-1"
    url = f"https://homebrain.test/api/reachy-mini/{config.device_id}/snapshots/{snapshot_id}"
    response = {
        "success": True,
        "snapshot": {
            "id": snapshot_id,
            "bytes": len(robot.media.jpeg),
            "contentType": "image/jpeg",
            "expiresAt": "2026-01-01T00:00:00Z",
        },
    }
    opener = RoutingOpener({url: FakeResponse(response, url=url)})
    clock = iter([10.0, 13.0])
    service = SnapshotService(config, robot, opener=opener, clock=lambda: next(clock))
    service.configure(camera_enabled=True, snapshot_enabled=True)
    result = service.capture_and_upload(snapshot_id, 90)
    request = opener.requests[0]
    assert request.data == robot.media.jpeg
    assert request.get_header("Content-type") == "image/jpeg"
    assert request.get_header("X-homebrain-device-token") == "device-secret-token"
    assert result["snapshot"]["bytes"] == len(robot.media.jpeg)


def test_snapshot_rate_limit(config, robot) -> None:
    snapshot_id = "snapshot-1"
    url = f"https://homebrain.test/api/reachy-mini/{config.device_id}/snapshots/{snapshot_id}"
    response = {
        "success": True,
        "snapshot": {
            "id": snapshot_id,
            "bytes": len(robot.media.jpeg),
            "contentType": "image/jpeg",
            "expiresAt": None,
        },
    }
    opener = RoutingOpener({url: FakeResponse(response, url=url)})
    service = SnapshotService(config, robot, opener=opener, clock=lambda: 10.0)
    service.configure(camera_enabled=True, snapshot_enabled=True)
    service.capture_and_upload(snapshot_id, 80)
    with pytest.raises(PerceptionError, match="rate limit"):
        service.capture_and_upload(snapshot_id, 80)


def test_presence_is_privacy_gated_and_debounced(robot) -> None:
    times = iter([0.0, 0.1, 1.0, 1.1])
    monitor = PresenceMonitor(robot, clock=lambda: next(times), debounce_s=0.5)
    monitor.configure(True)
    assert ("start_head_tracking", 0.01) in robot.calls
    robot.face = type("FaceTarget", (), {"detected": True})()
    assert monitor.poll() is None
    change = monitor.poll()
    assert change == {"present": True}
    monitor.close()
    assert any(name == "stop_head_tracking" for name, _ in robot.calls)


def test_presence_uses_face_target_detected_flag(robot) -> None:
    times = iter([0.0, 0.1, 1.0, 1.6])
    monitor = PresenceMonitor(robot, clock=lambda: next(times), debounce_s=0.5)
    monitor.configure(True)
    robot.face = type("FaceTarget", (), {"detected": False})()
    assert monitor.poll() is None
    assert monitor.state.present is False
    robot.face = type("FaceTarget", (), {"detected": True})()
    assert monitor.poll() is None
    assert monitor.poll() == {"present": True}


def test_local_volume_uses_loopback_daemon(robot) -> None:
    url = "http://127.0.0.1:8000/api/volume/set"
    opener = RoutingOpener({url: FakeResponse({"volume": 73}, url=url)})
    service = LocalVolumeService(robot, opener=opener)
    assert service.set("speaker", 73) == {"kind": "speaker", "volume": 73}
    assert json.loads(opener.requests[0].data) == {"volume": 73}
