#!/usr/bin/env bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HOMEBRAIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOMEBRAIN_DIR="${HOMEBRAIN_DIR:-$DEFAULT_HOMEBRAIN_DIR}"
HOMEBRAIN_USER="${HOMEBRAIN_USER:-${SUDO_USER:-$USER}}"
SERVICE_NAME="homebrain"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[OK]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

require_repo() {
  if [[ ! -f "${HOMEBRAIN_DIR}/package.json" || ! -d "${HOMEBRAIN_DIR}/server" || ! -d "${HOMEBRAIN_DIR}/client" ]]; then
    print_error "HomeBrain repo not found at ${HOMEBRAIN_DIR}"
    exit 1
  fi
}

resolve_node_bin() {
  command -v node 2>/dev/null || true
}

run_modern_npm() {
  local quoted_args=()
  local arg

  for arg in "$@"; do
    quoted_args+=("$(printf '%q' "$arg")")
  done

  sudo -u "$HOMEBRAIN_USER" bash -lc "cd $(printf '%q' "$HOMEBRAIN_DIR") && node scripts/run-with-modern-node.js npm ${quoted_args[*]}"
}

install_service() {
  require_repo

  local node_bin
  node_bin="$(resolve_node_bin)"
  if [[ -z "$node_bin" ]]; then
    print_error "Node.js is not installed."
    exit 1
  fi

  print_status "Writing ${SERVICE_PATH}"
  sudo tee "$SERVICE_PATH" >/dev/null <<EOF
[Unit]
Description=HomeBrain Smart Home Hub
After=network-online.target mongod.service
Wants=network-online.target
Requires=mongod.service

[Service]
Type=simple
User=${HOMEBRAIN_USER}
WorkingDirectory=${HOMEBRAIN_DIR}
Environment=NODE_ENV=production
ExecStart=${node_bin} scripts/run-with-modern-node.js npm start
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable "${SERVICE_NAME}"
  print_success "Service installed and enabled."
}

start_services() {
  print_status "Starting MongoDB and HomeBrain..."
  sudo systemctl start mongod
  sudo systemctl start "${SERVICE_NAME}"
  print_success "Services started."
}

stop_services() {
  print_status "Stopping HomeBrain..."
  sudo systemctl stop "${SERVICE_NAME}"
  print_success "HomeBrain stopped."
}

restart_services() {
  print_status "Restarting HomeBrain..."
  sudo systemctl restart "${SERVICE_NAME}"
  print_success "HomeBrain restarted."
}

show_status() {
  echo "MongoDB:"
  sudo systemctl status mongod --no-pager || true
  echo
  echo "HomeBrain:"
  sudo systemctl status "${SERVICE_NAME}" --no-pager || true
  echo
  echo "Listening ports:"
  sudo ss -lntup 2>/dev/null | grep -E '(:80|:443|:3000|:27017)\b|:12345\b' || true
}

show_logs() {
  case "${1:-homebrain}" in
    homebrain)
      sudo journalctl -u "${SERVICE_NAME}" -n 100 --no-pager
      ;;
    mongodb|mongod)
      sudo journalctl -u mongod -n 100 --no-pager || sudo tail -50 /var/log/mongodb/mongod.log
      ;;
    follow)
      sudo journalctl -f -u "${SERVICE_NAME}" -u mongod
      ;;
    *)
      print_error "Usage: $0 logs [homebrain|mongodb|follow]"
      exit 1
      ;;
  esac
}

