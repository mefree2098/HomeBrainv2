# HomeBrain host privilege and MongoDB hardening

This follow-up removes the application's administrative account boundary and retires MongoDB 6. Selene firmware, NVIDIA BSP, bootloader and kernel updates remain held. Host software installation, kernel changes and whole-host reboots require an authenticated SSH administrator.

## Runtime boundary

The administrator installer creates a dedicated `homebrain` system account with a locked login, a private home at `/var/lib/homebrain/runtime`, and only existing hardware groups. It replaces the old root/shared-operator service with `User=homebrain`, `NoNewPrivileges=true`, empty effective/ambient capability bounds, a read-only host filesystem, and writable access limited to the application checkout and runtime home. It protects the operator's home from writes. The account receives no sudo or Docker membership.

`homebrain-control.socket` accepts local Unix socket connections. Its root-owned, isolated Python handler checks the kernel's peer UID against the dedicated runtime account before reading a bounded request. The only request field is a fixed action. The handler maps that action to a constant systemd unit and verb, uses a clean environment, and accepts no command, path, argument, unit or environment supplied by the caller. It cannot install software, reload unit definitions, run checkout code as root, rebuild firmware or reboot. Restore code runs under the same unprivileged account and requests only fixed service stop/start operations.

The obsolete `homebrain-deploy` sudoers grant and root restart helper are removed. Application deployments retain administrator-owned service configuration and check the control socket instead of executing a writable setup script with sudo. Package update checks remain unprivileged; package installation/update, Ollama binary installation, Thread provisioning and kernel changes require SSH administration. Normal application dependencies, builds and self-restarts remain available.

Use a verified release and authenticated administrator session to install the reviewed service configuration:

```sh
sudo bash scripts/harden-homebrain-service.sh /absolute/path/to/HomeBrainv2
```

Before restarting, relocate external Python environments and cached models into the runtime home or provide narrowly scoped read access. Preserve the existing environment, identity signing keys, HomeKit pairing state and runtime data. The installer records the old service configuration under a root-only rollback directory. It does not migrate a database or update firmware.

## MongoDB upgrade and rollback

New installs default to MongoDB 8.0. An existing older installation is rejected by the fresh installer rather than silently reused or upgraded across unsupported major-version boundaries.

Production authentication uses a HomeBrain database user restricted to `readWrite` and `dbAdmin` on `HomeBrain`, with a separate administrator credential protected on the host. Anonymous data access and application access to other databases or server administration must fail. Backup and restore tools receive credentials through a temporary mode-0600 config inside a mode-0700 directory, which is removed on completion or failure. Restoring older backups preserves the current host's database connection instead of reintroducing obsolete credentials.

MongoDB documents sequential upgrades from [6.0 to 7.0](https://www.mongodb.com/docs/v7.0/release-notes/7.0-upgrade-standalone/) and [7.0 to 8.0](https://www.mongodb.com/docs/v8.0/release-notes/8.0-upgrade-standalone/). The selected native Ubuntu 22.04 ARM64 packages are 7.0.45 and 8.0.34. Verify repository signatures, package hashes and the actual target CPU before installation. MongoDB 8.0's [published lifecycle](https://www.mongodb.com/legal/support-policy/lifecycles) extends to October 2029.

Rehearse each host's actual backup in an isolated environment before production. Restore to 6.0, validate collections/indexes, record raw BSON and index hashes, start 7.0 and set FCV 7.0, then start 8.0, verify at FCV 7.0, and test FCV 8.0. Counts, BSON, indexes and collection options must match at every step. Check for deprecated BSON undefined values because [null comparison behavior changes in 8.0](https://www.mongodb.com/docs/v8.0/release-notes/8.0-compatibility/). Run actual HomeBrain model CRUD, unique-index, aggregation, date-range and compound-index queries against an isolated fixture database.

For production, stop HomeBrain, pause TTL deletion for the verification window, take a fresh logical archive and a clean stopped-server filesystem copy, preserve exact old packages/configuration, then perform the same sequential upgrade. Compare the quiescent data before allowing application writes. Do not run an older binary on a data directory whose compatibility version has advanced. Recovery to 6.0 uses the untouched pre-upgrade copy; after new writes resume, that snapshot alone is no longer a lossless rollback. Preserve normal backups and rehearse restore with the accepted current tools.

## Verification

CI tests the controller's strict request parser, caller UID checks, denied execution/argument/environment/reboot operations, bounded responses and failures. Node regressions cover deployment, restores, and administrator-only actions. The unit-test bootstrap replaces any inherited production database URI and host-control socket before loading test modules, so a deploy's tests cannot dispatch real service operations. A pinned official MongoDB 8.0.34 CI container exercises actual HomeBrain models; the integration script accepts only the isolated fixture database name and port 33337.

Native acceptance must measure the actual running process UID/groups/capabilities and no-new-privileges flag, prove sudo/Docker and protected-file writes fail, and verify the fixed control socket works. Complete a real application deployment, inspect its event stream and health, confirm live radio connections and cached inventory without device actuation, and verify identity issuer/client/signing-key continuity. No lock, siren, switch or robot actuation is part of this audit.

GStreamer ESM coverage, the Freestone NVIDIA FFmpeg fork and Selene's held platform update remain separate findings until a supported fix or tested replacement is available. This design does not remove the SSH administrator's legitimate ability to manage the host.
