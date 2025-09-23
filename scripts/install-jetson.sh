#!/bin/bash

# HomeBrain Jetson Orin Nano Installation Script
# This script automates the complete installation of HomeBrain on NVIDIA Jetson Orin Nano

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
HOMEBRAIN_USER="homebrain"
HOMEBRAIN_DIR="/opt/homebrain"
GITHUB_REPO="https://github.com/yourusername/homebrain.git"
NODE_VERSION="18"
MONGODB_VERSION="6.0"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        print_error "This script should not be run as root. Please run as a regular user with sudo privileges."
        exit 1
    fi
}

# Function to check if running on Jetson
check_jetson() {
    if ! grep -q "tegra" /proc/cpuinfo; then
        print_warning "This script is designed for NVIDIA Jetson devices. Continuing anyway..."
    fi
}

# Function to update system packages
update_system() {
    print_status "Updating system packages..."
    sudo apt update
    sudo apt upgrade -y
    sudo apt install -y curl wget git vim nano htop build-essential
    print_success "System packages updated"
}

# Function to install Node.js
install_nodejs() {
    print_status "Installing Node.js ${NODE_VERSION}..."

    # Check if Node.js is already installed
    if command -v node &> /dev/null; then
        CURRENT_VERSION=$(node --version | grep -o '[0-9]*' | head -1)
        if [[ $CURRENT_VERSION -ge $NODE_VERSION ]]; then
            print_success "Node.js ${CURRENT_VERSION} already installed"
            return
        fi
    fi

    # Install Node.js
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
    sudo apt install -y nodejs

    # Verify installation
    NODE_VER=$(node --version)
    NPM_VER=$(npm --version)
    print_success "Node.js ${NODE_VER} and npm ${NPM_VER} installed"
}

# Function to install MongoDB
install_mongodb() {
    print_status "Installing MongoDB ${MONGODB_VERSION}..."

    # Check if MongoDB is already installed
    if command -v mongod &> /dev/null; then
        print_success "MongoDB already installed"
        return
    fi

    # Import MongoDB GPG key
    wget -qO - https://www.mongodb.org/static/pgp/server-${MONGODB_VERSION}.asc | sudo apt-key add -

    # Add MongoDB repository
    echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/${MONGODB_VERSION} multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-${MONGODB_VERSION}.list

    # Install MongoDB
    sudo apt update
    sudo apt install -y mongodb-org

    # Start and enable MongoDB
    sudo systemctl daemon-reload
    sudo systemctl enable mongod
    sudo systemctl start mongod

    # Verify installation
    sleep 5
    if sudo systemctl is-active --quiet mongod; then
        print_success "MongoDB installed and running"
    else
        print_error "MongoDB installation failed"
        exit 1
    fi
}

# Function to install PM2
install_pm2() {
    print_status "Installing PM2 process manager..."

    if command -v pm2 &> /dev/null; then
        print_success "PM2 already installed"
        return
    fi

    sudo npm install -g pm2

    # Configure PM2 startup
    pm2 startup
    print_success "PM2 installed"
}

# Function to create homebrain user
create_user() {
    print_status "Creating homebrain user..."

    if id "$HOMEBRAIN_USER" &>/dev/null; then
        print_success "User ${HOMEBRAIN_USER} already exists"
    else
        sudo useradd -r -s /bin/bash -d /opt/homebrain -m $HOMEBRAIN_USER
        sudo usermod -a -G dialout,audio,video $HOMEBRAIN_USER
        print_success "User ${HOMEBRAIN_USER} created"
    fi
}

# Function to install HomeBrain application
install_homebrain() {
    print_status "Installing HomeBrain application..."

    # Create application directory
    if [[ ! -d "$HOMEBRAIN_DIR" ]]; then
        sudo mkdir -p $HOMEBRAIN_DIR
        sudo chown $HOMEBRAIN_USER:$HOMEBRAIN_USER $HOMEBRAIN_DIR
    fi

    # Clone or update repository
    if [[ -d "$HOMEBRAIN_DIR/.git" ]]; then
        print_status "Updating existing HomeBrain installation..."
        cd $HOMEBRAIN_DIR
        sudo -u $HOMEBRAIN_USER git pull
    else
        print_status "Cloning HomeBrain repository..."
        sudo -u $HOMEBRAIN_USER git clone $GITHUB_REPO $HOMEBRAIN_DIR
        cd $HOMEBRAIN_DIR
    fi

    # Install dependencies
    print_status "Installing application dependencies..."
    sudo -u $HOMEBRAIN_USER npm install

    # Install server dependencies
    cd server
    sudo -u $HOMEBRAIN_USER npm install

    # Install client dependencies
    cd ../client
    sudo -u $HOMEBRAIN_USER npm install

    # Build client application
    cd ..
    print_status "Building client application..."
    sudo -u $HOMEBRAIN_USER npm run build

    print_success "HomeBrain application installed"
}

