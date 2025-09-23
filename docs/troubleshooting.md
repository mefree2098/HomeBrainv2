# HomeBrain Troubleshooting Guide

## Overview

This guide covers common issues, diagnostic steps, and solutions for HomeBrain deployment and operation.

## Quick Diagnostics

### System Status Check
```bash
# Check all services
sudo systemctl status homebrain homebrain-discovery mongodb

# Check process status
ps aux | grep -E "(node|mongo|homebrain)"

# Check port availability
sudo netstat -tulnp | grep -E "(3000|5173|8080|12345|27017)"

# Check disk space
df -h

# Check memory usage
free -h
```

### Network Connectivity
```bash
# Test local connectivity
curl http://localhost:3000/api/ping
curl http://localhost:5173

# Test external connectivity
ping google.com
curl https://api.elevenlabs.io/v1/voices

# Check DNS resolution
nslookup google.com
```

### Audio System Check
```bash
# List audio devices
arecord -l
aplay -l

# Test microphone
arecord -f S16_LE -r 16000 -d 3 -t wav /tmp/test.wav

# Test speakers
aplay /usr/share/sounds/alsa/Front_Left.wav
```

## Common Issues and Solutions

### 1. Service Startup Issues

#### HomeBrain Service Won't Start

**Symptoms:**
- `sudo systemctl status homebrain` shows failed
- Web interface not accessible
- API endpoints return connection error

**Diagnosis:**
```bash
# Check service logs
journalctl -u homebrain -n 50

# Check Node.js errors
cd /opt/homebrain && npm start

# Check environment variables
cat server/.env
```

**Solutions:**

1. **Missing Dependencies:**
   ```bash
   cd /opt/homebrain
   npm install
   cd server && npm install
   cd ../client && npm install
   ```

2. **Port Conflicts:**
   ```bash
   # Check if ports are in use
   sudo lsof -i :3000
   sudo lsof -i :5173

   # Kill conflicting processes
   sudo kill -9 [PID]
   ```

3. **Permission Issues:**
   ```bash
   # Fix ownership
   sudo chown -R homebrain:homebrain /opt/homebrain

   # Fix permissions
   chmod +x /opt/homebrain/server/server.js
   ```

4. **Environment Configuration:**
   ```bash
   # Verify .env file exists
   ls -la /opt/homebrain/server/.env

   # Check required variables
   grep -E "(MONGODB_URI|JWT_ACCESS_SECRET)" /opt/homebrain/server/.env
   ```

#### MongoDB Connection Issues

**Symptoms:**
- "Cannot connect to MongoDB" errors
- Database-related API failures
- Service fails to start

**Diagnosis:**
```bash
# Check MongoDB status
sudo systemctl status mongod

# Check MongoDB logs
sudo tail -f /var/log/mongodb/mongod.log

# Test connection
mongo --eval "db.runCommand('ping')"
```

**Solutions:**

1. **MongoDB Not Running:**
   ```bash
   sudo systemctl start mongod
   sudo systemctl enable mongod
   ```

2. **Configuration Issues:**
   ```bash
   # Check MongoDB config
   sudo nano /etc/mongod.conf

   # Ensure correct bind IP
   net:
     port: 27017
     bindIp: 127.0.0.1
   ```

3. **Disk Space Issues:**
   ```bash
   # Check available space
   df -h /var/lib/mongodb

   # Clean up if needed
   sudo mongod --repair
   ```

4. **Permission Issues:**
   ```bash
   # Fix MongoDB data directory permissions
   sudo chown -R mongodb:mongodb /var/lib/mongodb
   sudo chown mongodb:mongodb /tmp/mongodb-27017.sock
   ```

### 2. Network and Connectivity Issues

#### Discovery Service Not Working

**Symptoms:**
- Remote devices can't find hub
- Discovery service fails to start
- Network devices not detected

**Diagnosis:**
```bash
# Check discovery service
sudo systemctl status homebrain-discovery

# Check UDP port
sudo netstat -ulnp | grep 12345

# Test UDP broadcast
echo "HOMEBRAIN_DISCOVERY_REQUEST" | nc -u -w1 255.255.255.255 12345
```

**Solutions:**

