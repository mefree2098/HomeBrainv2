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
- **Raspberry Pi 4B** (recommended - best performance)
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

### Network Requirements
- **Wi-Fi Connection**: 2.4GHz or 5GHz (5GHz preferred)
- **Local Network Access**: Must be on same network as HomeBrain hub
- **Internet Access**: Required for initial setup and updates

### Power Requirements
- **Official Power Supply**: Recommended for stability
- **Minimum Current**: 2.5A for Pi 4B, 1.5A for Pi Zero 2W
- **Quality Cables**: Use good USB cables to prevent voltage drops

## Quick Installation

### Automated Installation
```bash
# Download and run the installer
curl -fsSL https://preview-0py18bcb.ui.pythagora.ai/api/remote-devices/setup | bash
```

### Manual Installation Steps
1. Flash Raspberry Pi OS Lite
2. Enable SSH and configure Wi-Fi
3. Boot and SSH into device
4. Run installation script
5. Configure audio hardware
6. Test voice functionality

## Detailed Setup Instructions

### Step 1: Prepare Raspberry Pi

#### Flash Operating System
1. Download [Raspberry Pi Imager](https://www.raspberrypi.org/software/)
2. Flash **Raspberry Pi OS Lite** (64-bit recommended)
3. During imaging, configure:
   - Enable SSH with password or key
   - Configure Wi-Fi network
   - Set username and password

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

# SSH into Pi
ssh pi@192.168.1.xxx
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
    "enabled": ["Anna", "Henry"],
    "sensitivity": 0.7,
    "timeout": 5000
  },
  "debug": {
    "enabled": true,
    "logLevel": "info"
  }
}
```

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

#### Using Picovoice Console
1. Visit [Picovoice Console](https://console.picovoice.ai/)
2. Create account and new wake word
3. Train with voice samples
4. Download `.ppn` file
5. Place in `/home/pi/homebrain/remote-device/wake-words/`
6. Update config.json with file path

#### Configuration Example
```json
{
  "wakeWord": {
    "customModels": {
      "Anna": "/home/pi/homebrain/remote-device/wake-words/anna.ppn",
      "Henry": "/home/pi/homebrain/remote-device/wake-words/henry.ppn"
    },
    "enabled": ["Anna", "Henry"],
    "sensitivity": 0.7
  }
}
```

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
3. **Wake Word Models**: Verify `.ppn` files are correct
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