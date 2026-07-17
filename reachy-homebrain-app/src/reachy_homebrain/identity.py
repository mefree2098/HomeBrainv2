"""Fail-closed binding to the Reachy daemon's immutable hardware identity."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from .http_security import default_no_redirect_opener


class HardwareIdentityError(RuntimeError):
    """The local Reachy hardware identity was unavailable or malformed."""


class DaemonStatusError(RuntimeError):
    """The local Reachy daemon status was unavailable or malformed."""


_HARDWARE_ID_RE = re.compile(r"^[a-f0-9]{16}$")
_DAEMON_STATES = frozenset({"not_initialized", "starting", "running", "stopping", "stopped", "error"})


def _loopback_port(robot: Any | None, port: int | None, error_type: type[RuntimeError]) -> int:
    resolved_port = port
    if resolved_port is None and robot is not None:
        resolved_port = getattr(getattr(robot, "client", None), "port", None)
    if isinstance(resolved_port, bool):
        raise error_type("Reachy daemon loopback port is invalid")
    try:
        resolved_port = int(resolved_port if resolved_port is not None else 8000)
    except (TypeError, ValueError) as exc:
        raise error_type("Reachy daemon loopback port is invalid") from exc
    if not 1 <= resolved_port <= 65_535:
        raise error_type("Reachy daemon loopback port is invalid")
    return resolved_port


def validate_hardware_id(value: Any) -> str:
    """Return a bounded canonical daemon hardware id or fail closed."""

    if not isinstance(value, str):
        raise HardwareIdentityError("Reachy daemon hardware_id must be a string")
    hardware_id = value.strip()
    if not _HARDWARE_ID_RE.fullmatch(hardware_id):
        raise HardwareIdentityError("Reachy daemon hardware_id is malformed")
    return hardware_id


def read_hardware_id(
    *,
    robot: Any | None = None,
    port: int | None = None,
    opener: Callable[..., Any] | None = None,
    timeout_s: float = 3.0,
) -> str:
    """Read ``/api/daemon/hardware-id`` over loopback without redirects."""

    resolved_port = _loopback_port(robot, port, HardwareIdentityError)

    url = f"http://127.0.0.1:{resolved_port}/api/daemon/hardware-id"
    request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    open_url = opener or default_no_redirect_opener()
    try:
        with open_url(request, timeout=max(0.25, min(float(timeout_s), 10.0))) as response:
            final_url = response.geturl() if callable(getattr(response, "geturl", None)) else url
            if final_url != url:
                raise HardwareIdentityError("Reachy hardware identity redirects are forbidden")
            content_type = response.headers.get("Content-Type", "")
            if content_type and content_type.split(";", 1)[0].strip().lower() != "application/json":
                raise HardwareIdentityError("Reachy hardware identity response must be JSON")
            raw = response.read(65_537)
    except HardwareIdentityError:
        raise
    except urllib.error.HTTPError as exc:
        raise HardwareIdentityError(
            f"Reachy daemon rejected hardware identity request with HTTP {exc.code}"
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise HardwareIdentityError("Reachy daemon hardware identity is unavailable") from exc
    if len(raw) > 65_536:
        raise HardwareIdentityError("Reachy hardware identity response exceeded the safety limit")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HardwareIdentityError("Reachy daemon returned invalid hardware identity JSON") from exc
    if not isinstance(payload, dict):
        raise HardwareIdentityError("Reachy hardware identity response must be an object")
    return validate_hardware_id(payload.get("hardware_id"))


def read_daemon_status(
    *,
    robot: Any | None = None,
    port: int | None = None,
    expected_hardware_id: str | None = None,
    opener: Callable[..., Any] | None = None,
    timeout_s: float = 3.0,
) -> dict[str, Any]:
    """Return only bounded observability fields from official ``/api/daemon/status``."""

    resolved_port = _loopback_port(robot, port, DaemonStatusError)
    url = f"http://127.0.0.1:{resolved_port}/api/daemon/status"
    request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
    open_url = opener or default_no_redirect_opener()
    try:
        with open_url(request, timeout=max(0.25, min(float(timeout_s), 10.0))) as response:
            final_url = response.geturl() if callable(getattr(response, "geturl", None)) else url
            if final_url != url:
                raise DaemonStatusError("Reachy daemon status redirects are forbidden")
            content_type = response.headers.get("Content-Type", "")
            if content_type and content_type.split(";", 1)[0].strip().lower() != "application/json":
                raise DaemonStatusError("Reachy daemon status response must be JSON")
            raw = response.read(65_537)
    except DaemonStatusError:
        raise
    except urllib.error.HTTPError as exc:
        raise DaemonStatusError(f"Reachy daemon rejected status request with HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise DaemonStatusError("Reachy daemon status is unavailable") from exc
    if len(raw) > 65_536:
        raise DaemonStatusError("Reachy daemon status response exceeded the safety limit")
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DaemonStatusError("Reachy daemon returned invalid status JSON") from exc
    if not isinstance(payload, dict):
        raise DaemonStatusError("Reachy daemon status response must be an object")

    version = payload.get("version")
    if version is not None and (
        not isinstance(version, str)
        or not 1 <= len(version) <= 80
        or version.strip() != version
        or any(ord(character) < 32 or ord(character) == 127 for character in version)
    ):
        raise DaemonStatusError("Reachy daemon version is malformed")
    wireless = payload.get("wireless_version")
    simulation = payload.get("simulation_enabled")
    state = payload.get("state")
    if not isinstance(wireless, bool):
        raise DaemonStatusError("Reachy daemon wireless status is malformed")
    if simulation is not None and not isinstance(simulation, bool):
        raise DaemonStatusError("Reachy daemon simulation status is malformed")
    if not isinstance(state, str) or state not in _DAEMON_STATES:
        raise DaemonStatusError("Reachy daemon state is malformed")
    status_hardware_id = payload.get("hardware_id")
    if expected_hardware_id is not None and status_hardware_id is not None:
        try:
            status_hardware_id = validate_hardware_id(status_hardware_id)
        except HardwareIdentityError as exc:
            raise DaemonStatusError("Reachy daemon status hardware identity is malformed") from exc
        if status_hardware_id != validate_hardware_id(expected_hardware_id):
            raise DaemonStatusError("Reachy daemon status hardware identity changed")
    return {
        "daemonVersion": version,
        "wireless": wireless,
        "simulation": simulation,
        "state": state,
    }
