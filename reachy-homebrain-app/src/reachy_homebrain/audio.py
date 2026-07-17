"""Reachy microphone conversion and bounded command pre-roll buffering."""

from __future__ import annotations

from collections import deque
from collections.abc import Iterable
from threading import Lock
from typing import Any

import numpy as np
import numpy.typing as npt


class AudioFormatError(ValueError):
    """A microphone frame cannot be safely converted for HomeBrain."""


def normalize_float_audio(samples: Any) -> npt.NDArray[np.float32]:
    """Return mono float32 audio from mono or channel-first/last Reachy samples."""

    try:
        frame = np.asarray(samples, dtype=np.float32)
    except (TypeError, ValueError) as exc:
        raise AudioFormatError("audio samples must be numeric") from exc
    if frame.size == 0:
        return np.empty(0, dtype=np.float32)
    if frame.ndim == 1:
        mono = frame
    elif frame.ndim == 2:
        if 1 <= frame.shape[1] <= 8:
            mono = frame.mean(axis=1, dtype=np.float32)
        elif 1 <= frame.shape[0] <= 8:
            mono = frame.mean(axis=0, dtype=np.float32)
        else:
            raise AudioFormatError("unable to identify the audio channel dimension")
    else:
        raise AudioFormatError("audio samples must be one- or two-dimensional")
    return np.nan_to_num(mono, nan=0.0, posinf=1.0, neginf=-1.0).astype(np.float32, copy=False)


def float_audio_to_pcm16_mono(
    samples: Any,
    *,
    input_sample_rate: int = 16_000,
    target_sample_rate: int = 16_000,
) -> bytes:
    """Downmix Reachy's float stereo stream to HomeBrain's 16 kHz mono S16LE."""

    if input_sample_rate != target_sample_rate:
        raise AudioFormatError(
            f"resampling is intentionally unavailable ({input_sample_rate} != {target_sample_rate})"
        )
    mono = normalize_float_audio(samples)
    if not mono.size:
        return b""
    clipped = np.clip(mono, -1.0, 1.0)
    scaled = np.rint(clipped * 32_767.0)
    scaled = np.where(clipped <= -1.0, -32_768.0, scaled)
    return scaled.astype("<i2", copy=False).tobytes()


class PcmRingBuffer:
    """Thread-safe, byte-bounded PCM pre-roll buffer."""

    def __init__(self, max_bytes: int):
        if max_bytes < 0:
            raise ValueError("max_bytes must be non-negative")
        self.max_bytes = max_bytes
        self._chunks: deque[bytes] = deque()
        self._size = 0
        self._lock = Lock()

    def append(self, chunk: bytes | bytearray | memoryview) -> None:
        data = bytes(chunk)
        if not data or self.max_bytes == 0:
            return
        if len(data) >= self.max_bytes:
            data = data[-self.max_bytes :]
            with self._lock:
                self._chunks.clear()
                self._chunks.append(data)
                self._size = len(data)
            return
        with self._lock:
            self._chunks.append(data)
            self._size += len(data)
            while self._size > self.max_bytes and self._chunks:
                overflow = self._size - self.max_bytes
                first = self._chunks[0]
                if len(first) <= overflow:
                    self._chunks.popleft()
                    self._size -= len(first)
                else:
                    self._chunks[0] = first[overflow:]
                    self._size -= overflow

    def snapshot(self) -> bytes:
        with self._lock:
            return b"".join(self._chunks)

    def clear(self) -> None:
        with self._lock:
            self._chunks.clear()
            self._size = 0

    def extend(self, chunks: Iterable[bytes]) -> None:
        for chunk in chunks:
            self.append(chunk)

    def __len__(self) -> int:
        with self._lock:
            return self._size
