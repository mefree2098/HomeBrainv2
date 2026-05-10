#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-status}"
shift || true

STATE_DIR="${HOMEBRAIN_THREAD_KERNEL_STATE_DIR:-/var/lib/homebrain/thread-kernel}"
BUILDER_DIR="${HOMEBRAIN_THREAD_KERNEL_BUILDER_DIR:-/opt/homebrain/jetson-orin-kernel-builder}"
KERNEL_SRC="${HOMEBRAIN_THREAD_KERNEL_SOURCE_DIR:-/usr/src/kernel/kernel-jammy-src}"
EXTLINUX_CONF="${HOMEBRAIN_THREAD_KERNEL_EXTLINUX_CONF:-/boot/extlinux/extlinux.conf}"
CUSTOM_LABEL="${HOMEBRAIN_THREAD_KERNEL_LABEL:-homebrain-thread}"
CUSTOM_IMAGE="${HOMEBRAIN_THREAD_KERNEL_IMAGE:-/boot/Image.homebrain-thread}"
CUSTOM_INITRD="${HOMEBRAIN_THREAD_KERNEL_INITRD:-/boot/initrd.homebrain-thread}"
CONFIRM_PHRASE="${HOMEBRAIN_THREAD_KERNEL_CONFIRMATION:-REBUILD JETSON KERNEL FOR FULL THREAD}"
REBOOT_CONFIRM_PHRASE="${HOMEBRAIN_THREAD_KERNEL_REBOOT_CONFIRMATION:-REBOOT JETSON AFTER KERNEL INSTALL}"
JETSONHACKS_REPO_URL="${HOMEBRAIN_THREAD_KERNEL_BUILDER_REPO:-https://github.com/jetsonhacks/jetson-orin-kernel-builder.git}"
LOG_FILE="${STATE_DIR}/last-build.log"
LAST_RESULT_FILE="${STATE_DIR}/last-result.json"
PENDING_REBOOT_FILE="${STATE_DIR}/pending-reboot.json"
CONFIRMATION=""
REBOOT_CONFIRMATION=""
AUTO_REBOOT=0
FORCE_SOURCES=0
JOBS="${HOMEBRAIN_THREAD_KERNEL_JOBS:-}"

THREAD_KERNEL_CONFIGS=(
  CONFIG_IP_MULTIPLE_TABLES
  CONFIG_IP_MROUTE
  CONFIG_IP_MROUTE_MULTIPLE_TABLES
  CONFIG_IPV6_MULTIPLE_TABLES
  CONFIG_IPV6_MROUTE
  CONFIG_IPV6_MROUTE_MULTIPLE_TABLES
)

log() {
  printf '[homebrain-thread-kernel] %s\n' "$*"
}

die() {
  printf '[homebrain-thread-kernel] ERROR: %s\n' "$*" >&2
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

now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "This helper must run as root through HomeBrain sudoers."
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --confirm)
      CONFIRMATION="${2:-}"
      shift 2
      ;;
    --reboot-confirm)
      REBOOT_CONFIRMATION="${2:-}"
      shift 2
      ;;
    --auto-reboot)
      AUTO_REBOOT=1
      shift
      ;;
    --force-sources)
      FORCE_SOURCES=1
      shift
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

normalize_upper() {
  printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]'
}

