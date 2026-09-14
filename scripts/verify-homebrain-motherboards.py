#!/usr/bin/env python3
"""Independently verify dedicated HomeBrain motherboard geometry and artifacts."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
from collections import Counter
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DESIGN = ROOT / "hardware/homebrain-sensors/motherboards/motherboard-designs.json"
DEFAULT_OUTPUT = ROOT / "hardware/homebrain-sensors/motherboards/generated"
GENERATOR = ROOT / "scripts/generate-homebrain-motherboards.py"
FIRMWARE_HEADER = ROOT / "embedded/homebrain-sensor/include/HomeBrainSensor.h"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


generator = load_module("homebrain_motherboard_generator", GENERATOR)
carrier_verify = load_module("homebrain_carrier_verifier", ROOT / "scripts/verify-homebrain-carrier.py")


def verify_seeed_source(xiao: dict) -> None:
    """Compare against archived manufacturer CAD, not a duplicated golden pin map."""
    references = ROOT / "hardware/homebrain-sensors/motherboards/references"
    with zipfile.ZipFile(references / "seeed-xiao-c6.zip") as archive:
        pcb = archive.read(next(name for name in archive.namelist() if name.endswith(".kicad_pcb"))).decode()
    footprints = {}
    for block in re.split(r'\n\t\(footprint ', pcb):
        reference = re.search(r'\(property "Reference" "([^"]+)"', block)
        if reference:
            footprints[reference[1]] = block
    def position(block):
        match = re.search(r'\(at ([-\d.]+) ([-\d.]+)', block)
        require(match is not None, "Manufacturer CAD position missing")
        return float(match[1]), float(match[2])
    cx, cy = position(footprints["U2"])
    for label, ref, net in [("BAT-", "TP10", "GND"), ("BAT+", "TP9", "VBAT")]:
        block = footprints[ref]
        require(re.search(r'\(net \d+ "' + net + r'"\)', block) is not None, "Manufacturer battery pad net differs")
        px, py = position(block)
        # KiCad screen Y points down. USB originally points right. This maps
        # D0 to the LEFT of USB in a TOP view; negating dy would mirror the PCB.
        transformed = [round(py - cy, 4), round(px - cx, 4)]
        require(xiao["bottom_battery_pad_offsets_usb_top"][label] == transformed, f"Official XIAO {label} offset differs from manufacturer CAD")
    with zipfile.ZipFile(references / "seeed-footprints.zip") as archive:
        footprint = archive.read("Seeed_Studio_XIAO_Series.pretty/XIAO-ESP32-C6-DIP.kicad_mod").decode()
    holes = re.findall(r'\(pad "(\d+)" thru_hole circle\s*\(at ([-\d.]+) ([-\d.]+)', footprint)
    require(len(holes) == 14, "Manufacturer XIAO DIP must have 14 holes")
    for number, px, py in holes:
        number = int(number)
        expected_x = (-1 if number <= 7 else 1) * xiao["row_spacing"] / 2
        expected_y = (4 - number if number <= 7 else number - 11) * xiao["pin_pitch"]
        require(abs(float(py) - expected_x) < 1e-6 and abs(float(px) - expected_y) < 1e-6, "XIAO header disagrees with official DIP footprint")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design", type=Path, default=DEFAULT_DESIGN)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--repeat", action="store_true")
    parser.add_argument("--require-release", action="store_true", help="Fail unless manufacturing release is approved")
    return parser.parse_args()


def verify_hilink_source(module: dict) -> None:
    """Check header placement using the manufacturer's archived STEP hole axes."""
    path = ROOT / "hardware/homebrain-sensors/motherboards/references/hlk-ld2410c-3d.zip"
    with zipfile.ZipFile(path) as archive:
        step = archive.read("HLK-LD2410C.step").decode()
    entities = dict(re.findall(r'#(\d+)\s*=\s*([^;]+);', step))
    def point(index):
        value = entities[str(index)]
        match = re.fullmatch(r"CARTESIAN_POINT\('',\(([^)]+)\)\)", value)
        require(match is not None, "Hi-Link STEP point definition differs")
        return tuple(float(v) for v in match[1].split(','))
    # Entity references identify the Board solid in this archived STEP revision.
    # Read coordinates, rather than storing rounded copies in the checker.
    left, bottom, _ = point(243)
    right, _, _ = point(391)
    _, top, _ = point(284)
    bottom = point(412)[1]
    x1, y1, x2, y2 = module["outline"]
    require(abs((x2-x1)-(top-bottom)) < 0.001 and abs((y2-y1)-(right-left)) < 0.001, "Radar outline differs from STEP")
    hole_centres = sorted({point(index)[:2] for index in [510, 543, 576, 609, 642]})
    header = module["header"]
    for i, (px, py) in enumerate(hole_centres):
        expected = (x1 + top-py, y1 + px-left)
        actual = (header["origin"][0]+i*header["step"][0], header["origin"][1]+i*header["step"][1])
        require(all(abs(a-b) < 0.0001 for a,b in zip(actual, expected)), "Radar header differs from manufacturer STEP")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"{path}: invalid PNG")
    return struct.unpack(">II", data[16:24])


