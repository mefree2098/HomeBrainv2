#!/usr/bin/env python3
"""Generate three dedicated HomeBrain sensor motherboards and orderable Gerbers."""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DESIGN = ROOT / "hardware/homebrain-sensors/motherboards/motherboard-designs.json"
DEFAULT_OUTPUT = ROOT / "hardware/homebrain-sensors/motherboards/generated"
DEFAULT_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
BASE_GENERATOR = ROOT / "scripts/generate-homebrain-carrier.py"


def load_base():
    spec = importlib.util.spec_from_file_location("homebrain_carrier_base", BASE_GENERATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {BASE_GENERATOR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


base = load_base()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design", type=Path, default=DEFAULT_DESIGN)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--chrome", type=Path, default=DEFAULT_CHROME)
    parser.add_argument("--svg-only", action="store_true")
    parser.add_argument("--repackage-only", action="store_true", help="Create JLCPCB upload ZIPs from verified existing exports without rerouting")
    return parser.parse_args()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def board_design(catalog: dict, board: dict) -> dict:
    defaults = catalog["fabrication_defaults"]
    width, height = board["size"]
    return {
        "id": board["id"],
        "title": board["name"],
        "revision": board["revision"],
        "board": {
            "width": width,
            "height": height,
            "thickness": defaults["thickness"],
            "layers": defaults["layers"],
            "minimum_trace_width": defaults["minimum_trace_width"],
            "power_trace_width": defaults["power_trace_width"],
            "minimum_clearance": defaults["minimum_clearance"],
            "edge_clearance": defaults["edge_clearance"],
            "solder_mask_expansion": defaults["solder_mask_expansion"],
            "antenna_copper_keepout": board["antenna_copper_keepout"],
        },
        "xiao": {**catalog["xiao_footprint"], "center": board["xiao_center"]},
        "xiao_assembly": board["xiao_assembly"],
        "modules": board["modules"],
        "assembly_parts": board.get("assembly_parts", []),
        "mounting_holes": board["mounting_holes"],
        "xiao_battery_fill_pads": board.get("xiao_battery_fill_pads", []),
        "nets": {name: {"class": category} for name, category in board["nets"].items()},
        "route_order": board["route_order"],
        "external_connections": board["external_connections"],
        "fabrication": defaults,
    }


def derive_pads(design: dict) -> list:
    pads: list = []
    xiao = design["xiao"]
    cx, cy = xiao["center"]
    left_x = cx - xiao["row_spacing"] / 2.0
    right_x = cx + xiao["row_spacing"] / 2.0
    for side, x, rows in (
        ("L", left_x, xiao["left_top_to_bottom"]),
        ("R", right_x, xiao["right_top_to_bottom"]),
    ):
        for index, (label, net) in enumerate(rows, 1):
            y = cy + (4 - index) * xiao["pin_pitch"]
            pads.append(base.Pad(f"U1.{label}", "U1", f"{side}{index}", label, net, x, y, xiao["pad_diameter"], xiao["drill"]))
    for module in design["modules"]:
        header = module["header"]
        ox, oy = header["origin"]
        sx, sy = header["step"]
        drill = header.get("drill", 1.0)
        diameter = header.get("pad_diameter", 1.8)
        for index, (number, label, net) in enumerate(header["pins"]):
            pads.append(
                base.Pad(
                    f"{module['ref']}.{number}", module["ref"], number, label, net,
                    round(ox + index * sx, 4), round(oy + index * sy, 4), diameter, drill,
                )
            )
    for index, (x, y) in enumerate(design["mounting_holes"], 1):
        pads.append(base.Pad(f"MH{index}.1", f"MH{index}", "1", "CASE GND", "GND", x, y, 5.2, 3.4))
    for item in design["xiao_battery_fill_pads"]:
        dx, dy = item["offset_from_xiao_center"]
        pads.append(
            base.Pad(
                f"{item['ref']}.1", item["ref"], "1", item["label"], item["net"],
                round(cx + dx, 4), round(cy + dy, 4), item["pad_diameter"], item["drill"],
            )
        )
    keys = [pad.key for pad in pads]
    if len(keys) != len(set(keys)):
        raise ValueError(f"{design['id']}: duplicate pad key")
    return pads


class MotherboardRouter(base.Router):
    def reserve_xiao_escapes(self) -> None:
        counts: dict[str, int] = {}
        for pad in self.pads:
            counts[pad.net] = counts.get(pad.net, 0) + 1
        xiao_x = self.design["xiao"]["center"][0]
        routable = [net for net in self.design["route_order"] if counts.get(net, 0) >= 2]
        for index, net in enumerate(routable):
            pad = next((item for item in self.pads if item.ref == "U1" and item.net == net), None)
            if pad is None:
                continue
            layer_index = index % 2
            direction = -1.0 if pad.x < xiao_x else 1.0
            start = (base.q(pad.x), base.q(pad.y), layer_index)
            end = (base.q(pad.x + direction * 2.0), base.q(pad.y), layer_index)
            layer = base.LAYERS[layer_index]
            self.segments.append(base.Segment(net, layer, base.net_width(self.design, net), (base.uq(start[0]), base.uq(start[1])), (base.uq(end[0]), base.uq(end[1]))))
            low, high = sorted((start[0], end[0]))
            nodes = {(x, start[1], layer_index) for x in range(low, high + 1)}
            nodes.add((start[0], start[1], 1 - layer_index))
            self.escape_nodes[net] = nodes


def route_board(design: dict, pads: list) -> tuple[list, list, list[dict]]:
    router = MotherboardRouter(design, pads)
    segments, vias = router.route(design["route_order"])
    ground_voids = base.compute_ground_plane_voids(design, pads, segments, vias)
    return segments, vias, ground_voids


def write_silkscreen(path: Path, design: dict, pads: list) -> None:
    apertures = {10: ("C", 0.18), 11: ("C", 0.25), 12: ("C", 0.55)}
    # Remove legend from exposed copper, with 0.15 mm mask-to-silk margin.
    clearances = sorted({round(p.diameter + 2 * (design["board"]["solder_mask_expansion"] + 0.15), 4) for p in pads})
    clear_tools = {diameter: index + 20 for index, diameter in enumerate(clearances)}
    apertures.update({tool: ("C", diameter) for diameter, tool in clear_tools.items()})
    lines = base.gerber_header(f"{design['title']} front silkscreen", apertures)

    def label(value: str, x: float, y: float, pixel: float = 0.18, rotation: int = 0) -> None:
        for px, py in base.bitmap_text_segments(value, x, y, pixel, rotation):
            base.gerber_flash(lines, 10, px, py)

    width, height = design["board"]["width"], design["board"]["height"]
    label(f"HB {design['id']} {design['revision']}", 1.5, height - 2.4, 0.16)
    xiao = design["xiao"]
    cx, cy = xiao["center"]
    sx, sy = xiao["board_size"]
    outline = [(cx - sx / 2, cy - sy / 2), (cx + sx / 2, cy - sy / 2), (cx + sx / 2, cy + sy / 2), (cx - sx / 2, cy + sy / 2), (cx - sx / 2, cy - sy / 2)]
    for first, second in zip(outline, outline[1:]):
        base.gerber_draw(lines, 11, first, second)
    label("USB", cx - 2.7, min(height - 1.2, cy + sy / 2 + 0.5), 0.14)
    base.gerber_draw(lines, 11, (cx, cy + sy / 2 - 2.2), (cx, cy + sy / 2 + 0.2))
    base.gerber_draw(lines, 11, (cx, cy + sy / 2 + 0.2), (cx - 0.7, cy + sy / 2 - 0.6))
    base.gerber_draw(lines, 11, (cx, cy + sy / 2 + 0.2), (cx + 0.7, cy + sy / 2 - 0.6))
    for module in design["modules"]:
        x1, y1, x2, y2 = module["outline"]
        if not module.get("overhang"):
            points = [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)]
            for first, second in zip(points, points[1:]):
                base.gerber_draw(lines, 11, first, second)
        header = module["header"]
        ox, oy = header["origin"]
        label(module["ref"], max(0.8, min(width - 4.0, ox + 1.5)), max(0.8, min(height - 1.6, oy + 1.5)), 0.16)
        for index, (_number, pin_label, _net) in enumerate(header["pins"]):
            px = ox + index * header["step"][0]
            py = oy + index * header["step"][1]
            if abs(header["step"][0]) > abs(header["step"][1]):
                label(pin_label[:4], px - 1.0, py - 1.7, 0.11)
            else:
                label(pin_label[:5], px + 1.2, py - 0.35, 0.11)
        dx, dy = header["step"]
        length = math.hypot(dx, dy)
        base.gerber_flash(lines, 12, ox - 1.7 * dx / length, oy - 1.7 * dy / length)
    for pad in design["xiao_battery_fill_pads"]:
        dx, dy = pad["offset_from_xiao_center"]
        label(pad["label"], cx + dx - 1.0, cy + dy - 1.7, 0.12)
    label("USB UP", width / 2.0 - 4.2, 1.2, 0.14)
    lines.append("%LPC*%")
    for pad in pads:
        diameter = round(pad.diameter + 2 * (design["board"]["solder_mask_expansion"] + 0.15), 4)
        base.gerber_flash(lines, clear_tools[diameter], pad.x, pad.y)
    lines.append("%LPD*%")
    lines.append("M02*")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


