# HomeBrain Remote Device

A voice-enabled remote device application for Raspberry Pi that connects to the HomeBrain smart home hub.

## Features

- **Wake Word Detection**: Responds to customizable wake words like "Anna", "Henry", "Home Brain"
- **Voice Command Processing**: Captures and forwards voice commands to the hub
- **Text-to-Speech Playback**: Plays responses from the hub through local speakers
- **Automatic Hub Discovery**: Automatically discovers HomeBrain hubs on the network
- **Zero-Config Setup**: Auto-connects to hubs with minimal user intervention
- **Real-time Communication**: WebSocket connection with the hub for low-latency interaction
- **Audio Configuration**: Supports various microphone and speaker configurations
- **Service Management**: Systemd integration for automatic startup and monitoring
- **Heartbeat Monitoring**: Automatic status reporting and health monitoring

## Requirements

- **Raspberry Pi 3B+ or newer** (or compatible ARM64 device)
- **Raspberry Pi OS** (Bullseye or newer recommended)
- **Node.js 16 or higher**
- **Audio Hardware**:
  - USB microphone or Raspberry Pi audio HAT
  - Speakers, headphones, or audio output device
- **Network Connection**: WiFi or Ethernet connection to reach HomeBrain hub

## Quick Installation

### Option 1: Automatic Discovery (Recommended)

The easiest way to set up a remote device is using automatic discovery:

```bash
# Download and install the remote device software
curl -fsSL https://raw.githubusercontent.com/homebrain/remote-device/main/install.sh | bash

# Start auto-discovery mode
cd ~/homebrain-remote
node index.js --auto-discover --device-name "Kitchen Speaker"
```

This will:
1. **Scan your network** for HomeBrain hubs
2. **Automatically connect** to the first hub found
3. **Request approval** from the hub
4. **Wait for approval** - you'll see a message to approve in the web interface
5. **Complete setup automatically** once approved

### Option 2: Manual Registration (Traditional)

```bash
# Download and run the installation script
curl -fsSL https://raw.githubusercontent.com/homebrain/remote-device/main/install.sh | bash

# Get a registration code from your HomeBrain web interface
# Then register the device:
cd ~/homebrain-remote
./register.sh YOUR_REGISTRATION_CODE
```

### Option 3: Manual Installation

1. **Update system and install dependencies**:
   ```bash
   sudo apt-get update && sudo apt-get upgrade -y
   sudo apt-get install -y curl git build-essential python3 python3-pip alsa-utils pulseaudio portaudio19-dev libsndfile1-dev libasound2-dev sox libsox-fmt-all
   ```

2. **Install Node.js** (if not already installed):
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Create project directory**:
   ```bash
   mkdir -p ~/homebrain-remote
   cd ~/homebrain-remote
   ```

4. **Install the application**:
   ```bash
   npm init -y
   npm install ws node-record-lpcm16 speaker node-fetch yargs node-wav
   # Copy the index.js file to this directory
   ```

## Configuration

### Audio Setup

1. **List available audio devices**:
   ```bash
   arecord -l  # List recording devices (microphones)
   aplay -l    # List playback devices (speakers)
   ```

2. **Test your microphone and speakers**:
   ```bash
   ./test-audio.sh
   ```

3. **Edit audio configuration** in `config.json`:
   ```json
   {
     "audio": {
       "sampleRate": 16000,
       "channels": 1,
       "recordingDevice": "default",
       "playbackDevice": "default"
     }
   }
   ```

### Device Registration

1. **Get a registration code** from your HomeBrain web interface:
   - Navigate to Voice Devices page
   - Click "Add Remote Device"
   - Fill in device name and room
   - Copy the registration code

2. **Register your device**:
   ```bash
   # Replace YOUR_CODE with the actual registration code
   # Replace HUB_IP with your HomeBrain hub IP address
   ./register.sh YOUR_CODE http://HUB_IP:3000

   # Examples:
   ./register.sh ABC123 http://192.168.1.100:3000
   ./register.sh XYZ789  # Uses localhost:3000 by default
   ```

## Usage

### Starting the Device

**Manual start** (for testing):
```bash
./start.sh
# or
node index.js
```

