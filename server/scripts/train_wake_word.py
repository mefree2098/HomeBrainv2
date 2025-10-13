#!/usr/bin/env python3
"""
HomeBrain OpenWakeWord training helper.

Attempts to train an OpenWakeWord model for a custom phrase. The script first tries
to invoke the Python API (if available), falling back to the command line interface.

On success, JSON metadata is written to stdout. On failure, stderr contains a message
and the exit code will be non-zero.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Train an OpenWakeWord model for a custom wake word.")
    parser.add_argument("--wake-word", required=True, help="Wake word phrase to train (e.g., 'Anna').")
    parser.add_argument("--slug", required=True, help="Slugified identifier for the wake word (e.g., 'anna').")
    parser.add_argument("--output", required=True, help="Path to the output model file (.tflite or .onnx).")
    parser.add_argument("--format", default="tflite", choices=["tflite", "onnx"], help="Output model format.")
    parser.add_argument("--language", help="Language code for synthetic samples (if supported).")
    parser.add_argument("--tts-voice", help="Preferred TTS voice identifier for synthetic data generation.")
    parser.add_argument("--samples", type=int, help="Number of synthetic samples to generate, if supported.")
    return parser.parse_args()


def ensure_parent_directory(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)


def try_python_api(args, work_dir: Path):
    """
    Attempt to train using the Python API if available.
    Returns (success: bool, metadata_or_error: dict or str)
    """
    try:
        from openwakeword import training as oww_training  # type: ignore
    except ImportError:
        return False, "openwakeword Python training API not available"

    phrase = args.wake_word
    output_path = Path(args.output)
    ensure_parent_directory(output_path)

    start = time.time()

    try:
        if hasattr(oww_training, "train_keyword"):
            kwargs = {
                "keyword": phrase,
                "output_path": str(output_path),
                "format": args.format
            }
            if args.language:
                kwargs["language"] = args.language
            if args.tts_voice:
                kwargs["voice"] = args.tts_voice
            if args.samples:
                kwargs["sample_count"] = args.samples

            result = oww_training.train_keyword(**kwargs)
            metadata = result if isinstance(result, dict) else {}
        elif hasattr(oww_training, "KeywordTrainer"):
            trainer = oww_training.KeywordTrainer(
                keyword=phrase,
                output_dir=str(work_dir),
                output_format=args.format
            )
            if args.language and hasattr(trainer, "language"):
                trainer.language = args.language
            if args.tts_voice and hasattr(trainer, "tts_voice"):
                trainer.tts_voice = args.tts_voice
            if args.samples and hasattr(trainer, "sample_count"):
                trainer.sample_count = args.samples

            trainer.train()
            produced = next(work_dir.glob(f"*.*"), None)
            if not produced:
                return False, "Trainer completed but no model was produced"
            produced.rename(output_path)
            metadata = {}
        else:
            return False, "Unsupported openwakeword training API version"
    except Exception as error:  # pylint: disable=broad-except
        return False, f"Python training API failed: {error}"

    duration = int((time.time() - start) * 1000)

    return True, {
        "engine": "openwakeword",
        "format": args.format,
        "output": str(output_path),
        "durationMs": duration,
        "metadata": metadata
    }


def try_cli(args, work_dir: Path):
    """
    Attempt to train using the openwakeword CLI if available.
    Returns (success: bool, metadata_or_error: dict or str)
    """
    cli_executable_candidates = ["openwakeword", "openwakeword-train", "oww"]
    cli_path = None
    for executable in cli_executable_candidates:
        cli_path = shutil.which(executable)
        if cli_path:
            break
    if not cli_path:
        return False, "openwakeword CLI not found; install the openwakeword package with training extras"

    output_path = Path(args.output)
    ensure_parent_directory(output_path)

    command = [cli_path, "train", "--wake-word", args.wake_word, "--output", str(output_path), "--format", args.format]

    if args.language:
        command.extend(["--language", args.language])
    if args.tts_voice:
        command.extend(["--tts-voice", args.tts_voice])
    if args.samples:
        command.extend(["--samples", str(args.samples)])

    start = time.time()

    try:
        completed = subprocess.run(
            command,
            cwd=str(work_dir),
            capture_output=True,
            text=True,
            check=False
        )
    except Exception as error:  # pylint: disable=broad-except
        return False, f"Failed to launch openwakeword CLI: {error}"

    if completed.returncode != 0:
        error_message = completed.stderr.strip() or completed.stdout.strip() or f"CLI exited with code {completed.returncode}"
        return False, error_message

    duration = int((time.time() - start) * 1000)

    metadata = {}
    try:
        metadata = json.loads(completed.stdout) if completed.stdout.strip().startswith("{") else {}
    except json.JSONDecodeError:
        metadata = {"rawOutput": completed.stdout.strip()}

    return True, {
        "engine": "openwakeword",
        "format": args.format,
        "output": str(output_path),
        "durationMs": duration,
        "metadata": metadata
    }


def main():
    args = parse_args()
    output_path = Path(args.output)
    ensure_parent_directory(output_path)

    with tempfile.TemporaryDirectory(prefix="wakeword-training-") as temp_dir:
        work_dir = Path(temp_dir)

        success, payload = try_python_api(args, work_dir)
        if not success:
            success, payload = try_cli(args, work_dir)

        if not success:
            print(payload, file=sys.stderr)
            sys.exit(3)

        # Ensure the output file exists
        if not output_path.exists():
            print(f"Expected model output at {output_path} was not created", file=sys.stderr)
            sys.exit(4)

        print(json.dumps(payload))


if __name__ == "__main__":
    main()
