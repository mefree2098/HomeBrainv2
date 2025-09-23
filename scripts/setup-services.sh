#!/bin/bash

# HomeBrain Services Setup Script
# Additional configuration and service management utilities

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

HOMEBRAIN_DIR="/opt/homebrain"
HOMEBRAIN_USER="homebrain"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Function to show usage
show_usage() {
    echo "Usage: $0 [COMMAND]"
    echo
    echo "Commands:"
    echo "  start           Start all HomeBrain services"
    echo "  stop            Stop all HomeBrain services"
    echo "  restart         Restart all HomeBrain services"
    echo "  status          Show service status"
    echo "  logs            Show service logs"
    echo "  update          Update HomeBrain application"
    echo "  backup          Create system backup"
    echo "  restore         Restore from backup"
    echo "  reset           Reset configuration to defaults"
    echo "  health          Run system health check"
    echo "  setup-nginx     Configure nginx reverse proxy"
    echo "  setup-ssl       Configure SSL certificates"
    echo "  optimize        Run performance optimizations"
    echo
}

# Service management functions
start_services() {
    print_status "Starting HomeBrain services..."
    sudo systemctl start mongodb
    sudo systemctl start homebrain
    sudo systemctl start homebrain-discovery
    print_success "Services started"
}

stop_services() {
    print_status "Stopping HomeBrain services..."
    sudo systemctl stop homebrain-discovery
    sudo systemctl stop homebrain
    print_success "Services stopped"
}

restart_services() {
    print_status "Restarting HomeBrain services..."
    sudo systemctl restart homebrain
    sudo systemctl restart homebrain-discovery
    print_success "Services restarted"
}

show_status() {
    echo "HomeBrain Service Status:"
    echo "========================"
    sudo systemctl status mongodb --no-pager
    echo
    sudo systemctl status homebrain --no-pager
    echo
    sudo systemctl status homebrain-discovery --no-pager
    echo

    # Show process information
    echo "Process Information:"
    echo "==================="
    ps aux | grep -E "(mongod|node.*homebrain)" | grep -v grep
    echo

    # Show port usage
    echo "Port Usage:"
    echo "==========="
    sudo netstat -tulnp | grep -E "(3000|5173|8080|12345|27017)"
}

show_logs() {
    echo "Select log to view:"
    echo "1) HomeBrain main service"
    echo "2) Discovery service"
    echo "3) MongoDB"
    echo "4) All services"
    echo "5) Live follow mode"
    read -p "Choice (1-5): " choice

    case $choice in
        1) sudo journalctl -u homebrain -n 50 ;;
        2) sudo journalctl -u homebrain-discovery -n 50 ;;
        3) sudo tail -50 /var/log/mongodb/mongod.log ;;
        4)
            sudo journalctl -u homebrain -n 25
            echo "--- Discovery Service ---"
            sudo journalctl -u homebrain-discovery -n 25
            ;;
        5) sudo journalctl -f -u homebrain -u homebrain-discovery ;;
        *) print_error "Invalid choice" ;;
    esac
}

# Update application
update_homebrain() {
    print_status "Updating HomeBrain application..."

    # Stop services
    stop_services

    # Backup current version
    BACKUP_DIR="/tmp/homebrain-backup-$(date +%Y%m%d-%H%M%S)"
    sudo -u $HOMEBRAIN_USER cp -r $HOMEBRAIN_DIR $BACKUP_DIR
    print_status "Backed up current version to $BACKUP_DIR"

    # Update application
    cd $HOMEBRAIN_DIR
    sudo -u $HOMEBRAIN_USER git pull

    # Update dependencies
    sudo -u $HOMEBRAIN_USER npm install
    cd server && sudo -u $HOMEBRAIN_USER npm install
    cd ../client && sudo -u $HOMEBRAIN_USER npm install

    # Build client
    cd ..
    sudo -u $HOMEBRAIN_USER npm run build

    # Start services
    start_services

    print_success "HomeBrain updated successfully"
    print_warning "Backup available at: $BACKUP_DIR"
}

