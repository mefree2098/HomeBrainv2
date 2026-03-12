# Jetson Setup Guide

Use this guide if your HomeBrain hub is a Jetson Orin Nano.

## What You Need

- Jetson Orin Nano with Ubuntu / JetPack already installed
- Internet access on the Jetson
- A browser on another device on the same network

## Install

```bash
git clone <your-public-repo-url> HomeBrain
cd HomeBrain
bash scripts/install-jetson.sh
```

The script installs everything HomeBrain needs and creates the production service for you.

## Open HomeBrain

Find the Jetson IP:

```bash
hostname -I
```

Then open:

```text
http://<jetson-ip>:3000
```

## What Is Different On Jetson

Jetson is still the best-tested hardware for:

- local Whisper speech-to-text
- local Ollama models
- other GPU-accelerated workloads

HomeBrain itself is not limited to Jetson anymore, but Jetson is still the strongest all-in-one hub target.

## After Install

Next steps:

1. Create the first account
2. Follow [`configuration.md`](configuration.md)
3. Add remote listener devices from `Voice Devices`

## Useful Commands

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh logs follow
bash scripts/setup-services.sh health
```
