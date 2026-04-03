# Ollama Management

HomeBrain treats Ollama as a host-level dependency with a HomeBrain-managed runtime.

## Management Model

On Linux and Jetson hosts, the Ollama page in HomeBrain does four distinct jobs:

- installs or updates the Ollama host binary
- stops any foreign/system-managed Ollama runtime before changing versions
- starts a single HomeBrain-managed `ollama serve` process after install or update
- refuses to continue if Ollama is still running elsewhere, to avoid duplicate instances

That means the goal is not "any Ollama process is fine." The goal is one Ollama runtime, managed predictably by HomeBrain.

## Privileged Helper

HomeBrain itself runs as the `homebrain` systemd service user, not as root. To install, update, or force-stop Ollama safely, it uses a narrow root-owned helper:

- helper path: `/usr/local/lib/homebrain/ollama-host-control.sh`
- sudoers entry: `/etc/sudoers.d/homebrain-deploy`
- service override: `/etc/systemd/system/homebrain.service.d/99-ollama-helper.conf`

The override exists so the `homebrain` service is allowed to invoke the helper. Without it, `sudo` inside HomeBrain is blocked by `NoNewPrivileges=true`.

## Repair Command

If a host was installed before this Ollama flow existed, or if the helper/sudoers files were lost, run:

```bash
bash scripts/setup-services.sh refresh-privileges
```

That command:

- installs the current helper into `/usr/local/lib/homebrain/`
- refreshes the `homebrain-deploy` sudoers file
- writes the systemd drop-in that allows the HomeBrain service to call the helper

Afterward, restart HomeBrain:

```bash
sudo systemctl restart homebrain
```

Optional verification:

```bash
sudo -n /usr/local/lib/homebrain/ollama-host-control.sh probe && echo helper-ok
systemctl show homebrain -p NoNewPrivileges
```

Expected results:

- `helper-ok`
- `NoNewPrivileges=no`

## Update Behavior

When you click `Update Ollama` in the UI, HomeBrain should:

1. detect whether Ollama is already running
2. stop the current Ollama runtime, including the host `ollama` system service if needed
3. run the privileged helper to install the newer Ollama binary
4. start exactly one HomeBrain-managed runtime again

If the UI says Ollama is still running as user `ollama`, HomeBrain already tried to stop it and then refused to risk a second instance.

## Manual Commands

Normal operation:

- use the `Ollama` page in HomeBrain

Host maintenance:

```bash
bash scripts/setup-services.sh update
bash scripts/setup-services.sh refresh-privileges
```

Manual Ollama stop through the same privileged path HomeBrain uses:

```bash
sudo -n /usr/local/lib/homebrain/ollama-host-control.sh stop-system
```

## What To Avoid

Avoid mixing managers unless you are debugging:

- do not leave a separate manually launched `ollama serve` running
- do not rely on a second shell session to manage Ollama while HomeBrain is also trying to manage it
- do not assume the browser host platform matters; Ollama management is performed on the HomeBrain host itself

If HomeBrain detects a foreign Ollama runtime, it will try to stop it before taking ownership.
