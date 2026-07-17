from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeResponse, RoutingOpener

from reachy_homebrain.launcher_constants import (
    DEPENDENCY_FINGERPRINT,
    LAUNCHER_API,
    LAUNCHER_FINGERPRINT,
    STABLE_LAUNCHER_FILES,
)
from reachy_homebrain.package_stage import ManualReinstallRequired, PackageStageError, PackageStager
from reachy_homebrain.releases import ReleaseError, ReleaseManager, manifest_aggregate_sha256


def aggregate_for(entries: list[dict[str, Any]]) -> str:
    return manifest_aggregate_sha256(entries)


def test_manifest_aggregate_has_fixed_cross_language_utf8_vector() -> None:
    entries = [
        {"path": "src/reachy_homebrain/z.py", "size": 3, "sha256": "a" * 64},
        {"path": "src/reachy_homebrain/__init__.py", "size": 0, "sha256": "b" * 64},
        {"path": "src/reachy_homebrain/nested/é.py", "size": 12, "sha256": "c" * 64},
        {"path": "artifact-manifest.json", "size": 99, "sha256": "d" * 64},
    ]
    assert manifest_aggregate_sha256(entries) == (
        "2246bcb2638500a5070c7f2062a7fd023e4400d6d0bcb2f816f8ab576638a98d"
    )


def package_fixture(version: str = "0.2.0") -> tuple[dict[str, Any], dict[str, bytes]]:
    compatibility = {
        "launcherApi": LAUNCHER_API,
        "dependencyFingerprint": DEPENDENCY_FINGERPRINT,
        "launcherFingerprint": LAUNCHER_FINGERPRINT,
        "requiresManualReinstall": False,
    }
    files = {
        "pyproject.toml": b"[project]\nname='reachy-homebrain-app'\n",
        "artifact-manifest.json": json.dumps(
            {
                "artifact": "reachy-homebrain-app",
                "version": version,
                "compatibility": compatibility,
            }
        ).encode(),
        "src/reachy_homebrain/app.py": b"def run_companion(*args, **kwargs): pass\n",
    }
    entries = [
        {
            "path": path,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "downloadUrl": f"/files?path={path}",
        }
        for path, data in files.items()
    ]
    manifest = {
        "schemaVersion": 1,
        "artifact": "reachy-homebrain-app",
        "version": version,
        "compatibility": compatibility,
        "files": entries,
        "aggregateSha256": aggregate_for(entries),
    }
    return manifest, files


def stage_fixture(config, tmp_path: Path, manifest: dict[str, Any], files: dict[str, bytes]):
    manifest_url = "https://homebrain.test/manifest"
    routes: dict[str, Any] = {manifest_url: FakeResponse(manifest, url=manifest_url)}
    for entry in manifest["files"]:
        url = f"https://homebrain.test{entry['downloadUrl']}"
        source_path = entry["downloadUrl"].partition("path=")[2]
        routes[url] = FakeResponse(files[source_path], url=url)
    opener = RoutingOpener(routes)
    manager = ReleaseManager(tmp_path / "data")
    manager._ensure_dirs()
    stager = PackageStager(
        config,
        opener=opener,
        temp_parent=manager.data_root,
        release_manager=manager,
    )
    return manifest_url, opener, manager, stager


def test_success_commits_immutable_release_without_activating(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, opener, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    result = stager.stage(url, request_id="request-1")
    assert result.path.parent == manager.releases_dir
    assert result.path.name == manifest["aggregateSha256"]
    assert result.aggregate_sha256 == manifest["aggregateSha256"]
    assert (result.path / ".homebrain-package-manifest.json").is_file()
    state = json.loads(manager.state_path.read_text())
    assert state["active"] is None
    assert state["pending"] is None
    assert state["stagedRequests"]["request-1"]["aggregateSha256"] == manifest["aggregateSha256"]
    assert opener.requests[0].get_header("X-homebrain-device-token") == "device-secret-token"


def test_pending_is_promoted_only_after_matching_health_confirmation(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    stager.stage(url, request_id="request-1")
    pending = manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])
    manager.authorize_launch("request-1", "0.2.0", manifest["aggregateSha256"])
    selected = manager.prepare_launch(bundled_version="0.1.0")
    assert selected.version == "0.2.0"
    assert selected.pending is True
    assert manager.report()["version"] is None  # still no LKG active release
    with pytest.raises(ReleaseError, match="confirmation"):
        manager.confirm_update("request-1", "0.2.0", selected.aggregate_sha256, "wrong-attempt")
    manager.confirm_update("request-1", "0.2.0", selected.aggregate_sha256, selected.attempt_id)
    assert manager.report()["version"] == "0.2.0"
    assert manager.report()["pending"] is None
    assert pending["attemptId"] == selected.attempt_id


