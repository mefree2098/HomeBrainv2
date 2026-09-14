# HomeBrain physical wiring diagram generator

This active project mechanism turns the reviewed physical hardware catalog into the three wiring SVG/PNG pairs. It exists because every board must retain its exact physical pin order across revisions; the validator rejects generic four-pin substitutions, missing purchased parts, undeclared endpoints, lost no-connect markings, incorrect XIAO left/right-row routing, lost 90° sensor rotations, and the superseded one-resistor Climate divider. For Atmosphere it also enforces a physically centered XIAO, 16 distinct point-to-point jumper paths, unique `W01`–`W16` identifiers/colors, matching visible tags, and exact source/target metadata.

Generate:

```bash
python3 scripts/generate-homebrain-wiring-diagrams.py
```

Verify the checked artifacts, regenerate twice, and compare all six byte streams:

```bash
python3 scripts/verify-homebrain-wiring-diagrams.py --repeat
```

The mechanism was promoted to `active` after its first later real revision: rotating the SCD41/VEML7700 views, separating every physical pin run, and making both XIAO header-row exits explicit and machine-verified.
