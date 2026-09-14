# DEPRECATED — rejected HomeBrain universal sensor carrier

> **DO NOT ORDER OR BUILD THIS BOARD.** This harness-based architecture was rejected and has been replaced by three direct-solder [dedicated sensor motherboards](../motherboards/README.md). The files below remain only as historical/reproducibility artifacts.

This passive 32 × 56 mm carrier is the final-assembly answer to the shared-pin problem. Each XIAO header pin enters exactly one female socket; copper on the carrier distributes ground, 3.3 V, SDA, SCL, 5 V, and UART to separate keyed JST-XH ports. No finished device has multiple loose wires soldered into one XIAO hole, and the XIAO can be unplugged without desoldering it.

The same bare PCB is used in all three devices. Populate every keyed board header on all three carriers so a board remains universal. Populate the two 200 kΩ divider resistors only on the Climate carrier.

## Order these items

### 1. Five bare PCBs

Upload [`generated/homebrain-carrier-gerbers.zip`](./generated/homebrain-carrier-gerbers.zip) to the [JLCPCB instant quote](https://cart.jlcpcb.com/quote). Order bare boards, not assembly:

- Quantity: 5 (three used, two spare)
- Board: 32 × 56 mm, regular rigid FR-4
- Layers: 2
- Thickness: 1.6 mm
- Copper: 1 oz
- Surface finish: lead-free HASL
- Solder mask: any color
- Silkscreen: white
- Remove order number: optional
- PCB assembly: no
- Stencil: no

The upload should automatically detect 32 × 56 mm and two copper layers. Stop if its preview shows a different outline, missing drill holes, or copper in the gold `NO COPPER` antenna area shown in the [assembly image](./generated/homebrain-carrier-assembly.png).

### 2. One DigiKey order

Order the exact quantities below. They include practical spares.

| Qty | DigiKey item | Purpose |
| ---: | --- | --- |
| 8 | [Sullins PPTC071LFBN-RC, DigiKey S7005-ND](https://www.digikey.com/en/products/detail/sullins-connector-solutions/PPTC071LFBN-RC/810146) | Two 1×7, 2.54 mm female sockets per carrier; six used |
| 14 | [JST B4B-XH-A, DigiKey 455-B4B-XH-A-ND](https://www.digikey.com/en/products/detail/jst-sales-america-inc/B4B-XH-A/1651047) | Four 4-pin keyed headers per carrier; twelve used |
| 4 | [JST B3B-XH-A, DigiKey 455-2248-ND](https://www.digikey.com/en/products/detail/jst-sales-america-inc/B3B-XH-A/1651046) | One 3-pin DHT header per carrier; three used |
| 8 | [JST B2B-XH-A, DigiKey 455-B2B-XH-A-ND](https://www.digikey.com/en/products/detail/jst-sales-america-inc/B2B-XH-A/1651045) | Two 2-pin battery headers per carrier; six used |
| 8 | [JST XHP-4, DigiKey 455-2267-ND](https://www.digikey.com/en/products/detail/jst-sales-america-inc/XHP-4/683353) | Six sensor harness plugs plus two spare |
| 4 | [JST XHP-3, DigiKey 455-2219-ND](https://www.digikey.com/en/products/detail/jst-sales-america-inc/XHP-3/1651017) | Two DHT harness plugs plus two spare |
| 4 | [JST XHP-2, DigiKey 455-2266-ND](https://www.digikey.com/en/products/detail/jst-sales-america-inc/XHP-2/555485) | Two Climate battery harness plugs plus two spare |
| 20 | [JST ASXHSXH22K203, DigiKey 455-4222-ND](https://www.digikey.com/en/products/detail/jst-sales-america-inc/ASXHSXH22K203/9961918) | Double-ended, genuine XH pre-crimp leads; each produces two crimped stubs |
| 4 | [Yageo MFR-25FRF52-200K, cut tape](https://www.digikey.com/en/products/detail/yageo/MFR-25FRF52-200K/15104) | Two 200 kΩ 1% Climate-divider resistors plus two spare |

JST-XH is a real 2.50 mm-pitch connector family. Do not substitute an Amazon kit described as “XH 2.54 mm” unless its physical mating fit has been confirmed; many listings mix incompatible clone dimensions.

### 3. One Amazon battery-adapter kit

Order one [1.25 mm two-pin male/female pigtail set, ASIN B0DMT6VZVC](https://www.amazon.com/dp/B0DMT6VZVC). The purchased MakerHawk pack is advertised with a micro 1.25 mm two-pin connector. Use only the pigtail half that physically mates without force, and verify red/black polarity with a meter before connecting it to carrier J6. Connector shape and wire color are not proof of LiPo polarity.

Already purchased and reused: the ELEGOO colored female-to-female Dupont jumpers (ASIN B01EV70C78), thin electronics mounting tape, small heat-shrink, solder, and the external Anker/UGREEN USB power items. No antenna, crimp tool, terminal extractor, PCB standoffs, heat-set inserts, or additional case fasteners are required.

The machine-readable version of this order is [`generated/bom.csv`](./generated/bom.csv).

## Make the keyed harnesses

The genuine pre-crimp leads are black. For an unmistakable final harness, cut approximately 32 mm (1.25 in.) inward from **both** crimped ends of each 8-inch lead. That produces 40 short black XH contact stubs; 34 are used. Insert each crimp into the numbered cavity of its XHP housing, then solder its bare end to the matching colored female Dupont tail and cover the splice with heat-shrink. Most of each finished wire is therefore the guide color, while only the short keyed-plug end is black.

Use this color contract consistently:

| Function | Color |
| --- | --- |
| Ground / BAT− | Black |
| 3.3 V, 5 V, BAT+ | Red |
| SDA | Green |
| SCL | Blue |
| MCU TX → sensor RX | Purple |
| Sensor TX → MCU RX | Yellow |
| DHT data | White |
| DHT switched power | Orange |

The exact device guides are:

- [Atmosphere final keyed harness (PNG)](./generated/final-harness-atmosphere.png) · [SVG](./generated/final-harness-atmosphere.svg)
- [Presence final keyed harness (PNG)](./generated/final-harness-presence.png) · [SVG](./generated/final-harness-presence.svg)
- [Climate final keyed harness (PNG)](./generated/final-harness-climate.png) · [SVG](./generated/final-harness-climate.svg)

The white XH plug is keyed only at the carrier. At the module end, read the module's printed pin label and do not infer a connection from its physical left/right position or a seller's ribbon colors.

## Assemble each carrier

1. Keep the carrier component-side up and its `USB` arrow at the left.
2. Plug the XIAO's two installed male-header rows into the two loose 1×7 female sockets. Insert that whole stack into carrier U1, tack one pin at each end, confirm the XIAO is level and removable, then solder the remaining socket pins. Remove the XIAO before soldering the other parts.
3. Solder J1–J7 with each header's pin 1 aligned to the round silkscreen dot. The shrouds must sit flat and vertical.
4. Leave R1/R2 empty on Atmosphere and Presence. Install both 200 kΩ 1% resistors on Climate.
5. Meter-check continuity from every connector pin to its named XIAO socket pin. Confirm there is no short between 3V3, 5V/VBUS, BAT+, and GND.
6. Plug in the XIAO component-side up with USB toward the printed arrow.
7. On Climate, make J7 as a removable two-wire pigtail to the XIAO underside BAT− and BAT+ pads. Verify polarity against the XIAO silkscreen before soldering and again before inserting J6/J7.

In the Atmosphere case the completed carrier is rotated 180° in the floor plan so USB faces the right-side opening. Presence and Climate retain the board-artwork orientation with USB to the left. Connector reference designators and pin numbers do not change when the whole carrier is rotated.

## Fabrication and verification artifacts

- [Electrical schematic](./generated/homebrain-carrier-schematic.png)
- [Assembly/copper guide](./generated/homebrain-carrier-assembly.png)
- [Gerber/drill ZIP](./generated/homebrain-carrier-gerbers.zip)
- [Structured routed layout](./generated/layout.json)
- [Generation manifest](./generated/manifest.json)

Regenerate and verify with:

```bash
python3 scripts/generate-homebrain-carrier.py
python3 scripts/verify-homebrain-carrier.py --repeat
```

The independent verifier checks pin contracts, UART crossing, every net's connectivity, foreign-net shorts, edge and antenna clearance, plated holes, Gerber syntax, ground-plane continuity/island removal, guide structure, PNG dimensions, manifest hashes, and byte-for-byte repeatability.
