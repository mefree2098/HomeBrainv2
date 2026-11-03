# HomeBrain dependency audit — November 3, 2026

Baseline: `5f32e718a21bb7d11a263cb492c1e6ae46187360`.

## Result and release gate

The candidate removes 27 of 28 unique known advisories from the Android photo-frame build tooling. **One high advisory remains; this candidate must not merge or deploy under the daily audit's zero-vulnerability gate.** The healthy HomeBrain runtime is unaffected by these build-only changes. No Android APK was published or installed on a device.

All six npm lockfile projects pass `npm audit --json` with production, development, optional and peer dependencies included. GitHub's paginated open Dependabot alert query is empty. Python 3.11 isolated pip resolution and pip-audit pass for both server requirements files and the Reachy project's runtime, wakeword, test and build groups: 21, 32 and 96 resolved package entries respectively, with no skipped packages. Local vendored npm manifests are represented by the server lockfile or declare no dependencies.

Android discovery additionally covers both Gradle build files and the wrapper properties: the app declares no third-party runtime dependencies. A temporary Gradle project resolves the AGP build graph; the final candidate's actual root and app buildscript graphs are also resolved. OSV Maven batch queries scan those coordinates plus Maven metadata in the exact wrapper distribution. Baseline findings: 28 unique advisories (2 critical, 13 high, 13 moderate); advisory/CVE aliases and repeated package versions are not counted twice.

## Candidate changes

- Gradle 9.5.0 → 9.8.2, with the official distribution SHA-256 pinned. Patch-only 9.5.1 retained the vulnerable bundled Jackson and jsoup versions; 9.8.2 removes those findings.
- Android Gradle Plugin 9.3.0 → 9.3.3, preserving its minor release line.
- Buildscript constraints select Guava 33.7.2-jre, Commons Lang 3.18.0, jose4j 0.9.6, Bouncy Castle provider/PKIX/util 1.85, JDOM 2.0.6.1 and Kotlin Gradle Plugin 2.4.20. These affect AGP's graph, with no advisory ignores or force-upgrade flags.

## Upstream blocker

Gradle's latest stable release, 9.8.2, still bundles `lib/guava-33.4.6-jre.jar`. OSV reports **GHSA-xxph-c9ww-hj94 / CVE-2026-102554 (high)**, fixed in Guava 33.7.2. The separate AGP classpath resolves patched Guava, but project buildscript constraints do not replace Gradle's own bootstrap libraries. No custom Gradle archive, bootstrap JAR replacement, nightly distribution or advisory suppression is used. A maintained Gradle distribution carrying patched Guava, followed by complete rescanning and build validation, is needed before merge.

## Validation

- Android debug APK build and lint pass with the normal configuration cache enabled; `testDebugUnitTest` has no test sources.
- Native Java OTA trust checks pass (pinned hub, signatures, package/version, size and downgrade rejection).
- All 31 photo-frame server/player/security tests pass under verified Node 22.23.4.
- The isolated audit task initially conflicted with Gradle configuration-cache serialization; the standard build was rerun without that audit-only init script and passed. This does not require a product configuration change.
- Full post-change npm, Python, Dependabot and Android scans retain the single upstream Gradle/Guava finding. No production deploy is authorized by a partial scan result.

## Baseline advisories

Each row is one unique advisory; CVE/BIT aliases are identifiers for that same finding.

