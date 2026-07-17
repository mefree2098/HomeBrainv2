"""Stable launcher support for immutable, verified external runtime releases."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from .launcher_constants import DEPENDENCY_FINGERPRINT, LAUNCHER_API, LAUNCHER_FINGERPRINT


class ReleaseError(RuntimeError):
    """Release state or an immutable release directory is invalid."""


@dataclass(frozen=True, slots=True)
class ActiveRelease:
    path: Path | None
    release_id: str | None
    version: str
    aggregate_sha256: str | None
    bundled: bool
    pending: bool
    attempt_id: str | None


_DIGEST_RE = re.compile(r"^[a-f0-9]{64}$")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$")
_METADATA_FILES = frozenset({".homebrain-package-manifest.json", ".homebrain-stage-complete"})
_BUNDLED_RELEASE_ID = "@installed-bundle"


def manifest_aggregate_sha256(entries: list[dict[str, Any]]) -> str:
    """Hash the cross-language manifest stream in unsigned UTF-8 byte order."""

    aggregate = hashlib.sha256()
    for entry in sorted(entries, key=lambda value: value["path"].encode("utf-8")):
        aggregate.update(entry["path"].encode("utf-8"))
        aggregate.update(b"\x00")
        aggregate.update(str(entry["size"]).encode("ascii"))
        aggregate.update(b"\x00")
        aggregate.update(entry["sha256"].encode("ascii"))
        aggregate.update(b"\n")
    return aggregate.hexdigest()


class ReleaseManager:
    """Commit immutable source and switch pending/active pointers atomically.

    Every state transition is serialized by an advisory lock. A package is first
    copied into the release filesystem, fully synced and verified, and only then
    renamed into its content-addressed final path. Merely staging a package never
    makes it a boot candidate: ``prepare_update`` must approve the exact request.
    """

    def __init__(self, data_root: str | Path | None = None):
        self.data_root = Path(data_root or (Path.home() / ".local/share/homebrain-reachy"))
        self.releases_dir = self.data_root / "releases"
        self.state_path = self.data_root / "release-state.json"
        self.lock_path = self.data_root / ".release.lock"

    @staticmethod
    def release_id(version: str, digest: str) -> str:
        del version
        if not _DIGEST_RE.fullmatch(digest):
            raise ReleaseError("release aggregate digest is invalid")
        return digest

    def ensure_dirs(self) -> None:
        if self.data_root.is_symlink() or self.releases_dir.is_symlink():
            raise ReleaseError("release storage path is unsafe")
        self.releases_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not self.data_root.is_dir() or not self.releases_dir.is_dir():
            raise ReleaseError("release storage path is invalid")
        os.chmod(self.data_root, 0o700)
        os.chmod(self.releases_dir, 0o700)

    # Kept as an alias for older bundled runtimes that called this private helper.
    _ensure_dirs = ensure_dirs

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self.ensure_dirs()
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(self.lock_path, flags, 0o600)
        except OSError as exc:
            raise ReleaseError("release lock path is unsafe") from exc
        try:
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @staticmethod
    def _empty_state() -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "active": None,
            "previous": None,
            "pending": None,
            "releases": {},
            "stagedRequests": {},
            "bundled": None,
        }

    def _load_unlocked(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return self._empty_state()
        if self.state_path.is_symlink() or not self.state_path.is_file():
            raise ReleaseError("release state path is unsafe")
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # A torn state must not make unverified code executable.
            quarantine = self.state_path.with_name(
                f"release-state.corrupt-{int(time.time())}-{uuid.uuid4().hex}.json"
            )
            with suppress(OSError):
                os.replace(self.state_path, quarantine)
            return self._empty_state()
        if not isinstance(state, dict) or state.get("schemaVersion") != 1:
            return self._empty_state()
        if not isinstance(state.get("releases", {}), dict):
            return self._empty_state()
        if not isinstance(state.get("stagedRequests", {}), dict):
            state["stagedRequests"] = {}
        return state

    def _save_unlocked(self, state: dict[str, Any]) -> None:
        descriptor, temporary = tempfile.mkstemp(prefix=".release-state.", dir=self.data_root)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(state, handle, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.state_path)
            temporary = ""
            os.chmod(self.state_path, 0o600)
            self._fsync_directory(self.data_root)
        finally:
            if temporary:
                with suppress(FileNotFoundError):
                    os.unlink(temporary)

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def commit(
        self,
        staged: Path,
        *,
        version: str,
        aggregate_sha256: str,
        request_id: str | None = None,
    ) -> Path:
        """Commit verified source without changing the running/next runtime pointer."""

        staged = Path(staged)
        if not _VERSION_RE.fullmatch(version):
            raise ReleaseError("release version is invalid")
        if not _DIGEST_RE.fullmatch(aggregate_sha256):
            raise ReleaseError("release aggregate digest is invalid")
        if request_id is not None and not _REQUEST_ID_RE.fullmatch(request_id):
            raise ReleaseError("release request id is invalid")
        if not self._verify_release(staged, aggregate_sha256, immutable=False):
            raise ReleaseError("staged release failed verification")

        release_id = self.release_id(version, aggregate_sha256)
        with self._locked():
            state = self._load_unlocked()
            if request_id is not None:
                existing_request = state.get("stagedRequests", {}).get(request_id)
                if isinstance(existing_request, dict) and (
                    existing_request.get("version") != version
                    or existing_request.get("aggregateSha256") != aggregate_sha256
                ):
                    raise ReleaseError("release request id was reused for different content")
            target = self.releases_dir / release_id
            if target.exists():
                if not self._verify_release(target, aggregate_sha256, immutable=True):
                    raise ReleaseError("existing immutable release is unsafe")
            else:
                incoming = self.releases_dir / f".incoming-{release_id}-{uuid.uuid4().hex}"
                try:
                    # Copying into the destination filesystem before rename works even
                    # when the downloader staged on another mount (EXDEV-safe).
                    shutil.copytree(staged, incoming, symlinks=True, copy_function=shutil.copy2)
                    self._freeze_and_sync_tree(incoming)
                    if not self._verify_release(incoming, aggregate_sha256, immutable=True):
                        raise ReleaseError("copied release failed immutable verification")
                    os.replace(incoming, target)
                    self._fsync_directory(self.releases_dir)
                finally:
                    if incoming.exists():
                        self._make_removable(incoming)
                        shutil.rmtree(incoming, ignore_errors=True)

            releases = dict(state.get("releases", {}))
            releases[release_id] = {
                "version": version,
                "aggregateSha256": aggregate_sha256,
                "launcherApi": LAUNCHER_API,
                "dependencyFingerprint": DEPENDENCY_FINGERPRINT,
                "launcherFingerprint": LAUNCHER_FINGERPRINT,
            }
            state["releases"] = releases
            if request_id is not None:
                staged_requests = dict(state.get("stagedRequests", {}))
                staged_requests[request_id] = {
                    "releaseId": release_id,
                    "version": version,
                    "aggregateSha256": aggregate_sha256,
                    "stagedAt": int(time.time()),
                }
                # Bound durable request metadata without deleting any live approval.
                ordered = sorted(
                    staged_requests.items(),
                    key=lambda item: int(item[1].get("stagedAt", 0)),
                    reverse=True,
                )
                state["stagedRequests"] = dict(ordered[:64])
            self._save_unlocked(state)

        self._make_removable(staged)
        shutil.rmtree(staged, ignore_errors=True)
        return target

    def prepare_update(
        self,
        request_id: str,
        version: str,
        aggregate_sha256: str,
    ) -> dict[str, Any]:
        """Arm exactly the source package approved by a prior stage request."""

        if not _REQUEST_ID_RE.fullmatch(request_id):
            raise ReleaseError("release request id is invalid")
        if not _VERSION_RE.fullmatch(version) or not _DIGEST_RE.fullmatch(aggregate_sha256):
            raise ReleaseError("prepared release identity is invalid")
        with self._locked():
            state = self._load_unlocked()
            staged = state.get("stagedRequests", {}).get(request_id)
            if not isinstance(staged, dict):
                raise ReleaseError("prepare_update does not match a staged request")
            if staged.get("version") != version or staged.get("aggregateSha256") != aggregate_sha256:
                raise ReleaseError("prepare_update release identity does not match staged package")
            release_id = staged.get("releaseId")
            release = state.get("releases", {}).get(release_id)
            if not isinstance(release, dict):
                raise ReleaseError("requested staged release is unknown")
            if not self._verify_release(self.releases_dir / str(release_id), aggregate_sha256):
                raise ReleaseError("staged release failed pre-activation verification")
            existing = state.get("pending")
            if isinstance(existing, dict) and int(existing.get("expiresAt", 0)) < int(time.time()):
                state["lastFailedPending"] = existing
                state["pending"] = None
                existing = None
                self._save_unlocked(state)
            if (
                isinstance(existing, dict)
                and existing.get("aggregateSha256") == aggregate_sha256
                and existing.get("requestId") == request_id
                and existing.get("version") == version
            ):
                return dict(existing)
            if isinstance(existing, dict):
                raise ReleaseError("another prepared release is already pending")
            state["pending"] = {
                "requestId": request_id,
                "releaseId": release_id,
                "version": version,
                "aggregateSha256": aggregate_sha256,
                "attempts": 0,
                "attemptId": uuid.uuid4().hex,
                "expiresAt": int(time.time()) + 900,
                "launchReady": False,
            }
            self._save_unlocked(state)
            return dict(state["pending"])

    def activate_pending(self, aggregate_sha256: str) -> dict[str, Any]:
        """Legacy API intentionally disabled: approval must bind the stage request."""

        del aggregate_sha256
        raise ReleaseError("prepare_update requires requestId, version, and aggregateSha256")

    def authorize_launch(
        self,
        request_id: str,
        version: str,
        aggregate_sha256: str,
    ) -> dict[str, Any]:
        """Durably make an exact prepared release launchable immediately before release."""

        if not _REQUEST_ID_RE.fullmatch(request_id):
            raise ReleaseError("release authorization request id is invalid")
        if not _VERSION_RE.fullmatch(version) or not _DIGEST_RE.fullmatch(aggregate_sha256):
            raise ReleaseError("release authorization identity is invalid")
        with self._locked():
            state = self._load_unlocked()
            pending = state.get("pending")
            if (
                not isinstance(pending, dict)
                or pending.get("requestId") != request_id
                or pending.get("version") != version
                or pending.get("aggregateSha256") != aggregate_sha256
                or int(pending.get("attempts", 0)) != 0
            ):
                raise ReleaseError("release authorization does not match the prepared runtime")
            if not self._verify_release(self.releases_dir / str(pending.get("releaseId")), aggregate_sha256):
                raise ReleaseError("prepared release failed authorization verification")
            changed = False
            if pending.get("launchReady") is not True:
                pending["launchReady"] = True
                state["pending"] = pending
                changed = True
            authorized = state.get("lastAuthorized")
            if not (
                isinstance(authorized, dict)
                and authorized.get("requestId") == request_id
                and authorized.get("version") == version
                and authorized.get("aggregateSha256") == aggregate_sha256
            ):
                state["lastAuthorized"] = {
                    "requestId": request_id,
                    "version": version,
                    "aggregateSha256": aggregate_sha256,
                    "authorizedAt": int(time.time()),
                }
                changed = True
            if changed:
                self._save_unlocked(state)
            return dict(pending)

    def prepare_launch(self, *, bundled_version: str) -> ActiveRelease:
        """Try pending once; a second process automatically falls back to active LKG."""

        with self._locked():
            state = self._load_unlocked()
            self._record_bundled_identity_unlocked(state, bundled_version)
            pending = state.get("pending")
            selected_id: str | None = None
            pending_launch = False
            attempt_id: str | None = None
            if isinstance(pending, dict):
                expired = int(pending.get("expiresAt", 0)) < int(time.time())
                launch_ready = pending.get("launchReady") is True
                if expired or (launch_ready and int(pending.get("attempts", 0)) >= 1):
                    state["lastFailedPending"] = pending
                    state["pending"] = None
                    self._save_unlocked(state)
                elif launch_ready:
                    selected_id = str(pending.get("releaseId"))
                    attempt_id = str(pending.get("attemptId"))
                    pending["attempts"] = 1
                    state["pending"] = pending
                    self._save_unlocked(state)  # durable before importing new source
                    pending_launch = True
            if selected_id is None:
                active = state.get("active")
                selected_id = str(active) if active else None
            if selected_id == _BUNDLED_RELEASE_ID:
                bundled = state.get("bundled")
                aggregate = bundled.get("aggregateSha256") if isinstance(bundled, dict) else None
                return ActiveRelease(
                    None,
                    _BUNDLED_RELEASE_ID,
                    bundled_version,
                    aggregate if isinstance(aggregate, str) else None,
                    True,
                    False,
                    None,
                )
            if selected_id is None:
                return ActiveRelease(None, None, bundled_version, None, True, False, None)
            release = state.get("releases", {}).get(selected_id)
            if not isinstance(release, dict):
                return ActiveRelease(None, None, bundled_version, None, True, False, None)
            aggregate = str(release.get("aggregateSha256"))
            path = self.releases_dir / selected_id
            if not self._verify_release(path, aggregate):
                if pending_launch:
                    state["lastFailedPending"] = state.get("pending")
                    state["pending"] = None
                    self._save_unlocked(state)
                return ActiveRelease(None, None, bundled_version, None, True, False, None)
            return ActiveRelease(
                path,
                selected_id,
                str(release.get("version")),
                aggregate,
                False,
                pending_launch,
                attempt_id if pending_launch else None,
            )

    def mark_healthy(self, aggregate_sha256: str | None, attempt_id: str | None = None) -> None:
        if not aggregate_sha256:
            return
        with self._locked():
            state = self._load_unlocked()
            pending = state.get("pending")
            if (
                not isinstance(pending, dict)
                or pending.get("aggregateSha256") != aggregate_sha256
                or pending.get("attemptId") != attempt_id
                or pending.get("attempts") != 1
            ):
                return
            state["previous"] = state.get("active") or _BUNDLED_RELEASE_ID
            state["active"] = pending.get("releaseId")
            state["pending"] = None
            state["lastHealthy"] = aggregate_sha256
            self._save_unlocked(state)

    def confirm_update(
        self,
        request_id: str,
        version: str,
        aggregate_sha256: str,
        attempt_id: str | None,
    ) -> dict[str, Any]:
        """Promote only the exact pending runtime that is executing this launcher attempt."""

        if not _REQUEST_ID_RE.fullmatch(request_id):
            raise ReleaseError("confirmation request id is invalid")
        if not _VERSION_RE.fullmatch(version) or not _DIGEST_RE.fullmatch(aggregate_sha256):
            raise ReleaseError("confirmation release identity is invalid")
        with self._locked():
            state = self._load_unlocked()
            confirmed = state.get("lastConfirmed")
            if (
                isinstance(confirmed, dict)
                and confirmed.get("requestId") == request_id
                and confirmed.get("version") == version
                and confirmed.get("aggregateSha256") == aggregate_sha256
                and state.get("active") == confirmed.get("releaseId")
                and self._verify_release(
                    self.releases_dir / str(confirmed.get("releaseId")),
                    aggregate_sha256,
                )
            ):
                return self._report_unlocked(state)
            pending = state.get("pending")
            if (
                not isinstance(pending, dict)
                or pending.get("requestId") != request_id
                or pending.get("version") != version
                or pending.get("aggregateSha256") != aggregate_sha256
                or pending.get("attemptId") != attempt_id
                or pending.get("attempts") != 1
            ):
                raise ReleaseError("confirmation does not match the running pending release")
            release_id = str(pending.get("releaseId"))
            if not self._verify_release(self.releases_dir / release_id, aggregate_sha256):
                raise ReleaseError("running release failed confirmation verification")
            state["previous"] = state.get("active") or _BUNDLED_RELEASE_ID
            state["active"] = release_id
            state["pending"] = None
            state["lastHealthy"] = aggregate_sha256
            state["lastConfirmed"] = {
                "requestId": request_id,
                "releaseId": release_id,
                "version": version,
                "aggregateSha256": aggregate_sha256,
                "confirmedAt": int(time.time()),
            }
            self._save_unlocked(state)
            return self._report_unlocked(state)

    def rollback(
        self,
        request_id: str,
        version: str,
        aggregate_sha256: str,
    ) -> dict[str, Any]:
        if not _REQUEST_ID_RE.fullmatch(request_id):
            raise ReleaseError("rollback request id is invalid")
        if not _VERSION_RE.fullmatch(version) or not _DIGEST_RE.fullmatch(aggregate_sha256):
            raise ReleaseError("rollback target identity is invalid")
        with self._locked():
            state = self._load_unlocked()
            last = state.get("lastRollback")
            if (
                isinstance(last, dict)
                and last.get("requestId") == request_id
                and last.get("version") == version
                and last.get("aggregateSha256") == aggregate_sha256
            ):
                return self._report_unlocked(state)
            pending = state.get("pending")
            if isinstance(pending, dict):
                if pending.get("requestId") != request_id:
                    raise ReleaseError("rollback does not match the prepared update request")
                target_id = state.get("active")
            else:
                target_id = state.get("previous")
            target = state.get("releases", {}).get(target_id) if target_id else None
            if target_id == _BUNDLED_RELEASE_ID:
                bundled = state.get("bundled")
                if (
                    not isinstance(bundled, dict)
                    or bundled.get("version") != version
                    or bundled.get("aggregateSha256") != aggregate_sha256
                ):
                    raise ReleaseError("rollback target does not match the installed bundled release")
            elif target_id is not None:
                if (
                    not isinstance(target, dict)
                    or target.get("version") != version
                    or target.get("aggregateSha256") != aggregate_sha256
                    or not self._verify_release(self.releases_dir / str(target_id), aggregate_sha256)
                ):
                    raise ReleaseError("rollback target does not match the expected previous release")
            elif not isinstance(pending, dict):
                raise ReleaseError("rollback target does not match the expected previous release")
            if isinstance(pending, dict):
                state["lastFailedPending"] = pending
                state["pending"] = None
            elif state.get("previous") is not None:
                state["active"], state["previous"] = state.get("previous"), state.get("active")
            state["lastRollback"] = {
                "requestId": request_id,
                "releaseId": target_id,
                "version": version,
                "aggregateSha256": aggregate_sha256,
                "rolledBackAt": int(time.time()),
            }
            self._save_unlocked(state)
            return self._report_unlocked(state)

    def report(self) -> dict[str, Any]:
        with self._locked():
            return self._report_unlocked(self._load_unlocked())

    @staticmethod
    def _report_unlocked(state: dict[str, Any]) -> dict[str, Any]:
        pending_raw = state.get("pending")
        pending = (
            {
                key: pending_raw.get(key)
                for key in (
                    "requestId",
                    "version",
                    "aggregateSha256",
                    "attempts",
                    "expiresAt",
                    "launchReady",
                )
            }
            if isinstance(pending_raw, dict)
            else None
        )

        def valid_staged(item: tuple[Any, Any]) -> bool:
            request_id, value = item
            return bool(
                isinstance(request_id, str)
                and _REQUEST_ID_RE.fullmatch(request_id)
                and isinstance(value, dict)
                and isinstance(value.get("version"), str)
                and _VERSION_RE.fullmatch(value["version"])
                and isinstance(value.get("aggregateSha256"), str)
                and _DIGEST_RE.fullmatch(value["aggregateSha256"])
                and isinstance(value.get("stagedAt"), int)
                and not isinstance(value.get("stagedAt"), bool)
                and value["stagedAt"] >= 0
            )

        staged_raw = state.get("stagedRequests")
        staged_items = (
            sorted(
                filter(valid_staged, staged_raw.items()),
                key=lambda item: (-item[1]["stagedAt"], item[0].encode("utf-8")),
            )[:64]
            if isinstance(staged_raw, dict)
            else []
        )
        staged_requests = {
            request_id: {
                "version": value.get("version"),
                "aggregateSha256": value.get("aggregateSha256"),
                "stagedAt": value.get("stagedAt"),
            }
            for request_id, value in staged_items
        }
        last_staged = (
            {"requestId": staged_items[0][0], **staged_requests[staged_items[0][0]]} if staged_items else None
        )
        confirmed_raw = state.get("lastConfirmed")
        last_confirmed = (
            {
                key: confirmed_raw.get(key)
                for key in ("requestId", "version", "aggregateSha256", "confirmedAt")
            }
            if isinstance(confirmed_raw, dict)
            and valid_staged(
                (
                    confirmed_raw.get("requestId"),
                    {
                        "version": confirmed_raw.get("version"),
                        "aggregateSha256": confirmed_raw.get("aggregateSha256"),
                        "stagedAt": confirmed_raw.get("confirmedAt"),
                    },
                )
            )
            else None
        )
        authorized_raw = state.get("lastAuthorized")
        last_authorized = None
        if isinstance(authorized_raw, dict) and valid_staged(
            (
                authorized_raw.get("requestId"),
                {
                    "version": authorized_raw.get("version"),
                    "aggregateSha256": authorized_raw.get("aggregateSha256"),
                    "stagedAt": authorized_raw.get("authorizedAt"),
                },
            )
        ):
            authorized_matches_pending = (
                isinstance(pending_raw, dict)
                and pending_raw.get("requestId") == authorized_raw.get("requestId")
                and pending_raw.get("version") == authorized_raw.get("version")
                and pending_raw.get("aggregateSha256") == authorized_raw.get("aggregateSha256")
                and pending_raw.get("launchReady") is True
            )
            last_authorized = {
                key: authorized_raw.get(key)
                for key in ("requestId", "version", "aggregateSha256", "authorizedAt")
            }
            last_authorized["launchReady"] = authorized_matches_pending
        receipts = {
            "pending": pending,
            "lastConfirmed": last_confirmed,
            "lastStaged": last_staged,
            "stagedRequests": staged_requests,
            "lastAuthorized": last_authorized,
        }
        active_id = state.get("active")
        if active_id == _BUNDLED_RELEASE_ID:
            bundled = state.get("bundled")
            if isinstance(bundled, dict):
                return {
                    "version": bundled.get("version"),
                    "aggregateSha256": bundled.get("aggregateSha256"),
                    "provenance": "installed-bundle",
                    **receipts,
                }
        release = state.get("releases", {}).get(active_id) if active_id else None
        if not isinstance(release, dict):
            return {"version": None, "aggregateSha256": None, **receipts}
        return {
            "version": release.get("version"),
            "aggregateSha256": release.get("aggregateSha256"),
            "provenance": "external-release",
            **receipts,
        }

    def _record_bundled_identity_unlocked(self, state: dict[str, Any], bundled_version: str) -> None:
        """Persist the verified install receipt so bundled rollback is representable."""

        aggregate: str | None = None
        receipt_path = self.data_root / "installed-receipt.json"
        try:
            if receipt_path.is_symlink() or not receipt_path.is_file():
                raise OSError("installed receipt is unavailable")
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            candidate = receipt.get("aggregateSha256") if isinstance(receipt, dict) else None
            if receipt.get("version") == bundled_version and isinstance(candidate, str):
                candidate = candidate.lower()
                if _DIGEST_RE.fullmatch(candidate):
                    aggregate = candidate
        except (OSError, json.JSONDecodeError, AttributeError):
            aggregate = None
        identity = {"version": bundled_version, "aggregateSha256": aggregate}
        if state.get("bundled") != identity:
            state["bundled"] = identity
            self._save_unlocked(state)

    def _verify_release(
        self,
        root: Path,
        expected_aggregate: str,
        *,
        immutable: bool = True,
    ) -> bool:
        try:
            root = Path(root)
            if root.is_symlink() or not root.is_dir() or not _DIGEST_RE.fullmatch(expected_aggregate):
                return False
            manifest_path = root / ".homebrain-package-manifest.json"
            if manifest_path.is_symlink() or not manifest_path.is_file():
                return False
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if (
                not isinstance(manifest, dict)
                or manifest.get("schemaVersion") != 1
                or manifest.get("artifact") != "reachy-homebrain-app"
                or str(manifest.get("aggregateSha256", "")).lower() != expected_aggregate
            ):
                return False
            compatibility = manifest.get("compatibility")
            if compatibility != {
                "launcherApi": LAUNCHER_API,
                "dependencyFingerprint": DEPENDENCY_FINGERPRINT,
                "launcherFingerprint": LAUNCHER_FINGERPRINT,
                "requiresManualReinstall": False,
            }:
                return False
            entries = manifest.get("files")
            if not isinstance(entries, list) or not entries:
                return False
            declared: set[str] = set()
            normalized: list[dict[str, Any]] = []
            for entry in entries:
                if not isinstance(entry, dict):
                    return False
                raw_path = entry.get("path")
                if not isinstance(raw_path, str) or "\\" in raw_path or "\x00" in raw_path:
                    return False
                relative = PurePosixPath(raw_path)
                if (
                    relative.is_absolute()
                    or any(part in {"", ".", ".."} for part in relative.parts)
                    or relative.as_posix() in declared
                ):
                    return False
                size = entry.get("size")
                digest = str(entry.get("sha256", "")).removeprefix("sha256:").lower()
                if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                    return False
                if not _DIGEST_RE.fullmatch(digest):
                    return False
                path = root.joinpath(*relative.parts)
                if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
                    return False
                if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    return False
                declared.add(relative.as_posix())
                normalized.append({"path": relative.as_posix(), "size": size, "sha256": digest})
            required = {
                "pyproject.toml",
                "artifact-manifest.json",
                "src/reachy_homebrain/app.py",
            }
            if not required.issubset(declared):
                return False
            if manifest_aggregate_sha256(normalized) != expected_aggregate:
                return False
            files, directories, safe_modes = self._inventory(root, immutable=immutable)
            if not safe_modes or files != declared | _METADATA_FILES:
                return False
            expected_directories = {"."}
            for filename in files:
                parent = PurePosixPath(filename).parent
                while parent.as_posix() != ".":
                    expected_directories.add(parent.as_posix())
                    parent = parent.parent
            return directories == expected_directories
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return False

    @staticmethod
    def _inventory(root: Path, *, immutable: bool) -> tuple[set[str], set[str], bool]:
        files: set[str] = set()
        directories: set[str] = {"."}
        safe = True
        expected_file_mode = 0o400 if immutable else 0o600
        expected_dir_mode = 0o500 if immutable else 0o700
        if stat.S_IMODE(root.stat().st_mode) != expected_dir_mode:
            safe = False

        def visit(directory: Path, relative: PurePosixPath) -> None:
            nonlocal safe
            with os.scandir(directory) as iterator:
                for entry in iterator:
                    child_relative = relative / entry.name
                    name = child_relative.as_posix()
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        safe = False
                    elif stat.S_ISDIR(info.st_mode):
                        directories.add(name)
                        if stat.S_IMODE(info.st_mode) != expected_dir_mode:
                            safe = False
                        visit(Path(entry.path), child_relative)
                    elif stat.S_ISREG(info.st_mode):
                        files.add(name)
                        if stat.S_IMODE(info.st_mode) != expected_file_mode:
                            safe = False
                    else:
                        safe = False

        visit(root, PurePosixPath())
        return files, directories, safe

    @classmethod
    def _freeze_and_sync_tree(cls, root: Path) -> None:
        directories: list[Path] = []
        for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
            directory = Path(current)
            directories.append(directory)
            for name in dirnames:
                path = directory / name
                if path.is_symlink():
                    raise ReleaseError("release contains a symbolic-link directory")
            for name in filenames:
                path = directory / name
                if path.is_symlink() or not path.is_file():
                    raise ReleaseError("release contains an unsafe file")
                os.chmod(path, 0o400)
                descriptor = os.open(path, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        for directory in reversed(directories):
            cls._fsync_directory(directory)
            os.chmod(directory, 0o500)

    @staticmethod
    def _make_removable(root: Path) -> None:
        if not root.exists() or root.is_symlink():
            return
        for current, dirnames, filenames in os.walk(root, topdown=False, followlinks=False):
            del filenames
            for name in dirnames:
                path = Path(current) / name
                if not path.is_symlink():
                    with suppress(OSError):
                        os.chmod(path, 0o700)
        with suppress(OSError):
            os.chmod(root, 0o700)