validate_confirmation() {
  if [[ "$(normalize_upper "${CONFIRMATION}")" != "$(normalize_upper "${CONFIRM_PHRASE}")" ]]; then
    die "Type ${CONFIRM_PHRASE} to rebuild and install a HomeBrain Thread kernel."
  fi
  if [[ "${AUTO_REBOOT}" == "1" && "$(normalize_upper "${REBOOT_CONFIRMATION}")" != "$(normalize_upper "${REBOOT_CONFIRM_PHRASE}")" ]]; then
    die "Type ${REBOOT_CONFIRM_PHRASE} to allow HomeBrain to reboot after the kernel installs."
  fi
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

read_l4t_release() {
  if [[ -r /etc/nv_tegra_release ]]; then
    head -n 1 /etc/nv_tegra_release
  fi
}

is_jetson_orin_host() {
  [[ "$(uname -m)" == "aarch64" ]] || return 1
  [[ -r /etc/nv_tegra_release ]] || return 1
  grep -qiE 'tegra|nvidia' /etc/nv_tegra_release 2>/dev/null || return 1
}

kernel_config_json() {
  local first=1 key value
  printf '{'
  for key in "${THREAD_KERNEL_CONFIGS[@]}"; do
    value="$(read_kernel_config_value "${key}")"
    if [[ "${first}" == "0" ]]; then
      printf ','
    fi
    first=0
    printf '"%s":"%s"' "$(json_escape "${key}")" "$(json_escape "${value}")"
  done
  printf '}'
}

kernel_supports_full_thread() {
  local key value
  for key in "${THREAD_KERNEL_CONFIGS[@]}"; do
    value="$(read_kernel_config_value "${key}")"
    if [[ "${value}" != "y" && "${value}" != "m" ]]; then
      return 1
    fi
  done
  return 0
}

read_extlinux_default() {
  if [[ -r "${EXTLINUX_CONF}" ]]; then
    awk 'toupper($1) == "DEFAULT" {print $2; exit}' "${EXTLINUX_CONF}"
  fi
}

builder_revision() {
  if [[ -d "${BUILDER_DIR}/.git" ]]; then
    git -C "${BUILDER_DIR}" rev-parse --short HEAD 2>/dev/null || true
  fi
}

source_revision() {
  if [[ -d "${KERNEL_SRC}/.git" ]]; then
    git -C "${KERNEL_SRC}" rev-parse --short HEAD 2>/dev/null || true
  fi
}

file_sha256() {
  local target="${1:-}"
  if [[ -r "${target}" ]]; then
    sha256sum "${target}" 2>/dev/null | awk '{print $1}'
  fi
}

pending_reboot_json() {
  if [[ -r "${PENDING_REBOOT_FILE}" ]]; then
    tr -d '\n' <"${PENDING_REBOOT_FILE}"
  else
    printf 'null'
  fi
}

last_result_json() {
  if [[ -r "${LAST_RESULT_FILE}" ]]; then
    tr -d '\n' <"${LAST_RESULT_FILE}"
  else
    printf 'null'
  fi
}

print_status_json() {
  local jetson="false" support="false" needs="true" runtime l4t default_label pending last_result
  if is_jetson_orin_host; then
    jetson="true"
  fi
  if kernel_supports_full_thread; then
    support="true"
    needs="false"
  fi
  runtime="$(probe_ipv6_mroute_runtime)"
  l4t="$(read_l4t_release)"
  default_label="$(read_extlinux_default)"
  pending="$(pending_reboot_json)"
  last_result="$(last_result_json)"

  printf '{"success":true,"helper":"homebrain-jetson-kernel-control","confirmationPhrase":"%s","rebootConfirmationPhrase":"%s","isJetsonOrin":%s,"unameRelease":"%s","l4tRelease":"%s","kernelConfig":%s,"runtimeIpv6Mroute":"%s","kernelSupportsFullThread":%s,"needsRebuild":%s,"builder":{"path":"%s","exists":%s,"revision":"%s"},"source":{"path":"%s","exists":%s,"revision":"%s"},"boot":{"extlinuxConf":"%s","defaultLabel":"%s","customLabel":"%s","customImage":"%s","customImageSha256":"%s","customInitrd":"%s","customInitrdSha256":"%s"},"pendingReboot":%s,"lastResult":%s}\n' \
    "$(json_escape "${CONFIRM_PHRASE}")" \
    "$(json_escape "${REBOOT_CONFIRM_PHRASE}")" \
    "${jetson}" \
    "$(json_escape "$(uname -r)")" \
    "$(json_escape "${l4t}")" \
    "$(kernel_config_json)" \
    "$(json_escape "${runtime}")" \
    "${support}" \
    "${needs}" \
    "$(json_escape "${BUILDER_DIR}")" \
    "$([[ -d "${BUILDER_DIR}/.git" ]] && printf true || printf false)" \
    "$(json_escape "$(builder_revision)")" \
    "$(json_escape "${KERNEL_SRC}")" \
    "$([[ -d "${KERNEL_SRC}" ]] && printf true || printf false)" \
    "$(json_escape "$(source_revision)")" \
    "$(json_escape "${EXTLINUX_CONF}")" \
    "$(json_escape "${default_label}")" \
    "$(json_escape "${CUSTOM_LABEL}")" \
    "$(json_escape "${CUSTOM_IMAGE}")" \
    "$(json_escape "$(file_sha256 "${CUSTOM_IMAGE}")")" \
    "$(json_escape "${CUSTOM_INITRD}")" \
    "$(json_escape "$(file_sha256 "${CUSTOM_INITRD}")")" \
    "${pending}" \
    "${last_result}"
}

ensure_build_packages() {
  command_exists apt-get || die "apt-get is required on the Jetson host."
  export DEBIAN_FRONTEND=noninteractive
  log "Installing kernel build prerequisites."
  apt-get update
  apt-get install -y ca-certificates curl git wget build-essential bc bison flex libssl-dev libncurses-dev dwarves zstd xz-utils python3
}

prepare_builder() {
  mkdir -p "$(dirname "${BUILDER_DIR}")"
  if [[ -d "${BUILDER_DIR}/.git" ]]; then
    log "Updating JetsonHacks kernel builder."
    git -C "${BUILDER_DIR}" fetch --depth=1 origin main
    git -C "${BUILDER_DIR}" reset --hard FETCH_HEAD
  elif [[ -e "${BUILDER_DIR}" ]]; then
    local backup_dir
    backup_dir="${BUILDER_DIR}.backup.$(date +%Y%m%d-%H%M%S)"
    log "Moving existing non-git builder directory to ${backup_dir}."
    mv "${BUILDER_DIR}" "${backup_dir}"
    git clone --depth=1 "${JETSONHACKS_REPO_URL}" "${BUILDER_DIR}"
  else
    log "Cloning JetsonHacks kernel builder."
    git clone --depth=1 "${JETSONHACKS_REPO_URL}" "${BUILDER_DIR}"
  fi
}

prepare_sources() {
  local marker_dir marker_l4t marker_uname current_l4t current_uname need_sources=0
  marker_dir="${STATE_DIR}/source-marker"
  marker_l4t="${marker_dir}/l4t-release"
  marker_uname="${marker_dir}/uname-release"
  current_l4t="$(read_l4t_release)"
  current_uname="$(uname -r)"

  if [[ "${FORCE_SOURCES}" == "1" || ! -r "${KERNEL_SRC}/.config" ]]; then
    need_sources=1
  elif [[ -r "${marker_l4t}" && "$(cat "${marker_l4t}")" != "${current_l4t}" ]]; then
    need_sources=1
  elif [[ -r "${marker_uname}" && "$(cat "${marker_uname}")" != "${current_uname}" ]]; then
    need_sources=1
  fi

  if [[ "${need_sources}" == "1" ]]; then
    log "Downloading and preparing Jetson kernel sources for this L4T release."
    (
      cd "${BUILDER_DIR}"
      ./scripts/get_kernel_sources.sh --force-backup
    )
  else
    log "Using existing kernel sources at ${KERNEL_SRC}."
  fi

  [[ -r "${KERNEL_SRC}/.config" ]] || die "Kernel source .config was not found at ${KERNEL_SRC}/.config."
  mkdir -p "${marker_dir}"
  printf '%s\n' "${current_l4t}" >"${marker_l4t}"
  printf '%s\n' "${current_uname}" >"${marker_uname}"
}

apply_thread_kernel_config() {
  local key
  log "Enabling Thread Backbone Router multicast kernel options."
  (
    cd "${KERNEL_SRC}"
    cp -a .config ".config.homebrain-before-thread-$(date +%Y%m%d-%H%M%S)"
    chmod +x scripts/config
    for key in "${THREAD_KERNEL_CONFIGS[@]}"; do
      ./scripts/config --file .config -e "${key#CONFIG_}"
    done
    make olddefconfig
  )

  local missing=()
  for key in "${THREAD_KERNEL_CONFIGS[@]}"; do
    if ! grep -Eq "^${key}=(y|m)$" "${KERNEL_SRC}/.config"; then
      missing+=("${key}")
    fi
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    die "Kernel config did not enable required options: ${missing[*]}"
  fi
}

resolve_jobs() {
  if [[ -n "${JOBS}" && "${JOBS}" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "${JOBS}"
    return
  fi
  nproc 2>/dev/null || printf '4\n'
}

build_and_install_kernel() {
  local jobs kernel_release boot_backup initrd_backup extlinux_backup
  jobs="$(resolve_jobs)"
  log "Building Jetson kernel Image and modules with ${jobs} parallel jobs."
  (
    cd "${KERNEL_SRC}"
    make -j"${jobs}" Image
    make -j"${jobs}" modules
    kernel_release="$(make -s kernelrelease)"
    log "Installing modules for ${kernel_release}."
    make modules_install
    depmod "${kernel_release}" || true
  )

  [[ -r "${KERNEL_SRC}/arch/arm64/boot/Image" ]] || die "Built kernel Image was not found."
  mkdir -p "$(dirname "${CUSTOM_IMAGE}")"

  if [[ -r "${CUSTOM_IMAGE}" ]]; then
    boot_backup="${CUSTOM_IMAGE}.backup.$(date +%Y%m%d-%H%M%S)"
    log "Backing up previous HomeBrain custom kernel to ${boot_backup}."
    cp -a "${CUSTOM_IMAGE}" "${boot_backup}"
  fi

  log "Installing custom kernel image to ${CUSTOM_IMAGE}."
  install -m 0644 "${KERNEL_SRC}/arch/arm64/boot/Image" "${CUSTOM_IMAGE}"

  if command_exists nv-update-initrd; then
    log "Updating Jetson initrd with nv-update-initrd."
    nv-update-initrd || true
  elif command_exists update-initramfs; then
    log "Updating initramfs with update-initramfs."
    update-initramfs -u || true
  fi

  if [[ -r "${CUSTOM_INITRD}" ]]; then
    initrd_backup="${CUSTOM_INITRD}.backup.$(date +%Y%m%d-%H%M%S)"
    log "Backing up previous HomeBrain custom initrd to ${initrd_backup}."
    cp -a "${CUSTOM_INITRD}" "${initrd_backup}"
  fi
  if [[ -r /boot/initrd ]]; then
    log "Installing custom initrd to ${CUSTOM_INITRD}."
    install -m 0644 /boot/initrd "${CUSTOM_INITRD}"
  fi

  [[ -r "${EXTLINUX_CONF}" ]] || die "Jetson extlinux config was not found at ${EXTLINUX_CONF}."
  extlinux_backup="${EXTLINUX_CONF}.homebrain-backup.$(date +%Y%m%d-%H%M%S)"
  cp -a "${EXTLINUX_CONF}" "${extlinux_backup}"
  log "Updating ${EXTLINUX_CONF}; backup is ${extlinux_backup}."
  EXTLINUX_CONF="${EXTLINUX_CONF}" CUSTOM_LABEL="${CUSTOM_LABEL}" CUSTOM_IMAGE="${CUSTOM_IMAGE}" CUSTOM_INITRD="${CUSTOM_INITRD}" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["EXTLINUX_CONF"])
label = os.environ["CUSTOM_LABEL"]
image = os.environ["CUSTOM_IMAGE"]
initrd = os.environ["CUSTOM_INITRD"]

lines = path.read_text().splitlines()
out = []
skip = False
for line in lines:
    stripped = line.strip()
    upper = stripped.upper()
    if upper.startswith("LABEL ") and stripped.split(None, 1)[1:] and stripped.split(None, 1)[1] == label:
        skip = True
        continue
    if skip and upper.startswith("LABEL "):
        skip = False
    if skip:
        continue
    if upper.startswith("DEFAULT "):
        out.append(f"DEFAULT {label}")
    else:
        out.append(line)

if not any(line.strip().upper().startswith("DEFAULT ") for line in out):
    out.insert(0, f"DEFAULT {label}")

while out and out[-1] == "":
    out.pop()

stanza = [
    "",
    f"LABEL {label}",
    "    MENU LABEL HomeBrain Thread multicast kernel",
    f"    LINUX {image}",
]
if Path(initrd).exists():
    stanza.append(f"    INITRD {initrd}")
stanza.append("    APPEND ${cbootargs}")
path.write_text("\n".join(out + stanza) + "\n")
PY
}

write_result_json() {
  local status="${1:-completed}" message="${2:-}" pending_reboot="${3:-false}"
  mkdir -p "${STATE_DIR}"
  printf '{"status":"%s","message":"%s","updatedAt":"%s","unameRelease":"%s","l4tRelease":"%s","customImage":"%s","customImageSha256":"%s","customInitrd":"%s","customInitrdSha256":"%s","pendingReboot":%s}\n' \
    "$(json_escape "${status}")" \
    "$(json_escape "${message}")" \
    "$(now_iso)" \
    "$(json_escape "$(uname -r)")" \
    "$(json_escape "$(read_l4t_release)")" \
    "$(json_escape "${CUSTOM_IMAGE}")" \
    "$(json_escape "$(file_sha256 "${CUSTOM_IMAGE}")")" \
    "$(json_escape "${CUSTOM_INITRD}")" \
    "$(json_escape "$(file_sha256 "${CUSTOM_INITRD}")")" \
    "${pending_reboot}" >"${LAST_RESULT_FILE}"
}

mark_pending_reboot() {
  mkdir -p "${STATE_DIR}"
  printf '{"createdAt":"%s","reason":"custom-kernel-installed","message":"Reboot is required before the running kernel exposes IPv6 multicast routing."}\n' \
    "$(now_iso)" >"${PENDING_REBOOT_FILE}"
}

clear_pending_reboot_if_current_kernel_supports_thread() {
  if [[ -r "${PENDING_REBOOT_FILE}" ]] && kernel_supports_full_thread; then
    rm -f "${PENDING_REBOOT_FILE}"
  fi
}

schedule_reboot() {
  mark_pending_reboot
  log "Scheduling Jetson reboot in one minute so HomeBrain can finish recording job status."
  if command_exists shutdown; then
    shutdown -r +1 "HomeBrain installed a Thread multicast kernel; rebooting to activate it."
  elif command_exists systemctl; then
    systemd-run --on-active=60 /bin/systemctl reboot || systemctl reboot
  else
    reboot
  fi
}

run_apply() {
  require_root
  validate_confirmation
  is_jetson_orin_host || die "This kernel rebuild path is only supported on Jetson Orin-class L4T hosts."
  mkdir -p "${STATE_DIR}"
  : >"${LOG_FILE}"
  exec > >(tee -a "${LOG_FILE}") 2> >(tee -a "${LOG_FILE}" >&2)

  write_result_json running "Kernel rebuild is running." false
  ensure_build_packages
  prepare_builder
  prepare_sources
  apply_thread_kernel_config
  build_and_install_kernel
  mark_pending_reboot
  write_result_json completed "Custom Thread multicast kernel installed. Reboot is required." true

  if [[ "${AUTO_REBOOT}" == "1" ]]; then
    schedule_reboot
  fi

  print_status_json
}

case "${ACTION}" in
  status)
    clear_pending_reboot_if_current_kernel_supports_thread
    print_status_json
    ;;
  apply|rebuild)
    run_apply
    ;;
  *)
    die "Unknown action: ${ACTION}"
    ;;
esac