EXPECTED_MODULE_NETS = {
    "atmosphere": {
        "J1": [("VCC", "3V3"), ("GND", "GND"), ("SCL", "SCL"), ("SDA", "SDA"), ("SDO", "NC_BME_SDO"), ("CS", "NC_BME_CS")],
        "J2": [("GND", "GND"), ("VDD", "3V3"), ("SCL", "SCL"), ("SDA", "SDA")],
        "J3": [("VIN", "3V3"), ("3Vo", "NC_VEML_3VO"), ("GND", "GND"), ("SCL", "SCL"), ("SDA", "SDA")],
        "J4": [("VCC(+5V)", "VBUS"), ("GND", "GND"), ("SET", "NC_PMS_SET"), ("RXD", "TX"), ("TXD", "RX"), ("RESET", "NC_PMS_RESET"), ("NC1", "NC_PMS_1"), ("NC2", "NC_PMS_2")],
    },
    "presence": {
        "J1": [("+", "D3"), ("OUT", "D2"), ("-", "GND")],
        "J2": [("VIN", "3V3"), ("3Vo", "NC_VEML_3VO"), ("GND", "GND"), ("SCL", "SCL"), ("SDA", "SDA")],
        "J3": [("TX", "RX"), ("RX", "TX"), ("OUT", "NC_RADAR_OUT"), ("GND", "GND"), ("VCC", "VBUS")],
    },
    "climate": {
        "J1": [("+", "D3"), ("OUT", "D2"), ("-", "GND")],
        "J2": [("BAT+", "BAT+"), ("BAT-", "GND")],
        "R1": [("BAT+", "BAT+"), ("A0", "A0")],
        "R2": [("GND", "GND"), ("A0", "A0")],
    },
}

EXPECTED_FACTORY_HEADERED_MODULES = {
    "atmosphere": {"J1", "J2", "J3", "J4"},
    "presence": {"J1", "J2", "J3"},
    "climate": {"J1"},
}


