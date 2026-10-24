#!/usr/bin/env bash
# Administrator-only installation. The application must never sudo this file.
set -euo pipefail

if [[ ${EUID} -ne 0 || $# -ne 1 ]]; then
  echo 'Usage: sudo bash scripts/harden-homebrain-service.sh /absolute/HomeBrainv2' >&2
  exit 64
fi
REPO=$(readlink -f -- "$1")
[[ "$REPO" == /* && "$REPO" != / && "$REPO" != *$'\n'* && "$REPO" != *' '* ]]
[[ -f "$REPO/server/server.js" && -f "$REPO/scripts/homebrain-host-control.py" ]]
command -v setfacl >/dev/null || { echo 'Install the Ubuntu acl package first.' >&2; exit 1; }
RUNTIME_HOME=/var/lib/homebrain/runtime
BACKUP=/var/lib/homebrain/security-hardening/$(date -u +%Y%m%dT%H%M%SZ)
install -d -o root -g root -m 0700 "$BACKUP"
for old in /etc/systemd/system/homebrain.service /etc/systemd/system/homebrain.service.d /etc/systemd/system/homebrain-restore-helper.service /etc/sudoers.d/homebrain-deploy; do
  if [[ -e "$old" ]]; then cp -a --parents "$old" "$BACKUP/"; fi
done

if ! getent passwd homebrain >/dev/null; then
  useradd --system --user-group --home-dir "$RUNTIME_HOME" --shell /usr/sbin/nologin homebrain
fi
[[ $(id -u homebrain) != 0 ]]
# An existing account must not retain sudo/docker/administrative groups.
groups=()
for group in dialout audio video render plugdev gpio i2c; do
  if getent group "$group" >/dev/null; then groups+=("$group"); fi
done
GROUP_LIST=$(IFS=,; echo "${groups[*]}")
usermod -G "$GROUP_LIST" homebrain
usermod --home "$RUNTIME_HOME" --shell /usr/sbin/nologin --lock homebrain
install -d -o homebrain -g homebrain -m 0700 "$RUNTIME_HOME"
chown -hR homebrain:homebrain -- "$RUNTIME_HOME"

# Grant traversal of this checkout's ancestors, never the operator's home tree.
ancestor=$(dirname "$REPO")
while [[ "$ancestor" != / ]]; do
  setfacl -m u:homebrain:--x -- "$ancestor"
  ancestor=$(dirname "$ancestor")
done
chown -hR homebrain:homebrain -- "$REPO"
if [[ -f "$REPO/server/.env" ]]; then chmod 0600 "$REPO/server/.env"; fi

install -d -o root -g root -m 0755 /usr/local/lib/homebrain /etc/homebrain
install -d -o root -g root -m 0755 /run/homebrain-control
install -o root -g root -m 0755 "$REPO/scripts/homebrain-host-control.py" /usr/local/lib/homebrain/homebrain-host-control.py
install -o root -g root -m 0755 "$REPO/scripts/restore-homebrain-backup.sh" /usr/local/lib/homebrain/restore-homebrain-backup.sh
cat > /etc/homebrain/runtime.env <<EOF
HOMEBRAIN_HARDENED_SERVICE=1
HOMEBRAIN_HOST_CONTROL_SOCKET=/run/homebrain-control/host.sock
HOME=$RUNTIME_HOME
USER=homebrain
LOGNAME=homebrain
HOMEBRAIN_DIR=$REPO
EOF
chown root:root /etc/homebrain/runtime.env
chmod 0644 /etc/homebrain/runtime.env

cat > /etc/systemd/system/homebrain.service <<EOF
[Unit]
Description=HomeBrain Smart Home Hub
After=local-fs.target network-online.target mongod.service homebrain-control.socket
Wants=network-online.target homebrain-control.socket
Requires=mongod.service
RequiresMountsFor=$REPO $RUNTIME_HOME
StartLimitIntervalSec=300
StartLimitBurst=30

[Service]
Type=simple
User=homebrain
Group=homebrain
WorkingDirectory=$REPO
EnvironmentFile=-$REPO/server/.env
EnvironmentFile=/etc/homebrain/runtime.env
Environment=NODE_ENV=production
Environment=HOMEBRAIN_BOOTSTRAP_NODE_BIN=/usr/bin/node
Environment=WAKEWORD_PIPER_EXEC=$REPO/server/.wakeword-venv/bin/piper
ExecStart=$REPO/scripts/run-homebrain-server-with-modern-node.sh
Restart=always
RestartSec=10
TimeoutStopSec=90
KillMode=control-group
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$REPO $RUNTIME_HOME
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictRealtime=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/homebrain-control.socket <<'EOF'
[Unit]
Description=HomeBrain limited service control socket
[Socket]
ListenStream=/run/homebrain-control/host.sock
SocketUser=root
SocketGroup=homebrain
SocketMode=0660
DirectoryMode=0755
Accept=yes
MaxConnections=8
RemoveOnStop=true
[Install]
WantedBy=sockets.target
EOF

cat > /etc/systemd/system/homebrain-control@.service <<'EOF'
[Unit]
Description=HomeBrain limited service control
[Service]
ExecStart=/usr/bin/python3 -I -S /usr/local/lib/homebrain/homebrain-host-control.py
StandardInput=socket
StandardOutput=socket
StandardError=journal
User=root
Group=root
WorkingDirectory=/
Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
RuntimeMaxSec=25
EOF

cat > /etc/systemd/system/homebrain-restore-helper.service <<EOF
[Unit]
Description=HomeBrain unprivileged restore helper
After=network-online.target mongod.service
Requires=mongod.service
[Service]
Type=oneshot
User=homebrain
Group=homebrain
WorkingDirectory=$REPO
EnvironmentFile=-$REPO/server/.env
EnvironmentFile=/etc/homebrain/runtime.env
Environment=NODE_BIN=/usr/bin/node
ExecStart=/usr/local/lib/homebrain/restore-homebrain-backup.sh
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$REPO $RUNTIME_HOME
PrivateTmp=true
RestrictSUIDSGID=true
UMask=0077
TimeoutStartSec=30min
EOF

# Remove the old writable-checkout / unrestricted systemctl sudo grant.
rm -f /etc/sudoers.d/homebrain-deploy
rm -f /etc/systemd/system/homebrain.service.d/99-ollama-helper.conf
rm -f /etc/systemd/system/homebrain.service.d/98-direct-server-start.conf
# Retire the old root process-killing helper; the broker restarts the exact unit.
systemctl disable homebrain-restart-helper.service >/dev/null 2>&1 || true
if [[ -f /etc/systemd/system/homebrain-restart-helper.service ]]; then
  cp -a /etc/systemd/system/homebrain-restart-helper.service "$BACKUP/"
  rm /etc/systemd/system/homebrain-restart-helper.service
fi
systemctl daemon-reload
systemd-analyze verify homebrain.service homebrain-control.socket homebrain-control@.service homebrain-restore-helper.service
systemctl enable --now homebrain-control.socket
systemctl enable homebrain.service
echo "Hardened service installed. Restart HomeBrain after verifying its runtime/model permissions. Rollback: $BACKUP"
