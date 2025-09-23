# Jetson Orin Nano Setup Guide

## Overview

This guide covers the complete setup of the HomeBrain platform on NVIDIA Jetson Orin Nano, from initial hardware setup to a fully configured smart home hub.

## Prerequisites

### Hardware Requirements
- NVIDIA Jetson Orin Nano Developer Kit (8GB recommended)
- 64GB+ microSD card (UHS-I, Class 10 or better)
- OR NVMe SSD (256GB+ recommended for production)
- USB-A to micro-USB cable for initial setup
- Ethernet cable
- Monitor, keyboard, mouse for initial setup
- Power supply (included with developer kit)

### Optional Hardware
- USB audio interface (for hub voice commands)
- INSTEON PowerLinc Modem (USB) for INSTEON integration
- Wi-Fi antenna (if using Wi-Fi)

## Step 1: JetPack Installation

### Download JetPack
1. Visit [NVIDIA Developer](https://developer.nvidia.com/jetpack)
2. Download **JetPack 5.1.2** or later
3. Use NVIDIA SDK Manager or balenaEtcher to flash

### Flash to Storage
```bash
# Using balenaEtcher (recommended for beginners)
# 1. Download JetPack image
# 2. Flash to microSD card using balenaEtcher
# 3. Insert card into Jetson

# OR using command line (Linux/Mac)
sudo dd if=jetpack-5.1.2.img of=/dev/sdX bs=4M status=progress
sync
```

### Initial Boot
1. Insert flashed storage into Jetson
2. Connect monitor, keyboard, mouse
3. Connect power and boot
4. Complete Ubuntu setup wizard:
   - Username: `homebrain` (recommended)
   - Password: Strong password
   - Computer name: `homebrain-hub`

## Step 2: System Configuration

### Update System
```bash
# Update package lists
sudo apt update && sudo apt upgrade -y

# Install essential tools
sudo apt install -y curl wget git vim nano htop

# Reboot after major updates
sudo reboot
```

### Configure Network

#### Ethernet (Recommended)
```bash
# Check network interface
ip addr show

# Configure static IP (optional but recommended)
sudo nano /etc/netplan/01-netcfg.yaml
```

Example netplan configuration:
```yaml
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - 192.168.1.100/24
      gateway4: 192.168.1.1
      nameservers:
        addresses: [8.8.8.8, 8.8.4.4]
```

Apply configuration:
```bash
sudo netplan apply
```

#### Wi-Fi (Alternative)
```bash
# Connect to Wi-Fi
nmcli device wifi list
nmcli device wifi connect "SSID" password "password"

# Verify connection
ip addr show wlan0
```

### Configure SSH (Optional but Recommended)
```bash
# Enable SSH
sudo systemctl enable ssh
sudo systemctl start ssh

# Configure SSH key authentication
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# Add your public key to ~/.ssh/authorized_keys
# Then disable password authentication
sudo nano /etc/ssh/sshd_config
# Set: PasswordAuthentication no
sudo systemctl restart ssh
```

## Step 3: Audio Configuration

### Check Audio Devices
```bash
# List audio capture devices
arecord -l

# List audio playback devices
aplay -l

# Test audio capture
arecord -f cd -d 5 test.wav

# Test audio playback
aplay test.wav
```

### Configure USB Audio (If Using)
```bash
# Install ALSA utilities
sudo apt install -y alsa-utils pulseaudio pulseaudio-utils

# Configure default audio devices
sudo nano /etc/asound.conf
```

Example ALSA configuration:
```
# Use USB audio device as default
pcm.!default {
    type hw
    card 1  # USB audio card number
}
ctl.!default {
    type hw
    card 1
}
```

### Test Audio Configuration
```bash
# Test microphone
arecord -f S16_LE -r 16000 -d 5 -t wav test.wav
aplay test.wav

# Test speaker
speaker-test -c 2 -t wav -l 1
```

## Step 4: Install Dependencies

### Install Node.js
```bash
# Install Node.js 18.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version
```

### Install MongoDB
```bash
# Import MongoDB GPG key
wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | sudo apt-key add -

# Add MongoDB repository
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list

# Install MongoDB
sudo apt update
sudo apt install -y mongodb-org

# Start and enable MongoDB
sudo systemctl start mongod
sudo systemctl enable mongod

# Verify MongoDB is running
sudo systemctl status mongod
```

### Install PM2 Process Manager
```bash
# Install PM2 globally
sudo npm install -g pm2

# Configure PM2 to start on boot
pm2 startup
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME
```

### Install Python Dependencies (for AI/ML features)
```bash
# Install Python development tools
sudo apt install -y python3-dev python3-pip

# Install Python packages for AI features
pip3 install numpy scipy scikit-learn
```

## Step 5: Install HomeBrain Platform

### Download Source Code
```bash
# Create application directory
sudo mkdir -p /opt/homebrain
sudo chown $USER:$USER /opt/homebrain

# Clone repository
cd /opt/homebrain
git clone https://github.com/yourusername/homebrain.git .

# Or download and extract if using releases
# wget https://github.com/yourusername/homebrain/archive/main.tar.gz
# tar -xzf main.tar.gz --strip-components=1
```

### Install Application Dependencies
```bash
# Install root dependencies
npm install

# Install server dependencies
cd server
npm install

# Install client dependencies
cd ../client
npm install

# Return to root
cd ..
```

### Build Application
```bash
# Build client application
npm run build

# Verify build completed successfully
ls -la client/dist/
```

### Configure Environment
```bash
# Copy environment template
cp server/.env.example server/.env

# Edit environment configuration
nano server/.env
```

Required environment variables:
```bash
# Basic Configuration
NODE_ENV=production
PORT=3000
CLIENT_PORT=5173

# Database
MONGODB_URI=mongodb://localhost:27017/homebrain

# JWT Security (generate strong secrets)
JWT_ACCESS_SECRET=your-super-secret-jwt-access-key-here
JWT_REFRESH_SECRET=your-super-secret-jwt-refresh-key-here

# Geographic Location (for sunrise/sunset)
LATITUDE=40.7128
LONGITUDE=-74.0060
TIMEZONE=America/New_York

# Optional: ElevenLabs TTS
ELEVENLABS_API_KEY=your-elevenlabs-api-key

# Optional: AI Services
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key

# Optional: SmartThings
SMARTTHINGS_PAT=your-smartthings-personal-access-token
```

### Initialize Database
```bash
# Create admin user
npm run create-admin

# Seed initial data (optional)
npm run seed

# Verify database connection
npm run test-db
```

## Step 6: Configure System Services

### Create SystemD Services
```bash
# Create HomeBrain service
sudo tee /etc/systemd/system/homebrain.service > /dev/null << EOF
[Unit]
Description=HomeBrain Smart Home Hub
After=network.target mongodb.service
Requires=mongodb.service

[Service]
Type=simple
User=homebrain
WorkingDirectory=/opt/homebrain
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Create Discovery service
sudo tee /etc/systemd/system/homebrain-discovery.service > /dev/null << EOF
[Unit]
Description=HomeBrain Device Discovery
After=network.target homebrain.service
Requires=homebrain.service

[Service]
Type=simple
User=homebrain
WorkingDirectory=/opt/homebrain/server
ExecStart=/usr/bin/node services/discoveryService.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### Enable and Start Services
```bash
# Reload systemd configuration
sudo systemctl daemon-reload

# Enable services
sudo systemctl enable homebrain
sudo systemctl enable homebrain-discovery

# Start services
sudo systemctl start homebrain
sudo systemctl start homebrain-discovery

# Check service status
sudo systemctl status homebrain
sudo systemctl status homebrain-discovery
```

## Step 7: Configure Firewall

### Install and Configure UFW
```bash
# Install UFW
sudo apt install -y ufw

# Configure basic rules
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH
sudo ufw allow ssh

# Allow HomeBrain ports
sudo ufw allow 3000/tcp comment 'HomeBrain API'
sudo ufw allow 5173/tcp comment 'HomeBrain Web'
sudo ufw allow 8080/tcp comment 'HomeBrain WebSocket'
sudo ufw allow 12345/udp comment 'HomeBrain Discovery'

# Allow local network access
sudo ufw allow from 192.168.1.0/24

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status verbose
```

## Step 8: Performance Optimization

### Configure Jetson Power Mode
```bash
# Set maximum performance mode
sudo nvpmodel -m 0

# Verify power mode
sudo nvpmodel -q

# Set CPU governor to performance
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
```

### Configure Swap (if using microSD)
```bash
# Create swap file (4GB)
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Add to fstab for persistence
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Configure swappiness
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
```

### Optimize MongoDB
```bash
# Configure MongoDB for Jetson
sudo nano /etc/mongod.conf
```

MongoDB configuration optimizations:
```yaml
storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 1  # Limit cache to 1GB on 8GB Jetson
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
```

Restart MongoDB:
```bash
sudo systemctl restart mongod
```

## Step 9: Verification and Testing

### Test Web Interface
```bash
# Check if services are running
sudo systemctl status homebrain homebrain-discovery mongodb

# Test web interface
curl http://localhost:5173

# Test API endpoint
curl http://localhost:3000/api/ping
```

### Test Device Discovery
```bash
# Check discovery service
sudo netstat -ulnp | grep 12345

# Test discovery broadcast
nc -u [jetson-ip] 12345
# Type: "HOMEBRAIN_DISCOVERY_REQUEST"
```

### Access Web Interface
1. Open browser on local network
2. Navigate to `http://[jetson-ip]:5173`
3. Create first user account
4. Complete initial setup wizard

### Verify Audio (if configured)
```bash
# Test microphone
arecord -f S16_LE -r 16000 -d 3 -t wav /tmp/test.wav
file /tmp/test.wav

# Test speakers
speaker-test -c 2 -t wav -l 1
```

## Step 10: Integration Setup

### SmartThings Integration
1. Go to Settings > Integrations
2. Enter SmartThings Personal Access Token
3. Test connection
4. Sync devices

### INSTEON Integration (if applicable)
1. Connect INSTEON PowerLinc Modem via USB
2. Check device: `ls /dev/ttyUSB*`
3. Configure serial port in settings
4. Test communication

### ElevenLabs TTS
1. Go to Settings > AI Services
2. Enter ElevenLabs API key
3. Test text-to-speech
4. Configure default voice

## Troubleshooting

### Common Issues

#### Services Won't Start
```bash
# Check logs
journalctl -u homebrain -f
journalctl -u homebrain-discovery -f

# Check MongoDB
sudo systemctl status mongod
tail -f /var/log/mongodb/mongod.log
```

#### Network Issues
```bash
# Check network configuration
ip addr show
ip route show

# Test connectivity
ping google.com
curl http://localhost:3000/api/ping
```

#### Audio Issues
```bash
# Check audio devices
arecord -l
aplay -l

# Test ALSA configuration
aplay /usr/share/sounds/alsa/Front_Left.wav

# Check PulseAudio
pulseaudio --check
```

#### Performance Issues
```bash
# Check system resources
htop
iotop
nvidia-smi  # if using GPU features

# Check disk space
df -h

# Check memory usage
free -h
```

### Getting Help
- Check logs: `journalctl -u homebrain`
- System status: Access web interface System Status page
- Community support: GitHub issues or Discord
- Performance monitoring: `htop`, `iotop`, `nvidia-smi`

## Next Steps

1. **Set up Remote Devices**: Deploy Raspberry Pi voice devices
2. **Configure User Profiles**: Set up voice recognition
3. **Create Automations**: Use natural language automation
4. **Integrate Devices**: Connect SmartThings, INSTEON devices
5. **Customize Interface**: Arrange dashboard widgets
6. **Set up Scenes**: Create lighting and device scenes

Your Jetson Orin Nano is now ready to serve as your HomeBrain smart home hub!