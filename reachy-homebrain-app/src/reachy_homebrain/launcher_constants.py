"""Immutable compatibility boundary for external source-only runtime releases."""

from __future__ import annotations

import hashlib
from pathlib import Path

LAUNCHER_VERSION = "0.1.1"
LAUNCHER_API = 1
_DEPENDENCIES = "\n".join(
    (
        "aiohttp>=3.14.3,<4",
        "numpy>=1.26,<3",
        "reachy-mini>=1.9,<2",
        "websockets>=12,<17",
        "onnxruntime>=1.19,<2 (optional-installed)",
        "openwakeword>=0.6,<0.7 (optional-installed)",
    )
)
DEPENDENCY_FINGERPRINT = hashlib.sha256(_DEPENDENCIES.encode()).hexdigest()
STABLE_LAUNCHER_FILES = (
    "src/reachy_homebrain/__init__.py",
    "src/reachy_homebrain/__main__.py",
    "src/reachy_homebrain/launcher_constants.py",
    "src/reachy_homebrain/main.py",
    "src/reachy_homebrain/releases.py",
    "src/reachy_homebrain/sdk_compat.py",
)


def stable_launcher_fingerprint() -> str:
    """Hash the actual installed stable launcher inventory, including this algorithm."""

    package_dir = Path(__file__).resolve().parent
    entries: list[tuple[str, int, str]] = []
    for relative in STABLE_LAUNCHER_FILES:
        path = package_dir / Path(relative).name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"stable launcher file is missing or unsafe: {relative}")
        data = path.read_bytes()
        entries.append((relative, len(data), hashlib.sha256(data).hexdigest()))
    aggregate = hashlib.sha256()
    for relative, size, digest in sorted(entries, key=lambda item: item[0].encode("utf-8")):
        aggregate.update(relative.encode("utf-8"))
        aggregate.update(b"\x00")
        aggregate.update(str(size).encode("ascii"))
        aggregate.update(b"\x00")
        aggregate.update(digest.encode("ascii"))
        aggregate.update(b"\n")
    return aggregate.hexdigest()


LAUNCHER_FINGERPRINT = stable_launcher_fingerprint()
