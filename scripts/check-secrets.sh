#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
COMMON_SECRET_PATTERN='(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|-----BEGIN ((RSA|DSA|EC|OPENSSH|PGP) )?PRIVATE KEY-----)'

print_failure() {
  printf '\nPotential public-repo safety issue detected:\n%s\n' "$1" >&2
}

filter_allowed_matches() {
  grep -v 'client/src/pages/SSLManagement.tsx:.*placeholder=' || true
}

scan_current_tree() {
  local findings
  findings="$(
    { git grep -nI -E "${COMMON_SECRET_PATTERN}" -- . \
      ':(exclude).codex-home/**' \
      ':(exclude)docs/*.pdf' \
      ':(exclude)**/*.png' \
      ':(exclude)**/*.jpg' \
      ':(exclude)**/*.jpeg' \
      ':(exclude)**/*.gif' \
      ':(exclude)**/*.webp' \
      ':(exclude)**/*.ico' \
      || true; } \
      | filter_allowed_matches
  )"

  if [[ -n "${findings}" ]]; then
    print_failure "${findings}"
    return 1
  fi
}

scan_tracked_paths() {
  local unsafe_paths
  unsafe_paths="$(
    git ls-files \
      | grep -E '(^|/)(\.codex-home/|\.env$|\.env\.[^/]+|[^/]+\.(sqlite|sqlite-shm|sqlite-wal|db|pem|key|p12|crt|csr)$)' \
      | grep -vE '(^|/)\.env\.example$' \
      || true
  )"

  if [[ -n "${unsafe_paths}" ]]; then
    print_failure "${unsafe_paths}"
    return 1
  fi
}

scan_panel_defaults() {
  local config_path="embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h"
  local findings=""

  if [[ -f "${config_path}" ]]; then
    if ! grep -q '#define HOMEBRAIN_PANEL_WIFI_SSID "YOUR_WIFI_SSID"' "${config_path}"; then
      findings+="${config_path}: HOMEBRAIN_PANEL_WIFI_SSID must stay a placeholder in git"$'\n'
    fi
    if ! grep -q '#define HOMEBRAIN_PANEL_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"' "${config_path}"; then
      findings+="${config_path}: HOMEBRAIN_PANEL_WIFI_PASSWORD must stay a placeholder in git"$'\n'
    fi
    if ! grep -q '#define HOMEBRAIN_PANEL_ID "replace-with-panel-id"' "${config_path}"; then
      findings+="${config_path}: HOMEBRAIN_PANEL_ID must stay a placeholder in git"$'\n'
    fi
    if ! grep -q '#define HOMEBRAIN_PANEL_REGISTRATION_CODE "HBWP-XXXX-XXXX-XXXX"' "${config_path}"; then
      findings+="${config_path}: HOMEBRAIN_PANEL_REGISTRATION_CODE must stay a placeholder in git"$'\n'
    fi
  fi

  if [[ -n "${findings}" ]]; then
    print_failure "${findings}"
    return 1
  fi
}

scan_history() {
  local findings=""
  local rev
  local revs

  revs="$(history_revisions)"

  while IFS= read -r rev; do
    [[ -n "${rev}" ]] || continue
    local rev_matches
    rev_matches="$(
      { git grep -nI -E "${COMMON_SECRET_PATTERN}" "${rev}" -- . \
        ':(exclude).codex-home/**' \
        ':(exclude)docs/*.pdf' \
        ':(exclude)**/*.png' \
        ':(exclude)**/*.jpg' \
        ':(exclude)**/*.jpeg' \
        ':(exclude)**/*.gif' \
        ':(exclude)**/*.webp' \
        ':(exclude)**/*.ico' \
        2>/dev/null \
        || true; } \
        | filter_allowed_matches
    )"
    if [[ -n "${rev_matches}" ]]; then
      findings+="${rev}:${rev_matches}"$'\n'
    fi

    local rev_paths
    rev_paths="$(
      git ls-tree -r --name-only "${rev}" \
        | grep -E '(^|/)(\.codex-home/|\.env$|\.env\.[^/]+|[^/]+\.(sqlite|sqlite-shm|sqlite-wal|db|pem|key|p12|crt|csr)$)' \
        | grep -vE '(^|/)\.env\.example$' \
        || true
    )"
    if [[ -n "${rev_paths}" ]]; then
      findings+="${rev}: tracked unsafe path(s):"$'\n'"${rev_paths}"$'\n'
    fi
  done <<< "${revs}"

  if [[ -n "${findings}" ]]; then
    print_failure "${findings}"
    return 1
  fi
}

history_revisions() {
  local base_ref="${GITHUB_BASE_REF:-}"
  local event_name="${GITHUB_EVENT_NAME:-}"
  local remote_ref

  if [[ "${event_name}" == "pull_request" && -n "${base_ref}" ]]; then
    remote_ref="refs/remotes/origin/${base_ref}"
    git fetch --no-tags origin "${base_ref}:${remote_ref}" >/dev/null 2>&1 || true

    if git rev-parse --verify --quiet "${remote_ref}" >/dev/null; then
      git rev-list "${remote_ref}..HEAD"
      return
    fi
  fi

  git rev-list --all
}

scan_current_tree
scan_tracked_paths
scan_panel_defaults

if [[ "${MODE}" == "--history" ]]; then
  scan_history
fi

printf 'Secret-safety checks passed.\n'
