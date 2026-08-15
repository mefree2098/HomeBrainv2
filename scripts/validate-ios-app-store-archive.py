#!/usr/bin/env python3
"""Validate a HomeBrain iOS archive before App Store submission."""

from __future__ import annotations

import argparse
import json
import plistlib
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence


CommandRunner = Callable[[Sequence[str]], tuple[int, bytes]]


@dataclass(frozen=True)
class ValidationResult:
    archive: str
    app: str
    version: str | None
    build: str | None
    bundle_count: int
    errors: tuple[str, ...]

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "archive": self.archive,
            "app": self.app,
            "version": self.version,
            "build": self.build,
            "bundle_count": self.bundle_count,
            "errors": list(self.errors),
        }


def run_command(argv: Sequence[str]) -> tuple[int, bytes]:
    completed = subprocess.run(
        list(argv),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return completed.returncode, completed.stdout


def load_plist(path: Path) -> dict[str, object]:
    with path.open("rb") as handle:
        value = plistlib.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected a dictionary plist at {path}")
    return value


def extract_entitlements(output: bytes) -> dict[str, object]:
    start = output.find(b"<?xml")
    end_marker = b"</plist>"
    end = output.find(end_marker, start)
    if start < 0 or end < 0:
        return {}
    value = plistlib.loads(output[start : end + len(end_marker)])
    return value if isinstance(value, dict) else {}


def iter_plist_keys(value: object, prefix: str = ""):
    if isinstance(value, dict):
        for key, child in value.items():
            key_text = str(key)
            path = f"{prefix}.{key_text}" if prefix else key_text
            yield path
            yield from iter_plist_keys(child, path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from iter_plist_keys(child, f"{prefix}[{index}]")


def validate_archive(
    archive: Path,
    expected_version: str,
    expected_build: str,
    command_runner: CommandRunner = run_command,
) -> ValidationResult:
    archive = archive.resolve()
    errors: list[str] = []
    app_path = Path()
    version: str | None = None
    build: str | None = None

    if not archive.is_dir() or archive.suffix != ".xcarchive":
        return ValidationResult(
            str(archive),
            "",
            None,
            None,
            0,
            (f"archive does not exist or is not an .xcarchive directory: {archive}",),
        )

    archive_info_path = archive / "Info.plist"
    try:
        archive_info = load_plist(archive_info_path)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        return ValidationResult(
            str(archive), "", None, None, 0, (f"cannot read archive Info.plist: {error}",)
        )

    properties = archive_info.get("ApplicationProperties")
    if not isinstance(properties, dict):
        return ValidationResult(
            str(archive), "", None, None, 0, ("archive has no ApplicationProperties",)
        )

    application_path = properties.get("ApplicationPath")
    if not isinstance(application_path, str) or not application_path:
        return ValidationResult(
            str(archive), "", None, None, 0, ("archive has no ApplicationPath",)
        )

    app_path = archive / "Products" / application_path
    app_info_path = app_path / "Info.plist"
    try:
        app_info = load_plist(app_info_path)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        return ValidationResult(
            str(archive), str(app_path), None, None, 0, (f"cannot read app Info.plist: {error}",)
        )

    version = str(app_info.get("CFBundleShortVersionString", "")) or None
    build = str(app_info.get("CFBundleVersion", "")) or None
    archive_version = str(properties.get("CFBundleShortVersionString", "")) or None
    archive_build = str(properties.get("CFBundleVersion", "")) or None

    if version != expected_version:
        errors.append(f"app version is {version!r}; expected {expected_version!r}")
    if build != expected_build:
        errors.append(f"app build is {build!r}; expected {expected_build!r}")
    if archive_version != expected_version:
        errors.append(
            f"archive version is {archive_version!r}; expected {expected_version!r}"
        )
    if archive_build != expected_build:
        errors.append(f"archive build is {archive_build!r}; expected {expected_build!r}")

    forbidden_payloads = sorted(app_path.rglob("Metadata.appintents"))
    forbidden_payloads.extend(sorted(app_path.rglob("*.intentdefinition")))
    for payload in forbidden_payloads:
        errors.append(f"forbidden Intents payload found: {payload.relative_to(app_path)}")

    bundle_paths = sorted(
        {app_path, *app_path.rglob("*.app"), *app_path.rglob("*.appex")},
        key=lambda path: str(path),
    )

    for bundle_path in bundle_paths:
        info_path = bundle_path / "Info.plist"
        try:
            info = load_plist(info_path)
        except (OSError, ValueError, plistlib.InvalidFileException) as error:
            errors.append(f"cannot read bundle Info.plist at {bundle_path}: {error}")
            continue

        bundle_build = str(info.get("CFBundleVersion", "")) or None
        if bundle_build != expected_build:
            errors.append(
                f"bundle {bundle_path.name} build is {bundle_build!r}; expected {expected_build!r}"
            )

        intent_keys = sorted(key for key in iter_plist_keys(info) if "intent" in key.lower())
        for key in intent_keys:
            errors.append(f"bundle {bundle_path.name} declares Intents-related key {key}")

        if bundle_path.suffix == ".appex":
            extension = info.get("NSExtension")
            point = extension.get("NSExtensionPointIdentifier") if isinstance(extension, dict) else None
            if isinstance(point, str) and "intent" in point.lower():
                errors.append(
                    f"bundle {bundle_path.name} is an Intents extension ({point})"
                )

        executable_name = info.get("CFBundleExecutable")
        if isinstance(executable_name, str) and executable_name:
            executable_path = bundle_path / executable_name
            returncode, output = command_runner(["otool", "-L", str(executable_path)])
            if returncode != 0:
                errors.append(
                    f"otool failed for {executable_path}: {output.decode(errors='replace').strip()}"
                )
            else:
                linked = output.decode(errors="replace").lower()
                if "appintents.framework" in linked or "/intents.framework" in linked:
                    errors.append(f"bundle {bundle_path.name} links an Intents framework")

        returncode, output = command_runner(
            ["codesign", "-d", "--entitlements", ":-", str(bundle_path)]
        )
        if returncode != 0:
            errors.append(
                f"cannot inspect entitlements for {bundle_path}: "
                f"{output.decode(errors='replace').strip()}"
            )
        else:
            try:
                entitlements = extract_entitlements(output)
            except plistlib.InvalidFileException as error:
                errors.append(f"invalid entitlements for {bundle_path}: {error}")
            else:
                if entitlements.get("com.apple.developer.siri"):
                    errors.append(f"bundle {bundle_path.name} has the Siri entitlement")

    returncode, output = command_runner(
        ["codesign", "--verify", "--deep", "--strict", str(app_path)]
    )
    if returncode != 0:
        errors.append(
            "archive signature verification failed: "
            f"{output.decode(errors='replace').strip()}"
        )

    return ValidationResult(
        str(archive),
        str(app_path),
        version,
        build,
        len(bundle_paths),
        tuple(errors),
    )


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate an iOS .xcarchive and reject any Siri/App Intents integration."
    )
    parser.add_argument("archive", type=Path, help="Path to the .xcarchive directory")
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--expected-build", required=True)
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    result = validate_archive(args.archive, args.expected_version, args.expected_build)
    if args.json_output:
        print(json.dumps(result.as_dict(), indent=2, sort_keys=True))
    elif result.ok:
        print(
            f"PASS: {result.archive} is version {result.version} build {result.build}; "
            f"validated {result.bundle_count} signed app bundle(s) with no Siri/App Intents integration."
        )
    else:
        print(f"FAIL: {result.archive}", file=sys.stderr)
        for error in result.errors:
            print(f"- {error}", file=sys.stderr)
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
