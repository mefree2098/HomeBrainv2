"""Reachy Mini managed-app and standalone diagnostics entry points."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

from .bootstrap import activate_device
from .client import HomeBrainClient
from .config import ConfigurationError, SecureConfigStore
from .identity import HardwareIdentityError, read_daemon_status, read_hardware_id
from .motion import LocalMotionService
from .package_stage import PackageStager
from .perception import LocalVolumeService, PresenceMonitor, SnapshotService, TrackingCoordinator
from .releases import ReleaseManager
from .robot import RobotController
from .sdk_compat import ReachyMiniApp, require_sdk
from .tts import TtsPlayer
from .wakeword import WakeWordAssetManager, WakeWordRuntime

LOGGER = logging.getLogger(__name__)


def _default_config_path(app: ReachyMiniApp | None = None) -> Path:
    override = os.environ.get("HOMEBRAIN_REACHY_CONFIG", "").strip()
    if override:
        return Path(override).expanduser()
    if app is not None:
        try:
            instance_config = app._get_instance_path().parent / "config.json"
            if instance_config.exists():
                return instance_config
        except Exception:
            pass
    return Path.home() / ".config" / "homebrain-reachy" / "config.json"


def run_companion(
    robot: Any,
    stop_event: threading.Event,
    config_path: str | Path,
    *,
    health_callback: Any = None,
) -> None:
    store = SecureConfigStore(config_path)
    config = store.load()
    try:
        live_unit_id = read_hardware_id(robot=robot)
    except HardwareIdentityError as exc:
        raise ConfigurationError(str(exc)) from exc
    if config.unit_id and config.unit_id != live_unit_id:
        raise ConfigurationError("persisted Reachy unit_id does not match the connected hardware")
    if not config.unit_id:
        config = replace(config, unit_id=live_unit_id)
        store.save(config)
    if not config.device_token:
        config = activate_device(config, store, unit_id=live_unit_id)
    logging.getLogger().setLevel(getattr(logging, config.log_level))
    snapshot = SnapshotService(config, robot)
    volume = LocalVolumeService(robot)
    tracking = TrackingCoordinator(robot)
    motion = LocalMotionService(robot)
    presence = PresenceMonitor(robot, tracking=tracking)
    controller = RobotController(
        robot,
        default_ttl_ms=config.command_default_ttl_ms,
        max_ttl_ms=config.command_max_ttl_ms,
        snapshot_hook=snapshot.capture_and_upload,
        release_hook=lambda _command_id: stop_event.set(),
        volume_hook=volume.set,
        tracking=tracking,
        motion=motion,
    )
    tts = TtsPlayer(config, robot)
    wake_word = WakeWordRuntime(
        WakeWordAssetManager(config, Path(config_path).expanduser().resolve().parent / "wake-words")
    )
    release_manager = ReleaseManager()
    release_manager._ensure_dirs()
    package_stager = PackageStager(
        config,
        temp_parent=release_manager.data_root,
        receipt_path=release_manager.data_root / "installed-receipt.json",
        release_manager=release_manager,
    )
    client = HomeBrainClient(
        config,
        robot,
        controller,
        tts,
        release_callback=lambda _reason: stop_event.set(),
        package_stager=package_stager,
        wake_word=wake_word,
        presence=presence,
        snapshot=snapshot,
        release_manager=release_manager,
        health_callback=health_callback,
        daemon_status_provider=lambda: read_daemon_status(
            robot=robot,
            expected_hardware_id=live_unit_id,
        ),
    )
    try:
        asyncio.run(client.run(stop_event))
    finally:
        if not client.safe_shutdown_applied:
            controller.apply_safe_policy(config.safe_shutdown)
        presence.close()
        tts.close()


class HomeBrainReachyApp(ReachyMiniApp):  # type: ignore[misc]
    """Official Reachy Mini Apps entry point."""

    # Let the SDK select the daemon-owned local audio/camera path on Wireless.
    request_media_backend = "default"
    dont_start_webserver = True

    def run(self, reachy_mini: Any, stop_event: threading.Event) -> None:
        run_companion(reachy_mini, stop_event, _default_config_path(self))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="HomeBrain companion for Reachy Mini Wireless")
    parser.add_argument("--config", type=Path, default=_default_config_path())
    parser.add_argument(
        "--check-config",
        action="store_true",
        help="validate configuration and permissions without connecting to a robot",
    )
    return parser


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    arguments = _parser().parse_args()
    store = SecureConfigStore(arguments.config)
    try:
        config = store.load()
    except ConfigurationError as exc:
        raise SystemExit(f"Configuration error: {exc}") from exc
    if arguments.check_config:
        # Deliberately print only a redacted representation.
        print(f"Configuration valid: {config.redacted_mapping()}")
        return
    require_sdk()
    from reachy_mini import ReachyMini  # type: ignore[import-not-found]

    stop_event = threading.Event()
    try:
        with ReachyMini(connection_mode="localhost_only") as robot:
            run_companion(robot, stop_event, arguments.config)
    except KeyboardInterrupt:
        stop_event.set()


if __name__ == "__main__":  # pragma: no cover
    main()
