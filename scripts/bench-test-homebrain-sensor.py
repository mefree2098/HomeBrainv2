#!/usr/bin/env python3
"""Run the production firmware's structured USB bench diagnostic."""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "embedded/homebrain-sensor"
SCHEMA = "homebrain.usb-diagnostic.v1"
EXPECTED_AIR_MODULES = {
    "bme680": ("i2c_ack", "reading_valid"),
    "scd41": ("i2c_ack", "reading_valid"),
    "veml7700": ("i2c_ack", "reading_valid"),
    "pms5003": ("checksum_valid_frame", "two_way_uart"),
}
EXPECTED_PROFILE_MODULES = {
    "air-station": EXPECTED_AIR_MODULES,
    "presence": {"dht11": ("reading_valid",), "ld2410": ("reading_valid",), "veml7700": ("i2c_ack", "reading_valid")},
    "climate": {"dht11": ("reading_valid",), "battery": ("reading_valid",)},
}


class BenchDiagnosticError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Exact serial port; auto-detects one /dev/cu.usbmodem* when omitted.")
    parser.add_argument("--profile", default="air-station", choices=tuple(EXPECTED_PROFILE_MODULES))
    parser.add_argument("--timeout", type=float, default=35.0)
    parser.add_argument("--flash", action="store_true", help="Build and flash the same production image before testing.")
    parser.add_argument("--json-output", type=Path, help="Optional path for the validated diagnostic JSON.")
    return parser.parse_args()


def resolve_port(explicit: str | None) -> str:
    if explicit:
        if not Path(explicit).exists():
            raise BenchDiagnosticError(f"Serial port does not exist: {explicit}")
        return explicit
    candidates = sorted(glob.glob("/dev/cu.usbmodem*"))
    if len(candidates) != 1:
        raise BenchDiagnosticError(
            f"Expected exactly one /dev/cu.usbmodem* device, found {len(candidates)}: {candidates}"
        )
    return candidates[0]


def platformio_python() -> str:
    completed = subprocess.run(
        ["pio", "system", "info", "--json-output"],
        check=True,
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    return json.loads(completed.stdout)["python_exe"]["value"]


def ensure_pyserial() -> None:
    try:
        import serial  # noqa: F401
        return
    except ModuleNotFoundError:
        if os.environ.get("HOMEBRAIN_BENCH_PIO_PYTHON") == "1":
            raise BenchDiagnosticError("PlatformIO's Python environment does not contain pyserial")
    environment = os.environ.copy()
    environment["HOMEBRAIN_BENCH_PIO_PYTHON"] = "1"
    os.execve(platformio_python(), [platformio_python(), str(Path(__file__).resolve()), *sys.argv[1:]], environment)


def flash_production_firmware(port: str) -> None:
    subprocess.run(
        ["pio", "run", "--target", "upload", "--upload-port", port],
        check=True,
        cwd=FIRMWARE,
    )


def extract_report(lines: list[str]) -> dict:
    for line in lines:
        candidate = line.strip()
        if not candidate.startswith("{"):
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if parsed.get("schema") == SCHEMA:
            return parsed
    raise BenchDiagnosticError("No structured HomeBrain USB diagnostic report was received")


def validate_report(report: dict, expected_profile: str) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != SCHEMA:
        errors.append("wrong schema")
    if report.get("profile") != expected_profile:
        errors.append(f"expected profile {expected_profile}, received {report.get('profile')}")
    modules = report.get("modules")
    if not isinstance(modules, dict):
        return [*errors, "missing modules object"]
    for module_name, checks in EXPECTED_PROFILE_MODULES.get(expected_profile, {}).items():
        module = modules.get(module_name)
        if not isinstance(module, dict):
            errors.append(f"{module_name}: missing result")
            continue
        for check in checks:
            if module.get(check) is not True:
                errors.append(f"{module_name}: {check} is not true")
    if expected_profile in ("presence", "climate"):
        dht = modules.get("dht11") or {}
        temperature = dht.get("temperature_c")
        humidity = dht.get("humidity_pct")
        if not isinstance(temperature, (int, float)) or isinstance(temperature, bool) \
                or not math.isfinite(temperature) or not 0.0 <= temperature <= 50.0:
            errors.append(f"dht11: implausible temperature {temperature!r} °C")
        if not isinstance(humidity, (int, float)) or isinstance(humidity, bool) \
                or not math.isfinite(humidity) or not 5.0 <= humidity <= 95.0:
            errors.append(f"dht11: implausible humidity {humidity!r} %")
    if expected_profile == "climate":
        battery = modules.get("battery") or {}
        voltage = battery.get("voltage_v")
        if not isinstance(voltage, (int, float)) or isinstance(voltage, bool) \
                or not math.isfinite(voltage) or not 2.5 <= voltage <= 4.3:
            errors.append(f"battery: implausible voltage {voltage!r} V")
    if report.get("passed") is not True:
        failures = report.get("failures", [])
        errors.append("firmware reported failure" + (f": {', '.join(failures)}" if failures else ""))
    return errors


def capture_report(port: str, profile: str, timeout: float) -> tuple[dict, list[str]]:
    import serial

    lines: list[str] = []
    command_sent = False
    deadline = time.monotonic() + timeout
    with serial.Serial(port, 115200, timeout=0.15) as connection:
        connection.dtr = False
        connection.rts = True
        time.sleep(0.12)
        connection.rts = False
        while time.monotonic() < deadline:
            raw = connection.readline()
            if not raw:
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            lines.append(line)
            print(line, file=sys.stderr)
            if "Unprovisioned USB window:" in line and not command_sent:
                connection.write(f"diag {profile}\n".encode())
                connection.flush()
                command_sent = True
            if line == "USB_DIAGNOSTIC_END":
                break
    return extract_report(lines), lines


def main() -> None:
    args = parse_args()
    ensure_pyserial()
    try:
        port = resolve_port(args.port)
        if args.flash:
            flash_production_firmware(port)
        report, _ = capture_report(port, args.profile, args.timeout)
        errors = validate_report(report, args.profile)
        rendered = json.dumps(report, indent=2, sort_keys=True)
        print(rendered)
        if args.json_output:
            args.json_output.parent.mkdir(parents=True, exist_ok=True)
            args.json_output.write_text(rendered + "\n")
        if errors:
            raise BenchDiagnosticError("; ".join(errors))
    except (BenchDiagnosticError, subprocess.CalledProcessError) as error:
        print(f"BENCH DIAGNOSTIC FAILED: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