def verify_catalog(catalog: dict) -> None:
    require(catalog["schema_version"] == 1, "Unsupported motherboard schema")
    require([board["id"] for board in catalog["boards"]] == ["atmosphere", "presence", "climate"], "Dedicated board set changed")
    require(catalog["fabrication_defaults"]["layers"] == 2 and catalog["fabrication_defaults"]["thickness"] == 1.6, "Fabrication stack changed")
    require(catalog["fabrication_defaults"]["minimum_trace_width"] >= 0.4, "Trace width below 0.4 mm")
    require(catalog["fabrication_defaults"]["power_trace_width"] >= 0.8, "Power trace width below 0.8 mm")
    require(catalog["fabrication_defaults"]["minimum_clearance"] >= 0.25, "Copper clearance below 0.25 mm")
    xiao = catalog["xiao_footprint"]
    require(xiao["board_size"] == [17.8, 21.0] and xiao["row_spacing"] == 15.24 and xiao["pin_pitch"] == 2.54, "XIAO official footprint geometry changed")
    verify_seeed_source(xiao)
    require("factory-installed 1x7 straight male header rows through U1" in xiao["mounting_method"], "XIAO factory-header mounting contract changed")
    require("solder from the motherboard underside" in xiao["mounting_method"] and "trim excess pin length" in xiao["mounting_method"], "XIAO solder/trim sequence is incomplete")
    for board in catalog["boards"]:
        require(len(board["mounting_holes"]) == 4, f"{board['id']}: expected four motherboard mounting holes")
        require(board["size"] in ([80.0, 64.0], [64.0, 54.0], [58.0, 48.0]), f"{board['id']}: unexpected board envelope")
        modules = {module["ref"]: module for module in board["modules"]}
        require(set(modules) == set(EXPECTED_MODULE_NETS[board["id"]]), f"{board['id']}: module set changed")
        for ref, expected in EXPECTED_MODULE_NETS[board["id"]].items():
            actual = [(pin[1], pin[2]) for pin in modules[ref]["header"]["pins"]]
            require(actual == expected, f"{board['id']} {ref}: physical label/net order mismatch: {actual}")
        for ref in EXPECTED_FACTORY_HEADERED_MODULES[board["id"]]:
            header = modules[ref]["header"]
            require(header.get("installed_on_module") is True, f"{board['id']} {ref}: factory-installed header contract missing")
            require(header.get("assembly_method") == "through-hole-insert-solder-inspect-trim", f"{board['id']} {ref}: header assembly method changed")
            mount = modules[ref]["mount"]
            require("factory-installed 1x" in mount and "solder from the motherboard underside" in mount and "trim" in mount, f"{board['id']} {ref}: insert/solder/trim instructions incomplete")
        require("factory-installed 1x7 male header rows through U1" in board["xiao_assembly"], f"{board['id']}: XIAO does not use its factory header rows")
        if board["id"] == "atmosphere":
            require(modules["J4"]["asin"] == "B0BG612GB2", "Atmosphere J4 is not the purchased red PMS breakout")
            require("factory-installed 1x8 male header through J4" in modules["J4"]["mount"], "PMS breakout is not mounted by its photographed factory male header")
            require("solder from the motherboard underside" in modules["J4"]["mount"] and "then trim excess pin length" in modules["J4"]["mount"], "PMS breakout solder/trim sequence is incomplete")
            require(not board.get("assembly_parts"), "Atmosphere must not require an add-on header for the photographed PMS breakout")
            require(len(board["external_connections"]) == 2 and board["external_connections"][0]["name"] == "PMS5003 factory keyed cable", "PMS external cable contract changed")
        if board["id"] == "presence":
            require(modules["J3"].get("overhang") is True, "Radar must overhang motherboard as designed")
            verify_hilink_source(modules["J3"])
        if board["id"] == "climate":
            battery = {item["label"]: item for item in board["xiao_battery_fill_pads"]}
            require(set(battery) == {"BAT-", "BAT+"}, "Climate lacks direct XIAO battery-post pads")
            require(battery["BAT-"]["net"] == "GND" and battery["BAT+"]["net"] == "BAT+", "Climate battery-post polarity reversed")
            for label, item in battery.items():
                require(item["offset_from_xiao_center"] == xiao["bottom_battery_pad_offsets_usb_top"][label], "Climate battery post differs from manufacturer-derived offset")
            require(all(item.get("connection_method") == "rigid-post-through-hole" for item in battery.values()), "Climate battery pads do not use rigid through-hole posts")
            require(all("saved 200 kOhm resistor lead" in item["assembly"] for item in battery.values()), "Climate battery post material/sequence is incomplete")
            require("factory-installed 1x7 male header rows through U1" in board["xiao_assembly"] and "rigid posts" in board["xiao_assembly"], "Climate XIAO factory headers and battery posts are not assembled together")
    fastener = catalog["assembly_fastener"]
    require(fastener["home_depot_model"] == "Everbilt 824681" and fastener["total_screws"] == 24, "Common fastener contract changed")


def firmware_contract() -> None:
    text = FIRMWARE_HEADER.read_text(encoding="utf-8")
    expected = {
        "PIN_BATTERY_ADC": "D0", "PIN_SERVICE": "D1", "PIN_DHT_DATA": "D2", "PIN_DHT_POWER": "D3",
        "PIN_I2C_SDA": "D4", "PIN_I2C_SCL": "D5", "PIN_UART_TX": "D6", "PIN_UART_RX": "D7",
    }
    for constant, pin in expected.items():
        require(f"constexpr uint8_t {constant} = {pin};" in text, f"Firmware {constant} no longer uses {pin}")


def expected_pad_map(design: dict) -> dict[str, tuple[float, float, str, float, float]]:
    return {pad.key: (round(pad.x, 4), round(pad.y, 4), pad.net, pad.diameter, pad.drill) for pad in generator.derive_pads(design)}


