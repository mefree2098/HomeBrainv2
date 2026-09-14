#!/usr/bin/env python3
"""Prove the HomeBrain carrier verifier rejects a reversed keyed UART port."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESIGN = ROOT / "hardware/homebrain-sensors/carrier/carrier-design.json"
FIXTURE = ROOT / "hardware/homebrain-sensors/carrier/fixtures/reversed-uart.json"
OUTPUT = ROOT / "hardware/homebrain-sensors/carrier/generated"
VERIFIER = ROOT / "scripts/verify-homebrain-carrier.py"


def main() -> int:
    design = json.loads(DESIGN.read_text(encoding="utf-8"))
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    part = next(item for item in design["parts"] if item["ref"] == fixture["part"])
    part[fixture["field"]] = fixture["value"]
    with tempfile.TemporaryDirectory(prefix="homebrain-carrier-negative-") as temporary:
        mutated = Path(temporary) / "reversed-uart.json"
        mutated.write_text(json.dumps(design, indent=2) + "\n", encoding="utf-8")
        result = subprocess.run(
            ["python3", str(VERIFIER), "--design", str(mutated), "--output", str(OUTPUT)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if result.returncode == 0:
        raise AssertionError("Verifier accepted a reversed keyed UART port")
    if fixture["expected_error"] not in result.stdout:
        raise AssertionError(f"Verifier failed for the wrong reason:\n{result.stdout}")
    print("PASS: reversed keyed UART fixture was rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
