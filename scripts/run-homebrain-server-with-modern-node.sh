#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMEBRAIN_DIR="${HOMEBRAIN_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
BOOTSTRAP_NODE_BIN="${HOMEBRAIN_BOOTSTRAP_NODE_BIN:-$(command -v node || true)}"
HOMEBRAIN_PORT="${HOMEBRAIN_PORT:-${PORT:-3000}}"

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
  local homebrain_dir
  local process_cwd=""

  if [[ "${cmd}" != *"server.js"* && "${cmd}" != *"HomeBrainv2"* ]]; then
    return 1
  fi

  homebrain_dir="$(canonicalize_path "${HOMEBRAIN_DIR}")"
  process_cwd="$(canonicalize_path "/proc/${pid}/cwd" || true)"

  if [[ -n "${process_cwd}" && ( "${process_cwd}" == "${homebrain_dir}" || "${process_cwd}" == "${homebrain_dir}/"* ) ]]; then
    return 0
  fi

  if [[ "${cmd}" == *"${HOMEBRAIN_DIR}"* || "${cmd}" == *"${homebrain_dir}"* ]]; then
    return 0
  fi

  return 1
}

get_listener_pids_for_port() {
  local output

  output="$(ss -lntp "( sport = :${HOMEBRAIN_PORT} )" 2>/dev/null || true)"
  if [[ -z "${output}" ]]; then
    return 0
  fi

  grep -o 'pid=[0-9]\+' <<<"${output}" | cut -d= -f2 | sort -u || true
}

cleanup_blocking_homebrain_port_listener() {
  local listener_pid
  local cmd
  local blocking_pids=()
  local still_running=()

  while IFS= read -r listener_pid; do
    [[ -z "${listener_pid}" ]] && continue
    [[ "${listener_pid}" == "$$" ]] && continue

    cmd="$(ps -o args= -p "${listener_pid}" 2>/dev/null || true)"
    if [[ -z "${cmd}" ]]; then
      continue
    fi

    if process_matches_homebrain "${listener_pid}" "${cmd}"; then
      blocking_pids+=("${listener_pid}")
    fi
  done < <(get_listener_pids_for_port)

  if [[ "${#blocking_pids[@]}" -eq 0 ]]; then
    return 0
  fi

  echo "Stopping existing HomeBrain listener(s) on port ${HOMEBRAIN_PORT}: ${blocking_pids[*]}" >&2
  kill "${blocking_pids[@]}" 2>/dev/null || true

  for _ in {1..10}; do
    still_running=()
    for listener_pid in "${blocking_pids[@]}"; do
      if kill -0 "${listener_pid}" 2>/dev/null; then
        still_running+=("${listener_pid}")
      fi
    done

    if [[ "${#still_running[@]}" -eq 0 ]]; then
      return 0
    fi

    sleep 1
  done

  echo "Force-stopping HomeBrain listener(s) that did not exit: ${still_running[*]}" >&2
  kill -9 "${still_running[@]}" 2>/dev/null || true
}

if [[ -z "${BOOTSTRAP_NODE_BIN}" || ! -x "${BOOTSTRAP_NODE_BIN}" ]]; then
  echo "HomeBrain service could not find a bootstrap node binary." >&2
  exit 1
fi

cd "${HOMEBRAIN_DIR}"
SELECTED_NODE="$("${BOOTSTRAP_NODE_BIN}" scripts/run-with-modern-node.js --print-node-bin)"

if [[ -z "${SELECTED_NODE}" || ! -x "${SELECTED_NODE}" ]]; then
  echo "HomeBrain service could not resolve a supported node binary." >&2
  exit 1
fi

cleanup_blocking_homebrain_port_listener
exec "${SELECTED_NODE}" "${HOMEBRAIN_DIR}/server/server.js"
