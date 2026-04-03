#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:-}"
OS="$(uname -s)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This helper must run as root." >&2
  exit 1
fi

run_install() {
  if [[ "${OS}" == "Darwin" && "${OLLAMA_NO_START:-}" == "1" ]]; then
    export OLLAMA_NO_START=1
  fi

  curl -fsSL https://ollama.com/install.sh | sh
}

is_ollama_process_running() {
  pgrep -f "ollama serve" >/dev/null 2>&1
}

is_ollama_systemd_active() {
  command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ollama
}

wait_for_ollama_shutdown() {
  local attempt=1
  local max_attempts="${1:-20}"

  while [[ "${attempt}" -le "${max_attempts}" ]]; do
    if ! is_ollama_process_running && ! is_ollama_systemd_active; then
      return 0
    fi

    if [[ "${attempt}" -eq 5 || "${attempt}" -eq 10 || "${attempt}" -eq 15 ]]; then
      if command -v systemctl >/dev/null 2>&1; then
        systemctl stop ollama >/dev/null 2>&1 || true
        systemctl kill --kill-who=all --signal=SIGTERM ollama >/dev/null 2>&1 || true
      fi
      pkill -f "ollama serve" >/dev/null 2>&1 || true
    fi

    if [[ "${attempt}" -ge 10 ]]; then
      if command -v systemctl >/dev/null 2>&1; then
        systemctl kill --kill-who=all --signal=SIGKILL ollama >/dev/null 2>&1 || true
      fi
      pkill -9 -f "ollama serve" >/dev/null 2>&1 || true
    fi

    sleep 1
    attempt=$((attempt + 1))
  done

  return 1
}

stop_system_service() {
  local succeeded=1

  if [[ "${OS}" == "Darwin" ]]; then
    launchctl stop com.ollama.ollama >/dev/null 2>&1 && succeeded=0 || true
    pkill -x Ollama >/dev/null 2>&1 && succeeded=0 || true
    pkill -f "ollama serve" >/dev/null 2>&1 && succeeded=0 || true
  else
    if command -v systemctl >/dev/null 2>&1; then
      systemctl stop ollama >/dev/null 2>&1 && succeeded=0 || true
    fi

    if command -v service >/dev/null 2>&1; then
      service ollama stop >/dev/null 2>&1 && succeeded=0 || true
    fi

    pkill -f "ollama serve" >/dev/null 2>&1 && succeeded=0 || true

    if wait_for_ollama_shutdown 20; then
      succeeded=0
    fi
  fi

  if [[ "${succeeded}" -ne 0 ]]; then
    echo "Ollama service is still running after the stop attempt." >&2
    exit 1
  fi
}

case "${ACTION}" in
  install)
    run_install
    ;;
  update)
    run_install
    ;;
  stop-system)
    stop_system_service
    ;;
  probe)
    exit 0
    ;;
  *)
    echo "Usage: $0 <install|update|stop-system|probe>" >&2
    exit 64
    ;;
esac
