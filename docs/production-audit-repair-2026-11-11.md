# Freestone production audit repair — November 11, 2026

Verified production at https://freestonefamily.com using the `homebrain-live` skill with explicit target `freestone`. Initial runtime and repository both matched `9deb6e73`; the production checkout was clean. Existing edits in the operator workspace were preserved by working from an isolated checkout of current main.

## Confirmed defects and repairs

- Operational health queried automation history by nonexistent `executedAt`. It now counts failed and partial executions by `completedAt`, including long-running work that finished in the last 24 hours. Production history showed TheaterAC and the interior-light shutdown failed while health reported zero failures.
- Upstairs Motion Sensor reported IAS zone ID 255 (unassigned). Enrollment recovery echoed that reserved value, received transport success, and remained unenrolled. Recovery now assigns a valid zone ID and still requires live enrollment confirmation.
- Z-Wave live refresh omitted Sound Switch playback. It now reads the siren's tone ID without sounding it, recognizes stopped/playing state, and retains the stale warning if the read fails. Sound Switch and Basic playback reports also normalize the displayed state correctly.
- Server dependencies now use patched Mongoose and the published `node-forge` 1.4.3 release instead of the old source archive, so ordinary registry audits cover Forge again.
- Android builds use checksum-pinned Gradle 9.9.1 and Android Gradle Plugin 9.5.1, with targeted patched plugin dependencies. Wrapper files were regenerated using the verified distribution.

## Security evidence and limits

All six tracked npm lockfiles were scanned with production and development dependencies at every severity: zero findings after the changes. The resolved Android plugin graph contained 108 Maven artifacts and returned zero OSV advisory matches after the dependency constraints. Gradle distribution metadata identified 134 registry components; its updated Bouncy Castle libraries are outside the critical advisory's affected range.

**One upstream Gradle distribution advisory remains:** `GHSA-xxph-c9ww-hj94` against bundled Guava 33.4.6-jre. Gradle 9.9.1 is the current official stable distribution and still ships this version. Project classpath constraints do not replace Gradle's own library. The advisory concerns native Java deserialization and memory exhaustion; its presence does not establish exploitation in HomeBrain. Android tooling is used for builds and is not a server runtime dependency. No blanket security-clean claim is made. Full PlatformIO toolchain/library vulnerability coverage remains incomplete; installed package inventories alone are not a complete security scan.

Sources: [Guava advisory](https://github.com/advisories/GHSA-xxph-c9ww-hj94), [Bouncy Castle advisory](https://github.com/advisories/GHSA-9pwp-9qqc-pr26), [Mongoose advisory](https://github.com/advisories/GHSA-8332-j7wj-wjw4).

## Live connectivity findings

TheaterAC's enabled 1 AM America/Denver workflow targets the correct device, explicitly sends OFF without trusting cached OFF, and retries four times. Its last confirmed appliance reading was October 6. The saved address `192.168.2.63` did not answer LAN discovery; its last observed address `192.168.2.70` answered ping but refused TCP 6444 and did not respond to discovery. Independent discovery from the production host also found no Midea device. No temperature, power, alarm or siren actuation was performed during diagnosis. Appliance Wi-Fi/power recovery is needed before the scheduled action can be confirmed.

The Insteon PLM was connected, its queue was empty, and other devices returned live replies. Thirteen devices failed last night's interior-light shutdown after PLM acknowledgement; that acknowledgement confirms dispatch, not a reply from the target. Unreachable devices were not deleted, hidden or marked healthy. Twenty-one offline devices were initially reported across Insteon, Zigbee, the AC and one sensor node.

The audit wrapper is maintained separately in the `mefree2098/codex` repository. Its repair requires a structured outcome in addition to the agent process exit status, fails incomplete security audits, and runs in an isolated checkout so operator edits do not prevent remediation. Its tests use local mail stubs. The scheduler installation must receive that separate repository update.

## Validation

- Server suite: 1,582 tests; 1,580 passed in the initial run. The two Node-launcher failures were caused by the workstation's older Node patch; all three launcher tests then passed under supported Node 22.23.4.
- Focused health, enrollment and siren regressions passed, including failed/absent live reads and read-only siren playback queries.
- Android debug APK build and lint passed with the final patched plugin graph.
- Console-format check passed; all six npm audits reported zero vulnerabilities.
- Production deployment and its server suite provide a second check on the production Node runtime. Live results are reported with the release rather than inferred from local tests.
