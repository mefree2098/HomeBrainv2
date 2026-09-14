#!/usr/bin/env python3
"""Regression tests for the HomeBrain enclosure verifier's design contracts."""

from __future__ import annotations

import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATH = ROOT / "scripts" / "verify-homebrain-enclosures.py"
FIXTURE_PATH = ROOT / "hardware" / "homebrain-sensors" / "enclosures" / "fixtures" / "atmosphere-blocked-pms5003-airflow.json"
BLOCKED_PILOT_FIXTURE_PATH = ROOT / "hardware" / "homebrain-sensors" / "enclosures" / "fixtures" / "blocked-screw-pilot-gusset.json"
CONFIG_PATH = ROOT / "hardware" / "homebrain-sensors" / "enclosures" / "enclosure-profiles.json"
MOTHERBOARD_CONFIG_PATH = ROOT / "hardware" / "homebrain-sensors" / "motherboards" / "motherboard-designs.json"

SPEC = importlib.util.spec_from_file_location("homebrain_enclosure_verifier", VERIFIER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load verifier: {VERIFIER_PATH}")
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


class Pms5003AirflowContractTests(unittest.TestCase):
    def test_rejects_old_blocked_port_orientation(self) -> None:
        profile = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        with self.assertRaisesRegex(
            VERIFIER.VerificationError,
            "must define a dedicated exterior airflow contract",
        ):
            VERIFIER.verify_pms5003_airflow_spec(profile)

    def test_accepts_current_separated_intake_and_exhaust(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        profile = next(item for item in config["profiles"] if item["id"] == "atmosphere")
        airflow = VERIFIER.verify_pms5003_airflow_spec(profile)
        self.assertIsNotNone(airflow)
        assert airflow is not None
        self.assertEqual(airflow["port_face"]["side"], -1)
        self.assertEqual(airflow["intake"]["count"], 4)
        self.assertEqual(airflow["exhaust"]["count"], 5)
        self.assertGreaterEqual(
            airflow["exhaust"]["nominal_free_area_mm2"],
            3.14159 * (airflow["fan_opening_diameter_mm"] / 2.0) ** 2,
        )


class ScrewBossAndMotherboardSupportContractTests(unittest.TestCase):
    def test_rejects_old_gusset_that_sealed_pilot_entrance(self) -> None:
        fixture = json.loads(BLOCKED_PILOT_FIXTURE_PATH.read_text(encoding="utf-8"))
        fixture["fastener"].pop("quantity_per_case", None)
        fixture["fastener"].update(
            quantity_per_case_lid=4,
            quantity_per_motherboard=4,
            total_quantity=24,
        )
        with self.assertRaisesRegex(
            VERIFIER.VerificationError,
            "gusset overlaps the screw pilot",
        ):
            VERIFIER.verify_fastener_spec(fixture["fastener"])

    def test_all_cases_require_four_posts_and_two_eighteen_millimeter_rear_walls(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        mount = config["motherboard_mount"]
        VERIFIER.verify_motherboard_mount_spec(mount)
        self.assertEqual(mount["rear_wall_height_mm"], 18.0)
        self.assertEqual(mount["rear_wall_center_gap_mm"], 18.0)
        for profile in config["profiles"]:
            expected = VERIFIER.expected_motherboard_mount(profile, mount)
            self.assertEqual(len(expected["post_centers_mm"]), 4)
            self.assertEqual(len(expected["rear_wall_centers_mm"]), 2)
            self.assertEqual(expected["rear_wall_size_mm"][2], 18.0)

    def test_rejects_three_screw_motherboard_contract(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        profile = json.loads(json.dumps(config["profiles"][0]))
        profile["components"][0]["mounting_holes"].pop()
        with self.assertRaisesRegex(VERIFIER.VerificationError, "four mounting holes"):
            VERIFIER.verify_component_layout(
                profile,
                config["fastener"],
                config["xiao_radio"],
                config["motherboard_mount"],
            )

    def test_rejects_flush_module_height_after_factory_headers_are_confirmed(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        catalog = json.loads(MOTHERBOARD_CONFIG_PATH.read_text(encoding="utf-8"))
        profile = json.loads(json.dumps(config["profiles"][0]))
        board = catalog["boards"][0]
        bme = next(component for component in profile["components"] if component.get("source_ref") == "J1")
        bme["bottom_z"] = 13.6
        with self.assertRaisesRegex(VERIFIER.VerificationError, "wrong factory-header Z height"):
            VERIFIER.verify_case_matches_motherboard_design(
                profile,
                board,
                config["motherboard_mount"],
                config["xiao_radio"],
            )

    def test_rejects_old_climate_usb_height_with_factory_xiao_headers(self) -> None:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        catalog = json.loads(MOTHERBOARD_CONFIG_PATH.read_text(encoding="utf-8"))
        profile = json.loads(json.dumps(config["profiles"][2]))
        board = catalog["boards"][2]
        profile["usb_cutout"]["center_z"] = 16.5
        with self.assertRaisesRegex(VERIFIER.VerificationError, "USB opening Z"):
            VERIFIER.verify_case_matches_motherboard_design(
                profile,
                board,
                config["motherboard_mount"],
                config["xiao_radio"],
            )


if __name__ == "__main__":
    unittest.main()
