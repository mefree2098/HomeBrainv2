"""Reachy Mini app-assistant compatible managed entry point."""

from __future__ import annotations

import importlib
import os
import sys
import threading
from typing import Any

from .launcher_constants import LAUNCHER_VERSION
from .releases import ReleaseManager

try:
    from reachy_mini import ReachyMiniApp
except ImportError:  # SDK-free protocol/unit tests only
    from .sdk_compat import ReachyMiniApp


class ReachyHomebrain(ReachyMiniApp):  # type: ignore[misc]
    """Managed Reachy Wireless app discovered through ``reachy_mini_apps``."""

    request_media_backend = "default"
    dont_start_webserver = True

    def run(self, reachy_mini: Any, stop_event: threading.Event) -> None:
        sys.dont_write_bytecode = True
        manager = ReleaseManager()
        selected = manager.prepare_launch(bundled_version=LAUNCHER_VERSION)
        os.environ["HOMEBRAIN_REACHY_ACTIVE_VERSION"] = selected.version
        if selected.aggregate_sha256 and not selected.bundled:
            os.environ["HOMEBRAIN_REACHY_ACTIVE_AGGREGATE"] = selected.aggregate_sha256
        else:
            os.environ.pop("HOMEBRAIN_REACHY_ACTIVE_AGGREGATE", None)

        if selected.path is not None:
            package = sys.modules[__package__]
            runtime_package = str(selected.path / "src/reachy_homebrain")
            package.__path__[:] = [runtime_package]
            package_spec = getattr(package, "__spec__", None)
            if package_spec is None or package_spec.submodule_search_locations is None:
                raise RuntimeError("Reachy runtime package has no import search locations")
            package_spec.submodule_search_locations[:] = [runtime_package]
            importlib.invalidate_caches()

        allowed = {
            "reachy_homebrain",
            "reachy_homebrain.__main__",
            "reachy_homebrain.main",
            "reachy_homebrain.sdk_compat",
            "reachy_homebrain.releases",
            "reachy_homebrain.launcher_constants",
        }
        unexpected = sorted(
            name for name in sys.modules if name.startswith("reachy_homebrain.") and name not in allowed
        )
        if unexpected:
            raise RuntimeError(f"runtime modules loaded before release selection: {unexpected}")
        app = importlib.import_module("reachy_homebrain.app")
        config_path = app._default_config_path(self)

        def health_callback(request_id: str, version: str, aggregate: str) -> dict[str, Any]:
            return manager.confirm_update(
                request_id,
                version,
                aggregate,
                selected.attempt_id,
            )

        app.run_companion(
            reachy_mini,
            stop_event,
            config_path,
            health_callback=health_callback,
        )


if __name__ == "__main__":  # pragma: no cover - exercised by managed daemon smoke test
    application = ReachyHomebrain()
    try:
        application.wrapped_run()
    except KeyboardInterrupt:
        application.stop()
