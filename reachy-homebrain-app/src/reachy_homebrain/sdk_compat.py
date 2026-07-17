"""Optional Reachy SDK imports.

The managed app declares Reachy Mini as an installation dependency, but keeping
imports optional lets protocol, configuration, and robot-policy tests run on a
developer machine without a daemon or physical robot.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

SDK_AVAILABLE = False
SDK_IMPORT_ERROR: Exception | None = None

try:  # pragma: no cover - exercised on the robot, not in SDK-free CI
    from reachy_mini import ReachyMini as ReachyMini
    from reachy_mini import ReachyMiniApp as ReachyMiniApp
    from reachy_mini.utils import create_head_pose as create_head_pose

    SDK_AVAILABLE = True
except Exception as exc:  # pragma: no cover - the fallback itself is covered indirectly
    SDK_IMPORT_ERROR = exc
    ReachyMini = Any  # type: ignore[misc,assignment]

    class ReachyMiniApp:  # type: ignore[no-redef]
        """Small import-time stand-in; hardware execution still fails clearly."""

        settings_app: Any = None

        def _get_instance_path(self) -> Path:
            return Path.cwd() / "reachy_homebrain"

        def wrapped_run(self) -> None:
            raise RuntimeError(
                "The Reachy Mini SDK is required to run this managed app"
            ) from SDK_IMPORT_ERROR

        def stop(self) -> None:
            return None

    create_head_pose = None


def require_sdk() -> None:
    """Raise a useful error when hardware execution is attempted without the SDK."""

    if not SDK_AVAILABLE:
        raise RuntimeError(
            "reachy-mini is not installed; install this package normally on Reachy Wireless"
        ) from SDK_IMPORT_ERROR
