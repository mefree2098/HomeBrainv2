#!/usr/bin/env bash

# HomeBrain Jetson installation script (clean install path)
# - Installs system prerequisites
# - Installs Node.js 22 and MongoDB 6.0
# - Clones/updates HomeBrain
# - Installs/builds app with modern-node wrapper
# - Optionally bootstraps wake-word training dependencies
# - Configures systemd services

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

DEFAULT_REPO_URL="https://github.com/mefree2098/HomeBrainv2.git"
REPO_URL="${HOMEBRAIN_REPO_URL:-$DEFAULT_REPO_URL}"
HOMEBRAIN_DIR="${HOMEBRAIN_DIR:-$HOME/HomeBrainv2}"
NODE_MAJOR="${NODE_MAJOR:-22}"
MONGODB_VERSION="${MONGODB_VERSION:-6.0}"
INSTALL_WAKEWORD_DEPS="${INSTALL_WAKEWORD_DEPS:-1}"
ENABLE_FIREWALL="${ENABLE_FIREWALL:-0}"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
  if [[ $EUID -eq 0 ]]; then
    print_error "Run this script as a regular sudo-capable user, not root."
    exit 1
  fi

  if ! command -v sudo >/dev/null 2>&1; then
    print_error "sudo is required."
    exit 1
  fi

  if ! sudo -n true >/dev/null 2>&1; then
    print_warning "sudo may prompt for your password during installation."
  fi

  if grep -qi tegra /proc/cpuinfo 2>/dev/null; then
    print_success "Jetson platform detected."
  else
    print_warning "Jetson platform not detected; continuing anyway."
  fi
}

install_base_packages() {
  print_status "Installing base system packages..."
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl wget git gnupg ca-certificates lsb-release \
    build-essential python3 python3-pip python3-venv \
    pkg-config libcap2-bin net-tools
  print_success "Base packages installed."
}

install_node() {
  print_status "Ensuring Node.js ${NODE_MAJOR}.x or newer..."

  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= NODE_MAJOR )); then
      print_success "Node.js $(node -v) already satisfies requirement."
      return
    fi
  fi

  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

  print_success "Installed Node $(node -v), npm $(npm -v)."
}

install_mongodb() {
  print_status "Ensuring MongoDB ${MONGODB_VERSION}..."

  if ! command -v mongod >/dev/null 2>&1; then
    local codename
    codename="$(lsb_release -cs)"

    curl -fsSL "https://pgp.mongodb.com/server-${MONGODB_VERSION}.asc" \
      | sudo gpg --dearmor -o "/usr/share/keyrings/mongodb-server-${MONGODB_VERSION}.gpg"

    echo "deb [ arch=arm64,amd64 signed-by=/usr/share/keyrings/mongodb-server-${MONGODB_VERSION}.gpg ] https://repo.mongodb.org/apt/ubuntu ${codename}/mongodb-org/${MONGODB_VERSION} multiverse" \
      | sudo tee "/etc/apt/sources.list.d/mongodb-org-${MONGODB_VERSION}.list" >/dev/null

    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-org
  fi

  sudo systemctl enable --now mongod
  if sudo systemctl is-active --quiet mongod; then
    print_success "MongoDB is active."
  else
    print_error "MongoDB failed to start."
    sudo systemctl status mongod --no-pager || true
    exit 1
  fi
}

clone_or_update_repo() {
  print_status "Preparing HomeBrain repository at ${HOMEBRAIN_DIR}..."

  if [[ -d "${HOMEBRAIN_DIR}/.git" ]]; then
    git -C "${HOMEBRAIN_DIR}" fetch --all --prune
    git -C "${HOMEBRAIN_DIR}" pull --ff-only
  else
    mkdir -p "$(dirname "${HOMEBRAIN_DIR}")"
    git clone "${REPO_URL}" "${HOMEBRAIN_DIR}"
  fi

  print_success "Repository ready."
}

configure_env() {
  print_status "Configuring server environment file..."
  local env_file="${HOMEBRAIN_DIR}/server/.env"

  if [[ ! -f "$env_file" ]]; then
    cp "${HOMEBRAIN_DIR}/server/.env.example" "$env_file"

    local jwt_secret refresh_secret
    jwt_secret="$(openssl rand -hex 32)"
    refresh_secret="$(openssl rand -hex 32)"

    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${jwt_secret}|" "$env_file"
    sed -i "s|^REFRESH_TOKEN_SECRET=.*|REFRESH_TOKEN_SECRET=${refresh_secret}|" "$env_file"

    if ! grep -q '^DATABASE_URL=' "$env_file"; then
      echo 'DATABASE_URL=mongodb://localhost/HomeBrain' >> "$env_file"
    fi

    print_success "Created ${env_file}."
    print_warning "Review ${env_file} and add API keys before production use."
  else
    print_success "Existing ${env_file} found; leaving it unchanged."
  fi
}

install_app_dependencies() {
  print_status "Installing HomeBrain dependencies..."
  cd "${HOMEBRAIN_DIR}"

  node scripts/run-with-modern-node.js npm install --no-audit --no-fund
  node scripts/run-with-modern-node.js npm install --no-audit --no-fund --prefix server
  node scripts/run-with-modern-node.js npm install --no-audit --no-fund --prefix client

  print_status "Building client..."
  node scripts/run-with-modern-node.js npm run build --prefix client
  print_success "Dependencies installed and client built."
}

