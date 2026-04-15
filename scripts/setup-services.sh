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
SERVICE_DROPIN_DIR="/etc/systemd/system/${SERVICE_NAME}.service.d"
RESTART_HELPER_SERVICE_NAME="${SERVICE_NAME}-restart-helper"
RESTART_HELPER_SERVICE_PATH="/etc/systemd/system/${RESTART_HELPER_SERVICE_NAME}.service"
HOMEBRAIN_HELPER_INSTALL_DIR="/usr/local/lib/homebrain"
RESTART_HELPER_SOURCE_PATH="${HOMEBRAIN_DIR}/scripts/restart-homebrain-service.sh"
RESTART_HELPER_INSTALL_PATH="${HOMEBRAIN_HELPER_INSTALL_DIR}/restart-homebrain-service.sh"
OLLAMA_PRIVILEGE_OVERRIDE_PATH="${SERVICE_DROPIN_DIR}/99-ollama-helper.conf"
OLLAMA_SERVICE_DROPIN_DIR="/etc/systemd/system/ollama.service.d"
OLLAMA_RESOURCE_GUARD_PATH="${OLLAMA_SERVICE_DROPIN_DIR}/10-homebrain-resource-guard.conf"
CADDY_SERVICE_NAME="${CADDY_SERVICE_NAME:-caddy-api}"
CADDY_SERVICE_PATH="/etc/systemd/system/${CADDY_SERVICE_NAME}.service"
CADDY_BOOTSTRAP_PATH="${CADDY_BOOTSTRAP_PATH:-/etc/caddy/Caddyfile}"
OLLAMA_HELPER_SOURCE_PATH="${HOMEBRAIN_DIR}/scripts/ollama-host-control.sh"
OLLAMA_HELPER_INSTALL_DIR="${HOMEBRAIN_HELPER_INSTALL_DIR}"
OLLAMA_HELPER_INSTALL_PATH="${OLLAMA_HELPER_INSTALL_DIR}/ollama-host-control.sh"
DEPLOY_SUDOERS_PATH="/etc/sudoers.d/homebrain-deploy"
HOMEBRAIN_PORT="${HOMEBRAIN_PORT:-3000}"

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

is_homebrain_path_writable() {
  local target_path="$1"

  if [[ ! -e "${target_path}" ]]; then
    return 0
  fi

  if ! sudo -u "$HOMEBRAIN_USER" test -w "${target_path}"; then
    return 1
  fi

  if [[ -d "${target_path}" ]]; then
    local probe_path="${target_path}/.homebrain-write-probe-$$-$RANDOM"
    if ! sudo -u "$HOMEBRAIN_USER" bash -lc "touch $(printf '%q' "${probe_path}") && rm -f $(printf '%q' "${probe_path}")"; then
      return 1
    fi
  fi

  return 0
}

normalize_client_dist_permissions() {
  local dist_path="${HOMEBRAIN_DIR}/client/dist"
  local assets_path="${dist_path}/assets"
  local homebrain_group
  local quarantine_path

  if [[ ! -e "${dist_path}" ]]; then
    return
  fi

  homebrain_group="$(id -gn "${HOMEBRAIN_USER}" 2>/dev/null || id -gn)"

  print_status "Normalizing client/dist ownership before build..."
  sudo chown -R "${HOMEBRAIN_USER}:${homebrain_group}" "${dist_path}" || true
  sudo chmod -R u+rwX "${dist_path}" || true

  if is_homebrain_path_writable "${dist_path}" && { [[ ! -e "${assets_path}" ]] || is_homebrain_path_writable "${assets_path}"; }; then
    return
  fi

  quarantine_path="${HOMEBRAIN_DIR}/client/dist.quarantine.$(date +%Y%m%d-%H%M%S)"
  print_warning "client/dist is still not writable. Replacing it with a clean directory at ${dist_path} and quarantining the old contents to ${quarantine_path}."
  sudo mv "${dist_path}" "${quarantine_path}"
  sudo -u "$HOMEBRAIN_USER" mkdir -p "${dist_path}"
}

canonicalize_path() {
  local target_path="${1:-}"

  if [[ -z "${target_path}" ]]; then
    return 1
  fi

  readlink -f "${target_path}" 2>/dev/null || printf '%s\n' "${target_path}"
}