def test_unhealthy_pending_rolls_back_on_next_process(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    stager.stage(url, request_id="request-1")
    manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])
    manager.authorize_launch("request-1", "0.2.0", manifest["aggregateSha256"])
    assert manager.prepare_launch(bundled_version="0.1.0").pending is True
    second = ReleaseManager(manager.data_root).prepare_launch(bundled_version="0.1.0")
    assert second.bundled is True
    assert second.version == "0.1.0"


def test_checksum_mismatch_cleans_temporary_stage(config, tmp_path) -> None:
    manifest, files = package_fixture()
    files["src/reachy_homebrain/app.py"] = b"tampered"
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    with pytest.raises(PackageStageError, match=r"checksum|size mismatch"):
        stager.stage(url, request_id="request-1")
    assert list(manager.data_root.glob("homebrain-reachy-update-*")) == []


def test_path_traversal_is_rejected(config, tmp_path) -> None:
    manifest, files = package_fixture()
    manifest["files"][0]["path"] = "../escape.py"
    manifest["aggregateSha256"] = aggregate_for(manifest["files"])
    url, _, _, stager = stage_fixture(config, tmp_path, manifest, files)
    with pytest.raises(PackageStageError, match=r"traversal|allowlisted"):
        stager.stage(url, request_id="request-1")


def test_incompatible_dependency_fingerprint_requires_manual_reinstall(config, tmp_path) -> None:
    manifest, files = package_fixture()
    manifest["compatibility"]["dependencyFingerprint"] = "0" * 64
    url, _, _, stager = stage_fixture(config, tmp_path, manifest, files)
    with pytest.raises(ManualReinstallRequired, match="manual_reinstall_required"):
        stager.stage(url, request_id="request-1")


def test_incompatible_launcher_fingerprint_requires_manual_reinstall(config, tmp_path) -> None:
    manifest, files = package_fixture()
    manifest["compatibility"]["launcherFingerprint"] = "0" * 64
    url, _, _, stager = stage_fixture(config, tmp_path, manifest, files)
    with pytest.raises(ManualReinstallRequired, match="manual_reinstall_required"):
        stager.stage(url, request_id="request-1")


def test_external_package_cannot_replace_a_stable_launcher_file(config, tmp_path) -> None:
    manifest, files = package_fixture()
    stable_path = "src/reachy_homebrain/main.py"
    files[stable_path] = b"# forbidden stable launcher mutation\n"
    manifest["files"].append(
        {
            "path": stable_path,
            "size": len(files[stable_path]),
            "sha256": hashlib.sha256(files[stable_path]).hexdigest(),
            "downloadUrl": f"/files?path={stable_path}",
        }
    )
    manifest["aggregateSha256"] = aggregate_for(manifest["files"])
    url, _, _, stager = stage_fixture(config, tmp_path, manifest, files)
    with pytest.raises(ManualReinstallRequired, match="stable launcher file"):
        stager.stage(url, request_id="request-1")


def test_external_package_cannot_replace_already_loaded_package_initializer(config, tmp_path) -> None:
    manifest, files = package_fixture()
    stable_path = "src/reachy_homebrain/__init__.py"
    files[stable_path] = b"# forbidden pre-selection code\n"
    manifest["files"].append(
        {
            "path": stable_path,
            "size": len(files[stable_path]),
            "sha256": hashlib.sha256(files[stable_path]).hexdigest(),
            "downloadUrl": f"/files?path={stable_path}",
        }
    )
    manifest["aggregateSha256"] = aggregate_for(manifest["files"])
    url, _, _, stager = stage_fixture(config, tmp_path, manifest, files)
    with pytest.raises(ManualReinstallRequired, match="stable launcher file"):
        stager.stage(url, request_id="request-1")


def test_release_mutation_is_rejected_before_activation(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    result = stager.stage(url, request_id="request-1")
    app_file = result.path / "src/reachy_homebrain/app.py"
    app_file.chmod(0o600)
    app_file.write_text("tampered")
    with pytest.raises(ReleaseError, match="verification"):
        manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])


