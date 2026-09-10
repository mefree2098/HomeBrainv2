#!/usr/bin/env python3
"""Check compiled App Intents discovery, not just membership of Swift source files."""
import json
import pathlib
import sys

INTENTS = (
    "TurnOnHomeBrainLightsIntent", "TurnOffHomeBrainLightsIntent",
    "SetHomeBrainBrightnessIntent", "RunHomeBrainWorkflowIntent", "ActivateHomeBrainSceneIntent",
)


def check(root: pathlib.Path) -> None:
    found = []
    for path in root.rglob("Metadata.appintents/actionsdata"):
        # Ignore copied framework/test metadata: only application products count.
        if not path.parent.parent.name.endswith(".app"):
            continue
        raw = path.read_text()
        json.loads(raw)  # Corrupt/unreadable metadata must fail the build.
        missing = [name for name in INTENTS if name not in raw]
        if missing:
            raise RuntimeError(f"{path}: missing compiled intent identifiers {missing}")
        found.append(str(path))
        print(f"PASS five compiled Siri intents: {path}")
    if not found:
        raise RuntimeError(f"No compiled application App Intents metadata found under {root}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("Provide both iOS and standalone Watch build product directories")
    for directory in sys.argv[1:]:
        check(pathlib.Path(directory))
