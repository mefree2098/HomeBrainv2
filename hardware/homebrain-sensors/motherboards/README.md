# HomeBrain dedicated sensor motherboards

**Manufacturing HOLD (2026-09-06): do not order the linked ZIPs.** The [pre-order review](PREORDER-REVIEW.md) identifies unresolved footprint, assembly and electrical checks. The instructions below describe the draft assembly, not an approved release; a paper fit check alone does not clear this hold.

**2026-09-07 correction:** v1.2-draft fixes mirrored Climate battery-post coordinates and Presence radar header offsets using original manufacturer CAD. Prior v1.1 files are obsolete. See the [manufacturer-source register](references/README.md); do not use old battery-post positions.

These three PCBs replace the rejected universal carrier/harness design. Each device has one purpose-built motherboard. Every headered purchased board uses its factory-installed straight male pins: insert them through the labeled motherboard footprint, solder from the motherboard underside, inspect, and then trim the excess. Shared power/I²C/UART connections are copper traces inside the PCB.

## What remains flexible

- **Atmosphere:** the PMS5003 metal sensor remains on its supplied keyed eight-wire cable. The photographed red breakout already has a factory-installed 1×8 male header. Remove the temporary Dupont jumper leads, pass those eight pins directly through motherboard `J4`, solder them from the motherboard underside, inspect the joints, and only then trim the protruding ends. The keyed cable remains plugged between the breakout and PMS5003. There is no hand-wired PMS power or UART harness.
- **Climate:** the pouch battery's factory lead remains flexible because it is part of the cell. Its meter-verified mating 1.25 mm pigtail is soldered directly into `J2`. Two short rigid posts made from saved resistor-lead offcuts connect motherboard `XB1/XB2` to the XIAO's otherwise inaccessible underside `BAT−/BAT+` pads; these are soldered structural conductors, not jumper wires.
- **USB-powered boards:** the external USB-C cable plugs into the XIAO normally.

There are no other wires between modules.

## JLCPCB import-check packages — 2026-09-14

For JLCPCB **Re-Upload**, use the compatibility ZIPs below instead of the original generic ZIPs. These remain **v1.2-draft / manufacturing HOLD**; correcting file recognition does not clear the findings in [PREORDER-REVIEW.md](PREORDER-REVIEW.md).

| Device | Expected copper layers / outline size | Replacement upload |
|---|---|---|
| Atmosphere | 2 / 80 × 64 mm | [JLCPCB import-check ZIP](generated/atmosphere/homebrain-atmosphere-motherboard-jlcpcb-import-check.zip) |
| Presence | 2 / 64 × 54 mm | [JLCPCB import-check ZIP](generated/presence/homebrain-presence-motherboard-jlcpcb-import-check.zip) |
| Climate | 2 / 58 × 48 mm | [JLCPCB import-check ZIP](generated/climate/homebrain-climate-motherboard-jlcpcb-import-check.zip) |

