#!/usr/bin/env python3
"""
Persistent transcription worker for HomeBrain Whisper integration.

The process receives JSON commands on stdin and writes JSON responses on stdout.
This keeps the model loaded in memory for fast, low-latency transcriptions.
"""

import argparse
import inspect
import json
import os
import queue
import sys
import threading
import time
import traceback
from pathlib import Path

try:
    from faster_whisper import WhisperModel, download_model
except ImportError:  # pragma: no cover - handled in caller
    WhisperModel = None  # type: ignore
    download_model = None  # type: ignore


def log(message: str) -> None:
    sys.stderr.write(f"[whisper_server] {message}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def ensure_model_available(model_name: str, download_dir: Path) -> None:
    if download_model is None:
        raise RuntimeError("faster-whisper is not installed")
    log(f"Ensuring model '{model_name}' is downloaded to {download_dir}")
    download_model(model_name, output_dir=str(download_dir))


def load_model(model_name: str, download_dir: Path, device: str, compute_type: str) -> WhisperModel:
    if WhisperModel is None:
        raise RuntimeError("faster-whisper is not installed")

    kwargs = {
        "device": device,
        "compute_type": compute_type,
        "download_root": str(download_dir)
    }
    log(
        f"Loading Whisper model '{model_name}' "
        f"(device={device}, compute_type={compute_type}, root={download_dir})"
    )
    started = time.time()
    model = WhisperModel(model_name, **kwargs)
    log(f"Model '{model_name}' loaded in {time.time() - started:.2f}s")
    return model


class CommandLoop:
    def __init__(self, model: WhisperModel, model_name: str, requested_device: str, requested_compute: str):
        self.model = model
        self.model_name = model_name
        self.device = requested_device
        self.compute_type = requested_compute
        try:
            self._transcribe_params = set(inspect.signature(self.model.transcribe).parameters.keys())
        except Exception:
            self._transcribe_params = None
        internal_model = getattr(model, "_model", None) or getattr(model, "model", None)
        if internal_model is not None:
            self.device = getattr(internal_model, "device", self.device)
            self.compute_type = getattr(internal_model, "compute_type", self.compute_type)
        self.device = (self.device or "cpu")
        self.compute_type = (self.compute_type or "float32")
        self.stdout_lock = threading.Lock()
        self.pending: "queue.Queue[dict]" = queue.Queue()
        self._running = True

    def start(self) -> None:
        reader_thread = threading.Thread(target=self._reader, daemon=True)
        reader_thread.start()

        while self._running:
            try:
                payload = self.pending.get(timeout=0.1)
            except queue.Empty:
                continue

            action = payload.get("action")
            if action == "transcribe":
                self._handle_transcribe(payload)
            elif action == "status":
                self._handle_status(payload)
            elif action == "shutdown":
                self._handle_shutdown(payload)
            else:
                self._emit_error(payload, f"Unknown action '{action}'")

    def _reader(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                log(f"Failed to decode JSON line: {line[:200]}")
                continue
            self.pending.put(payload)
        self.pending.put({"action": "shutdown", "id": "stdin-closed"})

    def _emit_error(self, payload: dict, message: str) -> None:
        response = {
            "id": payload.get("id"),
            "success": False,
            "error": message
        }
        if "action" in payload:
            response["action"] = payload["action"]
        emit(response)

    def _handle_transcribe(self, payload: dict) -> None:
        request_id = payload.get("id")
        file_path = payload.get("file")
        language = payload.get("language") or None
        translate = bool(payload.get("translate"))
        beam_size = payload.get("beam_size", 5)
        temperature = payload.get("temperature", 0.0)
        vad_filter = bool(payload.get("vad_filter", True))

        if not file_path:
            self._emit_error(payload, "Missing audio file path")
            return

        audio_path = Path(file_path)
        if not audio_path.exists():
            self._emit_error(payload, f"Audio file not found: {audio_path}")
            return

        log(
            f"Transcribing '{audio_path.name}' (language={language or 'auto'}, "
            f"translate={translate}, beam_size={beam_size})"
        )
        try:
            started = time.time()
            transcribe_kwargs = {
                "language": language,
                "beam_size": beam_size,
                "temperature": temperature,
                "vad_filter": vad_filter,
            }
            if translate:
                if self._transcribe_params and "task" in self._transcribe_params:
                    transcribe_kwargs["task"] = "translate"
                else:
                    transcribe_kwargs["translate"] = True
            else:
                if self._transcribe_params and "task" in self._transcribe_params:
                    transcribe_kwargs["task"] = "transcribe"
                else:
                    transcribe_kwargs["translate"] = False

            if self._transcribe_params:
                transcribe_kwargs = {
                    key: value for key, value in transcribe_kwargs.items()
                    if key in self._transcribe_params
                }

            segments, info = self.model.transcribe(
                str(audio_path),
                **transcribe_kwargs,
            )
            transcript = []
            segment_payload = []
            total_avg_logprob = 0.0
            segment_count = 0

            for segment in segments:
                text = segment.text.strip()
                transcript.append(text)
                segment_count += 1
                total_avg_logprob += segment.avg_logprob if segment.avg_logprob is not None else 0.0

                segment_payload.append(
                    {
                        "id": segment.id,
                        "seek": segment.seek,
                        "start": segment.start,
                        "end": segment.end,
                        "text": text,
                        "avg_logprob": segment.avg_logprob,
                        "no_speech_prob": segment.no_speech_prob,
                        "temperature": segment.temperature,
                        "compression_ratio": segment.compression_ratio,
                        "tokens": segment.tokens,
                        "words": [
                            {
                                "start": word.start,
                                "end": word.end,
                                "word": word.word,
                                "probability": word.probability
                            }
                            for word in (segment.words or [])
                        ],
                    }
                )

            duration = time.time() - started
            avg_logprob = None
            if segment_count > 0:
                avg_logprob = total_avg_logprob / segment_count

            response = {
                "id": request_id,
                "success": True,
                "device": self.device,
                "compute_type": self.compute_type,
                "text": "".join(transcript).strip(),
                "segments": segment_payload,
                "info": {
                    "language": info.language,
                    "language_probability": getattr(info, "language_probability", None),
                    "duration": info.duration,
                    "vad": vad_filter,
                    "model": self.model_name,
                    "processing_time": duration,
                    "avg_logprob": avg_logprob,
                    "device": self.device,
                    "compute_type": self.compute_type,
                }
            }
            emit(response)
        except Exception:  # pragma: no cover - runtime logging
            log(traceback.format_exc())
            self._emit_error(payload, "Transcription failed")

    def _handle_status(self, payload: dict) -> None:
        response = {
            "id": payload.get("id"),
            "success": True,
            "action": "status",
            "model": self.model_name,
            "device": self.device,
            "compute_type": self.compute_type
        }
        emit(response)

    def _handle_shutdown(self, payload: dict) -> None:
        response = {
            "id": payload.get("id"),
            "success": True,
            "action": "shutdown"
        }
        emit(response)
        self._running = False


def main() -> int:
    parser = argparse.ArgumentParser(description="HomeBrain Whisper transcription worker")
    parser.add_argument("--model", default="small", help="Whisper model size (tiny, base, small, medium, large-v2, etc.)")
    parser.add_argument("--model-dir", required=True, help="Directory to store/download models")
    parser.add_argument("--device", default=os.environ.get("WHISPER_DEVICE", "auto"), help="Device to run on (cuda, cpu, auto)")
    parser.add_argument("--compute-type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "float16"), help="Compute precision for CTranslate2")
    parser.add_argument("--preload", action="store_true", help="Download model if needed before serving")

    args = parser.parse_args()
    model_dir = Path(args.model_dir).expanduser().resolve()
    model_dir.mkdir(parents=True, exist_ok=True)

    if args.preload:
        try:
            ensure_model_available(args.model, model_dir)
        except Exception as preload_error:  # pragma: no cover - runtime logging
            log(f"Failed to preload model '{args.model}': {preload_error}")
            emit({
                "id": None,
                "success": False,
                "error": f"Failed to preload model: {preload_error}"
            })
            return 1

    try:
        model = load_model(args.model, model_dir, args.device, args.compute_type)
    except Exception as load_error:  # pragma: no cover
        log(f"Unable to load model '{args.model}': {load_error}")
        emit({
            "id": None,
            "success": False,
            "error": f"Failed to load model '{args.model}': {load_error}"
        })
        return 1

    loop = CommandLoop(model, args.model, args.device, args.compute_type)
    try:
        loop.start()
    except KeyboardInterrupt:
        log("Keyboard interrupt - shutting down")
    except Exception:  # pragma: no cover
        log("Fatal error in command loop:\n" + traceback.format_exc())
        return 1
    finally:
        if hasattr(model, "release"):
            try:
                model.release()
            except Exception:
                log("Failed to release model resources")
    return 0


if __name__ == "__main__":
    sys.exit(main())