| Advisory | Severity | Aliases | Summary |
| --- | --- | --- | --- |
| [GHSA-2363-cqg2-863c](https://github.com/advisories/GHSA-2363-cqg2-863c) | high | BIT-solr-2021-33813, CVE-2021-33813 | XML External Entity (XXE) Injection in JDOM |
| [GHSA-3677-xxcr-wjqv](https://github.com/advisories/GHSA-3677-xxcr-wjqv) | high | CVE-2024-29371 | jose4j is vulnerable to DoS via compressed JWE content |
| [GHSA-3pjw-73gf-8qr5](https://github.com/advisories/GHSA-3pjw-73gf-8qr5) | moderate | CVE-2026-59888 | jackson-databind: @JsonIgnore on a Record property is bypassed with a PropertyNamingStrategy |
| [GHSA-574f-3g2m-x479](https://github.com/advisories/GHSA-574f-3g2m-x479) | critical | CVE-2025-14813 | Bouncy Castle for Java GOST 28147 CTR mode reuses keystream after 255 blocks |
| [GHSA-5gvw-p9qm-jgwh](https://github.com/advisories/GHSA-5gvw-p9qm-jgwh) | moderate | CVE-2026-59889 | jackson-databind: @JsonView bypassed for @JsonUnwrapped container properties on deserialization |
| [GHSA-5jmj-h7xm-6q6v](https://github.com/advisories/GHSA-5jmj-h7xm-6q6v) | moderate | CVE-2026-54515 | jackson-databind has case-insensitive deserialization bypasses per-property @JsonIgnoreProperties |
| [GHSA-65r4-943x-97jj](https://github.com/advisories/GHSA-65r4-943x-97jj) | high | CVE-2026-75140 | jsoup XmlTreeBuilder vulnerable to memory exhaustion through deeply nested namespace declarations |
| [GHSA-7hhh-6rmp-j9qf](https://github.com/advisories/GHSA-7hhh-6rmp-j9qf) | high | CVE-2026-89425 | jackson-core: UTF8DataInputJsonParser._reportInvalidToken() missing maxErrorTokenLength limit -> unbounded StringBuilder growth (DoS) |
| [GHSA-9pwp-9qqc-pr26](https://github.com/advisories/GHSA-9pwp-9qqc-pr26) | critical | CVE-2026-8763 | Bouncy Castle: Name Constraints bypass via trailing dot in rfc822Name and URI |
| [GHSA-c3fc-8qff-9hwx](https://github.com/advisories/GHSA-c3fc-8qff-9hwx) | moderate | CVE-2026-0636 | Bouncy Castle has an LDAP injection |
| [GHSA-cxp5-3px4-pw24](https://github.com/advisories/GHSA-cxp5-3px4-pw24) | high | CVE-2026-91777 | jackson-databind quadratic forward-reference completion  |
| [GHSA-gx83-3vf8-gh7j](https://github.com/advisories/GHSA-gx83-3vf8-gh7j) | moderate | CVE-2026-83557 | jackson-databind: Comparable missing from DefaultBaseTypeLimitingValidator's unsafe base types (incomplete PolymorphicTypeValidator denylist) |
| [GHSA-hgj6-7826-r7m5](https://github.com/advisories/GHSA-hgj6-7826-r7m5) | moderate | CVE-2026-54514 | jackson-databind: InetSocketAddress deserialization triggers eager DNS resolution (SSRF) |
| [GHSA-j288-q9x7-2f5v](https://github.com/advisories/GHSA-j288-q9x7-2f5v) | moderate | CVE-2025-48924 | Apache Commons Lang is vulnerable to Uncontrolled Recursion when processing long inputs |
| [GHSA-j3rv-43j4-c7qm](https://github.com/advisories/GHSA-j3rv-43j4-c7qm) | high | CVE-2026-54512 | jackson-databind has a PolymorphicTypeValidator bypass via generic type parameters that allows arbitrary class instantiation |
| [GHSA-mhm7-754m-9p8w](https://github.com/advisories/GHSA-mhm7-754m-9p8w) | moderate |  | jackson-databind: `@JsonView` bypass for creator properties with `@JsonTypeInfo(include=As.EXTERNAL_PROPERTY)` |
| [GHSA-p6pp-m3f8-5c89](https://github.com/advisories/GHSA-p6pp-m3f8-5c89) | high | CVE-2026-89407 |  jackson-core: ReDoS: quadratic backtracking in NumberInput.PATTERN_FLOAT via looksLikeValidNumber() |
| [GHSA-pmhh-3w7g-xqp8](https://github.com/advisories/GHSA-pmhh-3w7g-xqp8) | moderate | CVE-2026-71497 | jsoup: Cleaner may expose markup with custom raw-text elements |
| [GHSA-q4xh-88c3-wmh7](https://github.com/advisories/GHSA-q4xh-88c3-wmh7) | high | CVE-2026-68497 | jackson-databind: Duration XMLGregorianCalendar Unbounded Number Parse DoS |
| [GHSA-qp49-qgx5-5m26](https://github.com/advisories/GHSA-qp49-qgx5-5m26) | high | CVE-2026-13506 | Bouncy Castle: Lazy ASN.1 sequence forcing resets nesting-depth guard |
| [GHSA-r7wm-3cxj-wff9](https://github.com/advisories/GHSA-r7wm-3cxj-wff9) | high | CVE-2026-68494 | jackson-core: Async parser maxNumberLength bypass via chunked digit accumulation (incomplete fix for GHSA-72hv-8253-57qq) |
| [GHSA-r937-wjx7-w2jp](https://github.com/advisories/GHSA-r937-wjx7-w2jp) | moderate | CVE-2026-53914 | JetBrains Kotlin: Unsafe Deserialization in Kotlin Build Cache Enables Code Execution |
| [GHSA-rmj7-2vxq-3g9f](https://github.com/advisories/GHSA-rmj7-2vxq-3g9f) | high | CVE-2026-54513 | jackson-databind has an array subtype allowlist bypass in BasicPolymorphicTypeValidator (allowIfSubTypeIsArray) |
| [GHSA-vvgp-rfg2-7rr6](https://github.com/advisories/GHSA-vvgp-rfg2-7rr6) | moderate | CVE-2026-77310 | jackson-databind: Incomplete fix for CVE-2026-54514: eager DNS resolution (SSRF) still present in InetAddress deserialization |
| [GHSA-wg6q-6289-32hp](https://github.com/advisories/GHSA-wg6q-6289-32hp) | moderate | CVE-2026-5588 | Bouncy Castle Crypto Package For Java: Use of a Broken or Risky Cryptographic Algorithm vulnerability in bcpkix modules |
| [GHSA-wjgm-6hv5-3cvf](https://github.com/advisories/GHSA-wjgm-6hv5-3cvf) | moderate | CVE-2026-19032 | jackson-databind: Path Deserialization Missing Scheme Allowlist for FileSystemProvider Resolution |
| [GHSA-wv8q-qhhj-9h54](https://github.com/advisories/GHSA-wv8q-qhhj-9h54) | high | CVE-2026-91776 | jackson-databind retains every unknown raw type ID  |
| [GHSA-xxph-c9ww-hj94](https://github.com/advisories/GHSA-xxph-c9ww-hj94) | high | CVE-2026-102554 | Google Guava: CompactHashMap/CompactHashSet/MapMakerInternalMap deserialization triggers uncontrolled memory allocation |
