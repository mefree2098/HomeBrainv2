# Deco connected devices and AC DHCP recovery

HomeBrain can read a TP-Link Deco's local client list and use current addresses to discover already-paired Midea / Cooper & Hunter ACs. Configure it under **Settings → Integrations → Deco Network** (`/settings?tab=deco`).

For Freestone, the router is a BE63 running firmware 1.3.5 at the fixed router address `192.168.1.1`. The AC continues to use DHCP. Enter the network owner password accepted by the Deco local web management page and select **Save and Connect**. No password belongs in chat, source control, or a command-line argument.

## Behavior

- HomeBrain reads clients once per minute while enabled. Only login, client-list reads and mesh metadata reads are implemented; there are no router configuration, blocking, reservation or reboot operations.
- The admin-only screen shows the router's IP/MAC inventory, mesh firmware, last successful read and separate paired-AC network and appliance response status. Unknown online flags stay unknown. Failed or old reads retain the inventory with a stale warning, never a current-connected claim.
- Passwords are AES-GCM encrypted. The encryption key is stored separately from the database at `server/data/deco/credentials.key`, with private directory/file permissions. Disaster-recovery backups include `server/data`; restore the key with the database. Responses and logs do not include passwords, session tokens or raw router responses.
- An automatic login failure waits 15 minutes before retrying. A corrected password or explicit manual refresh can retry sooner. Router reads have fixed destinations, no redirects and bounded time/response sizes. AC commands use the cached inventory; they do not wait for the router to log in.
- Midea first validates its cached DHCP hint and tries its normal LAN discovery. If that fails, it probes at most 32 current private LAN candidates from a fresh Deco inventory, eight at a time. Candidate batches rotate across polls so large networks are covered. A previously confirmed Wi-Fi MAC is prioritized.
- **Every candidate must return the paired immutable Midea ID before HomeBrain authenticates or controls it.** Router names, vendor names, MACs and IPs alone do not establish appliance identity. Successful identity-verified AC reads can associate that address with the matching Deco MAC. A Deco-connected client may still have an unresponsive AC control service.
- Disable the integration in its setup card to stop polling and discard its active session and cached public inventory. The saved encrypted password is retained for re-enabling.

## Compatibility and validation

The LAN protocol follows the MIT-licensed [jvreagan/deco implementation](https://github.com/jvreagan/deco/tree/c81af352e8559b740f91a2f2b86c2b558fa0b899), which reports BE63 testing. Attribution is retained in `docs/licenses/deco-MIT.txt`. This is an internal firmware API; future Deco releases can change it.

The Deco wire protocol requires a legacy MD5 digest of the owner password inside an RSA-encrypted request signature and supplies a 512-bit signature key. These firmware requirements cannot be replaced with modern algorithms by a client alone. The two CodeQL digest findings have a line-scoped protocol-compatibility exception at that exact computation, with the handshake checked by a behavioral test. The digest is never stored, returned, logged or used as a HomeBrain password verifier; stored credentials use AES-256-GCM. The rest of CodeQL scanning remains enabled. Use this owner-authenticated interface only on the trusted home LAN.

The actual Freestone router answered the expected unauthenticated RSA/AES handshake during implementation. Authenticated client-list access and TheaterAC recovery require entering the owner password through the deployed setup screen and then checking the live result. A supported handshake alone is not a claim of full firmware compatibility.

Regression coverage includes the encrypted 512-bit signature handshake, session cookie reuse, request sequence signatures, read-only endpoints, private-address validation, credential omission, login backoff, stale inventory, bounded rotating DHCP candidates, admin/sandbox access, and a different appliance at a previously used address. Python recovery tests cover broadcast failure, identity checks, retained pairing credentials and no physical actuation during discovery.