def test_restart_between_stage_and_prepare_runs_existing_runtime(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    stager.stage(url, request_id="request-1")
    selected = ReleaseManager(manager.data_root).prepare_launch(bundled_version="0.1.0")
    assert selected.bundled is True
    assert selected.version == "0.1.0"


def test_prepared_but_not_released_candidate_is_never_selected(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    stager.stage(url, request_id="request-1")
    manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])
    selected = ReleaseManager(manager.data_root).prepare_launch(bundled_version="0.1.0")
    assert selected.bundled is True
    assert selected.version == "0.1.0"
    assert manager.report()["pending"]["launchReady"] is False


def test_expired_unreleased_prepare_is_garbage_collected_and_does_not_block_next_update(
    config, tmp_path
) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    stager.stage(url, request_id="request-1")
    manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])
    state = json.loads(manager.state_path.read_text())
    state["pending"]["expiresAt"] = 0
    manager.state_path.write_text(json.dumps(state))
    manager.state_path.chmod(0o600)
    selected = manager.prepare_launch(bundled_version="0.1.0")
    assert selected.bundled is True
    assert manager.report()["pending"] is None

    next_manifest, next_files = package_fixture("0.3.0")
    next_url, _, _, next_stager = stage_fixture(config, tmp_path, next_manifest, next_files)
    next_stager.stage(next_url, request_id="request-2")
    pending = manager.prepare_update("request-2", "0.3.0", next_manifest["aggregateSha256"])
    assert pending["requestId"] == "request-2"


def test_correlated_rollback_disarms_pending_idempotently(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    stager.stage(url, request_id="request-1")
    manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])
    previous_digest = "b" * 64
    first = manager.rollback("request-1", "0.1.0", previous_digest)
    second = manager.rollback("request-1", "0.1.0", previous_digest)
    assert first == second
    assert manager.report()["pending"] is None
    selected = manager.prepare_launch(bundled_version="0.1.0")
    assert selected.bundled is True
    with pytest.raises(ReleaseError, match=r"target|request"):
        manager.rollback("different-request", "0.1.0", previous_digest)


def test_confirmation_retry_is_idempotent(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    stager.stage(url, request_id="request-1")
    manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])
    manager.authorize_launch("request-1", "0.2.0", manifest["aggregateSha256"])
    selected = manager.prepare_launch(bundled_version="0.1.0")
    first = manager.confirm_update("request-1", "0.2.0", manifest["aggregateSha256"], selected.attempt_id)
    second = manager.confirm_update("request-1", "0.2.0", manifest["aggregateSha256"], selected.attempt_id)
    assert first == second


def test_first_external_confirmation_can_roll_back_to_verified_installed_bundle(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    bundled_digest = "e" * 64
    manager.data_root.joinpath("installed-receipt.json").write_text(
        json.dumps(
            {
                "version": "0.1.0",
                "aggregateSha256": bundled_digest,
                "provenance": "installed-bundle",
            }
        )
    )
    manager.data_root.joinpath("installed-receipt.json").chmod(0o600)
    stager.stage(url, request_id="request-1")
    manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])
    manager.authorize_launch("request-1", "0.2.0", manifest["aggregateSha256"])
    selected = manager.prepare_launch(bundled_version="0.1.0")
    manager.confirm_update("request-1", "0.2.0", manifest["aggregateSha256"], selected.attempt_id)

    # A lost confirm ACK is reconciled by the exact idempotent retry.
    retried = manager.confirm_update("request-1", "0.2.0", manifest["aggregateSha256"], selected.attempt_id)
    assert retried["version"] == "0.2.0"
    assert retried["provenance"] == "external-release"

    rolled_back = manager.rollback("rollback-1", "0.1.0", bundled_digest)
    assert rolled_back["version"] == "0.1.0"
    assert rolled_back["aggregateSha256"] == bundled_digest
    assert rolled_back["provenance"] == "installed-bundle"
    assert rolled_back["pending"] is None
    bundled = manager.prepare_launch(bundled_version="0.1.0")
    assert bundled.bundled is True
    assert bundled.aggregate_sha256 == bundled_digest


