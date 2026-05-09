#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-status}"
shift || true

STATE_DIR="${HOMEBRAIN_OTBR_STATE_DIR:-/var/lib/homebrain/otbr}"
SOURCE_DIR="${HOMEBRAIN_OTBR_SOURCE_DIR:-/opt/homebrain/ot-br-posix}"
SERVICE_NAME="${HOMEBRAIN_OTBR_SERVICE_NAME:-otbr-agent}"
REST_PORT="${HOMEBRAIN_OTBR_REST_PORT:-8081}"
NETWORK_NAME="${HOMEBRAIN_THREAD_NETWORK_NAME:-HomeBrain Thread}"
DEVICE_PATH=""
BAUD_RATE="${HOMEBRAIN_THREAD_BAUD_RATE:-460800}"
RADIO_URL=""
INFRA_IF="${HOMEBRAIN_OTBR_INFRA_IF:-}"

log() {
  printf '[homebrain-otbr] %s\n' "$*"
}

die() {
  printf '[homebrain-otbr] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "This helper must run as root through HomeBrain sudoers."
  fi
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --device)
      DEVICE_PATH="${2:-}"
      shift 2
      ;;
    --baud)
      BAUD_RATE="${2:-}"
      shift 2
      ;;
    --radio-url)
      RADIO_URL="${2:-}"
      shift 2
      ;;
    --network-name)
      NETWORK_NAME="${2:-}"
      shift 2
      ;;
    --infra-if)
      INFRA_IF="${2:-}"
      shift 2
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

resolve_otbr_agent() {
  if command -v otbr-agent >/dev/null 2>&1; then
    command -v otbr-agent
  elif [[ -x /usr/sbin/otbr-agent ]]; then
    printf '%s\n' /usr/sbin/otbr-agent
  elif [[ -x /usr/local/sbin/otbr-agent ]]; then
    printf '%s\n' /usr/local/sbin/otbr-agent
  fi
}

resolve_ot_ctl() {
  if command -v ot-ctl >/dev/null 2>&1; then
    command -v ot-ctl
  elif [[ -x /usr/sbin/ot-ctl ]]; then
    printf '%s\n' /usr/sbin/ot-ctl
  elif [[ -x /usr/local/bin/ot-ctl ]]; then
    printf '%s\n' /usr/local/bin/ot-ctl
  fi
}

detect_infra_if() {
  if [[ -n "${INFRA_IF}" ]]; then
    printf '%s\n' "${INFRA_IF}"
    return
  fi

  local detected=""
  if command_exists ip; then
    detected="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}' || true)"
  fi
  if [[ -z "${detected}" ]]; then
    detected="eth0"
  fi
  printf '%s\n' "${detected}"
}

ensure_base_packages() {
  if ! command_exists apt-get; then
    die "apt-get is required to install OpenThread Border Router on this host."
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git build-essential
}

install_otbr_package_or_source() {
  if [[ -n "$(resolve_otbr_agent)" && -n "$(resolve_ot_ctl)" ]]; then
    log "OTBR binaries are already installed."
    return
  fi

  ensure_base_packages

  log "Trying distro OTBR packages first."
  if apt-get install -y otbr-agent otbr-web >/tmp/homebrain-otbr-apt.log 2>&1; then
    log "Installed OTBR packages from apt."
    return
  fi
  if apt-get install -y otbr-agent >>/tmp/homebrain-otbr-apt.log 2>&1; then
    log "Installed OTBR agent package from apt."
    return
  fi
  log "Distro OTBR packages were not available; building ot-br-posix from source."

  mkdir -p "$(dirname "${SOURCE_DIR}")"
  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    git -C "${SOURCE_DIR}" fetch --depth=1 origin main || true
    git -C "${SOURCE_DIR}" merge --ff-only FETCH_HEAD || true
  elif [[ -e "${SOURCE_DIR}" ]]; then
    local backup_dir
    backup_dir="${SOURCE_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
    log "Moving existing non-git OTBR source directory to ${backup_dir}."
    mv "${SOURCE_DIR}" "${backup_dir}"
    git clone --depth=1 https://github.com/openthread/ot-br-posix.git "${SOURCE_DIR}"
  else
    git clone --depth=1 https://github.com/openthread/ot-br-posix.git "${SOURCE_DIR}"
  fi

  (
    cd "${SOURCE_DIR}"
    export INFRA_IF_NAME
    INFRA_IF_NAME="$(detect_infra_if)"
    export REFERENCE_DEVICE=0
    export RELEASE=1
    export REST_API=1
    export WEB_GUI=0
    export NAT64=0
    export DNS64=0
    export FIREWALL=0
    ./script/bootstrap
    ./script/setup
  )

  if [[ -z "$(resolve_otbr_agent)" || -z "$(resolve_ot_ctl)" ]]; then
    die "OTBR install completed but otbr-agent or ot-ctl was not found."
  fi
}

