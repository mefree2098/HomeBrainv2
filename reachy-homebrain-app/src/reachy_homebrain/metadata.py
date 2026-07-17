"""Stable package and wire-protocol metadata reported to HomeBrain."""

from __future__ import annotations

import json
import os
import platform
from importlib import metadata
from pathlib import Path
from typing import Any

from .launcher_constants import (
    DEPENDENCY_FINGERPRINT,
    LAUNCHER_API,
    LAUNCHER_FINGERPRINT,
    LAUNCHER_VERSION,
)
from .version import __version__

PACKAGE_NAME = "reachy-homebrain-app"
APP_ENTRY_POINT = "reachy-homebrain-app"
PROTOCOL_NAME = "homebrain-reachy"
PROTOCOL_VERSION = 1
MIN_REACHY_SDK = "1.9"


def package_version() -> str:
    active = os.environ.get("HOMEBRAIN_REACHY_ACTIVE_VERSION", "").strip()
    if active:
        return active
    try:
        return metadata.version(PACKAGE_NAME)
    except metadata.PackageNotFoundError:
        return __version__


def version_report(receipt_path: str | Path | None = None) -> dict[str, Any]:
    """Return non-secret update inventory suitable for auth/status messages."""

    sdk_version: str | None
    try:
        sdk_version = metadata.version("reachy-mini")
    except metadata.PackageNotFoundError:
        sdk_version = None
    version = package_version()
    aggregate: str | None = os.environ.get("HOMEBRAIN_REACHY_ACTIVE_AGGREGATE", "").strip() or None
    if aggregate is None and receipt_path is not None:
        try:
            receipt = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
            if receipt.get("version") == version:
                candidate = receipt.get("aggregateSha256")
                if isinstance(candidate, str) and len(candidate) == 64:
                    aggregate = candidate
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    return {
        "package": PACKAGE_NAME,
        "appEntryPoint": APP_ENTRY_POINT,
        "version": version,
        "aggregateSha256": aggregate,
        "protocol": {"name": PROTOCOL_NAME, "version": PROTOCOL_VERSION},
        "reachySdkVersion": sdk_version,
        "minimumReachySdk": MIN_REACHY_SDK,
        "pythonVersion": platform.python_version(),
        "updateStrategy": "managed-app-release",
        "launcherVersion": LAUNCHER_VERSION,
        "launcherApi": LAUNCHER_API,
        "launcherFingerprint": LAUNCHER_FINGERPRINT,
        "dependencyFingerprint": DEPENDENCY_FINGERPRINT,
        "provenance": "external-release"
        if os.environ.get("HOMEBRAIN_REACHY_ACTIVE_AGGREGATE")
        else "installed-bundle",
    }
