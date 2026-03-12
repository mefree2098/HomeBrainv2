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
CADDY_SERVICE_NAME="${CADDY_SERVICE_NAME:-caddy-api}"
CADDY_SERVICE_PATH="/etc/systemd/system/${CADDY_SERVICE_NAME}.service"
CADDY_BOOTSTRAP_PATH="${CADDY_BOOTSTRAP_PATH:-/etc/caddy/Caddyfile}"

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
  if [[ -x /usr/bin/node ]]; then
    echo /usr/bin/node
    return
  fi

  if [[ -x /usr/local/bin/node ]]; then
    echo /usr/local/bin/node
    return
  fi

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

cleanup_orphaned_homebrain_processes() {
  local service_pid="0"
  local stale_pids=()

  service_pid="$(sudo systemctl show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || echo 0)"
  service_pid="${service_pid:-0}"

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue

    local pid="${line%% *}"
    local cmd="${line#* }"
    if [[ -z "${pid}" || "${pid}" == "${service_pid}" ]]; then
      continue
    fi

    if [[ "${cmd}" == *"${HOMEBRAIN_DIR}"* ]] && [[ "${cmd}" == *"node"* ]] && [[ "${cmd}" == *"server.js"* || "${cmd}" == *"run-with-modern-node.js npm start"* ]]; then
      stale_pids+=("${pid}")
    fi
  done < <(ps -eo pid=,args=)

  if [[ "${#stale_pids[@]}" -eq 0 ]]; then
    return
  fi

  print_warning "Stopping orphaned HomeBrain Node process(es): ${stale_pids[*]}"
  sudo kill "${stale_pids[@]}" 2>/dev/null || true
  sleep 2
  sudo kill -9 "${stale_pids[@]}" 2>/dev/null || true
}

print_port_listener_summary() {
  sudo ss -lntup 2>/dev/null | grep -E '(:80|:443|:3000|:27017)\b|:12345\b' || true
}

report_edge_port_owner() {
  local edge_output
  edge_output="$(sudo ss -lntp '( sport = :80 or sport = :443 )' 2>/dev/null || true)"

  if [[ -z "${edge_output//[[:space:]]/}" ]]; then
    echo "  edge listener: none"
    return
  fi

  if grep -qi 'caddy' <<<"${edge_output}"; then
    echo "  edge listener: caddy"
  elif grep -qi 'node' <<<"${edge_output}"; then
    echo "  edge listener: unexpected node process"
  else
    echo "  edge listener: unexpected process"
  fi
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
  cleanup_orphaned_homebrain_processes
  print_success "HomeBrain stopped."
}

restart_services() {
  print_status "Restarting HomeBrain..."
  sudo systemctl restart "${SERVICE_NAME}"
  print_success "HomeBrain restarted."
}

wait_for_homebrain_http() {
  local attempts="${1:-20}"
  local delay_seconds="${2:-1}"
  local attempt=1

  while (( attempt <= attempts )); do
    if curl -fsS http://127.0.0.1:3000/ping >/dev/null 2>&1; then
      print_success "HomeBrain is responding on port 3000."
      return 0
    fi

    sleep "${delay_seconds}"
    attempt=$((attempt + 1))
  done

  print_error "HomeBrain did not respond on port 3000 after restart."
  return 1
}

ensure_caddy_user() {
  if ! id -u caddy >/dev/null 2>&1; then
    sudo useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
  fi
}

install_caddy_package() {
  print_status "Ensuring Caddy is installed..."
  sudo apt-get update
  if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y caddy; then
    print_success "Caddy package installed."
    return
  fi

  print_warning "Default apt source did not provide Caddy. Adding the upstream stable repository."
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  print_success "Caddy package installed from upstream repository."
}

write_caddy_bootstrap() {
  sudo mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
  ensure_caddy_user
  sudo chown -R caddy:caddy /var/lib/caddy /var/log/caddy

  print_status "Writing ${CADDY_BOOTSTRAP_PATH}"
  sudo tee "${CADDY_BOOTSTRAP_PATH}" >/dev/null <<'EOF'
{
    admin 127.0.0.1:2019
    storage file_system {
        root /var/lib/caddy
    }
}
EOF
}

