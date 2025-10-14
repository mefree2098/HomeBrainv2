#!/usr/bin/env python3
"""
Convert an ONNX wake-word classifier exported by our trainer to TFLite.
Run this on any machine that has TensorFlow installed (x86_64 or ARM) and copy
resulting .tflite back to the hub.

Usage:
  python server/scripts/convert_to_tflite.py --onnx path/to/model.onnx --out path/to/model.tflite

If openwakeword with onnx->tflite helper is available, it will be used.
Otherwise, a minimal fallback converter via onnx-tf + TF's TFLiteConverter is attempted.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def convert_with_oww(onnx_path: str, out_path: str) -> bool:
    try:
        from openwakeword.train import convert_onnx_to_tflite  # type: ignore
    except Exception:
        return False
    try:
        convert_onnx_to_tflite(onnx_path, out_path)
        return True
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"[tflite] openwakeword conversion failed: {e}\n")
        return False


def convert_with_tf(onnx_path: str, out_path: str) -> bool:
    try:
        import onnx
        from onnx_tf.backend import prepare  # type: ignore
        import tensorflow as tf  # type: ignore
    except Exception as e:
        sys.stderr.write("[tflite] Missing deps. Install: pip install onnx onnx-tf tensorflow\n")
        sys.stderr.write(str(e) + "\n")
        return False

    try:
        model = onnx.load(onnx_path)
        tf_rep = prepare(model)  # convert to TF graph
        tmp_saved_model = Path(out_path).with_suffix(".savedmodel")
        if tmp_saved_model.exists():
            import shutil
            shutil.rmtree(tmp_saved_model)
        tf_rep.export_graph(str(tmp_saved_model))

        converter = tf.lite.TFLiteConverter.from_saved_model(str(tmp_saved_model))
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        tflite_model = converter.convert()
        Path(out_path).write_bytes(tflite_model)
        return True
    except Exception as e:
        sys.stderr.write(f"[tflite] Fallback TF conversion failed: {e}\n")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    onnx_path = os.path.abspath(args.onnx)
    out_path = os.path.abspath(args.out)

    if not os.path.isfile(onnx_path):
        sys.stderr.write(f"[tflite] ONNX file not found: {onnx_path}\n")
        return 2

    # Try openwakeword helper first
    if convert_with_oww(onnx_path, out_path):
        print(f"[tflite] Wrote {out_path}")
        return 0

    # Fallback via onnx-tf + TF
    if convert_with_tf(onnx_path, out_path):
        print(f"[tflite] Wrote {out_path}")
        return 0

    sys.stderr.write("[tflite] Conversion failed. Ensure TensorFlow is installed on this machine.\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
