# HomeBrain security audit and October 2026 security release

Audit date: October 24, 2026. Application baseline: `e0ccd442b3d570f3a149f7675eae84bb714ff11e` on `main`.

The application update addresses 20 distinct npm advisories and the open CodeQL sensor authorization alert. All six npm projects pass the existing all-severity audit gate, without advisory exceptions. Production verification is recorded separately below because installing dependencies and restarting a live service are separate checks.

## Current advisories and applicability

The [October 21 Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) fixes Brotli memory corruption, DNS validation, TLS hostname verification and HTTP connection reuse issues. HomeBrain performs outbound HTTPS requests and accepts compressed HTTP requests, so its runtime must be patched along with its npm dependencies. Every npm manifest and the Node launcher now require a supported security baseline: **22.23.4, 24.22.1 or 26.12.1**, or a newer patch/minor on the same track. The Linux installer rejects Node 20 and checks installed runtimes against the same policy. Deployment status exposes the running Node and OpenSSL versions. CI pins Node 22.23.4 explicitly so an older hosted-runner cache cannot select a vulnerable patch.

[PHP2Shell, CVE-2026-109618 and CVE-2026-109619](https://www.php.net/archive/2026.php#2026-10-21-5), requires PHP 8.2.35, 8.3.36, 8.4.27 or 8.5.12 on the corresponding maintained branch. HomeBrain contains no PHP application or Composer dependency. Neither configured host has installed PHP packages. The October 23 PHP follow-up also identifies CVE-2026-115560 in an unusual session upload-progress configuration; it does not introduce a PHP dependency into HomeBrain. This repository assessment does not certify independent sites or appliances.

The [Ubuntu CA trust-store update, USN-8944-1](https://ubuntu.com/security/notices/USN-8944-1), removes the root affected by the eMudhra intermediate CA compromise. Ubuntu 22.04 requires `ca-certificates` **20260816ubuntu0.22.04.1**. Node's security releases also update their bundled CA trust. Python environments that use certifi require its updated bundle independently of the OS trust store.

## Dependency and application changes

| Dependency or boundary | Previous state | Updated state |
| --- | --- | --- |
| `body-parser`, server and broker | 2.3.0; compressed requests could crash the process | 2.4.0 |
| `follow-redirects`, server, client, broker and Lambda | 1.16.0; cross-origin credential stripping bypasses | 1.16.1 |
| `fast-uri`, server | 3.1.8; URI normalization and host/scheme confusion | 3.1.9 |
| `hono`, server | 4.13.7; static-path middleware bypass | 4.13.13 |
| `ip-address`, server and broker | 10.7.2; quadratic IPv6 zone parsing | 10.7.4 |
| `zod`, server | 4.6.5; validation memory exhaustion | 4.6.7 |
| Client's unused direct `zod` dependency | 3.25.76 | Removed; remaining peer resolution uses 4.6.7 |
| `postcss-selector-parser`, client | 6.1.4; quadratic selector parsing | Override to 7.1.7, verified with Tailwind 3 and the production build |
| Vite and Vitest | 8.3.0 and 4.1.11; editor, file access and mock registration advisories | 8.3.5 and 4.1.12 |
| Sensor authorization, CodeQL alert 826 | Overlapping whitespace/token regex could backtrack quadratically | Bound header length before matching; disjoint token parsing; malformed credential tests |
| Public information pages | Absolute paths failed when an ancestor directory was hidden | Serve fixed filenames relative to the explicit public information root |

### Temporary node-forge source pin

No patched node-forge npm release was available on the audit date. Its [RSA signature advisory, CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv), affects 1.4.0 and earlier. npm's proposed ACME downgrade does not establish a safe replacement.

Both the direct dependency and ACME's transitive dependency instead use the immutable [upstream PR 1152 commit `ceba34402e329f0365134f23fe19898756527d65`](https://github.com/digitalbazaar/forge/pull/1152). The lockfile records the source archive's integrity. Compared with 1.4.0, the source changes are the nested DigestAlgorithm element-count check, its upstream regression test, changelog and development version. This is an unmerged upstream fix, not a released npm security version. Replace the pin after a maintained release includes the fix and passes the same verification.

The new regression test constructs a malformed, RSA-signed DigestInfo with an extra nested element and confirms rejection, while a normal signature still verifies. A separate HTTP regression test submits a compressed request with trailing bytes and verifies the server remains responsive. These checks supplement the registry scanner, which cannot prove a custom source patch is correct.

npm 12 blocks remote archives and dependency install scripts by default. The server's project configuration permits only URL dependencies explicitly declared in its own manifest, including the immutable forge fix. Required native dependency scripts are approved by exact package version in each affected manifest. These approvals preserve npm's default restrictions for other dependencies. Clean npm 12 installs and native module loading are checked before production restart.

## Verification

Local checks use the official Node 22.23.4 distribution with its published SHA-256 verified.

- JavaScript: **1,664 tests passed** across server, broker, Lambda, remote device and client.
- Python: **154 Reachy tests, 5 remote audio tests and 9 appliance tests passed**.
- Client lint passes with zero warnings; production build and console-format checks pass.
- All six npm projects report zero advisories at every severity. Trivy's supplemental production dependency scan reports none.
- Python application/test environment audit passes after updating pip to 26.2.2. The complete Reachy SDK dependency resolution (83 packages, including its pinned SDK) also reports zero advisories.
- Gitleaks scanned **1,275 commits** and found no leaks. GitHub secret-scanning alerts are empty.
- Repository safety tests, archive-validation tests and configured sensor hardware artifact checks pass. The motherboard verifier retains its existing manufacturing HOLD; digital artifact checks do not certify physical hardware.

## Python runtime security

The live appliance environment contained vulnerable aiohttp, multidict, certifi, pip and setuptools. The declared appliance requirements now enforce their patched versions. Reachy companion release 0.1.2 similarly requires aiohttp 3.14.5 and the updated certifi bundle. Its dependency and stable-launcher fingerprints are regenerated; existing launchers with different fingerprints still require the normal stopped reinstall.

The live wake-word environment contained 14 packages with security findings, including its CPU Torch 2.10.0 build. The managed installer now uses an explicit runtime requirements file and the patched CPU Torch 2.14.1 build. HomeBrain uses its own DNN trainer; unused upstream training extras pinned an older torchaudio stack and brought in unrelated image parsers. A separately staged Python 3.11 environment permits the patched filelock version without altering the system Python. ONNX export explicitly retains the existing opset 13 exporter behavior. The offline acceptance test exercises a training step, export/prediction agreement, real audio features and cached Piper synthesis without playing audio.

Python CI now uses an isolated environment and audits the resolved test/appliance dependencies. The existing JavaScript audit continues to fail on every advisory severity.

## Database and host lifecycle findings

Freestone runs MongoDB 6.0.26, which is affected by Mongobleed, CVE-2025-14847; the configured vendor repository offers patch 6.0.29. Selene already runs 6.0.29. A private database backup precedes the Freestone patch, with no feature-compatibility-version or data-format migration. MongoDB 6.0 reached [end of life on July 31, 2025](https://www.mongodb.com/legal/support-policy/lifecycles); applying the available security backport does not put the deployment on a supported major release. A backed-up, separately tested major-version migration remains required.

The reported NVIDIA BSP versions are R36.4.4 on Freestone and R36.4.7 on Selene. Both precede the R36.5 fix listed in the [NVIDIA March 2026 Jetson security bulletin](https://nvidia.custhelp.com/app/answers/detail/a_id/5797). That platform update requires the supported NVIDIA OTA/recovery procedure and a coordinated host reboot; the ordinary Ubuntu application/package update does not replace it. The shared-host audit owns that separate maintenance investigation.

Both hosts also retain Ubuntu's GStreamer Bad Plugins 1.20.3-0ubuntu1.1. The [H.265 parser fix, USN-7558-1](https://ubuntu.com/security/notices/USN-7558-1), requires the Ubuntu Pro ESM Apps build `1.20.3-0ubuntu1.1+esm2`; the [September WAV parser fix, USN-8855-1](https://ubuntu.com/security/notices/USN-8855-1), requires `+esm3`. Neither host has an attached Pro entitlement, and their enabled repositories do not supply those fixes. This remains a host media-parser exposure requiring ESM coverage or a tested removal/replacement of the affected codec stack. The OS scanner's kernel findings against `linux-libc-dev` headers are not evidence that each CVE applies to the running NVIDIA kernel; the BSP bulletin is assessed separately.

## Production verification

Production acceptance requires Freestone and Selene to each report the released commit loaded by the running backend, the patched Node version, and healthy database, proxy, MQTT and WebSocket checks. Device inventory checks use cached reads without device actuation.

## Boundaries and follow-up

This audit covers HomeBrain source and its dependency manifests, authentication and request boundaries, current GitHub security findings, repository secrets and the configured HomeBrain production hosts. Independent applications sharing those hosts and firmware on unrelated physical devices need their own releases. Strict TypeScript compilation reports 1,020 diagnostics versus 1,028 on the original main with its original locked dependencies; normalized comparison finds zero added diagnostics. This existing debt is tracked separately from the passing Vite build and ESLint checks. Robot movement, alarms, locks and other consequential home controls are not exercised by these checks.
