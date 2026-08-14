#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import plistlib
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("validate-ios-app-store-archive.py")
SPEC = importlib.util.spec_from_file_location("archive_validator", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot import {SCRIPT_PATH}")
archive_validator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = archive_validator
SPEC.loader.exec_module(archive_validator)


class FakeCommandRunner:
    def __init__(self, *, link_app_intents: bool = False, siri_entitlement: bool = False):
        self.link_app_intents = link_app_intents
        self.siri_entitlement = siri_entitlement

    def __call__(self, argv):
        if argv[0] == "otool":
            frameworks = "\t/System/Library/Frameworks/AppIntents.framework/AppIntents\n" if self.link_app_intents else ""
            return 0, f"{argv[-1]}:\n{frameworks}".encode()
        if argv[:2] == ["codesign", "-d"]:
            entitlements = {}
            if self.siri_entitlement:
                entitlements["com.apple.developer.siri"] = True
            return 0, plistlib.dumps(entitlements)
        if argv[:2] == ["codesign", "--verify"]:
            return 0, b""
        return 1, f"unexpected command: {argv}".encode()


class ArchiveValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.archive = Path(self.temporary_directory.name) / "HomeBrain.xcarchive"
        self.app = self.archive / "Products/Applications/HomeBrainApp.app"
        self.watch = self.app / "Watch/HomeBrainWatch.app"
        self.watch.mkdir(parents=True)

        self.write_plist(
            self.archive / "Info.plist",
            {
                "ApplicationProperties": {
                    "ApplicationPath": "Applications/HomeBrainApp.app",
                    "CFBundleShortVersionString": "1.0",
                    "CFBundleVersion": "12",
                }
            },
        )
        self.write_bundle(self.app, "HomeBrainApp")
        self.write_bundle(self.watch, "HomeBrainWatch")

    def tearDown(self):
        self.temporary_directory.cleanup()

    @staticmethod
    def write_plist(path: Path, value: dict):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            plistlib.dump(value, handle)

    def write_bundle(self, path: Path, executable: str):
        self.write_plist(
            path / "Info.plist",
            {
                "CFBundleExecutable": executable,
                "CFBundleShortVersionString": "1.0",
                "CFBundleVersion": "12",
            },
        )
        (path / executable).write_bytes(b"fixture")

    def validate(self, runner=None, build="12"):
        return archive_validator.validate_archive(
            self.archive,
            "1.0",
            build,
            runner or FakeCommandRunner(),
        )

    def test_valid_archive_passes_repeatably(self):
        first = self.validate()
        second = self.validate()
        self.assertTrue(first.ok, first.errors)
        self.assertEqual(first, second)
        self.assertEqual(first.bundle_count, 2)

    def test_wrong_build_fails(self):
        result = self.validate(build="13")
        self.assertFalse(result.ok)
        self.assertTrue(any("expected '13'" in error for error in result.errors))

    def test_app_intents_metadata_fails(self):
        (self.app / "Metadata.appintents").mkdir()
        result = self.validate()
        self.assertFalse(result.ok)
        self.assertTrue(any("Metadata.appintents" in error for error in result.errors))

    def test_app_intents_linkage_fails(self):
        result = self.validate(FakeCommandRunner(link_app_intents=True))
        self.assertFalse(result.ok)
        self.assertTrue(any("links an Intents framework" in error for error in result.errors))

    def test_siri_entitlement_fails(self):
        result = self.validate(FakeCommandRunner(siri_entitlement=True))
        self.assertFalse(result.ok)
        self.assertTrue(any("Siri entitlement" in error for error in result.errors))

    def test_intents_extension_fails(self):
        extension = self.app / "PlugIns/HomeBrainIntent.appex"
        self.write_plist(
            extension / "Info.plist",
            {
                "CFBundleExecutable": "HomeBrainIntent",
                "CFBundleVersion": "12",
                "NSExtension": {
                    "NSExtensionPointIdentifier": "com.apple.intents-service"
                },
            },
        )
        (extension / "HomeBrainIntent").write_bytes(b"fixture")
        result = self.validate()
        self.assertFalse(result.ok)
        self.assertTrue(any("Intents extension" in error for error in result.errors))


if __name__ == "__main__":
    unittest.main()
