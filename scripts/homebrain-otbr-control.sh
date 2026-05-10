#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-status}"
shift || true

STATE_DIR="${HOMEBRAIN_OTBR_STATE_DIR:-/var/lib/homebrain/otbr}"
SOURCE_DIR="${HOMEBRAIN_OTBR_SOURCE_DIR:-/opt/homebrain/ot-br-posix}"
SERVICE_NAME="${HOMEBRAIN_OTBR_SERVICE_NAME:-otbr-agent}"
REST_PORT="${HOMEBRAIN_OTBR_REST_PORT:-8081}"
NETWORK_NAME="${HOMEBRAIN_THREAD_NETWORK_NAME:-HomeBrain Thread}"
BACKBONE_ROUTER_REQUEST="${HOMEBRAIN_OTBR_BACKBONE_ROUTER:-auto}"
BUILD_MODE_FILE="${STATE_DIR}/otbr-build-mode"
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

json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\r'/}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\t'/\\t}"
  printf '%s' "${value}"
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

read_kernel_config_value() {
  local key="${1:-}" line=""
  if [[ -z "${key}" ]]; then
    return 0
  fi

  if [[ -r /proc/config.gz ]] && command_exists zgrep; then
    line="$(zgrep -E "^${key}=|^# ${key} is not set" /proc/config.gz 2>/dev/null | head -n 1 || true)"
  fi

  if [[ -z "${line}" && -r "/boot/config-$(uname -r)" ]]; then
    line="$(grep -E "^${key}=|^# ${key} is not set" "/boot/config-$(uname -r)" 2>/dev/null | head -n 1 || true)"
  fi

  case "${line}" in
    "${key}=y") printf 'y\n' ;;
    "${key}=m") printf 'm\n' ;;
    "# ${key} is not set") printf 'n\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

probe_ipv6_mroute_runtime() {
  if ! command_exists python3; then
    printf 'unknown:no-python\n'
    return
  fi

  python3 - <<'PY' 2>/dev/null || true
import errno
import socket
import struct

MRT6_INIT = 200
MRT6_DONE = 201

try:
    sock = socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_ICMPV6)
except OSError as error:
    print(f"unknown:socket:{error.errno}")
    raise SystemExit(0)

try:
    sock.setsockopt(socket.IPPROTO_IPV6, MRT6_INIT, struct.pack("i", 1))
    print("supported")
    try:
        sock.setsockopt(socket.IPPROTO_IPV6, MRT6_DONE, struct.pack("i", 1))
    except OSError:
        pass
except OSError as error:
    if error.errno == errno.EADDRINUSE:
        print("supported:in-use")
    elif error.errno in (errno.ENOPROTOOPT, errno.EPROTONOSUPPORT):
        print(f"unsupported:{error.errno}")
    elif error.errno == errno.EPERM:
        print("unknown:eperm")
    else:
        print(f"unknown:{error.errno}")
finally:
    sock.close()
PY
}

ipv6_mroute_support_status() {
  local config_value probe_result
  config_value="$(read_kernel_config_value CONFIG_IPV6_MROUTE)"
  if [[ "${config_value}" == "n" ]]; then
    printf 'unsupported\n'
    return
  fi

  if [[ "${config_value}" == "m" ]]; then
    modprobe ip6_mroute >/dev/null 2>&1 || modprobe ipv6_mroute >/dev/null 2>&1 || true
  fi

  probe_result="$(probe_ipv6_mroute_runtime)"
  case "${probe_result}" in
    supported*) printf 'supported\n' ;;
    unsupported*) printf 'unsupported\n' ;;
    *)
      if [[ "${config_value}" == "y" || "${config_value}" == "m" ]]; then
        printf 'supported\n'
      else
        printf 'unknown\n'
      fi
      ;;
  esac
}

resolve_backbone_router_build_mode() {
  local requested support_status
  requested="$(printf '%s' "${BACKBONE_ROUTER_REQUEST}" | tr '[:upper:]' '[:lower:]')"
  case "${requested}" in
    1|true|yes|on|enabled|full)
      printf 'full\n'
      return
      ;;
    0|false|no|off|disabled|none|no-bbr)
      printf 'no-bbr\n'
      return
      ;;
  esac

  support_status="$(ipv6_mroute_support_status)"
  if [[ "${support_status}" == "supported" ]]; then
    printf 'full\n'
  else
    printf 'no-bbr\n'
  fi
}

read_installed_build_mode() {
  if [[ -r "${BUILD_MODE_FILE}" ]]; then
    tr -d '\r\n\t ' <"${BUILD_MODE_FILE}"
  fi
}

write_installed_build_mode() {
  local build_mode="${1:-unknown}"
  mkdir -p "${STATE_DIR}"
  printf '%s\n' "${build_mode}" >"${BUILD_MODE_FILE}"
}

ensure_base_packages() {
  if ! command_exists apt-get; then
    die "apt-get is required to install OpenThread Border Router on this host."
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git build-essential
}

prepare_otbr_source_dir() {
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
}

