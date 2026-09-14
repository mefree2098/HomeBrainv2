# Preserved work integrated on September 14, 2026

This release brings the relevant preserved sensor, hardware and tutorial work onto main. The earlier Apple Home, Siri, DNS and security branches were already integrated through PRs 652, 653, 676, 679, 680 and 682; their duplicate commits and one-time publication/evidence workflows are not replayed.

## Included work

- Custom Sensor Fleet administration, provisioning, authenticated readings, node watchdog, and telemetry integration.
- Shared ESP32-C6 firmware for Atmosphere Air Station, Presence Pod and Climate Pod, plus the USB bench diagnostic.
- Motherboard and enclosure sources, reference documents, generated design artifacts and verification tools. Enclosures were regenerated from the current board definitions. **Manufacturing and physical-fit holds remain in force**; see [the engineering review](../hardware/homebrain-sensors/motherboards/PREORDER-REVIEW.md). Deprecated carrier files retain their deprecated labels.
- Security Basics and Weather System tutorial exports, captions and editable sources. See [the tutorial index](videos/README.md). These recordings show the earlier UI.

## Integration corrections

- Consume sensor setup codes atomically so concurrent activation cannot issue multiple tokens.
- Enforce account, administration, read-only and review-sandbox boundaries. Require device credentials for readings/configuration; do not expose internal database errors.
- Verify HTTPS certificates and hostnames in sensor firmware, with a trusted CA override for private deployments. Synchronize time before TLS and never fall back to insecure HTTPS.
- Filter firmware JSON responses to the fields needed, so growing telemetry metadata cannot overflow the success/config parsing buffers.
- Show the real hardware suffix in Wi-Fi provisioning instructions and associate accessible labels with sensor controls.
- Clean up a linked device if sensor registration fails while saving the link.
- Carry the remote ONNX upgrade into the standalone installer fallback.
- Add the archived sensor/hardware verification tests to the repository CI gate.

## Dependency proposals

Compatible proposals were consolidated against current main and resolved into the checked-in lockfiles. Versions may be newer compatible releases than the original proposal. ESLint 10 uses compatible plugins while preserving the existing JavaScript and Hooks lint rules; the React Compiler rule set is a separate migration.

| Original PR | Proposal | Disposition |
| --- | --- | --- |
| [634](https://github.com/mefree2098/HomeBrainv2/pull/634) | Bump eslint from 9.39.5 to 10.9.1 in /client | Included |
| [636](https://github.com/mefree2098/HomeBrainv2/pull/636) | Bump onnxruntime-node from 1.27.0 to 1.29.0 in /remote-device | Included |
| [638](https://github.com/mefree2098/HomeBrainv2/pull/638) | Bump @types/react-dom from 19.2.4 to 19.2.5 in /client | Included |
| [645](https://github.com/mefree2098/HomeBrainv2/pull/645) | Bump mongoose from 9.9.2 to 9.9.4 in /server | Included |
| [646](https://github.com/mefree2098/HomeBrainv2/pull/646) | Bump vite from 8.2.1 to 8.2.2 in /client | Included |
| [654](https://github.com/mefree2098/HomeBrainv2/pull/654) | Bump typescript-eslint from 8.67.0 to 8.69.0 in /client | Included |
| [655](https://github.com/mefree2098/HomeBrainv2/pull/655) | Bump axios from 1.19.0 to 1.20.0 in /server | Included |
| [656](https://github.com/mefree2098/HomeBrainv2/pull/656) | Bump express-rate-limit from 8.6.2 to 8.7.0 in /broker | Included |
| [657](https://github.com/mefree2098/HomeBrainv2/pull/657) | Bump axios from 1.19.0 to 1.20.0 in /client | Included |
| [658](https://github.com/mefree2098/HomeBrainv2/pull/658) | Bump axios from 1.19.0 to 1.20.0 in /broker | Included |
| [659](https://github.com/mefree2098/HomeBrainv2/pull/659) | Bump @anthropic-ai/sdk from 0.111.0 to 0.123.0 in /server | Included |
| [660](https://github.com/mefree2098/HomeBrainv2/pull/660) | Bump axios from 1.19.0 to 1.20.0 in /lambda | Included |
| [661](https://github.com/mefree2098/HomeBrainv2/pull/661) | Bump lucide-react from 0.460.0 to 1.39.0 in /client | Included |
| [662](https://github.com/mefree2098/HomeBrainv2/pull/662) | Bump @types/node from 22.20.1 to 26.4.1 in /client | Not applicable: retain Node 22 typings to match the supported build/runtime and CI baseline. |
| [663](https://github.com/mefree2098/HomeBrainv2/pull/663) | Bump react-hook-form from 7.85.0 to 7.87.0 in /client | Included |
| [664](https://github.com/mefree2098/HomeBrainv2/pull/664) | Bump @openai/codex from 0.144.6 to 0.152.0 in /server | Included |
| [665](https://github.com/mefree2098/HomeBrainv2/pull/665) | Bump zod from 4.4.3 to 4.5.4 in /server | Included |
| [666](https://github.com/mefree2098/HomeBrainv2/pull/666) | Bump github/codeql-action/analyze from 4.37.6 to 4.37.9 | Included |
| [667](https://github.com/mefree2098/HomeBrainv2/pull/667) | Bump react-router from 8.3.0 to 8.3.1 in /client | Included |
| [668](https://github.com/mefree2098/HomeBrainv2/pull/668) | Bump zwave-js from 15.27.0 to 15.28.0 in /server | Included |
| [669](https://github.com/mefree2098/HomeBrainv2/pull/669) | Bump express-rate-limit from 8.6.2 to 8.7.0 in /server | Included |
| [670](https://github.com/mefree2098/HomeBrainv2/pull/670) | Bump @vitejs/plugin-react from 6.0.5 to 6.1.1 in /client | Included |
| [671](https://github.com/mefree2098/HomeBrainv2/pull/671) | Bump zigbee-herdsman from 10.8.1 to 10.9.1 in /server | Included |
| [672](https://github.com/mefree2098/HomeBrainv2/pull/672) | Bump openai from 6.49.0 to 7.8.0 in /server | Included |
| [673](https://github.com/mefree2098/HomeBrainv2/pull/673) | Bump zigbee-herdsman-converters from 26.94.0 to 26.103.0 in /server | Included |
| [674](https://github.com/mefree2098/HomeBrainv2/pull/674) | Bump github/codeql-action/init from 4.37.6 to 4.37.9 | Included |

## Material retained only in the external archive

67 scratch QA media files and five superseded narration files remain in the original verified archive. They are not dependencies of the retained final exports, current narration, or source tools. The two old stashes duplicate the sensor integration patch and contain no additional feature work. The branch bundle remains a recovery copy of historical branch commits.

## Verification

Validation covers the server, client, broker, Lambda and remote-device regression suites; client lint and production build; dependency and secret checks; sensor firmware compilation; hardware consistency checks; and both tutorial video variants. Hardware digital checks do not certify purchased-part fit or electrical operation, and merging does not flash any physical sensor.
