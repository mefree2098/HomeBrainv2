# HomeBrain dedicated-motherboard enclosures

**Fit/release HOLD — 2026-09-06:** Do not reprint these cases pending resolution of the [PCB pre-order review](../motherboards/PREORDER-REVIEW.md). Module mounting orientation, standoff and USB heights require physical confirmation; existing geometry tests do not establish purchased-part fit.

These are the current cases for the three purpose-built HomeBrain motherboards. The earlier universal-carrier cases are obsolete. Each motherboard sits on four printed posts and is fastened directly to plastic with four common #4 screws. Two 18 mm-high walls behind the board carry USB insertion force.

| Enclosure | Outside size | Current mechanical design |
| --- | ---: | --- |
| Atmosphere | 146 × 104 × 38 mm | 80 × 64 mm motherboard, separate PMS5003 tape cradle, aligned intake/exhaust grille banks, short airflow shroud and anti-recirculation divider |
| Presence | 66 × 94 × 48 mm | 64 × 54 mm motherboard, vertical DHT11 clearance, lux aperture, and a 1.2 mm radar window in front of the overhanging LD2410C |
| Climate | 110 × 84 × 48 mm | 58 × 48 mm motherboard, vertical DHT11 clearance, 46 × 32 × 9.5 mm protected-LiPo pocket, and charging/status access |

The editable source is [`generated/homebrain-sensor-enclosures.blend`](./generated/homebrain-sensor-enclosures.blend). It retains colored reference motherboards, soldered-module envelopes, all 24 screws, and RF/airflow metadata. Reference objects are excluded from the printable STLs.

## Print files

| Device | Body | Separate lid | Preview |
| --- | --- | --- | --- |
| Atmosphere | [`atmosphere-body.stl`](generated/atmosphere-body.stl) | [`atmosphere-lid.stl`](generated/atmosphere-lid.stl) | [`atmosphere-exploded.png`](generated/atmosphere-exploded.png) |
| Presence | [`presence-body.stl`](generated/presence-body.stl) | [`presence-lid.stl`](generated/presence-lid.stl) | [`presence-exploded.png`](generated/presence-exploded.png) |
| Climate | [`climate-body.stl`](generated/climate-body.stl) | [`climate-lid.stl`](generated/climate-lid.stl) | [`climate-exploded.png`](generated/climate-exploded.png) |

All six current STLs are watertight. The verifier checks actual mesh geometry for open-top/closed-bottom pilots, top annuli, post depth, lid clearance/recess holes, board-to-case drill alignment, USB support-wall height, antenna clearance, and open PMS5003 vents.

## One screw for every joint

Use **#4 × 3/8 in. Phillips pan-head coarse-thread sheet-metal screws** everywhere. The modeled local shelf item is [Everbilt model 824681, Home Depot Store SKU 1006540029, 16-pack](https://www.homedepot.com/p/317479260).

- Four screws fasten each motherboard to printed posts.
- Four screws fasten each lid.
- Three devices therefore use 24 screws. Buy two 16-packs total; if one pack is already in hand, buy one more.
- Every printed pilot is 2.35 mm diameter × 8.4 mm deep, open at the top, and closed at the bottom.
- No inserts, nuts, washers, standoffs, clips, or specialty screws are used.

Use a hand screwdriver. On first assembly, keep the screw perpendicular and stop when the head is just snug. On later assembly, turn it backward until it drops into the existing plastic thread before tightening.

## Print settings

- PETG preferred; PLA is acceptable away from hot or sunny locations.
- 0.4 mm nozzle, 0.20 mm layers, three walls, four top/bottom layers, and 20–25% gyroid infill.
- Print each body upright with its floor on the bed.
- Print each lid presentation face down.
- Supports off. The bodies, open blind pilots, alignment lips, and vents are designed to print without support.
- If a lid lip is tight, first try −0.10 mm horizontal expansion on the lid.

## Fit check and final assembly

Do not order a PCB until every purchased breakout has been laid over that motherboard's [actual-size fit template](../motherboards/README.md#fabrication-files-to-order), printed at 100%. Amazon sellers can revise a board without changing its ASIN.

1. For every headered sensor board and XIAO, remove temporary Dupont leads, insert all factory-installed male pins through its labeled motherboard footprint, solder from the motherboard underside, inspect, and then trim the excess. Modules marked `NC` still use their physical pin for support, but that pin has no signal route. Bench-test the complete motherboard before installing it.
2. Deburr the four motherboard holes, USB opening, vents, and lid holes. Dry-fit everything unpowered.
3. Place the motherboard component-side up on its four posts. The XIAO USB-C connector faces the side opening. The four PCB drills must sit concentrically over the four open post pilots.
4. Start all four motherboard screws by hand and tighten diagonally until just snug. Do not put tape under the motherboard: the screws establish its height. The two tall rear walls remain immediately behind the PCB and resist the push when a USB cable is inserted.
5. Plug in USB before closing the case. The PCB must remain rigid and the plug must enter without bending the XIAO or forcing the case wall.
6. Keep metal and loose cable away from the antenna keep-out recorded in the Blender file. The onboard ceramic antenna is used; there is no external-antenna opening.
7. Atmosphere only: use thin electronics tape on the raised PMS5003 bed. Install the metal sensor with its small inlet holes and round fan opening facing the long wall's two grille banks. Its cable socket faces inward. Keep the supplied keyed cable intact between the metal PMS5003 and the red breakout rigidly soldered into motherboard `J4` using the breakout's factory-installed male pins.
8. Climate only: before installing the XIAO, use two saved straight resistor-lead offcuts as rigid posts from the XIAO underside `BAT−/BAT+` pads through motherboard `XB1/XB2`; solder and verify polarity/continuity exactly as described in the motherboard guide. Then connect the meter-verified battery pigtail and tape the flat protected pouch cell into its pocket. Never clamp, bend, or puncture it.
9. Presence only: the LD2410C antenna/component face points upward toward the unvented thin radar window. Do not put metal in front of it.
10. Place the lid over its alignment lips, start all four lid screws, and tighten diagonally only until snug.

The PMS5003 does not shoot its laser out of the case. Its laser-scattering chamber is internal; room air must flow through the sensor. The Atmosphere case therefore places the physical 50 × 21 mm port plane 2.4 mm from the exterior wall, gives intake and exhaust separate grille banks, and prints a divider that prevents an internal airflow loop. Keep that grille side open to the room. See the [Plantower PMS5003 data manual](https://cdn-shop.adafruit.com/product-files/3686/plantower-pms5003-manual_v2-3.pdf), “Installation Attentions.”

Any body printed for the earlier carrier/harness design must be replaced. The current motherboard footprints, post positions, USB height, and outside dimensions are different.

## Regenerate and verify

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --python scripts/generate-homebrain-enclosures.py \
  -- \
  --config hardware/homebrain-sensors/enclosures/enclosure-profiles.json \
  --output hardware/homebrain-sensors/enclosures/generated

python3 scripts/test-verify-homebrain-enclosures.py
python3 scripts/verify-homebrain-enclosures.py --repeat
```

The enclosure verifier also reads `motherboard-designs.json`; a case cannot pass if a post, XIAO/USB location, or soldered-module envelope no longer matches its PCB source.
