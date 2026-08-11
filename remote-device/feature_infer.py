#!/usr/bin/env python3
"""
Feature-based wake-word inference sidecar for HomeBrain Remote Device.

- Reads 16 kHz mono PCM frames from stdin as raw bytes (little-endian int16).
- Computes OpenWakeWord AudioFeatures and windows them into [16 x 96] features.
- Performs ONNX inference and returns scores over stdout as JSON lines.

Protocol (stdin -> stdout):
- Input JSON control messages to set models and options, e.g.
  {"type":"config","models":[{"label":"Anna","path":"/path/anna.onnx","threshold":0.55}],"frameSamples":16000}
- Audio data frames are sent as binary blocks preceded by a 8-byte header:
  4 bytes: magic 'AUD0'
  4 bytes: uint32 frame byte length (should be frameSamples*2)
  then the PCM bytes (int16 LE)
- Output JSON events per processed frame/window:
  {"type":"score","model":"Anna","score":0.73,"ts":1690000000.123}
  and detection:
  {"type":"detect","model":"Anna","score":0.88,"ts":...}

This sidecar intentionally keeps a simple protocol to avoid large dependencies in Node.
"""
import inspect
import json
import os
import struct
import sys
import threading
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

try:
    import onnxruntime as ort
except Exception as exc:  # pragma: no cover
    sys.stderr.write(f"onnxruntime is required: {exc}\n")
    sys.exit(1)

OWW_UTILS = None
try:
    from openwakeword import utils as oww_utils  # type: ignore

    OWW_UTILS = oww_utils
except Exception:
    OWW_UTILS = None

try:
    from openwakeword.utils import AudioFeatures
except Exception as exc:  # pragma: no cover
    sys.stderr.write(f"openwakeword is required: {exc}\n")
    sys.exit(1)

MAGIC = b"AUD0"
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_MIN_RMS = 0.004
MAX_MIN_RMS = 0.2
DEFAULT_COOLDOWN_MS = 1500
WINDOW_FRAMES = 16
FEATURE_DIM = 96
MIN_SAMPLE_RATE = 8_000
MAX_SAMPLE_RATE = 48_000
MIN_FRAME_SAMPLES = 160
MAX_FRAME_SAMPLES = 160_000
MAX_CONTROL_MESSAGE_BYTES = 64 * 1024
MAX_MODELS = 32
MAX_LABEL_LENGTH = 128

@dataclass
class ModelSpec:
    label: str
    path: str
    threshold: float = 0.55
    input_name: Optional[str] = None
    session: Optional[ort.InferenceSession] = None
    input_shape: Optional[Tuple[int, ...]] = None
    output_names: Optional[List[str]] = None