COLORS = {
    "GND": "#28364b", "3V3": "#f59e0b", "VBUS": "#ef4444", "BAT+": "#d62f3f",
    "A0": "#14a47b", "D2": "#d946a5", "D3": "#e67620", "SDA": "#10a66a",
    "SCL": "#2583e8", "TX": "#8b5cf6", "RX": "#6d43d9",
}


def assembly_svg(design: dict, pads: list, segments: list, vias: list) -> str:
    width, height = 2000, 1250
    board_width, board_height = design["board"]["width"], design["board"]["height"]
    scale = min(10.0, 780.0 / board_width, 780.0 / board_height)
    left, top = 90.0, 200.0

    def sx(x: float) -> float:
        return left + x * scale

    def sy(y: float) -> float:
        return top + (board_height - y) * scale

    def wrap_fragments(fragments: list[str], limit: int = 88) -> list[str]:
        """Keep generated pin recipes inside the fixed-width instruction panel."""
        lines: list[str] = []
        current = ""
        for fragment in fragments:
            candidate = fragment if not current else f"{current}  •  {fragment}"
            if current and len(candidate) > limit:
                lines.append(current)
                current = fragment
            else:
                current = candidate
        if current:
            lines.append(current)
        return lines

    def wrap_words(value: str, limit: int = 108) -> list[str]:
        """Wrap prose without splitting labels or words in the assembly panel."""
        lines: list[str] = []
        current = ""
        for word in value.split():
            candidate = word if not current else f"{current} {word}"
            if current and len(candidate) > limit:
                lines.append(current)
                current = word
            else:
                current = candidate
        if current:
            lines.append(current)
        return lines

    xiao_summary = {
        "atmosphere": "U1 XIAO: insert both factory 1x7 headers; solder underside, inspect, then trim.",
        "presence": "U1 XIAO: insert both factory 1x7 headers; solder underside, inspect, then trim.",
        "climate": "U1 XIAO: factory 1x7 headers plus rigid BAT-/BAT+ posts through XB1/XB2; solder underside, inspect, trim.",
    }[design["id"]]
    body = [
        base.svg_text(70, 58, f"{design['title'].upper()} — {design['revision'].upper()} DIRECT-SOLDER ASSEMBLY", size=33, weight=900),
        base.svg_text(70, 100, "One dedicated PCB • factory male headers solder through labeled footprints • no inter-module wire harnesses", size=21, weight=650, fill="#526d89"),
        base.svg_rect(left - 24, top - 24, board_width * scale + 48, board_height * scale + 48, fill="#ffffff", radius=24),
        base.svg_rect(left, top, board_width * scale, board_height * scale, fill="#0b695f", stroke="#073f48", stroke_width=4, radius=5),
    ]
    keepout = design["board"]["antenna_copper_keepout"]
    kx, ky = keepout["min"]
    kx2, ky2 = keepout["max"]
    body.append(f'<rect x="{sx(kx)}" y="{sy(ky2)}" width="{(kx2-kx)*scale}" height="{(ky2-ky)*scale}" fill="#ffd976" fill-opacity="0.60" stroke="#f0b02e" stroke-width="2" stroke-dasharray="8 6"/>')
    for segment in segments:
        color = "#ff4b55" if segment.layer == "F.Cu" else "#31a6ff"
        body.append(f'<line x1="{sx(segment.start[0])}" y1="{sy(segment.start[1])}" x2="{sx(segment.end[0])}" y2="{sy(segment.end[1])}" stroke="{color}" stroke-opacity="0.78" stroke-width="{max(3.0, segment.width*scale)}" stroke-linecap="round" data-net="{segment.net}"/>')
    for module in design["modules"]:
        x1, y1, x2, y2 = module["outline"]
        fill = "#7b2da5" if "BME" in module["name"] else "#1e78ad" if "SCD" in module["name"] or "VEML" in module["name"] else "#be243b" if "PMS" in module["name"] else "#334c68"
        body.append(base.svg_rect(sx(x1), sy(y2), (x2-x1)*scale, (y2-y1)*scale, fill=fill, stroke="#dce9f2", stroke_width=2, radius=5, extra=f'data-module="{escape(module["ref"])}"'))
        body.append(base.svg_text((sx(x1)+sx(x2))/2, (sy(y1)+sy(y2))/2, module["ref"], size=17, weight=900, fill="white", anchor="middle"))
    xiao = design["xiao"]
    cx, cy = xiao["center"]
    xw, xh = xiao["board_size"]
    body.append(base.svg_rect(sx(cx-xw/2), sy(cy+xh/2), xw*scale, xh*scale, fill="#103d55", stroke="#6ce0d3", stroke_width=3, radius=6, extra='data-module="U1"'))
    body.append(base.svg_text(sx(cx), sy(cy), "XIAO", size=18, weight=900, fill="white", anchor="middle"))
    body.append(base.svg_text(sx(cx), sy(cy+xh/2)+18, "USB-C", size=13, weight=900, fill="#f8d36a", anchor="middle"))
    for pad in pads:
        color = "#adb7c3" if pad.net.startswith("NC_") else COLORS.get(pad.net, "#f4ce55")
        body.append(f'<circle cx="{sx(pad.x)}" cy="{sy(pad.y)}" r="{max(3.0,pad.diameter*scale/2)}" fill="{color}" stroke="#172b42" stroke-width="1.5" data-pad="{escape(pad.key)}" data-net="{escape(pad.net)}"/>')
        body.append(f'<circle cx="{sx(pad.x)}" cy="{sy(pad.y)}" r="{max(1.4,pad.drill*scale/2)}" fill="#f5f7fa"/>')
    panel_x = 980
    body.extend([
        base.svg_rect(panel_x, 180, 930, 140, fill="#fff7dc", stroke="#e5b746", radius=18),
        base.svg_text(panel_x + 28, 222, "THE ELECTRICAL CONNECTIONS ARE COPPER TRACES", size=23, weight=900, fill="#744c00"),
        base.svg_text(panel_x + 28, 262, "Colored routes are visualization only; the finished assembly contains no loose sensor wiring.", size=18, weight=650, fill="#6e5a2c"),
        base.svg_rect(panel_x, 345, 930, 785, fill="#ffffff", radius=18),
        base.svg_text(panel_x + 28, 390, "Direct-solder footprints", size=25, weight=900),
        base.svg_text(panel_x + 28, 420, xiao_summary, size=13, weight=650, fill="#087d70"),
    ])
    y = 466
    for module in design["modules"]:
        pin_lines = wrap_fragments([f"{pin[1]}={pin[2]}" for pin in module["header"]["pins"]])
        mount_lines = wrap_words(module["mount"])
        body.append(base.svg_text(panel_x + 28, y, f"{module['ref']}  {module['name']}", size=19, weight=850))
        for line_index, pin_line in enumerate(pin_lines):
            body.append(base.svg_text(panel_x + 28, y + 28 + line_index * 21, pin_line, size=14, weight=650, fill="#46617d"))
        mount_y = y + 32 + len(pin_lines) * 21
        for line_index, mount_line in enumerate(mount_lines):
            body.append(base.svg_text(panel_x + 28, mount_y + line_index * 21, mount_line, size=14, weight=600, fill="#64768a"))
        y += 52 + (len(pin_lines) + len(mount_lines)) * 21
    for part in design["assembly_parts"]:
        body.append(base.svg_text(panel_x + 28, y, f"{part['ref']}  {part['name']}", size=19, weight=850, fill="#9a4f00"))
        body.append(base.svg_text(panel_x + 28, y + 29, part.get("diagram", part["assembly"]), size=14, weight=650, fill="#64768a"))
        y += 64
    if design["xiao_battery_fill_pads"]:
        body.append(base.svg_text(panel_x + 28, y + 8, "Climate rigid battery posts", size=19, weight=850, fill="#b73340"))
        body.append(base.svg_text(panel_x + 28, y + 38, "Before U1 installation, solder saved resistor-lead posts to XIAO BAT−/BAT+; guide through XB1/XB2 and solder underside.", size=14, weight=650))
        y += 76
    body.append(base.svg_text(panel_x + 28, min(1095, y + 18), "Four 3.4 mm grounded mounting holes accept common #4 screws into printed plastic posts.", size=15, weight=750, fill="#087d70"))
    return base.svg_document(width, height, design["title"], {"artifact": "dedicated-motherboard-assembly", "board": design["id"], "pads": len(pads), "segments": len(segments), "vias": len(vias)}, body)


