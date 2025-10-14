#!/usr/bin/env python3
# Minimal OpenWakeWord training pipeline for HomeBrain.
#
# Emits JSON progress messages to stdout. The final line is a JSON object with type="result".

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

try:
    import soundfile as sf  # type: ignore
except ImportError as exc:  # pragma: no cover
    sys.stderr.write("soundfile is required. Install with `pip install soundfile`.\n")
    raise

try:
    from scipy import signal  # type: ignore
except Exception:  # pragma: no cover
    signal = None

try:
    import torch  # type: ignore
    from torch.utils.data import DataLoader, Dataset  # type: ignore
except ImportError as exc:  # pragma: no cover
    sys.stderr.write("PyTorch is required. Install with `pip install torch`.\n")
    raise

try:
    from openwakeword.utils import AudioFeatures  # type: ignore
except ImportError as exc:  # pragma: no cover
    sys.stderr.write("openwakeword is required. Install with `pip install openwakeword`.\n")
    raise

SAMPLE_RATE = 16_000
WINDOW_FRAMES = 16
WINDOW_STEP = 4
DEFAULT_POSITIVE_SYNTHETIC = 400
DEFAULT_NEGATIVE_SYNTHETIC = 150
DEFAULT_RANDOM_SILENCE = 200


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def progress(stage: str, amount: float, message: str, **extra: object) -> None:
    payload = {
        "type": "progress",
        "stage": stage,
        "progress": max(0.0, min(1.0, amount)),
        "message": message
    }
    if extra:
        payload["data"] = extra
    print(json.dumps(payload), flush=True)


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_audio(path: Path) -> np.ndarray:
    audio, sr = sf.read(str(path), always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        if signal is None:
            raise RuntimeError("Resampling requires scipy. Install with pip install scipy.")
        gcd = math.gcd(sr, SAMPLE_RATE)
        up = SAMPLE_RATE // gcd
        down = sr // gcd
        audio = signal.resample_poly(audio, up, down)
    return audio.astype(np.float32)


def pad_audio(audio: np.ndarray, target_samples: int, rng: random.Random) -> np.ndarray:
    if audio.shape[0] == target_samples:
        return audio.copy()
    if audio.shape[0] > target_samples:
        start = 0
        if audio.shape[0] - target_samples > 1:
            start = rng.randint(0, audio.shape[0] - target_samples)
        return audio[start:start + target_samples]
    result = np.zeros(target_samples, dtype=np.float32)
    start = 0
    if target_samples - audio.shape[0] > 1:
        start = rng.randint(0, target_samples - audio.shape[0])
    result[start:start + audio.shape[0]] = audio
    return result


def piper_synthesize(executable: str, voice: Dict[str, object], text: str, output: Path) -> Tuple[bool, str]:
    cmd = [executable, "--model", str(voice["modelPath"]), "--output_file", str(output)]
    if voice.get("configPath"):
        cmd.extend(["--config", str(voice["configPath"])])
    speaker_id = voice.get("speakerId")
    if isinstance(speaker_id, (int, float)):
        cmd.extend(["--speaker", str(int(speaker_id))])
    else:
        speaker_value = voice.get("speaker")
        if isinstance(speaker_value, int):
            cmd.extend(["--speaker", str(speaker_value)])
    try:
        result = subprocess.run(
            cmd,
            input=(text + "\n").encode("utf-8"),
            check=False,
            capture_output=True,
            timeout=60
        )
        if result.returncode == 0:
            return True, ""
        stderr = result.stderr.decode("utf-8", errors="ignore")
        stdout = result.stdout.decode("utf-8", errors="ignore")
        combined = "\n".join(filter(None, [stderr.strip(), stdout.strip()]))
        return False, combined or f"Piper exited with code {result.returncode}"
    except subprocess.TimeoutExpired:
        return False, "Piper synthesis timed out"
    except Exception as error:  # pragma: no cover
        return False, str(error)


# Attempt to resolve Piper executable from config/environment/known paths
# Returns absolute path or None if not found

def resolve_piper_executable(executable_opt: Optional[str]) -> Optional[str]:
    # 1) Explicit config value
    if executable_opt:
        raw = str(executable_opt)
        candidate = Path(raw)
        # Try as-is
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
        # Try relative to CWD and repo root
        try_paths = []
        try:
            try_paths.append((Path.cwd() / candidate))
        except Exception:
            pass
        root = Path(__file__).resolve().parent.parent
        try_paths.append(root / candidate)
        for p in try_paths:
            if p.is_file() and os.access(p, os.X_OK):
                return str(p.resolve())
        # Try PATH lookup
        resolved = shutil.which(raw)
        if resolved:
            return resolved

    # 2) Environment variable
    env_exec = os.environ.get("WAKEWORD_PIPER_EXEC")
    if env_exec:
        env_path = Path(str(env_exec))
        if env_path.is_file() and os.access(env_path, os.X_OK):
            return str(env_path.resolve())
        resolved = shutil.which(str(env_exec))
        if resolved:
            return resolved

    # 3) PATH search
    resolved = shutil.which("piper")
    if resolved:
        return resolved

    # 4) Known venv/system locations relative to this repo
    root = Path(__file__).resolve().parent.parent  # .../server
    candidates = [
        root / ".wakeword-venv" / "bin" / "piper",
        root / ".wakeword-venv" / "Scripts" / "piper.exe",
        Path("/usr/local/bin/piper"),
        Path("/usr/bin/piper"),
        Path("/bin/piper")
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)

    return None


def list_audio_files(sources: Iterable[Path]) -> List[Path]:
    results: List[Path] = []
    for source in sources:
        if source.is_file():
            results.append(source)
        elif source.is_dir():
            for child in source.rglob("*"):
                if child.suffix.lower() in {".wav", ".flac", ".mp3", ".ogg"}:
                    results.append(child)
    return results


def sha256_checksum(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Dataset assembly
# ---------------------------------------------------------------------------

def generate_positive_samples(
    phrase: str,
    options: Dict[str, object],
    target_samples: int,
    work_dir: Path,
    rng: random.Random
) -> Tuple[List[np.ndarray], Dict[str, object]]:
    samples: List[np.ndarray] = []
    tts_cfg = options.get("tts", {})
    synthetic_total = int(options.get("syntheticSamples", DEFAULT_POSITIVE_SYNTHETIC))
    voices = [voice for voice in tts_cfg.get("voices", []) if Path(str(voice.get("modelPath", ""))).is_file()]
    p_exec_cfg = tts_cfg.get("executable")
    piper_exec = resolve_piper_executable(str(p_exec_cfg) if p_exec_cfg else None)
    phrases = options.get("textVariations") or []
    if phrases:
        phrases = [p.strip() for p in phrases if p.strip()]

    stats = {
        "syntheticRequested": synthetic_total,
        "syntheticGenerated": 0,
        "userRecordings": 0,
        "silenceBackfill": 0,
        "voiceUsage": {},
        "piperAttempts": 0,
        "piperSucceeded": 0,
        "piperFailed": 0,
        "piperErrors": []
    }

    requested_voices = tts_cfg.get("voices", [])
    if synthetic_total > 0 and not voices:
        progress(
            "generating",
            0.07,
            "No positive voices available for Piper synthesis",
            stats={
                "requested": len(requested_voices),
                "resolved": [
                    {
                        "id": str(voice.get("id")),
                        "modelPath": str(voice.get("modelPath")),
                        "configPath": str(voice.get("configPath")),
                        "modelExists": Path(str(voice.get("modelPath", ""))).is_file(),
                        "configExists": Path(str(voice.get("configPath", ""))).is_file()
                    }
                    for voice in requested_voices
                ]
            }
        )

    if synthetic_total > 0 and voices and not piper_exec:
        progress(
            "generating",
            0.09,
            "Piper executable not found for positive synthesis",
            stats={
                "executableRequested": str(p_exec_cfg or "piper"),
                "resolvedExecutable": None,
                "voiceCount": len(voices)
            }
        )
        raise RuntimeError(
            "Piper executable not found. Install Piper and ensure it is executable, or set WAKEWORD_PIPER_EXEC to the full path and restart the hub."
        )

    if synthetic_total > 0 and piper_exec and voices:
        tmp_dir = ensure_dir(work_dir / "positive-tts")
        for index in range(synthetic_total):
            text = rng.choice(phrases) if phrases else phrase
            voice = rng.choice(voices)
            output = tmp_dir / f"{index:04d}.wav"
            stats["piperAttempts"] += 1
            success, error_message = piper_synthesize(piper_exec, voice, text, output)
            if not success:
                stats["piperFailed"] += 1
                if len(stats["piperErrors"]) < 5:
                    stats["piperErrors"].append({
                        "voice": str(voice.get("id") or voice.get("name") or "unknown"),
                        "error": error_message
                    })
            else:
                try:
                    audio = load_audio(output)
                    samples.append(pad_audio(audio, target_samples, rng))
                    stats["syntheticGenerated"] += 1
                    voice_id = str(voice.get("id") or voice.get("name") or "unknown")
                    stats["voiceUsage"][voice_id] = stats["voiceUsage"].get(voice_id, 0) + 1
                    stats["piperSucceeded"] += 1
                except Exception as error:
                    stats["piperFailed"] += 1
                    if len(stats["piperErrors"]) < 5:
                        stats["piperErrors"].append({
                            "voice": str(voice.get("id") or voice.get("name") or "unknown"),
                            "error": str(error)
                        })
            # Periodic progress updates to avoid appearing stuck
            if synthetic_total > 0 and ((index + 1) % max(10, synthetic_total // 20 or 1) == 0 or (index + 1) == synthetic_total):
                frac = (index + 1) / max(1, synthetic_total)
                progress(
                    "generating",
                    0.05 + 0.05 * frac,
                    f"Synthesizing positives {index + 1}/{synthetic_total}",
                    stats={
                        "attempts": stats["piperAttempts"],
                        "succeeded": stats["piperSucceeded"],
                        "failed": stats["piperFailed"],
                        "voiceUsage": stats["voiceUsage"]
                    }
                )

    for path in list_audio_files(map(Path, options.get("userRecordings", []))):
        try:
            audio = load_audio(path)
            samples.append(pad_audio(audio, target_samples, rng))
            stats["userRecordings"] += 1
        except Exception:
            continue

    if not samples:
        silence = np.zeros(target_samples, dtype=np.float32)
        for _ in range(max(200, synthetic_total or 200)):
            samples.append(silence.copy())

    stats["silenceBackfill"] = max(0, len(samples) - (stats["syntheticGenerated"] + stats["userRecordings"]))
    stats["totalSamples"] = len(samples)
    return samples, stats


def generate_negative_samples(
    phrase: str,
    options: Dict[str, object],
    target_samples: int,
    work_dir: Path,
    rng: random.Random
) -> Tuple[List[np.ndarray], Dict[str, object]]:
    samples: List[np.ndarray] = []
    backgrounds = list_audio_files(map(Path, options.get("backgroundDirs", [])))
    stats = {
        "backgroundClips": 0,
        "syntheticRequested": 0,
        "syntheticGenerated": 0,
        "noiseSamples": 0,
        "voiceUsage": {},
        "piperAttempts": 0,
        "piperSucceeded": 0,
        "piperFailed": 0,
        "piperErrors": []
    }
    for path in backgrounds:
        try:
            audio = load_audio(path)
            samples.append(pad_audio(audio, target_samples, rng))
            stats["backgroundClips"] += 1
        except Exception:
            continue

    piper_cfg = options.get("syntheticSpeech", {})
    phrases = piper_cfg.get("phrases") or [
        f"Ignore {phrase}",
        "Good morning",
        "Turn on the lights",
        "Cancel the alarm"
    ]
    synthetic_count = int(piper_cfg.get("samples", DEFAULT_NEGATIVE_SYNTHETIC))
    voices = [voice for voice in piper_cfg.get("voices", []) if Path(str(voice.get("modelPath", ""))).is_file()]
    piper_exec = shutil.which(str(piper_cfg.get("executable") or "piper"))
    stats["syntheticRequested"] = synthetic_count
    requested_voices = piper_cfg.get("voices", [])
    if synthetic_count > 0 and not voices:
        progress(
            "generating",
            0.14,
            "No negative voices available for Piper synthesis",
            stats={
                "requested": len(requested_voices),
                "resolved": [
                    {
                        "id": str(voice.get("id")),
                        "modelPath": str(voice.get("modelPath")),
                        "configPath": str(voice.get("configPath")),
                        "modelExists": Path(str(voice.get("modelPath", ""))).is_file(),
                        "configExists": Path(str(voice.get("configPath", ""))).is_file()
                    }
                    for voice in requested_voices
                ]
            }
        )

    if synthetic_count > 0 and voices and not piper_exec:
        raise RuntimeError(
            "Piper executable not found. Install Piper or set WAKEWORD_PIPER_EXEC to its path and restart the hub."
        )

    if synthetic_count > 0 and piper_exec and voices:
        tmp_dir = ensure_dir(work_dir / "negative-tts")
        for index in range(synthetic_count):
            text = rng.choice(phrases)
            voice = rng.choice(voices)
            output = tmp_dir / f"{index:04d}.wav"
            stats["piperAttempts"] += 1
            success, error_message = piper_synthesize(piper_exec, voice, text, output)
            if not success:
                stats["piperFailed"] += 1
                if len(stats["piperErrors"]) < 5:
                    stats["piperErrors"].append({
                        "voice": str(voice.get("id") or voice.get("name") or "unknown"),
                        "error": error_message
                    })
            else:
                try:
                    audio = load_audio(output)
                    samples.append(pad_audio(audio, target_samples, rng))
                    stats["syntheticGenerated"] += 1
                    voice_id = str(voice.get("id") or voice.get("name") or "unknown")
                    stats["voiceUsage"][voice_id] = stats["voiceUsage"].get(voice_id, 0) + 1
                    stats["piperSucceeded"] += 1
                except Exception as error:
                    stats["piperFailed"] += 1
                    if len(stats["piperErrors"]) < 5:
                        stats["piperErrors"].append({
                            "voice": str(voice.get("id") or voice.get("name") or "unknown"),
                            "error": str(error)
                        })
            if synthetic_count > 0 and ((index + 1) % max(10, synthetic_count // 20 or 1) == 0 or (index + 1) == synthetic_count):
                frac = (index + 1) / max(1, synthetic_count)
                progress(
                    "generating",
                    0.12 + 0.04 * frac,
                    f"Synthesizing negatives {index + 1}/{synthetic_count}",
                    stats={
                        "attempts": stats["piperAttempts"],
                        "succeeded": stats["piperSucceeded"],
                        "failed": stats["piperFailed"],
                        "voiceUsage": stats["voiceUsage"]
                    }
                )

    for _ in range(int(options.get("randomSilence", DEFAULT_RANDOM_SILENCE))):
        noise = np.random.normal(0, rng.uniform(0.002, 0.01), size=target_samples).astype(np.float32)
        samples.append(noise)
        stats["noiseSamples"] += 1

    if not samples:
        noise = np.random.normal(0, 0.01, size=target_samples).astype(np.float32)
        for _ in range(400):
            samples.append(noise.copy())
        stats["noiseSamples"] += 400

    stats["totalSamples"] = len(samples)
    return samples, stats


def augment(samples: List[np.ndarray], copies: int, rng: random.Random) -> List[np.ndarray]:
    augmented: List[np.ndarray] = []
    if copies <= 0:
        return samples
    for base in samples:
        augmented.append(base)
        for _ in range(copies):
            scale = rng.uniform(0.7, 1.1)
            noisy = base * scale
            noisy += np.random.normal(0, rng.uniform(0.001, 0.02), size=base.shape[0]).astype(np.float32)
            if signal is not None and rng.random() < 0.3:
                impulse = np.exp(-np.linspace(0, 3, 2048) * rng.uniform(0.2, 0.6)).astype(np.float32)
                noisy = signal.fftconvolve(noisy, impulse, mode="full").astype(np.float32)
            noisy = np.clip(noisy, -1.0, 1.0).astype(np.float32)
            if noisy.shape[0] != base.shape[0]:
                noisy = pad_audio(noisy, base.shape[0], rng)
            augmented.append(noisy)
    return augmented


def split_dataset(samples: List[np.ndarray], train_ratio: float, rng: random.Random) -> Tuple[np.ndarray, np.ndarray]:
    array = np.stack(samples, axis=0)
    rng.shuffle(array)
    split_index = int(train_ratio * array.shape[0])
    return array[:split_index], array[split_index:]


# ---------------------------------------------------------------------------
# Feature extraction and windows
# ---------------------------------------------------------------------------

def embeddings_from_clips(clips: np.ndarray, batch_size: int) -> np.ndarray:
    features = AudioFeatures(device="cuda" if torch.cuda.is_available() else "cpu")
    if clips.size == 0:
        return np.empty((0, WINDOW_FRAMES, 96), dtype=np.float32)
    if clips.dtype != np.int16:
        clips = np.asarray(
            np.clip(clips, -1.0, 1.0) * 32767.0,
            dtype=np.int16
        )
    return features.embed_clips(clips, batch_size=batch_size, ncpu=max(1, os.cpu_count() or 1)).astype(np.float32)


def window_embeddings(emb: np.ndarray, label: int) -> Tuple[np.ndarray, np.ndarray]:
    windows: List[np.ndarray] = []
    labels: List[int] = []
    for clip in emb:
        frames = clip.shape[0]
        if frames < WINDOW_FRAMES:
            continue
        for start in range(0, frames - WINDOW_FRAMES + 1, WINDOW_STEP):
            windows.append(clip[start:start + WINDOW_FRAMES, :])
            labels.append(label)
    if not windows:
        return np.empty((0, WINDOW_FRAMES, emb.shape[-1]), dtype=np.float32), np.empty((0,), dtype=np.float32)
    return np.stack(windows).astype(np.float32), np.array(labels, dtype=np.float32)


class WakeWordDataset(Dataset):
    def __init__(self, features: np.ndarray, labels: np.ndarray) -> None:
        self.features = torch.from_numpy(features).float()
        self.labels = torch.from_numpy(labels).float()

    def __len__(self) -> int:
        return self.features.shape[0]

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        return self.features[idx], self.labels[idx]


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

# Simple DNN classifier to avoid importing openwakeword.train (which pulls torchaudio)
class SimpleDNN(torch.nn.Module):
    def __init__(self, input_shape: Tuple[int, int], layer_dim: int = 128) -> None:
        super().__init__()
        self.input_shape = input_shape
        in_features = int(input_shape[0] * input_shape[1])
        self.net = torch.nn.Sequential(
            torch.nn.Flatten(),
            torch.nn.Linear(in_features, layer_dim),
            torch.nn.ReLU(),
            torch.nn.Dropout(p=0.2),
            torch.nn.Linear(layer_dim, layer_dim),
            torch.nn.ReLU(),
            torch.nn.Dropout(p=0.2),
            torch.nn.Linear(layer_dim, 1),
            torch.nn.Sigmoid()
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:  # type: ignore
        return self.net(x)


class WakeWordTrainer:
    def __init__(self, input_shape: Tuple[int, int], batch_size: int, learning_rate: float) -> None:
        self.model = SimpleDNN(input_shape=input_shape, layer_dim=128)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)
        self.optimizer = torch.optim.AdamW(self.model.parameters(), lr=learning_rate, weight_decay=1e-5)
        self.criterion = torch.nn.BCELoss()
        self.batch_size = batch_size

    def run_epoch(self, loader: DataLoader, train: bool) -> Tuple[float, float]:
        total_loss = 0.0
        correct = 0
        total = 0
        if train:
            self.model.train()
        else:
            self.model.eval()

        for features, labels in loader:
            features = features.to(self.device)
            labels = labels.to(self.device)
            if train:
                self.optimizer.zero_grad()
            outputs = self.model(features).view(-1)
            loss = self.criterion(outputs, labels)
            if train:
                loss.backward()
                torch.nn.utils.clip_grad_norm_(self.model.parameters(), max_norm=5.0)
                self.optimizer.step()
            total_loss += loss.item() * labels.size(0)
            predictions = (outputs.detach() >= 0.5).float()
            correct += int((predictions == labels).sum().item())
            total += labels.size(0)

        if total == 0:
            return 0.0, 0.0
        return total_loss / total, correct / total

    def fit(self, train_loader: DataLoader, val_loader: DataLoader, epochs: int) -> Dict[str, float]:
        best_val_loss = float("inf")
        best_state = None
        history = {}

        for epoch in range(epochs):
            progress("training", 0.4 + (epoch / max(epochs, 1)) * 0.3, f"Epoch {epoch + 1}/{epochs}")
            train_loss, train_acc = self.run_epoch(train_loader, train=True)
            val_loss, val_acc = self.run_epoch(val_loader, train=False)
            history = {"train_loss": train_loss, "train_accuracy": train_acc, "val_loss": val_loss, "val_accuracy": val_acc}
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                best_state = {k: v.clone() for k, v in self.model.state_dict().items()}

        if best_state:
            self.model.load_state_dict(best_state)
        return history

    def scores(self, features: np.ndarray) -> np.ndarray:
        if features.size == 0:
            return np.empty((0,), dtype=np.float32)
        self.model.eval()
        with torch.no_grad():
            tensor = torch.from_numpy(features).float().to(self.device)
            outputs = self.model(tensor).view(-1).cpu().numpy().astype(np.float32)
        return outputs

    def export_onnx(self, path: Path) -> None:
        dummy = torch.randn(1, *self.model.input_shape, dtype=torch.float32, device=self.device)
        torch.onnx.export(self.model, dummy, str(path), opset_version=13, do_constant_folding=True,
                          input_names=["audio"], output_names=["score"])


# ---------------------------------------------------------------------------
# Threshold estimation & artifact export
# ---------------------------------------------------------------------------

def determine_threshold(pos_scores: np.ndarray, neg_scores: np.ndarray, target_fp_per_hour: float) -> float:
    if neg_scores.size == 0:
        return 0.5
    percentile = max(90.0, min(99.9, 100.0 - target_fp_per_hour * 10))
    neg_level = float(np.percentile(neg_scores, percentile))
    pos_level = float(np.percentile(pos_scores, 10.0)) if pos_scores.size else 0.7
    threshold = max(0.1, min(0.9, (neg_level + pos_level) / 2.0))
    if pos_scores.size and threshold >= pos_scores.max():
        threshold = max(0.1, min(0.9, pos_scores.max() * 0.9))
    return threshold


def export_artifacts(trainer: WakeWordTrainer, output_path: Path) -> List[Dict[str, object]]:
    artifacts: List[Dict[str, object]] = []
    ensure_dir(output_path.parent)
    onnx_path = output_path.with_suffix(".onnx")
    trainer.export_onnx(onnx_path)
    artifacts.append({
        "format": "onnx",
        "path": str(onnx_path),
        "size": onnx_path.stat().st_size,
        "checksum": sha256_checksum(onnx_path)
    })

    converted = False
    try:  # Try helper from openwakeword if available
        from openwakeword.train import convert_onnx_to_tflite  # type: ignore
        convert_onnx_to_tflite(str(onnx_path), str(output_path))
        converted = True
    except Exception:
        # Fallback to our script using onnx-tf + TensorFlow if present
        try:
            conv_script = Path(__file__).resolve().parent / "convert_to_tflite.py"
            if conv_script.is_file():
                result = subprocess.run([sys.executable, str(conv_script), "--onnx", str(onnx_path), "--out", str(output_path)],
                                        check=False, capture_output=True)
                if result.returncode == 0 and output_path.exists():
                    converted = True
        except Exception:
            converted = False

    if converted and output_path.exists():
        artifacts.append({
            "format": "tflite",
            "path": str(output_path),
            "size": output_path.stat().st_size,
            "checksum": sha256_checksum(output_path)
        })
    else:
        progress("exporting", 0.88, "TFLite conversion failed; ONNX artifact only.")
    return artifacts


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------

def run_pipeline(args: argparse.Namespace, options: Dict[str, object]) -> Dict[str, object]:
    rng = random.Random(1337)
    dataset_cfg = options.get("dataset", {})

    # Allow window size override from options
    override_window_frames = dataset_cfg.get("windowFrames")
    if override_window_frames is not None:
        try:
            override_val = int(override_window_frames)
            if override_val >= 4:  # basic sanity
                global WINDOW_FRAMES
                WINDOW_FRAMES = override_val
        except Exception:
            pass

    target_seconds_config = float(dataset_cfg.get("clipDurationSeconds", 1.5))
    # Ensure clips are long enough to produce at least one training window
    # openWakeWord embedding uses 10 ms mel frames, 76-frame window, 8-frame (80 ms) stride.
    # To get WINDOW_FRAMES windows, mel frames needed = 76 + (WINDOW_FRAMES-1)*8
    # melspectrogram model yields roughly ceil(samples/160 - 3) frames -> samples ~= (mel_frames+3)*160
    mel_frames_needed = 76 + (WINDOW_FRAMES - 1) * 8
    min_required_seconds = ((mel_frames_needed + 3) * 160) / SAMPLE_RATE
    if target_seconds_config < min_required_seconds:
        progress("generating", 0.02, f"clipDurationSeconds too short ({target_seconds_config:.2f}s). Using {min_required_seconds:.2f}s to satisfy windowing.")
    target_seconds = max(target_seconds_config, min_required_seconds)
    target_samples = int(target_seconds * SAMPLE_RATE)
    augment_copies = int(dataset_cfg.get("augmentCopies", 2))
    train_ratio = float(dataset_cfg.get("trainSplit", 0.85))

    try:
        from openwakeword import utils as oww_utils  # type: ignore
        oww_utils.download_models()
    except Exception as download_error:  # pragma: no cover
        progress("generating", 0.01, f"Warning: failed to verify OpenWakeWord resources ({download_error}); proceeding with existing files.")

    work_dir = Path(tempfile.mkdtemp(prefix=f"wakeword-{args.slug}-"))
    ensure_dir(work_dir)

    progress("generating", 0.05, "Generating positive samples")
    positive_samples, positive_stats = generate_positive_samples(
        args.wake_word,
        dataset_cfg.get("positive", {}),
        target_samples,
        work_dir,
        rng
    )
    pos_voice_summary = ", ".join(
        f"{voice_id}: {count}"
        for voice_id, count in sorted(positive_stats["voiceUsage"].items())
    ) or "—"
    progress(
        "generating",
        0.1,
        f"Positive samples ready ({positive_stats['totalSamples']} clips, synthetic {positive_stats['syntheticGenerated']}, user {positive_stats['userRecordings']}, voices {pos_voice_summary})",
        stats={
            "total": positive_stats["totalSamples"],
            "synthetic": positive_stats["syntheticGenerated"],
            "userRecordings": positive_stats["userRecordings"],
            "silenceBackfill": positive_stats["silenceBackfill"],
            "voiceUsage": positive_stats["voiceUsage"],
            "piperAttempts": positive_stats["piperAttempts"],
            "piperSucceeded": positive_stats["piperSucceeded"],
            "piperFailed": positive_stats["piperFailed"],
            "piperErrors": positive_stats["piperErrors"]
        }
    )
    progress("generating", 0.12, "Generating negative samples")
    negative_samples, negative_stats = generate_negative_samples(
        args.wake_word,
        dataset_cfg.get("negative", {}),
        target_samples,
        work_dir,
        rng
    )
    neg_voice_summary = ", ".join(
        f"{voice_id}: {count}"
        for voice_id, count in sorted(negative_stats["voiceUsage"].items())
    ) or "—"
    progress(
        "generating",
        0.16,
        f"Negative samples ready ({negative_stats['totalSamples']} clips, synthetic {negative_stats['syntheticGenerated']}, noise {negative_stats['noiseSamples']}, voices {neg_voice_summary})",
        stats={
            "total": negative_stats["totalSamples"],
            "synthetic": negative_stats["syntheticGenerated"],
            "backgroundClips": negative_stats["backgroundClips"],
            "noiseSamples": negative_stats["noiseSamples"],
            "voiceUsage": negative_stats["voiceUsage"],
            "piperAttempts": negative_stats["piperAttempts"],
            "piperSucceeded": negative_stats["piperSucceeded"],
            "piperFailed": negative_stats["piperFailed"],
            "piperErrors": negative_stats["piperErrors"]
        }
    )

    progress("generating", 0.22, "Applying augmentation")
    positive_samples = augment(positive_samples, augment_copies, rng)
    negative_samples = augment(negative_samples, max(1, augment_copies // 2), rng)
    progress(
        "generating",
        0.26,
        f"Augmentation complete (positive {len(positive_samples)}, negative {len(negative_samples)})"
    )

    progress("generating", 0.3, "Splitting dataset")
    pos_train, pos_val = split_dataset(positive_samples, train_ratio, rng)
    neg_train, neg_val = split_dataset(negative_samples, train_ratio, rng)

    progress("generating", 0.38, "Computing embeddings")
    pos_train_emb = embeddings_from_clips(pos_train, batch_size=64)
    pos_val_emb = embeddings_from_clips(pos_val, batch_size=64)
    neg_train_emb = embeddings_from_clips(neg_train, batch_size=64)
    neg_val_emb = embeddings_from_clips(neg_val, batch_size=64)

    progress("generating", 0.44, "Preparing windows")
    pos_train_windows, pos_train_labels = window_embeddings(pos_train_emb, 1)
    neg_train_windows, neg_train_labels = window_embeddings(neg_train_emb, 0)
    pos_val_windows, pos_val_labels = window_embeddings(pos_val_emb, 1)
    neg_val_windows, neg_val_labels = window_embeddings(neg_val_emb, 0)

    train_features = np.concatenate([pos_train_windows, neg_train_windows], axis=0)
    train_labels = np.concatenate([pos_train_labels, neg_train_labels], axis=0)
    val_features = np.concatenate([pos_val_windows, neg_val_windows], axis=0)
    val_labels = np.concatenate([pos_val_labels, neg_val_labels], axis=0)

    if train_features.shape[0] == 0 or train_labels.shape[0] == 0:
        detail_messages = []
        if positive_stats.get("piperErrors"):
            detail_messages.append(f"positive synthesis errors: {positive_stats['piperErrors']}")
        if negative_stats.get("piperErrors"):
            detail_messages.append(f"negative synthesis errors: {negative_stats['piperErrors']}")
        detail_suffix = ""
        if detail_messages:
            detail_suffix = " Details: " + "; ".join(detail_messages)
        raise ValueError(
            "Training dataset is empty. Counts — "
            f"positive clips {positive_stats['totalSamples']} (synthetic {positive_stats['syntheticGenerated']}, "
            f"user {positive_stats['userRecordings']}, voices {pos_voice_summary}), "
            f"negative clips {negative_stats['totalSamples']} (synthetic {negative_stats['syntheticGenerated']}, "
            f"background {negative_stats['backgroundClips']}, noise {negative_stats['noiseSamples']}, "
            f"voices {neg_voice_summary}); windowed frames positive {pos_train_windows.shape[0]}, "
            f"negative {neg_train_windows.shape[0]}. Try increasing the number or duration of samples, or ensure "
            "that generated clips meet the configured clip length."
            + detail_suffix
        )

    if val_features.shape[0] == 0 or val_labels.shape[0] == 0:
        raise ValueError(
            "Validation dataset is empty. Try increasing the dataset size or adjusting the train/validation split."
        )

    rng_np = np.random.default_rng(42)
    train_idx = rng_np.permutation(train_features.shape[0])
    val_idx = rng_np.permutation(val_features.shape[0])
    train_features, train_labels = train_features[train_idx], train_labels[train_idx]
    val_features, val_labels = val_features[val_idx], val_labels[val_idx]

    train_loader = DataLoader(WakeWordDataset(train_features, train_labels),
                              batch_size=int(options.get("training", {}).get("batchSize", 128)),
                              shuffle=True, num_workers=min(4, os.cpu_count() or 1))
    val_loader = DataLoader(WakeWordDataset(val_features, val_labels),
                            batch_size=int(options.get("training", {}).get("batchSize", 128)),
                            shuffle=False, num_workers=min(4, os.cpu_count() or 1))

    trainer = WakeWordTrainer(input_shape=train_features.shape[1:],
                              batch_size=int(options.get("training", {}).get("batchSize", 128)),
                              learning_rate=float(options.get("training", {}).get("learningRate", 1e-4)))

    metrics = trainer.fit(train_loader, val_loader, epochs=int(options.get("training", {}).get("epochs", 6)))

    progress("training", 0.74, "Evaluating thresholds")
    pos_scores = trainer.scores(pos_val_windows)
    neg_scores = trainer.scores(neg_val_windows)
    threshold = determine_threshold(pos_scores, neg_scores,
                                    target_fp_per_hour=float(options.get("training", {}).get("targetFalseActivationsPerHour", 0.2)))
    sensitivity = max(0.05, min(0.95, 1.0 - threshold))

    progress("exporting", 0.82, "Exporting artifacts")
    output_path = Path(args.output).resolve()
    artifacts = export_artifacts(trainer, output_path)

    shutil.rmtree(work_dir, ignore_errors=True)

    duration_ms = int((time.monotonic() - START_TIME) * 1000)
    return {
        "engine": "openwakeword",
        "format": "tflite" if any(a["format"] == "tflite" for a in artifacts) else artifacts[0]["format"],
        "output": str(output_path),
        "durationMs": duration_ms,
        "samplesGenerated": len(positive_samples),
        "metadata": {
            "threshold": threshold,
            "recommendedSensitivity": sensitivity,
            "training": metrics,
            "validation": {
                "positiveSamples": float(len(pos_scores)),
                "negativeSamples": float(len(neg_scores)),
                "falsePositiveRate": float((neg_scores >= threshold).mean() if neg_scores.size else 0.0),
                "falseNegativeRate": float((pos_scores < threshold).mean() if pos_scores.size else 0.0)
            },
            "artifacts": artifacts,
            "config": {
                "windowFrames": int(WINDOW_FRAMES),
                "clipDurationSecondsRequested": float(target_seconds_config),
                "effectiveClipDurationSeconds": float(target_seconds),
                "minRequiredClipDurationSeconds": float(min_required_seconds)
            }
        }
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train an OpenWakeWord model for a custom wake word.")
    parser.add_argument("--wake-word", required=True, help="Wake word phrase.")
    parser.add_argument("--slug", required=True, help="Slug identifier for filenames.")
    parser.add_argument("--output", required=True, help="Output TFLite path (ONNX exported alongside).")
    parser.add_argument("--config", help="Optional JSON configuration file.")
    parser.add_argument("--samples", type=int, help="Override positive synthetic sample count.")
    parser.add_argument("--language", help="Override default TTS language.")
    parser.add_argument("--tts-voice", help="Add a Piper voice model path.")
    return parser.parse_args()


def load_options(args: argparse.Namespace) -> Dict[str, object]:
    options: Dict[str, object] = {}
    if args.config:
        config_path = Path(args.config)
        if config_path.is_file():
            with config_path.open("r", encoding="utf-8") as handle:
                options = json.load(handle)
    if args.samples is not None:
        options.setdefault("dataset", {}).setdefault("positive", {})["syntheticSamples"] = args.samples
    if args.language:
        options.setdefault("dataset", {}).setdefault("positive", {}).setdefault("tts", {})["language"] = args.language
    if args.tts_voice:
        options.setdefault("dataset", {}).setdefault("positive", {}).setdefault("tts", {}).setdefault("voices", []).append({
            "modelPath": args.tts_voice,
            "name": Path(args.tts_voice).stem
        })
    return options


def main() -> None:
    global START_TIME
    START_TIME = time.monotonic()
    args = parse_args()
    options = load_options(args)
    try:
        result = run_pipeline(args, options)
        result_payload = {"type": "result", **result}
        print(json.dumps(result_payload), flush=True)
    except Exception as exc:  # pragma: no cover
        progress("error", 1.0, f"Wake word training failed: {exc}")
        raise


if __name__ == "__main__":
    main()
