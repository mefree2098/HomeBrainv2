"""Device-authenticated HomeBrain TTS retrieval and Reachy SDK playback."""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import tempfile
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .config import HomeBrainConfig
from .http_security import default_no_redirect_opener


class TtsError(RuntimeError):
    """TTS could not be retrieved or safely played."""


class TtsCancelled(TtsError):
    """A stop command invalidated queued or downloading TTS."""


_VOICE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_MAX_TTS_BYTES = 20 * 1024 * 1024


def _audio_suffix(data: bytes, content_type: str) -> str:
    normalized = content_type.lower().split(";", 1)[0].strip()
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return ".wav"
    if data.startswith(b"OggS"):
        return ".ogg"
    if data.startswith(b"fLaC"):
        return ".flac"
    if data.startswith(b"ID3") or data[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
        return ".mp3"
    by_type = {
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/mpeg": ".mp3",
    }
    suffix = by_type.get(normalized)
    if suffix is None:
        raise TtsError("HomeBrain returned an unsupported audio format")
    return suffix


class TtsPlayer:
    """Serialize TTS, retain files for asynchronous GStreamer reads, and clean them on stop."""

    def __init__(
        self,
        config: HomeBrainConfig,
        robot: Any,
        *,
        opener: Callable[..., Any] | None = None,
        timeout_s: float = 20.0,
        temp_root: str | Path | None = None,
    ):
        self.config = config
        self.robot = robot
        self.opener = opener or default_no_redirect_opener()
        self.timeout_s = timeout_s
        self._lock = threading.Lock()
        self._playback_gate = threading.Lock()
        self._cancel_generation = 0
        self._closed = False
        self._owned_temp = temp_root is None
        self.temp_dir = Path(tempfile.mkdtemp(prefix="homebrain-tts-") if temp_root is None else temp_root)
        self.temp_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self.temp_dir, 0o700)
        self._files: list[Path] = []

    def generation(self) -> int:
        with self._playback_gate:
            return self._cancel_generation

    def invalidate(self) -> int:
        """Invalidate admitted TTS without waiting for a network fetch or player call."""

        with self._playback_gate:
            self._cancel_generation += 1
            return self._cancel_generation

    def play(
        self,
        text: str,
        voice: str = "default",
        *,
        expected_generation: int | None = None,
    ) -> dict[str, Any]:
        text = str(text).strip()
        voice = str(voice or "default").strip()
        if not 1 <= len(text) <= 1_000:
            raise TtsError("TTS text must contain 1 to 1000 characters")
        if voice != "default" and not _VOICE_RE.fullmatch(voice):
            raise TtsError("TTS voice id is malformed")
        if not self.config.device_token:
            raise TtsError("device token is required for TTS")
        with self._lock:
            if self._closed:
                raise TtsError("TTS player is closed")
            request = urllib.request.Request(
                self.config.tts_url(),
                data=json.dumps(
                    {"text": text, **({"voiceId": voice} if voice != "default" else {})}
                ).encode(),
                method="POST",
                headers={
                    **self.config.auth_headers(),
                    "Accept": "audio/*",
                    "Content-Type": "application/json",
                },
            )
            try:
                with self.opener(request, timeout=self.timeout_s) as response:
                    final_url = (
                        response.geturl() if callable(getattr(response, "geturl", None)) else request.full_url
                    )
                    if final_url != request.full_url:
                        raise TtsError("HomeBrain TTS redirects are forbidden")
                    content_length = response.headers.get("Content-Length")
                    if content_length:
                        try:
                            if int(content_length) > _MAX_TTS_BYTES:
                                raise TtsError("HomeBrain TTS exceeded the safety limit")
                        except ValueError as exc:
                            raise TtsError("HomeBrain TTS content length is invalid") from exc
                    data = response.read(_MAX_TTS_BYTES + 1)
                    content_type = response.headers.get("Content-Type", "")
                    if not content_type.lower().split(";", 1)[0].strip().startswith("audio/"):
                        raise TtsError("HomeBrain TTS response must have an audio Content-Type")
            except TtsError:
                raise
            except urllib.error.HTTPError as exc:
                raise TtsError(f"HomeBrain TTS was rejected with HTTP {exc.code}") from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                raise TtsError("unable to retrieve HomeBrain TTS") from exc
            if not data:
                raise TtsError("HomeBrain returned empty TTS audio")
            if len(data) > _MAX_TTS_BYTES:
                raise TtsError("HomeBrain TTS exceeded the safety limit")
            suffix = _audio_suffix(data, content_type)
            descriptor, raw_path = tempfile.mkstemp(prefix="tts-", suffix=suffix, dir=self.temp_dir)
            path = Path(raw_path)
            try:
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                media = getattr(self.robot, "media", None)
                play_sound = getattr(media, "play_sound", None)
                if not callable(play_sound):
                    raise TtsError("Reachy media playback is unavailable")
                with self._playback_gate:
                    if expected_generation is not None and expected_generation != self._cancel_generation:
                        raise TtsCancelled("TTS was cancelled by a stop command")
                    play_sound(str(path))
                self._files.append(path)
                self._trim_files()
                return {"played": True, "bytes": len(data), "format": suffix[1:]}
            except Exception:
                with contextlib.suppress(OSError):
                    path.unlink()
                raise

    def _trim_files(self) -> None:
        # GStreamer may open files asynchronously. Retain a small bounded window rather than
        # deleting the active file immediately after play_sound returns.
        while len(self._files) > 8:
            old = self._files.pop(0)
            with contextlib.suppress(OSError):
                old.unlink()

    def stop(self) -> None:
        with self._playback_gate:
            self._cancel_generation += 1
            media = getattr(self.robot, "media", None)
            stop_playing = getattr(media, "stop_playing", None)
            errors: list[Exception] = []
            if callable(stop_playing):
                try:
                    stop_playing()
                except Exception as exc:
                    errors.append(exc)
            else:
                clear = getattr(media, "clear_player", None)
                if callable(clear):
                    try:
                        clear()
                    except Exception as exc:
                        errors.append(exc)
            disable = getattr(self.robot, "disable_wobbling", None)
            if callable(disable):
                try:
                    disable()
                except Exception as exc:
                    errors.append(exc)
            if errors:
                raise TtsError("Reachy TTS playback or wobbling could not be stopped") from errors[0]

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            with contextlib.suppress(Exception):
                self.stop()
            disable = getattr(self.robot, "disable_wobbling", None)
            if callable(disable):
                with contextlib.suppress(Exception):
                    disable()
            for path in self._files:
                with contextlib.suppress(OSError):
                    path.unlink()
            self._files.clear()
            if self._owned_temp:
                shutil.rmtree(self.temp_dir, ignore_errors=True)