1. **Firewall Blocking UDP:**
   ```bash
   # Allow UDP discovery port
   sudo ufw allow 12345/udp

   # Check firewall status
   sudo ufw status verbose
   ```

2. **Network Interface Issues:**
   ```bash
   # Check network interfaces
   ip addr show

   # Ensure correct interface binding
   # Edit discovery service configuration
   ```

3. **Service Configuration:**
   ```bash
   # Check discovery service logs
   journalctl -u homebrain-discovery -f

   # Restart service
   sudo systemctl restart homebrain-discovery
   ```

#### API Endpoints Not Accessible

**Symptoms:**
- 404 errors on API calls
- Frontend can't reach backend
- CORS errors in browser

**Diagnosis:**
```bash
# Test API directly
curl http://localhost:3000/api/ping

# Check backend logs
journalctl -u homebrain -f

# Check frontend proxy configuration
cat client/vite.config.ts
```

**Solutions:**

1. **Proxy Configuration:**
   ```javascript
   // Verify vite.config.ts proxy settings
   server: {
     proxy: {
       '/api': {
         target: 'http://localhost:3000',
         changeOrigin: true
       }
     }
   }
   ```

2. **Backend Route Issues:**
   ```bash
   # Check route registration
   grep -r "router.use" server/routes/

   # Verify server.js includes routes
   grep "app.use" server/server.js
   ```

3. **CORS Configuration:**
   ```javascript
   // Check CORS settings in server.js
   app.use(cors({
     origin: ['http://localhost:5173'],
     credentials: true
   }));
   ```

### 3. Audio System Issues

#### Microphone Not Working

**Symptoms:**
- No audio input detected
- Voice commands not recognized
- Audio test fails

**Diagnosis:**
```bash
# Check audio devices
arecord -l

# Test microphone
arecord -f S16_LE -r 16000 -d 5 -t wav test.wav
file test.wav

# Check ALSA configuration
cat /etc/asound.conf
```

**Solutions:**

1. **USB Audio Device Not Detected:**
   ```bash
   # Check USB devices
   lsusb

   # Reload USB audio module
   sudo modprobe -r snd_usb_audio
   sudo modprobe snd_usb_audio

   # Check dmesg for USB errors
   dmesg | tail -20
   ```

2. **Permission Issues:**
   ```bash
   # Add user to audio group
   sudo usermod -a -G audio homebrain

   # Check device permissions
   ls -la /dev/snd/
   ```

3. **ALSA Configuration:**
   ```bash
   # Configure default audio device
   sudo nano /etc/asound.conf

   # Example configuration:
   pcm.!default {
       type hw
       card 1
   }
   ctl.!default {
       type hw
       card 1
   }
   ```

#### Speaker Output Issues

**Symptoms:**
- No audio output
- TTS responses not audible
- Audio playback fails

**Diagnosis:**
```bash
# Test speaker output
speaker-test -c 2 -t wav -l 1

# Check audio output devices
aplay -l

# Test with audio file
aplay /usr/share/sounds/alsa/Front_Left.wav
```

**Solutions:**

1. **Wrong Output Device:**
   ```bash
   # Set default output device
   sudo nano /etc/asound.conf

   # Or use PulseAudio
   pacmd list-sinks
   pacmd set-default-sink [sink-name]
   ```

2. **Volume Issues:**
   ```bash
   # Check and set volume
   alsamixer

   # Or command line
   amixer set Master 80%
   amixer set PCM 80%
   ```

3. **Driver Issues:**
   ```bash
   # Reload audio drivers
   sudo modprobe -r snd_hda_intel
   sudo modprobe snd_hda_intel

   # Check audio module loading
   lsmod | grep snd
   ```

### 4. Voice Recognition Issues

#### Wake Word Detection Not Working

**Symptoms:**
- Voice commands not triggering
- No response to wake words
- High false positive/negative rates

**Diagnosis:**
```bash
# Check voice device logs
journalctl -u homebrain | grep -i "wake"

# Test microphone sensitivity
arecord -f S16_LE -r 16000 -d 10 test.wav
aplay test.wav

# Check wake word configuration
curl http://localhost:3000/api/user-profiles
```

**Solutions:**

