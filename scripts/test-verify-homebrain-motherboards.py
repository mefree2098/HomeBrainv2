#!/usr/bin/env python3
"""Regression tests for dedicated HomeBrain motherboard safety contracts."""

from __future__ import annotations

import copy
import importlib.util
import json
import re
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERIFIER = ROOT / "scripts/verify-homebrain-motherboards.py"
DESIGN = ROOT / "hardware/homebrain-sensors/motherboards/motherboard-designs.json"


def load_verifier():
    spec = importlib.util.spec_from_file_location("motherboard_verifier_tests", VERIFIER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {VERIFIER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


verify = load_verifier()


class MotherboardVerifierTests(unittest.TestCase):
    def test_jlcpcb_export_and_mutations(self) -> None:
        for board in self.catalog["boards"]:
            with self.subTest(board=board["id"]), tempfile.TemporaryDirectory() as folder:
                target = Path(folder)
                source = verify.DEFAULT_OUTPUT / board["id"]
                shutil.copytree(source / "gerbers", target / "gerbers")
                prefix = f"homebrain-{board['id']}-motherboard"
                archive_path = target / f"{prefix}-jlcpcb-import-check.zip"
                design = verify.generator.board_design(self.catalog, board)
                layout = json.loads((source / "layout.json").read_text())
                verify.generator.write_jlcpcb_zip(target / "gerbers", archive_path, prefix)
                verify.verify_jlcpcb_zip(design, target, layout)
                first_bytes = archive_path.read_bytes()
                verify.generator.write_jlcpcb_zip(target / "gerbers", archive_path, prefix)
                self.assertEqual(first_bytes, archive_path.read_bytes())
                with zipfile.ZipFile(archive_path) as archive:
                    original = {name: archive.read(name) for name in archive.namelist()}
                bad_name = dict(original)
                bad_name[f"{prefix}.gbr"] = bad_name.pop(f"{prefix}.GTL")
                bad_copper = dict(original)
                bad_copper[f"{prefix}.GTL"] = original[f"{prefix}.GBL"]
                bad_mode = dict(original)
                bad_mode[f"{prefix}.GKO"] = original[f"{prefix}.GKO"].replace(b"G01*\n", b"")
                bad_drill = dict(original)
                bad_drill[f"{prefix}-PTH.XLN"] = original[f"{prefix}-PTH.XLN"].replace(b"C1.000", b"C1.100")
                bad_outline = dict(original)
                bad_outline[f"{prefix}.GKO"] = original[f"{prefix}.GKO"].replace(b"Y0000000000D02*", b"Y0001000000D02*", 1)
                for mutation in (bad_name, bad_copper, bad_mode, bad_drill, bad_outline):
                    with zipfile.ZipFile(archive_path, "w") as archive:
                        for name, content in mutation.items():
                            archive.writestr(name, content)
                    with self.assertRaises(ValueError):
                        verify.verify_jlcpcb_zip(design, target, layout)

    def test_silkscreen_excludes_exposed_pads_and_moves_pin_one_marks(self) -> None:
        for board in self.catalog["boards"]:
            design = verify.generator.board_design(self.catalog, board)
            pads = verify.generator.derive_pads(design)
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "silk.gbr"
                verify.generator.write_silkscreen(path, design, pads)
                text = path.read_text()
            clear = text.split("%LPC*%", 1)[1].split("%LPD*%", 1)[0]
            self.assertEqual(clear.count("D03*"), len(pads))
            for pad in pads:
                position = f"X{verify.generator.base.gerber_coord(pad.x)}Y{verify.generator.base.gerber_coord(pad.y)}D03*"
                self.assertIn(position, clear)
                self.assertNotIn("D12*\n" + position, text)

    def test_previous_radar_header_offset_is_rejected(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        radar = next(m for m in catalog["boards"][1]["modules"] if m["ref"] == "J3")
        radar["header"]["origin"] = [60.0, 28.92]
        with self.assertRaisesRegex(ValueError, "differs from manufacturer STEP"):
            verify.verify_catalog(catalog)

    def test_previous_mirrored_battery_geometry_is_rejected_by_manufacturer_cad(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        offsets = catalog["xiao_footprint"]["bottom_battery_pad_offsets_usb_top"]
        offsets["BAT-"][0] *= -1
        offsets["BAT+"][0] *= -1
        with self.assertRaisesRegex(ValueError, "differs from manufacturer CAD"):
            verify.verify_catalog(catalog)

    def test_drill_coordinates_and_diameters_are_verified(self) -> None:
        design = verify.generator.board_design(self.catalog, self.catalog["boards"][0])
        pads = verify.generator.derive_pads(design)
        layout = {"pads": [vars(pad) for pad in pads], "vias": []}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.drl"
            verify.generator.write_drill(path, pads, [])
            text = path.read_text()
        self.assertEqual(verify.verify_drill(text, layout), len(pads))
        for changed in [re.sub(r"X-?\d+\.\d+", "X999.000", text, count=1), text.replace("C1.000", "C1.100"), text.replace("METRIC", "INCH")]:
            with self.assertRaises(ValueError):
                verify.verify_drill(changed, layout)

    @classmethod
    def setUpClass(cls) -> None:
        cls.catalog = json.loads(DESIGN.read_text(encoding="utf-8"))

    def test_checked_in_catalog_passes_contract(self) -> None:
        verify.verify_catalog(copy.deepcopy(self.catalog))
        verify.firmware_contract()

    def test_reversed_pms_uart_is_rejected(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        atmosphere = catalog["boards"][0]
        pms = next(module for module in atmosphere["modules"] if module["ref"] == "J4")
        pms["header"]["pins"][3][2], pms["header"]["pins"][4][2] = pms["header"]["pins"][4][2], pms["header"]["pins"][3][2]
        with self.assertRaisesRegex(ValueError, "physical label/net order mismatch"):
            verify.verify_catalog(catalog)

    def test_reversed_climate_battery_fill_is_rejected(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        climate = catalog["boards"][2]
        climate["xiao_battery_fill_pads"][0]["net"] = "BAT+"
        climate["xiao_battery_fill_pads"][1]["net"] = "GND"
        with self.assertRaisesRegex(ValueError, "polarity reversed"):
            verify.verify_catalog(catalog)

    def test_missing_radar_overhang_is_rejected(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        presence = catalog["boards"][1]
        radar = next(module for module in presence["modules"] if module["ref"] == "J3")
        radar["overhang"] = False
        with self.assertRaisesRegex(ValueError, "Radar must overhang"):
            verify.verify_catalog(catalog)

    def test_headered_sensor_must_use_its_factory_pins(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        atmosphere = catalog["boards"][0]
        bme680 = next(module for module in atmosphere["modules"] if module["ref"] == "J1")
        bme680["header"]["installed_on_module"] = False
        with self.assertRaisesRegex(ValueError, "factory-installed header contract missing"):
            verify.verify_catalog(catalog)

    def test_pms_breakout_must_remain_direct_soldered(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        atmosphere = catalog["boards"][0]
        pms = next(module for module in atmosphere["modules"] if module["ref"] == "J4")
        pms["mount"] = "wire harness"
        with self.assertRaisesRegex(ValueError, "insert/solder/trim instructions incomplete"):
            verify.verify_catalog(catalog)

    def test_pms_breakout_must_not_require_an_add_on_header(self) -> None:
        catalog = copy.deepcopy(self.catalog)
        atmosphere = catalog["boards"][0]
        atmosphere["assembly_parts"] = [{"ref": "H1"}]
        with self.assertRaisesRegex(ValueError, "must not require an add-on header"):
            verify.verify_catalog(catalog)


if __name__ == "__main__":
    unittest.main()