@pytest.mark.parametrize("mutation", ["extra", "symlink", "mode"])
def test_release_verification_rejects_extra_symlink_and_unsafe_mode(config, tmp_path, mutation: str) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    result = stager.stage(url, request_id="request-1")
    if mutation == "extra":
        result.path.chmod(0o700)
        extra = result.path / "extra.py"
        extra.write_text("unexpected")
        extra.chmod(0o400)
        result.path.chmod(0o500)
    elif mutation == "symlink":
        parent = result.path / "src/reachy_homebrain"
        parent.chmod(0o700)
        target = parent / "app.py"
        target.unlink()
        target.symlink_to("__init__.py")
        parent.chmod(0o500)
    else:
        (result.path / "pyproject.toml").chmod(0o644)
    with pytest.raises(ReleaseError, match="verification"):
        manager.prepare_update("request-1", "0.2.0", manifest["aggregateSha256"])


def test_cleanup_refuses_unrelated_directory(tmp_path) -> None:
    with pytest.raises(PackageStageError, match="refusing"):
        PackageStager.cleanup(tmp_path / "unrelated")


def test_release_status_exposes_bounded_durable_reconciliation_receipts(config, tmp_path) -> None:
    manifest, files = package_fixture()
    url, _, manager, stager = stage_fixture(config, tmp_path, manifest, files)
    digest = manifest["aggregateSha256"]
    stager.stage(url, request_id="request-1")

    staged = ReleaseManager(manager.data_root).report()
    assert staged["lastStaged"] == {
        "requestId": "request-1",
        "version": "0.2.0",
        "aggregateSha256": digest,
        "stagedAt": staged["lastStaged"]["stagedAt"],
    }
    assert staged["stagedRequests"]["request-1"] == {
        "version": "0.2.0",
        "aggregateSha256": digest,
        "stagedAt": staged["lastStaged"]["stagedAt"],
    }
    assert isinstance(staged["lastStaged"]["stagedAt"], int)
    assert staged["lastAuthorized"] is None
    assert staged["lastConfirmed"] is None

    manager.prepare_update("request-1", "0.2.0", digest)
    first_authorization = manager.authorize_launch("request-1", "0.2.0", digest)
    second_authorization = manager.authorize_launch("request-1", "0.2.0", digest)
    assert first_authorization == second_authorization
    authorized = ReleaseManager(manager.data_root).report()
    assert authorized["lastAuthorized"]["requestId"] == "request-1"
    assert authorized["lastAuthorized"]["version"] == "0.2.0"
    assert authorized["lastAuthorized"]["aggregateSha256"] == digest
    assert isinstance(authorized["lastAuthorized"]["authorizedAt"], int)
    assert authorized["lastAuthorized"]["launchReady"] is True

    selected = manager.prepare_launch(bundled_version="0.1.0")
    confirmed = manager.confirm_update(
        "request-1",
        "0.2.0",
        digest,
        selected.attempt_id,
    )
    assert confirmed["lastConfirmed"]["requestId"] == "request-1"
    assert confirmed["lastConfirmed"]["version"] == "0.2.0"
    assert confirmed["lastConfirmed"]["aggregateSha256"] == digest
    assert isinstance(confirmed["lastConfirmed"]["confirmedAt"], int)
    assert confirmed["lastAuthorized"]["launchReady"] is False
    assert ReleaseManager(manager.data_root).report()["lastConfirmed"] == confirmed["lastConfirmed"]


def test_release_status_bounds_staged_request_receipts(tmp_path) -> None:
    manager = ReleaseManager(tmp_path / "data")
    manager.ensure_dirs()
    state = manager._empty_state()
    state["stagedRequests"] = {
        f"request-{index:03d}": {
            "releaseId": f"release-{index}",
            "version": f"0.2.{index}",
            "aggregateSha256": f"{index:064x}",
            "stagedAt": index,
        }
        for index in range(70)
    }
    manager.state_path.write_text(json.dumps(state), encoding="utf-8")
    manager.state_path.chmod(0o600)
    report = manager.report()
    assert len(report["stagedRequests"]) == 64
    assert report["lastStaged"]["requestId"] == "request-069"
    assert "request-000" not in report["stagedRequests"]


def test_artifact_declares_the_exact_stable_launcher_inventory() -> None:
    artifact = json.loads(
        Path(__file__).parents[1].joinpath("artifact-manifest.json").read_text(encoding="utf-8")
    )
    assert tuple(artifact["stableLauncherFiles"]) == STABLE_LAUNCHER_FILES
    assert artifact["compatibility"]["launcherFingerprint"] == LAUNCHER_FINGERPRINT
