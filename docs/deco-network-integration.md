# Deco connected devices and AC DHCP recovery

HomeBrain can read a TP-Link Deco's local client list and use current addresses to discover already-paired Midea / Cooper & Hunter ACs. Configure it under **Settings → Integrations → Deco Network** (`/settings?tab=deco`).

For Freestone, the router is a BE63 running firmware 1.3.5 at the fixed router address `192.168.1.1`. The AC continues to use DHCP. Enter the network owner password accepted by the Deco local web management page and select **Save and Connect**. No password belongs in chat, source control, or a command-line argument.

## Behavior

- HomeBrain reads clients once per minute while enabled. Only login, client-list reads and mesh metadata reads are implemented; there are no router configuration, blocking, reservation or reboot operations.
- The admin-only screen shows the router's IP/MAC inventory, mesh firmware, last successful read and separate paired-AC network and appliance response status. Unknown online flags stay unknown. Failed or old reads retain the inventory with a stale warning, never a current-connected claim.
- Passwords are AES-GCM encrypted. The encryption key is stored separately from the database at `server/data/deco/credentials.key`, with private directory/file permissions. Disaster-recovery backups include `server/data`; restore the key with the database. Responses and logs do not include passwords, session tokens or raw router responses.
- Transport failures wait 15 minutes before retrying. Rejected/locked logins and malformed protocol responses stop automatic attempts, including after a service restart, until a configuration change or explicit manual refresh. Sanitized diagnostics distinguish protocol failures, router rejection codes and lockout without exposing response bodies or credentials. Router reads have fixed destinations, no redirects and bounded time/response sizes. AC commands use the cached inventory; they do not wait for the router to log in.
- Mesh client-list aggregation has a 30-second deadline; login/key and optional metadata requests retain their eight-second deadline. A transport failure during an authenticated inventory read preserves the session for the next retry, while the cached inventory becomes stale. Freestone verification confirmed successful saved-password login followed by a client-list timeout at the original eight-second deadline.
- Midea first validates its cached DHCP hint and tries its normal LAN discovery. If that fails, it probes at most 32 current private LAN candidates from a fresh Deco inventory, eight at a time. Candidate batches rotate across polls so large networks are covered. A previously confirmed Wi-Fi MAC is prioritized.
- **Every candidate must return the paired immutable Midea ID before HomeBrain authenticates or controls it.** Router names, vendor names, MACs and IPs alone do not establish appliance identity. Successful identity-verified AC reads can associate that address with the matching Deco MAC. A Deco-connected client may still have an unresponsive AC control service.
- Disable the integration in its setup card to stop polling and discard its active session and cached public inventory. The saved encrypted password is retained for re-enabling.

## Compatibility and validation

The LAN protocol follows the MIT-licensed [jvreagan/deco implementation](https://github.com/jvreagan/deco/tree/c81af352e8559b740f91a2f2b86c2b558fa0b899), which reports BE63 testing. Attribution is retained in `docs/licenses/deco-MIT.txt`. This is an internal firmware API; future Deco releases can change it.

The Deco wire protocol requires a legacy MD5 digest of the owner password inside an RSA-encrypted request signature and supplies a 512-bit signature key. These firmware requirements cannot be replaced with modern algorithms by a client alone. The two CodeQL digest findings have a line-scoped protocol-compatibility exception at that exact computation, with the handshake checked by a behavioral test. The digest is never stored, returned, logged or used as a HomeBrain password verifier; stored credentials use AES-256-GCM. The rest of CodeQL scanning remains enabled. Use this owner-authenticated interface only on the trusted home LAN.

The actual Freestone router answered the expected unauthenticated RSA/AES handshake during implementation. Authenticated client-list access and TheaterAC recovery require entering the owner password through the deployed setup screen and then checking the live result. A supported handshake alone is not a claim of full firmware compatibility.

The BE63 firmware's own web assets were inspected on November 11 after a saved-credential login failed. They specify a JSON content type even for the URL-encoded encrypted envelope, JSON read bodies for the public key requests, and 16 decimal digits for each AES key/IV. The client now follows those details instead of the older reference client's form content type and hexadecimal key strings. Requests are spaced at least 100 ms apart. A decode failure is classified as protocol incompatibility, not as proof of a wrong password. Plaintext router errors are checked before decryption, and only explicit numeric rejection/lockout codes receive those classifications.

Evidence hashes (SHA-256) of public assets fetched from `http://192.168.1.1/webpages/`:

- `js/libs/tpEncrypt.js`: `fa22f47c2b371af4fa09a5c305a5a74d08159984af6c1f8cb4b2207a587d45ce`
- `js/su/frame.js`: `253bc9e5ec6d18d13ac3bb4ac8ac0963a3bf4803caf836e7e2ff98c5d611dabe`
- `modules/login/localLogin/controllers.js`: `c27edcdeb8d008dc7e50ab07652684930cfc3d27fbafa3127c07c799907eb6ed`
- `modules/login/localLogin/models.js`: `1c6fc5fe6aecf90b0c794b4ea2d3cfcee923ecd5ebe83b904b648b13b5a2ab12`

Regression coverage includes the encrypted 512-bit signature handshake, session cookie reuse, request sequence signatures, read-only endpoints, private-address validation, credential omission, login backoff, stale inventory, bounded rotating DHCP candidates, admin/sandbox access, and a different appliance at a previously used address. Python recovery tests cover broadcast failure, identity checks, retained pairing credentials and no physical actuation during discovery.