process_matches_homebrain() {
  local pid="$1"
  local cmd="$2"
  local homebrain_dir=""
  local process_cwd=""
  local repo_scoped_runtime="false"

  if [[ "${cmd}" != *"node"* && "${cmd}" != *"npm"* && "${cmd}" != *"server.js"* ]]; then
    return 1
  fi

  if [[ -z "${HOMEBRAIN_DIR}" ]]; then
    if [[ "${cmd}" == *"server.js"* || ( "${cmd}" == *"run-with-modern-node.js"* && "${cmd}" == *"start"* ) ]]; then
      return 0
    fi
    return 1
  fi

  homebrain_dir="$(canonicalize_path "${HOMEBRAIN_DIR}")"

  process_cwd="$(canonicalize_path "/proc/${pid}/cwd" || true)"
  if [[ -n "${process_cwd}" && ( "${process_cwd}" == "${homebrain_dir}" || "${process_cwd}" == "${homebrain_dir}/"* ) ]]; then
    repo_scoped_runtime="true"
  fi

  if [[ "${cmd}" == *"${HOMEBRAIN_DIR}"* || "${cmd}" == *"${homebrain_dir}"* ]]; then
    repo_scoped_runtime="true"
  fi

  if [[ "${repo_scoped_runtime}" == "true" ]]; then
    return 0
  fi

  if [[ "${cmd}" == *"server.js"* || ( "${cmd}" == *"run-with-modern-node.js"* && "${cmd}" == *"start"* ) ]]; then
    return 0
  fi

  return 1
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

    if process_matches_homebrain "${pid}" "${cmd}"; then
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

clear_ignored_package_locks() {
  local relative_lock_paths=(
    "package-lock.json"
    "server/package-lock.json"
    "client/package-lock.json"
    "broker/package-lock.json"
    "lambda/package-lock.json"
  )
  local existing_lock_paths=()
  local relative_path

  for relative_path in "${relative_lock_paths[@]}"; do
    local absolute_path="${HOMEBRAIN_DIR}/${relative_path}"
    if [[ -e "${absolute_path}" ]]; then
      existing_lock_paths+=("${absolute_path}")
    fi
  done

  if [[ "${#existing_lock_paths[@]}" -eq 0 ]]; then
    return 0
  fi

  print_status "Removing ignored package-lock files so dependencies refresh from the latest package manifests..."
  sudo -u "$HOMEBRAIN_USER" rm -f "${existing_lock_paths[@]}"
}

homebrain_service_unit_exists() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi

  sudo systemctl list-unit-files --type=service --no-legend 2>/dev/null \
    | awk '{print $1}' \
    | grep -qx "${SERVICE_NAME}.service"
}

homebrain_restart_helper_unit_exists() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi

  sudo systemctl list-unit-files --type=service --no-legend 2>/dev/null \
    | awk '{print $1}' \
    | grep -qx "${RESTART_HELPER_SERVICE_NAME}.service"
}

get_homebrain_service_state() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi

  sudo systemctl show -p ActiveState --value "${SERVICE_NAME}" 2>/dev/null || true
}

stop_homebrain_service() {
  local reason="${1:-Stopping HomeBrain...}"
  local wait_seconds="${2:-15}"
  local elapsed=0
  local state=""

  cleanup_orphaned_homebrain_processes

  if ! homebrain_service_unit_exists; then
    cleanup_blocking_homebrain_port_listeners
    return 0
  fi

  state="$(get_homebrain_service_state)"
  if [[ -z "${state}" || "${state}" == "inactive" || "${state}" == "failed" ]]; then
    cleanup_blocking_homebrain_port_listeners
    print_success "HomeBrain service is already stopped."
    return 0
  fi

  print_status "${reason} (waiting up to ${wait_seconds}s)..."
  sudo systemctl stop "${SERVICE_NAME}" --no-block || true

  while true; do
    state="$(get_homebrain_service_state)"

    if [[ -z "${state}" || "${state}" == "inactive" || "${state}" == "failed" ]]; then
      break
    fi

    if (( elapsed >= wait_seconds )); then
      print_warning "HomeBrain service is still ${state} after ${wait_seconds}s. Forcing it down."
      sudo systemctl kill --kill-who=all --signal=SIGKILL "${SERVICE_NAME}" 2>/dev/null || true
      sudo systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
      break
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  cleanup_orphaned_homebrain_processes
  cleanup_blocking_homebrain_port_listeners

  state="$(get_homebrain_service_state)"
  if [[ -z "${state}" || "${state}" == "inactive" || "${state}" == "failed" ]]; then
    print_success "HomeBrain service stopped."
    return 0
  fi

  print_warning "HomeBrain service state after stop attempt: ${state}"
  return 0
}

