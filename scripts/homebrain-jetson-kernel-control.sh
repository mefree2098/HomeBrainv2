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
CUSTOM_CONFIG="${HOMEBRAIN_THREAD_KERNEL_CONFIG:-/boot/config.homebrain-thread}"
CONFIRM_PHRASE="${HOMEBRAIN_THREAD_KERNEL_CONFIRMATION:-REBUILD JETSON KERNEL FOR FULL THREAD}"
REBOOT_CONFIRM_PHRASE="${HOMEBRAIN_THREAD_KERNEL_REBOOT_CONFIRMATION:-REBOOT JETSON AFTER KERNEL INSTALL}"
JETSONHACKS_REPO_URL="${HOMEBRAIN_THREAD_KERNEL_BUILDER_REPO:-https://github.com/jetsonhacks/jetson-orin-kernel-builder.git}"
LOG_FILE="${STATE_DIR}/last-build.log"
LAST_RESULT_FILE="${STATE_DIR}/last-result.json"
PENDING_REBOOT_FILE="${STATE_DIR}/pending-reboot.json"
VALIDATION_FILE="${STATE_DIR}/last-validation.json"
KERNEL_RELEASE_FILE="${STATE_DIR}/kernel-release"
LAST_EXTLINUX_BACKUP_FILE="${STATE_DIR}/last-extlinux-backup-path"
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

json_file_or_null() {
  local target="${1:-}"
  if [[ ! -s "${target}" ]]; then
    printf 'null'
    return
  fi

  if command_exists python3; then
    JSON_FILE="${target}" python3 - <<'PY'
import json
import os
import sys
from pathlib import Path

path = Path(os.environ["JSON_FILE"])
try:
    payload = json.loads(path.read_text(errors="ignore"))
except Exception:
    print("null")
    raise SystemExit(0)

if payload is None:
    print("null")
else:
    print(json.dumps(payload, separators=(",", ":")))
PY
    return
  fi

  tr -d '\n' <"${target}"
}

pending_reboot_json() {
  json_file_or_null "${PENDING_REBOOT_FILE}"
}

last_result_json() {
  json_file_or_null "${LAST_RESULT_FILE}"
}

validation_json() {
  json_file_or_null "${VALIDATION_FILE}"
}

print_status_json() {
  local jetson="false" support="false" needs="true" runtime l4t default_label pending last_result validation
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
  validation="$(validation_json)"

  printf '{"success":true,"helper":"homebrain-jetson-kernel-control","confirmationPhrase":"%s","rebootConfirmationPhrase":"%s","isJetsonOrin":%s,"unameRelease":"%s","l4tRelease":"%s","kernelConfig":%s,"runtimeIpv6Mroute":"%s","kernelSupportsFullThread":%s,"needsRebuild":%s,"builder":{"path":"%s","exists":%s,"revision":"%s"},"source":{"path":"%s","exists":%s,"revision":"%s"},"boot":{"extlinuxConf":"%s","defaultLabel":"%s","customLabel":"%s","customImage":"%s","customImageSha256":"%s","customInitrd":"%s","customInitrdSha256":"%s","customConfig":"%s","customConfigSha256":"%s"},"pendingReboot":%s,"validation":%s,"lastResult":%s}\n' \
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
    "$(json_escape "${CUSTOM_CONFIG}")" \
    "$(json_escape "$(file_sha256 "${CUSTOM_CONFIG}")")" \
    "${pending}" \
    "${validation}" \
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
  kernel_release="$(cd "${KERNEL_SRC}" && make -s kernelrelease)"

  [[ -r "${KERNEL_SRC}/arch/arm64/boot/Image" ]] || die "Built kernel Image was not found."
  mkdir -p "$(dirname "${CUSTOM_IMAGE}")"

  if [[ -r "${CUSTOM_IMAGE}" ]]; then
    boot_backup="${CUSTOM_IMAGE}.backup.$(date +%Y%m%d-%H%M%S)"
    log "Backing up previous HomeBrain custom kernel to ${boot_backup}."
    cp -a "${CUSTOM_IMAGE}" "${boot_backup}"
  fi

  log "Installing custom kernel image to ${CUSTOM_IMAGE}."
  install -m 0644 "${KERNEL_SRC}/arch/arm64/boot/Image" "${CUSTOM_IMAGE}"
  install -m 0644 "${KERNEL_SRC}/.config" "${CUSTOM_CONFIG}"
  printf '%s\n' "${kernel_release}" >"${KERNEL_RELEASE_FILE}"

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
  printf '%s\n' "${extlinux_backup}" >"${LAST_EXTLINUX_BACKUP_FILE}"
  log "Updating ${EXTLINUX_CONF}; backup is ${extlinux_backup}."
  EXTLINUX_CONF="${EXTLINUX_CONF}" CUSTOM_LABEL="${CUSTOM_LABEL}" CUSTOM_IMAGE="${CUSTOM_IMAGE}" CUSTOM_INITRD="${CUSTOM_INITRD}" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["EXTLINUX_CONF"])
