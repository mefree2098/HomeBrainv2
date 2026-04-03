# HomeBrain Troubleshooting

## First Checks

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh health
```

If HomeBrain is healthy:

- `mongod` is running
- `homebrain` is running
- `http://localhost:3000/ping` responds

## HomeBrain Does Not Open In The Browser

Check:

```bash
sudo journalctl -u homebrain -n 120 --no-pager
sudo ss -lntup | grep -E '(:3000|:443|:80)\b'
```

Fix:

```bash
bash scripts/setup-services.sh restart
```

If the app still fails, confirm [`server/.env`](../server/.env) exists and the database URL is valid.

## Login Problems

Make sure `JWT_SECRET` and `REFRESH_TOKEN_SECRET` exist in `server/.env`, then restart HomeBrain.

## Platform Deploy Fails

Common reasons:

- the git checkout has local changes
- the server cannot reach git remotes
- the service cannot be restarted

Check:

```bash
git status --short
git remote -v
```

If the repo is dirty, commit or stash your work first.

## Remote Listener Will Not Come Online

On the listener:

```bash
sudo systemctl status homebrain-remote --no-pager
sudo journalctl -u homebrain-remote -n 120 --no-pager
```

Typical fixes:

- rerun the one-command installer from `Voice Devices`
- confirm the listener can reach `http://<hub-ip>:3000`
- confirm the registration code or claim token is current

## Wake Word Is Not Triggering

Check in the UI:

- `Voice Devices`: the listener is online
- `User Profiles`: the wake word is assigned
- `Settings -> Voice & Audio`: the wake word model is ready

If wake-word training dependencies are missing on the hub:

```bash
cd server
PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh
sudo systemctl restart homebrain
```

## Local Whisper Problems

Open the `Whisper` page and look at:

- installed models
- active model
- logs

On non-Jetson hosts, local Whisper may run on CPU and be slower. That is expected.

## Ollama Problems

Open the `Ollama` page and verify:

- Ollama is installed
- the service is running
- a model is available locally

## INSTEON / PLM Problems

Important:

- the PLM is serial hardware, not Ethernet hardware
- a direct hub Ethernet cable to the PLM will not work

Supported connection styles:

- local serial path
- serial-to-TCP bridge

Detailed service behavior and regression notes:

- [`insteon-service.md`](insteon-service.md)

If serial access fails, confirm the host can see the serial device and that the HomeBrain user has permission to use it.

## MongoDB Problems

Check:

```bash
sudo systemctl status mongod --no-pager
mongosh --quiet "mongodb://localhost/HomeBrain" --eval "db.runCommand({ ping: 1 })"
```

If MongoDB is down, start it:

```bash
sudo systemctl restart mongod
```

## Need More Detail

Use the live event feed in `Operations` plus:

```bash
bash scripts/setup-services.sh logs follow
```
