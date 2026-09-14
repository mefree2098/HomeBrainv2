# HomeBrain tutorials

These tutorials preserve the security and weather walkthroughs recorded before the September 14, 2026 UI refresh. Their layouts show that earlier app version; current controls may look different.

| Tutorial | Master | Wall-panel version | Captions | Production notes |
| --- | --- | --- | --- | --- |
| Security Basics | [1920×1080](homebrain-security-basics/exports/homebrain-security-basics.mp4) | [1024×600](homebrain-security-basics/exports/homebrain-security-basics-1024x600.mp4) | [SRT](homebrain-security-basics/exports/homebrain-security-basics.srt) | [Notes](homebrain-security-basics/production-notes.md) |
| Weather System | [1920×1080](weather-system-live/exports/homebrain-weather-system.mp4) | [1024×600](weather-system-live/exports/homebrain-weather-system-1024x600.mp4) | [SRT](weather-system-live/exports/homebrain-weather-system.srt) | [Notes](weather-system-live/production-notes.md) |

Each tutorial includes its narration and editable capture, overlay, and audio sources. Rejected narration takes and scratch QA frames remain in the original external archive. The retained approved narration uses the `v3-calm` filenames identified in the production notes.

Verify or regenerate a wall-panel derivative with FFmpeg and the repository helper:

```sh
python3 scripts/finalize-video-tutorial.py verify \
  --master docs/videos/homebrain-security-basics/exports/homebrain-security-basics.mp4 \
  --output docs/videos/homebrain-security-basics/exports/homebrain-security-basics-1024x600.mp4
```

Replace `verify` with `finalize` to regenerate the derivative. The helper checks H.264/AAC, frame rate, dimensions, and matching duration. The weather overlay generator uses Pillow and the macOS Arial fonts named in its source.
