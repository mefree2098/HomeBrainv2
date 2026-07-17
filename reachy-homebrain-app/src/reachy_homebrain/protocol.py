"""HomeBrain voice-WebSocket messages and bounded robot command envelopes."""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .identity import HardwareIdentityError, validate_hardware_id


class ProtocolError(ValueError):
    """A peer message violates the companion protocol."""


def _reject_non_finite_json(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is forbidden: {value}")


def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def parse_message(raw: str | bytes, *, max_bytes: int = 1_048_576) -> dict[str, Any]:
    if isinstance(raw, str):
        encoded = raw.encode("utf-8")
    elif isinstance(raw, bytes):
        encoded = raw
    else:
        raise ProtocolError("WebSocket messages must be text or UTF-8 bytes")
    if len(encoded) > max_bytes:
        raise ProtocolError("WebSocket message exceeded the safety limit")
    try:
        value = json.loads(encoded, parse_constant=_reject_non_finite_json)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProtocolError("WebSocket message is not valid JSON") from exc
    if not isinstance(value, dict) or not isinstance(value.get("type"), str):
        raise ProtocolError("WebSocket message must be an object with a type")
    return value


def authentication_message(
    *,
    device_token: str,
    unit_id: str,
    version: str,
    capabilities: Sequence[str],
    capability_metadata: Mapping[str, Any] | None = None,
    package: Mapping[str, Any] | None = None,
    wake_detector: Mapping[str, Any] | None = None,
    state: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if not device_token:
        raise ProtocolError("device token is unavailable")
    try:
        resolved_unit_id = validate_hardware_id(unit_id)
    except HardwareIdentityError as exc:
        raise ProtocolError("Reachy hardware identity is unavailable") from exc
    return {
        "type": "authenticate",
        "deviceToken": device_token,
        "unitId": resolved_unit_id,
        "deviceInfo": {
            "version": version,
            "platform": "reachy-mini-wireless",
            "arch": "arm64",
            "runtime": "python",
            "appVersion": version,
            "unitId": resolved_unit_id,
            "capabilities": list(capabilities),
            **({"capabilityMetadata": dict(capability_metadata)} if capability_metadata is not None else {}),
            **({"package": dict(package)} if package is not None else {}),
            **({"wakeDetector": dict(wake_detector)} if wake_detector is not None else {}),
            **({"state": dict(state)} if state is not None else {}),
        },
    }


def _parse_issued_at(value: Any, now_ms: int) -> int:
    if value is None:
        return now_ms
    if isinstance(value, bool):
        raise ProtocolError("issuedAt is invalid")
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            raise ProtocolError("issuedAt is invalid")
        numeric = float(value)
        # Production epoch seconds are below 1e10 while epoch milliseconds are
        # above it. Synthetic/test clocks below that range use like-for-like ms.
        if now_ms < 10_000_000_000:
            return int(numeric)
        return int(numeric if numeric > 10_000_000_000 else numeric * 1_000)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise ProtocolError("issuedAt must be ISO-8601 or epoch time") from exc
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return int(parsed.timestamp() * 1_000)
    raise ProtocolError("issuedAt is invalid")


@dataclass(frozen=True, slots=True)
class RobotCommand:
    command_id: str
    action: str
    parameters: Mapping[str, Any]
    issued_at_ms: int
    ttl_ms: int

    @classmethod
    def from_message(
        cls,
        message: Mapping[str, Any],
        *,
        default_ttl_ms: int = 5_000,
        max_ttl_ms: int = 30_000,
        now_ms: int | None = None,
    ) -> RobotCommand:
        if message.get("type") not in {"robot_command", "reachy_command"}:
            raise ProtocolError("message is not a robot command")
        protocol_version = message.get("protocolVersion", 1)
        if protocol_version != 1:
            raise ProtocolError("unsupported robot command protocol version")
        nested = message.get("command")
        command = nested if isinstance(nested, Mapping) else message
        command_id = command.get("id", command.get("commandId", message.get("commandId")))
        if not isinstance(command_id, str) or not 1 <= len(command_id) <= 128:
            raise ProtocolError("robot command id is required and must be at most 128 characters")
        if any(ord(character) < 32 for character in command_id):
            raise ProtocolError("robot command id contains control characters")
        action = command.get("action")
        if action is None and isinstance(nested, str):
            action = nested
        if action is None:
            action = message.get("action")
        if not isinstance(action, str) or not 1 <= len(action) <= 64:
            raise ProtocolError("robot command action is required")
        parameters = command.get("parameters", command.get("params", {}))
        if not isinstance(parameters, Mapping):
            raise ProtocolError("robot command parameters must be an object")
        try:
            encoded_parameters = json.dumps(parameters, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError) as exc:
            raise ProtocolError("robot command parameters must be finite JSON values") from exc
        if len(encoded_parameters) > 16_384:
            raise ProtocolError("robot command parameters exceeded the safety limit")
        timestamp = int(time.time() * 1_000) if now_ms is None else now_ms
        issued = _parse_issued_at(command.get("issuedAt", message.get("issuedAt")), timestamp)
        ttl_value = command.get("ttlMs", message.get("ttlMs", default_ttl_ms))
        expires_value = command.get("expiresAt", message.get("expiresAt"))
        if expires_value is not None:
            expires_at = _parse_issued_at(expires_value, timestamp)
            ttl_value = expires_at - issued
        if isinstance(ttl_value, bool):
            raise ProtocolError("ttlMs must be numeric")
        try:
            ttl = int(ttl_value)
        except (TypeError, ValueError) as exc:
            raise ProtocolError("ttlMs must be numeric") from exc
        ttl = max(100, min(ttl, max_ttl_ms))
        if issued > timestamp + 30_000:
            raise ProtocolError("robot command timestamp is too far in the future")
        return cls(command_id, action.strip().lower(), dict(parameters), issued, ttl)

    def is_expired(self, *, now_ms: int | None = None) -> bool:
        timestamp = int(time.time() * 1_000) if now_ms is None else now_ms
        return timestamp > self.issued_at_ms + self.ttl_ms

    def fingerprint(self) -> str:
        canonical = json.dumps(
            {"action": self.action, "parameters": self.parameters},
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
        return hashlib.sha256(canonical).hexdigest()


class IdempotencyCache:
    """Bounded LRU of command fingerprints and immutable wire results."""

    def __init__(self, capacity: int = 512):
        if capacity < 1:
            raise ValueError("capacity must be positive")
        self.capacity = capacity
        self._values: OrderedDict[str, tuple[str, dict[str, Any]]] = OrderedDict()

    def get(self, command: RobotCommand) -> dict[str, Any] | None:
        cached = self._values.get(command.command_id)
        if cached is None:
            return None
        fingerprint, result = cached
        if fingerprint != command.fingerprint():
            raise ProtocolError("command id was reused with different parameters")
        self._values.move_to_end(command.command_id)
        return dict(result)

    def put(self, command: RobotCommand, result: Mapping[str, Any]) -> None:
        self._values[command.command_id] = (command.fingerprint(), dict(result))
        self._values.move_to_end(command.command_id)
        while len(self._values) > self.capacity:
            self._values.popitem(last=False)
