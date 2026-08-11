from __future__ import annotations

import json
import stat

import pytest
from conftest import FakeResponse, RoutingOpener

from reachy_homebrain.app import HomeBrainReachyApp, _default_config_path
from reachy_homebrain.bootstrap import activate_device
from reachy_homebrain.config import ConfigurationError, HomeBrainConfig, SecureConfigStore
from reachy_homebrain.main import ReachyHomebrain


def test_wireless_entrypoints_request_supported_auto_detected_media_backend() -> None:
    assert ReachyHomebrain.request_media_backend == "default"
    assert HomeBrainReachyApp.request_media_backend == "default"
    assert ReachyHomebrain.dont_start_webserver is True
    assert HomeBrainReachyApp.dont_start_webserver is True


def test_rejects_insecure_transport_without_explicit_opt_in() -> None:
    with pytest.raises(ConfigurationError, match="unencrypted"):
        HomeBrainConfig.from_mapping({"hub_url": "http://hub.local", "registration_code": "short-lived"})


@pytest.mark.parametrize("value", ["false", "true", 0, 1, None, [], {}])
def test_insecure_transport_opt_in_requires_a_real_json_boolean(value) -> None:
    with pytest.raises(ConfigurationError, match="JSON boolean"):
        HomeBrainConfig.from_mapping(
            {
                "hub_url": "http://hub.local",
                "registration_code": "short-lived",
                "allow_insecure_http": value,
            }
        )


def test_insecure_transport_accepts_explicit_true_boolean() -> None:
    config = HomeBrainConfig.from_mapping(
        {
            "hub_url": "http://hub.local",
            "registration_code": "short-lived",
            "allow_insecure_http": True,
        }
    )
    assert config.allow_insecure_http is True


@pytest.mark.parametrize(
    "hub_url",
    [
        "https://hub.test:not-a-port",
        "https://hub.test:0",
        "https://hub.test:65536",
        "https://home brain.test",
        "https://hub.test/\nsmuggled",
    ],
)
def test_hub_url_rejects_invalid_ports_whitespace_and_controls(hub_url) -> None:
    with pytest.raises(ConfigurationError, match="hub_url"):
        HomeBrainConfig.from_mapping({"hub_url": hub_url, "registration_code": "short-lived"})


def test_builds_voice_and_tts_urls(config: HomeBrainConfig) -> None:
    assert config.voice_websocket_url.startswith("wss://homebrain.test/ws/voice-device?")
    assert "deviceId=507f1f77bcf86cd799439011" in config.voice_websocket_url
    assert config.tts_url() == "https://homebrain.test/api/remote-devices/507f1f77bcf86cd799439011/tts"
    assert config.auth_headers() == {"X-HomeBrain-Device-Token": "device-secret-token"}


def test_secure_store_enforces_owner_only_mode(tmp_path) -> None:
    path = tmp_path / "private" / "config.json"
    store = SecureConfigStore(path)
    config = HomeBrainConfig.from_mapping({"hub_url": "https://hub.test", "registration_code": "temporary"})
    store.save(config)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    path.chmod(0o644)
    loaded = store.load()
    assert loaded.registration_code == "temporary"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_secure_store_rejects_config_file_symlinks(tmp_path) -> None:
    target = tmp_path / "real-config.json"
    target.write_text(
        json.dumps({"hub_url": "https://hub.test", "registration_code": "temporary"}),
        encoding="utf-8",
    )
    target.chmod(0o600)
    link = tmp_path / "config.json"
    link.symlink_to(target)
    store = SecureConfigStore(link)
    with pytest.raises(ConfigurationError, match="non-symlink"):
        store.load()
    config = HomeBrainConfig.from_mapping({"hub_url": "https://hub.test", "registration_code": "temporary"})
    with pytest.raises(ConfigurationError, match="symlink"):
        store.save(config)


def test_activation_uses_reachy_endpoint_and_persists_for_next_managed_launch(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("HOMEBRAIN_REACHY_CONFIG", raising=False)
    path = _default_config_path()
    assert path == tmp_path / ".config" / "homebrain-reachy" / "config.json"
    store = SecureConfigStore(path)
    bootstrap = HomeBrainConfig.from_mapping(
        {
            "hub_url": "https://homebrain.test",
            "device_id": "507f1f77bcf86cd799439011",
            "claim_token": "one-time-claim",
        }
    )
    store.save(bootstrap)
    url = "https://homebrain.test/api/reachy-mini/activate"
    opener = RoutingOpener(
        {
            url: FakeResponse(
                {
                    "success": True,
                    "device": {"_id": "507f1f77bcf86cd799439011"},
                    "deviceToken": "steady-device-token",
                },
                url=url,
                headers={"Content-Type": "application/json"},
            )
        }
    )
    activated = activate_device(bootstrap, store, opener=opener, unit_id="0123456789abcdef")
    assert activated.device_token == "steady-device-token"
    assert activated.claim_token == ""
    request_body = json.loads(opener.requests[0].data)
    assert request_body["claimToken"] == "one-time-claim"
    assert request_body["unitId"] == "0123456789abcdef"
    assert request_body["deviceInfo"]["unitId"] == "0123456789abcdef"
    assert activated.unit_id == "0123456789abcdef"

    # A later managed-app launch discovers the exact same canonical path without env overrides.
    next_launch = SecureConfigStore(_default_config_path()).load(environ={})
    assert next_launch.device_token == "steady-device-token"
    assert next_launch.claim_token == ""


def test_unknown_config_key_is_rejected() -> None:
    with pytest.raises(ConfigurationError, match="unknown"):
        HomeBrainConfig.from_mapping({"hub_url": "https://hub.test", "registration_code": "x", "typo": True})