The ZIPs use [JLCPCB's recommended filenames](https://jlcpcb.com/help/article/suggested-naming-patterns): GTL/GBL copper, GTS/GBS solder mask, GTO front legend, GKO outline, and PTH.XLN plated drilling. Every layer is at the archive root, with no duplicate generic layers or stale job-file paths. Gerbers explicitly select linear interpolation and preserve metadata as plain comments. Drill headers explicitly identify plated holes and absolute positioning.

Verification: Gerbonara 1.6.3 independently recognized both copper layers, both masks, front silk, and all four closed outline edges at the dimensions above. It recognized 41 / 32 / 29 plated holes for Atmosphere / Presence / Climate, respectively; every hole coordinate and diameter matched the layout. All six layers' parsed graphical primitives matched the original exports exactly. The original generic ZIPs and source geometry were preserved. Twelve regression tests and the existing digital verifier passed. **JLCPCB's actual re-upload result still needs confirmation**; do not override a zero-layer or wrong-outline result and proceed.

To refresh only these compatibility packages without rerouting or regenerating any design geometry:

```bash
python3 scripts/generate-homebrain-motherboards.py --repackage-only
python3 scripts/test-verify-homebrain-motherboards.py
python3 scripts/verify-homebrain-motherboards.py
```

## Original generic fabrication exports (retained for comparison)

Upload these as **three separate PCB orders**. The usual five-board minimum is expected for each design.

| Device | Board size | Print at 100% and test-fit first | Upload this ZIP after it passes |
|---|---:|---|---|
| Atmosphere | 80 × 64 mm | [`actual-size fit template`](generated/atmosphere/homebrain-atmosphere-motherboard-fit-check.svg) | [`homebrain-atmosphere-motherboard-gerbers.zip`](generated/atmosphere/homebrain-atmosphere-motherboard-gerbers.zip) |
| Presence | 64 × 54 mm | [`actual-size fit template`](generated/presence/homebrain-presence-motherboard-fit-check.svg) | [`homebrain-presence-motherboard-gerbers.zip`](generated/presence/homebrain-presence-motherboard-gerbers.zip) |
| Climate | 58 × 48 mm | [`actual-size fit template`](generated/climate/homebrain-climate-motherboard-fit-check.svg) | [`homebrain-climate-motherboard-gerbers.zip`](generated/climate/homebrain-climate-motherboard-gerbers.zip) |

Use the defaults recorded in [`order-list.csv`](generated/order-list.csv): two layers, 1.6 mm FR-4, 1 oz copper, lead-free HASL, bare boards/no assembly. Solder-mask color is cosmetic.

Do not order a PCB until the relevant purchased module is physically laid over its 1:1 SVG paper template and every header row aligns. In the print dialog choose **100% / Actual Size**, never “Fit to page,” then confirm the outside rectangle with a ruler. Straight header pins should pass through the printed pad centers without forcing. Seller breakout revisions can change even under one ASIN; this physical check is the final safeguard before spending money.

## Factory-header mounting

All sensor breakouts and all three XIAOs in the purchased set have factory-installed straight male headers. For every labeled `U1` or sensor `J` footprint: remove temporary Dupont jumper leads, orient the component exactly as printed in its assembly sheet, insert every factory pin fully through the motherboard, hold the component square, solder from the motherboard underside, and inspect all fillets. Only after inspection, trim the protruding ends with flush cutters, leaving about 0.5–1 mm beyond the solder fillet. Wear eye protection and reflow any joint mechanically disturbed by cutting.

The official XIAO footprint is 17.8 × 21 mm with 15.24 mm row spacing and 2.54 mm pin pitch. Install each XIAO component-side up with USB-C toward the large `USB` arrow; both factory 1×7 rows pass through `U1`.

Climate adds a battery-pad step because `BAT−` and `BAT+` are not on the factory side headers:

1. Install and solder `R1` and `R2` first. Save two straight lead offcuts at least 7 mm long.
2. With the Climate XIAO upside down and unpowered, flux its `BAT−` and `BAT+` pads. Tin one end of each saved lead and solder it perpendicular to the correct pad as a rigid post.
3. Turn the XIAO component-side up. Guide the two factory 1×7 header rows through `U1` and the rigid posts through `XB1 BAT−` and `XB2 BAT+` simultaneously.
4. Confirm orientation and polarity, then solder both factory header rows and both battery posts from the motherboard underside. Inspect for shorts and verify continuity before trimming.

## Atmosphere direct-solder pin contract

| Footprint | Purchased board | Physical pin order on that board | Motherboard copper |
|---|---|---|---|
| `J1` | hiBCTR BME680 | right edge top→bottom: `VCC GND SCL SDA SDO CS` | `3V3 GND SCL SDA NC NC` |
| `J2` | Teyleten SCD41 | bottom edge left→right: `GND VDD SCL SDA` | `GND 3V3 SCL SDA` |
| `J3` | HiLetgo VEML7700 | bottom edge left→right: `VIN 3Vo GND SCL SDA` | `3V3 NC GND SCL SDA` |
| `J4` | supplied red PMS breakout | left edge top→bottom: `VCC GND SET RXD TXD RESET NC NC` | `VBUS GND NC TX RX NC NC NC` |

`J4 RXD` is routed to XIAO `D6/TX`; `J4 TXD` is routed to XIAO `D7/RX`. The UART crossing is intentional and verified.

Your actual breakout is authoritative: its factory male pins are the board-to-board interconnect. Install the breakout component/socket side up with its keyed cable socket facing right. No additional header strip is required.

## Presence direct-solder pin contract

| Footprint | Purchased board | Physical order | Motherboard copper |
|---|---|---|---|
| `J1` | DIYables DHT11 | `+ OUT −` | `D3 D2 GND` |
| `J2` | HiLetgo VEML7700 | `VIN 3Vo GND SCL SDA` | `3V3 NC GND SCL SDA` |
| `J3` | Hi-Link LD2410C, rotated so the module overhangs the PCB | original `TX RX OUT GND VCC` | `RX TX NC GND VBUS` |

The LD2410C antenna face points toward the lid. Its body overhangs the motherboard edge. This placement alone does not certify an RF keepout; final antenna-face and enclosure clearance remain under review.

## Climate direct-solder pin contract

| Footprint | Part | Physical order | Motherboard copper |
|---|---|---|---|
| `J1` | DIYables DHT11 | `+ OUT −` | `D3 D2 GND` |
| `J2` | verified battery pigtail | `BAT+ BAT−` | `BAT+ GND` |
| `R1` | 200 kΩ 1% | either direction | `BAT+ → A0` |
| `R2` | 200 kΩ 1% | either direction | `GND → A0` |
| `XB1/XB2` | rigid posts soldered to XIAO underside pads | `BAT− / BAT+` | `GND / BAT+` |

Never trust the pigtail wire colors. Use a multimeter to identify the battery connector's positive and negative contacts, then solder the matching pigtail conductors into the labeled holes.

## Mechanical mounting and screws

Each motherboard has four 3.4 mm mounting holes. The redesigned case has matching plastic posts with open pilot holes. Four common **#4 × 3/8 in Phillips pan-head coarse-thread sheet-metal screws** fasten the PCB directly to those posts; four more close the lid. Across three devices that is 24 screws. Buy two 16-packs total of Home Depot Everbilt model `824681`, Store SKU `1006540029`. If the previously specified 16-pack is already in hand, only one additional pack is required.

## Generated proof sheets

- [Atmosphere assembly](generated/atmosphere/homebrain-atmosphere-motherboard-assembly.png) and [net schematic](generated/atmosphere/homebrain-atmosphere-motherboard-schematic.png)
- [Presence assembly](generated/presence/homebrain-presence-motherboard-assembly.png) and [net schematic](generated/presence/homebrain-presence-motherboard-schematic.png)
- [Climate assembly](generated/climate/homebrain-climate-motherboard-assembly.png) and [net schematic](generated/climate/homebrain-climate-motherboard-schematic.png)

Regenerate and verify deterministically:

```bash
python3 scripts/generate-homebrain-motherboards.py
python3 scripts/test-verify-homebrain-motherboards.py
python3 scripts/verify-homebrain-motherboards.py --repeat
```

The verifier checks physical pin order, firmware pin allocation, UART crossing, battery polarity, the XIAO antenna copper keep-out, radar overhang, net connectivity, trace clearance, grounded screw access, drill counts, Gerber ZIP contents, hashes, and repeatability.