get_service_main_pid() {
  local main_pid
  main_pid="$(sudo systemctl show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || echo 0)"
  if [[ -z "${main_pid}" ]]; then
    echo 0
    return
  fi
  echo "${main_pid}"
}

get_listener_pids_for_port() {
  local port="$1"
  local output

  output="$(sudo ss -lntp "( sport = :${port} )" 2>/dev/null || true)"
  if [[ -z "${output}" ]]; then
    return 0
  fi

  grep -o 'pid=[0-9]\+' <<<"${output}" | cut -d= -f2 | sort -u
}

kill_listener_pids() {
  local pids=("$@")

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi

  sudo kill "${pids[@]}" 2>/dev/null || true
  sleep 2
  sudo kill -9 "${pids[@]}" 2>/dev/null || true
}

pid_belongs_to_process_tree() {
  local pid="$1"
  local root_pid="$2"
  local parent_pid=""

  if [[ -z "${pid}" || -z "${root_pid}" || "${root_pid}" == "0" ]]; then
    return 1
  fi

  while [[ -n "${pid}" && "${pid}" != "0" ]]; do
    if [[ "${pid}" == "${root_pid}" ]]; then
      return 0
    fi

    parent_pid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "${parent_pid}" || "${parent_pid}" == "${pid}" ]]; then
      break
    fi
    pid="${parent_pid}"
  done

  return 1
}

cleanup_blocking_homebrain_port_listeners() {
  local main_pid
  local listener_pid
  local blocking_pids=()

  main_pid="$(get_service_main_pid)"

  while IFS= read -r listener_pid; do
    [[ -z "${listener_pid}" ]] && continue

    if pid_belongs_to_process_tree "${listener_pid}" "${main_pid}"; then
      continue
    fi

    blocking_pids+=("${listener_pid}")
  done < <(get_listener_pids_for_port "${HOMEBRAIN_PORT}")

  if [[ "${#blocking_pids[@]}" -eq 0 ]]; then
    return 0
  fi

  print_warning "Stopping process(es) blocking HomeBrain port ${HOMEBRAIN_PORT}: ${blocking_pids[*]}"
  kill_listener_pids "${blocking_pids[@]}"
}

homebrain_listener_matches_service() {
  local main_pid
  local listener_pid

  main_pid="$(get_service_main_pid)"
  if [[ -z "${main_pid}" || "${main_pid}" == "0" ]]; then
    return 1
  fi

  while IFS= read -r listener_pid; do
    [[ -z "${listener_pid}" ]] && continue
    if pid_belongs_to_process_tree "${listener_pid}" "${main_pid}"; then
      return 0
    fi
  done < <(get_listener_pids_for_port "${HOMEBRAIN_PORT}")

  return 1
}

describe_homebrain_listener_state() {
  local main_pid
  local listener_pids

  main_pid="$(get_service_main_pid)"
  listener_pids="$(get_listener_pids_for_port "${HOMEBRAIN_PORT}" | tr '\n' ' ' | sed 's/[[:space:]]\+$//')"
  if [[ -z "${listener_pids}" ]]; then
    listener_pids="none"
  fi

  echo "service MainPID=${main_pid:-0}; port 3000 listener pid(s)=${listener_pids}"
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
TimeoutStopSec=15s
KillMode=mixed
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
EOF

  if [[ ! -f "${RESTART_HELPER_SOURCE_PATH}" ]]; then
    print_error "HomeBrain restart helper not found at ${RESTART_HELPER_SOURCE_PATH}"
    exit 1
  fi

  print_status "Installing the HomeBrain restart helper..."
  sudo install -d -m 0755 "${HOMEBRAIN_HELPER_INSTALL_DIR}"
  sudo install -m 0755 "${RESTART_HELPER_SOURCE_PATH}" "${RESTART_HELPER_INSTALL_PATH}"
  sudo chown root:root "${RESTART_HELPER_INSTALL_PATH}"

  print_status "Writing ${RESTART_HELPER_SERVICE_PATH}"
  sudo tee "${RESTART_HELPER_SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=HomeBrain restart helper
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment="HOMEBRAIN_SERVICE_NAME=${SERVICE_NAME}"
Environment="HOMEBRAIN_DIR=${HOMEBRAIN_DIR}"
ExecStart=${RESTART_HELPER_INSTALL_PATH}
KillMode=process
TimeoutStartSec=45s

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable "${SERVICE_NAME}"
  print_success "Service installed and enabled."
}