def verify_geometry(design: dict, layout: dict) -> dict:
    expected = expected_pad_map(design)
    pads = {pad["key"]: pad for pad in layout["pads"]}
    require(set(pads) == set(expected), f"{design['id']}: generated pad set differs")
    for key, values in expected.items():
        pad = pads[key]
        actual = (round(pad["x"], 4), round(pad["y"], 4), pad["net"], pad["diameter"], pad["drill"])
        require(actual == values, f"{design['id']} {key}: pad position/net/drill mismatch")
    width, height = design["board"]["width"], design["board"]["height"]
    edge = design["board"]["edge_clearance"]
    for pad in pads.values():
        radius = pad["diameter"] / 2.0
        require(edge <= pad["x"] - radius and pad["x"] + radius <= width - edge, f"{design['id']} {pad['key']}: pad violates X edge clearance")
        require(edge <= pad["y"] - radius and pad["y"] + radius <= height - edge, f"{design['id']} {pad['key']}: pad violates Y edge clearance")
    primitives, _ = carrier_verify.layout_primitives(layout)
    clearance = design["board"]["minimum_clearance"]
    minimum = float("inf")
    checked = 0
    for index, first in enumerate(primitives):
        for second in primitives[index + 1:]:
            if first.layer != second.layer or first.net == second.net:
                continue
            checked += 1
            gap = carrier_verify.primitive_distance(first, second) - first.radius - second.radius
            minimum = min(minimum, gap)
            require(gap >= clearance - 1e-6, f"{design['id']}: DRC {first.key}/{second.key} gap {gap:.4f} mm")
    bounds = (*design["board"]["antenna_copper_keepout"]["min"], *design["board"]["antenna_copper_keepout"]["max"])
    for primitive in primitives:
        if primitive.kind == "circle":
            require(carrier_verify.rect_distance(primitive.start, bounds) >= primitive.radius - 1e-9, f"{design['id']} {primitive.key}: copper enters XIAO antenna keepout")
        else:
            require(not carrier_verify.segment_intersects_expanded_rect(primitive.start, primitive.end, bounds, primitive.radius), f"{design['id']} {primitive.key}: trace enters XIAO antenna keepout")
    by_net: dict[str, list] = {}
    for primitive in primitives:
        by_net.setdefault(primitive.net, []).append(primitive)
    for net in design["nets"]:
        if net == "GND":
            continue
        items = by_net[net]
        dsu = carrier_verify.DisjointSet([item.key for item in items])
        through: dict[str, list] = {}
        for item in items:
            if item.through_id:
                through.setdefault(item.through_id, []).append(item)
        for group in through.values():
            for item in group[1:]:
                dsu.union(group[0].key, item.key)
        for index, first in enumerate(items):
            for second in items[index + 1:]:
                if first.layer == second.layer and carrier_verify.primitive_distance(first, second) <= first.radius + second.radius + 1e-6:
                    dsu.union(first.key, second.key)
        roots = {dsu.find(f"{key}:F.Cu") for key in layout["net_endpoints"][net]}
        require(len(roots) == 1, f"{design['id']} {net}: endpoints split across {len(roots)} copper islands")
    ground_report = carrier_verify.verify_ground_plane(design, primitives, pads, layout["ground_plane_voids"])
    for segment in layout["segments"]:
        require(not segment["net"].startswith("NC_"), f"{design['id']}: NC pad was routed")
    # A #4 pan head has approximately a 2.8 mm radius; enforce 3.0 mm component clearance.
    for hole in design["mounting_holes"]:
        for module in design["modules"]:
            x1, y1, x2, y2 = module["outline"]
            distance = carrier_verify.rect_distance(tuple(hole), (x1, y1, x2, y2))
            require(distance >= 3.0, f"{design['id']} {module['ref']}: module blocks access to a motherboard screw")
    return {"primitive_count": len(primitives), "different_net_pairs_checked": checked, "minimum_clearance_mm": round(minimum, 4), "ground_plane": ground_report}


def verify_drill(text: str, layout: dict) -> int:
    tools = {}
    current = None
    actual = []
    require("METRIC" in text.splitlines() and "G90" in text.splitlines(), "Drill units/absolute mode missing")
    for line in text.splitlines():
        definition = re.fullmatch(r"T(\d+)C(\d+\.\d+)", line)
        selection = re.fullmatch(r"T(\d+)", line)
        hit = re.fullmatch(r"X(-?\d+\.\d+)Y(-?\d+\.\d+)", line)
        if definition:
            tools[definition[1]] = float(definition[2])
        elif selection:
            require(selection[1] in tools, "Unknown drill tool")
            current = tools[selection[1]]
        elif hit:
            require(current is not None, "Drill hit without selected tool")
            actual.append((float(hit[1]), float(hit[2]), current))
        elif line.startswith("X"):
            raise ValueError("Drill coordinates must use explicit decimal millimetres")
    expected = [(round(hole["x"], 3), round(hole["y"], 3), round(hole["drill"], 3)) for hole in [*layout["pads"], *layout["vias"]]]
    require(Counter(actual) == Counter(expected), "Drill position/diameter mismatch")
    return len(actual)


