from __future__ import annotations

import hashlib

import numpy as np
from conftest import FakeResponse, RoutingOpener

from reachy_homebrain.wakeword import (
    FRAME_SAMPLES,
    OpenWakeWordDetector,
    WakeWordAssetManager,
    WakeWordModelAsset,
    WakeWordRuntime,
)


def remote_config(data: bytes, *, checksum: str | None = None) -> dict:
    return {
        "wakeWords": ["Anna"],
        "wakeWord": {
            "enabled": ["Anna"],
            "debounceMs": 1000,
            "vad": {"minRms": 0.001},
            "assets": [
                {
                    "label": "Anna",
                    "slug": "anna",
                    "fileName": "anna.onnx",
                    "size": len(data),
                    "checksum": checksum or hashlib.sha256(data).hexdigest(),
                    "downloadUrl": "/api/model/anna",
                    "threshold": 0.55,
                    "dependencies": [],
                }
            ],
        },
    }


def test_asset_sync_authenticates_and_verifies_checksum(config, tmp_path) -> None:
    data = b"fake-onnx-model"
    url = "https://homebrain.test/api/model/anna"
    opener = RoutingOpener({url: FakeResponse(data, url=url)})
    manager = WakeWordAssetManager(config, tmp_path / "models", opener=opener)
    assets, health = manager.sync(remote_config(data))
    assert health["state"] == "assets_ready"
    assert assets[0].path.read_bytes() == data
    assert opener.requests[0].get_header("X-homebrain-device-token") == "device-secret-token"
    # Valid cache is reused without another network request.
    manager.sync(remote_config(data))
    assert len(opener.requests) == 1


def test_asset_checksum_failure_is_visible(config, tmp_path) -> None:
    data = b"model"
    url = "https://homebrain.test/api/model/anna"
    opener = RoutingOpener({url: FakeResponse(data, url=url)})
    runtime = WakeWordRuntime(WakeWordAssetManager(config, tmp_path, opener=opener))
    health = runtime.configure(remote_config(data, checksum="0" * 64))
    assert health["state"] == "error"
    assert "mismatch" in health["error"]


def test_openwakeword_detection_and_debounce(tmp_path) -> None:
    class Model:
        def predict(self, _frame):
            return {"anna": 0.9}

    times = iter([10.0, 10.2, 11.2])
    asset = WakeWordModelAsset("Anna", "anna", tmp_path / "anna.onnx", 0.55)
    detector = OpenWakeWordDetector(
        [asset],
        debounce_ms=1000,
        min_rms=0,
        model_factory=lambda **_kwargs: Model(),
        clock=lambda: next(times),
    )
    frame = np.full(FRAME_SAMPLES, 1000, dtype="<i2").tobytes()
    assert detector.process_pcm(frame)[0].label == "Anna"
    assert detector.process_pcm(frame) == []
    assert detector.process_pcm(frame)[0].confidence == 0.9


def test_detector_suspend_and_resume(tmp_path) -> None:
    class Model:
        def predict(self, _frame):
            return {"anna": 0.9}

    asset = WakeWordModelAsset("Anna", "anna", tmp_path / "anna.onnx", 0.5)
    detector = OpenWakeWordDetector(
        [asset], min_rms=0, model_factory=lambda **_kwargs: Model(), clock=lambda: 1.0
    )
    frame = np.full(FRAME_SAMPLES, 1000, dtype="<i2").tobytes()
    detector.suspend()
    assert detector.process_pcm(frame) == []
    detector.resume()
    assert detector.process_pcm(frame)


def test_no_model_state_is_truthful(config, tmp_path) -> None:
    runtime = WakeWordRuntime(WakeWordAssetManager(config, tmp_path))
    health = runtime.configure({"wakeWord": {"assets": []}})
    assert health == {
        "state": "no_models",
        "models": [],
        "error": "HomeBrain supplied no wake-word assets",
        "lastDetection": None,
    }
    assert runtime.process_pcm(b"audio") == []
