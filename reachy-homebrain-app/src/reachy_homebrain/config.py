"""Validated configuration and permission-safe persistence."""

from __future__ import annotations

import json
import os
import re
import stat
import tempfile
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


class ConfigurationError(ValueError):
    """Configuration is missing, unsafe, or malformed."""


_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_UNIT_ID_RE = re.compile(r"^[a-f0-9]{16}$")
_SAFE_POLICIES = frozenset({"stop", "neutral", "sleep"})


def _bounded_number(
    value: Any,
    name: str,
    minimum: float,
    maximum: float,
    *,
    integer: bool = False,
) -> float | int:
    if isinstance(value, bool):
        raise ConfigurationError(f"{name} must be numeric")
    try:
        resolved = int(value) if integer else float(value)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{name} must be numeric") from exc
    if not minimum <= resolved <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return resolved


def _json_boolean(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ConfigurationError(f"{name} must be a JSON boolean")
    return value


@dataclass(slots=True)
class HomeBrainConfig:
    """Robot-local configuration.

    Credential fields are excluded from ``repr`` so routine exception logging
    cannot accidentally expose bootstrap or long-lived device credentials.
    """

    hub_url: str
    unit_id: str = ""
    device_id: str = ""
    device_token: str = field(default="", repr=False)
    registration_code: str = field(default="", repr=False)
    claim_token: str = field(default="", repr=False)
    allow_insecure_http: bool = False
    heartbeat_interval_s: float = 30.0
    status_interval_s: float = 60.0
    reconnect_initial_s: float = 1.0
    reconnect_max_s: float = 30.0
    command_default_ttl_ms: int = 5_000
    command_max_ttl_ms: int = 30_000
    command_audio_max_s: float = 8.0
    audio_preroll_ms: int = 400
    safe_shutdown: str = "sleep"
    safe_disconnect: str = "neutral"
    log_level: str = "INFO"

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> HomeBrainConfig:
        """Build and validate a config while ignoring no misspelled keys."""

        known = set(cls.__dataclass_fields__)
        unknown = sorted(set(raw) - known)
        if unknown:
            raise ConfigurationError(f"unknown configuration key(s): {', '.join(unknown)}")

        config = cls(
            hub_url=str(raw.get("hub_url", "")).strip(),
            unit_id=str(raw.get("unit_id", "")).strip(),
            device_id=str(raw.get("device_id", "")).strip(),
            device_token=str(raw.get("device_token", "")).strip(),
            registration_code=str(raw.get("registration_code", "")).strip(),
            claim_token=str(raw.get("claim_token", "")).strip(),
            allow_insecure_http=_json_boolean(
                raw.get("allow_insecure_http", False),
                "allow_insecure_http",
            ),
            heartbeat_interval_s=float(
                _bounded_number(raw.get("heartbeat_interval_s", 30), "heartbeat_interval_s", 5, 300)
            ),
            status_interval_s=float(
                _bounded_number(raw.get("status_interval_s", 60), "status_interval_s", 10, 900)
            ),
            reconnect_initial_s=float(
                _bounded_number(raw.get("reconnect_initial_s", 1), "reconnect_initial_s", 0.1, 30)
            ),
            reconnect_max_s=float(_bounded_number(raw.get("reconnect_max_s", 30), "reconnect_max_s", 1, 300)),
            command_default_ttl_ms=int(
                _bounded_number(
                    raw.get("command_default_ttl_ms", 5_000),
                    "command_default_ttl_ms",
                    100,
                    30_000,
                    integer=True,
                )
            ),
            command_max_ttl_ms=int(
                _bounded_number(
                    raw.get("command_max_ttl_ms", 30_000),
                    "command_max_ttl_ms",
                    1_000,
                    120_000,
                    integer=True,
                )
            ),
            command_audio_max_s=float(
                _bounded_number(raw.get("command_audio_max_s", 8), "command_audio_max_s", 1, 30)
            ),
            audio_preroll_ms=int(
                _bounded_number(
                    raw.get("audio_preroll_ms", 400),
                    "audio_preroll_ms",
                    0,
                    2_000,
                    integer=True,
                )
            ),
            safe_shutdown=str(raw.get("safe_shutdown", "sleep")).strip().lower(),
            safe_disconnect=str(raw.get("safe_disconnect", "neutral")).strip().lower(),
            log_level=str(raw.get("log_level", "INFO")).strip().upper(),
        )
        config.validate()
        return config

    def validate(self) -> None:
        if not self.hub_url:
            raise ConfigurationError("hub_url is required")
        if not isinstance(self.allow_insecure_http, bool):
            raise ConfigurationError("allow_insecure_http must be a JSON boolean")
        if any(character.isspace() or ord(character) < 32 for character in self.hub_url):
            raise ConfigurationError("hub_url contains whitespace or control characters")
        parts = urlsplit(self.hub_url if "://" in self.hub_url else f"https://{self.hub_url}")
        if parts.scheme not in {"http", "https", "ws", "wss"} or not parts.hostname:
            raise ConfigurationError("hub_url must be an absolute HTTP(S) or WS(S) URL")
        try:
            port = parts.port
        except ValueError as exc:
            raise ConfigurationError("hub_url port is invalid") from exc
        if port is not None and not 1 <= port <= 65_535:
            raise ConfigurationError("hub_url port is invalid")
        if parts.username or parts.password:
            raise ConfigurationError("hub_url must not embed credentials")
        if parts.query or parts.fragment:
            raise ConfigurationError("hub_url must not contain a query string or fragment")
        if parts.scheme in {"http", "ws"} and not self.allow_insecure_http:
            raise ConfigurationError(
                "unencrypted HomeBrain transport is disabled; use HTTPS or explicitly set "
                "allow_insecure_http for a trusted development LAN"
            )
        if self.device_id and not _DEVICE_ID_RE.fullmatch(self.device_id):
            raise ConfigurationError("device_id contains unsupported characters")
        if self.unit_id and not _UNIT_ID_RE.fullmatch(self.unit_id):
            raise ConfigurationError("unit_id must be the Reachy daemon's 16-character hardware id")
        for name in ("device_token", "registration_code", "claim_token"):
            credential = getattr(self, name)
            if len(credential) > 4_096 or any(ord(char) < 32 for char in credential):
                raise ConfigurationError(f"{name} is malformed")
        if self.device_token and not self.device_id:
            raise ConfigurationError("device_id is required when device_token is set")
        if not self.device_token and not self.registration_code and not self.claim_token:
            raise ConfigurationError("provide device_token or one temporary registration_code/claim_token")
        if self.registration_code and self.claim_token:
            raise ConfigurationError("provide only one bootstrap credential")
        if self.reconnect_initial_s > self.reconnect_max_s:
            raise ConfigurationError("reconnect_initial_s must not exceed reconnect_max_s")
        if self.command_default_ttl_ms > self.command_max_ttl_ms:
            raise ConfigurationError("command_default_ttl_ms must not exceed command_max_ttl_ms")
        if self.safe_shutdown not in _SAFE_POLICIES or self.safe_disconnect not in _SAFE_POLICIES:
            raise ConfigurationError("safe policies must be stop, neutral, or sleep")
        if self.log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ConfigurationError("log_level is invalid")

    @property
    def http_base_url(self) -> str:
        parts = urlsplit(self.hub_url if "://" in self.hub_url else f"https://{self.hub_url}")
        scheme = "https" if parts.scheme in {"https", "wss"} else "http"
        return urlunsplit((scheme, parts.netloc, parts.path.rstrip("/"), "", ""))

    @property
    def voice_websocket_url(self) -> str:
        if not self.device_id:
            raise ConfigurationError("device_id is unavailable before activation")
        base = urlsplit(self.http_base_url)
        scheme = "wss" if base.scheme == "https" else "ws"
        prefix = base.path.rstrip("/")
        path = f"{prefix}/ws/voice-device"
        query = urlencode({"deviceId": self.device_id})
        return urlunsplit((scheme, base.netloc, path, query, ""))

    def absolute_http_url(self, path_or_url: str) -> str:
        candidate = urlsplit(path_or_url)
        if candidate.scheme:
            if candidate.scheme not in {"http", "https"}:
                raise ConfigurationError("remote asset URL must use HTTP(S)")
            if candidate.scheme == "http" and not self.allow_insecure_http:
                raise ConfigurationError("remote asset URL must use HTTPS")
            return path_or_url
        base = urlsplit(self.http_base_url)
        prefix = base.path.rstrip("/")
        path = path_or_url if path_or_url.startswith("/") else f"/{path_or_url}"
        return urlunsplit((base.scheme, base.netloc, f"{prefix}{path}", "", ""))

    def tts_url(self) -> str:
        if not self.device_id:
            raise ConfigurationError("device_id is unavailable before TTS")
        base = urlsplit(self.http_base_url)
        prefix = base.path.rstrip("/")
        device_id = quote(self.device_id, safe="")
        return urlunsplit((base.scheme, base.netloc, f"{prefix}/api/remote-devices/{device_id}/tts", "", ""))

    def auth_headers(self) -> dict[str, str]:
        if not self.device_token:
            return {}
        return {"X-HomeBrain-Device-Token": self.device_token}

    def persisted_mapping(self) -> dict[str, Any]:
        return asdict(self)

    def redacted_mapping(self) -> dict[str, Any]:
        value = self.persisted_mapping()
        for key in ("device_token", "registration_code", "claim_token"):
            if value[key]:
                value[key] = "<redacted>"
        return value


class SecureConfigStore:
    """Read and atomically persist config with owner-only permissions."""

    def __init__(self, path: str | Path):
        # Normalize dot segments without resolving symlinks; load/save must be
        # able to reject a symlink at the configured path itself.
        self.path = Path(os.path.abspath(Path(path).expanduser()))

    def load(self, environ: Mapping[str, str] | None = None) -> HomeBrainConfig:
        raw: dict[str, Any] = {}
        if self.path.is_symlink():
            raise ConfigurationError("config path must be a regular, non-symlink file")
        if self.path.exists():
            info = self.path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ConfigurationError("config path must be a regular, non-symlink file")
            if info.st_mode & 0o077:
                os.chmod(self.path, 0o600)
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise ConfigurationError(f"unable to read config: {exc}") from exc
            if not isinstance(loaded, dict):
                raise ConfigurationError("config root must be a JSON object")
            raw.update(loaded)

        env = os.environ if environ is None else environ
        env_fields = {
            "HOMEBRAIN_HUB_URL": "hub_url",
            "HOMEBRAIN_REACHY_UNIT_ID": "unit_id",
            "HOMEBRAIN_DEVICE_ID": "device_id",
            "HOMEBRAIN_DEVICE_TOKEN": "device_token",
            "HOMEBRAIN_REGISTRATION_CODE": "registration_code",
            "HOMEBRAIN_CLAIM_TOKEN": "claim_token",
        }
        for env_name, field_name in env_fields.items():
            if env.get(env_name, "").strip():
                raw[field_name] = env[env_name].strip()
        if env.get("HOMEBRAIN_ALLOW_INSECURE_HTTP", "").strip():
            raw["allow_insecure_http"] = env["HOMEBRAIN_ALLOW_INSECURE_HTTP"].lower() in {
                "1",
                "true",
                "yes",
            }
        return HomeBrainConfig.from_mapping(raw)

    def save(self, config: HomeBrainConfig) -> None:
        config.validate()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with suppress(OSError):
            os.chmod(self.path.parent, 0o700)
        if self.path.is_symlink():
            raise ConfigurationError("refusing to replace a symlinked config file")
        payload = json.dumps(config.persisted_mapping(), indent=2, sort_keys=True) + "\n"
        temporary: str | None = None
        try:
            descriptor, temporary = tempfile.mkstemp(
                prefix=f".{self.path.name}.", dir=self.path.parent, text=True
            )
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
            os.chmod(self.path, 0o600)
        finally:
            if temporary:
                with suppress(FileNotFoundError):
                    os.unlink(temporary)


def merge_query(url: str, values: Mapping[str, str]) -> str:
    """Add query parameters without discarding parameters supplied by HomeBrain."""

    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.update(values)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
