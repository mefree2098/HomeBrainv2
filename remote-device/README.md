# HomeBrain Remote Device Setup Guide

## Overview

HomeBrain Remote Devices are Raspberry Pi-based voice-activated units that connect to your main HomeBrain hub. Each device provides distributed voice control throughout your home, allowing you to issue voice commands from any room.

## Features

- **Always-On Voice Detection**: Responds to custom wake words like "Anna" or "Henry"
- **Distributed Audio**: High-quality microphone capture and speaker output
- **Auto-Discovery**: Automatically finds and connects to your HomeBrain hub
- **Room-Aware Commands**: Understands which room commands originate from
- **Low Latency**: Fast response times for voice commands
- **Easy Setup**: Automated installation and configuration
- **Remote Management**: Configure and monitor from main hub interface

## Hardware Requirements

### Supported Devices
- **Raspberry Pi 5** (recommended - best performance; requires Raspberry Pi OS Bookworm or later)
- **Raspberry Pi 4B** (supported)
- **Raspberry Pi Zero 2W** (compact option)
- **Raspberry Pi 3B+** (legacy support)

### Storage Requirements
- 32GB+ microSD card (Class 10 or UHS-I recommended)
- High-quality SD card for reliability

### Audio Hardware Options

#### Option 1: USB Audio (Recommended)
- **USB Microphone**: High-quality USB microphone
- **USB Speakers**: Powered USB speakers or USB audio interface
- **Advantages**: Easy setup, good quality, standard drivers

#### Option 2: I2S Audio HAT
- **Compatible HATs**: HiFiBerry, IQaudIO, or similar
- **Microphone**: I2S or analog microphone
- **Speaker**: Connected through HAT
- **Advantages**: Better audio quality, integrated solution

#### Option 3: Built-in Audio (Pi 4 only)
- **3.5mm Jack**: For speakers/headphones
- **USB Microphone**: Required for input
- **Limitations**: Lower audio quality
- **Pi 5 Note**: Use USB or I2S audio on Raspberry Pi 5.

### Network Requirements
- **Wi-Fi Connection**: 2.4GHz or 5GHz (5GHz preferred)
- **Local Network Access**: Must be on same network as HomeBrain hub
- **Internet Access**: Required for initial setup and updates

### Power Requirements
- **Official Power Supply**: Recommended for stability
- **Minimum Current**: 5A for Pi 5 (5V/5A USB-C recommended; 27W official PSU), 2.5A for Pi 4B, 1.5A for Pi Zero 2W
- **Active Cooling**: Recommended for Pi 5 under sustained load
- **Quality Cables**: Use good USB cables to prevent voltage drops

## Quick Installation

### Automated Installation
```bash
# Download and run the installer
curl -fsSL https://preview-0py18bcb.ui.pythagora.ai/api/remote-devices/setup | bash
```

### Manual Installation Steps
1. Flash Raspberry Pi OS Lite (64-bit; Bookworm or later required for Pi 5)
2. Enable SSH and configure Wi-Fi
3. Boot and SSH into device
4. Run installation script
5. Configure audio hardware
6. Test voice functionality

## Detailed Setup Instructions

### Step 1: Prepare Raspberry Pi

