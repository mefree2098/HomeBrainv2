#!/usr/bin/env python3
"""
Feature-based wake-word inference sidecar for HomeBrain Remote Device.

- Reads continuous 16 kHz mono PCM frames from stdin as raw bytes (little-endian int16).
- Advances OpenWakeWord's streaming AudioFeatures state every 80 ms and reads
  the latest trained [16 x 96] feature window.
- Performs ONNX inference and returns scores over stdout as JSON lines.

Protocol (stdin -> stdout):
- Input JSON control messages to set models and options, e.g.
  {"type":"config","models":[{"label":"Anna","path":"/path/anna.onnx","threshold":0.55}],"frameSamples":1280}
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
STREAM_FRAME_SAMPLES = 1280
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
ACTIVITY_HOLD_MS = 480
DETECTION_CONFIRMATION_MS = 160
SCORE_REPORT_INTERVAL_MS = 500
# Matches the minimum clip duration used by train_wake_word.py for a 16-frame
# classifier window: (76 + (16 - 1) * 8 + 3) * 160 samples.
MIN_READY_SAMPLES = (76 + (WINDOW_FRAMES - 1) * 8 + 3) * 160

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
        self.frame_samples = STREAM_FRAME_SAMPLES
        self.min_rms = DEFAULT_MIN_RMS  # energy gate to reduce false positives on silence
        self.cooldown_ms = DEFAULT_COOLDOWN_MS  # per-model cooldown between detects
        self.last_detect_ts: Dict[str, float] = {}
        self.last_global_detect_ts = 0.0
        self.samples_seen = 0
        self.activity_frames_remaining = 0
        self.pending_detection: Optional[Dict] = None
        self.pending_detection_frames = 0
        self.last_score_report_ts = 0.0
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
        if self.sample_rate != DEFAULT_SAMPLE_RATE:
            self.log(
                level="warn",
                msg="OpenWakeWord feature models require 16000 Hz mono audio; using 16000 Hz",
                requestedSampleRate=self.sample_rate,
            )
            self.sample_rate = DEFAULT_SAMPLE_RATE

        try:
            frame_samples = int(payload.get("frameSamples") or STREAM_FRAME_SAMPLES)
        except (TypeError, ValueError):
            frame_samples = STREAM_FRAME_SAMPLES
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
        if hasattr(self.features, "reset"):
            self.features.reset()
        self.samples_seen = 0
        self.activity_frames_remaining = 0
        self.pending_detection = None
        self.pending_detection_frames = 0
        self.last_score_report_ts = 0.0
        self.last_global_detect_ts = 0.0
        self.last_detect_ts.clear()

    def preprocess(self, pcm_i16: np.ndarray) -> Optional[np.ndarray]:
        """Advance continuous features and return the latest real [16, 96] window."""
        if pcm_i16.dtype != np.int16:
            pcm_i16 = np.asarray(pcm_i16, dtype=np.int16)
        processed_samples = int(self.features(pcm_i16))
        self.samples_seen += int(pcm_i16.size)
        if processed_samples < STREAM_FRAME_SAMPLES or self.samples_seen < MIN_READY_SAMPLES:
            return None
        window = self.features.get_features(WINDOW_FRAMES)
        if window.ndim != 3 or window.shape[0] != 1 or window.shape[1:] != (WINDOW_FRAMES, FEATURE_DIM):
            raise RuntimeError(f"Unexpected streaming embedding shape: {window.shape}")
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
            eligible = (
                (score is not None)
                and (score >= m.threshold)
                and (((now - last) * 1000.0) >= self.cooldown_ms)
                and (((now - self.last_global_detect_ts) * 1000.0) >= self.cooldown_ms)
            )
            results.append({
                "model": m.label,
                "score": score,
                "threshold": m.threshold,
                "eligible": bool(eligible),
                "detect": False,
            })
        return results

    @staticmethod
    def _label_words(label: str) -> List[str]:
        normalized = "".join(character.lower() if character.isalnum() else " " for character in str(label))
        return [word for word in normalized.split() if word]

    def _prefer_candidate(self, candidate: Dict, current: Dict) -> bool:
        candidate_words = self._label_words(candidate.get("model", ""))
        current_words = self._label_words(current.get("model", ""))
        candidate_text = " ".join(candidate_words)
        current_text = " ".join(current_words)

        # If two configured phrases contain one another ("Anna" / "Hey Anna"),
        # prefer the more specific phrase once both cross their own calibrated
        # thresholds. This keeps wake-word-specific voice profiles stable.
        if candidate_text and current_text:
            candidate_contains_current = f" {current_text} " in f" {candidate_text} "
            current_contains_candidate = f" {candidate_text} " in f" {current_text} "
            if candidate_contains_current != current_contains_candidate:
                return candidate_contains_current

        def relative_margin(entry: Dict) -> float:
            score = float(entry.get("score") or 0.0)
            threshold = float(entry.get("threshold") or 0.0)
            return (score - threshold) / max(0.001, 1.0 - threshold)

        candidate_rank = (relative_margin(candidate), float(candidate.get("score") or 0.0), len(candidate_words))
        current_rank = (relative_margin(current), float(current.get("score") or 0.0), len(current_words))
        return candidate_rank > current_rank

    def update_detection_candidate(self, results: List[Dict]) -> Optional[Dict]:
        candidates = [entry for entry in results if entry.get("eligible")]
        best = None
        for candidate in candidates:
            if best is None or self._prefer_candidate(candidate, best):
                best = candidate

        confirmation_frames = max(
            1,
            int(np.ceil(DETECTION_CONFIRMATION_MS / max(1.0, self.frame_samples / self.sample_rate * 1000.0)))
        )
        if best is None:
            self.pending_detection = None
            self.pending_detection_frames = 0
            return None

        pending_label = str(self.pending_detection.get("model")) if self.pending_detection else ""
        best_label = str(best.get("model") or "")
        if self.pending_detection is None or pending_label != best_label:
            self.pending_detection = dict(best)
            self.pending_detection_frames = confirmation_frames
        elif self._prefer_candidate(best, self.pending_detection):
            self.pending_detection = dict(best)

        self.pending_detection_frames -= 1
        if self.pending_detection_frames > 0:
            return None

        selected = self.pending_detection
        self.pending_detection = None
        self.pending_detection_frames = 0
        now = time.time()
        if ((now - self.last_global_detect_ts) * 1000.0) < self.cooldown_ms:
            return None
        label = str(selected.get("model") or "wake_word")
        self.last_detect_ts[label] = now
        self.last_global_detect_ts = now
        selected["detect"] = True
        return selected


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
        pcm_i16 = np.frombuffer(data, dtype=np.int16)
        try:
            emitted = False
            for start in range(0, pcm_i16.size, STREAM_FRAME_SAMPLES):
                audio_frame = pcm_i16[start:start + STREAM_FRAME_SAMPLES]
                if audio_frame.size == 0:
                    continue
                float_frame = audio_frame.astype(np.float32) / 32768.0
                rms = float(np.sqrt(np.mean(np.square(float_frame))) if float_frame.size else 0.0)

                # Silence must still advance AudioFeatures so separated phrases
                # are never spliced together. The energy gate controls model
                # inference only and stays open briefly after voiced audio.
                if rms >= fi.min_rms:
                    fi.activity_frames_remaining = max(
                        1,
                        int(np.ceil(ACTIVITY_HOLD_MS / (STREAM_FRAME_SAMPLES / fi.sample_rate * 1000.0)))
                    )
                elif fi.activity_frames_remaining > 0:
                    fi.activity_frames_remaining -= 1

                window = fi.preprocess(audio_frame)
                if window is None or fi.activity_frames_remaining <= 0:
                    detection = fi.update_detection_candidate([])
                    if detection:
                        ts = time.time()
                        sys.stdout.write(json.dumps({
                            "type": "detect",
                            "ts": ts,
                            "model": detection["model"],
                            "score": detection["score"],
                        }) + "\n")
                        emitted = True
                    continue

                results = fi.infer(window)
                detection = fi.update_detection_candidate(results)
                ts = time.time()
                should_report_scores = (
                    detection is not None
                    or any(entry.get("eligible") for entry in results)
                    or ((ts - fi.last_score_report_ts) * 1000.0) >= SCORE_REPORT_INTERVAL_MS
                )
                if should_report_scores:
                    fi.last_score_report_ts = ts
                    for result in results:
                        payload = {
                            "type": "score",
                            "ts": ts,
                            "model": result.get("model"),
                            "score": result.get("score"),
                            "threshold": result.get("threshold"),
                        }
                        sys.stdout.write(json.dumps(payload) + "\n")
                    emitted = True
                if detection:
                    sys.stdout.write(json.dumps({
                        "type": "detect",
                        "ts": ts,
                        "model": detection["model"],
                        "score": detection["score"],
                    }) + "\n")
                    emitted = True
            if emitted:
                sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"type": "error", "message": str(e)}) + "\n")
            sys.stdout.flush()


if __name__ == '__main__':
    main()