def schematic_svg(design: dict, pads: list) -> str:
    width, height = 1900, 1150
    body = [
        base.svg_text(60, 60, f"{design['title'].upper()} — {design['revision'].upper()} VERIFIED NET CONTRACT", size=32, weight=900),
        base.svg_text(60, 102, "Every row below is implemented as PCB copper. NC pads are drilled for mechanical mounting only and have no copper route.", size=20, weight=650, fill="#526d89"),
    ]
    by_net: dict[str, list] = {}
    for pad in pads:
        if pad.net in design["nets"]:
            by_net.setdefault(pad.net, []).append(pad)
    y = 170
    for net in design["nets"]:
        endpoints = by_net.get(net, [])
        if len(endpoints) < 2 and net != "GND":
            continue
        color = COLORS.get(net, "#526d89")
        body.append(base.svg_rect(60, y, 1780, 82, fill="#ffffff", stroke="#ced8e5", radius=14))
        body.append(f'<rect x="60" y="{y}" width="14" height="82" rx="7" fill="{color}"/>')
        body.append(base.svg_text(96, y + 34, net, size=22, weight=900, fill=color))
        endpoint_text = "   →   ".join(f"{pad.ref} {pad.label}" for pad in endpoints if not pad.ref.startswith("MH"))
        body.append(base.svg_text(240, y + 34, endpoint_text, size=18, weight=750))
        if net == "GND":
            body.append(base.svg_text(240, y + 62, "Both copper layers are stitched GND planes; mounting holes also connect to GND.", size=14, weight=650, fill="#5e7187"))
        y += 102
    if design["external_connections"]:
        body.append(base.svg_text(60, y + 30, "Unavoidable external factory leads", size=23, weight=900))
        y += 58
        for connection in design["external_connections"]:
            body.append(base.svg_text(86, y, f"• {connection['name']}: {connection['from']} → {connection['to']}", size=17, weight=800))
            body.append(base.svg_text(112, y + 28, connection["rule"], size=15, weight=600, fill="#5e7187"))
            y += 62
    return base.svg_document(width, height, f"{design['title']} net contract", {"artifact": "dedicated-motherboard-schematic", "board": design["id"], "nets": list(by_net)}, body)