validate_start_inputs() {
  [[ "${DEVICE_PATH}" == /dev/* ]] || die "--device must be a local /dev serial path."
  [[ -e "${DEVICE_PATH}" ]] || die "Thread serial device does not exist: ${DEVICE_PATH}"
  [[ "${BAUD_RATE}" =~ ^[0-9]{4,8}$ ]] || die "--baud must be numeric."
  if [[ -z "${RADIO_URL}" ]]; then
    RADIO_URL="spinel+hdlc+uart://${DEVICE_PATH}?uart-baudrate=${BAUD_RATE}"
  fi
  [[ "${RADIO_URL}" == spinel+hdlc+uart://* ]] || die "--radio-url must be a spinel+hdlc+uart URL."
}

write_otbr_config() {
  local agent_bin infra_if
  agent_bin="$(resolve_otbr_agent)"
  [[ -n "${agent_bin}" ]] || die "otbr-agent is not installed."
  infra_if="$(detect_infra_if)"

  log "Configuring ${SERVICE_NAME} for ${RADIO_URL} on infrastructure interface ${infra_if}."
  mkdir -p /etc/default "/etc/systemd/system/${SERVICE_NAME}.service.d" "${STATE_DIR}"
  cat >/etc/default/otbr-agent <<EOF
# Managed by HomeBrain.
OTBR_AGENT_OPTS="-I wpan0 -B ${infra_if} --rest-listen-address 127.0.0.1 --rest-listen-port ${REST_PORT} ${RADIO_URL}"
EOF

  cat >"/etc/systemd/system/${SERVICE_NAME}.service.d/10-homebrain.conf" <<EOF
[Service]
EnvironmentFile=
EnvironmentFile=/etc/default/otbr-agent
ExecStart=
ExecStart=${agent_bin} \$OTBR_AGENT_OPTS
Restart=always
RestartSec=5
EOF

  if id otbr >/dev/null 2>&1; then
    usermod -aG dialout otbr || true
  fi

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
}

wait_for_service() {
  local attempt
  for attempt in $(seq 1 40); do
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      return 0
    fi
    sleep 1
  done
  systemctl status "${SERVICE_NAME}" --no-pager >&2 || true
  return 1
}

ot_ctl() {
  local ot_ctl_bin
  ot_ctl_bin="$(resolve_ot_ctl)"
  [[ -n "${ot_ctl_bin}" ]] || die "ot-ctl is not installed."
  timeout 20s "${ot_ctl_bin}" "$@"
}

read_dataset() {
  local ot_ctl_bin
  ot_ctl_bin="$(resolve_ot_ctl)"
  if [[ -z "${ot_ctl_bin}" ]]; then
    return 0
  fi
  timeout 20s "${ot_ctl_bin}" dataset active -x 2>/dev/null | tr -d '\r' | awk '/^[0-9a-fA-F]+$/ {print; exit}' || true
}

read_state() {
  local ot_ctl_bin
  ot_ctl_bin="$(resolve_ot_ctl)"
  if [[ -z "${ot_ctl_bin}" ]]; then
    return 0
  fi
  timeout 20s "${ot_ctl_bin}" state 2>/dev/null | tr -d '\r' | awk '/^(disabled|detached|child|router|leader)$/ {print; exit}' || true
}

wait_for_ot_ctl() {
  local attempt state
  for attempt in $(seq 1 60); do
    state="$(read_state)"
    if [[ -n "${state}" ]]; then
      log "ot-ctl is ready; Thread interface state is ${state}."
      return 0
    fi
    sleep 1
  done
  systemctl status "${SERVICE_NAME}" --no-pager >&2 || true
  die "ot-ctl did not become ready after starting ${SERVICE_NAME}."
}

ensure_dataset() {
  local attempt dataset
  dataset="$(read_dataset)"
  if [[ -n "${dataset}" ]]; then
    log "Active Thread dataset already exists."
  else
    log "No active Thread dataset found; forming a new ${NETWORK_NAME} dataset."
    ot_ctl dataset init new >/dev/null
    ot_ctl dataset networkname "${NETWORK_NAME}" >/dev/null
    ot_ctl dataset commit active >/dev/null
    for attempt in $(seq 1 20); do
      dataset="$(read_dataset)"
      if [[ -n "${dataset}" ]]; then
        break
      fi
      sleep 1
    done
  fi

  [[ -n "${dataset}" ]] || die "Unable to read active Thread dataset after forming network."
  printf '%s\n' "${dataset}" >"${STATE_DIR}/active-dataset.hex"
}

start_thread_network() {
  ot_ctl ifconfig up >/dev/null
  ot_ctl thread start >/dev/null

  local attempt state
  for attempt in $(seq 1 30); do
    state="$(read_state)"
    case "${state}" in
      leader|router|child)
        log "Thread interface state is ${state}."
        return 0
        ;;
    esac
    sleep 1
  done

  state="$(read_state)"
  log "Thread interface state after wait: ${state:-unknown}."
}

print_status_json() {
  local active enabled pid state dataset agent ctl
  active="$(systemctl is-active "${SERVICE_NAME}" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "${SERVICE_NAME}" 2>/dev/null || true)"
  pid="$(systemctl show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || true)"
  state="$(read_state)"
  dataset="$(read_dataset)"
  agent="$(resolve_otbr_agent)"
  ctl="$(resolve_ot_ctl)"

  printf '{"success":true,"service":"%s","active":"%s","enabled":"%s","mainPid":"%s","state":"%s","dataset":"%s","otbrAgent":"%s","otCtl":"%s","restUrl":"http://127.0.0.1:%s"}\n' \
    "${SERVICE_NAME}" "${active}" "${enabled}" "${pid}" "${state}" "${dataset}" "${agent}" "${ctl}" "${REST_PORT}"
}

case "${ACTION}" in
  status)
    print_status_json
    ;;
  start)
    require_root
    validate_start_inputs
    install_otbr_package_or_source
    write_otbr_config
    log "Starting ${SERVICE_NAME}."
    systemctl restart "${SERVICE_NAME}"
    wait_for_service
    wait_for_ot_ctl
    ensure_dataset
    start_thread_network
    print_status_json
    ;;
  *)
    die "Unknown action: ${ACTION}"
    ;;
esac
