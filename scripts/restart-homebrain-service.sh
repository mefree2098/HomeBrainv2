#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${HOMEBRAIN_SERVICE_NAME:-homebrain}"
HOMEBRAIN_DIR="${HOMEBRAIN_DIR:-}"
WAIT_SECONDS="${HOMEBRAIN_RESTART_WAIT_SECONDS:-20}"
HOMEBRAIN_PORT="${HOMEBRAIN_PORT:-3000}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-$(command -v systemctl || true)}"

if [[ -z "${SYSTEMCTL_BIN}" ]]; then
  echo "systemctl is not available on this host." >&2
  exit 1
fi

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
  local include_service_pid="${1:-false}"
  local service_pid="0"
  local stale_pids=()

  service_pid="$("${SYSTEMCTL_BIN}" show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || echo 0)"
  service_pid="${service_pid:-0}"

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue

    local pid="${line%% *}"
    local cmd="${line#* }"
    if [[ -z "${pid}" ]]; then
      continue
    fi

    if [[ "${include_service_pid}" != "true" && "${pid}" == "${service_pid}" ]]; then
      continue
    fi

    if process_matches_homebrain "${pid}" "${cmd}"; then
      stale_pids+=("${pid}")
    fi
  done < <(ps -eo pid=,args=)

  if [[ "${#stale_pids[@]}" -eq 0 ]]; then
    return
  fi

  echo "Stopping orphaned HomeBrain Node process(es): ${stale_pids[*]}"
  kill "${stale_pids[@]}" 2>/dev/null || true
  sleep 2
  kill -9 "${stale_pids[@]}" 2>/dev/null || true
}

get_service_main_pid() {
  local main_pid
  main_pid="$("${SYSTEMCTL_BIN}" show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || echo 0)"
  if [[ -z "${main_pid}" ]]; then
    echo 0
    return
  fi
  echo "${main_pid}"
}

get_listener_pids_for_port() {
  local port="$1"
  local output

  output="$(ss -lntp "( sport = :${port} )" 2>/dev/null || true)"
  if [[ -z "${output}" ]]; then
    return 0
  fi

  grep -o 'pid=[0-9]\+' <<<"${output}" | cut -d= -f2 | sort -u
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

kill_listener_pids() {
  local pids=("$@")

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi

  kill "${pids[@]}" 2>/dev/null || true
  sleep 2
  kill -9 "${pids[@]}" 2>/dev/null || true
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

  echo "Stopping process(es) blocking HomeBrain port ${HOMEBRAIN_PORT}: ${blocking_pids[*]}"
  kill_listener_pids "${blocking_pids[@]}"
}

get_service_state() {
  "${SYSTEMCTL_BIN}" show -p ActiveState --value "${SERVICE_NAME}" 2>/dev/null || true
}

stop_homebrain_service() {
  local state=""
  local elapsed=0

  cleanup_orphaned_homebrain_processes false

  state="$(get_service_state)"
  if [[ -z "${state}" || "${state}" == "inactive" || "${state}" == "failed" ]]; then
    cleanup_orphaned_homebrain_processes true
    cleanup_blocking_homebrain_port_listeners
    return 0
  fi

  echo "Stopping ${SERVICE_NAME} (waiting up to ${WAIT_SECONDS}s)..."
  "${SYSTEMCTL_BIN}" stop "${SERVICE_NAME}" --no-block || true

  while true; do
    state="$(get_service_state)"

    if [[ -z "${state}" || "${state}" == "inactive" || "${state}" == "failed" ]]; then
      break
    fi

    if (( elapsed >= WAIT_SECONDS )); then
      echo "${SERVICE_NAME} is still ${state} after ${WAIT_SECONDS}s. Forcing it down."
      "${SYSTEMCTL_BIN}" kill --kill-who=all --signal=SIGKILL "${SERVICE_NAME}" 2>/dev/null || true
      "${SYSTEMCTL_BIN}" stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
      break
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  cleanup_orphaned_homebrain_processes true
  cleanup_blocking_homebrain_port_listeners
}

echo "Restarting ${SERVICE_NAME}..."
stop_homebrain_service
"${SYSTEMCTL_BIN}" daemon-reload || true
"${SYSTEMCTL_BIN}" start "${SERVICE_NAME}"
echo "${SERVICE_NAME} restart queued."
