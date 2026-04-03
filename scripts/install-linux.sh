#!/usr/bin/env bash

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST_PROFILE="${HOMEBRAIN_HOST_PROFILE:-linux}"
DEFAULT_REPO_URL="$(git -C "${PROJECT_ROOT}" config --get remote.origin.url 2>/dev/null || true)"
REPO_URL="${HOMEBRAIN_REPO_URL:-$DEFAULT_REPO_URL}"
HOMEBRAIN_DIR="${HOMEBRAIN_DIR:-$PROJECT_ROOT}"
NODE_MAJOR="${NODE_MAJOR:-22}"
MONGODB_VERSION="${MONGODB_VERSION:-6.0}"
INSTALL_WAKEWORD_DEPS="${INSTALL_WAKEWORD_DEPS:-1}"
ENABLE_FIREWALL="${ENABLE_FIREWALL:-0}"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[OK]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
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

  if ! command -v apt-get >/dev/null 2>&1; then
    print_error "This installer supports apt-based Linux distributions only."
    exit 1
  fi
}

host_banner() {
  local title="HomeBrain Linux Install"
  if [[ "$HOST_PROFILE" == "jetson" ]]; then
    title="HomeBrain Jetson Install"
  fi

  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE} ${title}${NC}"
  echo -e "${BLUE}========================================${NC}"
}

detect_host() {
  if grep -qi tegra /proc/cpuinfo 2>/dev/null || grep -qi tegra /proc/device-tree/compatible 2>/dev/null; then
    print_success "Jetson hardware detected."
  elif [[ "$HOST_PROFILE" == "jetson" ]]; then
    print_warning "Jetson hardware not detected; continuing with the generic Linux path."
  else
    print_success "Generic Linux host detected."
  fi
}

stop_running_homebrain_if_present() {
  local stale_pids=()

  cleanup_orphaned_homebrain_processes() {
    while IFS= read -r line; do
      [[ -z "${line}" ]] && continue

      local pid="${line%% *}"
      local cmd="${line#* }"

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

  if ! command -v systemctl >/dev/null 2>&1; then
    cleanup_orphaned_homebrain_processes
    return
  fi

  if ! sudo systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -qx 'homebrain.service'; then
    print_success "No existing HomeBrain service is installed yet."
    return
  fi

  if sudo systemctl is-active --quiet homebrain; then
    print_status "Stopping the running HomeBrain service before install/update..."
    sudo systemctl stop homebrain
    print_success "Stopped the existing HomeBrain service."
  else
    print_success "HomeBrain service is already stopped."
  fi

  cleanup_orphaned_homebrain_processes
}

install_base_packages() {
  print_status "Installing base packages..."
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    curl wget git gnupg ca-certificates lsb-release \
    build-essential python3 python3-pip python3-venv \
    pkg-config libcap2-bin
  print_success "Base packages installed."
}

install_node() {
  print_status "Ensuring Node.js ${NODE_MAJOR}.x or newer..."

  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= NODE_MAJOR )); then
      print_success "Node.js $(node -v) already satisfies the requirement."
      return
    fi
  fi

  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  hash -r 2>/dev/null || true

  local node_bin="/usr/bin/node"
  if [[ ! -x "${node_bin}" ]]; then
    node_bin="$(command -v node)"
  fi

  print_success "Installed Node.js $("${node_bin}" -v) at ${node_bin}."
}

install_mongodb() {
  print_status "Ensuring MongoDB ${MONGODB_VERSION}..."

  if command -v mongod >/dev/null 2>&1; then
    sudo systemctl enable --now mongod
    print_success "MongoDB is already installed."
    return
  fi

  # shellcheck disable=SC1091
  source /etc/os-release

  local codename="${VERSION_CODENAME:-$(lsb_release -cs)}"
  local keyring="/usr/share/keyrings/mongodb-server-${MONGODB_VERSION}.gpg"
  local listfile="/etc/apt/sources.list.d/mongodb-org-${MONGODB_VERSION}.list"
  local repo_url=""
  local repo_line=""

  case "${ID:-}" in
    ubuntu)
      repo_url="https://repo.mongodb.org/apt/ubuntu"
      repo_line="deb [ arch=amd64,arm64 signed-by=${keyring} ] ${repo_url} ${codename}/mongodb-org/${MONGODB_VERSION} multiverse"
      ;;
    debian)
      repo_url="https://repo.mongodb.org/apt/debian"
      repo_line="deb [ arch=amd64,arm64 signed-by=${keyring} ] ${repo_url} ${codename}/mongodb-org/${MONGODB_VERSION} main"
      ;;
    *)
      print_error "Automatic MongoDB setup only supports Ubuntu or Debian. Install MongoDB manually, then rerun."
      exit 1
      ;;
  esac

  curl -fsSL "https://pgp.mongodb.com/server-${MONGODB_VERSION}.asc" | sudo gpg --dearmor -o "${keyring}"
  echo "${repo_line}" | sudo tee "${listfile}" >/dev/null
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mongodb-org
  sudo systemctl enable --now mongod
  print_success "MongoDB installed and started."
}

