#!/usr/bin/env python3
"""Generate a fabrication-ready HomeBrain carrier PCB and final harness guides."""

from __future__ import annotations

import argparse
import csv
import hashlib
import heapq
import json
import math
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from xml.sax.saxutils import escape


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DESIGN = ROOT / "hardware/homebrain-sensors/carrier/carrier-design.json"
DEFAULT_OUTPUT = ROOT / "hardware/homebrain-sensors/carrier/generated"
DEFAULT_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
GRID = 0.25
LAYERS = ("F.Cu", "B.Cu")


@dataclass(frozen=True)
class Pad:
    key: str
    ref: str
    number: str
    label: str
    net: str
    x: float
    y: float
    diameter: float
    drill: float

    @property
    def radius(self) -> float:
        return self.diameter / 2.0


@dataclass(frozen=True)
class Segment:
    net: str
    layer: str
    width: float
    start: tuple[float, float]
    end: tuple[float, float]


@dataclass(frozen=True)
class Via:
    net: str
    x: float
    y: float
    diameter: float = 1.0
    drill: float = 0.4


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design", type=Path, default=DEFAULT_DESIGN)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--chrome", type=Path, default=DEFAULT_CHROME)
    parser.add_argument("--svg-only", action="store_true")
    return parser.parse_args()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def q(value: float) -> int:
    return int(round(value / GRID))


def uq(value: int) -> float:
    return round(value * GRID, 6)