def fit_check_svg(design: dict, pads: list) -> str:
    """Create an actual-size paper template for checking purchased board revisions."""
    width = design["board"]["width"]
    height = design["board"]["height"]
    elements = [
        f'<rect x="0.15" y="0.15" width="{width - 0.3}" height="{height - 0.3}" fill="white" stroke="#111827" stroke-width="0.3"/>',
        f'<text x="2" y="3.1" font-family="Arial,sans-serif" font-size="1.8" font-weight="700">{escape(design["title"])} {escape(design["revision"])} — PRINT 100%</text>',
        f'<text x="2" y="5.4" font-family="Arial,sans-serif" font-size="1.35">CUT OUTLINE MUST MEASURE {width:g} × {height:g} mm</text>',
    ]
    for module in design["modules"]:
        x1, y1, x2, y2 = module["outline"]
        elements.append(
            f'<rect x="{x1}" y="{height - y2}" width="{x2 - x1}" height="{y2 - y1}" fill="#dbeafe" fill-opacity="0.45" stroke="#2563eb" stroke-width="0.25" stroke-dasharray="1 0.7"/>'
        )
        elements.append(
            f'<text x="{(x1 + x2) / 2}" y="{height - (y1 + y2) / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Arial,sans-serif" font-size="1.8" font-weight="700">{escape(module["ref"])}</text>'
        )
    xiao = design["xiao"]
    cx, cy = xiao["center"]
    xiao_width, xiao_height = xiao["board_size"]
    elements.append(
        f'<rect x="{cx - xiao_width / 2}" y="{height - (cy + xiao_height / 2)}" width="{xiao_width}" height="{xiao_height}" fill="#ccfbf1" fill-opacity="0.55" stroke="#0f766e" stroke-width="0.3"/>'
    )
    elements.append(
        f'<text x="{cx}" y="{height - cy}" text-anchor="middle" dominant-baseline="middle" font-family="Arial,sans-serif" font-size="1.8" font-weight="700">U1 XIAO</text>'
    )
    for pad in pads:
        pad_fill = "#fee2e2" if pad.ref.startswith("MH") else "#fef3c7"
        elements.append(
            f'<circle cx="{pad.x}" cy="{height - pad.y}" r="{pad.diameter / 2}" fill="{pad_fill}" stroke="#374151" stroke-width="0.18"/>'
        )
        elements.append(
            f'<circle cx="{pad.x}" cy="{height - pad.y}" r="{pad.drill / 2}" fill="white" stroke="#111827" stroke-width="0.12"/>'
        )
    metadata = escape(json.dumps({"artifact": "actual-size-fit-check", "board": design["id"], "units": "millimeters", "print_scale": "100%"}, sort_keys=True))
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}mm" height="{height}mm" viewBox="0 0 {width} {height}">\n'
        f'<metadata>{metadata}</metadata>\n'
        + "\n".join(elements)
        + "\n</svg>\n"
    )