1. **Microphone Sensitivity:**
   ```bash
   # Adjust microphone levels
   alsamixer

   # Increase capture volume
   amixer set Capture 80%
   ```

2. **Wake Word Model Issues:**
   ```bash
   # Check wake word files
   ls -la /opt/homebrain/wake-words/

   # Verify model format
   file /opt/homebrain/wake-words/*.ppn
   ```

3. **Background Noise:**
   ```bash
   # Enable noise reduction
   # Configure in user profile:
   {
     "audioSettings": {
       "noiseReduction": true,
       "echoCancellation": true
     }
   }
   ```

### 5. Integration Issues

#### SmartThings Connection Failed

**Symptoms:**
- "Connection failed" in settings
- SmartThings devices not syncing
- API token errors

**Diagnosis:**
```bash
# Test SmartThings API
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://api.smartthings.com/v1/devices

# Check token in environment
grep SMARTTHINGS_PAT /opt/homebrain/server/.env

# Check integration logs
journalctl -u homebrain | grep -i smartthings
```

**Solutions:**

1. **Invalid Token:**
   ```bash
   # Regenerate SmartThings PAT
   # Update in environment
   echo "SMARTTHINGS_PAT=new-token" >> server/.env
   sudo systemctl restart homebrain
   ```

2. **Network Connectivity:**
   ```bash
   # Test external connectivity
   curl https://api.smartthings.com/v1/

   # Check DNS resolution
   nslookup api.smartthings.com
   ```

3. **API Rate Limits:**
   ```bash
   # Check for rate limit errors in logs
   journalctl -u homebrain | grep -i "rate limit"

   # Implement request throttling
   ```

#### ElevenLabs TTS Not Working

**Symptoms:**
- Text-to-speech fails
- Voice generation errors
- API key errors

**Diagnosis:**
```bash
# Test ElevenLabs API
npm run test-elevenlabs

# Check API key
grep ELEVENLABS_API_KEY /opt/homebrain/server/.env

# Test voice generation
curl -X POST https://api.elevenlabs.io/v1/text-to-speech/VOICE_ID \
  -H "xi-api-key: YOUR_API_KEY"
```

**Solutions:**

1. **API Key Issues:**
   ```bash
   # Verify API key validity
   curl -H "xi-api-key: YOUR_KEY" \
     https://api.elevenlabs.io/v1/voices

   # Update API key
   echo "ELEVENLABS_API_KEY=new-key" >> server/.env
   ```

2. **Credit/Quota Issues:**
   ```bash
   # Check account quota
   curl -H "xi-api-key: YOUR_KEY" \
     https://api.elevenlabs.io/v1/user

   # Implement quota monitoring
   ```

### 6. Performance Issues

#### High CPU Usage

**Symptoms:**
- System slow or unresponsive
- High CPU usage in htop
- Thermal throttling on Jetson

**Diagnosis:**
```bash
# Monitor CPU usage
htop
top -p $(pgrep node)

# Check CPU frequency
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq

# Monitor temperature
cat /sys/class/thermal/thermal_zone*/temp
```

**Solutions:**

1. **Power Mode Optimization:**
   ```bash
   # Set maximum performance mode
   sudo nvpmodel -m 0

   # Set CPU governor
   echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
   ```

2. **Process Optimization:**
   ```bash
   # Limit Node.js memory
   export NODE_OPTIONS="--max-old-space-size=2048"

   # Use PM2 for process management
   pm2 start server/server.js --name homebrain
   ```

3. **Cooling:**
   ```bash
   # Check thermal status
   sudo apt install linux-tools-common
   sudo turbostat

   # Ensure proper cooling/ventilation
   ```

#### Memory Issues

**Symptoms:**
- Out of memory errors
- Swap usage high
- System becomes unresponsive

**Diagnosis:**
```bash
# Check memory usage
free -h
ps aux --sort=-%mem | head -10

# Monitor swap usage
swapon -s
```

**Solutions:**

1. **Increase Swap:**
   ```bash
   # Create larger swap file
   sudo fallocate -l 4G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   ```

