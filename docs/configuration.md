# HomeBrain Configuration Guide

## Overview

This guide covers the complete configuration of HomeBrain after installation, including integrations, user profiles, voice devices, and advanced settings.

## Initial Setup Wizard

### First Access
1. Navigate to `http://[jetson-ip]:5173`
2. Create administrator account
3. Complete initial configuration wizard
4. Set geographic location for sunrise/sunset

### Geographic Configuration
```javascript
// Location settings affect:
// - Sunrise/sunset automations
// - Weather-based scenes
// - Timezone for scheduling

Location Settings:
- Latitude: 40.7128 (New York example)
- Longitude: -74.0060
- Timezone: America/New_York
```

## Integration Configuration

### SmartThings Integration

#### Prerequisites
- SmartThings account
- Personal Access Token (PAT)
- Connected SmartThings devices

#### Setup Steps
1. **Create Personal Access Token**:
   - Go to [SmartThings Developer Workspace](https://smartthings.developer.samsung.com/)
   - Navigate to "Personal Access Tokens"
   - Create new token with permissions:
     - `r:devices:*`
     - `x:devices:*`
     - `r:scenes:*`
     - `x:scenes:*`
     - `r:locations:*`

2. **Configure in HomeBrain**:
   ```bash
   # Via Web Interface:
   Settings > Integrations > SmartThings

   # Or via Environment Variable:
   echo "SMARTTHINGS_PAT=your-token-here" >> /opt/homebrain/server/.env
   sudo systemctl restart homebrain
   ```

3. **Test Connection**:
   - Click "Test Connection" in settings
   - Verify devices appear in device list
   - Test device control

4. **Sync Devices**:
   ```bash
   # Manual sync via API
   curl -X POST http://localhost:3000/api/smartthings/sync \
     -H "Authorization: Bearer your-jwt-token"

   # Or via web interface:
   Settings > Integrations > SmartThings > Sync Devices
   ```

### INSTEON Integration

#### Prerequisites
- INSTEON PowerLinc Modem (PLM)
- USB connection to Jetson
- INSTEON devices linked to PLM

#### Setup Steps
1. **Connect Hardware**:
   ```bash
   # Check USB device detection
   lsusb | grep INSTEON
   ls /dev/ttyUSB*

   # Typical device: /dev/ttyUSB0
   ```

2. **Configure Serial Port**:
   ```bash
   # Add homebrain user to dialout group
   sudo usermod -a -G dialout homebrain

   # Set permissions
   sudo chmod 666 /dev/ttyUSB0
   ```

3. **Configure in HomeBrain**:
   ```javascript
   // Settings > Integrations > INSTEON
   Serial Port: /dev/ttyUSB0
   Baud Rate: 19200 (default)
   ```

4. **Test Communication**:
   - Click "Test Connection"
   - Verify PLM responds
   - Test device commands

### ElevenLabs TTS Integration

#### Prerequisites
- ElevenLabs account
- API key with sufficient credits
- Voice selection preferences

#### Setup Steps
1. **Get API Key**:
   - Visit [ElevenLabs](https://elevenlabs.io/)
   - Generate API key in settings
   - Note available voice credits

2. **Configure API Key**:
   ```bash
   # Via environment variable
   echo "ELEVENLABS_API_KEY=your-api-key" >> /opt/homebrain/server/.env

   # Or via web interface:
   Settings > AI Services > ElevenLabs
   ```

3. **Test Service**:
   ```bash
   # Test TTS generation
   npm run test-elevenlabs

   # Or via web interface:
   Settings > AI Services > Test Text-to-Speech
   ```

4. **Configure Voice Preferences**:
   - Browse available voices
   - Set default system voice
   - Configure per-user voices in profiles

## AI Service Configuration

### OpenAI Integration
```bash
# Configure API key
OPENAI_API_KEY=your-openai-api-key

# Model selection (recommended)
OPENAI_MODEL=gpt-3.5-turbo  # or gpt-4
```

### Anthropic Integration
```bash
# Configure API key
ANTHROPIC_API_KEY=your-anthropic-api-key

# Model selection
ANTHROPIC_MODEL=claude-3-sonnet-20240229
```

### Local LLM Setup (Alternative)
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Download model
ollama pull llama2

# Configure local endpoint
LOCAL_LLM_ENDPOINT=http://localhost:11434
LOCAL_LLM_MODEL=llama2
```

## User Profile Configuration

### Creating User Profiles

#### Via Web Interface
1. Navigate to User Profiles page
2. Click "Create Profile"
3. Configure profile settings:
   - Name and description
   - Voice preferences
   - AI personality
   - Device permissions

#### Profile Settings

**Basic Information**:
```javascript
{
  name: "Anna",
  description: "Helpful AI assistant for home automation",
  isActive: true
}
```

**Voice Configuration**:
```javascript
{
  elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM",  // Rachel
  voiceSettings: {
    stability: 0.75,
    similarityBoost: 0.75,
    style: 0.25,
    speakerBoost: true
  }
}
```

**AI Personality**:
```javascript
{
  systemPrompt: `You are Anna, a helpful AI assistant for the HomeBrain smart home system.
  You help users control their home with voice commands. Be friendly, concise, and helpful.
  Always confirm actions before executing them.`,

  language: "en-US",
  responseStyle: "friendly"
}
```

**Wake Word Configuration**:
```javascript
{
  wakeWords: ["Anna", "Hey Anna"],
  wakeWordSensitivity: 0.7,
  customWakeWordFile: "/path/to/custom.ppn"
}
```

### Voice Training

#### Training Voice Recognition
1. Go to User Profiles > [Profile] > Voice Training
2. Record voice samples (minimum 10 phrases)
3. Train recognition model
4. Test accuracy

#### Training Custom Wake Words
```bash
# Using Picovoice Console
1. Visit https://console.picovoice.ai/
2. Create new wake word
3. Train with voice samples
4. Download .ppn file
5. Upload to HomeBrain profile
```

## Voice Device Configuration

### Device Registration

#### Automatic Discovery
```bash
# Devices should auto-discover when connected to network
# Check discovery status:
curl http://localhost:3000/api/discovery/status

# View pending devices:
curl http://localhost:3000/api/discovery/pending
```

#### Manual Registration
```javascript
// Via API
POST /api/remote-devices/register
{
  "name": "Living Room Voice Device",
  "location": "Living Room",
  "deviceId": "pi-livingroom-001"
}
```

### Device Configuration

#### Room Assignment
1. Go to Voice Devices page
2. Select device
3. Assign to room
4. Configure device-specific settings

#### Audio Configuration
```javascript
{
  microphoneSensitivity: 0.7,
  speakerVolume: 0.8,
  echoCancellation: true,
  noiseReduction: true
}
```

#### Wake Word Settings
```javascript
{
  enabledWakeWords: ["Anna", "Henry"],
  wakeWordSensitivity: 0.7,
  wakeWordTimeout: 5000
}
```

## Security Configuration

### Authentication Settings
```bash
# JWT token expiration
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Session security
SESSION_TIMEOUT=3600
MAX_LOGIN_ATTEMPTS=5
LOCKOUT_DURATION=900
```

### Network Security
```bash
# Configure HTTPS (recommended for production)
# Generate SSL certificate
sudo certbot certonly --standalone -d homebrain.local

# Configure nginx reverse proxy
sudo apt install nginx
```

Nginx configuration example:
```nginx
server {
    listen 443 ssl;
    server_name homebrain.local;

    ssl_certificate /etc/letsencrypt/live/homebrain.local/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/homebrain.local/privkey.pem;

    location / {
        proxy_pass http://localhost:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /socket.io {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Device Access Control
```javascript
// Configure device permissions per user
{
  devicePermissions: {
    "living-room-lights": ["view", "control"],
    "bedroom-thermostat": ["view"],
    "security-system": ["view", "control", "admin"]
  },

  roomAccess: ["Living Room", "Kitchen", "Office"],

  scenePermissions: {
    "movie-night": true,
    "security-mode": false
  }
}
```

## Automation Configuration

### Natural Language Automation

#### Creating Automations via Voice
```javascript
// Example voice commands:
"Hey Anna, every morning at 7 AM turn on the kitchen lights"
"Anna, when the front door opens, turn on the porch light"
"Henry, if it's after sunset and motion is detected, activate security mode"
```

#### Automation Structure
```javascript
{
  name: "Morning Routine",
  description: "Turn on lights and start coffee at 7 AM",

  triggers: [{
    type: "schedule",
    time: "07:00",
    days: ["monday", "tuesday", "wednesday", "thursday", "friday"]
  }],

  conditions: [{
    type: "time_range",
    after: "06:00",
    before: "09:00"
  }],

  actions: [
    {
      type: "device_control",
      deviceId: "kitchen-lights",
      action: "turn_on",
      properties: { brightness: 75 }
    },
    {
      type: "device_control",
      deviceId: "coffee-maker",
      action: "turn_on"
    }
  ]
}
```

### Scene Configuration

#### Creating Scenes
```javascript
{
  name: "Movie Night",
  category: "Entertainment",

  actions: [
    {
      deviceId: "living-room-lights",
      action: "set_brightness",
      value: 20
    },
    {
      deviceId: "tv",
      action: "turn_on"
    },
    {
      deviceId: "sound-system",
      action: "set_volume",
      value: 60
    }
  ]
}
```

#### Voice Scene Activation
```javascript
// Configure voice triggers for scenes
{
  voiceTriggers: [
    "activate movie night",
    "movie time",
    "entertainment mode"
  ]
}
```

## Advanced Configuration

### Performance Tuning

#### Database Optimization
```javascript
// MongoDB configuration for Jetson
{
  storage: {
    wiredTiger: {
      engineConfig: {
        cacheSizeGB: 1
      }
    }
  }
}
```

#### Node.js Optimization
```bash
# Optimize Node.js for ARM64
export NODE_OPTIONS="--max-old-space-size=2048"

# Enable ARM64 optimizations
export ARM_NEON=1
```

### Custom Hardware Integration

#### I2S Audio Configuration
```bash
# Enable I2S in /boot/config.txt
dtparam=i2s=on
dtoverlay=hifiberry-dac

# Configure ALSA for I2S
sudo nano /etc/asound.conf
```

#### GPIO Control
```javascript
// Configure GPIO pins for custom hardware
{
  gpioPins: {
    statusLED: 18,
    resetButton: 24,
    customRelay: 25
  }
}
```

### Backup Configuration

#### Automated Backups
```bash
# Create backup script
#!/bin/bash
BACKUP_DIR="/backup/homebrain-$(date +%Y%m%d)"
mkdir -p $BACKUP_DIR

# Backup database
mongodump --db homebrain --out $BACKUP_DIR/database

# Backup configuration
cp -r /opt/homebrain/server/.env $BACKUP_DIR/
cp -r /opt/homebrain/server/config $BACKUP_DIR/

# Create archive
tar -czf $BACKUP_DIR.tar.gz $BACKUP_DIR
rm -rf $BACKUP_DIR

# Schedule via cron
# 0 2 * * * /opt/homebrain/scripts/backup.sh
```

## Monitoring and Maintenance

### Health Monitoring
```bash
# System health checks
curl http://localhost:3000/api/health

# Service status monitoring
sudo systemctl status homebrain homebrain-discovery mongodb

# Log monitoring
journalctl -u homebrain -f
tail -f /var/log/mongodb/mongod.log
```

### Performance Monitoring
```bash
# Resource usage
htop
iotop
nvidia-smi

# Network monitoring
netstat -tulnp
ss -tulnp

# Audio monitoring
arecord -l
aplay -l
```

### Update Management
```bash
# Update HomeBrain
cd /opt/homebrain
git pull
npm install
npm run build
sudo systemctl restart homebrain

# Update system packages
sudo apt update && sudo apt upgrade

# Update Node.js packages
npm audit fix
```

This configuration guide ensures your HomeBrain system is properly configured for optimal performance and functionality in your smart home environment.