# HomeBrainv2 security and quality audit

Date: September 10, 2026  
Repository: `mefree2098/HomeBrainv2`  
Pull request: #676  
Original main: `1823f6885c912c179c7a5f4067e9aed6fe296d30`  
Verified application/test candidate: `e70d5a2f242c70878915df4f0893cbccaacf2e35`

## Executive result

The audit produced targeted security, reliability and efficiency fixes, three compatible dependency updates, and permanent regression/security gates. The final candidate passes **1,640 tests**, client lint with zero warnings, the production client build, the repository secret checks, dependency review and CodeQL's separate security-result check. CodeQL reports **no new alerts in changed code**, not that every existing alert in the repository has been eliminated.

The iOS/watchOS simulator build and configured ESP32 wall-panel firmware build also succeed. Strict TypeScript diagnostics fell from **1,016 to 1,012**, with **zero added diagnostics** after normalization of file/diagnostic text. The repository does **not** yet pass the full strict TypeScript compiler.

There is **one unresolved pre-existing dependency advisory**, affecting `adm-zip` through the remote-device ONNX runtime; npm represents that single advisory as two moderate affected-package entries. No new application dependencies or major runtime upgrades/downgrades were introduced. This is not a claim that the platform is vulnerability-free or production-tested on physical hardware.

This report records pre-merge evidence. PR #676 and its check history are the authoritative record for the subsequent merge and post-merge checks.

## Scope and method

The baseline inventory contained **923 tracked files** across the server, web client, broker, Alexa Lambda, remote-device runtime, Reachy integration, native Apple apps, firmware and operational scripts. Repository-wide inventory, security-pattern inspection and automated syntax checks covered **458 JavaScript files, 42 Python files and 15 shell scripts**, with no syntax failures. Manual investigation focused on authentication, outbound network validation, event delivery, file storage/downloads, browser API handling and CI boundaries. This was not a manual line-by-line proof of correctness for every file.

A baseline was established before application edits: the five JavaScript suites passed 1,438 tests, and client lint/build passed, while four component dependency audits reported vulnerabilities. Changes were developed on an isolated audit branch, with additional native validation on a separate branch. Temporary source/patch workbench files are absent from the final proposed tree. Production services, databases and home devices were not restarted or altered.

## Findings and implemented changes

