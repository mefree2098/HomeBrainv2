"""One-time conversion of short-lived HomeBrain credentials into a device token."""

from __future__ import annotations

import json
import platform
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from .config import ConfigurationError, HomeBrainConfig, SecureConfigStore
from .http_security import default_no_redirect_opener, origin
from .identity import HardwareIdentityError, read_hardware_id, validate_hardware_id
from .version import __version__


class ActivationError(RuntimeError):
    """HomeBrain rejected or could not complete device activation."""


UrlOpener = Callable[..., Any]


def _local_ip() -> str | None:
    """Best-effort LAN address discovery without sending application data."""

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.25)
        sock.connect(("192.0.2.1", 9))
        return str(sock.getsockname()[0])
    except OSError:
        return None
    finally:
        sock.close()


def activate_device(
    config: HomeBrainConfig,
    store: SecureConfigStore,
    *,
    opener: UrlOpener | None = None,
    timeout_s: float = 10.0,
    unit_id: str | None = None,
) -> HomeBrainConfig:
    """Activate with a temporary claim/registration credential, then persist only the token."""

    if config.device_token:
        return config
    if not config.registration_code and not config.claim_token:
        raise ActivationError("no bootstrap credential is available")

    try:
        supplied_unit_id = unit_id or config.unit_id
        resolved_unit_id = validate_hardware_id(supplied_unit_id) if supplied_unit_id else read_hardware_id()
    except HardwareIdentityError as exc:
        raise ActivationError(str(exc)) from exc

    payload = {
        "registrationCode": config.registration_code or None,
        "claimToken": config.claim_token or None,
        "deviceId": config.device_id or None,
        "ipAddress": _local_ip(),
        "firmwareVersion": __version__,
        "unitId": resolved_unit_id,
        "deviceInfo": {
            "platform": "reachy-mini-wireless",
            "pythonPlatform": platform.platform(),
            "architecture": platform.machine(),
            "unitId": resolved_unit_id,
        },
    }
    body = json.dumps({key: value for key, value in payload.items() if value is not None}).encode()
    activation_url = f"{config.http_base_url}/api/reachy-mini/activate"
    parsed_activation = urllib.parse.urlsplit(activation_url)
    if parsed_activation.scheme != "https" and not config.allow_insecure_http:
        raise ActivationError("HomeBrain activation requires HTTPS")
    request = urllib.request.Request(
        activation_url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    open_url = opener or default_no_redirect_opener()
    try:
        with open_url(request, timeout=timeout_s) as response:
            final_url = response.geturl() if callable(getattr(response, "geturl", None)) else activation_url
            if final_url != activation_url or origin(final_url) != origin(activation_url):
                raise ActivationError("activation redirects are forbidden")
            content_type = response.headers.get("Content-Type", "")
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                raise ActivationError("activation response must be application/json")
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > 1_048_576:
                        raise ActivationError("activation response exceeded the safety limit")
                except ValueError as exc:
                    raise ActivationError("activation response has an invalid content length") from exc
            raw = response.read(1_048_577)
    except ActivationError:
        raise
    except urllib.error.HTTPError as exc:
        # Do not echo server bodies: they can contain the submitted bootstrap credential.
        raise ActivationError(f"HomeBrain activation was rejected with HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ActivationError("unable to reach HomeBrain activation endpoint") from exc
    if len(raw) > 1_048_576:
        raise ActivationError("activation response exceeded the safety limit")
    try:
        result = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ActivationError("HomeBrain returned an invalid activation response") from exc
    if not isinstance(result, dict) or result.get("success") is not True:
        raise ActivationError("HomeBrain did not accept the activation request")
    device = result.get("device")
    device_id = device.get("_id") if isinstance(device, dict) else None
    token = result.get("deviceToken")
    if not isinstance(device_id, str) or not isinstance(token, str) or not token:
        raise ActivationError("activation response did not include device credentials")

    activated = replace(
        config,
        unit_id=resolved_unit_id,
        device_id=device_id,
        device_token=token,
        registration_code="",
        # Empty values deliberately erase one-time bootstrap credentials.
        claim_token="",  # nosec B106
    )
    try:
        activated.validate()
        store.save(activated)
    except ConfigurationError as exc:
        raise ActivationError("HomeBrain returned malformed device credentials") from exc
    return activated