def verify_jlcpcb_zip(design: dict, board_dir: Path, layout: dict) -> None:
    prefix = f"homebrain-{design['id']}-motherboard"
    mapping = {
        "GTL": "F_Cu.gbr", "GBL": "B_Cu.gbr", "GTS": "F_Mask.gbr",
        "GBS": "B_Mask.gbr", "GTO": "F_Silkscreen.gbr", "GKO": "Edge_Cuts.gbr", "XLN": "PTH.drl",
    }
    def geometry_commands(text):
        return [line for line in text.splitlines() if not line.startswith(("G04", "%TF.")) and line != "G01*"]
    def filename(extension):
        return f"{prefix}-PTH.XLN" if extension == "XLN" else f"{prefix}.{extension}"
    with zipfile.ZipFile(board_dir / f"{prefix}-jlcpcb-import-check.zip") as archive:
        require(len(archive.namelist()) == 7 and set(archive.namelist()) == {filename(ext) for ext in mapping}, "JLCPCB layer filenames differ or are duplicated")
        for extension, suffix in mapping.items():
            actual = archive.read(filename(extension))
            original = (board_dir / "gerbers" / f"{prefix}-{suffix}").read_bytes()
            if extension == "XLN":
                text = actual.decode("ascii")
                lines = text.splitlines()
                require(";TYPE=PLATED" in lines and lines.index("G90") < lines.index("%"), "JLCPCB drill plating/absolute header missing")
                def drill_commands(content):
                    return [line for line in content.splitlines() if not line.startswith(";") and line != "G90"]
                require(drill_commands(text) == drill_commands(original.decode("ascii")), "JLCPCB drill data changed")
                verify_drill(text, layout)
                continue
            text = actual.decode("ascii")
            require(geometry_commands(text) == geometry_commands(original.decode("ascii")), f"JLCPCB {extension} geometry changed")
            lines = text.splitlines()
            require(lines.count("G01*") == 1 and lines.index("G01*") < next(i for i, line in enumerate(lines) if line.startswith("X")), "Explicit linear interpolation missing before geometry")
            require("%TF." not in text, "JLCPCB compatibility export must not require X2 metadata")
            if extension == "GKO":
                points = [(int(x) / 1e6, int(y) / 1e6) for x, y in re.findall(r"X(-?\d+)Y(-?\d+)D0[12]\*", text)]
                width, height = design["board"]["width"], design["board"]["height"]
                require(points == [(0, 0), (width, 0), (width, 0), (width, height), (width, height), (0, height), (0, height), (0, 0)], "JLCPCB outline is not the closed full-size board rectangle")


