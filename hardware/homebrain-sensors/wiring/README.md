# HomeBrain physical wiring source

`physical-hardware.json` is the reviewed source for the three **breadboard/bench** wiring sheets. It records the exact purchased ASINs, the viewing orientation and physical pin/hole order of every board, every required net, and every deliberate no-connect.

These star-wired sheets are no longer the final assembly method. Finished devices use the [universal carrier PCB and keyed harness guides](../carrier/README.md), which eliminate every multi-wire XIAO joint. Keep these diagrams only for temporary bench diagnosis.

Generate the SVG and PNG files:

```bash
python3 scripts/generate-homebrain-wiring-diagrams.py
```

Validate pin order, endpoint existence, no-connect markings, two-resistor battery-divider topology, image dimensions, checked-artifact freshness, and byte-for-byte repeatability:

```bash
python3 scripts/verify-homebrain-wiring-diagrams.py --repeat
```

The renderer uses only local SVG primitives and headless Google Chrome; it does not download or embed Amazon product photography. Board silhouettes and identifying components are redrawn so that exact connection positions remain readable and the generated artifacts can be audited mechanically.

The Atmosphere sheet uses a centered XIAO star layout. Its 16 physical jumper runs are deliberately separate, uniquely colored, and labeled `W01` through `W16`; the bottom checklist repeats both printed endpoint labels for every wire. The SCD41 and VEML7700 are rotated 90 degrees counter-clockwise on that sheet so their hole columns face the XIAO. Their displayed top-to-bottom pin order is the reverse of the boards' original bottom left-to-right order, exactly as a physical counter-clockwise rotation requires.

If a delivered board revision differs from the catalog, stop before wiring it. Photograph both sides next to a ruler, update the physical order/drawing, and run the verifier. An ASIN remaining the same is not proof that a marketplace seller has not revised a PCB.