def write_layout(path: Path, design: dict, pads: list, segments: list, vias: list, voids: list[dict]) -> None:
    payload = {
        "schema_version": 1,
        "board_id": design["id"],
        "board": design["board"],
        "xiao": design["xiao"],
        "xiao_assembly": design["xiao_assembly"],
        "modules": design["modules"],
        "assembly_parts": design["assembly_parts"],
        "pads": [pad.__dict__ for pad in pads],
        "segments": [segment.__dict__ for segment in segments],
        "vias": [via.__dict__ for via in vias],
        "ground_plane_voids": voids,
        "net_endpoints": {net: sorted(pad.key for pad in pads if pad.net == net) for net in design["nets"]},
        "external_connections": design["external_connections"],
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_board_bom(path: Path, design: dict) -> None:
    rows = [["U1", "Seeed Studio XIAO ESP32-C6", "1", design["xiao_assembly"], "B0DJ6N55FX"]]
    for module in design["modules"]:
        rows.append([module["ref"], module["name"], "1", module["mount"], module.get("asin", "B08QRKSH5C (purchased resistor kit)")])
    for part in design["assembly_parts"]:
        rows.append([part["ref"], part["name"], part["quantity"], part["assembly"], part["source"]])
    rows.append(["MH1-MH4", "#4 x 3/8 in Phillips pan-head coarse-thread sheet-metal screw", "4", "PCB to printed plastic motherboard posts", "Home Depot 824681 / SKU 1006540029"])
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["Reference", "Part", "Quantity", "Assembly", "Purchased part/source"])
        writer.writerows(rows)


