"""Cancellable loopback motion transport for the Reachy Mini 1.9 daemon."""

from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.request
import uuid as uuid_module
from collections.abc import Callable
from typing import Any

import numpy as np

from .http_security import default_no_redirect_opener


class MotionError(RuntimeError):
    """The local daemon could not safely execute or cancel a motion."""


class MotionCancelled(MotionError):
    """The current motion was cancelled through the daemon task API."""


class LocalMotionService:
    """Run motions as daemon tasks whose UUIDs can be cancelled by emergency stop."""

    def __init__(
        self,
        robot: Any,
        *,
        opener: Callable[..., Any] | None = None,
        event_connector: Callable[[str], Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
        poll_interval_s: float = 0.05,
    ):
        port = int(getattr(getattr(robot, "client", None), "port", 0))
        if not 1 <= port <= 65_535:
            raise MotionError("Reachy daemon loopback port is unavailable")
        self.base_url = f"http://127.0.0.1:{port}/api/move"
        self.events_url = f"ws://127.0.0.1:{port}/api/move/ws/updates"
        self.opener = opener or default_no_redirect_opener()
        self.event_connector = event_connector or self._default_event_connector
        self.clock = clock
        self.sleeper = sleeper
        self.poll_interval_s = max(0.01, min(0.25, poll_interval_s))
        self._lock = threading.RLock()
        self._admission_lock = threading.Lock()
        self._generation = 0
        self._active_uuid: str | None = None

    def goto(
        self,
        *,
        head: np.ndarray | None = None,
        antennas: np.ndarray | list[float] | None = None,
        body_yaw: float | None = None,
        duration: float,
        token: int | None = None,
    ) -> dict[str, Any]:
        if not 0.1 <= duration <= 5.0:
            raise MotionError("cancellable motion duration must be between 0.1 and 5 seconds")
        if head is None and antennas is None and body_yaw is None:
            raise MotionError("cancellable motion requires a target")
        payload: dict[str, Any] = {"duration": float(duration)}
        if head is not None:
            pose = np.asarray(head, dtype=np.float64)
            if pose.shape != (4, 4) or not np.isfinite(pose).all():
                raise MotionError("head target must be a finite 4x4 pose")
            payload["head_pose"] = {"m": pose.flatten().tolist()}
        if antennas is not None:
            values = np.asarray(antennas, dtype=np.float64).flatten()
            if values.shape != (2,) or not np.isfinite(values).all():
                raise MotionError("antenna target must contain two finite radians")
            payload["antennas"] = values.tolist()
        if body_yaw is not None:
            if not math.isfinite(float(body_yaw)):
                raise MotionError("body yaw must be finite")
            payload["body_yaw"] = float(body_yaw)
        return self._run("/goto", payload, timeout_s=duration + 2.0, token=token)

    def wake(self, *, token: int | None = None) -> dict[str, Any]:
        return self._run("/play/wake_up", {}, timeout_s=8.0, token=token)

    def sleep(self, *, token: int | None = None) -> dict[str, Any]:
        return self._run("/play/goto_sleep", {}, timeout_s=8.0, token=token)

    def admit(self) -> int:
        with self._lock:
            return self._generation

    def invalidate(self) -> int:
        with self._lock:
            self._generation += 1
            return self._generation

    def stop(self) -> dict[str, Any]:
        self.invalidate()
        # An admission POST is immediate, but the lock closes the race where stop
        # arrived after daemon task creation and before its UUID was registered.
        if not self._admission_lock.acquire(timeout=5.5):
            raise MotionError("timed out waiting to identify the in-flight daemon motion")
        try:
            with self._lock:
                active = self._active_uuid
            if active is None:
                return {"cancelled": False, "uuid": None}
            self._stop_uuid(active)
            with self._lock:
                if self._active_uuid == active:
                    self._active_uuid = None
            return {"cancelled": True, "uuid": active}
        finally:
            self._admission_lock.release()

    def _run(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        timeout_s: float,
        token: int | None,
    ) -> dict[str, Any]:
        generation = self.admit() if token is None else token
        with self.event_connector(self.events_url) as events:
            with self._admission_lock:
                with self._lock:
                    if self._active_uuid is not None:
                        raise MotionError("an unresolved daemon motion requires a confirmed emergency stop")
                    if generation != self._generation:
                        raise MotionCancelled("motion was cancelled before daemon admission")
                response = self._request("POST", path, payload)
                move_uuid = response.get("uuid") if isinstance(response, dict) else None
                try:
                    move_uuid = str(uuid_module.UUID(str(move_uuid)))
                except (ValueError, TypeError, AttributeError) as exc:
                    raise MotionError("Reachy daemon returned an invalid motion UUID") from exc
                with self._lock:
                    self._active_uuid = move_uuid
                    cancelled_before_registration = self._generation != generation
                if cancelled_before_registration:
                    self._stop_uuid(move_uuid)
                    with self._lock:
                        if self._active_uuid == move_uuid:
                            self._active_uuid = None
                    raise MotionCancelled("motion was cancelled while being admitted")

            deadline = self.clock() + timeout_s
            terminal = False
            cancellation_confirmed = False
            try:
                while True:
                    remaining = deadline - self.clock()
                    if remaining <= 0:
                        raise MotionError("Reachy daemon motion timed out and was cancelled")
                    try:
                        raw_event = events.recv(timeout=remaining)
                        event = json.loads(raw_event)
                    except TimeoutError as exc:
                        raise MotionError("Reachy daemon motion timed out and was cancelled") from exc
                    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
                        raise MotionError("Reachy daemon emitted an invalid motion event") from exc
                    if not isinstance(event, dict) or str(event.get("uuid")) != move_uuid:
                        continue
                    event_type = event.get("type")
                    if event_type == "move_completed":
                        terminal = True
                        return {"uuid": move_uuid, "completed": True}
                    if event_type == "move_cancelled":
                        terminal = True
                        raise MotionCancelled("Reachy daemon confirmed motion cancellation")
                    if event_type == "move_failed":
                        terminal = True
                        raise MotionError("Reachy daemon reported motion failure")
                    if event_type != "move_started":
                        raise MotionError("Reachy daemon emitted an unknown motion event")
            except BaseException:
                if not terminal:
                    try:
                        self._stop_uuid(move_uuid)
                        cancellation_confirmed = True
                    except MotionError as cancel_error:
                        # Preserve the UUID for a later emergency-stop retry. Never
                        # report an ordinary transport failure while motion may continue.
                        raise MotionError(
                            "motion failed and physical cancellation could not be confirmed"
                        ) from cancel_error
                raise
            finally:
                if terminal or cancellation_confirmed:
                    with self._lock:
                        if self._active_uuid == move_uuid:
                            self._active_uuid = None

    def _stop_uuid(self, move_uuid: str) -> None:
        try:
            response = self._request("POST", "/stop", {"uuid": move_uuid})
        except MotionError as exc:
            # A task can finish between the running poll and stop request. Verify
            # absence before treating that race as a cancellation failure.
            running = self._request("GET", "/running", None)
            if isinstance(running, list) and not any(
                isinstance(item, dict) and str(item.get("uuid")) == move_uuid for item in running
            ):
                return
            raise MotionError("Reachy daemon could not confirm emergency motion cancellation") from exc
        if not isinstance(response, dict) or not isinstance(response.get("message"), str):
            raise MotionError("Reachy daemon did not confirm motion cancellation")

    @staticmethod
    def _default_event_connector(url: str) -> Any:
        from websockets.sync.client import connect

        return connect(
            url,
            open_timeout=3.0,
            close_timeout=1.0,
            max_size=262_144,
            compression=None,
        )

    def _request(self, method: str, path: str, payload: dict[str, Any] | None) -> Any:
        data = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Accept": "application/json", **({"Content-Type": "application/json"} if data else {})},
        )
        try:
            with self.opener(request, timeout=5.0) as response:
                raw = response.read(262_145)
                final_url = (
                    response.geturl() if callable(getattr(response, "geturl", None)) else request.full_url
                )
        except urllib.error.HTTPError as exc:
            raise MotionError(f"Reachy daemon motion API rejected HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise MotionError("Reachy daemon motion API is unavailable") from exc
        if final_url != request.full_url:
            raise MotionError("Reachy daemon motion API redirect is forbidden")
        if len(raw) > 262_144:
            raise MotionError("Reachy daemon motion response exceeded the safety limit")
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MotionError("Reachy daemon motion response was invalid JSON") from exc
