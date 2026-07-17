"""Same-origin authenticated HTTP helpers shared by package and model downloaders."""

from __future__ import annotations

import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from .config import ConfigurationError, HomeBrainConfig


class DownloadSecurityError(RuntimeError):
    """A URL, redirect, or response violated download policy."""


def origin(url: str) -> tuple[str, str, int | None]:
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), parsed.port


def resolve_homebrain_url(config: HomeBrainConfig, value: str) -> str:
    """Resolve relative URLs and reject credentials, fragments, and cross-origin URLs."""

    if not isinstance(value, str) or not value.strip():
        raise DownloadSecurityError("download URL is required")
    raw = value.strip()
    candidate = urllib.parse.urlsplit(raw)
    if candidate.username or candidate.password or candidate.fragment:
        raise DownloadSecurityError("download URL contains forbidden components")
    base = f"{config.http_base_url.rstrip('/')}/"
    resolved = urllib.parse.urljoin(base, raw)
    parsed = urllib.parse.urlsplit(resolved)
    if parsed.scheme not in {"http", "https"}:
        raise DownloadSecurityError("download URL must use HTTP(S)")
    if parsed.scheme == "http" and not config.allow_insecure_http:
        raise DownloadSecurityError("download URL must use HTTPS")
    if origin(resolved) != origin(config.http_base_url):
        raise DownloadSecurityError("cross-origin download URL is forbidden")
    return resolved


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, expected_origin: tuple[str, str, int | None]):
        super().__init__()
        self.expected_origin = expected_origin

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        if origin(newurl) != self.expected_origin:
            raise urllib.error.HTTPError(newurl, code, "cross-origin redirect forbidden", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        raise urllib.error.HTTPError(newurl, code, "redirect forbidden", headers, fp)


def default_same_origin_opener(config: HomeBrainConfig) -> Callable[..., Any]:
    handler = _SameOriginRedirectHandler(origin(config.http_base_url))
    return urllib.request.build_opener(handler).open


def default_no_redirect_opener() -> Callable[..., Any]:
    return urllib.request.build_opener(_NoRedirectHandler()).open


def fetch_limited(
    config: HomeBrainConfig,
    url: str,
    *,
    max_bytes: int,
    headers: dict[str, str],
    timeout_s: float,
    opener: Callable[..., Any] | None = None,
    allow_redirects: bool = True,
) -> tuple[bytes, Any]:
    resolved = resolve_homebrain_url(config, url)
    request = urllib.request.Request(resolved, method="GET", headers=headers)
    open_url = opener or (
        default_same_origin_opener(config) if allow_redirects else default_no_redirect_opener()
    )
    try:
        with open_url(request, timeout=timeout_s) as response:
            final_url = response.geturl() if callable(getattr(response, "geturl", None)) else resolved
            if origin(final_url) != origin(config.http_base_url):
                raise DownloadSecurityError("cross-origin redirect forbidden")
            data = response.read(max_bytes + 1)
            response_headers = response.headers
    except DownloadSecurityError:
        raise
    except urllib.error.HTTPError as exc:
        raise DownloadSecurityError(f"download rejected with HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError, ConfigurationError) as exc:
        raise DownloadSecurityError("download failed") from exc
    if len(data) > max_bytes:
        raise DownloadSecurityError("download exceeded the safety limit")
    return data, response_headers
