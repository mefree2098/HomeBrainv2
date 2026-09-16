# Freestone connectivity recovery and appliance integrations

Investigated September 16, 2026 with the `homebrain-live` skill, explicitly selecting `freestone` at https://freestonefamily.com. SSH confirmed the same `annaai` host. Times below are America/Denver (MDT).

## Incident and first production repair

| Time | Evidence |
| --- | --- |
| 10:31:52 AM | Sense refresh returned HTTP 504. |
| 11:07:43 AM | Another Sense refresh returned HTTP 504. |
| 11:08:43 AM | Backend crashed with `WebSocket was closed before the connection was established`, from SenseService.stopWebSocket → startWebSocket → performRefresh. |
| 11:08:54 AM | systemd restarted HomeBrain. |
| 11:08:57 AM | HTTP resumed, about 14 seconds after the crash. |
| After restart | Zigbee startup timed out at `ZDO activeEpReq`; the failed controller retained its serial lock, preventing subsequent startup attempts. |
| 12:38 PM | Reliability release a230640f deployed through HomeBrain. Zigbee resumed the existing network with 31 paired devices; Zigbee and Z-Wave controllers reported healthy. |

Only one backend crash was found between midnight and 11:15 AM. No host reboot or kernel out-of-memory event was found. This confirms a server outage; without individual iPad timestamps it cannot explain every displayed connectivity warning.

[PR 696](https://github.com/mefree2098/HomeBrainv2/pull/696) preserves valid connecting Sense sockets, safely handles asynchronous socket-close errors, limits handshake duration, and ignores callbacks from retired sockets. Zigbee startup now serializes attempts and closes a failed adapter without writing an incomplete network backup. Deploy health checks now check the actual direct-radio controllers.

## State recovery

Scenes may skip a physical device action only when a live read confirmed the required fields. A failed query cannot make cached OFF suppress an explicit OFF command. Local/mock devices retain their existing skip behavior.

Zigbee and Z-Wave reconnects query listening devices. Sleeping battery devices report on wake, so they do not block recovery of mains-powered devices. Insteon reconnects query known switches and lights. Matter startup reconnects known nodes and subscribes to actual remote state reports; explicit Matter refresh bypasses its attribute cache. Appliance integrations poll immediately on startup and then every minute. Existing cloud integrations retain their initial synchronization paths.

## TheaterAC

Production discovery identified a compatible Midea-family AC at **192.168.2.63**, device ID **15393162888273**. A read-only query confirmed power ON, cooling, target 74.3°F, indoor 70.7°F and outdoor 83.3°F. These are investigation-time readings, not ongoing values.

The adapter uses [msmart-ng](https://github.com/mill1000/midea-msmart) 2026.9.0 for LAN commands and readings. Supported settings reported by this unit: off, auto, cool, heat, dry, fan and smart dry; auto/max/high/medium/low/silent fan speeds; swing off/vertical/horizontal/both; eco, turbo and sleep. The range is 60.8–86°F with native half-degree Celsius increments. HomeBrain converts units and shows the confirmed rounded setpoint.

Commands refresh actual state before writing and require a successful readback before reporting success. Setup stores authentication material encrypted on the hub. DHCP recovery discovers the same device ID and updates the saved IP; it does not substitute another device at the old address.

The shared device path supports web, native iOS, HomeBrain voice, workflows and Alexa. Alexa uses standard power/thermostat controls plus ModeController and ToggleController for the additional settings. Extended Alexa controls also require deploying the updated Smart Home Lambda. Native iOS changes require installing a new app build; updating the server does not replace an installed iOS binary.

## Rheem tankless heater

The linked ASIN identifies RTGH-95DVELN-3, a natural-gas tankless heater with built-in EcoNet Wi-Fi. See the [Rheem specification](https://media.rheem.com/media/uploads/iat/sites/36/2023/06/RTGH-Series-condensing-Tankless-SS_0609.pdf).

The adapter uses [pyeconet](https://github.com/w1ll1am23/pyeconet) 0.2.6 through its unofficial cloud API and MQTT subscription. Register the heater in EcoNet, then enter its account in HomeBrain Settings → Rheem Water Heater. Credentials are encrypted with AES-GCM; the separate key is stored in `server/data/appliances/credentials.key` with restricted permissions and must accompany a database restore. Credentials never appear in command arguments or API status responses.

Monitoring includes connectivity, operating mode/state, setpoint, alert count, signal strength, and available daily water/energy readings. Missing model-specific fields remain unknown. Gas energy is not labelled kWh. A leak-sensor capability is not presented as a detected leak. HomeBrain creates ordinary in-app notifications when offline/error/filter/alert states appear; active fault details and service instructions remain in EcoNet. Heater control is outside this monitoring integration.

EcoNet connected successfully at 1:46 PM. The discovered Tankless Water Heater reported a 120°F setpoint, one active alert, 124 gallons of water used today, and 24 kBTU today. HomeBrain persisted the readings and created the heater alert notification. The API does not supply the alert description through this adapter; open EcoNet for its details. EcoNet cloud changes may require adapter updates.

## Validation and release requirements

Local validation: 1,466 server tests, 38 broker tests, 12 Lambda tests, six Python appliance adapter tests, web tests/lint/production build, console-format checks, and iOS simulator build with Swift warnings treated as errors. Regression tests cover failed-query stale caches, startup reads, real command confirmation, temperature conversion, DHCP identity matching, voice device selection, and Alexa controller instance forwarding.

Production verification:

- Integration release 8458e42c and compatibility follow-up 467233d2 were deployed through HomeBrain. Health returned green; Zigbee automatically recovered its startup timeout without re-pairing.
- TheaterAC is paired as device `6aaaeec609a5fd9e521fbbda`. Live API commands confirmed power, temperature, heat, cool, dry, fan-only, and fan-speed changes. The final compatibility checks completed in about four seconds each and restored cooling, 74.3°F, high fan.
- C&H firmware reports low/medium fan as 30/50 and dry-mode automatic fan as status-only code 101. The adapter recognizes these readings and uses the valid automatic-fan command when changing modes.
- Workflow `6aaaeee2fba859d4ffdcad12`, “Theater AC Off at 1 AM,” is enabled daily at 1 AM in the server's America/Denver timezone. It retries transient failures. A manual execution confirmed the AC switched off in approximately three seconds. It does not promise catch-up if the server is down at the scheduled time.
- Alexa exposure is enabled automatically. Broker catalog/state synchronization succeeded; Amazon accepted TheaterAC ChangeReports with HTTP 202. Household rediscovery was requested. The production Smart Home Lambda in account 201813911302 was updated successfully. A spoken Echo command still requires household confirmation.
- Data Platform persisted AC and heater samples. Gallon usage is numeric, and new energy samples include the reported unit in their metric name.
- Stars Only succeeded for all 11 group members, with exit sign at 36% and stage at 30%. A deliberate Zigbee light ON followed by scene activation produced a verified OFF state.
- Signed Release builds were installed and launched on Matt's iPhone Air and the Theater iPad. The Security Center decoration and provider-name cleanup was also installed on both.

Additional live checks exposed and corrected the nested Settings form that prevented EcoNet login submission, inaccurate default electric-mode naming for Eagle tankless units, and appliance report-provider labels. Regression checks now include 14 web tests, nine Python appliance tests, and unit-bearing numeric water/energy metrics.

One existing Z-Wave node (node 6, Honeywell switch) remained offline/incompletely interviewed despite a healthy controller. It was not reset or removed. Physical power/range checks may be needed for that separate device.

