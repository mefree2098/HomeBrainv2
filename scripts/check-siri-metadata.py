#!/usr/bin/env python3
"""Require compiled Siri metadata in the iOS, embedded Watch, and standalone Watch apps."""
import json
import os
import pathlib
import plistlib
import sys

INTENTS = (
    "TurnOnHomeBrainLightsIntent", "TurnOffHomeBrainLightsIntent",
    "SetHomeBrainBrightnessIntent", "RunHomeBrainWorkflowIntent", "ActivateHomeBrainSceneIntent",
)
IOS_BUNDLE = "NTechR.HomeBrainApp"
WATCH_BUNDLE = "NTechR.HomeBrainApp.watchkitapp"


def check(root: pathlib.Path, expected_bundles: set[str]) -> None:
    found = set()
    for app in root.rglob("*.app"):
        info_path = app / "Info.plist"
        if not info_path.is_file():
            continue
        info = plistlib.loads(info_path.read_bytes())
        bundle = info.get("CFBundleIdentifier")
        if bundle not in expected_bundles:
            continue
        metadata = app / "Metadata.appintents"
        # Xcode writes extract.actionsdata, not a file simply named actionsdata.
        # Retain compatibility with toolchains using the unprefixed filename.
        candidates = [metadata / "extract.actionsdata", metadata / "actionsdata"]
        path = next((candidate for candidate in candidates if candidate.is_file()), None)
        if path is None:
            raise RuntimeError(f"{app}: missing compiled App Intents metadata")
        raw = path.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise RuntimeError(f"{path}: invalid App Intents metadata object")
        missing = [name for name in INTENTS if name not in raw]
        if missing:
            raise RuntimeError(f"{path}: missing compiled intent identifiers {missing}")
        found.add(bundle)
        print(f"PASS five compiled Siri intents for {bundle}: {path}", flush=True)
        # Preserve the actual compiler output alongside CI logs for independent inspection.
        if os.environ.get("RUNNER_TEMP"):
            evidence = pathlib.Path(os.environ["RUNNER_TEMP"]) / "siri-evidence" / "metadata"
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / f"{root.parent.parent.name}-{bundle}.json").write_text(raw, encoding="utf-8")
    missing_bundles = expected_bundles - found
    if missing_bundles:
        raise RuntimeError(f"{root}: missing application products {sorted(missing_bundles)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Provide the iOS and standalone Watch build product directories")
    check(pathlib.Path(sys.argv[1]), {IOS_BUNDLE, WATCH_BUNDLE})
    check(pathlib.Path(sys.argv[2]), {WATCH_BUNDLE})