install_caddy_service() {
  local caddy_bin
  caddy_bin="$(command -v caddy 2>/dev/null || true)"
  if [[ -z "${caddy_bin}" ]]; then
    print_error "Caddy is not installed."
    exit 1
  fi

  ensure_caddy_user

  print_status "Writing ${CADDY_SERVICE_PATH}"
  sudo tee "${CADDY_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Caddy API Edge for HomeBrain
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=${caddy_bin} run --environ --resume --config ${CADDY_BOOTSTRAP_PATH} --adapter caddyfile
ExecReload=${caddy_bin} reload --address 127.0.0.1:2019 --config ${CADDY_BOOTSTRAP_PATH} --adapter caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/caddy /var/log/caddy /etc/caddy

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable "${CADDY_SERVICE_NAME}"
}

setup_caddy() {
  install_caddy_package
  write_caddy_bootstrap
  install_caddy_service

  if [[ "${CADDY_SERVICE_NAME}" != "caddy" ]] && sudo systemctl list-unit-files | grep -q '^caddy.service'; then
    print_warning "Disabling the stock caddy.service so ${CADDY_SERVICE_NAME} owns the edge runtime."
    sudo systemctl disable --now caddy || true
  fi

  if sudo systemctl is-active --quiet nginx; then
    print_warning "Stopping nginx so Caddy can own public 80/443."
    sudo systemctl disable --now nginx || true
  fi

  print_status "Starting ${CADDY_SERVICE_NAME}..."
  sudo systemctl restart "${CADDY_SERVICE_NAME}"

  if curl -fsS http://127.0.0.1:2019/config/ >/dev/null; then
    print_success "Caddy admin API is reachable at http://127.0.0.1:2019."
  else
    print_warning "Caddy started, but the admin API did not respond yet."
  fi
}

show_status() {
  echo "MongoDB:"
  sudo systemctl status mongod --no-pager || true
  echo
  echo "HomeBrain:"
  sudo systemctl status "${SERVICE_NAME}" --no-pager || true
  echo
  echo "Caddy:"
  sudo systemctl status "${CADDY_SERVICE_NAME}" --no-pager || true
  echo
  echo "Listening ports:"
  print_port_listener_summary
}

show_logs() {
  case "${1:-homebrain}" in
    homebrain)
      sudo journalctl -u "${SERVICE_NAME}" -n 100 --no-pager
      ;;
    mongodb|mongod)
      sudo journalctl -u mongod -n 100 --no-pager || sudo tail -50 /var/log/mongodb/mongod.log
      ;;
    caddy)
      sudo journalctl -u "${CADDY_SERVICE_NAME}" -n 100 --no-pager
      ;;
    follow)
      sudo journalctl -f -u "${SERVICE_NAME}" -u mongod -u "${CADDY_SERVICE_NAME}"
      ;;
    *)
      print_error "Usage: $0 logs [homebrain|mongodb|caddy|follow]"
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
  cleanup_orphaned_homebrain_processes
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

  wait_for_homebrain_http 20 1

  print_status "Bootstrapping reverse proxy database state..."
  sudo -u "$HOMEBRAIN_USER" bash -lc "cd $(printf '%q' "$HOMEBRAIN_DIR") && node server/scripts/bootstrapReverseProxyState.js --actor system:update"
  print_success "HomeBrain updated."
}

run_health_check() {
  print_status "Running health checks..."

  echo "Service state:"
  for service in mongod "${SERVICE_NAME}" "${CADDY_SERVICE_NAME}"; do
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

  if curl -fsS http://127.0.0.1:2019/config/ >/dev/null; then
    echo "  caddy admin: ok"
  else
    echo "  caddy admin: failed"
  fi
  report_edge_port_owner
  echo

  echo "Ports:"
  print_port_listener_summary
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
  print_warning "setup-ssl is a legacy path. Prefer 'setup-caddy' plus Reverse Proxy / Domains in the HomeBrain UI."
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
  setup-caddy       Install Caddy as the native public edge service
  start             Start MongoDB and HomeBrain
  stop              Stop HomeBrain
  restart           Restart HomeBrain
  status            Show MongoDB/HomeBrain status
  logs [target]     Show logs: homebrain, mongodb, caddy, or follow
  update            Pull latest git changes, install deps, build client, restart
  health            Run basic local health checks
  setup-nginx       Legacy: proxy port 80 to HomeBrain on port 3000
  setup-ssl         Legacy: obtain a Let's Encrypt certificate with certbot + nginx
EOF
}

main() {
  case "${1:-}" in
    install-service) install_service ;;
    setup-caddy) setup_caddy ;;
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