| Area and files | Finding | Implemented change and validation |
|---|---|---|
| Outbound network validation: `server/utils/networkSafety.js`, `broker/src/outboundNetworkSafety.js` | Cloud-metadata addresses could evade string comparisons through expanded IPv6 or IPv4-mapped IPv6 aliases. Metadata hostnames and trailing-dot variants also needed consistent treatment. | Use Node's built-in `net.BlockList` for binary address matching; normalize names; deny recognized metadata targets even when public/private network opt-ins are enabled. Mixed DNS answers containing a prohibited address fail closed. Added server/broker tests for aliases and DNS results without adding a dependency. Existing TLS verification and DNS-bound connection checks remain enabled. |
| Hostname normalization in the same two modules | A trailing-dot regular expression can take quadratic time on long dotted input. CodeQL caught a new occurrence during candidate validation; it was not merged in that form. | Replace the regex and split allocation with a linear scan and one slice. Add regression tests for suffixes, internal dots, bracketed addresses, zone identifiers and long dotted values. Rerun CodeQL: no new alerts. No alert suppression was added. |
| Authentication: `server/utils/authCookies.js`, `server/routes/middlewares/auth.js` | Malformed percent-encoded cookie data could throw during parsing; invalid authentication and insufficient authorization were conflated. | Safely skip malformed unrelated cookie names; reject malformed matching cookie values; preserve explicit Bearer-token precedence. Invalid/expired credentials return 401, while permission/inactive-user denials retain 403. Added malformed-cookie and middleware regression tests. |
| Browser API: `client/src/api/api.ts`, new `responsePolicy.ts` and tests | The response transformer attempted JSON parsing on binary responses, breaking Blob downloads such as Reachy snapshots. Parser-error logging could expose raw response data. | Preserve Blob, ArrayBuffer and already-decoded values; preserve large-number JSON parsing; return generic parse errors without raw response logging. Added four response-policy tests. |
| Browser authentication retry policy | Retrying a genuine 403 permission denial caused needless refresh traffic and could unnecessarily clear an otherwise valid session. | Refresh only on 401; prevent refresh-endpoint recursion and repeated retries. Permission denials no longer trigger refresh. Corresponding server status semantics were corrected in the same change set. |
| Browser type correctness and redundant code | API code treated an Axios instance as the Axios static module; a routing wrapper always returned the same instance; existing `json-bigint` imports lacked declarations. | Correct Axios instance typing and optional URL handling; remove the redundant routing wrapper; declare the already-installed JSON parser locally, without adding a package or relaxing strict compiler settings. Strict diagnostics decrease by four with none added. |
| Device WebSocket: `server/websocket/deviceWebSocket.js` and new safety tests | Inbound message size and queued outbound data lacked explicit application bounds; errors could occur before authentication handlers were attached; stale listeners/connections could survive lifecycle transitions. | Set a 16 KiB inbound message limit and a 1 MiB queued-backlog cutoff; attach transport handlers before asynchronous authentication; re-check socket/server state afterward; clean up event listeners and heartbeat resources; handle Buffer-based ping messages. Four focused tests plus the existing server suite pass. The backlog check disconnects slow clients; it is not an arbitrary cap on one legitimate snapshot payload. |
| Event replay: `server/services/eventStreamService.js` and tests | A zero/non-finite query limit could produce unintended defaults or an unbounded database result; excessive replay limits wasted resources. | Normalize finite integer limits to 1–500; use the existing 100-event default for zero/non-finite input. Exercise latest/replay paths and boundary inputs with regression tests. |
| Download storage: `server/services/generalDownloadStorage.js` and tests | PID/timestamp temporary names could collide between simultaneous streams. A failed writer could interfere with another writer's staging file. Declared stream lengths were not enforced before publication. | Use UUID staging names and exclusive creation; remove only a staging file owned by that writer; validate expected length and actual bytes before atomic publication. Failed/truncated streams preserve the prior complete destination. Tests cover concurrent writes, invalid lengths, truncation and staging collisions. |
| Reachy downloads: `reachy-homebrain-app/src/reachy_homebrain/http_security.py` and new tests | Invalid ports or malformed URLs could escape the intended error handling; credentials, fragments and whitespace/control characters needed explicit rejection; default-port equivalence required normalization. | Validate and normalize HTTP(S) origins; reject malformed/untrusted URL components with controlled errors; preserve same-origin enforcement during redirects/final response handling. Twelve added tests; Reachy total rises from 142 to 154. |
| Duplicate routing: `server/server.js` | The same notifications router was mounted twice. | Remove the second duplicate registration, preserving the first mount and route ordering. Existing notification behavior remains covered by the passing server suite. |
| Logging: `client/src/webmcp/HomeBrainWebMCP.tsx` | A pre-existing interpolated console format call failed the newly enabled repository formatting/security check. | Use a static format string with the tool name as a separate argument. The repository check now reports zero dynamic console-format calls. |
| CI and security gates | Existing npm auditing blocked only high/critical findings, and broad application regressions were not continuously gated together. | Add five-component JavaScript tests, Python tests, repository safety tests, zero-warning client lint, production build and console-format checks. Audit all six npm roots at every severity. Use least-privilege permissions and immutable action pins for new checks. Keep the existing secret scan, dependency review and CodeQL enabled. |

## Dependency results

Only the following package versions changed; other component lockfiles were preserved:

| Component | Dependency | Before | After | Advisories addressed |
|---|---|---:|---:|---|
| Server | `hono` | 4.13.1 | 4.13.7 | GHSA-gqvv-2mrq-wpjv; GHSA-g6gw-c38x-mqfc; GHSA-crvj-82cr-hjcx |
| Broker | `qs` | 6.15.3 | 6.16.0 | GHSA-x5fp-wj9c-mxmx; GHSA-4mjr-xmp4-gh2g |
| Client toolchain | `js-yaml` | 4.3.1 | 4.3.2 | GHSA-2883-xcg3-v3hh, high severity |

The final raw npm reports show **zero advisories** for root, server, client, broker and Lambda. Remote-device still reports **two moderate package entries, zero high/critical**, caused by the same unchanged `adm-zip` advisory below. The six unique advisories listed in the table are cleared by these updates.

### Residual dependency risk — issue #677

`remote-device` uses `onnxruntime-node` 1.27.0, which depends on `adm-zip` 0.6.0. Advisory **GHSA-vwc7-r8mq-g2x9** concerns archive extraction through pre-existing destination-directory symlinks. Deployment exploitability was not established. The npm registry still reported 0.6.0 as the latest `adm-zip` release during this audit; no confirmed patched release was available. npm's suggested remediation involved a major ONNX downgrade, which was not applied without inference compatibility testing.

