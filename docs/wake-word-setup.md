# Wake Word Setup (OpenWakeWord + HomeBrain UI)

HomeBrain includes a full OpenWakeWord pipeline:
- Create custom wake words in the UI
- Train models on the hub
- Distribute models to remote listeners automatically

No Picovoice console or AccessKey is required.

## 1. One-Time Hub Dependency Install

Run once on the hub:

```bash
cd ~/HomeBrainv2/server
scripts/install-openwakeword-deps.sh
```

If your Python path is custom, set `PYTHON_BIN` first.

Expected result: a virtual environment is created at `server/.wakeword-venv`.

## 2. Download Piper Voices (UI)

Open:
- `Settings -> Voice & Audio -> Wake Word Models`

In the Piper Voices section:
1. Filter by language/region if needed.
2. Download one or more voices.
3. Select the voices you want used for sample generation.

Expected result: selected voices show as installed.

## 3. Create Wake Word Models (UI)

Still in `Wake Word Models`:
1. Click `Create Wake Word`.
2. Enter phrase (for example `Anna`, `Henry`, `Hey Anna`).
3. Save and start training.

Model statuses progress through queue/training/export and end at `ready`.

## 4. Attach Wake Words to Profiles

Open `User Profiles`.

For each profile, set `Wake Words` to the phrase(s) you want that profile to answer to.

Expected result: listeners trigger the matching profile voice/personality.

## 5. Remote Listener Sync

Remote devices automatically receive updated wake word assets.

If a listener is stale:

```bash
sudo systemctl restart homebrain-remote
sudo journalctl -u homebrain-remote -f
```

Expected logs include wake-word detection startup and trigger events.

## 6. Fast Acknowledgment Lines (Pre-Generated)

When a profile has a configured voice, HomeBrain pre-generates short acknowledgment lines so the user hears an instant response while full LLM/TTS processing continues.

Current default line set includes:
- "`<CharacterName>` here."
- "I heard you."
- "On it."
- "One moment."
- "Working on that now."
- "Right away."
- "Checking now."

A line is chosen randomly at runtime for better UX variety.

## 7. Troubleshooting

If training is stuck or errors:
1. Re-run dependency installer script.
2. Restart HomeBrain service.
3. Requeue/retrain in Wake Word Models UI.
4. Check logs:

```bash
sudo journalctl -u homebrain -f | grep -i "wake word"
```

If listener detection fails:
1. Verify model status is `ready`.
2. Verify listener is online in `Voice Devices`.
3. Confirm listener has latest code via `Remote Fleet Updates`.