def write_job(path: Path, design: dict, prefix: str) -> None:
    job = {
        "Header": {"GenerationSoftware": {"Vendor": "OpenAI", "Application": "HomeBrain Dedicated Motherboard Generator", "Version": "1.0"}},
        "GeneralSpecs": {"ProjectId": {"Name": prefix, "Revision": design["revision"]}, "Size": {"X": design["board"]["width"], "Y": design["board"]["height"]}, "LayerNumber": 2},
        "FilesAttributes": [
            {"Path": f"{prefix}-F_Cu.gbr", "FileFunction": "Copper,L1,Top"},
            {"Path": f"{prefix}-B_Cu.gbr", "FileFunction": "Copper,L2,Bot"},
            {"Path": f"{prefix}-F_Mask.gbr", "FileFunction": "SolderMask,Top"},
            {"Path": f"{prefix}-B_Mask.gbr", "FileFunction": "SolderMask,Bot"},
            {"Path": f"{prefix}-F_Silkscreen.gbr", "FileFunction": "Legend,Top"},
            {"Path": f"{prefix}-Edge_Cuts.gbr", "FileFunction": "Profile"},
            {"Path": f"{prefix}-PTH.drl", "FileFunction": "Plated,1,2,PTH,Drill"},
        ],
    }
    path.write_text(json.dumps(job, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_drill(path: Path, pads: list, vias: list) -> None:
    """Explicit decimal millimetres avoid implicit Excellon format ambiguity."""
    holes = [*pads, *vias]
    diameters = sorted({hole.drill for hole in holes})
    lines = ["M48", "; HomeBrain Dedicated Motherboard Generator", "METRIC",]
    for index, diameter in enumerate(diameters, 1):
        lines.append(f"T{index:02d}C{diameter:.3f}")
    lines.extend(["%", "G90", "M71"])
    for index, diameter in enumerate(diameters, 1):
        lines.append(f"T{index:02d}")
        for x, y in sorted((hole.x, hole.y) for hole in holes if hole.drill == diameter):
            lines.append(f"X{x:.3f}Y{y:.3f}")
    lines.append("M30")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def write_jlcpcb_zip(gerbers: Path, destination: Path, prefix: str) -> None:
    """Use JLCPCB's documented Protel extensions and plain RS-274X commands.

    Do not scale, rotate, reroute, regenerate drills, or duplicate layers.
    The original generic Gerbers and their ZIP remain untouched.
    """
    layers = [
        ("F_Cu.gbr", "GTL", "Copper,L1,Top"),
        ("B_Cu.gbr", "GBL", "Copper,L2,Bot"),
        ("F_Mask.gbr", "GTS", "SolderMask,Top"),
        ("B_Mask.gbr", "GBS", "SolderMask,Bot"),
        ("F_Silkscreen.gbr", "GTO", "Legend,Top"),
        ("Edge_Cuts.gbr", "GKO", "Profile,NP"),
        ("PTH.drl", "PTH.XLN", "Plated,1,2,PTH,Drill"),
    ]
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.comment = b"Import compatibility package only; consult RELEASE-STATUS.txt and PREORDER-REVIEW.md before manufacture."
        for suffix, extension, function in layers:
            data = (gerbers / f"{prefix}-{suffix}").read_bytes()
            if extension == "PTH.XLN":
                lines = data.decode("ascii").splitlines()
                # Mark all existing holes as plated, as specified by the source
                # PTH file/job. Keep every tool diameter and coordinate intact.
                lines.remove("G90")
                lines.insert(lines.index("METRIC") + 1, "G90")
                lines.insert(1, ";TYPE=PLATED")
                lines.insert(2, "; #@! TF.FileFunction,Plated,1,2,PTH*")
                data = ("\n".join(lines) + "\n").encode("ascii")
            else:
                lines = data.decode("ascii").splitlines()
                if "%FSLAX46Y46*%" not in lines or "%MOMM*%" not in lines:
                    raise ValueError("Unexpected Gerber units/format; do not repackage blindly")
                # Preserve metadata as comments so importers need only RS-274X.
                lines = [f"G04 Layer function: {function}*"] + [
                    "G04 " + line[1:-1] if line.startswith("%TF.") else line
                    for line in lines
                ]
                # The original writer relied on implicit linear interpolation.
                # Explicitly select it before any region or drawing command.
                lines.insert(lines.index("%MOMM*%") + 1, "G01*")
                data = ("\n".join(lines) + "\n").encode("ascii")
            name = f"{prefix}-PTH.XLN" if extension == "PTH.XLN" else f"{prefix}.{extension}"
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)


def repackage_existing(catalog_path: Path, output: Path) -> None:
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["design_sha256"] != sha256(catalog_path):
        raise ValueError("Existing exports do not match the source design")
    for relative, item in manifest["files"].items():
        if sha256(output / relative) != item["sha256"]:
            raise ValueError(f"Existing export changed: {relative}")
    for board_id, report in manifest["boards"].items():
        prefix = f"homebrain-{board_id}-motherboard"
        relative = f"{board_id}/{prefix}-jlcpcb-import-check.zip"
        destination = output / relative
        write_jlcpcb_zip(output / board_id / "gerbers", destination, prefix)
        report["jlcpcb_import_zip"] = relative
        manifest["files"][relative] = {"bytes": destination.stat().st_size, "sha256": sha256(destination)}
        print(f"Repackaged {board_id}: {destination}")
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Manufacturing release unchanged: {manifest.get('release_status', 'HOLD')}")


def generate_one(design: dict, output: Path, chrome: Path, svg_only: bool) -> dict:
    pads = derive_pads(design)
    segments, vias, voids = route_board(design, pads)
    board_dir = output / design["id"]
    gerbers = board_dir / "gerbers"
    gerbers.mkdir(parents=True)
    prefix = f"homebrain-{design['id']}-motherboard"
    base.write_copper(gerbers / f"{prefix}-F_Cu.gbr", "F.Cu", design, pads, segments, vias, voids)
    base.write_copper(gerbers / f"{prefix}-B_Cu.gbr", "B.Cu", design, pads, segments, vias, voids)
    expansion = design["board"]["solder_mask_expansion"]
    base.write_mask(gerbers / f"{prefix}-F_Mask.gbr", "front", pads, expansion)
    base.write_mask(gerbers / f"{prefix}-B_Mask.gbr", "back", pads, expansion)
    write_silkscreen(gerbers / f"{prefix}-F_Silkscreen.gbr", design, pads)
    base.write_outline(gerbers / f"{prefix}-Edge_Cuts.gbr", design["board"]["width"], design["board"]["height"])
    write_drill(gerbers / f"{prefix}-PTH.drl", pads, vias)
    write_job(gerbers / f"{prefix}-job.gbrjob", design, prefix)
    for fabrication_path in gerbers.iterdir():
        if fabrication_path.suffix not in {".gbr", ".drl"}:
            continue
        fabrication_text = fabrication_path.read_text(encoding="ascii")
        fabrication_text = fabrication_text.replace("HomeBrain carrier", design["title"])
        fabrication_text = fabrication_text.replace("HomeBrain Carrier Generator", "HomeBrain Dedicated Motherboard Generator")
        fabrication_path.write_text(fabrication_text, encoding="ascii")
    base.deterministic_zip(gerbers, board_dir / f"{prefix}-gerbers.zip")
    write_jlcpcb_zip(gerbers, board_dir / f"{prefix}-jlcpcb-import-check.zip", prefix)
    write_layout(board_dir / "layout.json", design, pads, segments, vias, voids)
    write_board_bom(board_dir / "assembly-bom.csv", design)
    svg_outputs = {
        board_dir / f"{prefix}-assembly.svg": assembly_svg(design, pads, segments, vias),
        board_dir / f"{prefix}-schematic.svg": schematic_svg(design, pads),
        board_dir / f"{prefix}-fit-check.svg": fit_check_svg(design, pads),
    }
    for svg_path, content in svg_outputs.items():
        svg_path.write_text(content, encoding="utf-8")
        if not svg_only and not svg_path.name.endswith("-fit-check.svg"):
            base.render_png(svg_path, svg_path.with_suffix(".png"), chrome)
    return {
        "board_mm": [design["board"]["width"], design["board"]["height"], design["board"]["thickness"]],
        "pad_count": len(pads), "route_segment_count": len(segments), "via_count": len(vias),
        "ground_plane_void_count": len(voids), "gerber_zip": f"{design['id']}/{prefix}-gerbers.zip",
        "jlcpcb_import_zip": f"{design['id']}/{prefix}-jlcpcb-import-check.zip",
    }


def write_fleet_order(path: Path, catalog: dict) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["Order", "Item", "Quantity", "Specification", "Source"])
        for board in catalog["boards"]:
            writer.writerow([catalog.get("release_status", "HOLD"), board["name"], "5", f"{board['revision']}; {board['size'][0]} x {board['size'][1]} mm; 2-layer; 1.6 mm; 1 oz; lead-free HASL; bare board", "DO NOT ORDER until PREORDER-REVIEW.md blockers are resolved"])
        writer.writerow(["Fastener", "Everbilt #4 x 3/8 in Phillips pan-head sheet-metal screws", "Two 16-packs total", "24 used: 12 motherboard + 12 lid; eight spares", "Home Depot model 824681 / Store SKU 1006540029"])
        writer.writerow(["Additional electronics", "None", "0", "Use the purchased modules and their installed/supplied pins, the PMS factory cable, battery mating pigtail, and purchased 200 kOhm resistors", "Already purchased"])