2. **Optimize MongoDB:**
   ```bash
   # Limit MongoDB cache
   # Edit /etc/mongod.conf:
   storage:
     wiredTiger:
       engineConfig:
         cacheSizeGB: 1
   ```

3. **Node.js Memory Limits:**
   ```bash
   # Set memory limits
   export NODE_OPTIONS="--max-old-space-size=1024"
   ```

## Advanced Diagnostics

### Log Analysis

#### Centralized Logging
```bash
# View all HomeBrain logs
journalctl -u homebrain -u homebrain-discovery --since "1 hour ago"

# Follow logs in real-time
journalctl -f -u homebrain

# Filter by log level
journalctl -u homebrain -p err
```

#### Application Logs
```bash
# Enable debug logging
export DEBUG=homebrain:*
npm start

# MongoDB slow query log
# Add to /etc/mongod.conf:
operationProfiling:
  slowOpThresholdMs: 100
  mode: slowOp
```

### Network Diagnostics

#### WebSocket Issues
```bash
# Test WebSocket connection
wscat -c ws://localhost:8080

# Check WebSocket logs
journalctl -u homebrain | grep -i websocket

# Monitor WebSocket traffic
tcpdump -i lo port 8080
```

#### Discovery Protocol
```bash
# Monitor UDP discovery traffic
tcpdump -i any port 12345

# Send discovery request
echo "HOMEBRAIN_DISCOVERY_REQUEST" | nc -u 255.255.255.255 12345

# Check multicast/broadcast
ip route show | grep broadcast
```

### Database Diagnostics

#### MongoDB Performance
```bash
# Check database stats
mongo homebrain --eval "db.stats()"

# Analyze slow queries
mongo homebrain --eval "db.runCommand({profile: 2})"

# Check indexes
mongo homebrain --eval "db.devices.getIndexes()"
```

#### Data Integrity
```bash
# Validate collections
mongo homebrain --eval "db.devices.validate()"
mongo homebrain --eval "db.users.validate()"

# Check for corruption
sudo mongod --dbpath /var/lib/mongodb --repair
```

## Recovery Procedures

### System Recovery

#### Service Recovery
```bash
# Reset all services
sudo systemctl daemon-reload
sudo systemctl restart mongodb
sudo systemctl restart homebrain
sudo systemctl restart homebrain-discovery

# Check service dependencies
systemctl list-dependencies homebrain
```

#### Database Recovery
```bash
# Restore from backup
sudo systemctl stop homebrain
mongorestore --db homebrain /backup/latest/
sudo systemctl start homebrain

# Rebuild indexes
mongo homebrain --eval "db.reIndex()"
```

### Configuration Reset

#### Reset to Defaults
```bash
# Backup current config
cp server/.env server/.env.backup

# Reset configuration
npm run reset-config

# Recreate admin user
npm run create-admin
```

#### Selective Reset
```bash
# Clear specific collections
mongo homebrain --eval "db.automations.drop()"
mongo homebrain --eval "db.scenes.drop()"

# Reseed data
npm run seed
```

## Getting Help

### Information to Collect

When reporting issues, include:

1. **System Information:**
   ```bash
   # Hardware info
   cat /proc/cpuinfo | grep "model name"
   cat /proc/meminfo | grep MemTotal
   df -h

   # Software versions
   node --version
   npm --version
   mongod --version
   ```

2. **Service Status:**
   ```bash
   sudo systemctl status homebrain homebrain-discovery mongodb
   ```

3. **Recent Logs:**
   ```bash
   journalctl -u homebrain --since "1 hour ago" > homebrain.log
   ```

4. **Configuration:**
   ```bash
   # Remove sensitive data first!
   cat server/.env | sed 's/=.*/=***REDACTED***/'
   ```

### Support Channels

- **GitHub Issues**: Include logs and system info
- **Community Forum**: General questions and discussions
- **Documentation**: Check docs/ directory for guides
- **Professional Support**: Available for enterprise deployments

### Self-Help Resources

- **System Status**: Dashboard > System Health
- **Built-in Diagnostics**: Settings > System > Diagnostics
- **Log Viewer**: Settings > System > Logs
- **Configuration Validator**: Settings > System > Validate Config

This troubleshooting guide should help resolve most common issues with HomeBrain deployment and operation.