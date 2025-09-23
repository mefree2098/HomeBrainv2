# HomeBrain Deployment Guide

## Overview

HomeBrain is a comprehensive smart home management application designed to run on NVIDIA Jetson Orin Nano with distributed Raspberry Pi voice devices throughout your home. This guide covers complete deployment and configuration.

## Quick Start

### Main Platform (Jetson Orin Nano)
```bash
# Download and run the automated installer
curl -fsSL https://raw.githubusercontent.com/yourusername/homebrain/main/scripts/install-jetson.sh | bash
```

### Remote Devices (Raspberry Pi)
```bash
# Download and run the remote device installer
curl -fsSL https://preview-0py18bcb.ui.pythagora.ai/api/remote-devices/setup | bash
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        HomeBrain Network                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐     ┌─────────────────────────────────┐    │
│  │   Jetson Orin    │     │        Remote Devices          │    │
│  │   Nano (Hub)     │◄────┤  • Living Room (Pi 4)         │    │
│  │                  │     │  • Kitchen (Pi Zero 2W)       │    │
│  │  • Main Platform │     │  • Bedroom (Pi 4)             │    │
│  │  • Web Interface │     │  • Office (Pi Zero 2W)        │    │
│  │  • Voice Hub     │     └─────────────────────────────────┘    │
│  │  • Integrations  │                                            │
│  └──────────────────┘                                            │
│                                                                 │
│  ┌──────────────────┐     ┌─────────────────────────────────┐    │
│  │   Smart Devices  │     │      External Services         │    │
│  │                  │     │                                │    │
│  │  • SmartThings   │     │  • ElevenLabs (TTS)           │    │
│  │  • INSTEON       │     │  • OpenAI/Anthropic (LLM)    │    │
│  │  • Zigbee/Z-Wave│     └─────────────────────────────────┘    │
│  └──────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
```

## System Requirements

### Main Platform (Jetson Orin Nano)
- **Hardware**: NVIDIA Jetson Orin Nano (8GB recommended)
- **Storage**: 64GB+ microSD card or NVMe SSD
- **Network**: Ethernet connection (Wi-Fi optional)
- **USB**: Available ports for INSTEON PLM and audio devices
- **Audio**: USB audio interface or I2S HAT (optional for hub voice)

### Remote Devices (Raspberry Pi)
- **Hardware**: Raspberry Pi 4B/Zero 2W/3B+ (Pi 4B recommended)
- **Storage**: 32GB+ microSD card (Class 10 or better)
- **Network**: Wi-Fi connection required
- **Audio**: USB microphone + speaker OR I2S audio HAT
- **Power**: Official Pi power supply recommended

## Network Requirements

- **Local Network**: All devices on same subnet
- **Internet**: Required for initial setup and cloud services
- **Ports**:
  - 3000 (HomeBrain API)
  - 5173 (Web Interface)
  - 8080 (WebSocket)
  - 12345 (Discovery UDP)

## Detailed Deployment Instructions

### 1. Main Platform Setup (Jetson Orin Nano)

See [docs/jetson-setup.md](docs/jetson-setup.md) for detailed instructions.

#### Quick Steps:
1. Flash JetPack 5.1+ to Jetson Orin Nano
2. Complete initial Ubuntu setup
3. Run automated installer script
4. Configure integrations and services
5. Set up voice devices

### 2. Remote Device Setup (Raspberry Pi)

See [remote-device/README.md](remote-device/README.md) for detailed instructions.

#### Quick Steps:
1. Flash Raspberry Pi OS Lite
2. Enable SSH and configure Wi-Fi
3. Run automated installer script
4. Devices auto-discover and connect to hub

### 3. Configuration

See [docs/configuration.md](docs/configuration.md) for detailed configuration steps.

#### Key Configuration Areas:
- **Location Settings**: Geographic location for sunrise/sunset
- **Integrations**: SmartThings, INSTEON, ElevenLabs
- **AI Services**: OpenAI, Anthropic, or Local LLM
- **User Profiles**: Voice recognition and preferences
- **Voice Devices**: Wake word training and room assignment

## Post-Installation Verification

1. **Access Web Interface**: http://[jetson-ip]:5173
2. **Check Device Status**: Voice Devices page
3. **Test Voice Commands**: "Hey Anna, turn on the lights"
4. **Verify Integrations**: Settings > Integrations
5. **Create Test Automation**: "Every morning at 8 AM, turn on the coffee maker"

## Maintenance

### Regular Updates
```bash
# Update main platform
cd /opt/homebrain && git pull && npm install && npm run build

# Update remote devices
ssh pi@device-ip "cd ~/homebrain-remote && git pull && npm install"
```

### Backup Configuration
```bash
# Backup database
mongodump --db homebrain --out /backup/homebrain-$(date +%Y%m%d)

# Backup configuration
cp -r /opt/homebrain/server/.env /backup/
```

### Monitoring
- **System Health**: Dashboard > System Status
- **Device Status**: Voice Devices page
- **Logs**: `journalctl -u homebrain` or `pm2 logs`
- **Network**: `sudo systemctl status homebrain-discovery`

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues and solutions.

### Quick Diagnostics
```bash
# Check main services
sudo systemctl status homebrain mongodb

# Check network discovery
sudo netstat -ulnp | grep 12345

# Test voice device connectivity
curl http://[jetson-ip]:3000/api/voice-devices

# Check audio devices
arecord -l && aplay -l
```

## Support

- **Documentation**: [docs/](docs/)
- **Issues**: Create GitHub issue with logs
- **Community**: Join Discord/Forum
- **Professional**: Contact for enterprise support

## Security Considerations

- **Network Isolation**: Consider VLAN for IoT devices
- **Firewall**: Configure UFW rules for external access
- **Updates**: Regular security updates for all components
- **Authentication**: Strong passwords and JWT tokens
- **Local Processing**: Voice processing happens locally for privacy

## Integration Guides

### SmartThings Setup
1. Create SmartThings Developer Account
2. Generate Personal Access Token
3. Configure in HomeBrain Settings
4. Sync devices and test control

### INSTEON Setup
1. Connect INSTEON PowerLinc Modem via USB
2. Configure serial port in settings
3. Link INSTEON devices to hub
4. Organize devices by room

### ElevenLabs Setup
1. Create ElevenLabs account
2. Generate API key
3. Configure in HomeBrain settings
4. Test text-to-speech functionality

## Performance Optimization

### Jetson Orin Nano
- **Power Mode**: Set to MAXN for best performance
- **GPU**: Enable GPU acceleration for AI workloads
- **Storage**: Use NVMe SSD for better I/O performance
- **Cooling**: Ensure adequate cooling for sustained workloads

### Remote Devices
- **Audio Latency**: Use USB audio devices for lower latency
- **Network**: 5GHz Wi-Fi for better bandwidth
- **Storage**: Class 10+ SD cards for better performance
- **Power**: Stable power supply prevents audio glitches

## Advanced Configuration

### Custom Wake Words
1. Access Picovoice Console
2. Train custom wake word models
3. Download .ppn files
4. Configure in User Profiles

### Local LLM Setup
1. Install Ollama on Jetson
2. Download appropriate model (llama2, codellama)
3. Configure local endpoint in settings
4. Test natural language processing

### Multi-Hub Setup
1. Deploy multiple Jetson hubs
2. Configure hub-specific device assignments
3. Sync user profiles across hubs
4. Load balance voice processing

This deployment guide ensures a complete and secure HomeBrain installation across your smart home network.