# Backup system
create_backup() {
    print_status "Creating system backup..."

    BACKUP_DIR="/backup/homebrain-$(date +%Y%m%d-%H%M%S)"
    sudo mkdir -p $BACKUP_DIR

    # Backup database
    sudo -u $HOMEBRAIN_USER mongodump --db homebrain --out $BACKUP_DIR/database

    # Backup configuration
    sudo cp -r $HOMEBRAIN_DIR/server/.env $BACKUP_DIR/
    sudo cp -r $HOMEBRAIN_DIR/server/config $BACKUP_DIR/ 2>/dev/null || true

    # Backup service files
    sudo cp /etc/systemd/system/homebrain*.service $BACKUP_DIR/

    # Create archive
    sudo tar -czf $BACKUP_DIR.tar.gz -C $(dirname $BACKUP_DIR) $(basename $BACKUP_DIR)
    sudo rm -rf $BACKUP_DIR

    print_success "Backup created: $BACKUP_DIR.tar.gz"
}

# Restore system
restore_backup() {
    echo "Available backups:"
    ls -la /backup/homebrain-*.tar.gz 2>/dev/null || echo "No backups found"
    echo
    read -p "Enter backup file path: " backup_file

    if [[ ! -f "$backup_file" ]]; then
        print_error "Backup file not found: $backup_file"
        return 1
    fi

    print_warning "This will restore the system from backup. Continue? (y/N)"
    read -p "> " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        print_status "Restore cancelled"
        return 0
    fi

    print_status "Restoring from backup: $backup_file"

    # Stop services
    stop_services

    # Extract backup
    TEMP_DIR="/tmp/homebrain-restore-$(date +%s)"
    mkdir -p $TEMP_DIR
    tar -xzf $backup_file -C $TEMP_DIR

    # Restore database
    BACKUP_NAME=$(basename $backup_file .tar.gz)
    mongorestore --db homebrain --drop $TEMP_DIR/$BACKUP_NAME/database/homebrain/

    # Restore configuration
    sudo cp $TEMP_DIR/$BACKUP_NAME/.env $HOMEBRAIN_DIR/server/
    sudo chown $HOMEBRAIN_USER:$HOMEBRAIN_USER $HOMEBRAIN_DIR/server/.env

    # Start services
    start_services

    # Cleanup
    rm -rf $TEMP_DIR

    print_success "System restored from backup"
}

# Reset configuration
reset_config() {
    print_warning "This will reset all configuration to defaults. Continue? (y/N)"
    read -p "> " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        print_status "Reset cancelled"
        return 0
    fi

    print_status "Resetting configuration..."

    # Stop services
    stop_services

    # Backup current config
    sudo cp $HOMEBRAIN_DIR/server/.env $HOMEBRAIN_DIR/server/.env.backup.$(date +%s)

    # Reset to example
    sudo -u $HOMEBRAIN_USER cp $HOMEBRAIN_DIR/server/.env.example $HOMEBRAIN_DIR/server/.env

    # Generate new JWT secrets
    JWT_ACCESS_SECRET=$(openssl rand -base64 64)
    JWT_REFRESH_SECRET=$(openssl rand -base64 64)

    sudo -u $HOMEBRAIN_USER sed -i "s/your-super-secret-jwt-access-key-here/$JWT_ACCESS_SECRET/" $HOMEBRAIN_DIR/server/.env
    sudo -u $HOMEBRAIN_USER sed -i "s/your-super-secret-jwt-refresh-key-here/$JWT_REFRESH_SECRET/" $HOMEBRAIN_DIR/server/.env

    # Start services
    start_services

    print_success "Configuration reset to defaults"
    print_warning "Please edit $HOMEBRAIN_DIR/server/.env to configure your settings"
}