bootstrap_wakeword() {
  if [[ "$INSTALL_WAKEWORD_DEPS" != "1" ]]; then
    print_warning "Skipping wake-word dependency bootstrap (INSTALL_WAKEWORD_DEPS=${INSTALL_WAKEWORD_DEPS})."
    return
  fi

  if [[ -x "${HOMEBRAIN_DIR}/server/.wakeword-venv/bin/python" ]]; then
    print_success "Wake-word virtualenv already present."
    return
  fi

  print_status "Bootstrapping wake-word training dependencies (this can take several minutes)..."
  if (cd "${HOMEBRAIN_DIR}/server" && PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh); then
    print_success "Wake-word dependencies installed."
  else
    print_warning "Wake-word dependency install failed. You can retry later:"
    print_warning "  cd ${HOMEBRAIN_DIR}/server && PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh"
  fi
}

ensure_node_capability() {
  print_status "Granting Node permission to bind ports 80/443..."

  local node_bin
  node_bin="$(cd "${HOMEBRAIN_DIR}" && node scripts/run-with-modern-node.js node -p 'process.execPath' 2>/dev/null | tail -n 1 || true)"

  if [[ -z "$node_bin" ]]; then
    node_bin="$(readlink -f "$(command -v node)")"
  fi

  if [[ -z "$node_bin" ]]; then
    print_warning "Could not resolve Node binary for setcap."
    return
  fi

  if sudo setcap 'cap_net_bind_service=+ep' "$node_bin"; then
    print_success "Set cap_net_bind_service on ${node_bin}."
  else
    print_warning "Failed to set capability on ${node_bin}."
  fi
}

configure_systemd() {
  print_status "Configuring systemd services..."

  local run_user
  run_user="${SUDO_USER:-$USER}"

  sudo tee /etc/systemd/system/homebrain.service >/dev/null <<EOF2
[Unit]
Description=HomeBrain Smart Home Hub
After=network.target mongod.service
Requires=mongod.service

[Service]
Type=simple
User=${run_user}
WorkingDirectory=${HOMEBRAIN_DIR}
Environment=NODE_ENV=production
Environment=WAKEWORD_PIPER_EXEC=${HOMEBRAIN_DIR}/server/.wakeword-venv/bin/piper
ExecStart=/usr/bin/node scripts/run-with-modern-node.js npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF2

  sudo tee /etc/systemd/system/homebrain-discovery.service >/dev/null <<EOF2
[Unit]
Description=HomeBrain Device Discovery Service
After=network.target homebrain.service
Requires=homebrain.service

[Service]
Type=simple
User=${run_user}
WorkingDirectory=${HOMEBRAIN_DIR}/server
ExecStart=/usr/bin/node services/discoveryService.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF2

  sudo systemctl daemon-reload
  sudo systemctl enable homebrain homebrain-discovery

  print_success "Systemd services configured."
}

configure_deploy_sudoers() {
  print_status "Configuring passwordless restart for UI deploy..."
  local run_user
  run_user="${SUDO_USER:-$USER}"

  echo "${run_user} ALL=(ALL) NOPASSWD:/usr/bin/systemctl,/bin/systemctl" \
    | sudo tee /etc/sudoers.d/homebrain-deploy >/dev/null
  sudo chmod 0440 /etc/sudoers.d/homebrain-deploy
  print_success "sudoers file created: /etc/sudoers.d/homebrain-deploy"
}

configure_firewall() {
  if [[ "$ENABLE_FIREWALL" != "1" ]]; then
    print_warning "Skipping UFW configuration (ENABLE_FIREWALL=${ENABLE_FIREWALL})."
    return
  fi

  print_status "Configuring UFW..."
  sudo apt-get install -y ufw
  sudo ufw --force reset
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow ssh
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw allow 3000/tcp
  sudo ufw allow 5173/tcp
  sudo ufw allow 12345/udp
  sudo ufw --force enable
  print_success "UFW configured."
}

start_and_verify() {
  print_status "Starting HomeBrain services..."
  sudo systemctl restart homebrain homebrain-discovery

  sleep 5
  if ! sudo systemctl is-active --quiet homebrain; then
    print_error "homebrain service failed to start."
    sudo systemctl status homebrain --no-pager || true
    exit 1
  fi

  print_success "homebrain service is running."
  print_status "Recent logs:"
  sudo journalctl -u homebrain -n 20 --no-pager || true
}

print_summary() {
  local ip
  ip="$(hostname -I | awk '{print $1}')"

  echo
  print_success "HomeBrain installation complete"
  echo "Repository: ${HOMEBRAIN_DIR}"
  echo "UI: http://${ip}:5173"
  echo "API: http://${ip}:3000"
  echo
  echo "Useful commands:"
  echo "  sudo systemctl status homebrain --no-pager"
  echo "  sudo journalctl -u homebrain -f"
  echo "  cd ${HOMEBRAIN_DIR} && node scripts/run-with-modern-node.js npm run build --prefix client"
  echo
}

main() {
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE} HomeBrain Jetson Clean Install${NC}"
  echo -e "${BLUE}========================================${NC}"

  check_prerequisites
  install_base_packages
  install_node
  install_mongodb
  clone_or_update_repo
  configure_env
  install_app_dependencies
  bootstrap_wakeword
  ensure_node_capability
  configure_systemd
  configure_deploy_sudoers
  configure_firewall
  start_and_verify
  print_summary
}

main "$@"
