# HomeBrain carrier generator

This experimental mechanism turns the structured carrier contract into deterministic two-layer Gerbers, Excellon drill data, a fabrication ZIP, BOM, schematic, assembly guide, and three final keyed-harness guides.

Generate and verify:

```bash
python3 scripts/generate-homebrain-carrier.py
python3 scripts/test-verify-homebrain-carrier.py
python3 scripts/verify-homebrain-carrier.py --repeat
```

The independent verifier checks the official XIAO socket pitch/row spacing, keyed-port pin contracts, UART crossing, battery divider, every endpoint's copper connectivity, foreign-net clearance, board-edge clearance, antenna copper keep-out, stitched two-layer ground-plane reachability and island removal, Gerber/drill/ZIP structure, guide structure, hashes, and two-run byte determinism. The negative fixture proves a TX/RX reversal is rejected.
