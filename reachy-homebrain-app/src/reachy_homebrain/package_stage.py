"""Verified, non-executing HomeBrain package staging for the Reachy app manager."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .config import HomeBrainConfig
from .http_security import DownloadSecurityError, fetch_limited
from .launcher_constants import (
    DEPENDENCY_FINGERPRINT,
    LAUNCHER_API,
    LAUNCHER_FINGERPRINT,
    STABLE_LAUNCHER_FILES,
)
from .releases import ReleaseError, ReleaseManager, manifest_aggregate_sha256


class PackageStageError(RuntimeError):
    """A package manifest or file failed validation."""


class ManualReinstallRequired(PackageStageError):
    """A runtime release is incompatible with the stable installed launcher."""


_SHA256_RE = re.compile(r"^[a-fA-F0-9]{64}$")
_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$")
_ROOT_FILES = frozenset(
    {
        "pyproject.toml",
        "README.md",
        "config.example.json",
        "artifact-manifest.json",
        "MANIFEST.in",
        "install.sh",
        "index.html",
        "style.css",
    }
)
_SOURCE_RE = re.compile(r"^src/reachy_homebrain/[A-Za-z0-9_./-]+\.(?:py|json|txt|typed)$")
_STABLE_LAUNCHER_FILES = frozenset(STABLE_LAUNCHER_FILES)
MAX_MANIFEST_BYTES = 1 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_FILES = 128


@dataclass(frozen=True, slots=True)
class StagedPackage:
    path: Path
    version: str
    aggregate_sha256: str
    files: int
    total_bytes: int


def _safe_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise PackageStageError("package file path is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise PackageStageError("package file path traversal is forbidden")
    normalized = path.as_posix()
    if normalized in _STABLE_LAUNCHER_FILES:
        raise ManualReinstallRequired(
            f"manual_reinstall_required: stable launcher file cannot be source-updated: {normalized}"
        )
    if normalized not in _ROOT_FILES and not _SOURCE_RE.fullmatch(normalized):
        raise PackageStageError(f"package file is not allowlisted: {normalized}")
    return normalized


def _sha256(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise PackageStageError(f"{field} is required")
    normalized = value.removeprefix("sha256:").lower()
    if not _SHA256_RE.fullmatch(normalized):
        raise PackageStageError(f"{field} must be a SHA-256 digest")
    return normalized


class PackageStager:
    """Download only verified source files into a fresh 0700 temporary directory."""

    def __init__(
        self,
        config: HomeBrainConfig,
        *,
        opener: Callable[..., Any] | None = None,
        temp_parent: str | Path | None = None,
        receipt_path: str | Path | None = None,
        release_manager: ReleaseManager | None = None,
        timeout_s: float = 20.0,
    ):
        self.config = config
        self.opener = opener
        self.temp_parent = Path(temp_parent) if temp_parent is not None else Path(tempfile.gettempdir())
        self.timeout_s = timeout_s
        self.receipt_path = Path(receipt_path) if receipt_path is not None else None
        self.release_manager = release_manager

    @property
    def headers(self) -> dict[str, str]:
        if not self.config.device_token:
            raise PackageStageError("device token is required for package staging")
        return {
            "X-HomeBrain-Device-Token": self.config.device_token,
            "Accept": "application/json, application/octet-stream",
        }

    def stage(self, manifest_url: str, *, request_id: str | None = None) -> StagedPackage:
        stage_path: Path | None = None
        completed = False
        try:
            manifest_bytes, _ = fetch_limited(
                self.config,
                manifest_url,
                max_bytes=MAX_MANIFEST_BYTES,
                headers=self.headers,
                timeout_s=self.timeout_s,
                opener=self.opener,
                allow_redirects=False,
            )
            try:
                manifest = json.loads(manifest_bytes)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PackageStageError("package manifest is not valid JSON") from exc
            version, aggregate, entries = self._validate_manifest(manifest)
            stage_path = Path(tempfile.mkdtemp(prefix="homebrain-reachy-update-", dir=self.temp_parent))
            os.chmod(stage_path, 0o700)
            total = 0
            for entry in entries:
                path = entry["path"]
                expected_size = entry["size"]
                data, _ = fetch_limited(
                    self.config,
                    entry["downloadUrl"],
                    max_bytes=expected_size,
                    headers=self.headers,
                    timeout_s=self.timeout_s,
                    opener=self.opener,
                    allow_redirects=False,
                )
                if len(data) != expected_size:
                    raise PackageStageError(f"package file size mismatch: {path}")
                if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                    raise PackageStageError(f"package file checksum mismatch: {path}")
                total += len(data)
                if total > MAX_TOTAL_BYTES:
                    raise PackageStageError("package exceeded the aggregate size limit")
                self._write_file(stage_path, path, data)

            if manifest_aggregate_sha256(entries) != aggregate:
                raise PackageStageError("package aggregate checksum mismatch")
            self._write_internal_manifest(stage_path, manifest)
            self._validate_embedded_metadata(stage_path, version)
            if self.release_manager is not None:
                stage_path = self.release_manager.commit(
                    stage_path,
                    version=version,
                    aggregate_sha256=aggregate,
                    request_id=request_id,
                )
            completed = True
            return StagedPackage(stage_path, version, aggregate, len(entries), total)
        except (DownloadSecurityError, OSError, ReleaseError) as exc:
            if isinstance(exc, PackageStageError):
                raise
            raise PackageStageError(str(exc)) from exc
        finally:
            if stage_path is not None and not completed:
                shutil.rmtree(stage_path, ignore_errors=True)

    def _validate_manifest(self, manifest: Any) -> tuple[str, str, list[dict[str, Any]]]:
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
            raise PackageStageError("unsupported package manifest schema")
        if manifest.get("artifact") != "reachy-homebrain-app":
            raise PackageStageError("package artifact identity mismatch")
        compatibility = manifest.get("compatibility")
        if not isinstance(compatibility, dict):
            raise ManualReinstallRequired("manual_reinstall_required: compatibility metadata is missing")
        if (
            compatibility.get("launcherApi") != LAUNCHER_API
            or compatibility.get("dependencyFingerprint") != DEPENDENCY_FINGERPRINT
            or compatibility.get("launcherFingerprint") != LAUNCHER_FINGERPRINT
            or compatibility.get("requiresManualReinstall") is True
        ):
            raise ManualReinstallRequired("manual_reinstall_required: launcher or dependencies differ")
        version = manifest.get("version")
        if not isinstance(version, str) or not _VERSION_RE.fullmatch(version):
            raise PackageStageError("package version is invalid")
        aggregate = _sha256(manifest.get("aggregateSha256"), "aggregateSha256")
        files = manifest.get("files")
        if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
            raise PackageStageError("package manifest has an invalid file count")
        entries: list[dict[str, Any]] = []
        seen: set[str] = set()
        declared_total = 0
        for raw in files:
            if not isinstance(raw, dict):
                raise PackageStageError("package file entry must be an object")
            path = _safe_path(raw.get("path"))
            if path in seen:
                raise PackageStageError(f"duplicate package file: {path}")
            seen.add(path)
            size = raw.get("size")
            if isinstance(size, bool) or not isinstance(size, int) or not 0 <= size <= MAX_FILE_BYTES:
                raise PackageStageError(f"invalid package file size: {path}")
            declared_total += size
            if declared_total > MAX_TOTAL_BYTES:
                raise PackageStageError("package declared size exceeds the aggregate limit")
            download_url = raw.get("downloadUrl")
            if not isinstance(download_url, str) or not download_url:
                raise PackageStageError(f"download URL is missing: {path}")
            entries.append(
                {
                    "path": path,
                    "size": size,
                    "sha256": _sha256(raw.get("sha256"), f"sha256 for {path}"),
                    "downloadUrl": download_url,
                }
            )
        required = {"pyproject.toml", "artifact-manifest.json", "src/reachy_homebrain/app.py"}
        if not required.issubset(seen):
            raise PackageStageError("package manifest is missing required source files")
        return version, aggregate, entries

    def _write_file(self, root: Path, relative: str, data: bytes) -> None:
        target = root.joinpath(*PurePosixPath(relative).parts)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        parent = target.parent
        while parent != root:
            os.chmod(parent, 0o700)
            parent = parent.parent
        resolved_parent = target.parent.resolve()
        if root.resolve() not in {resolved_parent, *resolved_parent.parents}:
            raise PackageStageError("package path escaped the staging directory")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(target, flags, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        except Exception:
            with contextlib.suppress(OSError):
                os.close(descriptor)
            raise

    def _validate_embedded_metadata(self, root: Path, version: str) -> None:
        try:
            metadata = json.loads((root / "artifact-manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PackageStageError("embedded artifact metadata is invalid") from exc
        if metadata.get("artifact") != "reachy-homebrain-app" or metadata.get("version") != version:
            raise PackageStageError("embedded artifact version does not match package manifest")
        if metadata.get("compatibility") != {
            "launcherApi": LAUNCHER_API,
            "dependencyFingerprint": DEPENDENCY_FINGERPRINT,
            "launcherFingerprint": LAUNCHER_FINGERPRINT,
            "requiresManualReinstall": False,
        }:
            raise ManualReinstallRequired(
                "manual_reinstall_required: embedded launcher compatibility differs"
            )
        marker = root / ".homebrain-stage-complete"
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(version + "\n")

    @staticmethod
    def _write_internal_manifest(root: Path, manifest: dict[str, Any]) -> None:
        target = root / ".homebrain-package-manifest.json"
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _is_complete(path: Path) -> bool:
        return (path / ".homebrain-stage-complete").is_file()

    def _write_receipt(self, version: str, aggregate: str) -> None:
        if self.receipt_path is None:
            return
        self.receipt_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.receipt_path.parent, 0o700)
        temporary = self.receipt_path.with_name(f".{self.receipt_path.name}.{os.getpid()}")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(temporary, flags, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump({"version": version, "aggregateSha256": aggregate}, handle)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.receipt_path)
            os.chmod(self.receipt_path, 0o600)
        finally:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()

    @staticmethod
    def cleanup(path: str | Path) -> None:
        candidate = Path(path)
        if not candidate.name.startswith("homebrain-reachy-update-"):
            raise PackageStageError("refusing to clean a non-staging directory")
        shutil.rmtree(candidate, ignore_errors=True)
