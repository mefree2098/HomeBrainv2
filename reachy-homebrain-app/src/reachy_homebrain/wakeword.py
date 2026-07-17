"""Authenticated wake-word asset sync and lightweight OpenWakeWord inference."""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .config import HomeBrainConfig
from .http_security import DownloadSecurityError, fetch_limited


class WakeWordError(RuntimeError):
    """Wake-word assets or inference could not be initialized safely."""


_SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_SHA256 = re.compile(r"^[A-Fa-f0-9]{64}$")
MAX_ASSET_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 96 * 1024 * 1024
FRAME_SAMPLES = 1_280  # OpenWakeWord's efficient 80 ms unit at 16 kHz.


@dataclass(frozen=True, slots=True)
class WakeWordModelAsset:
    label: str
    slug: str
    path: Path
    threshold: float


@dataclass(frozen=True, slots=True)
class WakeWordDetection:
    label: str
    confidence: float


def _digest(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise WakeWordError(f"{field} checksum is required")
    normalized = value.removeprefix("sha256:").lower()
    if not _SHA256.fullmatch(normalized):
        raise WakeWordError(f"{field} checksum is invalid")
    return normalized


class WakeWordAssetManager:
    """Cache only checksum-verified model files delivered by HomeBrain."""

    def __init__(
        self,
        config: HomeBrainConfig,
        cache_dir: str | Path,
        *,
        opener: Callable[..., Any] | None = None,
        timeout_s: float = 20.0,
    ):
        self.config = config
        self.cache_dir = Path(cache_dir)
        self.opener = opener
        self.timeout_s = timeout_s

    def sync(self, remote_config: Any) -> tuple[list[WakeWordModelAsset], dict[str, Any]]:
        wake = remote_config.get("wakeWord") if isinstance(remote_config, dict) else None
        assets = wake.get("assets") if isinstance(wake, dict) else None
        if not isinstance(assets, list) or not assets:
            return [], {"state": "no_models", "models": [], "error": "HomeBrain supplied no wake-word assets"}
        if len(assets) > 16:
            raise WakeWordError("too many wake-word assets")
        self.cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.cache_dir, 0o700)
        models: list[WakeWordModelAsset] = []
        total = 0
        for raw in assets:
            if not isinstance(raw, dict):
                raise WakeWordError("wake-word asset entry must be an object")
            label = str(raw.get("label") or raw.get("slug") or "").strip()
            slug = str(raw.get("slug") or "").strip()
            file_name = str(raw.get("fileName") or "").strip()
            if (
                not label
                or len(label) > 80
                or not _SAFE_NAME.fullmatch(slug)
                or not _SAFE_NAME.fullmatch(file_name)
            ):
                raise WakeWordError("wake-word asset name is invalid")
            size = raw.get("size")
            if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= MAX_ASSET_BYTES:
                raise WakeWordError(f"wake-word asset size is invalid: {label}")
            total += size
            if total > MAX_TOTAL_BYTES:
                raise WakeWordError("wake-word assets exceed the aggregate size limit")
            checksum = _digest(raw.get("checksum"), label)
            folder = self.cache_dir / slug
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = self._sync_file(folder, file_name, size, checksum, raw.get("downloadUrl"))

            dependencies = raw.get("dependencies", [])
            if not isinstance(dependencies, list) or len(dependencies) > 16:
                raise WakeWordError(f"wake-word dependencies are invalid: {label}")
            for dependency in dependencies:
                if not isinstance(dependency, dict):
                    raise WakeWordError("wake-word dependency must be an object")
                dependency_name = str(dependency.get("fileName") or "")
                if not _SAFE_NAME.fullmatch(dependency_name):
                    raise WakeWordError("wake-word dependency name is invalid")
                dependency_size = dependency.get("size")
                if (
                    isinstance(dependency_size, bool)
                    or not isinstance(dependency_size, int)
                    or not 1 <= dependency_size <= MAX_ASSET_BYTES
                ):
                    raise WakeWordError("wake-word dependency size is invalid")
                total += dependency_size
                if total > MAX_TOTAL_BYTES:
                    raise WakeWordError("wake-word assets exceed the aggregate size limit")
                self._sync_file(
                    folder,
                    dependency_name,
                    dependency_size,
                    _digest(dependency.get("checksum"), dependency_name),
                    dependency.get("downloadUrl"),
                )
            threshold_raw = raw.get("threshold", 0.55)
            try:
                threshold = float(threshold_raw)
            except (TypeError, ValueError) as exc:
                raise WakeWordError(f"wake-word threshold is invalid: {label}") from exc
            if not math.isfinite(threshold):
                raise WakeWordError(f"wake-word threshold is invalid: {label}")
            models.append(WakeWordModelAsset(label, slug, path, max(0.05, min(0.99, threshold))))
        return models, {"state": "assets_ready", "models": [model.label for model in models], "error": None}

    def _sync_file(
        self,
        folder: Path,
        file_name: str,
        expected_size: int,
        expected_digest: str,
        download_url: Any,
    ) -> Path:
        target = folder / file_name
        if (
            target.exists()
            and target.is_file()
            and not target.is_symlink()
            and target.stat().st_size == expected_size
            and self._file_digest(target) == expected_digest
        ):
            os.chmod(target, 0o600)
            return target
        if target.exists():
            if target.is_dir() or target.is_symlink():
                raise WakeWordError("wake-word cache target is unsafe")
            target.unlink()
        if not isinstance(download_url, str) or not download_url:
            raise WakeWordError(f"wake-word download URL is missing: {file_name}")
        try:
            data, _ = fetch_limited(
                self.config,
                download_url,
                max_bytes=expected_size,
                headers={**self.config.auth_headers(), "Accept": "application/octet-stream"},
                timeout_s=self.timeout_s,
                opener=self.opener,
            )
        except DownloadSecurityError as exc:
            raise WakeWordError(f"wake-word download failed: {file_name}") from exc
        if len(data) != expected_size or hashlib.sha256(data).hexdigest() != expected_digest:
            raise WakeWordError(f"wake-word checksum or size mismatch: {file_name}")
        descriptor, temporary = tempfile.mkstemp(prefix=f".{file_name}.", dir=folder)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            temporary = ""
            os.chmod(target, 0o600)
            return target
        finally:
            if temporary:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temporary)

    @staticmethod
    def _file_digest(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()


class OpenWakeWordDetector:
    """Feed verified custom models with bounded 80 ms PCM frames."""

    def __init__(
        self,
        assets: list[WakeWordModelAsset],
        *,
        debounce_ms: int = 1_500,
        min_rms: float = 0.004,
        model_factory: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        if not assets:
            raise WakeWordError("at least one wake-word model is required")
        if model_factory is None:
            try:
                from openwakeword.model import Model
            except Exception as exc:
                raise WakeWordError("OpenWakeWord runtime is unavailable") from exc
            model_factory = Model
        paths = [str(asset.path) for asset in assets]
        try:
            self.model = model_factory(wakeword_models=paths, inference_framework="onnx")
        except TypeError:
            self.model = model_factory(wakeword_models=paths)
        except Exception as exc:
            raise WakeWordError("OpenWakeWord model initialization failed") from exc
        self.assets = assets
        self.debounce_s = max(0.25, min(debounce_ms / 1_000, 10.0))
        self.min_rms = max(0.0, min(float(min_rms), 0.2))
        self.clock = clock
        self._buffer = bytearray()
        self._last_detect: dict[str, float] = {}
        self._suspended = False
        self._lock = threading.Lock()

    def suspend(self) -> None:
        with self._lock:
            self._suspended = True
            self._buffer.clear()

    def resume(self) -> None:
        with self._lock:
            self._buffer.clear()
            self._suspended = False

    def process_pcm(self, pcm_s16le: bytes) -> list[WakeWordDetection]:
        with self._lock:
            if self._suspended or not pcm_s16le:
                return []
            self._buffer.extend(pcm_s16le[: 16_000 * 2 * 2])
            frame_bytes = FRAME_SAMPLES * 2
            detections: list[WakeWordDetection] = []
            while len(self._buffer) >= frame_bytes:
                raw = bytes(self._buffer[:frame_bytes])
                del self._buffer[:frame_bytes]
                frame = np.frombuffer(raw, dtype="<i2")
                rms = float(np.sqrt(np.mean(np.square(frame.astype(np.float32) / 32_768.0))))
                if rms < self.min_rms:
                    continue
                try:
                    predictions = self.model.predict(frame)
                except Exception as exc:
                    raise WakeWordError("OpenWakeWord inference failed") from exc
                if not isinstance(predictions, dict):
                    continue
                now = self.clock()
                for asset in self.assets:
                    score = self._score_for(asset, predictions)
                    if score < asset.threshold:
                        continue
                    last = self._last_detect.get(asset.label, -1e9)
                    if now - last < self.debounce_s:
                        continue
                    self._last_detect[asset.label] = now
                    detections.append(WakeWordDetection(asset.label, score))
            return detections

    @staticmethod
    def _score_for(asset: WakeWordModelAsset, predictions: dict[str, Any]) -> float:
        normalized_candidates = {
            asset.label.lower().replace("-", "_").replace(" ", "_"),
            asset.slug.lower().replace("-", "_"),
            asset.path.stem.lower().replace("-", "_"),
        }
        selected: Any = None
        for key, value in predictions.items():
            normalized_key = str(key).lower().replace("-", "_").replace(" ", "_")
            if normalized_key in normalized_candidates or any(
                candidate in normalized_key for candidate in normalized_candidates
            ):
                selected = value
                break
        if selected is None and len(predictions) == 1 and len(normalized_candidates) > 0:
            selected = next(iter(predictions.values()))
        if isinstance(selected, (list, tuple, np.ndarray)):
            array = np.asarray(selected).reshape(-1)
            selected = array[-1] if array.size else 0.0
        try:
            score = float(selected)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, min(1.0, score)) if math.isfinite(score) else 0.0


class WakeWordRuntime:
    """Atomically reconfigure detector assets and expose truthful health."""

    def __init__(
        self,
        manager: WakeWordAssetManager,
        *,
        detector_factory: Callable[..., OpenWakeWordDetector] = OpenWakeWordDetector,
    ):
        self.manager = manager
        self.detector_factory = detector_factory
        self.detector: OpenWakeWordDetector | None = None
        self._health: dict[str, Any] = {
            "state": "awaiting_config",
            "models": [],
            "error": None,
            "lastDetection": None,
        }
        self._lock = threading.Lock()

    def configure(self, remote_config: Any) -> dict[str, Any]:
        try:
            assets, asset_health = self.manager.sync(remote_config)
            if not assets:
                with self._lock:
                    self.detector = None
                    self._health = {**asset_health, "lastDetection": self._health.get("lastDetection")}
                return self.health()
            wake = remote_config.get("wakeWord", {}) if isinstance(remote_config, dict) else {}
            debounce = wake.get("debounceMs", 1_500) if isinstance(wake, dict) else 1_500
            vad = wake.get("vad", {}) if isinstance(wake, dict) else {}
            min_rms = vad.get("minRms", 0.004) if isinstance(vad, dict) else 0.004
            detector = self.detector_factory(
                assets,
                debounce_ms=int(debounce) if isinstance(debounce, (int, float)) else 1_500,
                min_rms=float(min_rms) if isinstance(min_rms, (int, float)) else 0.004,
            )
            with self._lock:
                self.detector = detector
                self._health = {
                    "state": "ready",
                    "models": [asset.label for asset in assets],
                    "error": None,
                    "lastDetection": self._health.get("lastDetection"),
                }
        except Exception as exc:
            with self._lock:
                self.detector = None
                self._health = {
                    "state": "error",
                    "models": [],
                    "error": str(exc)[:240],
                    "lastDetection": self._health.get("lastDetection"),
                }
        return self.health()

    def process_pcm(self, pcm: bytes) -> list[WakeWordDetection]:
        with self._lock:
            detector = self.detector
        if detector is None:
            return []
        try:
            detections = detector.process_pcm(pcm)
        except Exception as exc:
            with self._lock:
                self.detector = None
                self._health = {**self._health, "state": "error", "error": str(exc)[:240]}
            return []
        if detections:
            with self._lock:
                self._health["lastDetection"] = {
                    "label": detections[0].label,
                    "confidence": detections[0].confidence,
                    "at": time.time(),
                }
        return detections

    def suspend(self) -> None:
        with self._lock:
            detector = self.detector
        if detector is not None:
            detector.suspend()

    def resume(self) -> None:
        with self._lock:
            detector = self.detector
        if detector is not None:
            detector.resume()

    def health(self) -> dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._health, allow_nan=False))
