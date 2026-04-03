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
  fi

  if [[ "${succeeded}" -ne 0 ]]; then
    echo "Ollama service was not running." >&2
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