# Function to configure environment
configure_environment() {
    print_status "Configuring environment..."

    ENV_FILE="$HOMEBRAIN_DIR/server/.env"

    if [[ ! -f "$ENV_FILE" ]]; then
        sudo -u $HOMEBRAIN_USER cp $HOMEBRAIN_DIR/server/.env.example $ENV_FILE

        # Generate JWT secrets
        JWT_ACCESS_SECRET=$(openssl rand -base64 64)
        JWT_REFRESH_SECRET=$(openssl rand -base64 64)

        # Update environment file with generated secrets
        sudo -u $HOMEBRAIN_USER sed -i "s/your-super-secret-jwt-access-key-here/$JWT_ACCESS_SECRET/" $ENV_FILE
        sudo -u $HOMEBRAIN_USER sed -i "s/your-super-secret-jwt-refresh-key-here/$JWT_REFRESH_SECRET/" $ENV_FILE

        print_success "Environment configuration created"
        print_warning "Please edit $ENV_FILE to configure your API keys and location settings"
    else
        print_success "Environment configuration already exists"
    fi
}

# Function to configure audio
configure_audio() {
    print_status "Configuring audio system..."

    # Install audio packages
    sudo apt install -y alsa-utils pulseaudio pulseaudio-utils

    # Add homebrain user to audio group
    sudo usermod -a -G audio $HOMEBRAIN_USER

    # Create basic ALSA configuration if no USB audio detected
    if ! arecord -l | grep -q "USB Audio"; then
        print_warning "No USB audio device detected. Using default audio configuration."
    fi

    print_success "Audio system configured"
}

# Function to setup systemd services
setup_services() {
    print_status "Setting up systemd services..."

    # Create HomeBrain service
    sudo tee /etc/systemd/system/homebrain.service > /dev/null << EOF
[Unit]
Description=HomeBrain Smart Home Hub
After=network.target mongodb.service
Requires=mongodb.service
StartLimitBurst=3
StartLimitIntervalSec=60

[Service]
Type=simple
User=$HOMEBRAIN_USER
WorkingDirectory=$HOMEBRAIN_DIR
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Resource limits
MemoryLimit=1G
CPUQuota=80%

[Install]
WantedBy=multi-user.target
EOF

    # Create Discovery service
    sudo tee /etc/systemd/system/homebrain-discovery.service > /dev/null << EOF
[Unit]
Description=HomeBrain Device Discovery
After=network.target homebrain.service
Requires=homebrain.service
StartLimitBurst=3
StartLimitIntervalSec=60

[Service]
Type=simple
User=$HOMEBRAIN_USER
WorkingDirectory=$HOMEBRAIN_DIR/server
ExecStart=/usr/bin/node services/discoveryService.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    # Reload systemd and enable services
    sudo systemctl daemon-reload
    sudo systemctl enable homebrain
    sudo systemctl enable homebrain-discovery

    print_success "Systemd services configured"
}

# Function to configure firewall
configure_firewall() {
    print_status "Configuring firewall..."

    # Install UFW if not present
    sudo apt install -y ufw

    # Configure basic rules
    sudo ufw --force reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing

    # Allow SSH
    sudo ufw allow ssh

    # Allow HomeBrain ports
    sudo ufw allow 3000/tcp comment 'HomeBrain API'
    sudo ufw allow 5173/tcp comment 'HomeBrain Web'
    sudo ufw allow 8080/tcp comment 'HomeBrain WebSocket'
    sudo ufw allow 12345/udp comment 'HomeBrain Discovery'

    # Allow local network access (modify as needed)
    LOCAL_NETWORK=$(ip route | grep $(ip route | grep default | awk '{print $5}') | grep -E '192\.168\.|10\.|172\.' | head -1 | awk '{print $1}')
    if [[ -n "$LOCAL_NETWORK" ]]; then
        sudo ufw allow from $LOCAL_NETWORK
        print_success "Allowed access from local network: $LOCAL_NETWORK"
    fi

    # Enable firewall
    sudo ufw --force enable

    print_success "Firewall configured"
}

