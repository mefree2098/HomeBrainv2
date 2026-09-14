#!/usr/bin/env python3
"""Behavioral tests for the HomeBrain USB bench-report parser and oracle."""

from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).with_name("bench-test-homebrain-sensor.py")
SPEC = importlib.util.spec_from_file_location("homebrain_bench", SCRIPT)
assert SPEC and SPEC.loader
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)


PASS_REPORT = {
    "schema": bench.SCHEMA,
    "profile": "air-station",
    "modules": {
        "bme680": {"i2c_ack": True, "reading_valid": True},
        "scd41": {"i2c_ack": True, "reading_valid": True},
        "veml7700": {"i2c_ack": True, "reading_valid": True},
        "pms5003": {"checksum_valid_frame": True, "two_way_uart": True},
    },
    "failures": [],
    "passed": True,
}


def main() -> None:
    line = "noise\n" + __import__("json").dumps(PASS_REPORT) + "\nUSB_DIAGNOSTIC_END\n"
    parsed = bench.extract_report(line.splitlines())
    assert parsed == PASS_REPORT
    assert bench.validate_report(parsed, "air-station") == []

    failed = {**PASS_REPORT, "passed": False, "failures": ["scd41-no-i2c-ack"]}
    failed["modules"] = {name: dict(values) for name, values in PASS_REPORT["modules"].items()}
    failed["modules"]["scd41"]["i2c_ack"] = False
    errors = bench.validate_report(failed, "air-station")
    assert "scd41: i2c_ack is not true" in errors
    assert any("firmware reported failure" in error for error in errors)

    try:
        bench.extract_report(["not json", '{"schema":"unrelated"}'])
    except bench.BenchDiagnosticError:
        pass
    else:
        raise AssertionError("missing report must fail")

    print("USB bench diagnostic parser/oracle tests passed")


if __name__ == "__main__":
    main()
