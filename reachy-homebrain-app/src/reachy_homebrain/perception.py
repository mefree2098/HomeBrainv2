"""Bounded Wireless-only camera, presence, and local daemon controls."""

from __future__ import annotations

import contextlib
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .config import HomeBrainConfig
from .http_security import default_no_redirect_opener


class PerceptionError(RuntimeError):
    """A camera, presence, or local setting operation failed safely."""


MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024


class TrackingCoordinator:
    """Arbitrate all integration-owned uses of Reachy's single face tracker."""

    def __init__(self, robot: Any):
        self.robot = robot
        self._lock = threading.RLock()
        self._camera_enabled = False
        self._owners: dict[str, float] = {}
        self._applied_weight: float | None = None

    @property
    def active(self) -> bool:
        with self._lock:
            return bool(self._owners) and self._camera_enabled

    def configure_camera(self, enabled: bool) -> None:
        with self._lock:
            enabled = enabled is True
            if not enabled:
                self._owners.clear()
            self._camera_enabled = enabled
            self._reconcile()

    def request(self, owner: str, weight: float) -> None:
        with self._lock:
            if not self._camera_enabled:
                raise PerceptionError("camera access is disabled by HomeBrain privacy settings")
            self._owners[owner] = max(0.0, min(1.0, float(weight)))
            self._reconcile()

    def release(self, owner: str) -> None:
        with self._lock:
            self._owners.pop(owner, None)
            self._reconcile()

    def stop_all(self) -> None:
        """Clear every integration owner and stop the shared tracker for emergency stop."""

        with self._lock:
            self._owners.clear()
            if self._applied_weight is None:
                return
            stop = getattr(self.robot, "stop_head_tracking", None)
            if not callable(stop):
                raise PerceptionError("active face tracking could not be stopped")
            try:
                stop()
            except Exception as exc:
                # Keep the applied marker latched so another stop retries hardware.
                raise PerceptionError("active face tracking could not be stopped") from exc
            self._applied_weight = None

    def _reconcile(self) -> None:
        desired = max(self._owners.values()) if self._camera_enabled and self._owners else None
        if desired is None:
            if self._applied_weight is not None:
                stop = getattr(self.robot, "stop_head_tracking", None)
                if not callable(stop):
                    raise PerceptionError("active face tracking could not be stopped")
                try:
                    stop()
                except Exception as exc:
                    # Preserve the applied latch so a later OFF transition retries.
                    raise PerceptionError("active face tracking could not be stopped") from exc
            self._applied_weight = None
            return
        if self._applied_weight == desired:
            return
        start = getattr(self.robot, "start_head_tracking", None)
        if not callable(start):
            raise PerceptionError("presence tracking is unavailable")
        start(weight=desired)
        self._applied_weight = desired


