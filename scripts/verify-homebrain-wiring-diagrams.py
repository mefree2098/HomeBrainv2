#!/usr/bin/env python3
"""Independently validate HomeBrain physical wiring data, SVGs, PNGs, and repeatability."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SPEC = ROOT / "hardware/homebrain-sensors/wiring/physical-hardware.json"
DEFAULT_OUTPUT = ROOT / "docs/homebrain-sensors"
GENERATOR = ROOT / "scripts/generate-homebrain-wiring-diagrams.py"


class VerificationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, default=DEFAULT_SPEC)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--repeat", action="store_true", help="Regenerate twice and compare SVG/PNG byte streams.")
    return parser.parse_args()


EXPECTED_PIN_ORDERS = {
    "xiao_top": {
        "left_top_to_bottom": ["D0/A0", "D1", "D2", "D3", "D4/SDA", "D5/SCL", "D6/TX"],
        "right_top_to_bottom": ["VBUS/5V", "GND", "3V3", "D10", "D9", "D8", "D7/RX"],
    },
    "xiao_bottom": {"battery_pads_left_to_right": ["BAT-", "BAT+"]},
    "dht11": {"bottom_left_to_right": ["+", "OUT", "-"]},
    "bme680": {"right_top_to_bottom": ["VCC", "GND", "SCL", "SDA", "SDO", "CS"]},
    "scd41": {"bottom_left_to_right": ["GND", "VDD", "SCL", "SDA"]},
    "veml7700": {"bottom_left_to_right": ["VIN", "3Vo", "GND", "SCL", "SDA"]},
    "ld2410c": {"edge_left_to_right": ["TX", "RX", "OUT", "GND", "VCC"]},
    "pms_breakout": {"left_top_to_bottom": ["VCC(+5V)", "GND", "SET", "RXD", "TXD", "RESET", "NC1", "NC2"]},
    "pms5003": {},
    "battery": {"leads": ["POS", "NEG"]},
    "pigtail": {"leads": ["POS", "NEG"]},
    "resistor_r1": {"leads": ["A", "B"]},
    "resistor_r2": {"leads": ["A", "B"]},
    "usb_cable": {},
    "wall_adapter": {},
}


EXPECTED_DEFAULT_DIAGRAM_ROTATIONS = {
    "scd41": -90,
    "veml7700": 90,
}


EXPECTED_ATMOSPHERE_DIAGRAM_ROTATIONS = {
    "scd41": -90,
    "veml7700": -90,
}


EXPECTED_DESTINATIONS = {
    "bme680.VCC": "xiao_top.3V3",
    "bme680.GND": "xiao_top.GND",
    "bme680.SCL": "xiao_top.D5/SCL",
    "bme680.SDA": "xiao_top.D4/SDA",
    "bme680.SDO": "LEAVE EMPTY",
    "bme680.CS": "LEAVE EMPTY",
    "scd41.GND": "xiao_top.GND",
    "scd41.VDD": "xiao_top.3V3",
    "scd41.SCL": "xiao_top.D5/SCL",
    "scd41.SDA": "xiao_top.D4/SDA",
    "veml7700.VIN": "xiao_top.3V3",
    "veml7700.3Vo": "LEAVE EMPTY",
    "veml7700.GND": "xiao_top.GND",
    "veml7700.SCL": "xiao_top.D5/SCL",
    "veml7700.SDA": "xiao_top.D4/SDA",
    "pms_breakout.VCC(+5V)": "xiao_top.VBUS/5V",
    "pms_breakout.GND": "xiao_top.GND",
    "pms_breakout.SET": "LEAVE EMPTY",
    "pms_breakout.RXD": "xiao_top.D6/TX",
    "pms_breakout.TXD": "xiao_top.D7/RX",
    "pms_breakout.RESET": "LEAVE EMPTY",
    "pms_breakout.NC1": "LEAVE EMPTY",
    "pms_breakout.NC2": "LEAVE EMPTY",
}


EXPECTED_PARTS = {
    "atmosphere": {"xiao_top", "bme680", "scd41", "veml7700", "pms_breakout", "pms5003", "usb_cable", "wall_adapter"},
    "presence": {"xiao_top", "dht11", "veml7700", "ld2410c", "usb_cable", "wall_adapter"},
    "climate": {"xiao_top", "xiao_bottom", "dht11", "battery", "pigtail", "resistor_r1", "resistor_r2", "usb_cable"},
}


EXPECTED_UNCONNECTED = {
    "atmosphere": {"bme680.SDO", "bme680.CS", "veml7700.3Vo", "pms_breakout.SET", "pms_breakout.RESET", "pms_breakout.NC1", "pms_breakout.NC2"},
    "presence": {"veml7700.3Vo", "ld2410c.OUT"},
    "climate": set(),
}


EXPECTED_CONNECTIONS = {
    "atmosphere": {
        "A1": ("3V3", "xiao_top.3V3", ("bme680.VCC", "scd41.VDD", "veml7700.VIN")),
        "A2": ("GND", "xiao_top.GND", ("bme680.GND", "scd41.GND", "veml7700.GND", "pms_breakout.GND")),
        "A3": ("SDA", "xiao_top.D4/SDA", ("bme680.SDA", "scd41.SDA", "veml7700.SDA")),
        "A4": ("SCL", "xiao_top.D5/SCL", ("bme680.SCL", "scd41.SCL", "veml7700.SCL")),
        "A5": ("5V", "xiao_top.VBUS/5V", ("pms_breakout.VCC(+5V)",)),
        "A6": ("UART_TX", "xiao_top.D6/TX", ("pms_breakout.RXD",)),
        "A7": ("UART_RX", "pms_breakout.TXD", ("xiao_top.D7/RX",)),
        "A8": ("USB", "wall_adapter", ("usb_cable", "xiao_top.USB-C")),
    },
    "presence": {
        "P1": ("3V3", "xiao_top.D3", ("dht11.+",)),
        "P2": ("DATA", "xiao_top.D2", ("dht11.OUT",)),
        "P3": ("GND", "xiao_top.GND", ("dht11.-", "veml7700.GND", "ld2410c.GND")),
        "P4": ("3V3", "xiao_top.3V3", ("veml7700.VIN",)),
        "P5": ("SDA", "xiao_top.D4/SDA", ("veml7700.SDA",)),
        "P6": ("SCL", "xiao_top.D5/SCL", ("veml7700.SCL",)),
        "P7": ("5V", "xiao_top.VBUS/5V", ("ld2410c.VCC",)),
        "P8": ("UART_TX", "xiao_top.D6/TX", ("ld2410c.RX",)),
        "P9": ("UART_RX", "ld2410c.TX", ("xiao_top.D7/RX",)),
        "P10": ("USB", "wall_adapter", ("usb_cable", "xiao_top.USB-C")),
    },
    "climate": {
        "C1": ("3V3", "xiao_top.D3", ("dht11.+",)),
        "C2": ("DATA", "xiao_top.D2", ("dht11.OUT",)),
        "C3": ("GND", "xiao_top.GND", ("dht11.-", "resistor_r2.B")),
        "C4": ("BAT_POS", "pigtail.POS", ("xiao_bottom.BAT+", "resistor_r1.A")),
        "C5": ("BAT_NEG", "pigtail.NEG", ("xiao_bottom.BAT-",)),
        "C6": ("ADC", "resistor_r1.B", ("xiao_top.D0/A0", "resistor_r2.A")),
        "C7": ("USB", "usb_cable", ("xiao_top.USB-C",)),
    },
}


EXPECTED_ASINS = {
    "xiao": "B0DJ6N55FX",
    "dht11": "B0DQ3PPGH2",
    "bme680": "B0GXHGYRN2",
    "battery": "B0FZSR8MQY",
    "pigtail": "B07FP2FCYC",
    "resistor": "B08QRKSH5C",
    "scd41": "B0C622SS34",
    "veml7700": "B09KGYF83T",
    "ld2410c": "B0F1F97422",
    "pms5003": "B0BHZTCK8J",
    "pms_breakout": "B0BG612GB2",
    "wall_adapter": "B0B2MMYZPL",
    "usb_cable": "B0BPXKJSWY",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def flatten_pins(part: dict) -> set[str]:
    return {pin for ordered in part["physical_pin_order"].values() for pin in ordered}


def validate_spec(spec: dict) -> dict[str, dict]:
    require(spec.get("schema_version") == 1, "Unexpected wiring spec schema")
    require(spec["render"] == {"width": 2600, "height": 1700, "png_scale": 1}, "Render envelope changed")
    require({name: item["asin"] for name, item in spec["sources"].items()} == EXPECTED_ASINS, "Purchased ASIN catalog changed")
    for source_name, item in spec["sources"].items():
        require(item["url"] == f"https://www.amazon.com/dp/{item['asin']}", f"{source_name}: Amazon URL/ASIN mismatch")

    require(set(spec["parts"]) == set(EXPECTED_PIN_ORDERS), "Physical part catalog is incomplete or contains an unreviewed part")
    for part_name, expected in EXPECTED_PIN_ORDERS.items():
        require(spec["parts"][part_name]["physical_pin_order"] == expected, f"{part_name}: physical pin order changed")
        require("orientation" in spec["parts"][part_name], f"{part_name}: missing physical orientation")
    for part_name, expected_rotation in EXPECTED_DEFAULT_DIAGRAM_ROTATIONS.items():
        part = spec["parts"][part_name]
        require(part.get("diagram_rotation_degrees") == expected_rotation, f"{part_name}: diagram rotation must remain {expected_rotation} degrees clockwise")
        expected_order = "bottom-to-top" if expected_rotation == -90 else "top-to-bottom"
        require(expected_order in part.get("diagram_orientation", ""), f"{part_name}: rotated diagram orientation is not explicit")
    veml = spec["parts"]["veml7700"]
    require(veml.get("atmosphere_diagram_rotation_degrees") == -90, "veml7700: Atmosphere rotation must remain 90 degrees counter-clockwise")
    require("bottom-to-top" in veml.get("atmosphere_diagram_orientation", ""), "veml7700: Atmosphere pin order is not explicit")

    atmosphere_colors = spec.get("atmosphere_individual_wire_colors", [])
    atmosphere_path_count = sum(
        len(connection["to"])
        for device in spec["devices"]
        if device["id"] == "atmosphere"
        for connection in device["connections"]
        if connection["net"] != "USB"
    )
    require(len(atmosphere_colors) == atmosphere_path_count == 16, "Atmosphere must define exactly 16 individual jumper colors")
    require(len(set(atmosphere_colors)) == len(atmosphere_colors), "Atmosphere jumper colors must be unique")
    require(all(re.fullmatch(r"#[0-9A-Fa-f]{6}", color) for color in atmosphere_colors), "Atmosphere jumper colors must be six-digit hex values")

    devices = {device["id"]: device for device in spec["devices"]}
    require(set(devices) == set(EXPECTED_PARTS), "Expected exactly atmosphere, presence, and climate sheets")
    pin_catalog = {part_name: flatten_pins(part) for part_name, part in spec["parts"].items()}
    pin_catalog["xiao_top"].add("USB-C")

    for device_id, device in devices.items():
        require(set(device["parts"]) == EXPECTED_PARTS[device_id], f"{device_id}: incorrect physical part set")
        require(set(device["unconnected"]) == EXPECTED_UNCONNECTED[device_id], f"{device_id}: explicit no-connect list changed")
        actual_connections = {
            connection["id"]: (connection["net"], connection["from"], tuple(connection["to"]))
            for connection in device["connections"]
        }
        require(actual_connections == EXPECTED_CONNECTIONS[device_id], f"{device_id}: electrical connection contract changed")
        require(len(actual_connections) == len(device["connections"]), f"{device_id}: duplicate connection ID")
        for connection in device["connections"]:
            require(connection["net"] in spec["wire_colors"], f"{device_id}/{connection['id']}: unknown net color")
            for endpoint in [connection["from"], *connection["to"], *device["unconnected"]]:
                if "." not in endpoint:
                    require(endpoint in device["parts"], f"{device_id}: missing whole-part endpoint {endpoint}")
                    continue
                part_name, pin_name = endpoint.split(".", 1)
                require(part_name in device["parts"], f"{device_id}: endpoint uses absent part {part_name}")
                require(pin_name in pin_catalog[part_name], f"{device_id}: no physical pin {endpoint}")

    # This catches the safety regression that motivated the corrected Climate sheet.
    climate = devices["climate"]
    require({"resistor_r1", "resistor_r2"}.issubset(climate["parts"]), "Climate divider must contain two external resistors")
    require(EXPECTED_CONNECTIONS["climate"]["C4"][2][-1] == "resistor_r1.A", "BAT+ must feed R1")
    require(EXPECTED_CONNECTIONS["climate"]["C6"][2][-1] == "resistor_r2.A", "A0 node must feed R2")
    require(EXPECTED_CONNECTIONS["climate"]["C3"][2][-1] == "resistor_r2.B", "R2 must terminate at ground")
    return devices


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"{path.name}: invalid PNG signature")
    return struct.unpack(">II", data[16:24])


def data_values(root: ET.Element, attribute: str) -> list[str]:
    return [element.attrib[attribute] for element in root.iter() if attribute in element.attrib]


def xiao_side(spec: dict, endpoint: str) -> str | None:
    if not endpoint.startswith("xiao_top."):
        return None
    pin_name = endpoint.split(".", 1)[1]
    order = spec["parts"]["xiao_top"]["physical_pin_order"]
    if pin_name in order["left_top_to_bottom"]:
        return "left"
    if pin_name in order["right_top_to_bottom"]:
        return "right"
    if pin_name == "USB-C":
        return "usb"
    return None


def orthogonal_points(path_data: str) -> list[tuple[float, float]]:
    tokens = re.findall(r"[MHV]|-?\d+(?:\.\d+)?", path_data)
    points: list[tuple[float, float]] = []
    index = 0
    x = y = 0.0
    while index < len(tokens):
        command = tokens[index]
        index += 1
        if command == "M":
            x = float(tokens[index])
            y = float(tokens[index + 1])
            index += 2
        elif command == "H":
            x = float(tokens[index])
            index += 1
        elif command == "V":
            y = float(tokens[index])
            index += 1
        else:
            raise VerificationError(f"Unsupported path token {command!r} in {path_data!r}")
        points.append((x, y))
    return points


def verify_svg(svg_path: Path, spec: dict, device: dict) -> dict:
    root = ET.parse(svg_path).getroot()
    require(root.attrib.get("width") == str(spec["render"]["width"]), f"{svg_path.name}: wrong width")
    require(root.attrib.get("height") == str(spec["render"]["height"]), f"{svg_path.name}: wrong height")
    require(root.attrib.get("viewBox") == f"0 0 {spec['render']['width']} {spec['render']['height']}", f"{svg_path.name}: wrong viewBox")

    metadata = next((element for element in root.iter() if element.tag.endswith("metadata") and element.attrib.get("id") == "homebrain-physical-wiring"), None)
    require(metadata is not None and metadata.text, f"{svg_path.name}: missing machine-readable metadata")
    parsed_metadata = json.loads(metadata.text)
    require(parsed_metadata["device"] == device["id"], f"{svg_path.name}: wrong metadata device")
    require(set(parsed_metadata["parts"]) == set(device["parts"]), f"{svg_path.name}: metadata part mismatch")
    require(set(parsed_metadata["connections"]) == {item["id"] for item in device["connections"]}, f"{svg_path.name}: metadata connection mismatch")

    rendered_parts = set(data_values(root, "data-part"))
    require(rendered_parts == set(device["parts"]), f"{svg_path.name}: rendered parts differ: {rendered_parts ^ set(device['parts'])}")
    expected_rotations = EXPECTED_ATMOSPHERE_DIAGRAM_ROTATIONS if device["id"] == "atmosphere" else EXPECTED_DEFAULT_DIAGRAM_ROTATIONS
    for part_name, expected_rotation in expected_rotations.items():
        if part_name not in device["parts"]:
            continue
        part_element = next((element for element in root.iter() if element.attrib.get("data-part") == part_name), None)
        require(part_element is not None, f"{svg_path.name}: missing rendered {part_name}")
        require(part_element.attrib.get("data-rotation") == str(expected_rotation), f"{svg_path.name}: {part_name} is not visibly rotated {expected_rotation} degrees")

    rendered_pins = {element.attrib["data-pin"]: element for element in root.iter() if "data-pin" in element.attrib}
    required_pins = {
        f"{part_name}.{pin_name}"
        for part_name in device["parts"]
        for pin_name in flatten_pins(spec["parts"][part_name])
    }
    require(required_pins.issubset(rendered_pins), f"{svg_path.name}: missing physical pins {sorted(required_pins - set(rendered_pins))}")

    xiao_order = spec["parts"]["xiao_top"]["physical_pin_order"]
    if "xiao_top" in device["parts"]:
        for side, order_key in (("left", "left_top_to_bottom"), ("right", "right_top_to_bottom")):
            for pin_name in xiao_order[order_key]:
                endpoint = f"xiao_top.{pin_name}"
                require(rendered_pins[endpoint].attrib.get("data-side") == side, f"{svg_path.name}: {endpoint} is not assigned to its physical {side} row")
        row_legends = set(data_values(root, "data-xiao-row-legend"))
        require(row_legends == {"left", "right"}, f"{svg_path.name}: missing XIAO left/right used-row legends")

    for part_name, expected_rotation in expected_rotations.items():
        if part_name not in device["parts"]:
            continue
        ordered_names = spec["parts"][part_name]["physical_pin_order"]["bottom_left_to_right"]
        ordered_pins = [rendered_pins[f"{part_name}.{pin_name}"] for pin_name in ordered_names]
        x_positions = [float(element.attrib["cx"]) for element in ordered_pins]
        y_positions = [float(element.attrib["cy"]) for element in ordered_pins]
        expected_side = "right" if expected_rotation == -90 else "left"
        require(max(x_positions) == min(x_positions), f"{svg_path.name}: rotated {part_name} holes are not in one edge column")
        expected_y_positions = sorted(y_positions, reverse=expected_rotation == -90)
        require(y_positions == expected_y_positions and len(set(y_positions)) == len(y_positions), f"{svg_path.name}: rotated {part_name} hole order does not match its physical rotation")
        require(all(element.attrib.get("data-side") == expected_side for element in ordered_pins), f"{svg_path.name}: rotated {part_name} holes are not on the {expected_side} edge")
        for pin_name in ordered_names:
            endpoint = f"{part_name}.{pin_name}"
            expected_destination = EXPECTED_DESTINATIONS[endpoint]
            require(rendered_pins[endpoint].attrib.get("data-destination") == expected_destination, f"{svg_path.name}: {endpoint} destination label is wrong")

    used_pins = {
        endpoint
        for connection in device["connections"]
        for endpoint in [connection["from"], *connection["to"]]
        if "." in endpoint
    }
    for pin_name in required_pins:
        state = rendered_pins[pin_name].attrib.get("data-state")
        if pin_name in device["unconnected"]:
            require(state == "unconnected", f"{svg_path.name}: {pin_name} is not visibly marked no-connect")
        elif pin_name in used_pins:
            require(state == "used", f"{svg_path.name}: {pin_name} is not visibly marked used")
        elif pin_name.startswith("battery."):
            require(state == "physical-mate", f"{svg_path.name}: battery connector contact is not identified")
        else:
            require(state == "unused", f"{svg_path.name}: {pin_name} should be visibly unused")

    rendered_connections = data_values(root, "data-connection")
    for connection in device["connections"]:
        expected_count = 1 if connection["net"] == "USB" else len(connection["to"])
        require(rendered_connections.count(connection["id"]) == expected_count, f"{svg_path.name}: {connection['id']} should have {expected_count} rendered path(s)")

    rendered_paths = [element for element in root.iter() if "data-connection" in element.attrib]
    if device["id"] == "atmosphere":
        controller = next((element for element in root.iter() if element.attrib.get("data-layout-role") == "central-controller"), None)
        require(controller is not None, f"{svg_path.name}: XIAO is not marked as the central controller")
        controller_center = float(controller.attrib["x"]) + float(controller.attrib["width"]) / 2
        require(abs(controller_center - spec["render"]["width"] / 2) < 0.01, f"{svg_path.name}: XIAO physical board is not centered")

        jumper_paths = [path for path in rendered_paths if path.attrib.get("data-connection") != "A8"]
        expected_wire_ids = [f"W{index:02d}" for index in range(1, 17)]
        require(len(jumper_paths) == 16, f"{svg_path.name}: expected 16 individually rendered jumper paths")
        paths_by_wire_id = {path.attrib.get("data-wire-id"): path for path in jumper_paths}
        require(set(paths_by_wire_id) == set(expected_wire_ids), f"{svg_path.name}: individual W01-W16 path IDs changed")
        require(
            [paths_by_wire_id[wire_id].attrib.get("data-wire-color") for wire_id in expected_wire_ids] == spec["atmosphere_individual_wire_colors"],
            f"{svg_path.name}: jumper path colors do not match the reviewed palette",
        )
        require(len({path.attrib.get("d") for path in jumper_paths}) == 16, f"{svg_path.name}: two Atmosphere jumper wires share the same visible path")
        wire_tags = data_values(root, "data-wire-tag")
        require(len(wire_tags) == 16 and set(wire_tags) == set(expected_wire_ids), f"{svg_path.name}: every jumper must have one matching visible W-number tag")

        expected_runs = []
        for connection in device["connections"]:
            if connection["net"] == "USB":
                continue
            for target in connection["to"]:
                expected_runs.append((connection["id"], connection["from"], target))
        actual_runs = [
            (
                paths_by_wire_id[wire_id].attrib.get("data-connection"),
                paths_by_wire_id[wire_id].attrib.get("data-from"),
                paths_by_wire_id[wire_id].attrib.get("data-to"),
            )
            for wire_id in expected_wire_ids
        ]
        require(actual_runs == expected_runs, f"{svg_path.name}: W-number path endpoints no longer match the point-to-point netlist")
        for endpoint, destination in EXPECTED_DESTINATIONS.items():
            if endpoint in rendered_pins:
                require(rendered_pins[endpoint].attrib.get("data-destination") == destination, f"{svg_path.name}: {endpoint} visible destination is wrong")

    for path in rendered_paths:
        source_name = path.attrib.get("data-from", "")
        target_name = path.attrib.get("data-to", "")
        source_side = xiao_side(spec, source_name)
        target_side = xiao_side(spec, target_name)
        expected_side = source_side or target_side
        if expected_side is None:
            continue
        require(path.attrib.get("data-xiao-side") == expected_side, f"{svg_path.name}: {path.attrib.get('id')} does not identify its XIAO {expected_side} row")
        if expected_side == "usb":
            continue
        points = orthogonal_points(path.attrib["d"])
        require(len(points) >= 2, f"{svg_path.name}: {path.attrib.get('id')} has no visible XIAO-side segment")
        if source_side:
            first_x, second_x = points[0][0], points[1][0]
            require(second_x < first_x if source_side == "left" else second_x > first_x, f"{svg_path.name}: {path.attrib.get('id')} does not visibly exit the XIAO {source_side} row")
        if target_side:
            previous_x, final_x = points[-2][0], points[-1][0]
            require(previous_x < final_x if target_side == "left" else previous_x > final_x, f"{svg_path.name}: {path.attrib.get('id')} does not visibly enter the XIAO {target_side} row")

    svg_text = svg_path.read_text()
    require("XIAO already contains 200" not in svg_text, f"{svg_path.name}: contains superseded divider claim")
    if device["id"] == "climate":
        require("TWO external 200 kΩ resistors are required" in svg_text, "Climate sheet lacks corrected safety warning")
        require("There is no onboard A0 pull-down" in svg_text, "Climate sheet lacks explicit onboard-resistor correction")
    return {
        "sha256": sha256(svg_path),
        "bytes": svg_path.stat().st_size,
        "parts": len(rendered_parts),
        "pins": len(rendered_pins),
        "connection_paths": len(rendered_connections),
    }


def run_generator(spec_path: Path, output: Path) -> None:
    subprocess.run(
        ["python3", str(GENERATOR), "--spec", str(spec_path), "--output", str(output)],
        cwd=ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def verify_generated_pair(output: Path, spec: dict, devices: dict[str, dict]) -> dict:
    report = {}
    for device_id, device in devices.items():
        svg_path = output / f"wiring-{device_id}.svg"
        png_path = output / f"wiring-{device_id}.png"
        require(svg_path.is_file(), f"Missing {svg_path}")
        require(png_path.is_file(), f"Missing {png_path}")
        svg_report = verify_svg(svg_path, spec, device)
        require(png_size(png_path) == (spec["render"]["width"], spec["render"]["height"]), f"{png_path.name}: wrong pixel dimensions")
        report[device_id] = {
            "svg": svg_report,
            "png": {"sha256": sha256(png_path), "bytes": png_path.stat().st_size, "size": list(png_size(png_path))},
        }
    return report


def compare_outputs(first: Path, second: Path, device_ids: set[str], label: str) -> None:
    for device_id in device_ids:
        for suffix in ("svg", "png"):
            first_file = first / f"wiring-{device_id}.{suffix}"
            second_file = second / f"wiring-{device_id}.{suffix}"
            require(sha256(first_file) == sha256(second_file), f"{device_id}.{suffix}: {label} differs")


def main() -> None:
    args = parse_args()
    spec = json.loads(args.spec.read_text())
    devices = validate_spec(spec)
    report = verify_generated_pair(args.output, spec, devices)

    with tempfile.TemporaryDirectory(prefix="homebrain-wiring-verify-") as temp_name:
        regenerated = Path(temp_name) / "regenerated"
        regenerated.mkdir()
        run_generator(args.spec, regenerated)
        compare_outputs(args.output, regenerated, set(devices), "checked artifact and fresh generation")
        if args.repeat:
            repeated = Path(temp_name) / "repeated"
            repeated.mkdir()
            run_generator(args.spec, repeated)
            compare_outputs(regenerated, repeated, set(devices), "first and second fresh generations")

    print(json.dumps({"status": "verified", "repeatability": bool(args.repeat), "devices": report}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
