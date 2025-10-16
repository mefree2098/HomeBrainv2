#!/usr/bin/env python3
"""
Utility script to pre-download Whisper models using faster-whisper.
"""

import argparse
import sys
from pathlib import Path

try:
    from faster_whisper import download_model
except ImportError:
    print("faster-whisper is not installed. Please install it before downloading models.", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Whisper model files")
    parser.add_argument("--model", required=True, help="Model name (e.g., tiny, base, small, medium)")
    parser.add_argument("--output-dir", required=True, help="Directory where the model should be stored")
    args = parser.parse_args()

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Downloading Whisper model '{args.model}' to {output_dir}")
    download_model(args.model, output_dir=str(output_dir))
    print("Download complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
