# Pre-order engineering review — updated 2026-09-07

**HOLD: none of the three boards is approved for manufacture.** This supersedes previous order-ready statements. Passing a generator's programmed pin-map and clearance checks does not establish that the purchased boards fit or operate correctly.

## Findings and release requirements

Manufacturer lookup is now documented in the [source register](references/README.md). The earlier blanket request for customer photographs is withdrawn. Exact published CAD has already corrected two errors; missing seller drawings must be pursued as documentation gaps, not reassigned to the owner as a photography task.

| Scope | Finding | Required before release |
|---|---|---|
| Atmosphere J1 | BME680 outline ends at X=23.5 mm, while the header is at X=25.5 mm. Seller dimensioned graphic establishes 18.5×16 mm; existing outline is also wrong in height. | Overall dimensions are recorded. Obtain missing header-to-edge dimensions from supplier to anchor the corrected outline without inventing offsets. |
| Atmosphere J1 | CS and SDO are left unconnected. Bosch requires CSB high for I²C and SDO at a defined level. The purchased breakout may provide these straps, but that has not been established. | Identify/measure onboard straps with power disconnected; provide defined levels if absent. |
| Atmosphere supply | SCD41 can draw 205 mA peak at 3.3 V. Routing to 3V3 alone does not verify supply ripple, breakout regulator drop or decoupling. | Verify exact breakout circuitry and total peak load; measure sensor supply during CO₂ measurement and Wi-Fi activity. Do not change it to 5 V without checking I²C pull-ups/level compatibility. |
| Presence and Climate J1 | DIYables' official image shows an angled header supporting upright mounting, whereas owner specified straight headers. Module dimensional drawing is absent from published product page. | Request the installed header drawing and module envelope/current from DIYables; resolve variant without treating chip-package dimensions as breakout dimensions. |
| Presence J3 | RESOLVED: exact header pitch/order and XY offsets obtained from official manual/STEP. J3 origin corrected to (60.4648,28.9712). | Paired enclosure and antenna-face clearance remain to be verified. Removed unsupported claim that overhang alone establishes zero copper behind all antenna features. |
| Climate XB1/XB2 | RESOLVED: previous battery pad positions were mirrored. Corrected using Seeed CAD to BAT− (+0.7586,−5.5277), BAT+ (−1.7814,−5.5277) relative to U1, top view, USB up. | Solder access, standoff and mechanical strain of added posts still need design review. Ordinary continuity/polarity checks remain mandatory during assembly. |
| Other breakout geometry | VEML7700 overall size 17×17×4 mm and SCD41 header pitch 2.54 mm are published; complete offset drawings for these and red PMS adapter were not located. | Request missing supplier drawing/schematic. Do not substitute another vendor's board with the same chip. |
| All enclosures | 2.5 mm module spacing and 21 mm USB centre height are assumptions. Existing checks validate those assumptions, not actual hardware. | Measure assembled height and USB opening position; check sensor bodies, connectors, cable bend space, screw heads and lid clearance before releasing paired STLs. |
| All fabrication | Pin-one markers moved off pad centres and explicit mask-opening clearance added. Some tiny labels still require readability review. Ground pads have direct plane connection without hand-soldering thermal relief. | Inspect final CAM for readable orientation marks; review thermal relief and screw-head-to-copper clearance. |

## Refinements completed in this review

- Corrected mirrored Climate battery-post coordinates using original Seeed PCB; checker now reads manufacturer CAD and validates actual motherboard post offsets against it.
- Corrected Presence radar-header offset from Hi-Link STEP hole axes; regression test rejects the previous guessed origin.
- Archived manufacturer files and source/derivation register for offline checks.
- Moved pin-one silk marks off exposed pads and added 0.15 mm silk-to-mask margin clearances. Advanced all drafts to v1.2-draft to distinguish them from obsolete v1.1 exports.

- Replaced implicit fixed-digit drill coordinates with explicit decimal millimetres and absolute positioning.
- Added verification of every exported drill's XY position and diameter, not merely the number of holes; regression tests reject shifted holes, wrong diameters and wrong units.
- Added HOLD status to source, generated manifest, release notice and order list. `verify-homebrain-motherboards.py --require-release` fails while held.
- Changed verification output to distinguish digital consistency checks from physical/electrical certification.

No guessed component dimensions, power changes or unproven battery connections were silently substituted. Existing copper remains a draft, not an order recommendation. Previously downloaded ZIPs must also be treated as held.

## Evidence

- [Bosch BME680 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme680-ds001.pdf): I²C interface selection and SDO address level requirements.
- [Sensirion SCD40/SCD41 datasheet](https://sensirion.com/media/documents/E0F04247/631EF271/CD_DS_SCD40_SCD41_Datasheet_D1.pdf): supply range, ripple requirement and peak current.
- [Seeed XIAO ESP32C6 pin multiplexing](https://wiki.seeedstudio.com/xiao_pin_multiplexing_esp32c6/): pin functions and regulated output specification. These specifications do not establish third-party breakout geometry.

After the blockers are resolved: rerun digital checks, inspect actual Gerber/drill output in an independent CAM viewer, verify a full-scale physical fit, and build/test a prototype before any larger order. Software review cannot guarantee perfect hardware.
