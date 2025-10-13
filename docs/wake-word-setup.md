# Wake Word Setup Guide

HomeBrain now ships with an end-to-end **OpenWakeWord** pipeline. The hub automatically trains custom wake words, distributes the resulting models to every remote device, and switches the Raspberry Pi detectors to the new engine—no Picovoice Console or AccessKey required.

---

## 1. Prerequisites

Make sure the following are ready:

- **HomeBrain hub** (Jetson or other Linux host) is running the latest server build.
- **Remote devices** have pulled the updated `homebrain-remote` package and run `npm install` so that `onnxruntime-node` is available.
- **Python 3.8+ with pip** on the hub. The OpenWakeWord trainer is a Python script.
- **OpenWakeWord training dependencies** installed on the hub:

  ```bash
  cd ~/homebrain/HomeBrainv2/server
  python3 -m pip install --upgrade pip
  python3 -m pip install "openwakeword[train]"
  ```

  Consult the [OpenWakeWord project](https://github.com/dscripka/openWakeWord) if you need GPU support or a custom backend.

---

## 2. Add Wake Words from the UI

1. Sign in to the HomeBrain web UI.
2. Navigate to **Profiles** and create a new profile or edit an existing one.
3. In the **Wake Words** field, enter one or more phrases (for example `Anna`, `Hey Anna`).
4. Save the profile.

Saving queues a background training job for each phrase. Metadata is stored in MongoDB (`WakeWordModel` documents) and the trained models are written to `server/public/wake-words/<slug>.tflite`.

---

## 3. Monitor Training Progress

Training jobs run asynchronously on the hub. Use any of the following methods to check status:

- **System journal**

  ```bash
  sudo journalctl -u homebrain -f | grep -i "wake word"
  ```

  Watch for messages such as `Queueing wake word training for "anna"` and `Wake word model trained for "Anna" (tflite)`.

- **REST API**

  ```bash
  curl -s http://<hub-ip>:3000/api/profiles | jq '.[].wakeWordModels'
  ```

  Each populated model exposes its `status` (`pending`, `training`, `ready`, or `error`), checksum, and model path.

If a model reports `error`, review the Python logs above, verify the `openwakeword` package (with training extras) is installed, and re-save the profile to retry.

---

## 4. Remote Device Synchronisation

Remote devices automatically download trained models the next time they authenticate or when they receive a `config_update`. No manual copying is required.

1. Ensure the remote service is using the new engine:

   ```bash
   ssh pi@<remote-device-ip>
   cd ~/homebrain-remote
   npm install
   sudo systemctl restart homebrain-remote
   ```

2. Tail the remote logs while speaking the wake word:

   ```bash
   sudo journalctl -u homebrain-remote -f
   ```

   You should see `Wake word detection active (OpenWakeWord)` followed by `wake_word_detected` events.

---

## 5. Managing Wake Word Assets

- Models live under `server/public/wake-words/` on the hub and follow the naming convention `<slug>.tflite` (for example `anna.tflite`).
- Include this directory in your routine backups; although models can be regenerated, keeping a copy is recommended.
- To remove a wake word entirely, delete it from the profile (which updates MongoDB) and optionally remove the corresponding `.tflite` file. Remote devices will be notified automatically.

---

## 6. Summary Checklist

1. Install the `openwakeword` Python package (with training extras) on the hub.
2. Update remote devices by running `npm install` in `~/homebrain-remote`.
3. Add wake words to a profile in the UI and save.
4. Monitor the HomeBrain logs or query the API until each model reports `ready`.
5. Verify detection on a remote device with `journalctl -u homebrain-remote -f`.
6. Back up the generated `.tflite` files along with the rest of your HomeBrain data.

With these steps complete, HomeBrain will continually train and deploy OpenWakeWord models for every profile, keeping all devices in sync without manual `.ppn` handling.