configure_homebrain_ollama_privilege_override() {
  print_status "Allowing the HomeBrain service to invoke the Ollama helper..."
  sudo install -d -m 0755 "${SERVICE_DROPIN_DIR}"
  sudo tee "${OLLAMA_PRIVILEGE_OVERRIDE_PATH}" >/dev/null <<'EOF'
[Service]
NoNewPrivileges=false
EOF
  sudo systemctl daemon-reload
  print_success "HomeBrain Ollama privilege override written to ${OLLAMA_PRIVILEGE_OVERRIDE_PATH}."
}

install_ollama_privileged_helper() {
  require_repo

  if [[ ! -f "${OLLAMA_HELPER_SOURCE_PATH}" ]]; then
    print_error "Ollama privilege helper not found at ${OLLAMA_HELPER_SOURCE_PATH}"
    exit 1
  fi

  print_status "Installing the HomeBrain Ollama privilege helper..."
  sudo install -d -m 0755 "${OLLAMA_HELPER_INSTALL_DIR}"
  sudo install -m 0755 "${OLLAMA_HELPER_SOURCE_PATH}" "${OLLAMA_HELPER_INSTALL_PATH}"
  sudo chown root:root "${OLLAMA_HELPER_INSTALL_PATH}"
  print_success "Installed Ollama privilege helper to ${OLLAMA_HELPER_INSTALL_PATH}."
}

configure_ollama_resource_guard() {
  local os_name arch_name
  os_name="$(uname -s)"
  arch_name="$(uname -m)"

  if [[ "${os_name}" != "Linux" || ! "${arch_name}" =~ ^(aarch64|arm64)$ ]]; then
    return
  fi

  print_status "Writing Ollama resource guard for single-model Jetson operation..."
  sudo install -d -m 0755 "${OLLAMA_SERVICE_DROPIN_DIR}"
  sudo tee "${OLLAMA_RESOURCE_GUARD_PATH}" >/dev/null <<EOF
[Service]
Environment="OLLAMA_KEEP_ALIVE=${HOMEBRAIN_OLLAMA_KEEP_ALIVE:--1}"
Environment="OLLAMA_MAX_LOADED_MODELS=${HOMEBRAIN_OLLAMA_MAX_LOADED_MODELS:-1}"
Environment="OLLAMA_NUM_PARALLEL=${HOMEBRAIN_OLLAMA_NUM_PARALLEL:-1}"
EOF
  sudo systemctl daemon-reload
  print_success "Ollama resource guard written to ${OLLAMA_RESOURCE_GUARD_PATH}."
}

configure_deploy_sudoers() {
  print_status "Refreshing HomeBrain sudoers access for service management and Ollama updates..."
  sudo tee "${DEPLOY_SUDOERS_PATH}" >/dev/null <<EOF
${HOMEBRAIN_USER} ALL=(ALL) NOPASSWD:/usr/bin/systemctl,/bin/systemctl,${OLLAMA_HELPER_INSTALL_PATH} install,${OLLAMA_HELPER_INSTALL_PATH} update,${OLLAMA_HELPER_INSTALL_PATH} stop-system,${OLLAMA_HELPER_INSTALL_PATH} probe
EOF
  sudo chmod 0440 "${DEPLOY_SUDOERS_PATH}"
  print_success "sudoers file written to ${DEPLOY_SUDOERS_PATH}."
}

refresh_privileges() {
  configure_homebrain_ollama_privilege_override
  install_ollama_privileged_helper
  configure_ollama_resource_guard
  configure_deploy_sudoers
}

start_services() {
  print_status "Starting MongoDB and HomeBrain..."
  sudo systemctl start mongod
  sudo systemctl start "${SERVICE_NAME}"
  print_success "Services started."
}

stop_services() {
  stop_homebrain_service "Stopping HomeBrain"
}

restart_services() {
  if homebrain_restart_helper_unit_exists; then
    print_status "Restarting HomeBrain via ${RESTART_HELPER_SERVICE_NAME}..."
    sudo systemctl start "${RESTART_HELPER_SERVICE_NAME}"
  else
    print_status "Restarting HomeBrain..."
    stop_homebrain_service "Stopping HomeBrain before restart"
    sudo systemctl start "${SERVICE_NAME}"
  fi
  print_success "HomeBrain restarted."
}

