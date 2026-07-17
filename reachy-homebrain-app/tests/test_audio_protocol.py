from __future__ import annotations

import json

import numpy as np
import pytest

from reachy_homebrain.audio import AudioFormatError, PcmRingBuffer, float_audio_to_pcm16_mono
from reachy_homebrain.protocol import ProtocolError, RobotCommand, authentication_message, parse_message


def test_float_stereo_downmix_to_pcm16() -> None:
    samples = np.array([[1.0, 1.0], [-1.0, -1.0], [0.5, -0.5]], dtype=np.float32)
    output = np.frombuffer(float_audio_to_pcm16_mono(samples), dtype="<i2")
    assert output.tolist() == [32767, -32768, 0]


def test_audio_rejects_implicit_resampling() -> None:
    with pytest.raises(AudioFormatError, match="resampling"):
        float_audio_to_pcm16_mono([0.0], input_sample_rate=48_000)


def test_ring_buffer_keeps_exact_tail() -> None:
    ring = PcmRingBuffer(5)
    ring.append(b"abc")
    ring.append(b"defg")
    assert ring.snapshot() == b"cdefg"


def test_nested_and_flat_server_command_fixtures_round_trip() -> None:
    nested = {
        "type": "robot_command",
        "protocolVersion": 1,
        "command": {
            "id": "cmd-1",
            "action": "look",
            "parameters": {"direction": "left"},
            "issuedAt": 1_000,
            "ttlMs": 5_000,
        },
    }
    parsed = RobotCommand.from_message(nested, now_ms=1_500_000)
    assert parsed.command_id == "cmd-1"
    assert parsed.action == "look"

    flat = {
        "type": "robot_command",
        "protocolVersion": 1,
        "commandId": "cmd-2",
        "command": "stop",
        "parameters": {},
        "issuedAt": 1_500_000,
        "expiresAt": 1_505_000,
    }
    parsed_flat = RobotCommand.from_message(flat, now_ms=1_500_000)
    assert parsed_flat.action == "stop"
    assert parsed_flat.ttl_ms == 5_000


def test_auth_message_uses_capability_id_array() -> None:
    message = authentication_message(
        device_token="secret",
        unit_id="0123456789abcdef",
        version="1.2.3",
        capabilities=["audio_input", "head_motion"],
        capability_metadata={"actions": ["stop"]},
        package={"version": "1.2.3", "aggregateSha256": "a" * 64},
        wake_detector={"state": "ready"},
        state={"sleeping": False},
    )
    assert message["deviceInfo"]["capabilities"] == ["audio_input", "head_motion"]
    assert message["deviceInfo"]["appVersion"] == "1.2.3"
    assert message["unitId"] == "0123456789abcdef"
    assert message["deviceInfo"]["unitId"] == "0123456789abcdef"


def test_message_size_and_shape_are_bounded() -> None:
    with pytest.raises(ProtocolError):
        parse_message(json.dumps(["not", "object"]))
    with pytest.raises(ProtocolError, match="safety"):
        parse_message(b"x" * 100, max_bytes=10)
