# HomeBrain enclosure generator

This experimental project mechanism keeps the Atmosphere, Presence, and Climate dedicated-motherboard cases repeatable without becoming a general CAD framework.

Generate:

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --python scripts/generate-homebrain-enclosures.py \
  -- \
  --config hardware/homebrain-sensors/enclosures/enclosure-profiles.json \
  --output hardware/homebrain-sensors/enclosures/generated
```

Verify the checked artifacts and deterministic STL output:

```bash
python3 scripts/test-verify-homebrain-enclosures.py
python3 scripts/verify-homebrain-enclosures.py --repeat
```

The verifier independently ties case geometry to `motherboard-designs.json`, including board envelopes, all twelve transformed PCB drill coordinates, XIAO/USB locations, and soldered-module footprints. It then checks component and lid-boss clearance, all twelve actual PCB-post entrances and blind depths, all twelve body lid-pilot entrances and blind depths, all twelve lid clearance/recess geometries, six 18 mm USB-load walls, three antenna keep-outs, the PMS5003 50 × 20.9 mm port-plane alignment, separate intake/exhaust areas, all nine open grille slots, the anti-recirculation divider, watertight binary STL structure, exact envelopes, previews, Blender source integrity, hashes, staleness, and repeatability.

The old center-crossing screw-gusset and blocked PMS5003 airflow layouts remain rejection fixtures. Actual-size PCB paper templates remain the required safeguard against Amazon seller footprint revisions before either boards or cases are ordered/printed.
