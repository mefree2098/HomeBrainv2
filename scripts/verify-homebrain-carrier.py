#!/usr/bin/env python3
"""Independently verify HomeBrain carrier electrical geometry and fabrication output."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DESIGN = ROOT / "hardware/homebrain-sensors/carrier/carrier-design.json"
DEFAULT_OUTPUT = ROOT / "hardware/homebrain-sensors/carrier/generated"
GENERATOR = ROOT / "scripts/generate-homebrain-carrier.py"
LAYERS = ("F.Cu", "B.Cu")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design", type=Path, default=DEFAULT_DESIGN)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--repeat", action="store_true")
    return parser.parse_args()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"{path.name}: invalid PNG")
    return struct.unpack(">II", data[16:24])


def point_segment_distance(point: tuple[float, float], start: tuple[float, float], end: tuple[float, float]) -> float:
    px, py = point
    ax, ay = start
    bx, by = end
    dx, dy = bx - ax, by - ay
    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def orientation(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> bool:
    return min(a[0], c[0]) - 1e-9 <= b[0] <= max(a[0], c[0]) + 1e-9 and min(a[1], c[1]) - 1e-9 <= b[1] <= max(a[1], c[1]) + 1e-9


def segment_distance(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float], d: tuple[float, float]) -> float:
    o1, o2, o3, o4 = orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)
    intersects = (o1 * o2 < 0 and o3 * o4 < 0) or (abs(o1) < 1e-9 and on_segment(a, c, b)) or (abs(o2) < 1e-9 and on_segment(a, d, b)) or (abs(o3) < 1e-9 and on_segment(c, a, d)) or (abs(o4) < 1e-9 and on_segment(c, b, d))
    if intersects:
        return 0.0
    return min(point_segment_distance(a, c, d), point_segment_distance(b, c, d), point_segment_distance(c, a, b), point_segment_distance(d, a, b))


@dataclass(frozen=True)
class Primitive:
    key: str
    net: str
    layer: str
    kind: str
    radius: float
    start: tuple[float, float]
    end: tuple[float, float]
    through_id: str | None = None


def primitive_distance(first: Primitive, second: Primitive) -> float:
    if first.kind == "circle" and second.kind == "circle":
        return math.hypot(first.start[0] - second.start[0], first.start[1] - second.start[1])
    if first.kind == "circle":
        return point_segment_distance(first.start, second.start, second.end)
    if second.kind == "circle":
        return point_segment_distance(second.start, first.start, first.end)
    return segment_distance(first.start, first.end, second.start, second.end)


def expected_pad_positions(design: dict) -> dict[str, tuple[float, float, str]]:
    xiao = design["xiao"]
    result: dict[str, tuple[float, float, str]] = {}
    for row_name, y in (
        ("top_row", xiao["center"][1] - xiao["row_spacing"] / 2.0),
        ("bottom_row", xiao["center"][1] + xiao["row_spacing"] / 2.0),
    ):
        for index, (label, net) in enumerate(xiao[row_name], 1):
            x = xiao["center"][0] + (index - 4) * xiao["pin_pitch"]
            result[f"U1.{label}"] = (round(x, 4), round(y, 4), net)
    for part in design["parts"]:
        if part["type"] == "JST-XH":
            for index, net in enumerate(part["pin_nets"], 1):
                x = part["center"][0] + (index - (part["positions"] + 1) / 2.0) * 2.5
                result[f"{part['ref']}.{index}"] = (round(x, 4), part["center"][1], net)
        elif part["type"] == "AXIAL":
            result[f"{part['ref']}.1"] = (part["center"][0] - part["lead_spacing"] / 2.0, part["center"][1], part["pin_nets"][0])
            result[f"{part['ref']}.2"] = (part["center"][0] + part["lead_spacing"] / 2.0, part["center"][1], part["pin_nets"][1])
        elif part["type"] == "TEST_PAD":
            result[f"{part['ref']}.1"] = (part["center"][0], part["center"][1], part["pin_nets"][0])
    return result


def verify_design(design: dict) -> None:
    require(design["schema_version"] == 1, "Unsupported carrier design schema")
    board = design["board"]
    require((board["width"], board["height"], board["thickness"], board["layers"]) == (32.0, 56.0, 1.6, 2), "Fabrication envelope changed")
    require(board["minimum_trace_width"] >= 0.4, "Signal traces below 0.4 mm")
    require(board["power_trace_width"] >= 0.8, "Power traces below 0.8 mm")
    require(board["minimum_clearance"] >= 0.25, "Copper clearance below 0.25 mm")
    require(design["xiao"]["row_spacing"] == 15.24 and design["xiao"]["pin_pitch"] == 2.54, "XIAO socket geometry differs from official footprint")
    require([net for _label, net in design["xiao"]["top_row"]] == ["A0", "D1", "D2", "D3", "SDA", "SCL", "TX"], "XIAO top row is wrong")
    require([net for _label, net in design["xiao"]["bottom_row"]] == ["VBUS", "GND", "3V3", "NC_D10", "NC_D9", "NC_D8", "RX"], "XIAO bottom row is wrong")
    parts = {part["ref"]: part for part in design["parts"]}
    require(parts["J1"]["pin_nets"] == parts["J2"]["pin_nets"] == parts["J3"]["pin_nets"] == ["GND", "3V3", "SDA", "SCL"], "I2C keyed port order changed")
    require(parts["J4"]["pin_nets"] == ["GND", "VBUS", "TX", "RX"], "UART keyed port order or crossing changed")
    require(parts["J5"]["pin_nets"] == ["GND", "D2", "D3"], "DHT keyed port order changed")
    require(parts["J6"]["pin_nets"] == parts["J7"]["pin_nets"] == ["GND", "BAT+"], "Battery keyed polarity changed")
    require(parts["R1"]["pin_nets"] == ["A0", "BAT+"] and parts["R2"]["pin_nets"] == ["A0", "GND"], "Climate divider no longer forms BAT+ → R1 → A0 → R2 → GND")
    profiles = design["profiles"]
    require(profiles["atmosphere"]["ports"]["J4"]["module_pins"] == ["GND", "VCC(+5V)", "RXD", "TXD"], "PMS UART must be crossed")
    require(profiles["presence"]["ports"]["J4"]["module_pins"] == ["GND", "VCC", "RX", "TX"], "Radar UART must be crossed")
    require(profiles["climate"]["populate"] == ["R1", "R2"], "Climate must populate both divider resistors")


def layout_primitives(layout: dict) -> tuple[list[Primitive], dict[str, dict]]:
    primitives: list[Primitive] = []
    pads = {pad["key"]: pad for pad in layout["pads"]}
    for pad in layout["pads"]:
        for layer in LAYERS:
            primitives.append(Primitive(f"{pad['key']}:{layer}", pad["net"], layer, "circle", pad["diameter"] / 2.0, (pad["x"], pad["y"]), (pad["x"], pad["y"]), pad["key"]))
    for index, segment in enumerate(layout["segments"]):
        primitives.append(Primitive(f"segment-{index}", segment["net"], segment["layer"], "segment", segment["width"] / 2.0, tuple(segment["start"]), tuple(segment["end"])))
    for index, via in enumerate(layout["vias"]):
        for layer in LAYERS:
            primitives.append(Primitive(f"via-{index}:{layer}", via["net"], layer, "circle", via["diameter"] / 2.0, (via["x"], via["y"]), (via["x"], via["y"]), f"via-{index}"))
    return primitives, pads


class DisjointSet:
    def __init__(self, keys: list[str]):
        self.parent = {key: key for key in keys}

    def find(self, key: str) -> str:
        while self.parent[key] != key:
            self.parent[key] = self.parent[self.parent[key]]
            key = self.parent[key]
        return key

    def union(self, first: str, second: str) -> None:
        a, b = self.find(first), self.find(second)
        if a != b:
            self.parent[b] = a


def rect_distance(point: tuple[float, float], bounds: tuple[float, float, float, float]) -> float:
    x1, y1, x2, y2 = bounds
    dx = max(x1 - point[0], 0.0, point[0] - x2)
    dy = max(y1 - point[1], 0.0, point[1] - y2)
    return math.hypot(dx, dy)


def segment_intersects_expanded_rect(start: tuple[float, float], end: tuple[float, float], bounds: tuple[float, float, float, float], expansion: float) -> bool:
    x1, y1, x2, y2 = bounds
    expanded = (x1 - expansion, y1 - expansion, x2 + expansion, y2 + expansion)
    if rect_distance(start, expanded) == 0.0 or rect_distance(end, expanded) == 0.0:
        return True
    corners = [(expanded[0], expanded[1]), (expanded[2], expanded[1]), (expanded[2], expanded[3]), (expanded[0], expanded[3])]
    return any(segment_distance(start, end, corners[index], corners[(index + 1) % 4]) == 0.0 for index in range(4))


def verify_ground_plane(design: dict, primitives: list[Primitive], pads: dict[str, dict], voids: list[dict]) -> dict:
    obstacles = {
        layer: [item for item in primitives if item.layer == layer and item.net != "GND"]
        for layer in LAYERS
    }
    step = 0.25
    width, height = design["board"]["width"], design["board"]["height"]
    edge = design["board"]["edge_clearance"]
    clearance = design["board"]["minimum_clearance"]
    keepout = design["board"]["antenna_copper_keepout"]
    kx1, ky1 = keepout["min"]
    kx2, ky2 = keepout["max"]
    ground_pads = [pad for pad in pads.values() if pad["net"] == "GND"]

    def copper(node: tuple[int, int, int]) -> bool:
        x, y, layer_index = node[0] * step, node[1] * step, node[2]
        if x < edge or y < edge or x > width - edge or y > height - edge:
            return False
        if kx1 <= x <= kx2 and ky1 <= y <= ky2:
            return False
        # Dark plated GND pads are redrawn after clear-mode moats, so their
        # annuli remain copper even at sample points that are outside the fill.
        if any(math.hypot(x - pad["x"], y - pad["y"]) <= pad["diameter"] / 2.0 + 1e-9 for pad in ground_pads):
            return True
        for void in voids:
            if void["layer"] == LAYERS[layer_index] and abs(x - void["x"]) <= void["size"] / 2.0 + 1e-9 and abs(y - void["y"]) <= void["size"] / 2.0 + 1e-9:
                return False
        for primitive in obstacles[LAYERS[layer_index]]:
            if primitive.kind == "circle":
                distance = math.hypot(x - primitive.start[0], y - primitive.start[1])
            else:
                distance = point_segment_distance((x, y), primitive.start, primitive.end)
            if distance < primitive.radius + clearance - 1e-9:
                return False
        return True

    require(ground_pads, "Ground plane has no endpoints")
    ground_nodes = {
        (round(pad["x"] / step), round(pad["y"] / step))
        for pad in ground_pads
    }
    start = (*next(iter(sorted(ground_nodes))), 0)
    require(copper(start), "First GND pad is isolated from the B.Cu plane")
    frontier = [start]
    visited = {start}
    while frontier:
        x, y, layer = frontier.pop()
        neighbors = [(x + 1, y, layer), (x - 1, y, layer), (x, y + 1, layer), (x, y - 1, layer)]
        if any(math.hypot(x * step - pad["x"], y * step - pad["y"]) <= pad["diameter"] / 2.0 + 1e-9 for pad in ground_pads):
            neighbors.append((x, y, 1 - layer))
        for neighbor in neighbors:
            if neighbor not in visited and copper(neighbor):
                visited.add(neighbor)
                frontier.append(neighbor)
    for pad in ground_pads:
        xy = (round(pad["x"] / step), round(pad["y"] / step))
        require((*xy, 0) in visited and (*xy, 1) in visited, f"{pad['key']}: GND pad is cut off from the stitched copper planes")
    all_copper = 0
    for layer in range(2):
        for x in range(math.ceil(edge / step), math.floor((width - edge) / step) + 1):
            for y in range(math.ceil(edge / step), math.floor((height - edge) / step) + 1):
                all_copper += int(copper((x, y, layer)))
    require(len(visited) == all_copper, f"Ground fill contains {all_copper - len(visited)} floating sampled copper points")
    return {"sample_step_mm": step, "reachable_copper_samples": len(visited), "ground_pad_count": len(ground_pads), "layers": 2, "island_void_count": len(voids)}


def verify_geometry(design: dict, layout: dict) -> dict:
    primitives, pads = layout_primitives(layout)
    clearance = design["board"]["minimum_clearance"]
    expected = expected_pad_positions(design)
    require(set(pads) == set(expected), f"Pad catalog differs: {set(pads) ^ set(expected)}")
    for key, (x, y, net) in expected.items():
        pad = pads[key]
        require((round(pad["x"], 4), round(pad["y"], 4), pad["net"]) == (x, y, net), f"{key}: position/net mismatch")
    width, height = design["board"]["width"], design["board"]["height"]
    edge = design["board"]["edge_clearance"]
    for primitive in primitives:
        for point in (primitive.start, primitive.end):
            require(point[0] - primitive.radius >= edge - 1e-9 and point[1] - primitive.radius >= edge - 1e-9, f"{primitive.key}: copper too near lower/left edge")
            require(point[0] + primitive.radius <= width - edge + 1e-9 and point[1] + primitive.radius <= height - edge + 1e-9, f"{primitive.key}: copper too near upper/right edge")
    keepout = design["board"]["antenna_copper_keepout"]
    bounds = (*keepout["min"], *keepout["max"])
    for primitive in primitives:
        if primitive.kind == "circle":
            require(rect_distance(primitive.start, bounds) >= primitive.radius - 1e-9, f"{primitive.key}: copper enters antenna keep-out")
        else:
            require(not segment_intersects_expanded_rect(primitive.start, primitive.end, bounds, primitive.radius), f"{primitive.key}: trace enters antenna keep-out")
    same_layer_pairs = 0
    minimum_actual = float("inf")
    for index, first in enumerate(primitives):
        for second in primitives[index + 1 :]:
            if first.layer != second.layer or first.net == second.net:
                continue
            same_layer_pairs += 1
            edge_gap = primitive_distance(first, second) - first.radius - second.radius
            minimum_actual = min(minimum_actual, edge_gap)
            require(edge_gap >= clearance - 1e-6, f"Copper DRC: {first.key} ({first.net}) / {second.key} ({second.net}) gap {edge_gap:.4f} mm")
    by_net: dict[str, list[Primitive]] = {}
    for primitive in primitives:
        by_net.setdefault(primitive.net, []).append(primitive)
    for net in design["nets"]:
        if net == "GND":
            continue
        items = by_net[net]
        dsu = DisjointSet([item.key for item in items])
        through: dict[str, list[Primitive]] = {}
        for item in items:
            if item.through_id:
                through.setdefault(item.through_id, []).append(item)
        for group in through.values():
            for item in group[1:]:
                dsu.union(group[0].key, item.key)
        for index, first in enumerate(items):
            for second in items[index + 1 :]:
                if first.layer == second.layer and primitive_distance(first, second) <= first.radius + second.radius + 1e-6:
                    dsu.union(first.key, second.key)
        endpoint_roots = {dsu.find(f"{pad_key}:F.Cu") for pad_key in layout["net_endpoints"][net]}
        require(len(endpoint_roots) == 1, f"{net}: endpoints split across {len(endpoint_roots)} copper islands")
    expected_planes = [
        {
            "antenna_keepout": design["board"]["antenna_copper_keepout"],
            "bounds": [[design["board"]["edge_clearance"], design["board"]["edge_clearance"]], [design["board"]["width"] - design["board"]["edge_clearance"], design["board"]["height"] - design["board"]["edge_clearance"]]],
            "clearance": design["board"]["minimum_clearance"],
            "layer": layer,
            "net": "GND",
        }
        for layer in LAYERS
    ]
    require(layout.get("planes") == expected_planes, "Missing or altered stitched GND plane contract")
    voids = layout.get("ground_plane_voids")
    require(isinstance(voids, list) and all(item.get("layer") in LAYERS and item.get("size") == 0.26 for item in voids), "Ground-plane void contract changed")
    plane = verify_ground_plane(design, primitives, pads, voids)
    return {"primitive_count": len(primitives), "different_net_pairs_checked": same_layer_pairs, "minimum_clearance_mm": round(minimum_actual, 4), "ground_plane": plane}


def parse_gerber(path: Path) -> dict:
    lines = path.read_text(encoding="ascii").splitlines()
    require(lines and lines[-1] == "M02*", f"{path.name}: missing Gerber terminator")
    require("%FSLAX46Y46*%" in lines and "%MOMM*%" in lines, f"{path.name}: wrong coordinate format/units")
    return {"flashes": sum(line.endswith("D03*") for line in lines), "draws": sum(line.endswith("D01*") for line in lines), "bytes": path.stat().st_size}


def verify_fabrication(output: Path, layout: dict) -> dict:
    gerbers = output / "gerbers"
    expected_files = {
        "homebrain-carrier-F_Cu.gbr", "homebrain-carrier-B_Cu.gbr", "homebrain-carrier-F_Mask.gbr", "homebrain-carrier-B_Mask.gbr",
        "homebrain-carrier-F_Silkscreen.gbr", "homebrain-carrier-Edge_Cuts.gbr", "homebrain-carrier-PTH.drl", "homebrain-carrier-job.gbrjob",
    }
    require({path.name for path in gerbers.iterdir() if path.is_file()} == expected_files, "Gerber directory contents changed")
    reports = {name: parse_gerber(gerbers / name) for name in expected_files if name.endswith(".gbr")}
    copper_flashes = len(layout["pads"]) + len(layout["vias"])
    non_ground_pads = sum(pad["net"] != "GND" for pad in layout["pads"])
    non_ground_vias = sum(via["net"] != "GND" for via in layout["vias"])
    for name in ("homebrain-carrier-F_Cu.gbr", "homebrain-carrier-B_Cu.gbr"):
        layer = "F.Cu" if "F_Cu" in name else "B.Cu"
        void_count = sum(item["layer"] == layer for item in layout["ground_plane_voids"])
        require(reports[name]["flashes"] == copper_flashes + non_ground_pads + non_ground_vias + void_count, f"{name}: dark/clear/void flash count mismatch")
        copper_text = (gerbers / name).read_text(encoding="ascii")
        require(copper_text.count("G36*") == 2 and copper_text.count("G37*") == 2, f"{name}: lacks plane/antenna region operations")
        require("%LPC*%" in copper_text and copper_text.count("%LPD*%") >= 2, f"{name}: lacks clear-polarity moats")
    drill_lines = (gerbers / "homebrain-carrier-PTH.drl").read_text(encoding="ascii").splitlines()
    drill_hits = sum(line.startswith("X") for line in drill_lines)
    require(drill_hits == len(layout["pads"]) + len(layout["vias"]), "Drill hit count mismatch")
    zip_path = output / "homebrain-carrier-gerbers.zip"
    with zipfile.ZipFile(zip_path) as archive:
        require(set(archive.namelist()) == expected_files, "Fabrication ZIP contents changed")
        for name in expected_files:
            require(archive.read(name) == (gerbers / name).read_bytes(), f"Fabrication ZIP {name} differs from checked file")
    return {"gerbers": reports, "drill_hits": drill_hits, "zip_bytes": zip_path.stat().st_size}


def verify_visuals(output: Path, design: dict) -> dict:
    expected = {
        "homebrain-carrier-assembly": (1800, 1200),
        "homebrain-carrier-schematic": (1800, 1100),
        "final-harness-atmosphere": (1900, 1250),
        "final-harness-presence": (1900, 1250),
        "final-harness-climate": (1900, 1250),
    }
    report = {}
    for stem, dimensions in expected.items():
        svg = output / f"{stem}.svg"
        png = output / f"{stem}.png"
        require(svg.is_file() and png.is_file(), f"Missing {stem} SVG/PNG")
        text = svg.read_text(encoding="utf-8")
        require("<metadata>" in text, f"{stem}: missing structured metadata")
        require(png_size(png) == dimensions, f"{stem}: PNG dimensions changed")
        report[stem] = {"svg_sha256": sha256(svg), "png_sha256": sha256(png), "pixels": list(dimensions)}
    expected_harnesses = {
        "atmosphere": ("J1", "J2", "J3", "J4"),
        "presence": ("J1", "J4", "J5"),
        "climate": ("J5", "J6", "J7"),
    }
    harness_text: dict[str, str] = {}
    for profile, refs in expected_harnesses.items():
        harness_text[profile] = (output / f"final-harness-{profile}.svg").read_text(encoding="utf-8")
        for ref in refs:
            require(
                f'data-harness=&quot;{ref}&quot;' in harness_text[profile] or f'data-harness="{ref}"' in harness_text[profile],
                f"{profile.title()} guide missing {ref}",
            )
    atmosphere = harness_text["atmosphere"]
    require("pin 3 MCU-TX  →  RXD" in atmosphere and "pin 4 MCU-RX  →  TXD" in atmosphere, "Atmosphere guide does not visibly cross UART")
    presence = harness_text["presence"]
    require("pin 3 MCU-TX  →  RX" in presence and "pin 4 MCU-RX  →  TX" in presence, "Presence guide does not visibly cross UART")
    climate = harness_text["climate"]
    require("pin 1 BAT-  →  BAT-" in climate and "pin 2 BAT+  →  BAT+" in climate, "Climate guide does not visibly preserve battery polarity")
    return report


def compare_trees(first: Path, second: Path) -> None:
    first_files = {path.relative_to(first).as_posix(): sha256(path) for path in first.rglob("*") if path.is_file()}
    second_files = {path.relative_to(second).as_posix(): sha256(path) for path in second.rglob("*") if path.is_file()}
    require(first_files == second_files, f"Generator is not deterministic: {set(first_files) ^ set(second_files)}")


def main() -> int:
    args = parse_args()
    design_path, output = args.design.resolve(), args.output.resolve()
    design = json.loads(design_path.read_text(encoding="utf-8"))
    verify_design(design)
    layout = json.loads((output / "layout.json").read_text(encoding="utf-8"))
    geometry = verify_geometry(design, layout)
    fabrication = verify_fabrication(output, layout)
    visuals = verify_visuals(output, design)
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    require(manifest["design_sha256"] == sha256(design_path), "Manifest design hash is stale")
    for relative, item in manifest["files"].items():
        path = output / relative
        require(path.is_file() and path.stat().st_size == item["bytes"] and sha256(path) == item["sha256"], f"Manifest mismatch: {relative}")
    if args.repeat:
        with tempfile.TemporaryDirectory(prefix="carrier-repeat-a-") as first_tmp, tempfile.TemporaryDirectory(prefix="carrier-repeat-b-") as second_tmp:
            first, second = Path(first_tmp) / "generated", Path(second_tmp) / "generated"
            subprocess.run(["python3", str(GENERATOR), "--design", str(design_path), "--output", str(first)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["python3", str(GENERATOR), "--design", str(design_path), "--output", str(second)], check=True, stdout=subprocess.DEVNULL)
            compare_trees(first, second)
    print(
        f"PASS: {manifest['pad_count']} pads, {manifest['route_segment_count']} trace segments, {manifest['via_count']} vias; "
        f"{geometry['primitive_count']} copper primitives, {geometry['different_net_pairs_checked']} DRC pairs, "
        f"minimum measured clearance {geometry['minimum_clearance_mm']} mm; {fabrication['drill_hits']} plated drill hits; "
        f"5 verified SVG/PNG guides" + ("; deterministic two-run comparison passed" if args.repeat else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