update_homebrain() {
  require_repo

  if [[ -n "$(git -C "${HOMEBRAIN_DIR}" status --porcelain)" ]]; then
    print_error "Repository has local changes. Commit or stash them before running update."
    exit 1
  fi

  print_status "Updating HomeBrain from Git..."
  sudo systemctl stop "${SERVICE_NAME}" || true
  sudo -u "$HOMEBRAIN_USER" git -C "${HOMEBRAIN_DIR}" pull --ff-only

  print_status "Installing dependencies..."
  run_modern_npm install --no-audit --no-fund

  print_status "Building client..."
  run_modern_npm run build --prefix client

  if [[ ! -x "${HOMEBRAIN_DIR}/server/.wakeword-venv/bin/python" && -x "${HOMEBRAIN_DIR}/server/scripts/install-openwakeword-deps.sh" ]]; then
    print_warning "Wake-word virtualenv is missing. Bootstrapping it now."
    (cd "${HOMEBRAIN_DIR}/server" && PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh) || true
  fi

  install_service
  sudo systemctl restart "${SERVICE_NAME}"
  print_success "HomeBrain updated."
}

run_health_check() {
  print_status "Running health checks..."

  echo "Service state:"
  for service in mongod "${SERVICE_NAME}"; do
    if sudo systemctl is-active --quiet "$service"; then
      echo "  $service: running"
    else
      echo "  $service: stopped"
    fi
  done
  echo

  echo "HTTP checks:"
  if curl -fsS http://localhost:3000/ping >/dev/null; then
    echo "  ping: ok"
  else
    echo "  ping: failed"
  fi

  if curl -fsS http://localhost:3000/ >/dev/null; then
    echo "  web app: ok"
  else
    echo "  web app: failed"
  fi
  echo

  echo "Ports:"
  sudo ss -lntup 2>/dev/null | grep -E '(:80|:443|:3000|:27017)\b|:12345\b' || true
  echo

  echo "Disk:"
  df -h | sed -n '1,6p'
  echo

  echo "Memory:"
  free -h
  echo

  if command -v mongosh >/dev/null 2>&1; then
    echo "MongoDB ping:"
    mongosh --quiet "mongodb://localhost/HomeBrain" --eval "db.runCommand({ ping: 1 })" || true
    echo
  fi
}

setup_nginx() {
  print_status "Installing and configuring nginx..."
  sudo apt-get update
  sudo apt-get install -y nginx

  sudo tee /etc/nginx/sites-available/homebrain >/dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300;
    }
}
EOF

  sudo ln -sf /etc/nginx/sites-available/homebrain /etc/nginx/sites-enabled/homebrain
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl enable --now nginx
  print_success "nginx now proxies port 80 to HomeBrain on port 3000."
}

setup_ssl() {
  print_status "Preparing certbot + nginx..."
  sudo apt-get update
  sudo apt-get install -y snapd
  sudo snap install core || true
  sudo snap refresh core || true
  sudo snap install --classic certbot || true
  sudo ln -sf /snap/bin/certbot /usr/bin/certbot

  read -r -p "Domain name for HomeBrain: " domain
  if [[ -z "${domain}" ]]; then
    print_error "Domain name is required."
    exit 1
  fi

  sudo certbot --nginx -d "${domain}"
  sudo certbot renew --dry-run
  print_success "TLS configured for ${domain}."
}

show_usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  install-service   Write /etc/systemd/system/homebrain.service
  start             Start MongoDB and HomeBrain
  stop              Stop HomeBrain
  restart           Restart HomeBrain
  status            Show MongoDB/HomeBrain status
  logs [target]     Show logs: homebrain, mongodb, or follow
  update            Pull latest git changes, install deps, build client, restart
  health            Run basic local health checks
  setup-nginx       Proxy port 80 to HomeBrain on port 3000
  setup-ssl         Obtain a Let's Encrypt certificate with certbot + nginx
EOF
}

main() {
  case "${1:-}" in
    install-service) install_service ;;
    start) start_services ;;
    stop) stop_services ;;
    restart) restart_services ;;
    status) show_status ;;
    logs) show_logs "${2:-homebrain}" ;;
    update) update_homebrain ;;
    health) run_health_check ;;
    setup-nginx) setup_nginx ;;
    setup-ssl) setup_ssl ;;
    *) show_usage ;;
  esac
}

main "$@"