#### Flash Operating System
1. Download [Raspberry Pi Imager](https://www.raspberrypi.org/software/)
2. In Imager:
   - Device: Raspberry Pi 5
   - Choose OS:
     - If listed: **Raspberry Pi OS (other)** -> **Raspberry Pi OS Lite (64-bit)**.
     - If not listed, use **Use custom** and select:
       - https://downloads.raspberrypi.org/raspios_lite_arm64/images/raspios_lite_arm64-2024-07-04/2024-07-04-raspios-bookworm-arm64-lite.img.xz
   - Choose Storage: select your SD card
3. If OS customization is available, open it (gear icon or **Edit settings** prompt).
4. **General** tab:
   - Set hostname
   - Set username and password
   - Configure wireless LAN (SSID, password, country)
   - Set locale settings (timezone, keyboard)
5. **Services** tab:
   - Enable SSH (password auth or your SSH public key)
6. Save, confirm, and write the image.
7. If OS customization is NOT available (common when using **Use custom** on Imager 2.x), configure headless access manually after writing:
   1. Reinsert the SD card so the **boot** partition mounts in Windows (usually labeled `bootfs`).
   2. Create an empty file named `ssh` (no extension) in the boot partition:
      ```powershell
      New-Item -Path X:\ssh -ItemType File -Force | Out-Null
      ```
   3. Create `userconf.txt` with `username:password_hash`:
      - Generate a hash (Git Bash or any OpenSSL install):
        ```bash
        openssl passwd -6
        ```
        Enter the password; copy the full output hash (include everything, including any trailing `.b1`).
      - Create the file (PowerShell, replace `X:` with your boot drive letter). Use single quotes so `$` is not stripped:
        ```powershell
        $line = 'matt:<PASTE_HASH_HERE>'
        Set-Content -Path X:\userconf.txt -Value $line -Encoding ASCII -NoNewline
        ```
      - You will still log in with the plain password you entered for the hash (not the hash itself).
   4. If using Wi-Fi, create `wpa_supplicant.conf` in the boot partition:
      ```
      country=US
      ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
      update_config=1

      network={
        ssid="YOUR_WIFI_NAME"
        psk="YOUR_WIFI_PASSWORD"
      }
      ```
   5. Safely eject the SD card and boot the Pi.
      - After the first successful boot, `userconf.txt` should disappear from the boot partition. If it is still there, the user was not created and login will fail.
      - If it still exists after boot, you can force-create the user without reflashing:
        1. Power off, insert the SD card in Windows, and edit `cmdline.txt` (single line). Append ` init=/bin/sh` at the end.
        2. Boot the Pi; you should land at a root shell.
        3. Run:
           ```bash
           mount -o remount,rw /
           useradd -m -s /bin/bash matt
           passwd matt
           usermod -aG sudo,audio,video,plugdev,netdev,gpio,i2c,spi matt
           sync
           ```
        4. Power off, remove `init=/bin/sh` from `cmdline.txt`, boot normally, and log in as `matt`.

#### Alternative: Manual Configuration
If not configured during imaging:

1. **Enable SSH**:
   ```bash
   # Create SSH enable file on boot partition
   touch /boot/ssh
   ```

2. **Configure Wi-Fi**:
   ```bash
   # Create wpa_supplicant configuration
   nano /boot/wpa_supplicant.conf
   ```

   Add Wi-Fi configuration:
   ```
   country=US
   ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
   update_config=1

   network={
       ssid="YourWiFiNetwork"
       psk="YourWiFiPassword"
   }
   ```

### Step 2: Initial System Setup

#### Connect to Raspberry Pi
```bash
# Find Pi IP address
nmap -sn 192.168.1.0/24 | grep -i raspberry

# SSH into Pi (replace with the username you created in Imager)
ssh <user>@192.168.1.xxx
```

#### Update System
```bash
# Update package lists and system
sudo apt update && sudo apt upgrade -y

# Install essential tools
sudo apt install -y curl wget git vim
```

#### Configure Audio System
```bash
# For USB Audio (most common):
sudo apt install -y alsa-utils pulseaudio

# List audio devices
arecord -l  # List microphones
aplay -l    # List speakers

# Test microphone
arecord -f S16_LE -r 16000 -d 5 test.wav

# Test speakers
aplay test.wav
```

### Step 3: Install HomeBrain Remote Device

#### Automatic Installation
```bash
# Download and run installer
curl -fsSL https://preview-0py18bcb.ui.pythagora.ai/api/remote-devices/setup | bash
```

#### Installer Script (copied `remote-device` folder)
```bash
cd ~/remote-device
bash install.sh
```
If `install.sh` fails with `$'\r': command not found`, convert line endings and retry:
```bash
sed -i 's/\r$//' install.sh
bash install.sh
```

#### Manual Installation
```bash
# Clone repository
git clone https://github.com/yourusername/homebrain.git
cd homebrain/remote-device

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install dependencies
npm install

# Copy configuration template
cp config.example.json config.json

# Edit configuration
nano config.json
```

### Step 4: Configure Device

#### Configuration File
Edit `config.json`:
```json
{
  "device": {
    "name": "Living Room Voice Device",
    "location": "Living Room",
    "deviceId": "pi-livingroom-001"
  },
  "network": {
    "discoveryPort": 12345,
    "hubDiscoveryTimeout": 30000,
    "heartbeatInterval": 60000
  },
  "audio": {
    "microphoneDevice": "hw:1,0",
    "speakerDevice": "hw:1,0",
    "sampleRate": 16000,
    "channels": 1,
    "volume": 80,
    "sensitivity": 0.7
  },
  "wakeWord": {
    "enabled": ["Anna"],
    "reportedConfidence": 0.9,
    "timeout": 5000
  },
  "debug": {
    "enabled": true,
    "logLevel": "info"
  }
}
```

#### Wake Word Engine (OpenWakeWord)

1. **Install/update dependencies** on the device (this pulls `onnxruntime-node`):
   ```bash
   cd ~/homebrain/remote-device
   npm install
   ```
2. **Restart the remote service** whenever you deploy new code so it loads the OpenWakeWord runtime:
   ```bash
   sudo systemctl restart homebrain-remote
   journalctl -u homebrain-remote -n 20
   ```

### Step 5: Confirm speech-to-text is running on the hub
The Pi streams raw audio to the hub after a wake word. If STT is not running, you will see `command_error: Sorry, I could not understand the audio.` even when the Pi is fine.

- In the HomeBrain UI, open **Settings -> Voice & Audio** and confirm the STT provider.
- If using **On-device Whisper (Jetson)**:
  - Go to `http://<hub-ip>:3000/whisper`
  - Click **Install Dependencies**, then **Start Service**
  - Download and **Activate** the `small` model (recommended)
- If using **OpenAI**, set your API key in the UI or via `OPENAI_API_KEY`, then restart the hub service.
3. **Let the hub manage models.** Trained `.tflite` files are downloaded automatically into `~/homebrain-remote/wake-words/` based on the profile wake words configured in the UI—no AccessKey or manual copying is required.
4. **Monitor detection** with `journalctl -u homebrain-remote -f`; successful triggers appear as `wake_word_detected` events.

#### Audio Configuration

For **USB Audio Device**:
```bash
# Find USB audio device number
arecord -l
aplay -l

# Update config.json with correct device IDs
# Example: if USB audio is card 1
"microphoneDevice": "hw:1,0",
"speakerDevice": "hw:1,0"
```

For **I2S HAT**:
```bash
# Enable I2S in boot config
echo "dtparam=i2s=on" | sudo tee -a /boot/config.txt

# Add HAT overlay (example for HiFiBerry)
echo "dtoverlay=hifiberry-dac" | sudo tee -a /boot/config.txt

# Reboot
sudo reboot

# Update config.json
"microphoneDevice": "hw:0,0",
"speakerDevice": "hw:0,0"
```

### Step 5: Test Installation

#### Test Audio System
```bash
# Test microphone capture
arecord -D hw:1,0 -f S16_LE -r 16000 -d 3 test.wav

# Test speaker output
aplay -D hw:1,0 test.wav

# Adjust volume if needed
alsamixer
```

#### Start Remote Device
```bash
# Start in foreground for testing
npm start

# Or start as service
sudo systemctl start homebrain-remote
```

#### Verify Discovery
```bash
# Check if hub is discovered
# Look for discovery messages in logs
journalctl -u homebrain-remote -f

# Verify network connectivity
ping [hub-ip]
```

### Step 6: Configure as System Service

#### Create Service File
```bash
sudo tee /etc/systemd/system/homebrain-remote.service > /dev/null << EOF
[Unit]
Description=HomeBrain Remote Voice Device
After=network.target sound.target
Wants=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/homebrain/remote-device
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Resource limits
MemoryLimit=512M
CPUQuota=50%

[Install]
WantedBy=multi-user.target
EOF
```

#### Enable and Start Service
```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service
sudo systemctl enable homebrain-remote

# Start service
sudo systemctl start homebrain-remote

# Check status
sudo systemctl status homebrain-remote
```

## Advanced Configuration

### Custom Wake Words

#### Using the HomeBrain Training Pipeline
1. Open the HomeBrain UI, edit (or create) the profile that should respond to the wake word, and add the new phrase.
2. Wait for the hub to finish training (watch `journalctl -u homebrain -f` or query the Profiles API until the model status becomes `ready`).
3. Confirm a matching `.tflite` file appears under `server/public/wake-words/`.
4. Restart the remote service—or wait for the next `config_update`—so the Pi downloads the new model into `~/homebrain-remote/wake-words/`.

#### Configuration Example
```json
{
  "wakeWord": {
    "enabled": ["Anna", "Henry"],
    "cacheDir": "/home/pi/homebrain-remote/wake-words",
    "keywords": [
      {
        "label": "Anna",
        "path": "/home/pi/homebrain-remote/wake-words/anna.tflite",
        "threshold": 0.55
      },
      {
        "label": "Henry",
        "path": "/home/pi/homebrain-remote/wake-words/henry.tflite",
        "threshold": 0.6
      }
    ],
    "assets": [
      {
        "label": "Anna",
        "slug": "anna",
        "checksum": "<sha256>",
        "downloadUrl": "/api/remote-devices/<deviceId>/wake-words/anna?code=<REGISTRATION_CODE>",
        "sensitivity": 0.6
      },
      {
        "label": "Henry",
        "slug": "henry",
        "checksum": "<sha256>",
        "downloadUrl": "/api/remote-devices/<deviceId>/wake-words/henry?code=<REGISTRATION_CODE>",
        "sensitivity": 0.7
      }
    ],
    "reportedConfidence": 0.9
  }
}
```
> The `downloadUrl` entries are generated by the hub—treat them as read-only. Keep your AccessKey outside of the config file by exporting `PICOVOICE_ACCESS_KEY` (or `PV_ACCESS_KEY`).

### Audio Optimization

#### Reduce Latency
```json
{
  "audio": {
    "bufferSize": 512,
    "sampleRate": 16000,
    "channels": 1,
    "echoAncellation": true,
    "noiseReduction": true,
    "automaticGainControl": true
  }
}
```

#### USB Audio Optimization
```bash
# Reduce USB audio latency
echo "snd_usb_audio nrpacks=1" | sudo tee -a /etc/modprobe.d/alsa-base.conf

# Increase USB power for stability
echo "dwc_otg.fiq_enable=1" | sudo tee -a /boot/cmdline.txt
echo "dwc_otg.fiq_fsm_enable=1" | sudo tee -a /boot/cmdline.txt
```

### Network Optimization

#### Wi-Fi Power Management
```bash
# Disable Wi-Fi power management for stability
sudo iwconfig wlan0 power off

# Make permanent
echo "wireless-power off" | sudo tee -a /etc/network/interfaces
```

#### Quality of Service
```json
{
  "network": {
    "qosEnabled": true,
    "audioPriority": "high",
    "heartbeatInterval": 30000,
    "reconnectAttempts": 10
  }
}
```

## Device Management

### Remote Configuration
- Access device settings through main HomeBrain interface
- Configure room assignment and device properties
- Update audio settings remotely
- Monitor device status and performance

### Firmware Updates
```bash
# Update remote device software
cd /home/pi/homebrain/remote-device
git pull
npm install
sudo systemctl restart homebrain-remote
```

### Performance Monitoring
```bash
# Check system resources
htop

# Monitor audio performance
arecord -M | head -c 1000000 | aplay -M

# Check network latency
ping [hub-ip]

# View service logs
journalctl -u homebrain-remote -f
```

## Troubleshooting

### Common Issues

#### Device Not Discovering Hub
1. **Check Network**: Ensure both devices on same network
2. **Firewall**: Check firewall rules on hub and router
3. **Discovery Port**: Verify UDP port 12345 is open
4. **Network Discovery**: Run network discovery test

```bash
# Test UDP broadcast
echo "HOMEBRAIN_DISCOVERY_REQUEST" | nc -u 255.255.255.255 12345

# Check local network
nmap -sn 192.168.1.0/24
```

#### Audio Issues
1. **Device Detection**: Check `arecord -l` and `aplay -l`
2. **Permissions**: Add user to audio group: `sudo usermod -a -G audio pi`
3. **Volume Levels**: Adjust with `alsamixer`
4. **USB Power**: Ensure adequate power supply

#### Voice Recognition Problems
1. **Microphone Sensitivity**: Adjust in config.json
2. **Background Noise**: Enable noise reduction
3. **Wake Word Models**: Confirm `.tflite` models exist in `~/homebrain-remote/wake-words/` and that the hub reports the wake word status as `ready`
4. **Audio Quality**: Check for audio distortion or clipping

#### Service Startup Issues
```bash
# Check service status
sudo systemctl status homebrain-remote

# View detailed logs
journalctl -u homebrain-remote -n 50

# Test manual startup
cd /home/pi/homebrain/remote-device
npm start
```

### Performance Optimization

#### Raspberry Pi Settings
```bash
# Increase GPU memory split
echo "gpu_mem=64" | sudo tee -a /boot/config.txt

# Disable unnecessary services
sudo systemctl disable bluetooth
sudo systemctl disable hciuart

# Optimize audio
echo "audio_pwm_mode=2" | sudo tee -a /boot/config.txt
```

#### System Monitoring
```bash
# Check CPU temperature
vcgencmd measure_temp

# Monitor system performance
iostat 5

# Check memory usage
free -h
```

## Multiple Device Setup

### Room-Based Deployment
1. **Living Room**: Primary device with high-quality speakers
2. **Kitchen**: Noise-resistant setup for cooking environment
3. **Bedroom**: Lower volume, privacy-focused configuration
4. **Office**: Professional setup for work commands

### Device Naming Convention
```json
{
  "device": {
    "name": "[Room] Voice Device",
    "location": "[Room]",
    "deviceId": "pi-[room]-[number]"
  }
}
```

### Coordinated Management
- Configure all devices through main hub interface
- Monitor network status and performance
- Synchronize wake word models across devices
- Implement room-specific voice profiles

## Security Considerations

### Network Security
- Use WPA3 Wi-Fi encryption
- Isolate IoT devices on separate VLAN
- Regular security updates
- Monitor network traffic

### Device Security
```bash
# Change default passwords
sudo passwd pi

# Disable password SSH (use keys)
sudo nano /etc/ssh/sshd_config
# Set: PasswordAuthentication no

# Enable firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow from [hub-ip]
```

### Audio Privacy
- Local voice processing only
- No cloud transmission of audio
- Configurable wake word sensitivity
- Manual mute functionality

This comprehensive guide ensures successful deployment of HomeBrain Remote Devices throughout your smart home network.
