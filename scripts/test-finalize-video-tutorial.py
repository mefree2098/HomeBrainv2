#!/usr/bin/env python3

import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FINALIZER = ROOT / "scripts" / "finalize-video-tutorial.py"


class VideoTutorialFinalizerTests(unittest.TestCase):
    def make_fixture(self, directory: Path, size: str) -> Path:
        fixture = directory / f"fixture-{size}.mp4"
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=navy:s={size}:r=30:d=1",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest",
            str(fixture),
        ], check=True)
        return fixture

    def test_finalize_and_verify(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            master = self.make_fixture(directory, "1920x1080")
            output = directory / "derived.mp4"
            result = subprocess.run([
                "python3", str(FINALIZER), "finalize",
                "--master", str(master), "--output", str(output),
            ], check=True, text=True, capture_output=True)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["verified"])
            self.assertEqual(payload["derivative"]["width"], 1024)
            self.assertEqual(payload["derivative"]["height"], 600)

            subprocess.run([
                "python3", str(FINALIZER), "verify",
                "--master", str(master), "--output", str(output),
            ], check=True, text=True, capture_output=True)

    def test_rejects_non_1080p_master_without_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            master = self.make_fixture(directory, "1280x720")
            output = directory / "derived.mp4"
            result = subprocess.run([
                "python3", str(FINALIZER), "finalize",
                "--master", str(master), "--output", str(output),
            ], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