class FeatureInfer:
    def __init__(self) -> None:
        self.models: List[ModelSpec] = []
        self.sample_rate = DEFAULT_SAMPLE_RATE
        self.frame_samples = DEFAULT_SAMPLE_RATE  # 1 second by default
        self.min_rms = DEFAULT_MIN_RMS  # energy gate to reduce false positives on silence
        self.cooldown_ms = DEFAULT_COOLDOWN_MS  # per-model cooldown between detects
        self.last_detect_ts: Dict[str, float] = {}
        # Initialize AudioFeatures; if resources missing, attempt one more download, then retry once
        try:
            self.features = self._init_features()
        except Exception as init_err:
            try:
                if OWW_UTILS and hasattr(OWW_UTILS, "download_models"):
                    OWW_UTILS.download_models()
                self.features = self._init_features()
            except Exception as retry_error:
                self.log(
                    level="error",
                    msg="Unable to initialize OpenWakeWord features",
                    error=str(retry_error),
                )
                raise init_err
        self.lock = threading.Lock()

    def _init_features(self):
        try:
            sig = inspect.signature(AudioFeatures.__init__)
            if "device" in sig.parameters:
                return AudioFeatures(device="cpu")
        except (TypeError, ValueError):
            self.log(level="debug", msg="AudioFeatures signature could not be inspected")
        return AudioFeatures()

    def log(self, **kwargs):
        sys.stderr.write(json.dumps({"ts": time.time(), **kwargs}) + "\n")
        sys.stderr.flush()

    def configure(self, payload: Dict) -> None:
        if not isinstance(payload, dict):
            raise ValueError("Configuration must be a JSON object")

        models_cfg = payload.get("models") or []
        if not isinstance(models_cfg, list):
            raise ValueError("Configuration models must be a list")

        try:
            sample_rate = int(payload.get("sampleRate") or DEFAULT_SAMPLE_RATE)
        except (TypeError, ValueError):
            sample_rate = DEFAULT_SAMPLE_RATE
        self.sample_rate = max(MIN_SAMPLE_RATE, min(MAX_SAMPLE_RATE, sample_rate))

        try:
            frame_samples = int(payload.get("frameSamples") or self.sample_rate)
        except (TypeError, ValueError):
            frame_samples = self.sample_rate
        self.frame_samples = max(MIN_FRAME_SAMPLES, min(MAX_FRAME_SAMPLES, frame_samples))

        vad = payload.get("vad") or {}
        if not isinstance(vad, dict):
            vad = {}
        try:
            if vad.get("minRms") is not None:
                min_rms = float(vad.get("minRms"))
                self.min_rms = max(DEFAULT_MIN_RMS, min(MAX_MIN_RMS, min_rms)) if min_rms > 0 else DEFAULT_MIN_RMS
        except (TypeError, ValueError):
            self.min_rms = DEFAULT_MIN_RMS
        try:
            cooldown_ms = int(payload.get("cooldownMs")) if payload.get("cooldownMs") is not None else self.cooldown_ms
        except (TypeError, ValueError):
            cooldown_ms = DEFAULT_COOLDOWN_MS
        self.cooldown_ms = max(0, min(300_000, cooldown_ms))

        providers = ["CPUExecutionProvider"]
        configured: List[ModelSpec] = []
        for entry in models_cfg[:MAX_MODELS]:
            if not isinstance(entry, dict):
                self.log(level="warn", msg="Ignoring non-object model entry")
                continue
            label = str(entry.get("label") or entry.get("slug") or "wake_word")[:MAX_LABEL_LENGTH]
            path = str(entry.get("path") or entry.get("model") or "").strip()
            try:
                threshold = float(entry.get("threshold") if entry.get("threshold") is not None else 0.55)
            except (TypeError, ValueError):
                threshold = 0.55
            threshold = max(0.0, min(1.0, threshold))
            if not path:
                self.log(level="warn", msg="Model entry missing path", label=label)
                continue
            if not os.path.isfile(path):
                self.log(level="warn", msg="Model path not found", label=label, path=path)
                continue
            try:
                sess = ort.InferenceSession(path, providers=providers)
                # resolve input name and shape
                if hasattr(sess, "get_inputs"):
                    inputs = sess.get_inputs()
                    input_name = inputs[0].name if inputs else "audio"
                    dims = tuple(int(d) if isinstance(d, (int, np.integer)) and d > 0 else -1 for d in (inputs[0].shape or [])) if inputs else (1, WINDOW_FRAMES, FEATURE_DIM)
                else:
                    input_name = sess.get_inputs()[0].name
                    dims = tuple(sess.get_inputs()[0].shape)
                output_names = [o.name for o in sess.get_outputs()] if hasattr(sess, "get_outputs") else None
                configured.append(ModelSpec(label=label, path=path, threshold=threshold, input_name=input_name, session=sess, input_shape=dims, output_names=output_names))
                self.log(level="info", msg="Model loaded", label=label, path=path, input=input_name, shape=list(dims))
            except Exception as e:
                self.log(level="error", msg="Failed to load model", label=label, path=path, error=str(e))
        with self.lock:
            self.models = configured

    def preprocess(self, pcm: np.ndarray) -> np.ndarray:
        """Compute features and extract latest [WINDOW_FRAMES, FEATURE_DIM] window."""
        # pcm expected float32 [-1,1], shape (N,)
        # AudioFeatures.embed_clips wants int16 mono samples shaped [clips, samples]
        if pcm.dtype != np.float32:
            pcm = pcm.astype(np.float32)
        pcm = np.clip(pcm, -1.0, 1.0)
        pcm_i16 = (pcm * 32767.0).astype(np.int16)[None, :]
        emb = self.features.embed_clips(pcm_i16, batch_size=1, ncpu=1)  # -> [clips, frames, 96]
        if emb.ndim != 3:
            raise RuntimeError(f"Unexpected embedding shape: {emb.shape}")
        frames = emb.shape[1]
        if frames < WINDOW_FRAMES:
            # pad or repeat last frame
            pad = np.repeat(emb[:, -1:, :], WINDOW_FRAMES - frames, axis=1)
            window = np.concatenate([emb, pad], axis=1)[:, :WINDOW_FRAMES, :]
        else:
            window = emb[:, -WINDOW_FRAMES:, :]
        return window.astype(np.float32)[0]

    def infer(self, window: np.ndarray) -> List[Dict]:
        # window shape: [16, 96]
        results = []
        now = time.time()
        for m in self.models:
            if not m.session or not m.input_name:
                continue
            # Build [1, 16, 96]
            tensor = window[None, :, :]
            # Some models may expect different order; try common cases if the first attempt fails
            try:
                inputs = {m.input_name: tensor}
                outputs = m.session.run(m.output_names, inputs)
            except Exception:
                # Try NHW (1, 96, 16)
                try:
                    inputs = {m.input_name: np.transpose(tensor, (0, 2, 1))}
                    outputs = m.session.run(m.output_names, inputs)
                except Exception as e2:
                    results.append({"model": m.label, "error": f"inference_failed: {e2}"})
                    continue
            # Coerce a score
            score = None
            if outputs:
                out = outputs[0]
                if isinstance(out, (list, tuple, np.ndarray)):
                    arr = np.array(out)
                    score = float(arr.flatten()[0]) if arr.size else 0.0
                else:
                    score = 0.0
            else:
                score = 0.0
            last = self.last_detect_ts.get(m.label, 0.0)
            detect = (score is not None) and (score >= m.threshold) and (((now - last) * 1000.0) >= self.cooldown_ms)
            if detect:
                self.last_detect_ts[m.label] = now
            results.append({"model": m.label, "score": score, "detect": bool(detect)})
        return results