install_otbr_from_source() {
  local build_mode="${1:-full}" backbone_router="1"
  if [[ "${build_mode}" == "no-bbr" ]]; then
    backbone_router="0"
    log "Building OTBR without Backbone Router multicast routing because this host lacks IPv6 multicast routing."
  else
    log "Building OTBR with Backbone Router support."
  fi

  prepare_otbr_source_dir

  (
    cd "${SOURCE_DIR}"
    export INFRA_IF_NAME
    INFRA_IF_NAME="$(detect_infra_if)"
    export REFERENCE_DEVICE=0
    export RELEASE=1
    export REST_API=1
    export WEB_GUI=0
    export BACKBONE_ROUTER="${backbone_router}"
    export NAT64=0
    export DNS64=0
    export FIREWALL=0
    ./script/bootstrap
    ./script/setup
  )

  if [[ -z "$(resolve_otbr_agent)" || -z "$(resolve_ot_ctl)" ]]; then
    die "OTBR install completed but otbr-agent or ot-ctl was not found."
  fi

  write_installed_build_mode "${build_mode}"
}

install_otbr_package_or_source() {
  local desired_mode installed_mode
  desired_mode="$(resolve_backbone_router_build_mode)"
  installed_mode="$(read_installed_build_mode)"

  if [[ -n "$(resolve_otbr_agent)" && -n "$(resolve_ot_ctl)" ]]; then
    if [[ "${installed_mode}" == "${desired_mode}" || ( -z "${installed_mode}" && "${desired_mode}" == "full" ) ]]; then
      log "OTBR binaries are already installed."
      return
    fi
    log "OTBR binaries are installed, but build mode is ${installed_mode:-unknown}; rebuilding for ${desired_mode}."
  fi

  ensure_base_packages

  if [[ "${desired_mode}" == "no-bbr" ]]; then
    install_otbr_from_source "${desired_mode}"
    return
  fi

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
  install_otbr_from_source "${desired_mode}"
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

read_ot_value() {
  local ot_ctl_bin
  ot_ctl_bin="$(resolve_ot_ctl)"
  if [[ -z "${ot_ctl_bin}" ]]; then
    return 0
  fi
  timeout 10s "${ot_ctl_bin}" "$@" 2>/dev/null \
    | tr -d '\r' \
    | sed '/^Done$/d' \
    | head -n 12 || true
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

configure_router_mode() {
  log "Ensuring OpenThread can form or join as a router."
  if [[ "$(resolve_backbone_router_build_mode)" == "no-bbr" ]]; then
    log "Backbone Router multicast routing is unavailable on this host; keeping BBR disabled."
    ot_ctl bbr disable >/dev/null 2>&1 || true
  fi
  ot_ctl mode rdn >/dev/null 2>&1 || true
  ot_ctl routereligible enable >/dev/null 2>&1 || true
}

start_thread_network() {
  configure_router_mode
  ot_ctl ifconfig up >/dev/null
  ot_ctl thread start >/dev/null

  local attempt state
  for attempt in $(seq 1 90); do
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
  die "Thread interface did not attach after start; current state is ${state:-unknown}."
}

print_status_json() {
  local active enabled pid state dataset agent ctl mode router_eligible version bbr_state status_text journal_text
  local ipv6_mroute backbone_mode installed_mode
  active="$(systemctl is-active "${SERVICE_NAME}" 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "${SERVICE_NAME}" 2>/dev/null || true)"
  pid="$(systemctl show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || true)"
  state="$(read_state)"
  dataset="$(read_dataset)"
  agent="$(resolve_otbr_agent)"
  ctl="$(resolve_ot_ctl)"
  mode="$(read_ot_value mode)"
  router_eligible="$(read_ot_value routereligible)"
  version="$(read_ot_value version)"
  bbr_state="$(read_ot_value bbr state)"
  ipv6_mroute="$(ipv6_mroute_support_status)"
  backbone_mode="$(resolve_backbone_router_build_mode)"
  installed_mode="$(read_installed_build_mode)"
  status_text="$(systemctl status "${SERVICE_NAME}" --no-pager --lines=20 2>&1 || true)"
  journal_text="$(journalctl -u "${SERVICE_NAME}" -n 240 --no-pager 2>&1 \
    | grep -Ei 'fail|error|exited|killed|stop|start|restart|spinel|radio|attach|parent|leader|router|backbone|bbr|multicast|mroute|protocol|rloc|notfound|dropped|rejected|reset' \
    | tail -n 140 || true)"

  printf '{"success":true,"service":"%s","active":"%s","enabled":"%s","mainPid":"%s","state":"%s","dataset":"%s","mode":"%s","routerEligible":"%s","version":"%s","bbrState":"%s","ipv6Mroute":"%s","backboneRouterMode":"%s","installedBackboneRouterMode":"%s","otbrAgent":"%s","otCtl":"%s","restUrl":"http://127.0.0.1:%s","diagnostics":{"systemctl":"%s","journal":"%s"}}\n' \
    "$(json_escape "${SERVICE_NAME}")" \
    "$(json_escape "${active}")" \
    "$(json_escape "${enabled}")" \
    "$(json_escape "${pid}")" \
    "$(json_escape "${state}")" \
    "$(json_escape "${dataset}")" \
    "$(json_escape "${mode}")" \
    "$(json_escape "${router_eligible}")" \
    "$(json_escape "${version}")" \
    "$(json_escape "${bbr_state}")" \
    "$(json_escape "${ipv6_mroute}")" \
    "$(json_escape "${backbone_mode}")" \
    "$(json_escape "${installed_mode:-unknown}")" \
    "$(json_escape "${agent}")" \
    "$(json_escape "${ctl}")" \
    "$(json_escape "${REST_PORT}")" \
    "$(json_escape "${status_text}")" \
    "$(json_escape "${journal_text}")"
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