label = os.environ["CUSTOM_LABEL"]
image = os.environ["CUSTOM_IMAGE"]
initrd = os.environ["CUSTOM_INITRD"]

lines = path.read_text().splitlines()
global_lines = []
stanzas = []
current = None
default_label = ""

for line in lines:
    stripped = line.strip()
    upper = stripped.upper()
    if upper.startswith("DEFAULT "):
        parts = stripped.split(None, 1)
        default_label = parts[1] if len(parts) > 1 else ""
        global_lines.append(f"DEFAULT {label}")
        continue
    if upper.startswith("LABEL "):
        if current:
            stanzas.append(current)
        current = [line]
        continue
    if current is None:
        global_lines.append(line)
    else:
        current.append(line)

if current:
    stanzas.append(current)

if not any(line.strip().upper().startswith("DEFAULT ") for line in global_lines):
    global_lines.insert(0, f"DEFAULT {label}")

existing_stanzas = []
source_stanza = None
for stanza in stanzas:
    first = stanza[0].strip().split(None, 1)
    stanza_label = first[1] if len(first) > 1 else ""
    if stanza_label == label:
        continue
    if source_stanza is None and (stanza_label == default_label or not default_label):
        source_stanza = stanza
    existing_stanzas.append(stanza)

if source_stanza is None and existing_stanzas:
    source_stanza = existing_stanzas[0]

if source_stanza:
    new_stanza = []
    saw_linux = False
    saw_menu = False
    saw_initrd = False
    for line in source_stanza:
        stripped = line.strip()
        upper = stripped.upper()
        indent = line[:len(line) - len(line.lstrip())] or "    "
        if upper.startswith("LABEL "):
            new_stanza.append(f"LABEL {label}")
        elif upper.startswith("MENU LABEL "):
            new_stanza.append(f"{indent}MENU LABEL HomeBrain Thread multicast kernel")
            saw_menu = True
        elif upper.startswith("LINUX "):
            new_stanza.append(f"{indent}LINUX {image}")
            saw_linux = True
        elif upper.startswith("INITRD ") and Path(initrd).exists():
            new_stanza.append(f"{indent}INITRD {initrd}")
            saw_initrd = True
        else:
            new_stanza.append(line)
    if not saw_menu:
        new_stanza.insert(1, "    MENU LABEL HomeBrain Thread multicast kernel")
    if not saw_linux:
        new_stanza.insert(2, f"    LINUX {image}")
    if Path(initrd).exists() and not saw_initrd:
        insert_at = 3 if len(new_stanza) >= 3 else len(new_stanza)
        new_stanza.insert(insert_at, f"    INITRD {initrd}")
else:
    new_stanza = [
        f"LABEL {label}",
        "    MENU LABEL HomeBrain Thread multicast kernel",
        f"    LINUX {image}",
    ]
    if Path(initrd).exists():
        new_stanza.append(f"    INITRD {initrd}")
    new_stanza.append("    APPEND ${cbootargs}")

while global_lines and global_lines[-1] == "":
    global_lines.pop()

out = list(global_lines)
for stanza in existing_stanzas:
    if out and out[-1] != "":
        out.append("")
    out.extend(stanza)
if out and out[-1] != "":
    out.append("")
out.extend(new_stanza)
path.write_text("\n".join(out).rstrip() + "\n")
PY
}