def distance_point_segment(point: tuple[float, float], segment: Segment) -> float:
    px, py = point
    ax, ay = segment.start
    bx, by = segment.end
    dx, dy = bx - ax, by - ay
    if dx == 0.0 and dy == 0.0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def segment_distance(first: Segment, second: Segment) -> float:
    def orientation(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def on_segment(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> bool:
        return min(a[0], c[0]) - 1e-9 <= b[0] <= max(a[0], c[0]) + 1e-9 and min(a[1], c[1]) - 1e-9 <= b[1] <= max(a[1], c[1]) + 1e-9

    a, b, c, d = first.start, first.end, second.start, second.end
    o1, o2, o3, o4 = orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)
    intersects = (o1 * o2 < 0 and o3 * o4 < 0) or (abs(o1) < 1e-9 and on_segment(a, c, b)) or (abs(o2) < 1e-9 and on_segment(a, d, b)) or (abs(o3) < 1e-9 and on_segment(c, a, d)) or (abs(o4) < 1e-9 and on_segment(c, b, d))
    if intersects:
        return 0.0
    return min(
        distance_point_segment(a, second),
        distance_point_segment(b, second),
        distance_point_segment(c, first),
        distance_point_segment(d, first),
    )


def derive_pads(design: dict) -> list[Pad]:
    pads: list[Pad] = []
    xiao = design["xiao"]
    center_x, center_y = xiao["center"]
    top_y = center_y - xiao["row_spacing"] / 2.0
    bottom_y = center_y + xiao["row_spacing"] / 2.0
    for row_name, row_y in (("top_row", top_y), ("bottom_row", bottom_y)):
        for index, (label, net) in enumerate(xiao[row_name], start=1):
            x = center_x + (index - 4) * xiao["pin_pitch"]
            pads.append(
                Pad(
                    key=f"U1.{label}",
                    ref="U1",
                    number=f"{row_name[0].upper()}{index}",
                    label=label,
                    net=net,
                    x=round(x, 4),
                    y=round(row_y, 4),
                    diameter=xiao["socket_pad_diameter"],
                    drill=xiao["socket_drill"],
                )
            )
    for part in design["parts"]:
        part_type = part["type"]
        if part_type == "JST-XH":
            count = part["positions"]
            for index, (net, label) in enumerate(zip(part["pin_nets"], part["labels"]), start=1):
                x = part["center"][0] + (index - (count + 1) / 2.0) * 2.5
                pads.append(Pad(f"{part['ref']}.{index}", part["ref"], str(index), label, net, round(x, 4), part["center"][1], 1.8, 1.0))
        elif part_type == "AXIAL":
            for index, net in enumerate(part["pin_nets"], start=1):
                direction = -1.0 if index == 1 else 1.0
                x = part["center"][0] + direction * part["lead_spacing"] / 2.0
                pads.append(Pad(f"{part['ref']}.{index}", part["ref"], str(index), net, net, round(x, 4), part["center"][1], 1.8, 0.8))
        elif part_type == "TEST_PAD":
            pads.append(Pad(f"{part['ref']}.1", part["ref"], "1", part["value"], part["pin_nets"][0], part["center"][0], part["center"][1], 2.0, 1.0))
        else:
            raise ValueError(f"Unsupported part type: {part_type}")
    keys = [pad.key for pad in pads]
    if len(keys) != len(set(keys)):
        raise ValueError("Duplicate pad key")
    return pads


def net_width(design: dict, net: str) -> float:
    return design["board"]["power_trace_width"] if design["nets"][net]["class"] == "power" else design["board"]["minimum_trace_width"]


class Router:
    def __init__(self, design: dict, pads: list[Pad]):
        self.design = design
        self.pads = pads
        self.board = design["board"]
        self.clearance = self.board["minimum_clearance"]
        self.segments: list[Segment] = []
        self.vias: list[Via] = []
        self.escape_nodes: dict[str, set[tuple[int, int, int]]] = {}
        keepout = self.board["antenna_copper_keepout"]
        self.keepout = (*keepout["min"], *keepout["max"])
        self.reserve_xiao_escapes()

    def reserve_xiao_escapes(self) -> None:
        """Give every used XIAO pad a short protected path away from the socket row.

        Without these stubs, a legal maze route for one fan-out net can wrap
        around an adjacent, not-yet-routed socket pad and leave it electrically
        unreachable. Alternating layers keeps all escape channels independent.
        """
        assignments = {
            "A0": ("F.Cu", -2.0),
            "D1": ("B.Cu", -2.0),
            "D2": ("F.Cu", -2.0),
            "D3": ("B.Cu", -2.0),
            "SDA": ("F.Cu", -2.0),
            "SCL": ("B.Cu", -2.0),
            "TX": ("F.Cu", -2.0),
            "VBUS": ("F.Cu", 2.0),
            "3V3": ("F.Cu", 2.0),
            "RX": ("B.Cu", 2.0),
        }
        for net, (layer, delta_y) in assignments.items():
            pad = next(item for item in self.pads if item.ref == "U1" and item.net == net)
            start = (q(pad.x), q(pad.y), LAYERS.index(layer))
            end = (q(pad.x), q(pad.y + delta_y), LAYERS.index(layer))
            self.segments.append(Segment(net, layer, net_width(self.design, net), (uq(start[0]), uq(start[1])), (uq(end[0]), uq(end[1]))))
            nodes: set[tuple[int, int, int]] = set()
            low, high = sorted((start[1], end[1]))
            for y in range(low, high + 1):
                nodes.add((start[0], y, start[2]))
            nodes.add((start[0], start[1], 1 - start[2]))
            self.escape_nodes[net] = nodes

    def node_free(self, node: tuple[int, int, int], net: str, width: float, *, via: bool = False) -> bool:
        x, y = uq(node[0]), uq(node[1])
        radius = (0.5 if via else width / 2.0)
        edge = self.board["edge_clearance"] + radius
        if x < edge or y < edge or x > self.board["width"] - edge or y > self.board["height"] - edge:
            return False
        kx1, ky1, kx2, ky2 = self.keepout
        if kx1 - radius <= x <= kx2 + radius and ky1 - radius <= y <= ky2 + radius:
            return False
        for pad in self.pads:
            if pad.net == net:
                continue
            if math.hypot(x - pad.x, y - pad.y) < radius + pad.radius + self.clearance - 1e-9:
                return False
        layers = LAYERS if via else (LAYERS[node[2]],)
        for existing in self.segments:
            if existing.net == net or existing.layer not in layers:
                continue
            if distance_point_segment((x, y), existing) < radius + existing.width / 2.0 + self.clearance - 1e-9:
                return False
        for existing in self.vias:
            if existing.net == net:
                continue
            if math.hypot(x - existing.x, y - existing.y) < radius + existing.diameter / 2.0 + self.clearance - 1e-9:
                return False
        return True

    def route_connection(
        self,
        net: str,
        source_nodes: set[tuple[int, int, int]],
        goal_nodes: set[tuple[int, int, int]],
    ) -> list[tuple[int, int, int]]:
        width = net_width(self.design, net)
        min_goal_x = min(node[0] for node in goal_nodes)
        max_goal_x = max(node[0] for node in goal_nodes)
        min_goal_y = min(node[1] for node in goal_nodes)
        max_goal_y = max(node[1] for node in goal_nodes)

        def heuristic(node: tuple[int, int, int]) -> float:
            dx = max(min_goal_x - node[0], 0, node[0] - max_goal_x)
            dy = max(min_goal_y - node[1], 0, node[1] - max_goal_y)
            return dx + dy

        frontier: list[tuple[float, float, tuple[int, int, int]]] = []
        cost: dict[tuple[int, int, int], float] = {}
        parent: dict[tuple[int, int, int], tuple[int, int, int] | None] = {}
        for source in sorted(source_nodes):
            if not self.node_free(source, net, width):
                continue
            cost[source] = 0.0
            parent[source] = None
            heapq.heappush(frontier, (heuristic(source), 0.0, source))
        if not frontier:
            raise RuntimeError(f"{net}: no free source nodes")
        found: tuple[int, int, int] | None = None
        while frontier:
            _priority, current_cost, current = heapq.heappop(frontier)
            if current_cost != cost.get(current):
                continue
            if current in goal_nodes:
                found = current
                break
            x, y, layer = current
            neighbors = [(x + 1, y, layer), (x - 1, y, layer), (x, y + 1, layer), (x, y - 1, layer), (x, y, 1 - layer)]
            for neighbor in neighbors:
                layer_change = neighbor[2] != layer
                if layer_change:
                    if not self.node_free(current, net, width, via=True):
                        continue
                    step = 12.0
                else:
                    if not self.node_free(neighbor, net, width):
                        continue
                    step = 1.0
                new_cost = current_cost + step
                if new_cost + 1e-9 >= cost.get(neighbor, float("inf")):
                    continue
                cost[neighbor] = new_cost
                parent[neighbor] = current
                heapq.heappush(frontier, (new_cost + heuristic(neighbor), new_cost, neighbor))
        if found is None:
            raise RuntimeError(f"{net}: maze router could not reach the existing copper tree")
        result: list[tuple[int, int, int]] = []
        cursor: tuple[int, int, int] | None = found
        while cursor is not None:
            result.append(cursor)
            cursor = parent[cursor]
        result.reverse()
        return result

    @staticmethod
    def simplify_path(path: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
        if len(path) < 3:
            return path
        result = [path[0]]
        for index in range(1, len(path) - 1):
            previous, current, following = result[-1], path[index], path[index + 1]
            first_delta = (current[0] - previous[0], current[1] - previous[1], current[2] - previous[2])
            second_delta = (following[0] - current[0], following[1] - current[1], following[2] - current[2])
            if first_delta[2] == 0 and second_delta[2] == 0 and first_delta[0] * second_delta[1] == first_delta[1] * second_delta[0]:
                continue
            result.append(current)
        result.append(path[-1])
        return result

    def add_path(self, net: str, path: list[tuple[int, int, int]]) -> None:
        path = self.simplify_path(path)
        width = net_width(self.design, net)
        for first, second in zip(path, path[1:]):
            if first[2] != second[2]:
                x, y = uq(first[0]), uq(first[1])
                if not any(via.net == net and abs(via.x - x) < 1e-9 and abs(via.y - y) < 1e-9 for via in self.vias):
                    self.vias.append(Via(net, x, y))
                continue
            self.segments.append(Segment(net, LAYERS[first[2]], width, (uq(first[0]), uq(first[1])), (uq(second[0]), uq(second[1]))))

    def route(self, order: list[str] | None = None) -> tuple[list[Segment], list[Via]]:
        endpoints: dict[str, list[Pad]] = {net: [] for net in self.design["nets"]}
        for pad in self.pads:
            if pad.net in endpoints:
                endpoints[pad.net].append(pad)
        # Route the two high-fanout buses first so later point-to-point traces
        # cannot form a wall between their three keyed headers.
        order = order or ["TX", "RX", "VBUS", "SCL", "SDA", "3V3", "BAT+", "D1", "D2", "D3", "A0"]
        for net in order:
            # When the net has a XIAO socket endpoint, make that plated pad the
            # root so its reserved escape stub and the routed tree are one
            # physical copper island from the outset.
            pads = sorted(endpoints[net], key=lambda item: (item.ref != "U1", item.key))
            if len(pads) < 2:
                raise ValueError(f"{net}: requires at least two endpoints")
            first_node_xy = (q(pads[0].x), q(pads[0].y))
            tree: set[tuple[int, int, int]] = {(first_node_xy[0], first_node_xy[1], 0), (first_node_xy[0], first_node_xy[1], 1)}
            tree.update(self.escape_nodes.get(net, set()))
            connected = [pads[0]]
            remaining = pads[1:]
            while remaining:
                target_pad = min(
                    remaining,
                    key=lambda pad: min(abs(q(pad.x) - node[0]) + abs(q(pad.y) - node[1]) for node in tree),
                )
                source_xy = (q(target_pad.x), q(target_pad.y))
                sources = {(source_xy[0], source_xy[1], 0), (source_xy[0], source_xy[1], 1)}
                path = self.route_connection(net, sources, tree)
                self.add_path(net, path)
                tree.update(path)
                tree.update(sources)
                connected.append(target_pad)
                remaining.remove(target_pad)
        return self.segments, self.vias


def compute_ground_plane_voids(design: dict, pads: list[Pad], segments: list[Segment], vias: list[Via]) -> list[dict]:
    """Return clear-mode cells that remove every sampled floating fill island."""
    step = GRID
    board = design["board"]
    edge = board["edge_clearance"]
    clearance = board["minimum_clearance"]
    keepout = board["antenna_copper_keepout"]
    non_ground_segments = {layer: [item for item in segments if item.layer == layer and item.net != "GND"] for layer in LAYERS}
    non_ground_pads = [pad for pad in pads if pad.net != "GND"]
    ground_pads = [pad for pad in pads if pad.net == "GND"]

    def ground_feature(x: float, y: float) -> bool:
        return any(math.hypot(x - pad.x, y - pad.y) <= pad.radius + 1e-9 for pad in ground_pads) or any(
            via.net == "GND" and math.hypot(x - via.x, y - via.y) <= via.diameter / 2.0 + 1e-9 for via in vias
        )

    def copper(node: tuple[int, int, int]) -> bool:
        x, y, layer_index = uq(node[0]), uq(node[1]), node[2]
        if x < edge or y < edge or x > board["width"] - edge or y > board["height"] - edge:
            return False
        if keepout["min"][0] <= x <= keepout["max"][0] and keepout["min"][1] <= y <= keepout["max"][1]:
            return False
        if ground_feature(x, y):
            return True
        for pad in non_ground_pads:
            if math.hypot(x - pad.x, y - pad.y) < pad.radius + clearance - 1e-9:
                return False
        for segment in non_ground_segments[LAYERS[layer_index]]:
            if distance_point_segment((x, y), segment) < segment.width / 2.0 + clearance - 1e-9:
                return False
        for via in vias:
            if via.net != "GND" and math.hypot(x - via.x, y - via.y) < via.diameter / 2.0 + clearance - 1e-9:
                return False
        return True

    def all_nodes() -> set[tuple[int, int, int]]:
        return {
            (x, y, layer)
            for layer in range(2)
            for x in range(math.ceil(edge / step), math.floor((board["width"] - edge) / step) + 1)
            for y in range(math.ceil(edge / step), math.floor((board["height"] - edge) / step) + 1)
            if copper((x, y, layer))
        }

    def connected(nodes: set[tuple[int, int, int]]) -> set[tuple[int, int, int]]:
        pad = ground_pads[0]
        start = (q(pad.x), q(pad.y), 0)
        if start not in nodes:
            raise RuntimeError("Ground-plane root pad is not copper")
        visited = {start}
        frontier = [start]
        while frontier:
            x, y, layer = frontier.pop()
            neighbors = [(x + 1, y, layer), (x - 1, y, layer), (x, y + 1, layer), (x, y - 1, layer)]
            px, py = uq(x), uq(y)
            if ground_feature(px, py):
                neighbors.append((x, y, 1 - layer))
            for neighbor in neighbors:
                if neighbor in nodes and neighbor not in visited:
                    visited.add(neighbor)
                    frontier.append(neighbor)
        return visited

    nodes = all_nodes()
    visited = connected(nodes)
    for pad in ground_pads:
        for layer in range(2):
            if (q(pad.x), q(pad.y), layer) not in visited:
                raise RuntimeError(f"{pad.key}: stitched ground planes do not reach this GND pad")
    return [
        {"layer": LAYERS[layer], "x": uq(x), "y": uq(y), "size": 0.26}
        for x, y, layer in sorted(nodes - visited)
    ]


def gerber_coord(value: float) -> str:
    return f"{int(round(value * 1_000_000)):010d}"


def gerber_header(title: str, apertures: dict[int, tuple[str, float]]) -> list[str]:
    lines = [f"G04 {title}*", "%TF.GenerationSoftware,OpenAI,HomeBrain Carrier Generator,1.0*%", "%FSLAX46Y46*%", "%MOMM*%", "%LPD*%"]
    for number, (shape, size) in sorted(apertures.items()):
        parameter = f"{size:.4f}X{size:.4f}" if shape == "R" else f"{size:.4f}"
        lines.append(f"%ADD{number}{shape},{parameter}*%")
    return lines


def gerber_flash(lines: list[str], aperture: int, x: float, y: float) -> None:
    lines.extend((f"D{aperture}*", f"X{gerber_coord(x)}Y{gerber_coord(y)}D03*"))


def gerber_draw(lines: list[str], aperture: int, start: tuple[float, float], end: tuple[float, float]) -> None:
    lines.extend(
        (
            f"D{aperture}*",
            f"X{gerber_coord(start[0])}Y{gerber_coord(start[1])}D02*",
            f"X{gerber_coord(end[0])}Y{gerber_coord(end[1])}D01*",
        )
    )


def write_copper(path: Path, layer: str, design: dict, pads: list[Pad], segments: list[Segment], vias: list[Via], ground_voids: list[dict]) -> None:
    clearance = design["board"]["minimum_clearance"]
    aperture_sizes = sorted(
        {pad.diameter for pad in pads}
        | {segment.width for segment in segments if segment.layer == layer}
        | {via.diameter for via in vias}
        | {round(pad.diameter + 2.0 * clearance, 4) for pad in pads if pad.net != "GND"}
        | {round(segment.width + 2.0 * clearance, 4) for segment in segments if segment.layer == layer and segment.net != "GND"}
        | {round(via.diameter + 2.0 * clearance, 4) for via in vias if via.net != "GND"}
    )
    number_by_size = {size: 10 + index for index, size in enumerate(aperture_sizes)}
    apertures = {number_by_size[size]: ("C", size) for size in aperture_sizes}
    layer_voids = [item for item in ground_voids if item["layer"] == layer]
    void_aperture = max(apertures) + 1
    if layer_voids:
        apertures[void_aperture] = ("R", layer_voids[0]["size"])
    lines = gerber_header(f"HomeBrain carrier {layer}", apertures)
    if layer in LAYERS:
        edge = design["board"]["edge_clearance"]
        width, height = design["board"]["width"], design["board"]["height"]
        # Stitched front/back ground planes replace nine separate GND traces,
        # reducing congestion and improving USB/PMS current return. Clear-mode
        # moats are cut before non-ground copper is redrawn. Every plated GND
        # pad joins the two fills and prevents a route barrier on one layer from
        # isolating a connector on the other.
        lines.extend(
            (
                "G36*",
                f"X{gerber_coord(edge)}Y{gerber_coord(edge)}D02*",
                f"X{gerber_coord(width - edge)}Y{gerber_coord(edge)}D01*",
                f"X{gerber_coord(width - edge)}Y{gerber_coord(height - edge)}D01*",
                f"X{gerber_coord(edge)}Y{gerber_coord(height - edge)}D01*",
                f"X{gerber_coord(edge)}Y{gerber_coord(edge)}D01*",
                "G37*",
                "%LPC*%",
            )
        )
        for pad in sorted((item for item in pads if item.net != "GND"), key=lambda item: item.key):
            clear_size = round(pad.diameter + 2.0 * clearance, 4)
            gerber_flash(lines, number_by_size[clear_size], pad.x, pad.y)
        for segment in sorted((item for item in segments if item.layer == layer and item.net != "GND"), key=lambda item: (item.net, item.start, item.end)):
            clear_size = round(segment.width + 2.0 * clearance, 4)
            gerber_draw(lines, number_by_size[clear_size], segment.start, segment.end)
        for via in sorted((item for item in vias if item.net != "GND"), key=lambda item: (item.net, item.x, item.y)):
            clear_size = round(via.diameter + 2.0 * clearance, 4)
            gerber_flash(lines, number_by_size[clear_size], via.x, via.y)
        keepout = design["board"]["antenna_copper_keepout"]
        lines.extend(
            (
                "G36*",
                f"X{gerber_coord(keepout['min'][0])}Y{gerber_coord(keepout['min'][1])}D02*",
                f"X{gerber_coord(keepout['max'][0])}Y{gerber_coord(keepout['min'][1])}D01*",
                f"X{gerber_coord(keepout['max'][0])}Y{gerber_coord(keepout['max'][1])}D01*",
                f"X{gerber_coord(keepout['min'][0])}Y{gerber_coord(keepout['max'][1])}D01*",
                f"X{gerber_coord(keepout['min'][0])}Y{gerber_coord(keepout['min'][1])}D01*",
                "G37*",
            )
        )
        for void in layer_voids:
            gerber_flash(lines, void_aperture, void["x"], void["y"])
        lines.append("%LPD*%")
    for pad in sorted(pads, key=lambda item: item.key):
        gerber_flash(lines, number_by_size[pad.diameter], pad.x, pad.y)
    for via in sorted(vias, key=lambda item: (item.net, item.x, item.y)):
        gerber_flash(lines, number_by_size[via.diameter], via.x, via.y)
    for segment in sorted((item for item in segments if item.layer == layer), key=lambda item: (item.net, item.start, item.end)):
        gerber_draw(lines, number_by_size[segment.width], segment.start, segment.end)
    lines.append("M02*")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def write_mask(path: Path, layer: str, pads: list[Pad], expansion: float) -> None:
    sizes = sorted({round(pad.diameter + 2.0 * expansion, 4) for pad in pads})
    number_by_size = {size: 10 + index for index, size in enumerate(sizes)}
    lines = gerber_header(f"HomeBrain carrier {layer} solder mask openings", {number_by_size[size]: ("C", size) for size in sizes})
    for pad in sorted(pads, key=lambda item: item.key):
        size = round(pad.diameter + 2.0 * expansion, 4)
        gerber_flash(lines, number_by_size[size], pad.x, pad.y)
    lines.append("M02*")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


FONT: dict[str, tuple[str, ...]] = {
    " ": ("000",) * 5,
    "+": ("000", "010", "111", "010", "000"),
    "-": ("000", "000", "111", "000", "000"),
    "/": ("001", "001", "010", "100", "100"),
    "0": ("111", "101", "101", "101", "111"),
    "1": ("010", "110", "010", "010", "111"),
    "2": ("110", "001", "111", "100", "111"),
    "3": ("110", "001", "111", "001", "110"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "110", "001", "110"),
    "6": ("011", "100", "111", "101", "111"),
    "7": ("111", "001", "010", "010", "010"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "110"),
    "A": ("010", "101", "111", "101", "101"),
    "B": ("110", "101", "110", "101", "110"),
    "C": ("011", "100", "100", "100", "011"),
    "D": ("110", "101", "101", "101", "110"),
    "E": ("111", "100", "110", "100", "111"),
    "F": ("111", "100", "110", "100", "100"),
    "G": ("011", "100", "101", "101", "011"),
    "H": ("101", "101", "111", "101", "101"),
    "I": ("111", "010", "010", "010", "111"),
    "J": ("001", "001", "001", "101", "010"),
    "K": ("101", "101", "110", "101", "101"),
    "L": ("100", "100", "100", "100", "111"),
    "M": ("10001", "11011", "10101", "10101", "10101"),
    "N": ("1001", "1101", "1011", "1001", "1001"),
    "O": ("010", "101", "101", "101", "010"),
    "P": ("110", "101", "110", "100", "100"),
    "Q": ("010", "101", "101", "011", "001"),
    "R": ("110", "101", "110", "101", "101"),
    "S": ("011", "100", "010", "001", "110"),
    "T": ("111", "010", "010", "010", "010"),
    "U": ("101", "101", "101", "101", "111"),
    "V": ("101", "101", "101", "101", "010"),
    "W": ("10101", "10101", "10101", "11011", "10001"),
    "X": ("101", "101", "010", "101", "101"),
    "Y": ("101", "101", "010", "010", "010"),
    "Z": ("111", "001", "010", "100", "111"),
}


def bitmap_text_segments(text: str, x: float, y: float, pixel: float = 0.18, rotation: int = 0) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    cursor = 0.0
    for char in text.upper():
        glyph = FONT.get(char, FONT[" "])
        width = max(len(row) for row in glyph)
        for row_index, row in enumerate(glyph):
            for column_index, value in enumerate(row):
                if value != "1":
                    continue
                local_x = cursor + column_index * pixel
                local_y = row_index * pixel
                if rotation == 90:
                    px, py = x - local_y, y + local_x
                elif rotation == 180:
                    px, py = x - local_x, y - local_y
                else:
                    px, py = x + local_x, y + local_y
                points.append((round(px, 5), round(py, 5)))
        cursor += (width + 1) * pixel
    return points


def write_silkscreen(path: Path, design: dict) -> None:
    lines = gerber_header("HomeBrain carrier front silkscreen", {10: ("C", 0.18), 11: ("C", 0.25)})
    labels = [
        ("J1", 1.3, 7.3, 0), ("J2", 13.3, 7.3, 0), ("J5", 1.8, 10.2, 0), ("J6", 13.2, 10.2, 0),
        ("J7", 26.0, 9.2, 0), ("J3", 1.3, 48.2, 0), ("J4", 13.3, 48.2, 0),
        ("USB", 1.0, 22.0, 90), ("HB V1", 6.6, 25.2, 90), ("SVC", 27.2, 38.0, 90),
        ("R1", 9.8, 14.4, 0), ("R2", 3.8, 40.0, 0),
    ]
    for value, x, y, rotation in labels:
        for px, py in bitmap_text_segments(value, x, y, 0.18, rotation):
            gerber_flash(lines, 10, px, py)
    # XIAO outline and USB/antenna direction marks.
    xiao = design["xiao"]
    cx, cy = xiao["center"]
    sx, sy = xiao["board_size"]
    outline = [(cx - sx / 2, cy - sy / 2), (cx + sx / 2, cy - sy / 2), (cx + sx / 2, cy + sy / 2), (cx - sx / 2, cy + sy / 2), (cx - sx / 2, cy - sy / 2)]
    for first, second in zip(outline, outline[1:]):
        gerber_draw(lines, 11, first, second)
    # Pin-1 dots on every keyed connector.
    for part in design["parts"]:
        if part["type"] == "JST-XH":
            pin1_x = part["center"][0] - (part["positions"] - 1) * 1.25
            gerber_flash(lines, 11, pin1_x, part["center"][1] - 1.6)
    lines.append("M02*")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def write_outline(path: Path, width: float, height: float) -> None:
    lines = gerber_header("HomeBrain carrier board outline", {10: ("C", 0.1)})
    points = [(0.0, 0.0), (width, 0.0), (width, height), (0.0, height), (0.0, 0.0)]
    for first, second in zip(points, points[1:]):
        gerber_draw(lines, 10, first, second)
    lines.append("M02*")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def write_drill(path: Path, pads: list[Pad], vias: list[Via]) -> None:
    tools = sorted({pad.drill for pad in pads} | {via.drill for via in vias})
    tool_number = {diameter: index + 1 for index, diameter in enumerate(tools)}
    lines = ["M48", "; DRILL file generated by HomeBrain Carrier Generator", "METRIC,TZ"]
    for diameter in tools:
        lines.append(f"T{tool_number[diameter]:02d}C{diameter:.3f}")
    lines.append("%")
    for diameter in tools:
        lines.append(f"T{tool_number[diameter]:02d}")
        locations = [(pad.x, pad.y) for pad in pads if pad.drill == diameter] + [(via.x, via.y) for via in vias if via.drill == diameter]
        for x, y in sorted(locations):
            lines.append(f"X{int(round(x * 1000)):06d}Y{int(round(y * 1000)):06d}")
    lines.extend(("M30", ""))
    path.write_text("\n".join(lines), encoding="ascii")


def deterministic_zip(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file_path in sorted(path for path in source.rglob("*") if path.is_file()):
            info = zipfile.ZipInfo(file_path.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, file_path.read_bytes())


def svg_document(width: int, height: int, title: str, metadata: dict, body: Iterable[str]) -> str:
    return "\n".join(
        [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
            f"<title>{escape(title)}</title>",
            f"<metadata>{escape(json.dumps(metadata, sort_keys=True))}</metadata>",
            '<rect width="100%" height="100%" fill="#f4f7fb"/>',
            *body,
            "</svg>",
            "",
        ]
    )


def svg_text(x: float, y: float, value: str, *, size: int = 22, weight: int = 500, fill: str = "#15243b", anchor: str = "start") -> str:
    return f'<text x="{x}" y="{y}" font-family="Arial,Helvetica,sans-serif" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}">{escape(value)}</text>'


def svg_rect(x: float, y: float, width: float, height: float, *, fill: str = "white", stroke: str = "#c7d2e2", stroke_width: float = 2.0, radius: float = 12.0, extra: str = "") -> str:
    return f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="{stroke_width}" {extra}/>'


def render_board_svg(design: dict, pads: list[Pad], segments: list[Segment], vias: list[Via]) -> str:
    width, height = 1800, 1200
    board_x, board_y, scale = 100.0, 180.0, 13.3
    board_w = design["board"]["width"] * scale
    board_h = design["board"]["height"] * scale
    body = [
        svg_text(70, 62, "HOMEBRAIN UNIVERSAL SENSOR CARRIER — ASSEMBLY", size=34, weight=850),
        svg_text(70, 102, "Front/component side • USB edge left • keyed JST-XH ports • XIAO plugs into two 1×7 sockets", size=21, weight=650, fill="#56708d"),
        svg_rect(board_x - 18, board_y - 18, board_w + 36, board_h + 36, fill="#ffffff", radius=24),
        svg_rect(board_x, board_y, board_w, board_h, fill="#0b695f", stroke="#083e48", stroke_width=4, radius=5),
    ]
    keepout = design["board"]["antenna_copper_keepout"]
    kx = board_x + keepout["min"][0] * scale
    ky = board_y + keepout["min"][1] * scale
    kw = (keepout["max"][0] - keepout["min"][0]) * scale
    kh = (keepout["max"][1] - keepout["min"][1]) * scale
    body.append(f'<rect x="{kx}" y="{ky}" width="{kw}" height="{kh}" fill="#ffe7a4" fill-opacity="0.78" stroke="#f5b23b" stroke-width="2" stroke-dasharray="8 6"/>')
    body.append(svg_text(kx + kw / 2, ky + kh / 2, "NO COPPER", size=12, weight=900, fill="#875308", anchor="middle"))
    for segment in segments:
        color = "#ff4b55" if segment.layer == "F.Cu" else "#36a3ff"
        opacity = "0.88" if segment.layer == "F.Cu" else "0.62"
        body.append(
            f'<line x1="{board_x + segment.start[0] * scale}" y1="{board_y + segment.start[1] * scale}" '
            f'x2="{board_x + segment.end[0] * scale}" y2="{board_y + segment.end[1] * scale}" '
            f'stroke="{color}" stroke-opacity="{opacity}" stroke-width="{max(4.0, segment.width * scale)}" stroke-linecap="round" data-net="{segment.net}" data-layer="{segment.layer}"/>'
        )
    for via in vias:
        body.append(f'<circle cx="{board_x + via.x * scale}" cy="{board_y + via.y * scale}" r="{via.diameter * scale / 2}" fill="#f6c74f" stroke="#16334d" stroke-width="2" data-net="{via.net}"/>')
    # Component outlines.
    xiao = design["xiao"]
    xiao_x = board_x + (xiao["center"][0] - xiao["board_size"][0] / 2) * scale
    xiao_y = board_y + (xiao["center"][1] - xiao["board_size"][1] / 2) * scale
    body.append(svg_rect(xiao_x, xiao_y, xiao["board_size"][0] * scale, xiao["board_size"][1] * scale, fill="#113c54", stroke="#6ce0d3", stroke_width=3, radius=8, extra='data-part="U1"'))
    body.append(svg_text(xiao_x + xiao["board_size"][0] * scale / 2, xiao_y + 74, "XIAO", size=22, weight=900, fill="white", anchor="middle"))
    body.append(svg_text(xiao_x + xiao["board_size"][0] * scale / 2, xiao_y + 102, "ESP32-C6", size=15, weight=750, fill="#a9f3ea", anchor="middle"))
    body.append(svg_rect(xiao_x - 7, xiao_y + 83, 22, 52, fill="#b9c1cc", stroke="#65758a", stroke_width=2, radius=5))
    body.append(svg_text(xiao_x - 16, xiao_y + 73, "USB-C", size=13, weight=900, fill="#f8d36a", anchor="end"))
    for part in design["parts"]:
        cx, cy = part["center"]
        if part["type"] == "JST-XH":
            pw = (part["positions"] * 2.5 + 2.5) * scale
            ph = 5.8 * scale
            body.append(svg_rect(board_x + cx * scale - pw / 2, board_y + cy * scale - ph / 2, pw, ph, fill="#f2f1e9", stroke="#223b55", stroke_width=2, radius=5, extra=f'data-part="{part["ref"]}"'))
            body.append(svg_text(board_x + cx * scale, board_y + cy * scale - ph / 2 - 8, f"{part['ref']} {part['value']}", size=13, weight=850, fill="#ffffff", anchor="middle"))
        elif part["type"] == "AXIAL":
            body.append(svg_rect(board_x + (cx - 3.1) * scale, board_y + (cy - 1.0) * scale, 6.2 * scale, 2.0 * scale, fill="#d6b47b", stroke="#5d4428", stroke_width=2, radius=8, extra=f'data-part="{part["ref"]}"'))
            body.append(svg_text(board_x + cx * scale, board_y + (cy + 0.35) * scale, part["ref"], size=12, weight=900, fill="#3b2c18", anchor="middle"))
    for pad in pads:
        color = "#f4ce55" if not pad.net.startswith("NC_") else "#a4afbd"
        body.append(f'<circle cx="{board_x + pad.x * scale}" cy="{board_y + pad.y * scale}" r="{pad.diameter * scale / 2}" fill="{color}" stroke="#172b42" stroke-width="2" data-pad="{escape(pad.key)}" data-net="{pad.net}"/>')
        body.append(f'<circle cx="{board_x + pad.x * scale}" cy="{board_y + pad.y * scale}" r="{pad.drill * scale / 2}" fill="#eef2f6"/>')
    # Right-side assembly contract.
    panel_x = 535
    body.extend(
        [
            svg_rect(panel_x, 180, 1190, 198, fill="#ffffff", radius=20),
            svg_text(panel_x + 28, 220, "Why this fixes the fan-out problem", size=25, weight=850),
            svg_text(panel_x + 28, 258, "Each XIAO pin enters exactly one socket contact. Copper on this PCB fans power, ground, SDA and SCL out", size=20, weight=600),
            svg_text(panel_x + 28, 290, "to separate keyed ports. No XIAO hole ever contains two wires, and every sensor harness can be unplugged.", size=20, weight=600),
            svg_text(panel_x + 28, 338, "Red = front copper   •   Blue = back copper   •   Gold = plated through-hole   •   Yellow = antenna copper keep-out", size=18, weight=750, fill="#56708d"),
            svg_rect(panel_x, 400, 580, 650, fill="#ffffff", radius=20),
            svg_text(panel_x + 28, 440, "Connector pin contract", size=25, weight=850),
        ]
    )
    y = 480
    for part in [item for item in design["parts"] if item["type"] == "JST-XH"]:
        body.append(svg_text(panel_x + 28, y, f"{part['ref']}  {part['value']}", size=19, weight=850))
        body.append(svg_text(panel_x + 210, y, "  ·  ".join(f"{index}:{label}" for index, label in enumerate(part["labels"], 1)), size=17, weight=650, fill="#3f5d79"))
        y += 54
    body.extend(
        [
            svg_rect(panel_x + 610, 400, 580, 650, fill="#ffffff", radius=20),
            svg_text(panel_x + 638, 440, "Assembly rules", size=25, weight=850),
            svg_text(panel_x + 638, 488, "1. Solder the two 1×7 sockets perfectly vertical.", size=19, weight=650),
            svg_text(panel_x + 638, 532, "2. Solder all keyed headers with pin 1 at the round silk dot.", size=19, weight=650),
            svg_text(panel_x + 638, 576, "3. Populate R1/R2 only on Climate; both are 200 kΩ 1%.", size=19, weight=650),
            svg_text(panel_x + 638, 620, "4. Plug the XIAO in component-side up, USB toward the arrow.", size=19, weight=650),
            svg_text(panel_x + 638, 664, "5. Meter-check GND↔GND and confirm no 3V3↔5V short.", size=19, weight=650),
            svg_text(panel_x + 638, 708, "6. On Climate, verify battery polarity before inserting J6/J7.", size=19, weight=650),
            svg_text(panel_x + 638, 768, "SERVICE", size=19, weight=850, fill="#8b4db8"),
            svg_text(panel_x + 748, 768, "Short TP1 to TP2/GND during boot for 1.5 seconds.", size=18, weight=650),
            svg_text(panel_x + 638, 824, "XIAO SOCKET ROWS", size=19, weight=850, fill="#087d70"),
            svg_text(panel_x + 638, 862, "Top: D0, D1, D2, D3, SDA, SCL, TX", size=18, weight=650),
            svg_text(panel_x + 638, 898, "Bottom: VBUS, GND, 3V3, D10, D9, D8, RX", size=18, weight=650),
            svg_text(panel_x + 638, 958, "D10/D9/D8 remain electrically isolated on this board.", size=18, weight=650, fill="#66788c"),
        ]
    )
    return svg_document(width, height, design["title"], {"artifact": "carrier-assembly", "pads": len(pads), "segments": len(segments), "vias": len(vias)}, body)


def schematic_svg(design: dict) -> str:
    width, height = 1800, 1100
    colors = {"GND": "#252f3d", "3V3": "#e13d4e", "VBUS": "#ff675c", "BAT+": "#d32636", "A0": "#d39b12", "D1": "#7b8798", "D2": "#9b7fc2", "D3": "#f28b27", "SDA": "#1aa876", "SCL": "#237bd8", "TX": "#814cd1", "RX": "#e0a61a"}
    body = [
        svg_text(60, 62, "HOMEBRAIN CARRIER — ELECTRICAL SCHEMATIC", size=34, weight=850),
        svg_text(60, 100, "The carrier is passive: sockets, copper fan-out, keyed headers, and the Climate-only 1:2 battery divider.", size=21, weight=650, fill="#56708d"),
        svg_rect(690, 210, 420, 620, fill="#103b53", stroke="#62dfd0", stroke_width=4, radius=22, extra='data-part="U1"'),
        svg_text(900, 262, "U1  XIAO ESP32-C6", size=27, weight=850, fill="white", anchor="middle"),
    ]
    left_ports = [("J1", "I2C-A", 190), ("J2", "I2C-B", 360), ("J3", "I2C-C", 530), ("J5", "DHT", 700)]
    right_ports = [("J4", "UART-5V", 220), ("J6", "BAT-IN", 480), ("J7", "TO-XIAO-BAT", 680)]
    parts_by_ref = {part["ref"]: part for part in design["parts"]}
    for ref, title, y in left_ports:
        part = parts_by_ref[ref]
        body.append(svg_rect(90, y, 360, 130, fill="#ffffff", radius=16, extra=f'data-part="{ref}"'))
        body.append(svg_text(115, y + 34, f"{ref}  {title}", size=21, weight=850))
        for index, (net, label) in enumerate(zip(part["pin_nets"], part["labels"]), 1):
            line_y = y + 42 + index * 19
            body.append(svg_text(120, line_y, f"{index} {label}", size=14, weight=700, fill=colors[net]))
            body.append(f'<path d="M 450 {line_y - 5} H 570 V {310 + list(design["nets"]).index(net) * 38} H 690" fill="none" stroke="{colors[net]}" stroke-width="4" data-net="{net}"/>')
    for ref, title, y in right_ports:
        part = parts_by_ref[ref]
        body.append(svg_rect(1350, y, 360, 130, fill="#ffffff", radius=16, extra=f'data-part="{ref}"'))
        body.append(svg_text(1375, y + 34, f"{ref}  {title}", size=21, weight=850))
        for index, (net, label) in enumerate(zip(part["pin_nets"], part["labels"]), 1):
            line_y = y + 42 + index * 19
            body.append(svg_text(1380, line_y, f"{index} {label}", size=14, weight=700, fill=colors[net]))
            body.append(f'<path d="M 1110 {310 + list(design["nets"]).index(net) * 38} H 1230 V {line_y - 5} H 1350" fill="none" stroke="{colors[net]}" stroke-width="4" data-net="{net}"/>')
    for index, net in enumerate(design["nets"]):
        y = 310 + index * 38
        body.append(svg_text(900, y + 6, net, size=16, weight=850, fill=colors[net], anchor="middle"))
    body.extend(
        [
            svg_rect(1160, 865, 550, 175, fill="#fff9e9", stroke="#e9b847", stroke_width=3, radius=18),
            svg_text(1188, 905, "CLIMATE BATTERY DIVIDER", size=21, weight=850, fill="#7a5400"),
            svg_text(1190, 950, "BAT+ ─ R1 200 kΩ ─ A0 ─ R2 200 kΩ ─ GND", size=20, weight=750),
            svg_text(1190, 990, "J6 feeds the battery; J7 carries ± to the XIAO underside pads.", size=17, weight=650, fill="#6d5b32"),
            svg_rect(90, 865, 720, 175, fill="#ffffff", radius=18),
            svg_text(118, 905, "IMPORTANT", size=21, weight=850, fill="#c22f35"),
            svg_text(118, 950, "J4 pin 3 MCU-TX goes to the sensor RX pin.", size=19, weight=700),
            svg_text(118, 988, "J4 pin 4 MCU-RX comes from the sensor TX pin.", size=19, weight=700),
        ]
    )
    return svg_document(width, height, "HomeBrain carrier electrical schematic", {"artifact": "carrier-schematic", "net_count": len(design["nets"])}, body)


MODULE_ORDERS = {
    "BME680": "Sensor LEFT; holes RIGHT top→bottom: VCC, GND, SCL, SDA, SDO, CS",
    "SCD41": "Sensor TOP; holes BOTTOM left→right: GND, VDD, SCL, SDA",
    "VEML7700": "Sensor TOP; holes BOTTOM left→right: VIN, 3Vo, GND, SCL, SDA",
    "PMS5003 breakout": "Red breakout holes top→bottom: VCC, GND, SET, RXD, TXD, RESET, NC, NC",
    "LD2410C": "Antenna/component face up; pins left→right: TX, RX, OUT, GND, VCC",
    "DHT11": "Blue sensor up; pins left→right: +, OUT, −",
    "LiPo adapter": "Meter-verified polarity only: BAT−, BAT+",
    "XIAO underside battery pads": "USB left/component side up: BAT− pad then BAT+ pad; confirm against board silk",
}


def harness_svg(design: dict, profile_id: str) -> str:
    profile = design["profiles"][profile_id]
    parts = {part["ref"]: part for part in design["parts"]}
    color_hex = {"black": "#222a35", "red": "#e33f4b", "yellow": "#e4a91a", "gray": "#7d8794", "white": "#d6dce5", "orange": "#ef8625", "green": "#14a879", "blue": "#277fd4", "purple": "#8751d0"}
    width, height = 1900, 1250
    body = [
        svg_text(55, 58, f"{profile['title'].upper()} — FINAL KEYED HARNESS", size=34, weight=850),
        svg_text(55, 98, "Carrier front/component side • XIAO USB left • follow connector pin numbers and printed module labels", size=21, weight=650, fill="#56708d"),
        svg_rect(55, 135, 590, 1010, fill="#ffffff", radius=22),
        svg_text(350, 180, "HOMEBRAIN CARRIER", size=26, weight=850, anchor="middle"),
        svg_text(350, 214, "XIAO plugs into sockets — no wire fan-out here", size=17, weight=700, fill="#087d70", anchor="middle"),
        svg_rect(210, 290, 280, 470, fill="#0b695f", stroke="#083e48", stroke_width=4, radius=12),
        svg_rect(268, 410, 164, 230, fill="#123c54", stroke="#64dfd1", stroke_width=3, radius=10),
        svg_text(350, 500, "XIAO", size=28, weight=900, fill="white", anchor="middle"),
        svg_text(350, 536, "ESP32-C6", size=18, weight=750, fill="#a9f3ea", anchor="middle"),
        svg_text(198, 540, "USB-C", size=16, weight=850, fill="#d9a614", anchor="end"),
    ]
    port_positions = {"J1": (246, 325), "J2": (402, 325), "J5": (222, 375), "J6": (350, 375), "J7": (466, 375), "J3": (246, 720), "J4": (402, 720)}
    for ref, (x, y) in port_positions.items():
        active = ref in profile["ports"]
        body.append(svg_rect(x - 54, y - 20, 108, 40, fill="#f2f1e9" if active else "#cfd6df", stroke="#20384f", stroke_width=2, radius=5, extra=f'data-port="{ref}" data-state="{"active" if active else "unused"}"'))
        body.append(svg_text(x, y + 6, ref, size=16, weight=900, fill="#15243b" if active else "#758293", anchor="middle"))
    body.append(svg_text(350, 820, "R1 + R2: " + ("POPULATE 200 kΩ 1%" if profile_id == "climate" else "LEAVE EMPTY"), size=18, weight=850, fill="#d06b10" if profile_id == "climate" else "#6b7788", anchor="middle"))
    body.append(svg_text(350, 870, "Unused keyed ports remain empty; never install jumpers across them.", size=16, weight=650, fill="#5d7085", anchor="middle"))
    card_x, card_y = 690, 145
    for card_index, (ref, mapping) in enumerate(profile["ports"].items()):
        part = parts[ref]
        card_height = 220 if len(part["pin_nets"]) <= 3 else 246
        if card_y + card_height > 1160:
            card_x += 580
            card_y = 145
        body.append(svg_rect(card_x, card_y, 540, card_height, fill="#ffffff", radius=20, extra=f'data-harness="{ref}" data-module="{escape(mapping["module"])}"'))
        body.append(svg_text(card_x + 24, card_y + 38, f"{ref} {part['value']}  →  {mapping['module']}", size=22, weight=850))
        row_y = card_y + 76
        for pin_index, (net, carrier_label, module_pin) in enumerate(zip(part["pin_nets"], part["labels"], mapping["module_pins"]), 1):
            color_name = design["wire_colors"][net]
            color = color_hex[color_name]
            body.append(f'<line x1="{card_x + 26}" y1="{row_y - 6}" x2="{card_x + 82}" y2="{row_y - 6}" stroke="{color}" stroke-width="9" stroke-linecap="round" data-net="{net}"/>')
            body.append(svg_text(card_x + 96, row_y, f"pin {pin_index} {carrier_label}  →  {module_pin}", size=18, weight=750))
            body.append(svg_text(card_x + 500, row_y, color_name.upper(), size=13, weight=850, fill=color, anchor="end"))
            row_y += 34
        body.append(svg_text(card_x + 24, card_y + card_height - 24, MODULE_ORDERS[mapping["module"]], size=14, weight=650, fill="#60748a"))
        card_y += card_height + 22
    body.extend(
        [
            svg_rect(55, 1165, 1790, 60, fill="#fff3d5", stroke="#e7b54a", stroke_width=2, radius=12),
            svg_text(82, 1203, "KEY RULE: the white XH plug is keyed at the carrier. At the sensor, match the printed pin label—not the module's left/right appearance or ribbon position.", size=18, weight=800, fill="#744c00"),
        ]
    )
    return svg_document(width, height, f"{profile['title']} final harness", {"artifact": "final-harness", "profile": profile_id, "active_ports": sorted(profile["ports"])}, body)


def render_png(svg_path: Path, png_path: Path, chrome: Path) -> None:
    if not chrome.is_file():
        raise FileNotFoundError(f"Google Chrome not found at {chrome}")
    subprocess.run(
        [
            str(chrome),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--window-size={svg_path.read_text(encoding='utf-8').split('width=\"', 1)[1].split('\"', 1)[0]},{svg_path.read_text(encoding='utf-8').split('height=\"', 1)[1].split('\"', 1)[0]}",
            f"--screenshot={png_path}",
            svg_path.resolve().as_uri(),
        ],
        check=True,
        timeout=20,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def write_bom(path: Path) -> None:
    rows = [
        ["Bare carrier PCB", "HomeBrain Universal Sensor Carrier v1.0", "5", "3 used + 2 spares", "JLCPCB", "https://cart.jlcpcb.com/quote"],
        ["1x7 female socket", "Sullins PPTC071LFBN-RC / DigiKey S7005-ND", "8", "6 used + 2 spares", "DigiKey", "https://www.digikey.com/en/products/detail/sullins-connector-solutions/PPTC071LFBN-RC/810146"],
        ["4-pin vertical header", "JST B4B-XH-A(LF)(SN) / 455-B4B-XH-A-ND", "14", "12 used + 2 spares", "DigiKey", "https://www.digikey.com/en/products/detail/jst-sales-america-inc/B4B-XH-A/1651047"],
        ["3-pin vertical header", "JST B3B-XH-A(LF)(SN) / 455-2248-ND", "4", "3 used + 1 spare", "DigiKey", "https://www.digikey.com/en/products/detail/jst-sales-america-inc/B3B-XH-A/1651046"],
        ["2-pin vertical header", "JST B2B-XH-A(LF)(SN) / 455-B2B-XH-A-ND", "8", "6 used + 2 spares", "DigiKey", "https://www.digikey.com/en/products/detail/jst-sales-america-inc/B2B-XH-A/1651045"],
        ["4-pin plug housing", "JST XHP-4 / 455-2267-ND", "8", "6 used + 2 spares", "DigiKey", "https://www.digikey.com/en/products/detail/jst-sales-america-inc/XHP-4/683353"],
        ["3-pin plug housing", "JST XHP-3 / 455-2219-ND", "4", "2 used + 2 spares", "DigiKey", "https://www.digikey.com/en/products/detail/jst-sales-america-inc/XHP-3/1651017"],
        ["2-pin plug housing", "JST XHP-2 / 455-2266-ND", "4", "2 used + 2 spares", "DigiKey", "https://www.digikey.com/en/products/detail/jst-sales-america-inc/XHP-2/555485"],
        ["8-inch double-ended pre-crimp lead", "JST ASXHSXH22K203 / 455-4222-ND", "20", "Cut 1.25-inch stubs from both ends: 40 keyed contacts; 34 used", "DigiKey", "https://www.digikey.com/en/products/detail/jst-sales-america-inc/ASXHSXH22K203/9961918"],
        ["200 kOhm 1% resistor", "Yageo MFR-25FRF52-200K cut tape", "4", "Climate R1/R2: 2 used + 2 spares", "DigiKey", "https://www.digikey.com/en/products/detail/yageo/MFR-25FRF52-200K/15104"],
        ["Micro 1.25 mm 2-pin pigtail set", "Amazon B0DMT6VZVC", "1 kit", "Use the half that physically mates with the MakerHawk battery; polarity-meter before splicing to J6", "Amazon", "https://www.amazon.com/dp/B0DMT6VZVC"],
        ["Female Dupont jumper ribbon", "ELEGOO B01EV70C78", "1 kit", "Use 30 female ends for module-side harnesses", "Already purchased deluxe item", "https://www.amazon.com/dp/B01EV70C78"],
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["Item", "Exact part", "Order quantity", "Use", "Source", "URL"])
        writer.writerows(rows)


def write_layout(path: Path, design: dict, pads: list[Pad], segments: list[Segment], vias: list[Via], ground_voids: list[dict]) -> None:
    payload = {
        "schema_version": 1,
        "board": design["board"],
        "pads": [pad.__dict__ for pad in pads],
        "segments": [segment.__dict__ for segment in segments],
        "vias": [via.__dict__ for via in vias],
        "planes": [
            {
                "net": "GND",
                "layer": layer,
                "bounds": [
                    [design["board"]["edge_clearance"], design["board"]["edge_clearance"]],
                    [design["board"]["width"] - design["board"]["edge_clearance"], design["board"]["height"] - design["board"]["edge_clearance"]]
                ],
                "clearance": design["board"]["minimum_clearance"],
                "antenna_keepout": design["board"]["antenna_copper_keepout"]
            }
            for layer in LAYERS
        ],
        "ground_plane_voids": ground_voids,
        "net_endpoints": {
            net: sorted(pad.key for pad in pads if pad.net == net)
            for net in design["nets"]
        },
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    design_path = args.design.resolve()
    output = args.output.resolve()
    design = json.loads(design_path.read_text(encoding="utf-8"))
    pads = derive_pads(design)
    router = Router(design, pads)
    segments, vias = router.route()
    ground_voids = compute_ground_plane_voids(design, pads, segments, vias)
    with tempfile.TemporaryDirectory(prefix="homebrain-carrier-") as temporary:
        staging = Path(temporary) / "generated"
        gerbers = staging / "gerbers"
        gerbers.mkdir(parents=True)
        write_copper(gerbers / "homebrain-carrier-F_Cu.gbr", "F.Cu", design, pads, segments, vias, ground_voids)
        write_copper(gerbers / "homebrain-carrier-B_Cu.gbr", "B.Cu", design, pads, segments, vias, ground_voids)
        expansion = design["board"]["solder_mask_expansion"]
        write_mask(gerbers / "homebrain-carrier-F_Mask.gbr", "front", pads, expansion)
        write_mask(gerbers / "homebrain-carrier-B_Mask.gbr", "back", pads, expansion)
        write_silkscreen(gerbers / "homebrain-carrier-F_Silkscreen.gbr", design)
        write_outline(gerbers / "homebrain-carrier-Edge_Cuts.gbr", design["board"]["width"], design["board"]["height"])
        write_drill(gerbers / "homebrain-carrier-PTH.drl", pads, vias)
        job = {
            "Header": {"GenerationSoftware": {"Vendor": "OpenAI", "Application": "HomeBrain Carrier Generator", "Version": "1.0"}},
            "GeneralSpecs": {"ProjectId": {"Name": "homebrain-carrier", "Revision": "v1.0"}, "Size": {"X": design["board"]["width"], "Y": design["board"]["height"]}, "LayerNumber": 2},
            "FilesAttributes": [
                {"Path": "homebrain-carrier-F_Cu.gbr", "FileFunction": "Copper,L1,Top"},
                {"Path": "homebrain-carrier-B_Cu.gbr", "FileFunction": "Copper,L2,Bot"},
                {"Path": "homebrain-carrier-F_Mask.gbr", "FileFunction": "SolderMask,Top"},
                {"Path": "homebrain-carrier-B_Mask.gbr", "FileFunction": "SolderMask,Bot"},
                {"Path": "homebrain-carrier-F_Silkscreen.gbr", "FileFunction": "Legend,Top"},
                {"Path": "homebrain-carrier-Edge_Cuts.gbr", "FileFunction": "Profile"},
                {"Path": "homebrain-carrier-PTH.drl", "FileFunction": "Plated,1,2,PTH,Drill"},
            ],
            "MaterialStackup": [
                {"Type": "Legend", "Name": "Top Silkscreen"},
                {"Type": "SolderPaste", "Name": "Top Solder Mask"},
                {"Type": "Copper", "Name": "Top Copper", "Notes": "1 oz"},
                {"Type": "Dielectric", "Name": "FR-4", "Thickness": 1.6},
                {"Type": "Copper", "Name": "Bottom Copper", "Notes": "1 oz"},
                {"Type": "SolderPaste", "Name": "Bottom Solder Mask"},
            ],
        }
        (gerbers / "homebrain-carrier-job.gbrjob").write_text(json.dumps(job, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        deterministic_zip(gerbers, staging / "homebrain-carrier-gerbers.zip")
        write_layout(staging / "layout.json", design, pads, segments, vias, ground_voids)
        write_bom(staging / "bom.csv")
        svg_outputs = {
            "homebrain-carrier-assembly.svg": render_board_svg(design, pads, segments, vias),
            "homebrain-carrier-schematic.svg": schematic_svg(design),
            **{f"final-harness-{profile}.svg": harness_svg(design, profile) for profile in design["profiles"]},
        }
        for name, content in svg_outputs.items():
            svg_path = staging / name
            svg_path.write_text(content, encoding="utf-8")
            if not args.svg_only:
                render_png(svg_path, svg_path.with_suffix(".png"), args.chrome)
        files = [path for path in staging.rglob("*") if path.is_file() and path.name != "manifest.json"]
        manifest = {
            "schema_version": 1,
            "generator": "scripts/generate-homebrain-carrier.py",
            "design_sha256": sha256(design_path),
            "board_mm": [design["board"]["width"], design["board"]["height"], design["board"]["thickness"]],
            "pad_count": len(pads),
            "route_segment_count": len(segments),
            "via_count": len(vias),
            "ground_plane_void_count": len(ground_voids),
            "fabrication_order": design["fabrication_order"],
            "files": {path.relative_to(staging).as_posix(): {"bytes": path.stat().st_size, "sha256": sha256(path)} for path in sorted(files)},
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if output.exists():
            resolved = output.resolve()
            expected_parent = (ROOT / "hardware/homebrain-sensors/carrier").resolve()
            if resolved.parent != expected_parent or resolved.name != "generated":
                raise RuntimeError(f"Refusing to replace unexpected output directory: {resolved}")
            shutil.rmtree(output)
        shutil.copytree(staging, output)
    print(f"Generated HomeBrain carrier: {len(pads)} pads, {len(segments)} trace segments, {len(vias)} vias")
    print(f"Fabrication ZIP: {output / 'homebrain-carrier-gerbers.zip'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