# Function to optimize Jetson performance
optimize_jetson() {
    print_status "Optimizing Jetson performance..."

    # Set maximum performance mode
    if command -v nvpmodel &> /dev/null; then
        sudo nvpmodel -m 0
        print_success "Set Jetson to maximum performance mode"
    fi

    # Set CPU governor to performance
    echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null

    # Configure swap if using microSD
    if ! grep -q '/swapfile' /proc/swaps; then
        print_status "Creating swap file..."
        sudo fallocate -l 2G /swapfile
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
        sudo swapon /swapfile

        # Add to fstab
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

        # Configure swappiness
        echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf

        print_success "Swap file created and configured"
    fi

    print_success "Jetson optimization complete"
}

# Function to initialize database
initialize_database() {
    print_status "Initializing database..."

    cd $HOMEBRAIN_DIR

    # Wait for MongoDB to be ready
    sleep 10

    # Test database connection
    if ! sudo -u $HOMEBRAIN_USER npm run test-db; then
        print_error "Database connection test failed"
        exit 1
    fi

    # Create admin user if it doesn't exist
    sudo -u $HOMEBRAIN_USER npm run create-admin || true

    # Seed initial data
    sudo -u $HOMEBRAIN_USER npm run seed || true

    print_success "Database initialized"
}

# Function to start services
start_services() {
    print_status "Starting HomeBrain services..."

    # Start services
    sudo systemctl start homebrain
    sudo systemctl start homebrain-discovery

    # Wait for services to start
    sleep 10

    # Check service status
    if sudo systemctl is-active --quiet homebrain; then
        print_success "HomeBrain service started"
    else
        print_error "HomeBrain service failed to start"
        sudo systemctl status homebrain
        exit 1
    fi

    if sudo systemctl is-active --quiet homebrain-discovery; then
        print_success "Discovery service started"
    else
        print_warning "Discovery service failed to start (this may be normal)"
    fi
}

# Function to verify installation
verify_installation() {
    print_status "Verifying installation..."

    # Check web interface
    if curl -s http://localhost:5173 > /dev/null; then
        print_success "Web interface is accessible"
    else
        print_warning "Web interface may not be ready yet"
    fi

    # Check API
    if curl -s http://localhost:3000/api/ping > /dev/null; then
        print_success "API is accessible"
    else
        print_warning "API may not be ready yet"
    fi

    # Get system IP
    SYSTEM_IP=$(hostname -I | awk '{print $1}')

    print_success "Installation verification complete"
    echo
    print_success "HomeBrain installation completed successfully!"
    echo
    echo -e "${GREEN}Next Steps:${NC}"
    echo "1. Access the web interface at: ${BLUE}http://$SYSTEM_IP:5173${NC}"
    echo "2. Complete the initial setup wizard"
    echo "3. Configure your integrations in Settings"
    echo "4. Set up remote voice devices using the provided installer"
    echo
    echo -e "${YELLOW}Configuration:${NC}"
    echo "- Edit environment: $ENV_FILE"
    echo "- Check logs: sudo journalctl -u homebrain -f"
    echo "- Service control: sudo systemctl {start|stop|restart} homebrain"
    echo
    echo -e "${YELLOW}Documentation:${NC}"
    echo "- Configuration guide: $HOMEBRAIN_DIR/docs/configuration.md"
    echo "- Troubleshooting: $HOMEBRAIN_DIR/docs/troubleshooting.md"
}

# Main installation function
main() {
    echo -e "${BLUE}"
    echo "=========================================="
    echo "  HomeBrain Jetson Installation Script"
    echo "=========================================="
    echo -e "${NC}"

    check_root
    check_jetson

    print_status "Starting HomeBrain installation..."

    update_system
    install_nodejs
    install_mongodb
    install_pm2
    create_user
    install_homebrain
    configure_environment
    configure_audio
    setup_services
    configure_firewall
    optimize_jetson
    initialize_database
    start_services
    verify_installation

    echo
    print_success "Installation completed successfully!"
}

# Run main function
main "$@"