def main() -> int:
    args = parse_args()
    catalog_path = args.design.resolve()
    output = args.output.resolve()
    if args.repackage_only:
        repackage_existing(catalog_path, output)
        return 0
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="homebrain-motherboards-") as temporary:
        staging = Path(temporary) / "generated"
        staging.mkdir()
        board_reports = {}
        for board in catalog["boards"]:
            design = board_design(catalog, board)
            board_reports[board["id"]] = generate_one(design, staging, args.chrome, args.svg_only)
        write_fleet_order(staging / "order-list.csv", catalog)
        (staging / "RELEASE-STATUS.txt").write_text(catalog.get("release_status", "HOLD") + "\n" + catalog.get("release_note", "Not approved for manufacture.") + "\n", encoding="utf-8")
        files = [path for path in staging.rglob("*") if path.is_file() and path.name != "manifest.json"]
        manifest = {
            "schema_version": 1,
            "release_status": catalog.get("release_status", "HOLD"),
            "generator": "scripts/generate-homebrain-motherboards.py",
            "design_sha256": sha256(catalog_path),
            "boards": board_reports,
            "files": {path.relative_to(staging).as_posix(): {"bytes": path.stat().st_size, "sha256": sha256(path)} for path in sorted(files)},
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if output.exists():
            expected = (ROOT / "hardware/homebrain-sensors/motherboards/generated").resolve()
            if output != expected:
                raise RuntimeError(f"Refusing to replace unexpected output directory: {output}")
            shutil.rmtree(output)
        shutil.copytree(staging, output)
    print("Generated dedicated HomeBrain motherboards:")
    for board_id, report in board_reports.items():
        print(f"  {board_id}: {report['pad_count']} pads, {report['route_segment_count']} segments, {report['via_count']} vias")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
