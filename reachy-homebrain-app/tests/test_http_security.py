from __future__ import annotations

import urllib.request

import pytest

from reachy_homebrain.config import HomeBrainConfig
from reachy_homebrain.http_security import (
    DownloadSecurityError,
    _SameOriginRedirectHandler,
    origin,
    resolve_homebrain_url,
)


def test_default_ports_have_the_same_origin() -> None:
    assert origin("https://hub.test/path") == origin("https://HUB.test:443/other")
    assert origin("http://hub.test") == origin("http://hub.test:80/")
    assert origin("https://hub.test:444") != origin("https://hub.test")


def test_explicit_default_port_is_a_valid_same_origin_download() -> None:
    config = HomeBrainConfig.from_mapping({"hub_url": "https://hub.test", "registration_code": "temporary"})
    assert resolve_homebrain_url(config, "https://hub.test:443/model.bin") == "https://hub.test:443/model.bin"


@pytest.mark.parametrize("url", [
    "https://hub.test:not-a-port/model", "https://hub.test:65536/model", "https://[broken/model",
    "https://hub.test:0/model", "https://user:password@hub.test/model", "https://hub.test/model#fragment",
    "https://hub.test/a\nb", "https://hub.test/a\tb", "https://hub.test/a b",
])
def test_malformed_or_forbidden_download_urls_fail_closed(url: str) -> None:
    config = HomeBrainConfig.from_mapping({"hub_url": "https://hub.test", "registration_code": "temporary"})
    with pytest.raises(DownloadSecurityError):
        resolve_homebrain_url(config, url)


def test_redirect_does_not_accept_same_host_credentials() -> None:
    handler = _SameOriginRedirectHandler(origin("https://hub.test"))
    request = urllib.request.Request("https://hub.test/start")
    with pytest.raises(DownloadSecurityError, match="forbidden"):
        handler.redirect_request(request, None, 302, "Found", {}, "https://user:password@hub.test/model")