The new all-severity gate visibly records **only this existing moderate advisory chain in remote-device**, and expires at **2026-10-10T00:00:00Z**. New advisories, higher severity, other projects, malformed reports and expired exceptions fail the gate. This strengthens the previous high/critical-only gate; it does not remove or conceal the outstanding advisory. The gate will fail after expiry until this is resolved or deliberately re-reviewed.

Issue #677 records remediation and supported-device inference acceptance criteria. Do not run `npm audit fix --force` as an untested substitute for that work.

## Verification evidence

Final application/test candidate: `e70d5a2f242c70878915df4f0893cbccaacf2e35`.

| Check | Verified result |
|---|---|
| Server JavaScript tests | 1,360 passed; zero failures/skips |
| Broker JavaScript tests | 38 passed; zero failures/skips |
| Alexa Lambda tests | 12 passed; zero failures/skips |
| Remote-device JavaScript tests | 45 passed; zero failures/skips |
| Client Vitest tests | 13 passed |
| Repository security/hostname policy tests | 7 passed; zero failures/skips |
| Reachy Python tests | 154 passed |
| Remote-device audio-feature tests | 5 passed |
| iOS archive-validation script tests | 6 passed |
| Total | **1,640 passed** |
| Client ESLint | Passed with `--max-warnings=0` |
| Console-format check | Passed: zero dynamic format calls |
| Client production build | Passed |
| npm dependency audit policy | Passed, with the explicit residual exception above |
| Dependency review and secret scan | Passed |
| CodeQL security-result check | Passed: no new alerts; zero annotations |
| iOS/watchOS simulator build | Passed, unsigned Debug build |
| Configured ESP32 wall-panel firmware | Passed; no compiler warnings observed |
| Strict TypeScript comparison | 1,016 baseline → 1,012 candidate; zero new diagnostics |

Evidence references: baseline run `34483419975`; final regression run `34489197987`; final dependency audit run `34489198054`; dependency review `34489198035`; secret scan `34489197979`; CodeQL workflow `34489198051` and separate security check `102912076205`; native/TypeScript validation run `34487749605`; retained log-evidence run `34489507967`. Native/TypeScript validation used `af6660a2d2c79be64ddfdc7869d8160a0ec79609`; subsequent application changes affected only server/broker normalization and its tests, not the native/client sources tested there.

### Warning accounting

No npm installation/deprecation warnings, client lint warnings, client production-build warnings or Python test warnings were found in the final regression logs. Server negative-path tests intentionally emit existing SmartThings warning-level messages. The unchanged native targets emit two Xcode AppIntents messages: metadata extraction is skipped because the relevant framework is not linked. The build succeeds, but this report does not describe native build output as warning-free. An initial temporary artifact-upload action emitted runtime-deprecation notices; it was replaced in the validation helpers, and is not part of the permanent regression workflow.

## Remaining work and verification limits

**Strict TypeScript debt, issue #678:** The remaining 1,012 diagnostics are real pre-existing debt. Vite transpilation and configured ESLint checks are not substitutes for strict compilation. Fix typed API boundaries and component contracts incrementally; do not hide the debt with global suppressions. Several very large service/UI/native source files also merit tested extraction rather than risky bulk rewrites during a security patch.

**Storage and streaming follow-up:** This patch fixes ordinary stream staging ownership/integrity, not every resumable-upload race or hostile-local-filesystem scenario. Concurrent resumable offset updates, symlink-resistant containment when local writers are untrusted, and SSE slow-client backpressure merit focused integration/load testing. These are review follow-ups, not claims of a proven remotely exploitable vulnerability in the deployed system.

**Hardware and deployment:** Tests used isolated runners and mocked robot/media objects. Physical Insteon devices, microphones, robot movement, wake-word inference on device architectures, signed/App Store native builds and end-to-end production deployments were not exercised. Python hardware SDK and operating-system supply chains did not receive a complete dependency audit. No production credentials or live home-control actions were used. A successful GitHub merge must not be confused with a verified rollout to home hardware.

## Reproduction and publication

The permanent workflows rerun the documented JavaScript/Python/security checks on pull requests and pushes to main. Native validation is separate and its build commands/results are retained in the validation branch and run artifacts. Hosted workflow artifacts have limited retention; this report preserves their run identifiers and summarized results.

Publication should use PR #676 with an expected head SHA after all checks succeed, without force-pushing main or bypassing branch protection. The PR conversation records the final merge SHA and post-merge verification. No database migration or production restart is required by this source change set.