def verify_fabrication(design: dict, board_dir: Path, layout: dict) -> dict:
    prefix = f"homebrain-{design['id']}-motherboard"
    expected = {
        f"{prefix}-F_Cu.gbr", f"{prefix}-B_Cu.gbr", f"{prefix}-F_Mask.gbr", f"{prefix}-B_Mask.gbr",
        f"{prefix}-F_Silkscreen.gbr", f"{prefix}-Edge_Cuts.gbr", f"{prefix}-PTH.drl", f"{prefix}-job.gbrjob",
    }
    gerbers = board_dir / "gerbers"
    require({path.name for path in gerbers.iterdir() if path.is_file()} == expected, f"{design['id']}: Gerber directory contents differ")
    for path in gerbers.glob("*.gbr"):
        carrier_verify.parse_gerber(path)
    for path in [*gerbers.glob("*.gbr"), *gerbers.glob("*.drl")]:
        require("HomeBrain carrier" not in path.read_text(encoding="ascii"), f"{design['id']}: obsolete carrier branding remains in {path.name}")
    drill_hits = verify_drill((gerbers / f"{prefix}-PTH.drl").read_text(encoding="ascii"), layout)
    require(drill_hits == len(layout["pads"]) + len(layout["vias"]), f"{design['id']}: drill hit count mismatch")
    zip_path = board_dir / f"{prefix}-gerbers.zip"
    with zipfile.ZipFile(zip_path) as archive:
        require(set(archive.namelist()) == expected, f"{design['id']}: fabrication ZIP contents differ")
        for name in expected:
            require(archive.read(name) == (gerbers / name).read_bytes(), f"{design['id']}: ZIP {name} differs from verified file")
    verify_jlcpcb_zip(design, board_dir, layout)
    assembly = board_dir / f"{prefix}-assembly"
    schematic = board_dir / f"{prefix}-schematic"
    require(png_size(assembly.with_suffix(".png")) == (2000, 1250), f"{design['id']}: assembly PNG dimensions differ")
    require(png_size(schematic.with_suffix(".png")) == (1900, 1150), f"{design['id']}: schematic PNG dimensions differ")
    for path in (assembly.with_suffix(".svg"), schematic.with_suffix(".svg")):
        require("<metadata>" in path.read_text(encoding="utf-8"), f"{path.name}: structured metadata missing")
    fit_check = board_dir / f"{prefix}-fit-check.svg"
    fit_text = fit_check.read_text(encoding="utf-8")
    require(f'width="{design["board"]["width"]}mm"' in fit_text, f"{design['id']}: fit-check width is not actual size")
    require(f'height="{design["board"]["height"]}mm"' in fit_text, f"{design['id']}: fit-check height is not actual size")
    require("<metadata>" in fit_text and "actual-size-fit-check" in fit_text, f"{design['id']}: fit-check metadata missing")
    bom_text = (board_dir / "assembly-bom.csv").read_text(encoding="utf-8")
    if design["id"] == "atmosphere":
        require("factory-installed 1x8 male header through J4" in bom_text, "Atmosphere BOM omits the photographed PMS breakout header assembly")
        require("B00U8OCENY" not in bom_text and "breakaway male header" not in bom_text, "Atmosphere BOM still requests an unnecessary add-on header")
    return {"drill_hits": drill_hits, "zip_bytes": zip_path.stat().st_size}


def compare_trees(first: Path, second: Path) -> None:
    first_files = {path.relative_to(first).as_posix(): sha256(path) for path in first.rglob("*") if path.is_file()}
    second_files = {path.relative_to(second).as_posix(): sha256(path) for path in second.rglob("*") if path.is_file()}
    require(first_files == second_files, f"Motherboard generator is not deterministic: {set(first_files) ^ set(second_files)}")


def main() -> int:
    args = parse_args()
    design_path, output = args.design.resolve(), args.output.resolve()
    catalog = json.loads(design_path.read_text(encoding="utf-8"))
    verify_catalog(catalog)
    firmware_contract()
    reports = {}
    for board in catalog["boards"]:
        design = generator.board_design(catalog, board)
        board_dir = output / board["id"]
        layout = json.loads((board_dir / "layout.json").read_text(encoding="utf-8"))
        reports[board["id"]] = {"geometry": verify_geometry(design, layout), "fabrication": verify_fabrication(design, board_dir, layout)}
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    require(manifest["design_sha256"] == sha256(design_path), "Motherboard manifest is stale")
    for relative, item in manifest["files"].items():
        path = output / relative
        require(path.is_file() and path.stat().st_size == item["bytes"] and sha256(path) == item["sha256"], f"Manifest mismatch: {relative}")
    if args.repeat:
        with tempfile.TemporaryDirectory(prefix="motherboard-repeat-a-") as first_tmp, tempfile.TemporaryDirectory(prefix="motherboard-repeat-b-") as second_tmp:
            first, second = Path(first_tmp) / "generated", Path(second_tmp) / "generated"
            subprocess.run(["python3", str(GENERATOR), "--design", str(design_path), "--output", str(first)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["python3", str(GENERATOR), "--design", str(design_path), "--output", str(second)], check=True, stdout=subprocess.DEVNULL)
            compare_trees(first, second)
    summary = "; ".join(
        f"{board}: {report['geometry']['primitive_count']} primitives, {report['geometry']['minimum_clearance_mm']} mm min clearance, {report['fabrication']['drill_hits']} drills"
        for board, report in reports.items()
    )
    print(f"PASS (digital checks only): {summary}; configured net/geometry contracts passed; purchased-part fit and electrical operation NOT certified" + ("; deterministic repeat passed" if args.repeat else ""))
    print(f"Manufacturing release: {catalog.get('release_status', 'HOLD')}")
    if args.require_release:
        require(catalog.get("release_status") == "APPROVED", "Manufacturing release HOLD: resolve PREORDER-REVIEW.md before ordering")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
