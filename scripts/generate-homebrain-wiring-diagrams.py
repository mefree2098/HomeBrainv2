#!/usr/bin/env python3
"""Generate auditable physical SVG/PNG wiring sheets for the HomeBrain sensor fleet."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path
from textwrap import wrap
from xml.sax.saxutils import escape, quoteattr


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SPEC = ROOT / "hardware/homebrain-sensors/wiring/physical-hardware.json"
DEFAULT_OUTPUT = ROOT / "docs/homebrain-sensors"
DEFAULT_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


INK = "#14243b"
MUTED = "#61708a"
PAPER = "#f5f7fb"
CARD = "#ffffff"
LINE = "#c7d0df"
TEAL = "#44d5c4"
UNUSED = "#cbd5e1"
UNCONNECTED = "#94a3b8"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, default=DEFAULT_SPEC)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--chrome", type=Path, default=DEFAULT_CHROME)
    parser.add_argument("--svg-only", action="store_true")
    return parser.parse_args()


def key(part: str, pin: str | None = None) -> str:
    return part if pin is None else f"{part}.{pin}"


def safe_id(value: str) -> str:
    result = []
    for char in value:
        result.append(char.lower() if char.isalnum() else "-")
    return "".join(result).strip("-")


class Sheet:
    def __init__(self, width: int, height: int, device: dict, spec: dict):
        self.width = width
        self.height = height
        self.device = device
        self.spec = spec
        self.base: list[str] = []
        self.wires: list[str] = []
        self.parts: list[str] = []
        self.labels: list[str] = []
        self.endpoints: dict[str, tuple[float, float]] = {}
        self.used: dict[str, tuple[str, str]] = {}
        self.atmosphere_runs: dict[tuple[str, str], dict[str, str]] = {}
        self.endpoint_wire_colors: dict[str, str] = {}
        self.unconnected = set(device["unconnected"])
        for connection in device["connections"]:
            net = connection["net"]
            color = spec["wire_colors"][net]
            for endpoint in [connection["from"], *connection["to"]]:
                if "." in endpoint:
                    self.used[endpoint] = (net, color)

        if device["id"] == "atmosphere":
            colors = spec["atmosphere_individual_wire_colors"]
            run_index = 0
            for connection in device["connections"]:
                if connection["net"] == "USB":
                    continue
                for target in connection["to"]:
                    color = colors[run_index]
                    wire_id = f"W{run_index + 1:02d}"
                    self.atmosphere_runs[(connection["id"], target)] = {
                        "id": wire_id,
                        "color": color,
                    }
                    self.endpoint_wire_colors[target] = color
                    if len(connection["to"]) == 1:
                        self.endpoint_wire_colors[connection["from"]] = color
                    run_index += 1

    @staticmethod
    def attrs(**kwargs: object) -> str:
        converted = []
        for name, value in kwargs.items():
            if value is None:
                continue
            converted.append(f"{name.replace('_', '-')}={quoteattr(str(value))}")
        return " ".join(converted)

    def rect(self, layer: list[str], x: float, y: float, w: float, h: float, *, rx: float = 0, **attrs: object) -> None:
        layer.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" {self.attrs(**attrs)}/>')

    def circle(self, layer: list[str], x: float, y: float, radius: float, **attrs: object) -> None:
        layer.append(f'<circle cx="{x}" cy="{y}" r="{radius}" {self.attrs(**attrs)}/>')

    def line(self, layer: list[str], x1: float, y1: float, x2: float, y2: float, **attrs: object) -> None:
        layer.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" {self.attrs(**attrs)}/>')

    def path(self, layer: list[str], d: str, **attrs: object) -> None:
        layer.append(f'<path d={quoteattr(d)} {self.attrs(**attrs)}/>')

    def text(
        self,
        layer: list[str],
        x: float,
        y: float,
        value: str,
        *,
        size: float = 22,
        weight: int = 500,
        fill: str = INK,
        anchor: str = "start",
        family: str = "Arial, Helvetica, sans-serif",
        **attrs: object,
    ) -> None:
        layer.append(
            f'<text x="{x}" y="{y}" font-family={quoteattr(family)} font-size="{size}" '
            f'font-weight="{weight}" fill={quoteattr(fill)} text-anchor={quoteattr(anchor)} '
            f'{self.attrs(**attrs)}>{escape(value)}</text>'
        )

    def wrapped_text(
        self,
        layer: list[str],
        x: float,
        y: float,
        value: str,
        *,
        width_chars: int,
        line_height: float = 28,
        size: float = 21,
        weight: int = 500,
        fill: str = INK,
    ) -> float:
        lines = wrap(value, width=width_chars, break_long_words=False, break_on_hyphens=False) or [""]
        for index, current in enumerate(lines):
            self.text(layer, x, y + index * line_height, current, size=size, weight=weight, fill=fill)
        return y + len(lines) * line_height

    def card(self, x: float, y: float, w: float, h: float, title: str, source: str | None = None) -> None:
        self.rect(self.base, x, y, w, h, rx=22, fill=CARD, stroke=LINE, stroke_width=3)
        title_size = 20 if len(title) > 46 else 22
        self.text(self.labels, x + 26, y + 39, title, size=title_size, weight=800)
        if source:
            item = self.spec["sources"][source]
            self.text(self.labels, x + w - 26, y + 70, f"ASIN {item['asin']}", size=15, weight=800, fill=MUTED, anchor="end")

    def pin(
        self,
        part: str,
        pin_name: str,
        x: float,
        y: float,
        *,
        label_x: float,
        label_y: float,
        anchor: str,
        label_size: float = 16,
        label_fill: str | None = None,
        prong: tuple[float, float, float, float] | None = None,
        display_label: str | None = None,
        destination: str | None = None,
        side: str | None = None,
    ) -> None:
        endpoint = key(part, pin_name)
        self.endpoints[endpoint] = (x, y)
        net_color = self.endpoint_wire_colors.get(endpoint, self.used.get(endpoint, ("", UNUSED))[1])
        state = "used" if endpoint in self.used else "unconnected" if endpoint in self.unconnected else "unused"
        fill = "#ffffff" if state == "used" else "#eef2f7"
        stroke = net_color if state == "used" else UNCONNECTED if state == "unconnected" else UNUSED
        if prong:
            self.line(self.parts, *prong, stroke=stroke, stroke_width=7, stroke_linecap="round")
        self.circle(
            self.parts,
            x,
            y,
            10,
            fill=fill,
            stroke=stroke,
            stroke_width=5 if state == "used" else 3,
            id=f"pin-{safe_id(endpoint)}",
            data_pin=endpoint,
            data_state=state,
            data_net=self.used.get(endpoint, ("", ""))[0],
            data_destination=destination,
            data_side=side,
        )
        self.circle(self.parts, x, y, 4, fill="#0f172a" if state == "used" else "#94a3b8")
        pin_label_fill = label_fill if label_fill is not None else INK if state == "used" else MUTED
        self.text(self.labels, label_x, label_y, display_label or pin_name, size=label_size, weight=800 if state == "used" else 600, fill=pin_label_fill, anchor=anchor)
        if state == "unconnected":
            self.line(self.labels, x - 6, y - 6, x + 6, y + 6, stroke="#64748b", stroke_width=3)
            self.line(self.labels, x + 6, y - 6, x - 6, y + 6, stroke="#64748b", stroke_width=3)

    def endpoint(self, name: str, x: float, y: float) -> None:
        self.endpoints[name] = (x, y)

    def callout(self, endpoint: str, x: float, y: float) -> None:
        if endpoint not in self.used:
            return
        net, color = self.used[endpoint]
        self.rect(self.labels, x, y, 76, 25, rx=12, fill=color)
        self.text(self.labels, x + 38, y + 18, net, size=12, weight=800, fill="#ffffff", anchor="middle")

    def physical_board_note(self, x: float, y: float, text_value: str, width_chars: int) -> None:
        self.wrapped_text(self.labels, x, y, text_value, width_chars=width_chars, line_height=22, size=16, fill=MUTED)

    def physical_destination(self, endpoint: str) -> str:
        if endpoint in self.unconnected:
            return "LEAVE EMPTY"
        for connection in self.device["connections"]:
            if endpoint == connection["from"]:
                return " + ".join(connection["to"])
            if endpoint in connection["to"]:
                return connection["from"]
        return "NO WIRE"

    @staticmethod
    def display_destination(destination: str) -> str:
        if destination.startswith("xiao_top."):
            return "XIAO " + destination.split(".", 1)[1]
        return destination

    def xiao_pin_side(self, endpoint: str) -> str | None:
        if not endpoint.startswith("xiao_top."):
            return None
        pin_name = endpoint.split(".", 1)[1]
        order = self.spec["parts"]["xiao_top"]["physical_pin_order"]
        if pin_name in order["left_top_to_bottom"]:
            return "left"
        if pin_name in order["right_top_to_bottom"]:
            return "right"
        if pin_name == "USB-C":
            return "usb"
        return None

    def draw_xiao(self, x: float, y: float, w: float = 650, h: float = 990) -> None:
        self.card(x, y, w, h, "SEEED XIAO ESP32-C6 — COMPONENT SIDE", "xiao")
        self.text(self.labels, x + 26, y + 72, "USB-C ↑ TOP · antenna ↓ BOTTOM · do not mirror", size=18, weight=700, fill="#087f74")

        bx, by, bw, bh = x + (w - 390) / 2, y + 182, 390, 460
        self.rect(
            self.parts,
            bx,
            by,
            bw,
            bh,
            rx=22,
            fill="#075e61",
            stroke=TEAL,
            stroke_width=5,
            id="part-xiao-top",
            data_part="xiao_top",
            data_layout_role="central-controller" if self.device["id"] == "atmosphere" else None,
        )
        self.rect(self.parts, bx + 120, by - 31, 150, 64, rx=13, fill="#dbe2ea", stroke="#475569", stroke_width=4)
        self.rect(self.parts, bx + 142, by - 18, 106, 30, rx=8, fill="#6b7280")
        self.text(self.labels, bx + bw / 2, by - 48, "USB-C", size=20, weight=800, anchor="middle")
        self.endpoint("xiao_top.USB-C", bx + bw / 2, by - 31)

        self.rect(self.parts, bx + 137, by + 133, 116, 108, rx=10, fill="#172033", stroke="#91a4b8", stroke_width=3)
        self.text(self.labels, bx + bw / 2, by + 190, "ESP32-C6", size=18, weight=700, fill="#ffffff", anchor="middle")
        self.rect(self.parts, bx + 149, by + 348, 92, 48, rx=9, fill="#f5eee0", stroke="#a69372", stroke_width=3)
        self.text(self.labels, bx + bw / 2, by + 380, "2.4 GHz", size=14, weight=800, anchor="middle")
        self.circle(self.parts, bx + 288, by + 372, 15, fill="#d7ab48", stroke="#694f16", stroke_width=3)
        self.circle(self.parts, bx + 288, by + 372, 5, fill="#eef2f7")
        self.text(self.labels, bx + 311, by + 378, "U.FL", size=13, weight=700, fill="#d7eff0")

        left = self.spec["parts"]["xiao_top"]["physical_pin_order"]["left_top_to_bottom"]
        right = self.spec["parts"]["xiao_top"]["physical_pin_order"]["right_top_to_bottom"]
        for index, pin_name in enumerate(left):
            py = by + 62 + index * 56
            self.pin("xiao_top", pin_name, bx + 17, py, label_x=bx + 41, label_y=py + 6, anchor="start", label_size=15, label_fill="#daf7f4", side="left")
        for index, pin_name in enumerate(right):
            py = by + 62 + index * 56
            self.pin("xiao_top", pin_name, bx + bw - 17, py, label_x=bx + bw - 41, label_y=py + 6, anchor="end", label_size=15, label_fill="#daf7f4", side="right")

        used_left = [pin_name for pin_name in left if key("xiao_top", pin_name) in self.used]
        used_right = [pin_name for pin_name in right if key("xiao_top", pin_name) in self.used]
        row_legend_y = y + (694 if self.device["id"] == "atmosphere" else 724)
        self.rect(self.labels, x + 24, row_legend_y, w - 48, 35, rx=17, fill="#e8f8f5", stroke="#8bd8cf", stroke_width=2)
        self.text(self.labels, x + 40, row_legend_y + 24, "LEFT ROW USED → " + " · ".join(used_left), size=15, weight=900, fill="#075e61", data_xiao_row_legend="left")
        self.rect(self.labels, x + 24, row_legend_y + 44, w - 48, 35, rx=17, fill="#eef4ff", stroke="#9db8e5", stroke_width=2)
        self.text(self.labels, x + 40, row_legend_y + 68, "RIGHT ROW USED → " + " · ".join(used_right), size=15, weight=900, fill="#244b85", data_xiao_row_legend="right")

        legend_y = y + (792 if self.device["id"] == "atmosphere" else 842)
        self.text(self.labels, x + 26, legend_y, "THE HOLE TO USE", size=18, weight=800)
        self.wrapped_text(
            self.labels,
            x + 26,
            legend_y + 31,
            "If headers are installed, connect to the header pin—or to any breadboard hole in the same numbered row on that same side of the center groove.",
            width_chars=92 if self.device["id"] == "atmosphere" else 74,
            line_height=21,
            size=15,
            fill=MUTED,
        )
        if self.device["id"] == "atmosphere":
            self.text(self.labels, x + 26, y + h - 27, "Colored ring = connect · gray = no wire · USB-C and antenna end shown", size=15, weight=700, fill=MUTED)
        else:
            self.text(self.labels, x + 26, y + h - 55, "Colored ring = connect · pale gray = no wire in this build", size=15, weight=700, fill=MUTED)
            self.text(self.labels, x + 26, y + h - 27, "USB-C and the antenna end are intentionally shown.", size=15, weight=700, fill=MUTED)

    def draw_bme680(self, x: float, y: float, w: float = 700, h: float = 310) -> None:
        self.card(x, y, w, h, "hiBCTR BME680 — 6 HOLES", "bme680")
        bx, by, bw, bh = x + 58, y + 76, w - 100, h - 112
        self.rect(self.parts, bx, by, bw, bh, rx=16, fill="#692d91", stroke="#b58bd2", stroke_width=4, id="part-bme680", data_part="bme680")
        self.rect(self.parts, bx + 34, by + 46, 104, 104, rx=13, fill="#d3d8de", stroke="#57606e", stroke_width=4)
        self.rect(self.parts, bx + 60, by + 72, 52, 52, rx=8, fill="#737b86")
        self.text(self.labels, bx + 86, by + 174, "BME680", size=15, weight=800, fill="#f3e8ff", anchor="middle")
        pins = self.spec["parts"]["bme680"]["physical_pin_order"]["right_top_to_bottom"]
        spacing = (bh - 46) / (len(pins) - 1)
        for index, pin_name in enumerate(pins):
            py = by + 23 + index * spacing
            endpoint = key("bme680", pin_name)
            destination = self.physical_destination(endpoint)
            self.pin(
                "bme680",
                pin_name,
                bx + bw - 15,
                py,
                label_x=bx + bw - 40,
                label_y=py + 5,
                anchor="end",
                label_size=12,
                label_fill="#f5eaff" if destination != "LEAVE EMPTY" else "#ddd2e7",
                display_label=f"{pin_name} → {self.display_destination(destination)}",
                destination=destination,
                side="right",
            )
        self.physical_board_note(x + 25, y + h - 17, "Sensor LEFT · holes RIGHT · labels top→bottom", 70)

    def draw_scd41(self, x: float, y: float, w: float = 700, h: float = 310) -> None:
        self.card(x, y, w, h, "TEYLETEN ROBOT SCD41 — 4 HOLES", "scd41")
        bx, by, bw, bh = x + 58, y + 76, w - 100, h - 112
        self.rect(self.parts, bx, by, bw, bh, rx=16, fill="#1266ae", stroke="#76b6eb", stroke_width=4, id="part-scd41", data_part="scd41", data_rotation="-90")
        self.rect(self.parts, bx + 18, by + 20, 145, bh - 40, rx=12, fill="#d8dde2", stroke="#636b74", stroke_width=4)
        for dx, dy in ((55, 50), (105, 50), (55, 95), (105, 95), (55, 140), (105, 140)):
            self.circle(self.parts, bx + dx, by + dy, 14, fill="#8d969f")
        pins = list(reversed(self.spec["parts"]["scd41"]["physical_pin_order"]["bottom_left_to_right"]))
        spacing = (bh - 54) / (len(pins) - 1)
        for index, pin_name in enumerate(pins):
            py = by + 27 + index * spacing
            endpoint = key("scd41", pin_name)
            destination = self.physical_destination(endpoint)
            self.pin(
                "scd41",
                pin_name,
                bx + bw - 15,
                py,
                label_x=bx + bw - 40,
                label_y=py + 5,
                anchor="end",
                label_size=12,
                label_fill="#e7f5ff",
                display_label=f"{pin_name} → {self.display_destination(destination)}",
                destination=destination,
                side="right",
            )
        self.text(self.labels, x + 24, y + h - 17, "ROTATED 90° CCW · sensor edge LEFT · holes RIGHT · order top→bottom: SDA / SCL / VDD / GND", size=12.5, weight=800, fill=MUTED)

    def draw_veml7700(self, x: float, y: float, w: float = 480, h: float = 415) -> None:
        self.card(x, y, w, h, "HILETGO VEML7700 — 5 HOLES", "veml7700")
        if self.device["id"] == "atmosphere":
            bx, by, bw, bh = x + 58, y + 76, w - 100, h - 112
            self.rect(self.parts, bx, by, bw, bh, rx=15, fill="#176db0", stroke="#7bc0ed", stroke_width=4, id="part-veml7700", data_part="veml7700", data_rotation="-90")
            self.rect(self.parts, bx + 28, by + 32, 58, 48, rx=8, fill="#eef5f7", stroke="#637381", stroke_width=3)
            self.circle(self.parts, bx + 57, by + 56, 11, fill="#bdd8e7")
            self.text(self.labels, bx + 58, by + 119, "VEML7700", size=14, weight=800, fill="#eaf6ff", anchor="middle")
            pins = list(reversed(self.spec["parts"]["veml7700"]["physical_pin_order"]["bottom_left_to_right"]))
            spacing = (bh - 50) / (len(pins) - 1)
            for index, pin_name in enumerate(pins):
                py = by + 25 + index * spacing
                endpoint = key("veml7700", pin_name)
                destination = self.physical_destination(endpoint)
                self.pin(
                    "veml7700",
                    pin_name,
                    bx + bw - 15,
                    py,
                    label_x=bx + bw - 40,
                    label_y=py + 5,
                    anchor="end",
                    label_size=12,
                    label_fill="#e7f5ff" if destination != "LEAVE EMPTY" else "#d8e0e8",
                    display_label=f"{pin_name} → {self.display_destination(destination)}",
                    destination=destination,
                    side="right",
                )
            self.text(self.labels, x + 24, y + h - 17, "ROTATED 90° CCW · holes RIGHT · order top→bottom: SDA / SCL / GND / 3Vo / VIN", size=12.5, weight=800, fill=MUTED)
            return

        bx, by, bw, bh = x + 115, y + 78, 250, 300
        self.rect(self.parts, bx, by, bw, bh, rx=15, fill="#176db0", stroke="#7bc0ed", stroke_width=4, id="part-veml7700", data_part="veml7700", data_rotation="90")
        self.rect(self.parts, bx + 188, by + 52, 44, 58, rx=8, fill="#eef5f7", stroke="#637381", stroke_width=3)
        self.circle(self.parts, bx + 210, by + 81, 11, fill="#bdd8e7")
        self.text(self.labels, bx + 210, by + 151, "VEML", size=14, weight=800, fill="#eaf6ff", anchor="middle")
        self.text(self.labels, bx + 210, by + 170, "7700", size=14, weight=800, fill="#eaf6ff", anchor="middle")
        pins = self.spec["parts"]["veml7700"]["physical_pin_order"]["bottom_left_to_right"]
        for index, pin_name in enumerate(pins):
            py = by + 38 + index * 55
            endpoint = key("veml7700", pin_name)
            destination = self.physical_destination(endpoint)
            self.pin(
                "veml7700",
                pin_name,
                bx + 15,
                py,
                label_x=bx + 38,
                label_y=py + 5,
                anchor="start",
                label_size=11.5,
                label_fill="#e7f5ff" if destination != "LEAVE EMPTY" else "#d8e0e8",
                display_label=f"{pin_name} → {self.display_destination(destination)}",
                destination=destination,
                side="left",
            )
        self.text(self.labels, x + 24, y + h - 18, "ROTATED 90° CW · sensor edge RIGHT · holes LEFT · order top→bottom", size=13, weight=800, fill=MUTED)

    def draw_dht11(self, x: float, y: float, w: float = 500, h: float = 430) -> None:
        self.card(x, y, w, h, "DIYABLES DHT11 MODULE — 3 PINS", "dht11")
        bx, by, bw, bh = x + 140, y + 92, 220, 280
        self.rect(self.parts, bx, by, bw, bh, rx=14, fill="#171d29", stroke="#536074", stroke_width=4, id="part-dht11", data_part="dht11")
        self.rect(self.parts, bx + 42, by + 20, 136, 150, rx=11, fill="#2978b8", stroke="#7dc4ee", stroke_width=4)
        for index in range(5):
            self.line(self.parts, bx + 61, by + 43 + index * 23, bx + 159, by + 43 + index * 23, stroke="#163e67", stroke_width=7, stroke_linecap="round")
        pins = self.spec["parts"]["dht11"]["physical_pin_order"]["bottom_left_to_right"]
        for index, pin_name in enumerate(pins):
            px = bx + 48 + index * 62
            py = by + bh
            self.pin("dht11", pin_name, px, py, label_x=px, label_y=py - 26, anchor="middle", label_size=15, label_fill="#f4f7fb", prong=(px, py - 6, px, py + 30))
        self.physical_board_note(x + 25, y + h - 24, "Blue sensor TOP · pins point DOWN · labels read + / OUT / −", 62)

    def draw_ld2410c(self, x: float, y: float, w: float = 1030, h: float = 470) -> None:
        self.card(x, y, w, h, "QOROOS LD2410C — 5 EDGE PINS", "ld2410c")
        bx, by, bw, bh = x + 92, y + 100, 830, 305
        self.rect(self.parts, bx, by, bw, bh, rx=15, fill="#157b55", stroke="#75caa8", stroke_width=4, id="part-ld2410c", data_part="ld2410c")
        for row in range(4):
            yy = by + 42 + row * 43
            self.path(self.parts, f"M {bx + 55} {yy} H {bx + 210} V {yy + 18} H {bx + 320}", fill="none", stroke="#e5c758", stroke_width=9, stroke_linecap="round", stroke_linejoin="round")
        self.rect(self.parts, bx + 500, by + 48, 150, 118, rx=10, fill="#1d2d33", stroke="#95a3a6", stroke_width=3)
        self.text(self.labels, bx + 575, by + 112, "LD2410C", size=20, weight=800, fill="#ffffff", anchor="middle")
        pins = self.spec["parts"]["ld2410c"]["physical_pin_order"]["edge_left_to_right"]
        for index, pin_name in enumerate(pins):
            px = bx + 320 + index * 95
            py = by + bh - 12
            self.pin("ld2410c", pin_name, px, py, label_x=px, label_y=py - 27, anchor="middle", label_size=15, label_fill="#e7fff5", prong=(px, py - 4, px, py + 26))
        self.physical_board_note(x + 25, y + h - 25, "Antenna/component face toward radar window · silkscreen readable · TX RX OUT GND VCC", 110)

    def draw_pms5003(self, x: float, y: float, w: float = 700, h: float = 640) -> None:
        self.card(x, y, w, h, "PMS5003 + SUPPLIED 8-WIRE CABLE + RED 8-HOLE BREAKOUT", "pms_breakout")
        rb_x, rb_y, rb_w, rb_h = x + 42, y + 90, 270, 330
        self.rect(self.parts, rb_x, rb_y, rb_w, rb_h, rx=12, fill="#b61f32", stroke="#ef8191", stroke_width=4, id="part-pms-breakout", data_part="pms_breakout")
        self.rect(self.parts, rb_x + 165, rb_y + 82, 95, 166, rx=12, fill="#f2f2ed", stroke="#77808b", stroke_width=4)
        pins = self.spec["parts"]["pms_breakout"]["physical_pin_order"]["left_top_to_bottom"]
        for index, pin_name in enumerate(pins):
            py = rb_y + 31 + index * 38
            endpoint = key("pms_breakout", pin_name)
            destination = self.physical_destination(endpoint)
            display_destination = self.display_destination(destination)
            self.pin(
                "pms_breakout",
                pin_name,
                rb_x + 16,
                py,
                label_x=rb_x + 40,
                label_y=py + 5,
                anchor="start",
                label_size=11.5,
                label_fill="#ffe8ec" if destination != "LEAVE EMPTY" else "#e7c8ce",
                display_label=f"{pin_name} → {display_destination}",
                destination=destination,
                side="left",
            )

        sx, sy, sw, sh = x + 350, y + 145, w - 390, 220
        self.rect(self.parts, sx, sy, sw, sh, rx=24, fill="#bdc7d1", stroke="#46576a", stroke_width=5, id="part-pms5003", data_part="pms5003")
        fan_x, fan_y, fan_radius = sx + 95, sy + sh / 2, 75
        self.circle(self.parts, fan_x, fan_y, fan_radius, fill="#8998a7", stroke="#425466", stroke_width=5)
        for angle in range(0, 360, 30):
            radians = math.radians(angle)
            self.line(self.parts, fan_x, fan_y, fan_x + (fan_radius - 11) * math.cos(radians), fan_y + (fan_radius - 11) * math.sin(radians), stroke="#cbd4dc", stroke_width=6)
        self.circle(self.parts, fan_x, fan_y, 20, fill="#566678")
        label_x = sx + sw - 105
        self.text(self.labels, label_x, sy + 100, "PMS5003", size=25, weight=900, anchor="middle")
        self.text(self.labels, label_x, sy + 135, "PARTICLE SENSOR", size=14, weight=800, fill=MUTED, anchor="middle")
        self.rect(self.parts, sx - 14, sy + 70, 45, 80, rx=8, fill="#f5f4ed", stroke="#687481", stroke_width=4)

        ribbon_y = sy + 110
        colors = ["#ef4444", "#111827", "#f59e0b", "#2563eb", "#8b5cf6", "#22c55e", "#a855f7", "#64748b"]
        for index, color in enumerate(colors):
            self.path(self.parts, f"M {rb_x + rb_w - 8} {rb_y + 116 + index * 11} C {rb_x + rb_w + 40} {rb_y + 116 + index * 11}, {sx - 80} {ribbon_y - 39 + index * 11}, {sx - 3} {ribbon_y - 39 + index * 11}", fill="none", stroke=color, stroke_width=6)
        self.text(self.labels, x + w / 2, y + 456, "KEYED 8-WIRE CABLE — leave intact", size=17, weight=800, fill=MUTED, anchor="middle")
        self.physical_board_note(x + 32, y + h - 34, "Breakout labels—not ribbon colors—define VCC / GND / RXD / TXD. SET, RESET and NC stay empty.", 92)

    def draw_xiao_bottom(self, x: float, y: float, w: float = 680, h: float = 470) -> None:
        self.card(x, y, w, h, "XIAO UNDERSIDE — BATTERY PADS", "xiao")
        self.text(self.labels, x + 25, y + 72, "USB-C ↑ TOP · underside view · do not mirror", size=18, weight=700, fill="#087f74")
        bx, by, bw, bh = x + 150, y + 110, 380, 300
        self.rect(self.parts, bx, by, bw, bh, rx=20, fill="#075e61", stroke=TEAL, stroke_width=5, id="part-xiao-bottom", data_part="xiao_bottom")
        self.rect(self.parts, bx + 116, by - 22, 148, 50, rx=12, fill="#dbe2ea", stroke="#475569", stroke_width=4)
        self.rect(self.parts, bx + 122, by + 116, 136, 76, rx=9, fill="#182333", stroke="#8ba0b4", stroke_width=3)
        pads = self.spec["parts"]["xiao_bottom"]["physical_pin_order"]["battery_pads_left_to_right"]
        for index, pin_name in enumerate(pads):
            px = bx + 140 + index * 100
            py = by + bh - 52
            endpoint = key("xiao_bottom", pin_name)
            self.endpoints[endpoint] = (px, py)
            net_color = self.used.get(endpoint, ("", UNUSED))[1]
            self.rect(self.parts, px - 24, py - 15, 48, 30, rx=7, fill="#d5ac47", stroke=net_color, stroke_width=6, id=f"pin-{safe_id(endpoint)}", data_pin=endpoint, data_state="used", data_net=self.used.get(endpoint, ("", ""))[0])
            self.text(self.labels, px, py - 29, pin_name, size=18, weight=900, fill="#ffffff", anchor="middle")
        self.text(self.labels, bx + bw / 2, by + bh - 12, "BAT− LEFT          BAT+ RIGHT", size=17, weight=800, fill="#e5fbf7", anchor="middle")

    def draw_battery_and_pigtail(self, x: float, y: float, w: float = 1140, h: float = 470) -> None:
        self.card(x, y, w, h, "MAKERHAWK LiPo + 1.25 mm MATING PIGTAIL", "battery")
        bx, by, bw, bh = x + 55, y + 105, 460, 280
        self.rect(self.parts, bx, by, bw, bh, rx=28, fill="#dbe2e9", stroke="#58697b", stroke_width=5, id="part-battery", data_part="battery")
        self.rect(self.parts, bx + 34, by + 34, bw - 68, bh - 68, rx=20, fill="#edf1f5", stroke="#a6b2bf", stroke_width=3)
        self.text(self.labels, bx + bw / 2, by + 112, "LiPo 1000 mAh", size=30, weight=900, anchor="middle")
        self.text(self.labels, bx + bw / 2, by + 155, "3.7 V nominal · 4.2 V full", size=19, weight=700, fill=MUTED, anchor="middle")
        self.text(self.labels, bx + bw / 2, by + 207, "VERIFY POLARITY", size=21, weight=900, fill="#b42318", anchor="middle")

        conn_x, conn_y = x + 620, y + 178
        self.line(self.parts, bx + bw, by + 100, conn_x - 22, conn_y, stroke="#ef4444", stroke_width=10)
        self.line(self.parts, bx + bw, by + 184, conn_x - 22, conn_y + 42, stroke="#26354d", stroke_width=10)
        self.rect(self.parts, conn_x - 22, conn_y - 22, 82, 90, rx=10, fill="#f3f2eb", stroke="#687584", stroke_width=4)
        self.circle(self.parts, conn_x + 5, conn_y + 12, 7, fill="#ef4444", id="pin-battery-pos", data_pin="battery.POS", data_state="physical-mate")
        self.circle(self.parts, conn_x + 5, conn_y + 43, 7, fill="#26354d", id="pin-battery-neg", data_pin="battery.NEG", data_state="physical-mate")
        self.endpoint("battery.POS", conn_x + 5, conn_y + 12)
        self.endpoint("battery.NEG", conn_x + 5, conn_y + 43)

        mate_x = conn_x + 105
        self.rect(self.parts, mate_x, conn_y - 13, 82, 74, rx=10, fill="#f3f2eb", stroke="#687584", stroke_width=4, id="part-pigtail", data_part="pigtail")
        self.line(self.parts, conn_x + 66, conn_y + 24, mate_x - 9, conn_y + 24, stroke="#087f74", stroke_width=5, marker_end="url(#arrowhead)")
        self.line(self.parts, mate_x + 82, conn_y + 7, x + w - 70, conn_y + 7, stroke="#ef4444", stroke_width=10)
        self.line(self.parts, mate_x + 82, conn_y + 42, x + w - 70, conn_y + 42, stroke="#26354d", stroke_width=10)
        self.endpoint("pigtail.POS", x + w - 70, conn_y + 7)
        self.endpoint("pigtail.NEG", x + w - 70, conn_y + 42)
        self.circle(self.parts, x + w - 70, conn_y + 7, 8, fill="#ffffff", stroke="#ef4444", stroke_width=4, id="pin-pigtail-pos", data_pin="pigtail.POS", data_state="used", data_net="BAT_POS")
        self.circle(self.parts, x + w - 70, conn_y + 42, 8, fill="#ffffff", stroke="#26354d", stroke_width=4, id="pin-pigtail-neg", data_pin="pigtail.NEG", data_state="used", data_net="BAT_NEG")
        self.text(self.labels, mate_x + 42, conn_y + 101, "mating plug", size=17, weight=700, fill=MUTED, anchor="middle")
        self.text(self.labels, x + w - 70, conn_y - 11, "+ wire end", size=15, weight=800, fill="#b42318", anchor="middle")
        self.text(self.labels, x + w - 70, conn_y + 76, "− wire end", size=15, weight=800, fill=INK, anchor="middle")
        self.physical_board_note(x + 40, y + h - 30, "Connector shell and wire color are not proof of polarity. Check the delivered pair with a multimeter before the first connection.", 120)

    def draw_divider(self, x: float, y: float, w: float = 1050, h: float = 470) -> None:
        self.card(x, y, w, h, "BATTERY VOLTAGE DIVIDER — TWO EXTERNAL RESISTORS", "resistor")
        self.text(self.labels, x + 28, y + 74, "Corrected topology: BAT+ → R1 → A0 → R2 → GND", size=20, weight=900, fill="#b42318")
        base_y = y + 245
        left_x, r1_x, node_x, r2_x, right_x = x + 58, x + 240, x + 515, x + 735, x + w - 58
        self.line(self.parts, left_x, base_y, r1_x - 62, base_y, stroke="#ef4444", stroke_width=9)
        self.draw_resistor("resistor_r1", r1_x, base_y, "R1 200 kΩ", "#ef4444", "#14a47b")
        self.line(self.parts, r1_x + 62, base_y, node_x, base_y, stroke="#14a47b", stroke_width=9)
        self.circle(self.parts, node_x, base_y, 12, fill="#14a47b", stroke="#ffffff", stroke_width=3)
        self.draw_resistor("resistor_r2", r2_x, base_y, "R2 200 kΩ", "#14a47b", "#26354d")
        self.line(self.parts, node_x, base_y, r2_x - 62, base_y, stroke="#14a47b", stroke_width=9)
        self.line(self.parts, r2_x + 62, base_y, right_x, base_y, stroke="#26354d", stroke_width=9)
        self.endpoint("divider.BAT+", left_x, base_y)
        self.endpoint("divider.A0", node_x, base_y)
        self.endpoint("divider.GND", right_x, base_y)
        self.text(self.labels, left_x, base_y - 38, "BAT+", size=20, weight=900, fill="#b42318", anchor="middle")
        self.text(self.labels, node_x, base_y - 38, "JOIN → D0/A0", size=20, weight=900, fill="#087f74", anchor="middle")
        self.text(self.labels, right_x, base_y - 38, "GND", size=20, weight=900, anchor="middle")
        self.text(self.labels, x + w / 2, y + h - 68, "R1 and R2 are both from the ordered 200 kΩ 1% pack.", size=18, weight=700, fill=MUTED, anchor="middle")
        self.text(self.labels, x + w / 2, y + h - 35, "There is no onboard A0 pull-down resistor to substitute for R2.", size=18, weight=900, fill="#b42318", anchor="middle")

    def draw_resistor(self, part: str, center_x: float, center_y: float, label: str, left_color: str, right_color: str) -> None:
        self.line(self.parts, center_x - 90, center_y, center_x - 62, center_y, stroke=left_color, stroke_width=8)
        self.rect(self.parts, center_x - 62, center_y - 25, 124, 50, rx=22, fill="#ead9af", stroke="#8b7042", stroke_width=3, id=f"part-{safe_id(part)}", data_part=part)
        bands = [(center_x - 34, "#dc2626"), (center_x - 15, "#111827"), (center_x + 4, "#111827"), (center_x + 23, "#f97316"), (center_x + 43, "#7c3f18")]
        for band_x, color in bands:
            self.line(self.parts, band_x, center_y - 21, band_x, center_y + 21, stroke=color, stroke_width=8)
        self.line(self.parts, center_x + 62, center_y, center_x + 90, center_y, stroke=right_color, stroke_width=8)
        self.endpoint(f"{part}.A", center_x - 90, center_y)
        self.endpoint(f"{part}.B", center_x + 90, center_y)
        self.circle(self.parts, center_x - 90, center_y, 2, fill=left_color, id=f"pin-{safe_id(part)}-a", data_pin=f"{part}.A", data_state="used", data_net=self.used.get(f"{part}.A", ("", ""))[0])
        self.circle(self.parts, center_x + 90, center_y, 2, fill=right_color, id=f"pin-{safe_id(part)}-b", data_pin=f"{part}.B", data_state="used", data_net=self.used.get(f"{part}.B", ("", ""))[0])
        self.text(self.labels, center_x, center_y + 61, label, size=17, weight=800, anchor="middle")

    def draw_power_icons(self, x: float, y: float, xiao_usb: tuple[float, float], connection_id: str, optional: bool = False) -> None:
        self.rect(self.parts, x, y, 85, 110, rx=14, fill="#e2e8f0", stroke="#526175", stroke_width=4, id="part-wall-adapter", data_part="wall_adapter")
        self.line(self.parts, x + 20, y - 20, x + 20, y, stroke="#526175", stroke_width=7)
        self.line(self.parts, x + 62, y - 20, x + 62, y, stroke="#526175", stroke_width=7)
        self.text(self.labels, x + 42, y + 50, "5 V", size=20, weight=900, anchor="middle")
        self.text(self.labels, x + 42, y + 78, "323", size=15, weight=900, fill=MUTED, anchor="middle")
        self.endpoint("wall_adapter", x + 85, y + 55)
        cable_x, cable_y = x + 138, y + 55
        self.endpoint("usb_cable", cable_x, cable_y)
        self.path(self.parts, f"M {x + 85} {y + 55} C {x + 125} {y + 55}, {x + 115} {y + 55}, {cable_x} {cable_y} C {cable_x + 80} {cable_y}, {xiao_usb[0] - 100} {xiao_usb[1] - 62}, {xiao_usb[0]} {xiao_usb[1]}", fill="none", stroke="#64748b", stroke_width=9, stroke_linecap="round", id="part-usb-cable", data_part="usb_cable", data_connection=connection_id, data_from="wall_adapter", data_to="xiao_top.USB-C", data_net="USB", data_xiao_side="usb")
        self.text(self.labels, x + 42, y + 137, "ANKER 323", size=14, weight=900, fill=MUTED, anchor="middle")
        self.text(self.labels, x + 137, y + 83, "UGREEN USB-C", size=13, weight=800, fill=MUTED, anchor="middle")

    def wire_connections(self) -> None:
        if self.device["id"] == "atmosphere":
            self.wire_atmosphere_connections()
            return
        if self.device["id"] == "climate":
            self.wire_climate_connections()
            return

        left_connection_ids = []
        for connection in self.device["connections"]:
            endpoints = [connection["from"], *connection["to"]]
            if any(self.xiao_pin_side(endpoint) == "left" for endpoint in endpoints):
                left_connection_ids.append(connection["id"])
        left_rank = {connection_id: index for index, connection_id in enumerate(left_connection_ids)}

        for index, connection in enumerate(self.device["connections"]):
            if connection["net"] == "USB":
                continue
            source_name = connection["from"]
            if source_name not in self.endpoints:
                continue
            sx, sy = self.endpoints[source_name]
            color = self.spec["wire_colors"][connection["net"]]
            targets = [target for target in connection["to"] if target in self.endpoints]
            for target_index, target_name in enumerate(targets):
                tx, ty = self.endpoints[target_name]
                source_side = self.xiao_pin_side(source_name)
                target_side = self.xiao_pin_side(target_name)
                xiao_side = source_side or target_side
                if self.device["id"] in ("atmosphere", "presence") and ((sx < 700 and tx > 900) or (tx < 700 and sx > 900)):
                    lane_x = 724 + index * 20 + target_index * 4
                    if source_side == "left":
                        rank = left_rank[connection["id"]]
                        escape_x = 158 - rank * 11
                        gutter_y = 890 + rank * 12
                        d = f"M {sx} {sy} H {escape_x} V {gutter_y} H {lane_x} V {ty} H {tx}"
                    elif target_side == "left":
                        rank = left_rank[connection["id"]]
                        escape_x = 158 - rank * 11
                        gutter_y = 890 + rank * 12
                        d = f"M {sx} {sy} H {lane_x} V {gutter_y} H {escape_x} V {ty} H {tx}"
                    else:
                        d = f"M {sx} {sy} H {lane_x} V {ty} H {tx}"
                else:
                    mid_y = min(sy, ty) - 22 - index * 4 - target_index * 3
                    if abs(sx - tx) < 200:
                        mid_y = max(sy, ty) + 32 + index * 3
                    d = f"M {sx} {sy} V {mid_y} H {tx} V {ty}"
                self.draw_wire_path(connection, target_name, d, target_index + 1, xiao_side=xiao_side)

    def draw_wire_path(
        self,
        connection: dict,
        target_name: str,
        d: str,
        target_index: int,
        *,
        xiao_side: str | None = None,
        wire_id: str | None = None,
        wire_color: str | None = None,
    ) -> None:
        color = wire_color or self.spec["wire_colors"][connection["net"]]
        outline_width = 11 if wire_id else 14
        wire_width = 6 if wire_id else 7
        self.path(
            self.wires,
            d,
            fill="none",
            stroke="#ffffff",
            stroke_width=outline_width,
            stroke_linecap="round",
            stroke_linejoin="round",
        )
        self.path(
            self.wires,
            d,
            fill="none",
            stroke=color,
            stroke_width=wire_width,
            stroke_linecap="round",
            stroke_linejoin="round",
            id=f"wire-{safe_id(connection['id'])}-{target_index}",
            data_connection=connection["id"],
            data_from=connection["from"],
            data_to=target_name,
            data_net=connection["net"],
            data_xiao_side=xiao_side,
            data_wire_id=wire_id,
            data_wire_color=wire_color,
        )

    def atmosphere_wire_tag(self, wire_id: str, color: str, x: float, y: float, *, anchor: str = "start") -> None:
        tag_width = 48
        left = x if anchor == "start" else x - tag_width
        self.rect(self.labels, left, y - 15, tag_width, 25, rx=12, fill=color, data_wire_tag=wire_id)
        self.text(self.labels, left + tag_width / 2, y + 3, wire_id, size=12, weight=900, fill="#ffffff", anchor="middle")

    def wire_atmosphere_connections(self) -> None:
        connections = {item["id"]: item for item in self.device["connections"]}

        def point(endpoint: str) -> tuple[float, float]:
            return self.endpoints[endpoint]

        def draw(connection_id: str, target_name: str, d: str, *, xiao_side: str, tag: tuple[float, float, str]) -> None:
            connection = connections[connection_id]
            run = self.atmosphere_runs[(connection_id, target_name)]
            target_index = connection["to"].index(target_name) + 1
            self.draw_wire_path(
                connection,
                target_name,
                d,
                target_index,
                xiao_side=xiao_side,
                wire_id=run["id"],
                wire_color=run["color"],
            )
            self.atmosphere_wire_tag(run["id"], run["color"], tag[0], tag[1], anchor=tag[2])

        # SDA and SCL leave the XIAO's physical LEFT row and use six separate
        # vertical lanes. Nothing is merged into a bus line in the drawing.
        left_runs = (
            ("A3", "bme680.SDA", 834),
            ("A3", "scd41.SDA", 818),
            ("A3", "veml7700.SDA", 802),
            ("A4", "bme680.SCL", 786),
            ("A4", "scd41.SCL", 770),
            ("A4", "veml7700.SCL", 754),
        )
        for connection_id, target_name, lane_x in left_runs:
            connection = connections[connection_id]
            sx, sy = point(connection["from"])
            tx, ty = point(target_name)
            draw(
                connection_id,
                target_name,
                f"M {sx} {sy} H {lane_x} V {ty} H {tx}",
                xiao_side="left",
                tag=(tx + 18, ty, "start"),
            )

        # 3V3 and GND originate on the XIAO's physical RIGHT row. Each sensor
        # gets its own point-to-point run through a unique lower service lane.
        lower_runs = (
            ("A1", "bme680.VCC", 1764, 1220, 834),
            ("A1", "scd41.VDD", 1778, 1236, 818),
            ("A1", "veml7700.VIN", 1792, 1252, 802),
            ("A2", "bme680.GND", 1806, 1268, 786),
            ("A2", "scd41.GND", 1820, 1284, 770),
            ("A2", "veml7700.GND", 1834, 1300, 754),
        )
        for connection_id, target_name, right_lane_x, lower_y, left_lane_x in lower_runs:
            connection = connections[connection_id]
            sx, sy = point(connection["from"])
            tx, ty = point(target_name)
            draw(
                connection_id,
                target_name,
                f"M {sx} {sy} H {right_lane_x} V {lower_y} H {left_lane_x} V {ty} H {tx}",
                xiao_side="right",
                tag=(tx + 18, ty, "start"),
            )

        # PMS5003 power and UART occupy the clear gap to the XIAO's right.
        for connection_id, target_name, lane_x in (
            ("A5", "pms_breakout.VCC(+5V)", 1790),
            ("A2", "pms_breakout.GND", 1810),
        ):
            connection = connections[connection_id]
            sx, sy = point(connection["from"])
            tx, ty = point(target_name)
            draw(
                connection_id,
                target_name,
                f"M {sx} {sy} H {lane_x} V {ty} H {tx}",
                xiao_side="right",
                tag=(tx - 18, ty, "end"),
            )

        connection = connections["A6"]
        sx, sy = point(connection["from"])
        tx, ty = point("pms_breakout.RXD")
        draw(
            "A6",
            "pms_breakout.RXD",
            f"M {sx} {sy} H 738 V 1316 H 1828 V {ty} H {tx}",
            xiao_side="left",
            tag=(tx - 18, ty, "end"),
        )

        connection = connections["A7"]
        sx, sy = point(connection["from"])
        tx, ty = point("xiao_top.D7/RX")
        draw(
            "A7",
            "xiao_top.D7/RX",
            f"M {sx} {sy} H 1818 V {ty} H {tx}",
            xiao_side="right",
            tag=(sx - 18, sy, "end"),
        )

    def wire_climate_connections(self) -> None:
        connections = {item["id"]: item for item in self.device["connections"]}

        def point(endpoint: str) -> tuple[float, float]:
            return self.endpoints[endpoint]

        # DHT11 point-to-point runs use separate lanes in the clear gap between cards.
        for connection_id, target_name, lane_x, escape_x, gutter_y in (
            ("C1", "dht11.+", 742, 158, 890),
            ("C2", "dht11.OUT", 762, 147, 902),
            ("C3", "dht11.-", 782, None, None),
        ):
            connection = connections[connection_id]
            sx, sy = point(connection["from"])
            tx, ty = point(target_name)
            side = self.xiao_pin_side(connection["from"])
            if side == "left":
                d = f"M {sx} {sy} H {escape_x} V {gutter_y} H {lane_x} V {ty} H {tx}"
            else:
                d = f"M {sx} {sy} H {lane_x} V {ty} H {tx}"
            self.draw_wire_path(connection, target_name, d, 1, xiao_side=side)

        # Ground to R2 travels through the open horizontal service lane between the upper and lower cards.
        connection = connections["C3"]
        sx, sy = point(connection["from"])
        tx, ty = point("resistor_r2.B")
        self.draw_wire_path(connection, "resistor_r2.B", f"M {sx} {sy} H 716 V 690 H 2415 V {ty} H {tx}", 2, xiao_side="right")

        # The meter-verified mating pigtail feeds the underside BAT pads. BAT+ also feeds R1.
        connection = connections["C4"]
        sx, sy = point(connection["from"])
        for target_index, (target_name, lane_y) in enumerate((("xiao_bottom.BAT+", 681), ("resistor_r1.A", 696)), start=1):
            tx, ty = point(target_name)
            self.draw_wire_path(connection, target_name, f"M {sx} {sy} H 2570 V {lane_y} H {tx} V {ty}", target_index)

        connection = connections["C5"]
        sx, sy = point(connection["from"])
        tx, ty = point("xiao_bottom.BAT-")
        self.draw_wire_path(connection, "xiao_bottom.BAT-", f"M {sx} {sy} H 2550 V 708 H {tx} V {ty}", 1)

        # R1/R2 are already visibly joined inside the divider card; this run takes that midpoint to D0/A0.
        connection = connections["C6"]
        sx, sy = point(connection["from"])
        tx, ty = point("xiao_top.D0/A0")
        self.draw_wire_path(connection, "xiao_top.D0/A0", f"M {sx} {sy} V 690 H 125 V {ty} H {tx}", 1, xiao_side="left")
        # Metadata-bearing zero-length logical edge documents the physical R1/R2 lead splice drawn in the divider.
        target_name = "resistor_r2.A"
        tx, ty = point(target_name)
        self.path(
            self.wires,
            f"M {tx} {ty} h 0.01",
            fill="none",
            stroke=self.spec["wire_colors"][connection["net"]],
            stroke_width=1,
            id="wire-c6-2",
            data_connection="C6",
            data_from=connection["from"],
            data_to=target_name,
            data_net=connection["net"],
        )

    def recipe(self, y: float = 1260, h: float = 390) -> None:
        if self.device["id"] == "atmosphere":
            self.atmosphere_recipe(y, h)
            return
        self.rect(self.base, 50, y, self.width - 100, h, rx=22, fill="#ffffff", stroke=LINE, stroke_width=3)
        self.text(self.labels, 80, y + 43, "POINT-TO-POINT CONNECTION RECIPE", size=25, weight=900)
        self.text(self.labels, self.width - 80, y + 42, "Match the printed labels; do not infer position from wire color.", size=18, weight=800, fill="#b42318", anchor="end")
        connections = self.device["connections"]
        left_count = math.ceil(len(connections) / 2)
        columns = [connections[:left_count], connections[left_count:]]
        column_x = [80, 1285]
        row_height = 42
        for column_index, rows in enumerate(columns):
            for row_index, connection in enumerate(rows):
                row_y = y + 88 + row_index * row_height
                color = self.spec["wire_colors"][connection["net"]]
                self.rect(self.labels, column_x[column_index], row_y - 24, 62, 32, rx=16, fill=color)
                self.text(self.labels, column_x[column_index] + 31, row_y, connection["id"], size=16, weight=900, fill="#ffffff", anchor="middle")
                self.text(self.labels, column_x[column_index] + 78, row_y, connection["instruction"], size=17, weight=650)

        notes_y = y + 88 + max(len(columns[0]), len(columns[1])) * row_height + 8
        self.line(self.labels, 80, notes_y, self.width - 80, notes_y, stroke=LINE, stroke_width=2)
        for note_index, note in enumerate(self.device["assembly_notes"]):
            self.text(self.labels, 86, notes_y + 27 + note_index * 26, f"• {note}", size=16, weight=650, fill=MUTED)

    def atmosphere_recipe(self, y: float, h: float) -> None:
        self.rect(self.base, 50, y, self.width - 100, h, rx=22, fill="#ffffff", stroke=LINE, stroke_width=3)
        self.text(self.labels, 80, y + 39, "16 SEPARATE JUMPER WIRES — POINT TO POINT", size=24, weight=900)
        self.text(self.labels, self.width - 80, y + 38, "Match W-number + printed labels; drawing colors are identifiers.", size=17, weight=800, fill="#b42318", anchor="end")

        part_names = {
            "xiao_top": "XIAO",
            "bme680": "BME680",
            "scd41": "SCD41",
            "veml7700": "VEML7700",
            "pms_breakout": "PMS breakout",
        }

        def endpoint_label(endpoint: str) -> str:
            part, pin = endpoint.split(".", 1)
            return f"{part_names[part]} {pin}"

        runs = []
        for connection in self.device["connections"]:
            if connection["net"] == "USB":
                continue
            for target in connection["to"]:
                run = self.atmosphere_runs[(connection["id"], target)]
                runs.append((run, endpoint_label(connection["from"]), endpoint_label(target)))

        column_width = 615
        for run_index, (run, source, target) in enumerate(runs):
            column = run_index // 4
            row = run_index % 4
            x = 80 + column * column_width
            row_y = y + 78 + row * 43
            self.rect(self.labels, x, row_y - 23, 50, 29, rx=14, fill=run["color"])
            self.text(self.labels, x + 25, row_y - 1, run["id"], size=13, weight=900, fill="#ffffff", anchor="middle")
            self.text(self.labels, x + 62, row_y - 1, f"{source} → {target}", size=14.5, weight=700)

        notes_y = y + 240
        self.line(self.labels, 80, notes_y, self.width - 80, notes_y, stroke=LINE, stroke_width=2)
        notes = [
            "Every colored path is one physical jumper wire; no line represents a hidden multi-wire bus.",
            "PMS5003 keyed cable stays intact. On the red breakout, follow VCC/GND/RXD/TXD silkscreen—not ribbon colors.",
            "Leave BME680 SDO/CS, VEML7700 3Vo, and PMS SET/RESET/NC holes empty. PMS power is VBUS/5V, never 3V3.",
        ]
        for note_index, note in enumerate(notes):
            self.text(self.labels, 86, notes_y + 25 + note_index * 24, f"• {note}", size=14.5, weight=650, fill=MUTED)

    def header(self) -> None:
        self.rect(self.base, 0, 0, self.width, 150, fill=INK)
        self.text(self.labels, 52, 61, self.device["title"], size=36, weight=900, fill="#ffffff")
        self.text(self.labels, 52, 108, self.device["subtitle"], size=22, weight=600, fill="#cfe5ee")
        self.rect(self.base, 0, 150, self.width, 56, fill="#fff2cc")
        warning = "PHYSICAL ORIENTATION IS AUTHORITATIVE: hold each board exactly as drawn; wire only the colored-ring hole/pin. Gray X = leave empty."
        if self.device["id"] == "atmosphere":
            warning = "XIAO IS CENTERED: trace each W-number from an exact XIAO pin to one exact module hole. Every colored path = one jumper."
        if self.device["id"] == "climate":
            warning = "CORRECTED: TWO external 200 kΩ resistors are required. Do not use the superseded one-resistor Climate diagram."
        self.text(self.labels, self.width / 2, 187, warning, size=19, weight=900, fill="#7a4b00", anchor="middle")

    def footer(self) -> None:
        asins = []
        for part in self.device["parts"]:
            source = self.spec["parts"][part]["source"]
            asin = self.spec["sources"][source]["asin"]
            if asin not in asins:
                asins.append(asin)
        self.text(self.labels, self.width - 52, self.height - 18, "Exact purchase references: " + " · ".join(asins), size=14, weight=650, fill=MUTED, anchor="end")

    def render(self) -> str:
        metadata = {
            "schema_version": self.spec["schema_version"],
            "device": self.device["id"],
            "parts": self.device["parts"],
            "connections": [item["id"] for item in self.device["connections"]],
        }
        return "\n".join(
            [
                '<?xml version="1.0" encoding="UTF-8"?>',
                f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}">',
                f'<metadata id="homebrain-physical-wiring">{escape(json.dumps(metadata, sort_keys=True, separators=(",", ":")))}</metadata>',
                f'<rect width="{self.width}" height="{self.height}" fill="{PAPER}"/>',
                '<defs><marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#087f74"/></marker></defs>',
                '<g id="background">',
                *self.base,
                '</g><g id="wires">',
                *self.wires,
                '</g><g id="physical-parts">',
                *self.parts,
                '</g><g id="labels">',
                *self.labels,
                "</g></svg>",
            ]
        )


def build_sheet(spec: dict, device: dict) -> str:
    width = spec["render"]["width"]
    height = spec["render"]["height"]
    sheet = Sheet(width, height, device, spec)
    sheet.header()
    device_id = device["id"]

    if device_id == "atmosphere":
        sheet.draw_bme680(50, 230, 680, 310)
        sheet.draw_scd41(50, 550, 680, 310)
        sheet.draw_veml7700(50, 870, 680, 340)
        sheet.draw_xiao(850, 280, 900, 930)
        sheet.draw_pms5003(1850, 480, 700, 640)
        sheet.draw_power_icons(1880, 260, sheet.endpoints["xiao_top.USB-C"], "A8")
    elif device_id == "presence":
        sheet.draw_xiao(50, 230, 650, 990)
        sheet.draw_dht11(920, 230)
        sheet.draw_veml7700(1460, 230)
        sheet.draw_ld2410c(920, 720)
        sheet.draw_power_icons(68, 285, sheet.endpoints["xiao_top.USB-C"], "P10")
    elif device_id == "climate":
        sheet.draw_xiao(50, 230, 650, 990)
        sheet.draw_dht11(800, 230, 500, 430)
        sheet.draw_battery_and_pigtail(1360, 230, 1190, 430)
        sheet.draw_xiao_bottom(800, 720, 680, 500)
        sheet.draw_divider(1530, 720, 1020, 500)
        # Show an unplugged service/charge cable without an AC adapter.
        usb_x, usb_y = sheet.endpoints["xiao_top.USB-C"]
        sheet.endpoint("usb_cable", usb_x - 72, usb_y - 80)
        sheet.path(sheet.parts, f"M {usb_x - 72} {usb_y - 80} C {usb_x - 36} {usb_y - 80}, {usb_x - 45} {usb_y - 38}, {usb_x} {usb_y}", fill="none", stroke="#64748b", stroke_width=9, stroke_dasharray="18 12", id="part-usb-cable", data_part="usb_cable", data_connection="C7", data_from="usb_cable", data_to="xiao_top.USB-C", data_net="USB", data_xiao_side="usb")
        sheet.text(sheet.labels, usb_x - 132, usb_y - 92, "optional USB-C charge/flash cable", size=16, weight=800, fill=MUTED, anchor="middle")
    else:
        raise ValueError(f"Unknown device layout: {device_id}")

    sheet.wire_connections()
    if device_id == "atmosphere":
        sheet.recipe(1340, 310)
    else:
        sheet.recipe()
    sheet.footer()
    return sheet.render()


def render_png(svg_path: Path, png_path: Path, width: int, height: int, chrome: Path) -> None:
    if not chrome.is_file():
        raise FileNotFoundError(f"Google Chrome not found at {chrome}")
    command = [
        str(chrome),
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        f"--window-size={width},{height}",
        f"--screenshot={png_path}",
        svg_path.resolve().as_uri(),
    ]
    with open("/dev/null", "wb") as sink:
        subprocess.run(command, check=True, stdout=sink, stderr=sink)


def main() -> None:
    args = parse_args()
    spec = json.loads(args.spec.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    for device in spec["devices"]:
        svg_path = args.output / f"wiring-{device['id']}.svg"
        png_path = args.output / f"wiring-{device['id']}.png"
        svg_path.write_text(build_sheet(spec, device))
        if not args.svg_only:
            render_png(svg_path, png_path, spec["render"]["width"], spec["render"]["height"], args.chrome)
        def display(path: Path) -> str:
            try:
                return str(path.relative_to(ROOT))
            except ValueError:
                return str(path)

        print(f"generated {display(svg_path)}" + (f" and {display(png_path)}" if not args.svg_only else ""))


if __name__ == "__main__":
    main()