prepare_repo() {
  print_status "Preparing HomeBrain checkout at ${HOMEBRAIN_DIR}..."

  if [[ "${HOMEBRAIN_DIR}" == "${PROJECT_ROOT}" && -f "${PROJECT_ROOT}/package.json" ]]; then
    print_success "Using the current checkout."
    return
  fi

  if [[ -d "${HOMEBRAIN_DIR}/.git" ]]; then
    git -C "${HOMEBRAIN_DIR}" fetch --all --prune
    git -C "${HOMEBRAIN_DIR}" pull --ff-only
    print_success "Updated existing checkout."
    return
  fi

  if [[ -z "${REPO_URL}" ]]; then
    print_error "No git remote URL found. Set HOMEBRAIN_REPO_URL or clone the repository first."
    exit 1
  fi

  mkdir -p "$(dirname "${HOMEBRAIN_DIR}")"
  git clone "${REPO_URL}" "${HOMEBRAIN_DIR}"
  print_success "Repository cloned."
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "${file}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
  else
    echo "${key}=${value}" >> "${file}"
  fi
}

set_env_value_if_missing() {
  local file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "${file}"; then
    return
  fi

  echo "${key}=${value}" >> "${file}"
}

get_existing_env_value() {
  local file="$1"
  local key="$2"

  if [[ ! -f "${file}" ]]; then
    return
  fi

  grep -E "^${key}=" "${file}" | tail -n 1 | cut -d '=' -f 2- || true
}

get_default_acme_env() {
  local env_file="$1"
  local explicit="${ACME_ENV:-}"
  local public_base_url="${HOMEBRAIN_PUBLIC_BASE_URL:-$(get_existing_env_value "${env_file}" "HOMEBRAIN_PUBLIC_BASE_URL")}"

  if [[ "${explicit}" == "production" || "${explicit}" == "staging" ]]; then
    echo "${explicit}"
    return
  fi

  if [[ -n "${public_base_url}" && "${public_base_url}" != "http://localhost"* && "${public_base_url}" != "http://127.0.0.1"* ]]; then
    echo "production"
    return
  fi

  if [[ -f "${HOMEBRAIN_DIR}/server/certificates/active-chain.pem" && -f "${HOMEBRAIN_DIR}/server/certificates/active-key.pem" ]]; then
    echo "production"
    return
  fi

  echo "staging"
}

configure_env() {
  print_status "Configuring server environment..."
  local env_file="${HOMEBRAIN_DIR}/server/.env"
  local default_acme_env

  if [[ ! -f "${env_file}" ]]; then
    cp "${HOMEBRAIN_DIR}/server/.env.example" "${env_file}"
    set_env_value "${env_file}" "JWT_SECRET" "$(openssl rand -hex 32)"
    set_env_value "${env_file}" "REFRESH_TOKEN_SECRET" "$(openssl rand -hex 32)"
    print_success "Created ${env_file} with fresh local secrets."
  else
    print_success "Existing ${env_file} found; backfilling required keys if needed."
  fi

  default_acme_env="$(get_default_acme_env "${env_file}")"
  set_env_value_if_missing "${env_file}" "DATABASE_URL" "mongodb://localhost/HomeBrain"
  set_env_value_if_missing "${env_file}" "CADDY_ADMIN_URL" "http://127.0.0.1:2019"
  set_env_value_if_missing "${env_file}" "ACME_ENV" "${default_acme_env}"
  set_env_value_if_missing "${env_file}" "HOMEBRAIN_DEFAULT_ADMIN_EMAIL" "matt@freestonefamily.com"
  set_env_value_if_missing "${env_file}" "HOMEBRAIN_DEFAULT_ADMIN_NAME" "Matt Freestone"

  if ! grep -q '^JWT_SECRET=' "${env_file}"; then
    set_env_value "${env_file}" "JWT_SECRET" "$(openssl rand -hex 32)"
  fi

  if ! grep -q '^REFRESH_TOKEN_SECRET=' "${env_file}"; then
    set_env_value "${env_file}" "REFRESH_TOKEN_SECRET" "$(openssl rand -hex 32)"
  fi

  if [[ -n "${HOMEBRAIN_PUBLIC_BASE_URL:-}" ]]; then
    set_env_value "${env_file}" "HOMEBRAIN_PUBLIC_BASE_URL" "${HOMEBRAIN_PUBLIC_BASE_URL}"
  fi

  if [[ -n "${HOMEBRAIN_EXPECTED_PUBLIC_IP:-}" ]]; then
    set_env_value "${env_file}" "HOMEBRAIN_EXPECTED_PUBLIC_IP" "${HOMEBRAIN_EXPECTED_PUBLIC_IP}"
  fi

  if [[ -n "${HOMEBRAIN_DEFAULT_ADMIN_PASSWORD:-}" ]]; then
    set_env_value "${env_file}" "HOMEBRAIN_DEFAULT_ADMIN_PASSWORD" "${HOMEBRAIN_DEFAULT_ADMIN_PASSWORD}"
  fi

  print_warning "Add optional API keys to ${env_file} before enabling cloud providers."
}