**Background service** (recommended):
```bash
# Enable automatic startup
sudo systemctl enable homebrain-remote
sudo systemctl start homebrain-remote

# Check status
sudo systemctl status homebrain-remote

# View logs
sudo journalctl -u homebrain-remote -f
```

### Voice Commands

1. **Say a wake word**: "Hey Anna", "Henry", or "Home Brain"
2. **Wait for acknowledgment**: The device will indicate it's listening
3. **Speak your command**: "Turn on the living room lights"
4. **Listen to response**: The device will play back the hub's response

### Command Line Options

```bash
node index.js [options]

Options:
  --register, -r    Registration code for device setup
  --config, -c      Path to configuration file (default: ./config.json)
  --hub, -h         Hub URL (e.g., http://192.168.1.100:3000)
  --verbose, -v     Enable verbose logging
  --help           Show help
```

## Service Management

### Systemd Service Commands

```bash
# Start the service
sudo systemctl start homebrain-remote

# Stop the service
sudo systemctl stop homebrain-remote

# Restart the service
sudo systemctl restart homebrain-remote

# Enable automatic startup
sudo systemctl enable homebrain-remote

# Disable automatic startup
sudo systemctl disable homebrain-remote

# Check service status
sudo systemctl status homebrain-remote

# View recent logs
sudo journalctl -u homebrain-remote --since "1 hour ago"

# Follow logs in real-time
sudo journalctl -u homebrain-remote -f
```

## Troubleshooting

### Audio Issues

**Problem**: Microphone not working
- Check connections and power
- Verify device with: `arecord -l`
- Test recording: `arecord -d 5 test.wav && aplay test.wav`
- Check ALSA configuration in `/etc/asound.conf`

**Problem**: No speaker output
- Check speaker connections and volume
- Verify device with: `aplay -l`
- Test playback: `speaker-test -c 2`
- Check PulseAudio: `pulseaudio --check`

### Connection Issues

**Problem**: Cannot connect to hub
- Verify hub is running and accessible
- Check network connectivity: `ping HUB_IP`
- Verify hub URL in configuration
- Check firewall settings on hub

**Problem**: Authentication failed
- Verify registration code is correct and not expired
- Re-register device if necessary
- Check device ID in configuration

### Service Issues

**Problem**: Service won't start
- Check service status: `sudo systemctl status homebrain-remote`
- View detailed logs: `sudo journalctl -u homebrain-remote`
- Verify file permissions and paths
- Check Node.js installation: `node --version`

### Performance Issues

**Problem**: High CPU usage
- Reduce wake word detection sensitivity
- Check for audio feedback loops
- Monitor with: `htop`

**Problem**: Memory leaks
- Restart service periodically if needed
- Monitor with: `free -h`
- Check for updated dependencies

## Configuration File Reference

```json
{
  "deviceId": "auto-generated-after-registration",
  "hubUrl": "http://192.168.1.100:3000",
  "hubWsUrl": "ws://192.168.1.100:3000/ws/voice-device/DEVICE_ID",
  "audio": {
    "sampleRate": 16000,
    "channels": 1,
    "recordingDevice": "default",
    "playbackDevice": "default"
  },
  "wakeWords": ["anna", "henry", "home brain"],
  "settings": {
    "volume": 50,
    "microphoneSensitivity": 50,
    "wakeWordThreshold": 0.5,
    "recordingTimeout": 30000
  }
}
```

## Development

### Test Mode

Run in test mode (no audio required):
```bash
node index.js --verbose
# Press ENTER to simulate wake word detection
# Type commands and press ENTER to simulate voice input
```

### Custom Wake Words

To use custom wake words with Porcupine:

1. Install Porcupine:
   ```bash
   npm install @picovoice/porcupine-node
   ```

2. Train custom wake words at: https://console.picovoice.ai/

3. Update configuration with your custom keyword files

### Building from Source

```bash
git clone https://github.com/homebrain/remote-device.git
cd remote-device
npm install
npm run build  # If applicable
```

## Support

- **Documentation**: https://docs.homebrain.io/remote-devices
- **Issues**: https://github.com/homebrain/remote-device/issues
- **Community**: https://community.homebrain.io

## License

MIT License - see LICENSE file for details