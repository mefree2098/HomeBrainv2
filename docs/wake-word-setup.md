# Wake Word Setup

HomeBrain includes wake-word training and remote distribution.

## One-Time Dependency Install On The Hub

```bash
cd server
PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh
```

This creates `server/.wakeword-venv`.

## In The UI

Open `Settings -> Voice & Audio`.

Use the `Wake Word Models` area to:

- download Piper voices
- create wake-word phrases
- train models
- monitor training status

## Typical Flow

1. Install wake-word dependencies on the hub
2. Download one or more Piper voices
3. Create a wake word
4. Wait for it to become ready
5. Assign it to a user profile
6. Let listener devices sync the updated assets

## Listener Sync

HomeBrain pushes updated wake-word assets to listener devices automatically.

If a listener seems stale:

```bash
sudo systemctl restart homebrain-remote
sudo journalctl -u homebrain-remote -f
```

## If Training Fails

- confirm the wake-word virtualenv exists
- confirm Piper voices are installed
- restart `homebrain`
- retry the job from the UI