run_preflight_validation() {
  mkdir -p "${STATE_DIR}"
  local validation status stderr_file stderr_text fallback_detail
  stderr_file="$(mktemp "${STATE_DIR}/preflight-stderr.XXXXXX" 2>/dev/null || mktemp)"
  set +e
  validation="$(EXTLINUX_CONF="${EXTLINUX_CONF}" CUSTOM_LABEL="${CUSTOM_LABEL}" CUSTOM_IMAGE="${CUSTOM_IMAGE}" CUSTOM_INITRD="${CUSTOM_INITRD}" CUSTOM_CONFIG="${CUSTOM_CONFIG}" KERNEL_RELEASE_FILE="${KERNEL_RELEASE_FILE}" KERNEL_SRC="${KERNEL_SRC}" REQUIRED_CONFIGS="$(IFS=,; echo "${THREAD_KERNEL_CONFIGS[*]}")" python3 - 2>"${stderr_file}" <<'PY'
import json
import os
import re
import subprocess
import sys
from pathlib import Path

required = [item for item in os.environ["REQUIRED_CONFIGS"].split(",") if item]
extlinux = Path(os.environ["EXTLINUX_CONF"])
label = os.environ["CUSTOM_LABEL"]
image = Path(os.environ["CUSTOM_IMAGE"])
initrd = Path(os.environ["CUSTOM_INITRD"])
config = Path(os.environ["CUSTOM_CONFIG"])
kernel_src = Path(os.environ["KERNEL_SRC"])
release_file = Path(os.environ["KERNEL_RELEASE_FILE"])

def read_config(path):
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(errors="ignore").splitlines():
        for key in required:
            if line == f"{key}=y":
                values[key] = "y"
            elif line == f"{key}=m":
                values[key] = "m"
            elif line == f"# {key} is not set":
                values[key] = "n"
    return values

def parse_extlinux(path):
    parsed = {"defaultLabel": "", "labels": [], "custom": None}
    if not path.exists():
        return parsed
    current = None
    for line in path.read_text(errors="ignore").splitlines():
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith("DEFAULT "):
            parts = stripped.split(None, 1)
            parsed["defaultLabel"] = parts[1] if len(parts) > 1 else ""
            continue
        if upper.startswith("LABEL "):
            parts = stripped.split(None, 1)
            current = {"label": parts[1] if len(parts) > 1 else "", "lines": [], "linux": "", "initrd": ""}
            parsed["labels"].append(current["label"])
            if current["label"] == label:
                parsed["custom"] = current
            continue
        if current is not None:
            current["lines"].append(line)
            if upper.startswith("LINUX "):
                parts = stripped.split(None, 1)
                current["linux"] = parts[1] if len(parts) > 1 else ""
            elif upper.startswith("INITRD "):
                parts = stripped.split(None, 1)
                current["initrd"] = parts[1] if len(parts) > 1 else ""
    return parsed

checks = []
warnings = []

def add_check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": detail})
    return bool(ok)

image_exists = image.exists()
image_size = image.stat().st_size if image_exists else 0
add_check("custom kernel image exists", image_exists, str(image))
add_check("custom kernel image is non-empty", image_size > 8 * 1024 * 1024, f"{image_size} bytes")

file_text = ""
if image_exists:
    try:
        file_text = subprocess.run(["file", "-b", str(image)], text=True, capture_output=True, timeout=5).stdout.strip()
    except Exception as exc:
        file_text = f"file unavailable: {exc}"
    if file_text and not re.search(r"(linux|kernel|arm|aarch64|data)", file_text, re.I):
        warnings.append(f"Unexpected kernel image file type: {file_text}")

config_values = read_config(config)
missing = [key for key in required if config_values.get(key) not in ("y", "m")]
add_check("custom kernel config exists", config.exists(), str(config))
add_check("custom kernel config enables Thread multicast routing", not missing, ", ".join(missing) if missing else "all required options enabled")

extract_script = kernel_src / "scripts" / "extract-ikconfig"
extracted = {"available": False, "ok": None, "missing": [], "error": ""}
if image_exists and extract_script.exists():
    try:
        result = subprocess.run([str(extract_script), str(image)], text=True, capture_output=True, timeout=20)
        if result.returncode == 0 and result.stdout.strip():
            extracted["available"] = True
            temp_config = Path(os.environ.get("TMPDIR", "/tmp")) / f"homebrain-extracted-kernel-config-{os.getpid()}"
            temp_config.write_text(result.stdout)
            values = read_config(temp_config)
            temp_config.unlink(missing_ok=True)
            extracted["missing"] = [key for key in required if values.get(key) not in ("y", "m")]
            extracted["ok"] = not extracted["missing"]
            add_check("embedded kernel config matches required Thread options", extracted["ok"], ", ".join(extracted["missing"]) if extracted["missing"] else "all required options present")
        else:
            extracted["error"] = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
            warnings.append("Could not extract embedded kernel config from Image; validating copied source .config instead.")
    except Exception as exc:
        extracted["error"] = str(exc)
        warnings.append("Could not extract embedded kernel config from Image; validating copied source .config instead.")
else:
    warnings.append("Kernel extract-ikconfig script is unavailable; validating copied source .config instead.")

kernel_release = release_file.read_text().strip() if release_file.exists() else ""
modules_dir = Path("/lib/modules") / kernel_release if kernel_release else Path("/lib/modules/__missing__")
add_check("kernel release recorded", bool(kernel_release), kernel_release or "missing")
add_check("matching modules directory exists", modules_dir.exists(), str(modules_dir))
add_check("module dependency index exists", (modules_dir / "modules.dep").exists(), str(modules_dir / "modules.dep"))

boot = parse_extlinux(extlinux)
custom = boot.get("custom") or {}
fallback_labels = [item for item in boot.get("labels", []) if item and item != label]
custom_linux = custom.get("linux", "")
custom_initrd = custom.get("initrd", "")
linux_matches = custom_linux == str(image)
initrd_ok = True
if custom_initrd == str(initrd):
    initrd_ok = initrd.exists()

add_check("boot config exists", extlinux.exists(), str(extlinux))
add_check("custom boot label exists", bool(custom), label)
add_check("custom boot label is default", boot.get("defaultLabel") == label, boot.get("defaultLabel") or "missing")
add_check("custom boot label points at HomeBrain kernel image", linux_matches, custom_linux or "missing")
add_check("stock boot fallback label remains available", bool(fallback_labels), ", ".join(fallback_labels) or "none")
add_check("referenced custom initrd exists", initrd_ok, custom_initrd or "no custom initrd reference")

ok = all(check["ok"] for check in checks)
payload = {
    "ok": ok,
    "checkedAt": subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], text=True, capture_output=True).stdout.strip(),
    "kernelRelease": kernel_release or None,
    "customImage": str(image),
    "customImageBytes": image_size,
    "customImageType": file_text,
    "customConfig": str(config),
    "extlinuxConf": str(extlinux),
    "defaultLabel": boot.get("defaultLabel") or None,
    "fallbackLabels": fallback_labels,
    "requiredConfigs": required,
    "configValues": config_values,
    "embeddedConfig": extracted,
    "checks": checks,
    "warnings": warnings,
}
print(json.dumps(payload, separators=(",", ":")))
sys.exit(0 if ok else 1)
PY
)"
  status=$?
  set -e
  stderr_text="$(tr -d '\r' <"${stderr_file}" 2>/dev/null || true)"
  rm -f "${stderr_file}"
  if [[ -z "${validation}" ]]; then
    fallback_detail="${stderr_text:-preflight produced no output}"
    validation="$(printf '{"ok":false,"checkedAt":"%s","error":"%s","checks":[{"name":"preflight helper returned validation details","ok":false,"detail":"%s"}],"warnings":[]}\n' \
      "$(now_iso)" \
      "$(json_escape "${fallback_detail}")" \
      "$(json_escape "${fallback_detail}")")"
    status=1
  fi
  if [[ -z "${validation}" ]]; then
    validation='{"ok":false,"error":"preflight produced no output"}'
  fi
  printf '%s\n' "${validation}" >"${VALIDATION_FILE}"
  printf '%s\n' "${validation}"
  return "${status}"
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

restore_extlinux_backup_after_failed_validation() {
  local backup_path=""
  if [[ -r "${LAST_EXTLINUX_BACKUP_FILE}" ]]; then
    backup_path="$(cat "${LAST_EXTLINUX_BACKUP_FILE}")"
  fi
  if [[ -n "${backup_path}" && -r "${backup_path}" ]]; then
    log "Restoring ${EXTLINUX_CONF} from ${backup_path} because validation failed."
    cp -a "${backup_path}" "${EXTLINUX_CONF}"
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
  log "Running pre-reboot validation for the installed HomeBrain Thread kernel."
  if ! run_preflight_validation >/dev/null; then
    restore_extlinux_backup_after_failed_validation
    write_result_json failed "Pre-reboot kernel validation failed. Reboot was not scheduled." false
    die "Pre-reboot kernel validation failed; leaving the current booted kernel in place."
  fi
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
  validate|preflight)
    run_preflight_validation
    ;;
  apply|rebuild)
    run_apply
    ;;
  *)
    die "Unknown action: ${ACTION}"
    ;;
esac
