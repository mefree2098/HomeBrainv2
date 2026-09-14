# Manufacturer-source register — 2026-09-07

Sources are evidence, not interchangeable footprints. Chip drawings are not breakout drawings. No dimensions below were obtained by measuring pixels in photographs.

| Part | Source and facts established | Still not established |
|---|---|---|
| Seeed XIAO ESP32C6 | [Official resource page](https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/), archived KiCad PCB and DIP footprint. All 14 header centres and underside TP9/TP10 coordinates are now checked directly against these files. | Factory header stack height is not specified by the DIP footprint. Battery-post assembly needs a solder-access/strain design review; correct XY coordinates alone do not settle it. |
| Hi-Link LD2410C | [Official download centre](https://h.hlktech.com/Mobile/download/fdetail/214.html), archived manual V1.09 pp.7–9 and STEP model. 22×16 mm outline, 2.54 mm pitch, 0.9 mm module holes; TX/RX/OUT/GND/VCC order; 5 V recommended, 3.3 V logic, supply capability >200 mA. STEP provides header-to-outline offsets. | Paired case assembly and antenna-face clearance need updating/checking. |
| hiBCTR BME680, B0GXHGYRN2 | [Seller's dimensioned graphic](https://m.media-amazon.com/images/I/61XrN4UIEeL._AC_SL1500_.jpg): overall 18.5×16 mm, main section 14 mm, sensor projection width 5 mm. [Listing](https://www.amazon.com/dp/B0GXHGYRN2) has contradictory textual dimensions; the explicit dimensioned graphic is the better mechanical evidence. | No dimensioned header centre-to-edge offset, assembled header specification or module schematic found. Bosch's chip datasheet does not settle breakout regulator, level-shifter or CS/SDO strap wiring. |
| Teyleten Robot SCD41, B0C622SS34 | [Seller listing](https://www.amazon.com/dp/B0C622SS34) explicitly specifies 2.54 mm header pitch and supply range 2.4–5.5 V. | No complete dimensioned breakout drawing or module schematic found. Sensirion's 10.1 mm chip dimensions are not dimensions of the blue breakout. |
| HiLetgo VEML7700, B09KGYF83T | [Brand listing](https://www.amazon.com/dp/B09KGYF83T): 17×17×4 mm, 3.3 or 5 V input, fixed address 0x10. [Manufacturer website](https://hiletgo.com/). | Exact header offsets and module schematic not located. Adafruit's different VEML7700 board is not a valid footprint substitute. |
| DIYables DHT11, B0DQ3PPGH2 | [Manufacturer product page](https://diyables.io/products/dht11-temperature-and-humidity-sensor-module) links directly to this ASIN and specifies 3.3–5 V operation and onboard pull-up. Its [published side view](https://diyables.io/images/products/dht11-temperature-humidity-sensor-2.jpg) shows a right-angle header, so upright assembly is possible for that advertised variant. | No dimensioned module/header drawing or full module-current specification on the product page. Owner said straight headers; do not silently replace that statement with a different pictured variant. Bare DHT11 package drawings do not determine breakout geometry. |
| risingsaplings PMS breakout, B0BG612GB2 | [Seller listing](https://www.amazon.com/dp/B0BG612GB2) confirms breakout/cable product; owner's earlier photo establishes installed 1×8 male pins. | No dimensioned red-breakout drawing or board schematic located. Plantower's metal-sensor drawing is not the red-breakout footprint. |
| Plantower PMS5003 | [Plantower manual hosted by Adafruit](https://cdn-shop.adafruit.com/product-files/3686/plantower-pms5003-manual_v2-3.pdf): physical/electrical source for metal sensor, not adapter. | Not evidence for the separate risingsaplings board. |

## Coordinate derivation

Seeed PCB uses screen coordinates with Y downward and USB pointing right. U2 is at (108.3977,72.876). To express a **top view with USB upward** in our Y-up design, use `x_new = y_source - 72.876`, `y_new = x_source - 108.3977`. D0 then lands at (-7.62,+7.62), proving the handedness. TP9/VBAT at (102.87,71.0946) becomes **BAT+ (-1.7814,-5.5277)**. TP10/GND at (102.87,73.6346) becomes **BAT− (+0.7586,-5.5277)**. The prior X offsets had the wrong sign. Corrected v1.2-draft and regression-tested against the archived PCB.

Hi-Link STEP Board bounds are X=151.5350036621…173.5350036621, Y=28.165000915527…44.165000915527. Header centres have Y=42.70017368, with X=157.50625344 plus n×2.54. Rotating the antenna-up board so its header is left and TX is lowest gives header offset **(1.4648272,5.9712498)** from the rotated lower-left outline corner. Existing outline origin (59,23) therefore gives **J3 origin (60.4648,28.9712)**. The old (60,28.92) was not the manufacturer geometry.

## Archived originals

Downloads are retained unchanged for offline verification. Seeed files retain their original embedded licensing/attribution; Hi-Link files are manufacturer reference material, not authored HomeBrain designs.

| File | Original URL | SHA-256 |
|---|---|---|
| seeed-xiao-c6.zip | https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32C6/XIAO_ESP32_C6_v1.0_SCH%26PCB_260114.zip | cea2ed66da575e4a1dd6c7a9acd60583ed4a9adbf6b1d2952851c1e4199c05fc |
| seeed-footprints.zip | https://files.seeedstudio.com/wiki/XIAO-KiCad-Library/New_XIAO_Series_Footprints.zip | 36f7e87db783002f20dad0fb36136c877dbc49e051293997993a988cac065698 |
| hlk-ld2410c-3d.zip | https://r0.hlktech.com/download/HLK-LD2410C-24G/1/HLK-LD2410C-3D%E5%9B%BE.zip | 87c50427f06a368fa2d99e99d39ea9b12e5156f6ad100cecf09ccbdd4535b9f3 |
| hlk-ld2410c-v1.09.pdf | https://r0.hlktech.com/download/HLK-LD2410C-24G/1/HLK%20LD2410C%E7%94%9F%E5%91%BD%E5%AD%98%E5%9C%A8%E6%84%9F%E5%BA%94%E6%A8%A1%E7%BB%84%E8%AF%B4%E6%98%8E%E4%B9%A6V1.09.pdf | 07b16520cb9dca21fb7ff67673c075fc0c2d00e75b6d2da267a478f50675f397 |

The precise missing supplier request is a dimensioned breakout drawing with header pitch, hole centres relative to PCB outline, installed header part/height and component envelope, plus schematic identifying regulator, pull-ups and interface straps. No customer photographs or ruler measurements are required for that request.
