#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${HOMEBRAIN_SERVICE_NAME:-homebrain}"
HOMEBRAIN_DIR="${HOMEBRAIN_DIR:-}"
WAIT_SECONDS="${HOMEBRAIN_RESTART_WAIT_SECONDS:-20}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-$(command -v systemctl || true)}"

if [[ -z "${SYSTEMCTL_BIN}" ]]; then
  echo "systemctl is not available on this host." >&2
  exit 1
fi

cleanup_orphaned_homebrain_processes() {
  local service_pid="0"
  local stale_pids=()

  service_pid="$("${SYSTEMCTL_BIN}" show -p MainPID --value "${SERVICE_NAME}" 2>/dev/null || echo 0)"
  service_pid="${service_pid:-0}"

  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue

    local pid="${line%% *}"
    local cmd="${line#* }"
    if [[ -z "${pid}" || "${pid}" == "${service_pid}" ]]; then
      continue
    fi

    if [[ -n "${HOMEBRAIN_DIR}" && "${cmd}" != *"${HOMEBRAIN_DIR}"* ]]; then
      continue
    fi

    if [[ "${cmd}" == *"node"* ]] && [[ "${cmd}" == *"server.js"* || "${cmd}" == *"run-with-modern-node.js npm start"* ]]; then
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

get_service_state() {
  "${SYSTEMCTL_BIN}" show -p ActiveState --value "${SERVICE_NAME}" 2>/dev/null || true
}

stop_homebrain_service() {
  local state=""
  local elapsed=0

  cleanup_orphaned_homebrain_processes

  state="$(get_service_state)"
  if [[ -z "${state}" || "${state}" == "inactive" || "${state}" == "failed" ]]; then
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

  cleanup_orphaned_homebrain_processes
}

echo "Restarting ${SERVICE_NAME}..."
stop_homebrain_service
"${SYSTEMCTL_BIN}" daemon-reload || true
"${SYSTEMCTL_BIN}" start "${SERVICE_NAME}"
echo "${SERVICE_NAME} restart queued."
