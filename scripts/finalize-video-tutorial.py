#!/usr/bin/env python3
"""Create and verify the standard 1024x600 HomeBrain tutorial derivative."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


MASTER_SIZE = (1920, 1080)
DERIVATIVE_SIZE = (1024, 600)
EXPECTED_FPS = 30.0


class FinalizerError(RuntimeError):
    pass


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=True, text=True, capture_output=True)
    except FileNotFoundError as error:
        raise FinalizerError(f"Required executable is unavailable: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip() or "command failed"
        raise FinalizerError(detail) from error


def rate_to_float(value: str) -> float:
    numerator, separator, denominator = str(value).partition("/")
    if not separator:
        return float(numerator)
    denominator_value = float(denominator)
    if denominator_value == 0:
        return 0.0
    return float(numerator) / denominator_value


def probe(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size == 0:
        raise FinalizerError(f"Video does not exist or is empty: {path}")
    result = run([
        "ffprobe",
        "-v", "error",
        "-show_entries",
        "format=duration,size:stream=index,codec_name,codec_type,width,height,avg_frame_rate,pix_fmt,sample_rate,channels",
        "-of", "json",
        str(path),
    ])
    return json.loads(result.stdout)


def summarize(path: Path, data: dict) -> dict:
    streams = data.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not video:
        raise FinalizerError(f"No video stream found: {path}")
    if not audio:
        raise FinalizerError(f"No audio stream found: {path}")
    return {
        "path": str(path.resolve()),
        "width": int(video.get("width", 0)),
        "height": int(video.get("height", 0)),
        "fps": rate_to_float(video.get("avg_frame_rate", "0/1")),
        "video_codec": video.get("codec_name"),
        "pixel_format": video.get("pix_fmt"),
        "audio_codec": audio.get("codec_name"),
        "sample_rate": int(audio.get("sample_rate", 0)),
        "channels": int(audio.get("channels", 0)),
        "duration": float(data.get("format", {}).get("duration", 0)),
        "size": int(data.get("format", {}).get("size", 0)),
    }


def validate(summary: dict, expected_size: tuple[int, int], label: str) -> None:
    actual_size = (summary["width"], summary["height"])
    if actual_size != expected_size:
        raise FinalizerError(f"{label} must be {expected_size[0]}x{expected_size[1]}, found {actual_size[0]}x{actual_size[1]}")
    if abs(summary["fps"] - EXPECTED_FPS) > 0.01:
        raise FinalizerError(f"{label} must be 30 fps, found {summary['fps']:.4f}")
    if summary["video_codec"] != "h264":
        raise FinalizerError(f"{label} must use H.264 video, found {summary['video_codec']}")
    if summary["audio_codec"] != "aac":
        raise FinalizerError(f"{label} must use AAC audio, found {summary['audio_codec']}")


def verify(master: Path, output: Path) -> dict:
    master_summary = summarize(master, probe(master))
    output_summary = summarize(output, probe(output))
    validate(master_summary, MASTER_SIZE, "Master")
    validate(output_summary, DERIVATIVE_SIZE, "Derivative")
    if output_summary["pixel_format"] != "yuv420p":
        raise FinalizerError(f"Derivative must use yuv420p, found {output_summary['pixel_format']}")
    if abs(master_summary["duration"] - output_summary["duration"]) > 0.05:
        raise FinalizerError(
            f"Derivative duration drifted from {master_summary['duration']:.3f}s to {output_summary['duration']:.3f}s"
        )
    return {"master": master_summary, "derivative": output_summary, "verified": True}


def finalize(master: Path, output: Path) -> dict:
    master_summary = summarize(master, probe(master))
    validate(master_summary, MASTER_SIZE, "Master")
    output.parent.mkdir(parents=True, exist_ok=True)

    temporary = tempfile.NamedTemporaryFile(
        prefix=f".{output.stem}.", suffix=".mp4", dir=output.parent, delete=False
    )
    temporary_path = Path(temporary.name)
    temporary.close()

    try:
        run([
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-i", str(master),
            "-map", "0:v:0",
            "-map", "0:a:0",
            "-vf", "scale=1024:576:flags=lanczos,pad=1024:600:0:12:color=black,format=yuv420p",
            "-r", "30",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "18",
            "-profile:v", "high",
            "-level", "4.0",
            "-c:a", "copy",
            "-movflags", "+faststart",
            str(temporary_path),
        ])
        temporary_summary = summarize(temporary_path, probe(temporary_path))
        validate(temporary_summary, DERIVATIVE_SIZE, "Derivative")
        if abs(master_summary["duration"] - temporary_summary["duration"]) > 0.05:
            raise FinalizerError("Derivative duration does not match the master")
        os.replace(temporary_path, output)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()

    return verify(master, output)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("finalize", "verify"):
        subparser = subparsers.add_parser(command)
        subparser.add_argument("--master", required=True, type=Path)
        subparser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise FinalizerError("ffmpeg and ffprobe are required")
    result = finalize(args.master, args.output) if args.command == "finalize" else verify(args.master, args.output)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FinalizerError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
