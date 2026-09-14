#!/usr/bin/env python3
"""Independently validate HomeBrain enclosure STLs and generator repeatability."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import tempfile
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "hardware/homebrain-sensors/enclosures/enclosure-profiles.json"
DEFAULT_OUTPUT = ROOT / "hardware/homebrain-sensors/enclosures/generated"
DEFAULT_BLENDER = Path("/Applications/Blender.app/Contents/MacOS/Blender")
GENERATOR = ROOT / "scripts/generate-homebrain-enclosures.py"
MOTHERBOARD_CONFIG = ROOT / "hardware/homebrain-sensors/motherboards/motherboard-designs.json"


class VerificationError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--repeat", action="store_true", help="Regenerate twice and compare all six STL byte streams.")
    parser.add_argument("--blender", type=Path, default=DEFAULT_BLENDER)
    return parser.parse_args()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def triangle_area_squared(a: tuple[float, float, float], b: tuple[float, float, float], c: tuple[float, float, float]) -> float:
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    cross = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    return sum(value * value for value in cross) / 4.0


def parse_binary_stl(path: Path) -> dict:
    data = path.read_bytes()
    require(len(data) >= 84, f"{path.name}: shorter than a binary STL header")
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    require(len(data) == 84 + triangle_count * 50, f"{path.name}: malformed binary STL length")
    require(triangle_count >= 100, f"{path.name}: suspiciously few triangles ({triangle_count})")

    minimum = [float("inf")] * 3
    maximum = [float("-inf")] * 3
    edges: Counter[tuple[tuple[float, float, float], tuple[float, float, float]]] = Counter()
    degenerate = 0
    signed_volume = 0.0

    for triangle_index in range(triangle_count):
        offset = 84 + triangle_index * 50 + 12
        values = struct.unpack_from("<9f", data, offset)
        vertices = [tuple(values[vertex * 3 + axis] for axis in range(3)) for vertex in range(3)]
        require(all(math.isfinite(value) for vertex in vertices for value in vertex), f"{path.name}: non-finite vertex")
        for vertex in vertices:
            for axis, value in enumerate(vertex):
                minimum[axis] = min(minimum[axis], value)
                maximum[axis] = max(maximum[axis], value)
        if triangle_area_squared(*vertices) < 1e-12:
            degenerate += 1
        rounded = [tuple(round(value, 5) for value in vertex) for vertex in vertices]
        for first, second in ((rounded[0], rounded[1]), (rounded[1], rounded[2]), (rounded[2], rounded[0])):
            edges[tuple(sorted((first, second)))] += 1
        a, b, c = vertices
        signed_volume += (
            a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
        ) / 6.0

    non_manifold = [(edge, count) for edge, count in edges.items() if count != 2]
    require(degenerate == 0, f"{path.name}: {degenerate} degenerate triangles")
    require(not non_manifold, f"{path.name}: {len(non_manifold)} non-manifold edges")
    require(abs(signed_volume) > 1.0, f"{path.name}: effectively zero enclosed volume")
    return {
        "sha256": sha256(path),
        "bytes": len(data),
        "triangles": triangle_count,
        "bounds": {
            "min": [round(value, 4) for value in minimum],
            "max": [round(value, 4) for value in maximum],
            "size": [round(maximum[index] - minimum[index], 4) for index in range(3)],
        },
        "closed_edges": len(edges),
        "signed_volume_mm3": round(signed_volume, 2),
    }


def stl_vertices(path: Path) -> set[tuple[float, float, float]]:
    data = path.read_bytes()
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    vertices: set[tuple[float, float, float]] = set()
    for triangle_index in range(triangle_count):
        values = struct.unpack_from("<9f", data, 84 + triangle_index * 50 + 12)
        for vertex in range(3):
            vertices.add(tuple(values[vertex * 3 + axis] for axis in range(3)))
    return vertices


def stl_triangles(path: Path) -> list[tuple[tuple[float, float, float], ...]]:
    data = path.read_bytes()
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    triangles: list[tuple[tuple[float, float, float], ...]] = []
    for triangle_index in range(triangle_count):
        values = struct.unpack_from("<9f", data, 84 + triangle_index * 50 + 12)
        triangles.append(
            tuple(tuple(values[vertex * 3 + axis] for axis in range(3)) for vertex in range(3))
        )
    return triangles


def point_in_triangle_2d(
    point: tuple[float, float],
    triangle: tuple[tuple[float, float], tuple[float, float], tuple[float, float]],
    tolerance: float = 1e-6,
) -> bool:
    (px, py), ((ax, ay), (bx, by), (cx, cy)) = point, triangle
    denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(denominator) <= tolerance:
        return False
    first = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denominator
    second = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denominator
    third = 1.0 - first - second
    return first >= -tolerance and second >= -tolerance and third >= -tolerance


def wall_plane_covers(
    triangles: list[tuple[tuple[float, float, float], ...]],
    axis: int,
    plane: float,
    point: tuple[float, float],
    tolerance: float = 0.03,
) -> bool:
    projected_axes = [index for index in range(3) if index != axis]
    for triangle in triangles:
        if not all(abs(vertex[axis] - plane) <= tolerance for vertex in triangle):
            continue
        projected = tuple(
            (vertex[projected_axes[0]], vertex[projected_axes[1]]) for vertex in triangle
        )
        if point_in_triangle_2d(point, projected):
            return True
    return False


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"{path.name}: invalid PNG signature")
    return struct.unpack(">II", data[16:24])


def close_list(actual: list[float], expected: list[float], tolerance: float, label: str) -> None:
    require(len(actual) == len(expected), f"{label}: dimension count mismatch")
    for axis, (observed, wanted) in enumerate(zip(actual, expected)):
        require(abs(observed - wanted) <= tolerance, f"{label}: axis {axis} is {observed}, expected {wanted} ± {tolerance}")


def rotated_footprint(component: dict) -> tuple[float, float]:
    width, depth = component["size"][:2]
    if int(component.get("rotation", 0.0)) % 180 == 90:
        width, depth = depth, width
    return width, depth


def transform_source_point(profile: dict, point: list[float]) -> list[float]:
    """Rotate a motherboard design point into its installed case coordinates."""
    motherboard = next(component for component in profile["components"] if component["kind"] == "motherboard")
    source_width, source_depth = motherboard["source_board_size"]
    dx = point[0] - source_width / 2.0
    dy = point[1] - source_depth / 2.0
    rotation = int(motherboard["source_rotation_degrees"]) % 360
    require(rotation == 90, f"{profile['id']}: only the verified 90-degree motherboard installation is supported")
    return [motherboard["center"][0] - dy, motherboard["center"][1] + dx]


def verify_case_matches_motherboard_design(profile: dict, board: dict, motherboard_mount: dict, radio: dict) -> None:
    """Tie every case post and soldered proxy to the generated PCB source geometry."""
    require(profile["id"] == board["id"], "Enclosure and motherboard IDs differ")
    motherboard = next(component for component in profile["components"] if component["kind"] == "motherboard")
    close_list(motherboard["source_board_size"], board["size"], 0.001, f"{profile['id']} source motherboard size")
    close_list(motherboard["size"][:2], [board["size"][1], board["size"][0]], 0.001, f"{profile['id']} installed motherboard size")

    expected_holes = sorted(tuple(round(value, 4) for value in transform_source_point(profile, point)) for point in board["mounting_holes"])
    installed_holes = sorted(tuple(round(value, 4) for value in point) for point in motherboard["mounting_holes"])
    require(installed_holes == expected_holes, f"{profile['id']}: case posts do not match the PCB mounting drills")

    installed_xiao = transform_source_point(profile, board["xiao_center"])
    expected_offset = [
        round(installed_xiao[0] - motherboard["center"][0], 4),
        round(installed_xiao[1] - motherboard["center"][1], 4),
    ]
    close_list(motherboard["radio_board_center_offset"], expected_offset, 0.001, f"{profile['id']} XIAO case position")
    require(
        abs(profile["usb_cutout"]["center_z"] - radio["factory_header_usb_center_z_mm"]) <= 0.001,
        f"{profile['id']}: USB opening Z does not match the factory-header XIAO height",
    )

    source_modules = {module["ref"]: module for module in board["modules"]}
    factory_header_bottom = (
        motherboard_mount["post_top_z_mm"]
        + motherboard_mount["board_thickness_mm"]
        + motherboard_mount["factory_header_standoff_mm"]
    )
    for component in (item for item in profile["components"] if item["kind"] == "soldered"):
        source_ref = component.get("source_ref")
        require(source_ref in source_modules, f"{profile['id']}: {component['name']} has no matching motherboard source footprint")
        module = source_modules[source_ref]
        if module["header"].get("installed_on_module") is True:
            require(component.get("factory_headered") is True, f"{profile['id']} {source_ref}: case proxy omits the factory header spacer")
            require(abs(component["bottom_z"] - factory_header_bottom) <= 0.001, f"{profile['id']} {source_ref}: case proxy has the wrong factory-header Z height")
        min_x, min_y, max_x, max_y = module["outline"]
        outline_center = [(min_x + max_x) / 2.0, (min_y + max_y) / 2.0]
        source_width = max_x - min_x
        source_depth = max_y - min_y
        if module["mount"].startswith("vertical"):
            header = module["header"]
            pin_count = len(header["pins"])
            header_center = [
                header["origin"][0] + header["step"][0] * (pin_count - 1) / 2.0,
                header["origin"][1] + header["step"][1] * (pin_count - 1) / 2.0,
            ]
            expected_center = transform_source_point(profile, [outline_center[0], header_center[1]])
            expected_size = [3.0, source_width]
        else:
            require(module["mount"].startswith("parallel"), f"{profile['id']}: unsupported soldered-module orientation for {source_ref}")
            expected_center = transform_source_point(profile, outline_center)
            expected_size = [source_depth, source_width]
        close_list(component["center"], expected_center, 0.051, f"{profile['id']} {source_ref} installed center")
        close_list(component["size"][:2], expected_size, 0.051, f"{profile['id']} {source_ref} installed footprint")


def verify_pms5003_airflow_spec(profile: dict) -> dict | None:
    airflow_components = [component for component in profile["components"] if component.get("airflow")]
    if profile["id"] != "atmosphere":
        require(not airflow_components, f"{profile['id']}: only Atmosphere may declare the PMS5003 airflow contract")
        return None

    pms = next((component for component in profile["components"] if component["name"] == "PMS5003"), None)
    require(pms is not None, "atmosphere: missing PMS5003 component")
    require(pms.get("airflow") is not None, "atmosphere: PMS5003 must define a dedicated exterior airflow contract")
    require(airflow_components == [pms], "atmosphere: exactly the PMS5003 must own the airflow contract")
    airflow = pms["airflow"]
    require(airflow["port_face_axis"] == "y", "atmosphere: PMS5003 port face must point at a long Y wall")
    require(airflow["port_face_side"] in (-1, 1), "atmosphere: invalid PMS5003 port-face side")
    require(int(pms.get("rotation", 0.0)) % 180 == 0, "atmosphere: PMS5003 must remain unrotated for the Y-facing port plane")

    side = float(airflow["port_face_side"])
    x, y = pms["center"]
    width, depth, height = pms["size"]
    port_width, port_height = airflow["port_face_size_mm"]
    require(abs(port_width - width) <= 0.05, "atmosphere: PMS5003 port-face width no longer matches its physical 50 mm face")
    require(abs(port_height - 20.9) <= 0.05, "atmosphere: PMS5003 physical port-face height must remain 20.9 mm")
    require(abs(height - 21.0) <= 0.05, "atmosphere: PMS5003 enclosure height must remain 21 mm")

    inner_wall_plane = side * (profile["outer"][1] / 2.0 - profile["wall"])
    port_plane = y + side * depth / 2.0
    wall_gap = abs(port_plane - inner_wall_plane)
    require(abs(wall_gap - airflow["wall_gap_mm"]) <= 0.05, "atmosphere: PMS5003 port plane is not at its declared wall gap")
    require(1.8 <= wall_gap <= 3.0, "atmosphere: PMS5003 port face is not close enough to the host wall")
    base_height = airflow["mount_base_height_mm"]
    require(0.7 <= base_height <= 1.2, "atmosphere: PMS5003 tape base is outside the printable range")
    component_bottom = profile["bottom"] + base_height
    component_top = component_bottom + height
    component_center_z = (component_bottom + component_top) / 2.0
    body_height = profile["outer"][2] - profile["lid_thickness"]
    rib = airflow["shroud_rib_thickness_mm"]
    require(rib >= 1.2, "atmosphere: PMS5003 airflow shroud ribs are too thin to print reliably")
    require(component_top + rib <= body_height - 1.0, "atmosphere: PMS5003 airflow shroud collides with the lid")

    vents = {vent.get("id"): vent for vent in profile.get("side_vents", []) if vent.get("id")}
    intake_id = airflow["intake_vent_id"]
    exhaust_id = airflow["exhaust_vent_id"]
    require(intake_id != exhaust_id, "atmosphere: PMS5003 intake and exhaust must use separate vent banks")

    def vent_contract(vent_id: str) -> dict:
        require(vent_id in vents, f"atmosphere: missing dedicated vent bank {vent_id}")
        vent = vents[vent_id]
        require(vent["axis"] == "y", f"atmosphere: {vent_id} must pass through the long Y wall")
        require(vent["side"] == airflow["port_face_side"], f"atmosphere: {vent_id} is on the wrong side of the case")
        outer_plane = side * profile["outer"][1] / 2.0
        require(abs(vent["center"][1] - outer_plane) <= 0.05, f"atmosphere: {vent_id} is not centered through the exterior wall")
        cx, _cy, cz = vent["center"]
        span_x = (vent["count"] - 1) * vent["spacing"] + vent["slot"][0]
        free_area = vent["count"] * vent["slot"][0] * vent["slot"][2]
        return {
            "vent_id": vent_id,
            "count": vent["count"],
            "nominal_free_area_mm2": round(free_area, 4),
            "bounds_xz_mm": [
                [round(cx - span_x / 2.0, 4), round(cz - vent["slot"][2] / 2.0, 4)],
                [round(cx + span_x / 2.0, 4), round(cz + vent["slot"][2] / 2.0, 4)],
            ],
        }

    intake = vent_contract(intake_id)
    exhaust = vent_contract(exhaust_id)
    port_bounds = [
        [x - port_width / 2.0, component_center_z - port_height / 2.0],
        [x + port_width / 2.0, component_center_z + port_height / 2.0],
    ]
    for label, vent in (("intake", intake), ("exhaust", exhaust)):
        (min_x, min_z), (max_x, max_z) = vent["bounds_xz_mm"]
        require(
            min_x >= port_bounds[0][0] - 0.01
            and max_x <= port_bounds[1][0] + 0.01
            and min_z >= port_bounds[0][1] - 0.01
            and max_z <= port_bounds[1][1] + 0.01,
            f"atmosphere: {label} vent bank does not stay inside the physical PMS5003 port face",
        )

    fan_diameter = airflow["fan_opening_diameter_mm"]
    require(abs(fan_diameter - 18.0) <= 0.05, "atmosphere: PMS5003 fan opening must remain the documented 18 mm diameter")
    require(
        exhaust["nominal_free_area_mm2"] >= math.pi * (fan_diameter / 2.0) ** 2,
        "atmosphere: exhaust grille free area is smaller than the PMS5003 fan opening",
    )
    require(
        intake["nominal_free_area_mm2"] >= airflow["minimum_intake_free_area_mm2"],
        "atmosphere: intake grille free area is below its conservative minimum",
    )

    separator_x = x + airflow["separator_offset_mm"]
    separator_thickness = airflow["separator_thickness_mm"]
    require(separator_thickness >= 1.2, "atmosphere: PMS5003 separator is too thin to print reliably")
    separator_left = separator_x - separator_thickness / 2.0
    separator_right = separator_x + separator_thickness / 2.0
    require(intake["bounds_xz_mm"][1][0] <= separator_left - 0.2, "atmosphere: intake grille crosses the anti-recirculation divider")
    require(exhaust["bounds_xz_mm"][0][0] >= separator_right + 0.2, "atmosphere: exhaust grille crosses the anti-recirculation divider")
    clearance = airflow["separator_sensor_clearance_mm"]
    require(0.15 <= clearance <= 0.4, "atmosphere: PMS5003 shroud-to-sensor clearance is unsafe")
    channel_depth = wall_gap - clearance
    require(channel_depth >= 1.2, "atmosphere: PMS5003 printed airflow channel is too shallow")
    channel_center_y = (inner_wall_plane + port_plane + side * clearance) / 2.0

    return {
        "component": pms["name"],
        "installation": "small inlet holes and round fan opening face the dedicated exterior grille",
        "port_face": {
            "axis": "y",
            "side": int(side),
            "plane_mm": round(port_plane, 4),
            "host_inner_wall_plane_mm": round(inner_wall_plane, 4),
            "wall_gap_mm": round(wall_gap, 4),
            "bounds_xz_mm": [
                [round(port_bounds[0][0], 4), round(port_bounds[0][1], 4)],
                [round(port_bounds[1][0], 4), round(port_bounds[1][1], 4)],
            ],
        },
        "intake": intake,
        "exhaust": exhaust,
        "fan_opening_diameter_mm": fan_diameter,
        "separator": {
            "center_mm": [round(separator_x, 4), round(channel_center_y, 4), round(component_center_z, 4)],
            "size_mm": [round(separator_thickness, 4), round(channel_depth, 4), round(height, 4)],
            "sensor_clearance_mm": clearance,
        },
        "shroud": {
            "channel_depth_mm": round(channel_depth, 4),
            "frame_outer_bounds_xz_mm": [
                [round(x - width / 2.0 - rib, 4), round(component_bottom - rib, 4)],
                [round(x + width / 2.0 + rib, 4), round(component_top + rib, 4)],
            ],
            "rib_thickness_mm": rib,
        },
    }


def verify_xiao_radio_spec(radio: dict) -> None:
    require(radio["antenna_mode"] == "onboard_ceramic", "Fleet enclosures must use the XIAO onboard ceramic antenna")
    require(radio["antenna_end"] == "opposite_usb", "XIAO antenna end must remain opposite the USB connector")
    require(radio["forward_keepout_mm"] >= 12.0, "XIAO antenna needs at least 12 mm of forward plastic/air clearance")
    require(radio["side_keepout_mm"] >= 3.0, "XIAO antenna needs at least 3 mm of side clearance beyond the PCB")
    require(radio["external_ufl_reserved"] is True, "The unused external U.FL connector must remain reserved")


def verify_motherboard_mount_spec(mount: dict) -> None:
    require("four common #4 screws" in mount["retention"], "Motherboard retention must use four common #4 screws")
    require("two tall rear USB-load walls" in mount["retention"], "Motherboard must retain two tall rear USB-load walls")
    require(mount["board_thickness_mm"] == 1.6, "Motherboard thickness contract changed")
    require(11.5 <= mount["post_top_z_mm"] <= 12.5, "Motherboard post top is outside the intended assembly height")
    require(mount["post_outer_diameter_mm"] >= 7.2, "Motherboard screw posts are too thin")
    require(2.2 <= mount["pilot_diameter_mm"] <= 2.5, "Motherboard #4 screw pilot is unsafe")
    require(mount["pilot_depth_mm"] >= 8.2, "Motherboard screw pilot is too shallow")
    require(mount["rear_wall_height_mm"] >= 17.5, "Motherboard rear walls are too short to carry USB insertion force")
    require(mount["rear_wall_depth_mm"] >= 3.0, "Motherboard rear walls are too shallow")
    require(mount["rear_wall_width_mm"] >= 15.0, "Motherboard rear walls are too narrow")
    require(mount["rear_wall_center_gap_mm"] >= 17.0, "Motherboard rear walls leave too little central clearance")


def expected_motherboard_mount(profile: dict, mount: dict) -> dict:
    motherboard = next(component for component in profile["components"] if component["kind"] == "motherboard")
    x, y = motherboard["center"]
    width, _depth = motherboard["size"][:2]
    open_side = 1 if motherboard["open_side"] > 0 else -1
    rear_direction = -open_side
    rear_x = x + rear_direction * (width / 2.0 + mount["rear_wall_depth_mm"] / 2.0)
    y_offset = mount["rear_wall_center_gap_mm"] / 2.0 + mount["rear_wall_width_mm"] / 2.0
    rear_centers = [
        [round(rear_x, 4), round(y - y_offset, 4), round(profile["bottom"] + mount["rear_wall_height_mm"] / 2.0, 4)],
        [round(rear_x, 4), round(y + y_offset, 4), round(profile["bottom"] + mount["rear_wall_height_mm"] / 2.0, 4)],
    ]
    post_centers = [[round(px, 4), round(py, 4), round(mount["post_top_z_mm"], 4)] for px, py in motherboard["mounting_holes"]]
    return {
        "retention": mount["retention"],
        "post_centers_mm": post_centers,
        "post_outer_diameter_mm": mount["post_outer_diameter_mm"],
        "pilot_diameter_mm": mount["pilot_diameter_mm"],
        "pilot_depth_mm": mount["pilot_depth_mm"],
        "board_bottom_z_mm": mount["post_top_z_mm"],
        "rear_wall_centers_mm": rear_centers,
        "rear_wall_size_mm": [mount["rear_wall_depth_mm"], mount["rear_wall_width_mm"], mount["rear_wall_height_mm"]],
        "usb_open_side": open_side,
    }


def xiao_antenna_keepout(profile: dict, radio: dict) -> dict:
    xiao = next((component for component in profile["components"] if component["kind"] == "motherboard"), None)
    require(xiao is not None, f"{profile['id']}: missing dedicated motherboard reference")
    require(xiao.get("radio_board_size") == [21.0, 17.8], f"{profile['id']}: XIAO radio-board size changed")
    offset_x, offset_y = xiao.get("radio_board_center_offset", [0.0, 0.0])
    require(offset_x * xiao["open_side"] > 0.0, f"{profile['id']}: XIAO radio board is not offset toward USB")
    x, y = xiao["center"][0] + offset_x, xiao["center"][1] + offset_y
    width, depth = xiao["radio_board_size"]
    usb_direction = 1.0 if xiao["open_side"] > 0 else -1.0
    antenna_direction = -usb_direction
    antenna_edge_x = x + antenna_direction * width / 2.0
    far_edge_x = antenna_edge_x + antenna_direction * radio["forward_keepout_mm"]
    side = radio["side_keepout_mm"]
    return {
        "mode": radio["antenna_mode"],
        "bounds": [
            [round(min(antenna_edge_x, far_edge_x), 4), round(y - depth / 2.0 - side, 4)],
            [round(max(antenna_edge_x, far_edge_x), 4), round(y + depth / 2.0 + side, 4)],
        ],
        "antenna_edge_x": round(antenna_edge_x, 4),
        "usb_direction": int(usb_direction),
    }


def screw_boss_centers(profile: dict, fastener: dict) -> list[tuple[float, float]]:
    width, depth, _height = profile["outer"]
    radius = fastener["boss_outer_diameter_mm"] / 2.0
    offset = fastener["boss_edge_gap_mm"]
    x = width / 2.0 - profile["wall"] - radius - offset
    y = depth / 2.0 - profile["wall"] - radius - offset
    return [(-x, -y), (-x, y), (x, -y), (x, y)]


def verify_fastener_spec(fastener: dict) -> None:
    require(fastener["description"].startswith("#4 x 3/8 in Phillips pan-head"), "Fastener must remain the common #4 x 3/8 in Phillips pan-head type")
    require(fastener["home_depot_model"] == "Everbilt 824681", "Unexpected Home Depot fastener model")
    require(fastener["home_depot_store_sku"] == "1006540029", "Unexpected Home Depot store SKU")
    require(fastener["quantity_per_case_lid"] == 4, "Every lid must use exactly four identical screws")
    require(fastener["quantity_per_motherboard"] == 4, "Every motherboard must use exactly four identical screws")
    require(fastener["total_quantity"] == 24, "The three finished devices must require exactly 24 identical screws")
    require(9.4 <= fastener["screw_length_mm"] <= 9.7, "The screw must remain nominally 3/8 inch long")
    require(2.2 <= fastener["pilot_diameter_mm"] <= 2.5, "Direct-thread pilot diameter is unsafe for a #4 screw")
    require(fastener["boss_outer_diameter_mm"] >= 3.0 * fastener["pilot_diameter_mm"], "Direct-thread boss wall is too thin")
    require(fastener["clearance_diameter_mm"] >= 3.2, "Lid clearance hole is too small for a #4 screw")
    require(fastener["head_recess_diameter_mm"] >= 5.8, "Pan-head recess is too small")
    require(0.3 <= fastener["head_recess_depth_mm"] <= 0.9, "Head recess leaves an unsafe amount of lid material")
    boss_radius = fastener["boss_outer_diameter_mm"] / 2.0
    pilot_radius = fastener["pilot_diameter_mm"] / 2.0
    gusset_overlap = fastener["gusset_boss_overlap_mm"]
    pilot_clearance = fastener["gusset_pilot_clearance_mm"]
    require(
        boss_radius - gusset_overlap >= pilot_radius + pilot_clearance,
        "Top strengthening gusset overlaps the screw pilot and would seal its entrance",
    )
    require(1.0 <= gusset_overlap <= 2.0, "Boss gusset overlap is outside the structural design range")
    require(pilot_clearance >= 0.8, "Boss gusset leaves too little printable clearance around the pilot entrance")


def verify_component_layout(profile: dict, fastener: dict, radio: dict, mount: dict) -> dict:
    width, depth, total_height = profile["outer"]
    wall = profile["wall"]
    bottom = profile["bottom"]
    body_height = total_height - profile["lid_thickness"]
    inner_width = width - 2.0 * wall
    inner_depth = depth - 2.0 * wall
    boss_radius = fastener["boss_outer_diameter_mm"] / 2.0
    boss_centers = screw_boss_centers(profile, fastener)
    rectangles: list[tuple[str, str, float, float, float, float]] = []
    motherboard = next((component for component in profile["components"] if component["kind"] == "motherboard"), None)
    require(motherboard is not None, f"{profile['id']}: missing dedicated motherboard reference")
    require(sum(component["kind"] == "motherboard" for component in profile["components"]) == 1, f"{profile['id']}: expected exactly one motherboard")
    require(len(motherboard.get("mounting_holes", [])) == 4, f"{profile['id']}: motherboard must have four mounting holes")
    for component in profile["components"]:
        component_width, component_depth = rotated_footprint(component)
        x, y = component["center"]
        margin_x = inner_width / 2.0 - (abs(x) + component_width / 2.0)
        margin_y = inner_depth / 2.0 - (abs(y) + component_depth / 2.0)
        require(margin_x >= -0.01 and margin_y >= -0.01, f"{profile['id']}: {component['name']} crosses the inner wall")
        if component["kind"] == "motherboard":
            component_bottom = mount["post_top_z_mm"]
        elif component["kind"] == "soldered":
            component_bottom = component["bottom_z"]
        elif component.get("airflow"):
            component_bottom = bottom + component["airflow"]["mount_base_height_mm"]
        else:
            component_bottom = bottom + (3.0 if component["kind"] in ("large", "battery") else 2.2)
        require(
            component_bottom + component["size"][2] <= body_height - 1.0,
            f"{profile['id']}: {component['name']} collides with the screw-down lid",
        )
        for boss_x, boss_y in boss_centers:
            closest_dx = max(abs(boss_x - x) - component_width / 2.0, 0.0)
            closest_dy = max(abs(boss_y - y) - component_depth / 2.0, 0.0)
            require(
                math.hypot(closest_dx, closest_dy) >= boss_radius + 0.6,
                f"{profile['id']}: {component['name']} collides with a direct-thread screw boss",
            )
        rectangles.append(
            (
                component["name"],
                component["kind"],
                x - component_width / 2.0,
                x + component_width / 2.0,
                y - component_depth / 2.0,
                y + component_depth / 2.0,
            )
        )

    for index, first in enumerate(rectangles):
        for second in rectangles[index + 1 :]:
            # A directly soldered module intentionally occupies the same XY
            # envelope as its motherboard. All other items remain separate.
            if {first[1], second[1]} == {"motherboard", "soldered"}:
                continue
            overlap_x = min(first[3], second[3]) - max(first[2], second[2])
            overlap_y = min(first[5], second[5]) - max(first[4], second[4])
            require(
                overlap_x <= 0.01 or overlap_y <= 0.01,
                f"{profile['id']}: component envelopes overlap ({first[0]} / {second[0]})",
            )

    usb = profile["usb_cutout"]
    require(motherboard.get("open_side") == usb["side"], f"{profile['id']}: XIAO USB end does not face the case cutout")
    xiao_offset_x, xiao_offset_y = motherboard["radio_board_center_offset"]
    xiao_x = motherboard["center"][0] + xiao_offset_x
    xiao_y = motherboard["center"][1] + xiao_offset_y
    require(abs(xiao_y - usb["center_y"]) <= 0.01, f"{profile['id']}: USB cutout is not aligned to the XIAO connector")
    xiao_width = motherboard["radio_board_size"][0]
    usb_side = 1.0 if usb["side"] > 0 else -1.0
    connector_board_edge = xiao_x + usb_side * xiao_width / 2.0
    cutout_inner_edge = usb_side * (width / 2.0 - 2.0 * wall)
    connector_reach = abs(connector_board_edge - cutout_inner_edge)
    require(connector_reach <= 6.0, f"{profile['id']}: XIAO USB connector sits {connector_reach:.2f} mm beyond the cutout reach")
    require(mount["post_top_z_mm"] + mount["board_thickness_mm"] <= body_height - 1.0, f"{profile['id']}: motherboard collides with the lid")
    require(profile["bottom"] + mount["rear_wall_height_mm"] <= body_height - 1.0, f"{profile['id']}: motherboard rear walls collide with the lid")

    board_width, board_depth = rotated_footprint(motherboard)
    board_min_x = motherboard["center"][0] - board_width / 2.0
    board_max_x = motherboard["center"][0] + board_width / 2.0
    board_min_y = motherboard["center"][1] - board_depth / 2.0
    board_max_y = motherboard["center"][1] + board_depth / 2.0
    for hole_x, hole_y in motherboard["mounting_holes"]:
        require(
            board_min_x + 3.0 <= hole_x <= board_max_x - 3.0
            and board_min_y + 3.0 <= hole_y <= board_max_y - 3.0,
            f"{profile['id']}: motherboard mounting hole at {(hole_x, hole_y)} is too close to the PCB edge",
        )

    keepout = xiao_antenna_keepout(profile, radio)
    (keepout_min_x, keepout_min_y), (keepout_max_x, keepout_max_y) = keepout["bounds"]
    require(
        keepout_min_x >= -inner_width / 2.0 - 0.01
        and keepout_max_x <= inner_width / 2.0 + 0.01
        and keepout_min_y >= -inner_depth / 2.0 - 0.01
        and keepout_max_y <= inner_depth / 2.0 + 0.01,
        f"{profile['id']}: onboard antenna keep-out crosses the inner wall",
    )
    for name, kind, min_x, max_x, min_y, max_y in rectangles:
        if kind == "motherboard":
            continue
        overlap_x = min(max_x, keepout_max_x) - max(min_x, keepout_min_x)
        overlap_y = min(max_y, keepout_max_y) - max(min_y, keepout_min_y)
        require(
            overlap_x <= 0.01 or overlap_y <= 0.01,
            f"{profile['id']}: {name} enters the onboard antenna keep-out",
        )
    for boss_x, boss_y in boss_centers:
        closest_dx = max(keepout_min_x - boss_x, 0.0, boss_x - keepout_max_x)
        closest_dy = max(keepout_min_y - boss_y, 0.0, boss_y - keepout_max_y)
        require(
            math.hypot(closest_dx, closest_dy) >= boss_radius + 0.6,
            f"{profile['id']}: a metal lid screw would enter the onboard antenna keep-out",
        )
    return keepout


def verify_motherboard_rear_support_geometry(profile: dict, mount: dict, body_path: Path) -> None:
    expected = expected_motherboard_mount(profile, mount)
    vertices = stl_vertices(body_path)
    depth, width, height = expected["rear_wall_size_mm"]
    top_z = profile["bottom"] + height
    bottom_z = profile["bottom"]
    for index, center in enumerate(expected["rear_wall_centers_mm"], start=1):
        cx, cy, _cz = center
        local = [
            vertex
            for vertex in vertices
            if abs(vertex[0] - cx) <= depth / 2.0 + 0.08
            and abs(vertex[1] - cy) <= width / 2.0 + 0.08
        ]
        require(local, f"{profile['id']}: rear USB-load wall {index} is missing")
        require(any(abs(vertex[2] - top_z) <= 0.06 for vertex in local), f"{profile['id']}: rear USB-load wall {index} is shorter than {height} mm")
        require(any(abs(vertex[2] - bottom_z) <= 0.06 for vertex in local), f"{profile['id']}: rear USB-load wall {index} is not anchored to the case floor")

    motherboard = next(component for component in profile["components"] if component["kind"] == "motherboard")
    rear_x = expected["rear_wall_centers_mm"][0][0]
    # Inspect only the top of the tall walls. Other low locating features may
    # legitimately cross this X coordinate without filling the center gap.
    central_high_vertices = [
        vertex
        for vertex in vertices
        if abs(vertex[0] - rear_x) <= depth / 2.0 + 0.08
        and abs(vertex[1] - motherboard["center"][1]) < mount["rear_wall_center_gap_mm"] / 2.0 - 0.25
        and vertex[2] >= top_z - 0.25
    ]
    require(not central_high_vertices, f"{profile['id']}: tall motherboard rear walls block their intended center gap")


def verify_motherboard_post_geometry(profile: dict, mount: dict, body_path: Path) -> None:
    """Prove the four PCB pilots are open at the top, deep enough, and still blind."""
    expected = expected_motherboard_mount(profile, mount)
    vertices = stl_vertices(body_path)
    triangles = stl_triangles(body_path)
    post_top = mount["post_top_z_mm"]
    pilot_radius = mount["pilot_diameter_mm"] / 2.0
    post_radius = mount["post_outer_diameter_mm"] / 2.0
    for center_x, center_y, _center_z in expected["post_centers_mm"]:
        center = (center_x, center_y)
        entrance_sample_radius = pilot_radius * 0.55
        entrance_samples = [
            center,
            (center_x - entrance_sample_radius, center_y),
            (center_x + entrance_sample_radius, center_y),
            (center_x, center_y - entrance_sample_radius),
            (center_x, center_y + entrance_sample_radius),
        ]
        require(
            all(not wall_plane_covers(triangles, 2, post_top, sample) for sample in entrance_samples),
            f"{profile['id']}: motherboard screw pilot is sealed at {center}",
        )
        annulus_radius = (pilot_radius + post_radius) / 2.0
        annulus_samples = [
            (center_x - annulus_radius, center_y),
            (center_x + annulus_radius, center_y),
            (center_x, center_y - annulus_radius),
            (center_x, center_y + annulus_radius),
        ]
        require(
            all(wall_plane_covers(triangles, 2, post_top, sample) for sample in annulus_samples),
            f"{profile['id']}: motherboard post lacks a complete top annulus at {center}",
        )
        pilot_min, pilot_max = radial_z_range(vertices, center, pilot_radius)
        require(pilot_min <= post_top - mount["pilot_depth_mm"] + 0.08, f"{profile['id']}: motherboard pilot is too shallow at {center}")
        require(pilot_max >= post_top - 0.08, f"{profile['id']}: motherboard pilot does not open at {center}")
        require(pilot_min > profile["bottom"] + 1.0, f"{profile['id']}: motherboard pilot is not blind at {center}")


def verify_pms5003_airflow_geometry(profile: dict, airflow: dict, body_path: Path) -> None:
    """Check the actual STL has every grille slot plus the printed separator reaching the sensor."""
    triangles = stl_triangles(body_path)
    vertices = stl_vertices(body_path)
    outer_y = airflow["port_face"]["side"] * profile["outer"][1] / 2.0
    vent_map = {vent.get("id"): vent for vent in profile.get("side_vents", []) if vent.get("id")}

    for section in ("intake", "exhaust"):
        vent = vent_map[airflow[section]["vent_id"]]
        center_x, _center_y, center_z = vent["center"]
        slot_centers = [
            center_x + (index - (vent["count"] - 1) / 2.0) * vent["spacing"]
            for index in range(vent["count"])
        ]
        for index, slot_x in enumerate(slot_centers, start=1):
            require(
                not wall_plane_covers(triangles, 1, outer_y, (slot_x, center_z)),
                f"atmosphere: {section} slot {index} is blocked in the generated body STL",
            )
        for index, (first, second) in enumerate(zip(slot_centers, slot_centers[1:]), start=1):
            require(
                wall_plane_covers(triangles, 1, outer_y, ((first + second) / 2.0, center_z)),
                f"atmosphere: {section} grille rib {index} is missing from the generated body STL",
            )

    separator_x, separator_y, separator_z = airflow["separator"]["center_mm"]
    separator_width, separator_depth, separator_height = airflow["separator"]["size_mm"]
    separator_vertices = [
        vertex
        for vertex in vertices
        if abs(vertex[0] - separator_x) <= separator_width / 2.0 + 0.08
        and abs(vertex[2] - separator_z) <= separator_height / 2.0 + 0.08
        and abs(vertex[1] - separator_y) <= separator_depth / 2.0 + 0.08
    ]
    require(separator_vertices, "atmosphere: PMS5003 anti-recirculation separator is missing from the body STL")
    sensor_side_y = airflow["port_face"]["plane_mm"] + airflow["port_face"]["side"] * airflow["separator"]["sensor_clearance_mm"]
    if airflow["port_face"]["side"] < 0:
        require(
            max(vertex[1] for vertex in separator_vertices) >= sensor_side_y - 0.08,
            "atmosphere: PMS5003 separator does not reach the sensor-side end of the airflow channel",
        )
    else:
        require(
            min(vertex[1] for vertex in separator_vertices) <= sensor_side_y + 0.08,
            "atmosphere: PMS5003 separator does not reach the sensor-side end of the airflow channel",
        )
    require(
        min(vertex[2] for vertex in separator_vertices) <= separator_z - separator_height / 2.0 + 0.08
        and max(vertex[2] for vertex in separator_vertices) >= separator_z + separator_height / 2.0 - 0.08,
        "atmosphere: PMS5003 separator does not span the full inlet/exhaust height",
    )

    separator_control_x = separator_x
    require(
        wall_plane_covers(triangles, 1, outer_y, (separator_control_x, separator_z)),
        "atmosphere: exterior wall is open across the intake/exhaust separator",
    )


def radial_z_range(
    vertices: set[tuple[float, float, float]],
    center: tuple[float, float],
    radius: float,
    tolerance: float = 0.04,
) -> tuple[float, float]:
    z_values = [
        vertex[2]
        for vertex in vertices
        if abs(math.hypot(vertex[0] - center[0], vertex[1] - center[1]) - radius) <= tolerance
    ]
    require(bool(z_values), f"No cylindrical surface found at {center} radius {radius}")
    return min(z_values), max(z_values)


def verify_direct_thread_geometry(profile: dict, fastener: dict, body_path: Path, lid_path: Path) -> None:
    body_height = profile["outer"][2] - profile["lid_thickness"]
    body_vertices = stl_vertices(body_path)
    body_triangles = stl_triangles(body_path)
    lid_vertices = stl_vertices(lid_path)
    pilot_radius = fastener["pilot_diameter_mm"] / 2.0
    boss_radius = fastener["boss_outer_diameter_mm"] / 2.0
    clearance_radius = fastener["clearance_diameter_mm"] / 2.0
    recess_radius = fastener["head_recess_diameter_mm"] / 2.0
    recess_floor = 0.8 + profile["lid_thickness"] - fastener["head_recess_depth_mm"]
    lid_top = 0.8 + profile["lid_thickness"]

    for center in screw_boss_centers(profile, fastener):
        entrance_sample_radius = pilot_radius * 0.55
        entrance_samples = [
            center,
            (center[0] - entrance_sample_radius, center[1]),
            (center[0] + entrance_sample_radius, center[1]),
            (center[0], center[1] - entrance_sample_radius),
            (center[0], center[1] + entrance_sample_radius),
        ]
        require(
            all(not wall_plane_covers(body_triangles, 2, body_height, sample) for sample in entrance_samples),
            f"{profile['id']}: screw pilot entrance is covered by top material at {center}",
        )
        annulus_sample_radius = (pilot_radius + boss_radius) / 2.0
        annulus_samples = [
            (center[0] - annulus_sample_radius, center[1]),
            (center[0] + annulus_sample_radius, center[1]),
            (center[0], center[1] - annulus_sample_radius),
            (center[0], center[1] + annulus_sample_radius),
        ]
        require(
            all(wall_plane_covers(body_triangles, 2, body_height, sample) for sample in annulus_samples),
            f"{profile['id']}: screw boss lacks a complete load-bearing top annulus at {center}",
        )

        pilot_min, pilot_max = radial_z_range(body_vertices, center, pilot_radius)
        require(pilot_min <= body_height - fastener["pilot_depth_mm"] + 0.08, f"{profile['id']}: blind pilot is too shallow at {center}")
        require(pilot_max >= body_height - 0.08, f"{profile['id']}: blind pilot does not open at the boss top")
        require(pilot_min > profile["bottom"] + 1.0, f"{profile['id']}: pilot hole is not blind")

        clearance_min, clearance_max = radial_z_range(lid_vertices, center, clearance_radius)
        require(clearance_min <= 0.85, f"{profile['id']}: lid clearance hole does not pass through")
        require(clearance_max >= recess_floor - 0.08, f"{profile['id']}: lid clearance bore is interrupted")
        recess_min, recess_max = radial_z_range(lid_vertices, center, recess_radius)
        require(recess_min <= recess_floor + 0.08, f"{profile['id']}: pan-head recess is too shallow")
        require(recess_max >= lid_top - 0.08, f"{profile['id']}: pan-head recess does not open at the lid top")


def verify_output(config_path: Path, output: Path) -> dict[str, dict[str, dict]]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    motherboard_config = json.loads(MOTHERBOARD_CONFIG.read_text(encoding="utf-8"))
    require(config["schema_version"] == 2, "Unsupported enclosure profile schema")
    require(config["units"] == "millimeters", "Profiles must use millimeters")
    fastener = config["fastener"]
    verify_fastener_spec(fastener)
    radio = config["xiao_radio"]
    verify_xiao_radio_spec(radio)
    mount = config["motherboard_mount"]
    verify_motherboard_mount_spec(mount)
    profiles = config["profiles"]
    require({profile["id"] for profile in profiles} == {"atmosphere", "presence", "climate"}, "Expected exactly the three fleet profiles")
    motherboard_boards = {board["id"]: board for board in motherboard_config["boards"]}
    require(set(motherboard_boards) == {profile["id"] for profile in profiles}, "Motherboard/enclosure fleet sets differ")

    manifest_path = output / "manifest.json"
    require(manifest_path.is_file(), "Missing generated manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest["config_sha256"] == sha256(config_path), "Generated files are stale relative to enclosure-profiles.json")
    require(manifest["motherboard_design_sha256"] == sha256(MOTHERBOARD_CONFIG), "Generated cases are stale relative to motherboard-designs.json")
    require(manifest["fastener"] == fastener, "Generated fastener contract differs from the dimension source")
    require(manifest["xiao_radio"] == radio, "Generated radio contract differs from the dimension source")
    require(manifest["motherboard_mount"] == mount, "Generated motherboard mount contract differs from the dimension source")
    require(set(manifest["profiles"]) == {profile["id"] for profile in profiles}, "Manifest profile set mismatch")

    blend_path = output / manifest["blend"]["file"]
    require(blend_path.is_file() and blend_path.stat().st_size > 100_000, "Missing or implausibly small Blender source")
    blend_header = blend_path.read_bytes()[:7]
    require(
        blend_header == b"BLENDER" or blend_header[:4] == b"\x28\xb5\x2f\xfd",
        "Generated .blend file is neither an uncompressed Blender file nor Blender's Zstandard container",
    )
    require(manifest["blend"]["sha256"] == sha256(blend_path), "Blender source hash mismatch")

    hero = manifest.get("linkedin_hero")
    require(isinstance(hero, dict), "Missing LinkedIn fleet render metadata")
    hero_path = output / hero["file"]
    require(hero_path.is_file() and hero_path.stat().st_size > 50_000, "Missing or implausibly small LinkedIn fleet render")
    require(png_size(hero_path) == (1600, 1000), "LinkedIn fleet render must be 1600×1000")
    require(hero["sha256"] == sha256(hero_path), "LinkedIn fleet render hash mismatch")

    results: dict[str, dict[str, dict]] = {}
    for profile in profiles:
        profile_id = profile["id"]
        verify_case_matches_motherboard_design(profile, motherboard_boards[profile_id], mount, radio)
        pms5003_airflow = verify_pms5003_airflow_spec(profile)
        antenna_keepout = verify_component_layout(profile, fastener, radio, mount)
        body_path = output / f"{profile_id}-body.stl"
        lid_path = output / f"{profile_id}-lid.stl"
        body_stats = parse_binary_stl(body_path)
        lid_stats = parse_binary_stl(lid_path)
        recorded = manifest["profiles"][profile_id]
        require(body_stats["sha256"] == recorded["body"]["sha256"], f"{profile_id}: body hash mismatch")
        require(lid_stats["sha256"] == recorded["lid"]["sha256"], f"{profile_id}: lid hash mismatch")
        require(body_stats["triangles"] == recorded["body"]["triangles"], f"{profile_id}: body triangle count mismatch")
        require(lid_stats["triangles"] == recorded["lid"]["triangles"], f"{profile_id}: lid triangle count mismatch")
        expected_body = [profile["outer"][0], profile["outer"][1], profile["outer"][2] - profile["lid_thickness"]]
        close_list(body_stats["bounds"]["size"], expected_body, 0.05, f"{profile_id} body size")
        require(abs(recorded["body_height_mm"] - expected_body[2]) <= 0.01, f"{profile_id}: manifest body height mismatch")
        expected_centers = [[round(value, 4) for value in center] for center in screw_boss_centers(profile, fastener)]
        require(recorded["screw_boss_centers_mm"] == expected_centers, f"{profile_id}: manifest screw boss positions mismatch")
        require(recorded["antenna_keepout_mm"] == antenna_keepout, f"{profile_id}: manifest antenna keep-out mismatch")
        require(recorded["motherboard_mount"] == expected_motherboard_mount(profile, mount), f"{profile_id}: manifest motherboard mount mismatch")
        require(recorded.get("pms5003_airflow") == pms5003_airflow, f"{profile_id}: manifest PMS5003 airflow contract mismatch")

        expected_lid_xy = profile["outer"][:2]
        close_list(lid_stats["bounds"]["size"][:2], expected_lid_xy, 0.05, f"{profile_id} lid footprint")
        require(
            profile["lid_thickness"] + 0.7 <= lid_stats["bounds"]["size"][2] <= profile["lid_thickness"] + 1.5,
            f"{profile_id}: lid Z envelope is outside the alignment-lip/label design range",
        )
        verify_direct_thread_geometry(profile, fastener, body_path, lid_path)
        verify_motherboard_post_geometry(profile, mount, body_path)
        verify_motherboard_rear_support_geometry(profile, mount, body_path)
        if pms5003_airflow:
            verify_pms5003_airflow_geometry(profile, pms5003_airflow, body_path)

        preview = output / f"{profile_id}-exploded.png"
        require(preview.is_file() and preview.stat().st_size > 20_000, f"{profile_id}: missing preview")
        require(png_size(preview) == (1000, 700), f"{profile_id}: preview must be 1000×700")
        results[profile_id] = {"body": body_stats, "lid": lid_stats}
    return results


def regenerate(blender: Path, config: Path, destination: Path) -> None:
    require(blender.is_file(), f"Blender executable not found: {blender}")
    command = [
        str(blender),
        "--background",
        "--python",
        str(GENERATOR),
        "--",
        "--config",
        str(config),
        "--output",
        str(destination),
        "--no-render",
    ]
    completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    require(completed.returncode == 0, f"Blender regeneration failed:\n{completed.stdout}\n{completed.stderr}")


def verify_repeatability(blender: Path, config: Path, checked_output: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="homebrain-enclosure-repeat-") as temp:
        root = Path(temp)
        first = root / "first"
        second = root / "second"
        regenerate(blender, config, first)
        regenerate(blender, config, second)
        for profile_id in ("atmosphere", "presence", "climate"):
            for part in ("body", "lid"):
                name = f"{profile_id}-{part}.stl"
                checked_hash = sha256(checked_output / name)
                first_hash = sha256(first / name)
                second_hash = sha256(second / name)
                require(first_hash == second_hash, f"{name}: consecutive runs differ")
                require(checked_hash == first_hash, f"{name}: checked-in output is stale")


def main() -> int:
    args = parse_args()
    config = args.config.resolve()
    output = args.output.resolve()
    results = verify_output(config, output)
    if args.repeat:
        verify_repeatability(args.blender.resolve(), config, output)
    triangle_total = sum(part["triangles"] for profile in results.values() for part in profile.values())
    repeat_note = "; deterministic two-run comparison passed" if args.repeat else ""
    print(f"PASS: 6 watertight STLs, 12 open-top/closed-bottom lid pilots, 12 recessed lid holes, 12 open-top/closed-bottom motherboard pilots, 6 tall motherboard USB-load walls, 3 onboard-antenna keep-outs, 9 open PMS5003 grille slots with printed anti-loop separator, {triangle_total:,} triangles, 3 previews, LinkedIn hero, valid Blender source{repeat_note}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(f"FAIL: {error}")
        raise SystemExit(1)