wait_for_homebrain_http() {
  local attempts="${1:-20}"
  local delay_seconds="${2:-1}"
  local attempt=1

  while (( attempt <= attempts )); do
    if curl -fsS "http://127.0.0.1:${HOMEBRAIN_PORT}/ping" >/dev/null 2>&1 && homebrain_listener_matches_service; then
      print_success "HomeBrain is responding on port 3000."
      return 0
    fi

    sleep "${delay_seconds}"
    attempt=$((attempt + 1))
  done

  print_error "HomeBrain did not respond on port 3000 after restart."
  print_warning "$(describe_homebrain_listener_state)"
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

  local node_bin
  local repo_status
  repo_status="$(git -C "${HOMEBRAIN_DIR}" status --porcelain)"
  if [[ -n "${repo_status}" ]]; then
    print_error "Repository has local changes. Commit or stash them before running update."
    echo "${repo_status}"
    exit 1
  fi

  node_bin="$(resolve_node_bin)"
  if [[ -z "$node_bin" ]]; then
    print_error "Node.js is not installed."
    exit 1
  fi

  print_status "Preparing HomeBrain for update..."
  stop_homebrain_service "Stopping HomeBrain service before Git update"
  print_status "Pulling latest HomeBrain code from Git..."
  sudo -u "$HOMEBRAIN_USER" git -C "${HOMEBRAIN_DIR}" pull --ff-only

  clear_ignored_package_locks

  print_status "Installing dependencies..."
  run_modern_npm install --package-lock=false --no-audit --no-fund

  print_status "Ensuring native server modules match the active Node.js runtime..."
  run_modern_npm run ensure:native --prefix server

  normalize_client_dist_permissions

  print_status "Building client..."
  run_modern_npm run build --prefix client

  print_status "Validating OpenClaw integration assets..."
  sudo -u "$HOMEBRAIN_USER" bash -lc "cd $(printf '%q' "$HOMEBRAIN_DIR") && $(printf '%q' "$node_bin") - <<'NODE'
const fs = require('fs');
const requiredFiles = [
  './server/services/openclawIntegrationService.js',
  './server/services/openclawMcpService.js',
  './server/services/openclawToolCatalog.js',
  './server/routes/openclawRoutes.js',
  './server/routes/openclawMcpRoutes.js',
  './openclaw/skills/homebrain-admin/SKILL.md',
  './openclaw/jetson/install-jetson.sh',
  './docs/openclaw/jetson-setup.md'
];

for (const filePath of requiredFiles) {
  if (!fs.existsSync(filePath)) {
    throw new Error('Missing OpenClaw asset: ' + filePath);
  }
}

require('./server/services/openclawIntegrationService');
require('./server/services/openclawMcpService');
console.log('OpenClaw integration assets verified.');
NODE"

  if [[ ! -x "${HOMEBRAIN_DIR}/server/.wakeword-venv/bin/python" && -x "${HOMEBRAIN_DIR}/server/scripts/install-openwakeword-deps.sh" ]]; then
    print_warning "Wake-word virtualenv is missing. Bootstrapping it now."
    (cd "${HOMEBRAIN_DIR}/server" && PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh) || true
  fi

  install_service
  refresh_privileges
  print_status "Restarting HomeBrain via ${RESTART_HELPER_SERVICE_NAME}..."
  sudo systemctl start "${RESTART_HELPER_SERVICE_NAME}"

  wait_for_homebrain_http 20 1

  print_status "Bootstrapping reverse proxy database state..."
  sudo -u "$HOMEBRAIN_USER" bash -lc "cd $(printf '%q' "$HOMEBRAIN_DIR") && node server/scripts/bootstrapReverseProxyState.js --actor system:update"
  print_status "Bootstrapping identity database state..."
  sudo -u "$HOMEBRAIN_USER" bash -lc "cd $(printf '%q' "$HOMEBRAIN_DIR") && node server/scripts/bootstrapIdentityState.js --actor system:update"
  print_status "Bootstrapping default admin state..."
  sudo -u "$HOMEBRAIN_USER" bash -lc "cd $(printf '%q' "$HOMEBRAIN_DIR") && node server/scripts/bootstrapAdminState.js --actor system:update"
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
  install-service   Write /etc/systemd/system/homebrain.service and the restart helper
  refresh-privileges Install the Ollama helper and refresh HomeBrain sudoers
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
    refresh-privileges) refresh_privileges ;;
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