install_app() {
  print_status "Installing HomeBrain dependencies..."
  cd "${HOMEBRAIN_DIR}"
  node scripts/run-with-modern-node.js npm install --no-audit --no-fund
  print_status "Ensuring native server modules match the active Node.js runtime..."
  node scripts/run-with-modern-node.js npm run ensure:native --prefix server

  if [[ -d "${HOMEBRAIN_DIR}/client/dist" ]]; then
    print_status "Normalizing client/dist ownership before build..."
    sudo chown -R "${USER}:$(id -gn)" "${HOMEBRAIN_DIR}/client/dist"
    sudo chmod -R u+rwX "${HOMEBRAIN_DIR}/client/dist"
  fi

  print_status "Building the production web app..."
  node scripts/run-with-modern-node.js npm run build --prefix client
  print_success "Dependencies installed and client built."
}

bootstrap_wakeword() {
  if [[ "${INSTALL_WAKEWORD_DEPS}" != "1" ]]; then
    print_warning "Skipping wake-word dependency bootstrap."
    return
  fi

  if [[ -x "${HOMEBRAIN_DIR}/server/.wakeword-venv/bin/python" ]]; then
    print_success "Wake-word virtualenv already exists."
    return
  fi

  print_status "Installing wake-word training dependencies (this can take several minutes)..."
  if (cd "${HOMEBRAIN_DIR}/server" && PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh); then
    print_success "Wake-word dependencies installed."
  else
    print_warning "Wake-word dependency bootstrap failed. HomeBrain will still run, but wake-word training will stay unavailable until you retry."
  fi
}

install_service() {
  print_status "Installing the HomeBrain systemd service..."
  HOMEBRAIN_DIR="${HOMEBRAIN_DIR}" HOMEBRAIN_USER="${USER}" bash "${HOMEBRAIN_DIR}/scripts/setup-services.sh" install-service
}

configure_deploy_sudoers() {
  print_status "Allowing the HomeBrain UI to manage its own service and Ollama updates..."
  HOMEBRAIN_DIR="${HOMEBRAIN_DIR}" HOMEBRAIN_USER="${USER}" bash "${HOMEBRAIN_DIR}/scripts/setup-services.sh" refresh-privileges
}

configure_firewall() {
  if [[ "${ENABLE_FIREWALL}" != "1" ]]; then
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
  sudo ufw allow 12345/udp
  sudo ufw --force enable
  print_success "Firewall configured."
}

start_and_verify() {
  print_status "Starting HomeBrain..."
  sudo systemctl enable --now mongod
  sudo systemctl restart homebrain
  sleep 5

  if ! sudo systemctl is-active --quiet homebrain; then
    print_error "homebrain failed to start."
    sudo systemctl status homebrain --no-pager || true
    sudo journalctl -u homebrain -n 80 --no-pager || true
    exit 1
  fi

  if curl -fsS http://localhost:3000/ping >/dev/null; then
    print_success "HomeBrain is responding on port 3000."
  else
    print_warning "The service is running, but the local ping endpoint did not respond yet."
  fi
}

bootstrap_reverse_proxy_state() {
  print_status "Bootstrapping reverse proxy database state..."
  cd "${HOMEBRAIN_DIR}"
  node server/scripts/bootstrapReverseProxyState.js --actor system:install
  print_status "Bootstrapping identity database state..."
  node server/scripts/bootstrapIdentityState.js --actor system:install
  print_status "Bootstrapping default admin state..."
  node server/scripts/bootstrapAdminState.js --actor system:install
  print_success "Reverse proxy, identity, and admin database state are ready."
}

print_summary() {
  local ip
  ip="$(hostname -I | awk '{print $1}')"

  echo
  print_success "HomeBrain installation complete."
  echo "Repository: ${HOMEBRAIN_DIR}"
  echo "Open HomeBrain at: http://${ip}:3000"
  echo "Health check:     http://${ip}:3000/ping"
  echo "Reverse proxy:    bash ${HOMEBRAIN_DIR}/scripts/setup-services.sh setup-caddy"
  echo
  echo "Useful commands:"
  echo "  bash ${HOMEBRAIN_DIR}/scripts/setup-services.sh status"
  echo "  bash ${HOMEBRAIN_DIR}/scripts/setup-services.sh logs follow"
  echo "  bash ${HOMEBRAIN_DIR}/scripts/setup-services.sh update"
  echo
  if [[ "$HOST_PROFILE" == "jetson" ]]; then
    echo "Jetson note:"
    echo "  HomeBrain also runs on other Ubuntu/Debian x86_64 and ARM64 hosts."
    echo "  Jetson remains the best-tested option for local GPU workloads."
    echo
  fi
}

main() {
  host_banner
  check_prerequisites
  detect_host
  install_base_packages
  install_node
  install_mongodb
  stop_running_homebrain_if_present
  prepare_repo
  configure_env
  install_app
  bootstrap_wakeword
  install_service
  bash "${HOMEBRAIN_DIR}/scripts/setup-services.sh" setup-caddy
  configure_deploy_sudoers
  configure_firewall
  start_and_verify
  bootstrap_reverse_proxy_state
  print_summary
}

main "$@"