class SnapshotService:
    """Capture one transient JPEG and upload it directly to HomeBrain."""

    def __init__(
        self,
        config: HomeBrainConfig,
        robot: Any,
        *,
        opener: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        minimum_interval_s: float = 2.0,
    ):
        self.config = config
        self.robot = robot
        self.opener = opener or default_no_redirect_opener()
        self.clock = clock
        self.minimum_interval_s = max(1.0, minimum_interval_s)
        self._last_capture = -1e9
        self._lock = threading.Lock()
        self._camera_enabled = False
        self._snapshot_enabled = False

    def configure(self, *, camera_enabled: bool, snapshot_enabled: bool) -> None:
        """Apply server-owned privacy gates; defaults remain fail-closed."""

        with self._lock:
            self._camera_enabled = camera_enabled is True
            self._snapshot_enabled = snapshot_enabled is True and self._camera_enabled

    def capture_and_upload(self, snapshot_id: str, quality: int) -> dict[str, Any]:
        # SDK v1.9 returns daemon-encoded JPEG; quality is validated by the command
        # boundary but cannot alter that encoder without wasteful CM4 re-encoding.
        if not 10 <= quality <= 95:
            raise PerceptionError("snapshot quality is out of range")
        if not isinstance(snapshot_id, str) or not 1 <= len(snapshot_id) <= 128:
            raise PerceptionError("snapshot id is invalid")
        with self._lock:
            # This check deliberately precedes clock access and camera SDK access.
            if not self._camera_enabled or not self._snapshot_enabled:
                raise PerceptionError("snapshot capture is disabled by HomeBrain privacy settings")
            now = self.clock()
            if now - self._last_capture < self.minimum_interval_s:
                raise PerceptionError("snapshot rate limit is active")
            getter = getattr(getattr(self.robot, "media", None), "get_frame_jpeg", None)
            if not callable(getter):
                raise PerceptionError("Reachy camera JPEG capture is unavailable")
            jpeg = getter()
            if not isinstance(jpeg, (bytes, bytearray, memoryview)):
                raise PerceptionError("Reachy camera returned no frame")
            data = bytes(jpeg)
            if not 4 <= len(data) <= MAX_SNAPSHOT_BYTES:
                raise PerceptionError("snapshot size is invalid")
            if not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
                raise PerceptionError("Reachy camera returned an invalid JPEG")
            captured_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            encoded_id = urllib.parse.quote(snapshot_id, safe="")
            url = (
                f"{self.config.http_base_url}/api/reachy-mini/"
                f"{urllib.parse.quote(self.config.device_id, safe='')}/snapshots/{encoded_id}"
            )
            request = urllib.request.Request(
                url,
                data=data,
                method="POST",
                headers={
                    **self.config.auth_headers(),
                    "Content-Type": "image/jpeg",
                    "Content-Length": str(len(data)),
                    "X-Reachy-Captured-At": captured_at,
                    "Accept": "application/json",
                },
            )
            try:
                with self.opener(request, timeout=15.0) as response:
                    raw = response.read(65_537)
            except urllib.error.HTTPError as exc:
                raise PerceptionError(f"snapshot upload rejected with HTTP {exc.code}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise PerceptionError("snapshot upload failed") from exc
            if len(raw) > 65_536:
                raise PerceptionError("snapshot response exceeded the safety limit")
            try:
                result = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PerceptionError("snapshot upload returned invalid JSON") from exc
            snapshot = result.get("snapshot") if isinstance(result, dict) else None
            if result.get("success") is not True or not isinstance(snapshot, dict):
                raise PerceptionError("snapshot upload was not accepted")
            if snapshot.get("id") != snapshot_id or snapshot.get("contentType") != "image/jpeg":
                raise PerceptionError("snapshot response metadata mismatch")
            response_bytes = snapshot.get("bytes")
            if response_bytes != len(data):
                raise PerceptionError("snapshot response size mismatch")
            self._last_capture = now
            return {
                "snapshot": {
                    "id": snapshot_id,
                    "bytes": len(data),
                    "contentType": "image/jpeg",
                    "expiresAt": snapshot.get("expiresAt"),
                    "capturedAt": captured_at,
                    "qualityRequested": quality,
                }
            }


class LocalVolumeService:
    """Use only the loopback Reachy daemon's bounded volume endpoints."""

    def __init__(self, robot: Any, *, opener: Callable[..., Any] = urllib.request.urlopen):
        self.robot = robot
        self.opener = opener

    def set(self, kind: str, volume: int) -> dict[str, Any]:
        if kind not in {"speaker", "microphone"} or not 0 <= volume <= 100:
            raise PerceptionError("volume request is invalid")
        client = getattr(self.robot, "client", None)
        port = int(getattr(client, "port", 8000))
        suffix = "/api/volume/set" if kind == "speaker" else "/api/volume/microphone/set"
        url = f"http://127.0.0.1:{port}{suffix}"
        body = json.dumps({"volume": volume}).encode()
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener(request, timeout=5.0) as response:
                raw = response.read(65_537)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            raise PerceptionError(f"Reachy {kind} volume control failed") from exc
        if len(raw) > 65_536:
            raise PerceptionError("Reachy volume response exceeded the safety limit")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PerceptionError("Reachy volume response was invalid") from exc
        if not isinstance(value, dict) or value.get("volume") != volume:
            raise PerceptionError("Reachy did not confirm the requested volume")
        return {"kind": kind, "volume": volume}


@dataclass(slots=True)
class PresenceState:
    present: bool = False
    confidence: float | None = None
    changed_at: float = 0.0


class PresenceMonitor:
    """Own low-weight tracking only while privacy configuration enables presence."""

    def __init__(
        self,
        robot: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        debounce_s: float = 0.75,
        tracking: TrackingCoordinator | None = None,
    ):
        self.robot = robot
        self.clock = clock
        self.debounce_s = max(0.25, debounce_s)
        self.tracking = tracking or TrackingCoordinator(robot)
        if tracking is None:
            self.tracking.configure_camera(True)
        self.enabled = False
        self._candidate: bool | None = None
        self._candidate_since = 0.0
        self.state = PresenceState(changed_at=self.clock())

    def configure(self, enabled: bool, *, tracker_already_active: bool = False) -> None:
        del tracker_already_active
        if enabled == self.enabled:
            return
        self.enabled = enabled
        if enabled:
            self.tracking.request("presence", 0.01)
        else:
            self.tracking.release("presence")
            self._candidate = None

    def poll(self) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        getter = getattr(self.robot, "get_tracked_face", None)
        if not callable(getter):
            return None
        try:
            face = getter(wait=False)
        except Exception:
            return None
        present = bool(face is not None and getattr(face, "detected", False))
        confidence: float | None = None
        confidence_raw = getattr(face, "confidence", None)
        if confidence_raw is not None:
            try:
                confidence = max(0.0, min(1.0, float(confidence_raw)))
            except (TypeError, ValueError):
                confidence = None
        now = self.clock()
        if present == self.state.present:
            self._candidate = None
            self.state.confidence = confidence
            return None
        if self._candidate != present:
            self._candidate = present
            self._candidate_since = now
            return None
        if now - self._candidate_since < self.debounce_s:
            return None
        self.state = PresenceState(present, confidence, now)
        self._candidate = None
        change: dict[str, Any] = {"present": present}
        if confidence is not None:
            change["confidence"] = confidence
        return change

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.tracking.release("presence")
        self.enabled = False

    def emergency_stop(self) -> None:
        """Require an explicit later configuration re-arm after a physical stop."""

        self.enabled = False
        self._candidate = None
        self.tracking.release("presence")