def read_exact(stream, n):
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def main():
    fi = FeatureInfer()
    # Line-based control messages on stdin until we receive the first audio header
    bin_in = sys.stdin.buffer
    while True:
        try:
            pos = bin_in.peek(4) if hasattr(bin_in, 'peek') else None
            if pos and len(pos) >= 4 and pos[:4] == MAGIC:
                break
        except (OSError, ValueError) as error:
            fi.log(level="error", msg="Unable to inspect sidecar input", error=str(error))
            return
        line_bytes = bin_in.readline(MAX_CONTROL_MESSAGE_BYTES + 1)
        if not line_bytes:
            break
        if len(line_bytes) > MAX_CONTROL_MESSAGE_BYTES:
            fi.log(level="error", msg="Control message exceeds size limit")
            return
        try:
            text = line_bytes.decode('utf-8', errors='ignore')
            payload = json.loads(text)
            if payload.get('type') == 'config':
                fi.configure(payload)
                sys.stdout.write(json.dumps({"type": "ready", "models": [m.label for m in fi.models]}) + "\n")
                sys.stdout.flush()
            else:
                fi.log(level="warn", msg="Unknown control message")
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            fi.log(level="debug", msg="Skipping invalid control line", error=str(error))
            continue

    # Audio loop
    while True:
        header = read_exact(sys.stdin.buffer, 8)
        if header is None:
            break
        magic, length = header[:4], struct.unpack('<I', header[4:])[0]
        if magic != MAGIC:
            continue
        expected_length = fi.frame_samples * 2
        if length != expected_length or length > MAX_FRAME_SAMPLES * 2:
            fi.log(
                level="error",
                msg="Audio frame length is invalid",
                expected=expected_length,
                received=length,
            )
            return
        data = read_exact(sys.stdin.buffer, length)
        if data is None:
            break
        # Convert to float32
        pcm_i16 = np.frombuffer(data, dtype=np.int16)
        pcm = (pcm_i16.astype(np.float32) / 32768.0)
        try:
            # Simple energy gate to avoid processing silence
            rms = float(np.sqrt(np.mean(np.square(pcm))) if pcm.size else 0.0)
            if rms < fi.min_rms:
                # Skip low-energy frame
                continue
            window = fi.preprocess(pcm)
            results = fi.infer(window)
            ts = time.time()
            for r in results:
                payload = {"type": "score", "ts": ts, **r}
                sys.stdout.write(json.dumps(payload) + "\n")
                if r.get("detect"):
                    sys.stdout.write(json.dumps({"type": "detect", "ts": ts, "model": r["model"], "score": r["score"]}) + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"type": "error", "message": str(e)}) + "\n")
            sys.stdout.flush()


if __name__ == '__main__':
    main()