# Health check
run_health_check() {
    print_status "Running system health check..."

    # Check services
    echo "Service Health:"
    echo "=============="
    for service in mongodb homebrain homebrain-discovery; do
        if sudo systemctl is-active --quiet $service; then
            echo -e "  $service: ${GREEN}Running${NC}"
        else
            echo -e "  $service: ${RED}Stopped${NC}"
        fi
    done
    echo

    # Check network ports
    echo "Network Ports:"
    echo "============="
    for port in 3000 5173 8080 12345 27017; do
        if sudo netstat -tuln | grep -q ":$port "; then
            echo -e "  Port $port: ${GREEN}Open${NC}"
        else
            echo -e "  Port $port: ${RED}Closed${NC}"
        fi
    done
    echo

    # Check disk space
    echo "Disk Space:"
    echo "==========="
    df -h | grep -E "(Filesystem|/dev/)"
    echo

    # Check memory usage
    echo "Memory Usage:"
    echo "============"
    free -h
    echo

    # Check system load
    echo "System Load:"
    echo "==========="
    uptime
    echo

    # Test database connection
    echo "Database Connection:"
    echo "==================="
    if mongo --eval "db.runCommand('ping')" homebrain &>/dev/null; then
        echo -e "  MongoDB: ${GREEN}Connected${NC}"
    else
        echo -e "  MongoDB: ${RED}Connection Failed${NC}"
    fi
    echo

    # Test API endpoints
    echo "API Endpoints:"
    echo "============="
    if curl -s http://localhost:3000/api/ping &>/dev/null; then
        echo -e "  API: ${GREEN}Responding${NC}"
    else
        echo -e "  API: ${RED}Not Responding${NC}"
    fi

    if curl -s http://localhost:5173 &>/dev/null; then
        echo -e "  Web Interface: ${GREEN}Accessible${NC}"
    else
        echo -e "  Web Interface: ${RED}Not Accessible${NC}"
    fi
    echo

    print_success "Health check complete"
}

# Setup nginx reverse proxy
setup_nginx() {
    print_status "Setting up nginx reverse proxy..."

    # Install nginx
    sudo apt update
    sudo apt install -y nginx

    # Create configuration
    sudo tee /etc/nginx/sites-available/homebrain > /dev/null << 'EOF'
server {
    listen 80;
    server_name _;

    # Main application
    location / {
        proxy_pass http://localhost:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API endpoints
    location /api {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket support
    location /socket.io {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

    # Enable site
    sudo ln -sf /etc/nginx/sites-available/homebrain /etc/nginx/sites-enabled/
    sudo rm -f /etc/nginx/sites-enabled/default

    # Test configuration
    sudo nginx -t

    # Start and enable nginx
    sudo systemctl enable nginx
    sudo systemctl restart nginx

    # Update firewall
    sudo ufw allow 'Nginx Full'

    print_success "Nginx reverse proxy configured"
    print_status "HomeBrain is now accessible on port 80"
}

# Setup SSL certificates
setup_ssl() {
    print_status "Setting up SSL certificates with Let's Encrypt..."

    # Install certbot
    sudo apt update
    sudo apt install -y snapd
    sudo snap install core; sudo snap refresh core
    sudo snap install --classic certbot
    sudo ln -sf /snap/bin/certbot /usr/bin/certbot

    echo "Enter your domain name (e.g., homebrain.yourdomain.com):"
    read -p "> " domain

    if [[ -z "$domain" ]]; then
        print_error "Domain name is required"
        return 1
    fi

    # Get certificate
    sudo certbot --nginx -d $domain

    # Test renewal
    sudo certbot renew --dry-run

    print_success "SSL certificate configured for $domain"
}

# Performance optimizations
run_optimizations() {
    print_status "Running performance optimizations..."

    # Set Jetson to max performance
    if command -v nvpmodel &> /dev/null; then
        sudo nvpmodel -m 0
        print_success "Set Jetson to maximum performance mode"
    fi

    # Set CPU governor
    echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null
    print_success "Set CPU governor to performance mode"

    # Optimize MongoDB
    sudo tee -a /etc/mongod.conf > /dev/null << EOF

# Performance optimizations
storage:
  wiredTiger:
    engineConfig:
      cacheSizeGB: 1
    collectionConfig:
      blockCompressor: snappy
    indexConfig:
      prefixCompression: true
EOF

    # Optimize Node.js
    echo 'export NODE_OPTIONS="--max-old-space-size=2048"' | sudo tee -a /etc/environment

    # Restart services to apply changes
    restart_services

    print_success "Performance optimizations applied"
}

# Main function
main() {
    case "${1:-}" in
        start) start_services ;;
        stop) stop_services ;;
        restart) restart_services ;;
        status) show_status ;;
        logs) show_logs ;;
        update) update_homebrain ;;
        backup) create_backup ;;
        restore) restore_backup ;;
        reset) reset_config ;;
        health) run_health_check ;;
        setup-nginx) setup_nginx ;;
        setup-ssl) setup_ssl ;;
        optimize) run_optimizations ;;
        *) show_usage ;;
    esac
}

main "$@"