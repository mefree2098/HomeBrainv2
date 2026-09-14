#!/usr/bin/env python3
"""Generate the three HomeBrain sensor enclosures in Blender.

Run through Blender, not system Python:
  blender --background --python scripts/generate-homebrain-enclosures.py -- \
    --config hardware/homebrain-sensors/enclosures/enclosure-profiles.json \
    --output hardware/homebrain-sensors/enclosures/generated
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "hardware/homebrain-sensors/enclosures/enclosure-profiles.json"
DEFAULT_OUTPUT = ROOT / "hardware/homebrain-sensors/enclosures/generated"
MOTHERBOARD_CONFIG = ROOT / "hardware/homebrain-sensors/motherboards/motherboard-designs.json"


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--no-render", action="store_true")
    return parser.parse_args(argv)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "MILLIMETERS"
    scene.unit_settings.scale_length = 0.001


def material(name: str, color: tuple[float, float, float, float], roughness: float = 0.45) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.roughness = roughness
    return mat


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> None:
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def rounded_box(
    name: str,
    size: tuple[float, float, float] | list[float],
    location: tuple[float, float, float],
    radius: float = 0.0,
    mat: bpy.types.Material | None = None,
    rotation_z: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=(0.0, 0.0, math.radians(rotation_z)))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    activate(obj)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if radius > 0.0:
        bevel = obj.modifiers.new("printable_radius", "BEVEL")
        bevel.width = min(radius, min(size) * 0.45)
        bevel.segments = 4
        bevel.limit_method = "ANGLE"
        apply_modifier(obj, bevel)
    if mat:
        obj.data.materials.append(mat)
    return obj


def rounded_prism(
    name: str,
    size: tuple[float, float, float] | list[float],
    location: tuple[float, float, float],
    radius: float,
    mat: bpy.types.Material | None = None,
    segments: int = 8,
    bottom_chamfer: float = 0.0,
) -> bpy.types.Object:
    """Create a vertical rounded-rectangle prism with a flat, full-height rim."""
    width, depth, height = size

    def ring(ring_width: float, ring_depth: float, ring_radius: float, z: float) -> list[tuple[float, float, float]]:
        points: list[tuple[float, float, float]] = []
        corners = (
            (ring_width / 2.0 - ring_radius, ring_depth / 2.0 - ring_radius, 0.0),
            (-ring_width / 2.0 + ring_radius, ring_depth / 2.0 - ring_radius, 90.0),
            (-ring_width / 2.0 + ring_radius, -ring_depth / 2.0 + ring_radius, 180.0),
            (ring_width / 2.0 - ring_radius, -ring_depth / 2.0 + ring_radius, 270.0),
        )
        for cx, cy, start_angle in corners:
            for step in range(segments + 1):
                angle = math.radians(start_angle + 90.0 * step / segments)
                points.append((cx + ring_radius * math.cos(angle), cy + ring_radius * math.sin(angle), z))
        return points

    chamfer = min(bottom_chamfer, height * 0.2, radius * 0.45)
    rings: list[list[tuple[float, float, float]]] = []
    if chamfer > 0.0:
        rings.append(ring(width - 2.0 * chamfer, depth - 2.0 * chamfer, max(0.4, radius - chamfer), -height / 2.0))
        rings.append(ring(width, depth, radius, -height / 2.0 + chamfer))
    else:
        rings.append(ring(width, depth, radius, -height / 2.0))
    rings.append(ring(width, depth, radius, height / 2.0))

    vertices = [vertex for current_ring in rings for vertex in current_ring]
    ring_size = len(rings[0])
    faces: list[tuple[int, ...]] = [tuple(reversed(range(ring_size)))]
    for ring_index in range(len(rings) - 1):
        start = ring_index * ring_size
        next_start = (ring_index + 1) * ring_size
        for index in range(ring_size):
            following = (index + 1) % ring_size
            faces.append((start + index, start + following, next_start + following, next_start + index))
    top_start = (len(rings) - 1) * ring_size
    faces.append(tuple(top_start + index for index in range(ring_size)))

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.validate(verbose=False)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    if mat:
        obj.data.materials.append(mat)
    return obj


def cylinder(
    name: str,
    radius: float,
    depth: float,
    location: tuple[float, float, float],
    mat: bpy.types.Material | None = None,
    vertices: int = 48,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location)
    obj = bpy.context.object
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    return obj


def stepped_hole_cutter(
    name: str,
    center: tuple[float, float],
    small_radius: float,
    large_radius: float,
    bottom_z: float,
    recess_floor_z: float,
    top_z: float,
    vertices: int = 64,
) -> bpy.types.Object:
    """Create one manifold cutter for a through-hole plus flat head counterbore."""
    rings: list[list[tuple[float, float, float]]] = []
    for radius, z in (
        (small_radius, bottom_z),
        (small_radius, recess_floor_z),
        (large_radius, recess_floor_z),
        (large_radius, top_z),
    ):
        rings.append([
            (
                center[0] + radius * math.cos(2.0 * math.pi * (index + 0.5) / vertices),
                center[1] + radius * math.sin(2.0 * math.pi * (index + 0.5) / vertices),
                z,
            )
            for index in range(vertices)
        ])

    mesh_vertices = [vertex for ring in rings for vertex in ring]
    faces: list[tuple[int, ...]] = [tuple(reversed(range(vertices)))]
    for ring_index in range(len(rings) - 1):
        start = ring_index * vertices
        next_start = (ring_index + 1) * vertices
        for index in range(vertices):
            following = (index + 1) % vertices
            faces.append((start + index, start + following, next_start + following, next_start + index))
    top_start = (len(rings) - 1) * vertices
    faces.append(tuple(top_start + index for index in range(vertices)))

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(mesh_vertices, [], faces)
    mesh.validate(verbose=False)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def boolean_difference(base: bpy.types.Object, cutters: list[bpy.types.Object], label: str) -> None:
    for index, cutter in enumerate(cutters):
        modifier = base.modifiers.new(f"{label}_{index:02d}", "BOOLEAN")
        modifier.operation = "DIFFERENCE"
        modifier.solver = "EXACT"
        modifier.object = cutter
        apply_modifier(base, modifier)
        bpy.data.objects.remove(cutter, do_unlink=True)


def add_text_mesh(
    text: str,
    name: str,
    location: tuple[float, float, float],
    size: float,
    extrude: float,
    max_width: float,
    mat: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.object.text_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.data.body = text
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = size
    obj.data.extrude = extrude
    obj.data.bevel_depth = 0.06
    obj.data.bevel_resolution = 1
    obj.data.materials.append(mat)
    obj.rotation_euler.z = math.radians(180.0)
    bpy.context.view_layer.update()
    if obj.dimensions.x > max_width:
        scale = max_width / obj.dimensions.x
        obj.scale.x *= scale
        obj.scale.y *= scale
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.object


def add_circuit_mark(
    prefix: str,
    center: tuple[float, float],
    z: float,
    mat: bpy.types.Material,
) -> list[bpy.types.Object]:
    x, y = center
    parts: list[bpy.types.Object] = []
    for index, (dx, dy, radius) in enumerate(((-4.2, 0.0, 1.4), (0.0, 3.4, 1.15), (0.0, -3.4, 1.15), (4.2, 0.0, 1.4))):
        parts.append(cylinder(f"{prefix}_node_{index}", radius, 0.42, (x + dx, y + dy, z), mat, 32))
    for index, (sx, sy, length, angle) in enumerate(((-2.1, 1.7, 5.3, 39.0), (-2.1, -1.7, 5.3, -39.0), (2.1, 1.7, 5.3, -39.0), (2.1, -1.7, 5.3, 39.0))):
        parts.append(rounded_box(f"{prefix}_trace_{index}", (length, 0.72, 0.38), (x + sx, y + sy, z), 0.22, mat, angle))
    return parts


def fastener_centers(profile: dict, fastener: dict) -> list[tuple[float, float]]:
    width, depth, _height = profile["outer"]
    wall = profile["wall"]
    boss_radius = fastener["boss_outer_diameter_mm"] / 2.0
    edge_gap = fastener["boss_edge_gap_mm"]
    x = width / 2.0 - wall - boss_radius - edge_gap
    y = depth / 2.0 - wall - boss_radius - edge_gap
    return [(-x, -y), (-x, y), (x, -y), (x, y)]


def make_shell(profile: dict, fastener: dict, case_mat: bpy.types.Material) -> tuple[list[bpy.types.Object], dict]:
    profile_id = profile["id"]
    width, depth, total_height = profile["outer"]
    wall = profile["wall"]
    bottom = profile["bottom"]
    radius = profile["corner_radius"]
    body_height = total_height - profile["lid_thickness"]

    body = rounded_prism(
        f"{profile_id}_body",
        (width, depth, body_height),
        (0.0, 0.0, body_height / 2.0),
        radius,
        case_mat,
        bottom_chamfer=0.9,
    )
    cavity_height = body_height - bottom + 3.0
    cavity = rounded_prism(
        f"{profile_id}_cavity",
        (width - 2.0 * wall, depth - 2.0 * wall, cavity_height),
        (0.0, 0.0, bottom + cavity_height / 2.0),
        max(1.2, radius - wall),
    )

    usb_config = profile["usb_cutout"]
    usb_side = 1.0 if usb_config["side"] > 0 else -1.0
    usb = rounded_box(
        f"{profile_id}_usb_cutout",
        (wall * 4.0, usb_config["width"], usb_config["height"]),
        (usb_side * width / 2.0, usb_config["center_y"], usb_config["center_z"]),
        1.4,
    )
    cutters = [cavity, usb]

    for vent_index, vent in enumerate(profile.get("side_vents", [])):
        cx, cy, cz = vent["center"]
        count = vent["count"]
        spacing = vent["spacing"]
        slot_x, slot_y, slot_z = vent["slot"]
        for slot_index in range(count):
            offset = (slot_index - (count - 1) / 2.0) * spacing
            if vent["axis"] == "x":
                location = (cx, cy + offset, cz)
            else:
                location = (cx + offset, cy, cz)
            cutters.append(
                rounded_box(
                    f"{profile_id}_sidevent_{vent_index}_{slot_index}",
                    (slot_x, slot_y, slot_z),
                    location,
                    min(slot_x, slot_y, slot_z) * 0.42,
                )
            )

    boolean_difference(body, cutters, "shell_cut")
    body_objects: list[bpy.types.Object] = [body]

    inner_width = width - 2.0 * wall
    inner_depth = depth - 2.0 * wall
    boss_radius = fastener["boss_outer_diameter_mm"] / 2.0
    pilot_radius = fastener["pilot_diameter_mm"] / 2.0
    pilot_depth = fastener["pilot_depth_mm"]
    gusset_overlap = fastener["gusset_boss_overlap_mm"]
    gusset_inner_radius = boss_radius - gusset_overlap
    minimum_gusset_radius = pilot_radius + fastener["gusset_pilot_clearance_mm"]
    if gusset_inner_radius < minimum_gusset_radius:
        raise ValueError(
            f"{profile_id}: boss gusset would seal the pilot entrance "
            f"({gusset_inner_radius:.3f} mm radial clearance, {minimum_gusset_radius:.3f} mm required)"
        )
    boss_bottom = bottom - 0.4
    boss_depth = body_height - boss_bottom
    boss_centers = fastener_centers(profile, fastener)
    for index, (boss_x, boss_y) in enumerate(boss_centers):
        boss = cylinder(
            f"{profile_id}_direct_thread_boss_{index + 1}",
            boss_radius,
            boss_depth,
            (boss_x, boss_y, boss_bottom + boss_depth / 2.0),
            case_mat,
            64,
        )
        pilot = cylinder(
            f"{profile_id}_pilot_hole_{index + 1}",
            pilot_radius,
            pilot_depth + 0.4,
            (boss_x, boss_y, body_height - pilot_depth / 2.0 + 0.2),
            vertices=48,
        )
        boolean_difference(boss, [pilot], "blind_pilot")
        body_objects.append(boss)

        x_sign = 1.0 if boss_x > 0 else -1.0
        y_sign = 1.0 if boss_y > 0 else -1.0
        x_outer = x_sign * width / 2.0
        y_outer = y_sign * depth / 2.0
        # Meet only the wall-facing half of the boss. The former formula
        # crossed the boss center, so the overlapping gusset mesh refilled
        # the otherwise correct blind pilot at its top entrance.
        x_inner = boss_x + x_sign * gusset_inner_radius
        y_inner = boss_y + y_sign * gusset_inner_radius
        body_objects.append(
            rounded_box(
                f"{profile_id}_boss_x_gusset_{index + 1}",
                (abs(x_outer - x_inner), 2.4, 6.0),
                ((x_outer + x_inner) / 2.0, boss_y, body_height - 3.0),
                0.45,
                case_mat,
            )
        )
        body_objects.append(
            rounded_box(
                f"{profile_id}_boss_y_gusset_{index + 1}",
                (2.4, abs(y_outer - y_inner), 6.0),
                (boss_x, (y_outer + y_inner) / 2.0, body_height - 3.0),
                0.45,
                case_mat,
            )
        )

    return body_objects, {
        "inner": [inner_width, inner_depth, body_height - bottom],
        "body_height": body_height,
        "boss_centers": [[round(x, 4), round(y, 4)] for x, y in boss_centers],
    }


def pms5003_airflow_geometry(profile: dict, component: dict) -> dict:
    """Resolve the PMS5003 port plane, dedicated vents, and printed anti-loop shroud."""
    airflow = component.get("airflow")
    if not airflow:
        raise ValueError(f"{profile['id']}: {component['name']} is missing its airflow contract")
    if airflow["port_face_axis"] != "y" or int(component.get("rotation", 0.0)) % 180 != 0:
        raise ValueError(f"{profile['id']}: PMS5003 airflow geometry currently requires an unrotated Y-facing port plane")

    side = 1.0 if airflow["port_face_side"] > 0 else -1.0
    x, y = component["center"]
    width, depth, height = component["size"]
    case_depth = profile["outer"][1]
    inner_wall_plane = side * (case_depth / 2.0 - profile["wall"])
    port_plane = y + side * depth / 2.0
    wall_gap = abs(port_plane - inner_wall_plane)
    base_height = airflow["mount_base_height_mm"]
    component_bottom = profile["bottom"] + base_height
    component_top = component_bottom + height
    component_center_z = (component_bottom + component_top) / 2.0
    port_width, port_height = airflow["port_face_size_mm"]
    clearance = airflow["separator_sensor_clearance_mm"]
    shroud_end_plane = port_plane + side * clearance
    channel_depth = abs(shroud_end_plane - inner_wall_plane)
    channel_center_y = (inner_wall_plane + shroud_end_plane) / 2.0
    separator_x = x + airflow["separator_offset_mm"]
    separator_thickness = airflow["separator_thickness_mm"]
    rib = airflow["shroud_rib_thickness_mm"]

    vents = {vent.get("id"): vent for vent in profile.get("side_vents", []) if vent.get("id")}

    def vent_contract(vent_id: str) -> dict:
        vent = vents.get(vent_id)
        if not vent:
            raise ValueError(f"{profile['id']}: missing dedicated side vent {vent_id}")
        cx, _cy, cz = vent["center"]
        span_x = (vent["count"] - 1) * vent["spacing"] + vent["slot"][0]
        return {
            "vent_id": vent_id,
            "count": vent["count"],
            "nominal_free_area_mm2": round(vent["count"] * vent["slot"][0] * vent["slot"][2], 4),
            "bounds_xz_mm": [
                [round(cx - span_x / 2.0, 4), round(cz - vent["slot"][2] / 2.0, 4)],
                [round(cx + span_x / 2.0, 4), round(cz + vent["slot"][2] / 2.0, 4)],
            ],
        }

    return {
        "component": component["name"],
        "installation": "small inlet holes and round fan opening face the dedicated exterior grille",
        "port_face": {
            "axis": "y",
            "side": int(side),
            "plane_mm": round(port_plane, 4),
            "host_inner_wall_plane_mm": round(inner_wall_plane, 4),
            "wall_gap_mm": round(wall_gap, 4),
            "bounds_xz_mm": [
                [round(x - port_width / 2.0, 4), round(component_center_z - port_height / 2.0, 4)],
                [round(x + port_width / 2.0, 4), round(component_center_z + port_height / 2.0, 4)],
            ],
        },
        "intake": vent_contract(airflow["intake_vent_id"]),
        "exhaust": vent_contract(airflow["exhaust_vent_id"]),
        "fan_opening_diameter_mm": airflow["fan_opening_diameter_mm"],
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


def add_pms5003_airflow_shroud(
    profile: dict,
    component: dict,
    case_mat: bpy.types.Material,
) -> tuple[list[bpy.types.Object], dict]:
    """Add a short perimeter plenum and divider that prevent inlet/exhaust recirculation."""
    info = pms5003_airflow_geometry(profile, component)
    airflow = component["airflow"]
    x, _y = component["center"]
    width, _depth, height = component["size"]
    base_height = airflow["mount_base_height_mm"]
    component_bottom = profile["bottom"] + base_height
    component_top = component_bottom + height
    component_center_z = (component_bottom + component_top) / 2.0
    separator_x, channel_y, _separator_z = info["separator"]["center_mm"]
    separator_width, channel_depth, _separator_height = info["separator"]["size_mm"]
    rib = airflow["shroud_rib_thickness_mm"]
    name = component["name"].replace(" ", "_").replace("-", "_")

    parts = [
        rounded_box(
            f"{profile['id']}_{name}_airflow_separator",
            (separator_width, channel_depth, height),
            (separator_x, channel_y, component_center_z),
            min(0.32, separator_width * 0.2),
            case_mat,
        )
    ]
    for side, label in ((-1.0, "left"), (1.0, "right")):
        parts.append(
            rounded_box(
                f"{profile['id']}_{name}_airflow_shroud_{label}",
                (rib, channel_depth, height + rib),
                (x + side * (width / 2.0 + rib / 2.0), channel_y, component_center_z),
                0.25,
                case_mat,
            )
        )
    for side, label in ((-1.0, "bottom"), (1.0, "top")):
        z = component_center_z + side * (height / 2.0 + rib / 2.0)
        parts.append(
            rounded_box(
                f"{profile['id']}_{name}_airflow_shroud_{label}",
                (width + 2.0 * rib, channel_depth, rib),
                (x, channel_y, z),
                0.25,
                case_mat,
            )
        )
    return parts, info


def add_component_cradle(
    profile_id: str,
    component: dict,
    bottom: float,
    motherboard_mount: dict,
    case_mat: bpy.types.Material,
    proxy_mat: bpy.types.Material,
) -> tuple[list[bpy.types.Object], bpy.types.Object, dict | None]:
    name = component["name"].replace(" ", "_").replace("-", "_")
    x, y = component["center"]
    sx, sy, sz = component["size"]
    rotation = component.get("rotation", 0.0)
    if int(rotation) % 180 == 90:
        sx, sy = sy, sx
    kind = component["kind"]
    airflow = component.get("airflow")
    clearance = 0.6 if kind != "battery" else 0.9
    rail_height = 2.2 if kind not in ("large", "battery") else 3.0
    rail_width = 1.2 if kind != "large" else 1.5
    parts: list[bpy.types.Object] = []
    mount_info: dict | None = None

    if kind == "motherboard":
        post_top = motherboard_mount["post_top_z_mm"]
        post_radius = motherboard_mount["post_outer_diameter_mm"] / 2.0
        pilot_radius = motherboard_mount["pilot_diameter_mm"] / 2.0
        pilot_depth = motherboard_mount["pilot_depth_mm"]
        post_bottom = bottom - 0.2
        post_depth = post_top - post_bottom
        post_centers: list[list[float]] = []
        for index, (post_x, post_y) in enumerate(component["mounting_holes"], 1):
            post = cylinder(
                f"{profile_id}_{name}_mount_post_{index}",
                post_radius,
                post_depth,
                (post_x, post_y, post_bottom + post_depth / 2.0),
                case_mat,
                64,
            )
            pilot = cylinder(
                f"{profile_id}_{name}_mount_pilot_{index}",
                pilot_radius,
                pilot_depth + 0.4,
                (post_x, post_y, post_top - pilot_depth / 2.0 + 0.2),
                vertices=48,
            )
            boolean_difference(post, [pilot], "open_blind_motherboard_pilot")
            parts.append(post)
            post_centers.append([round(post_x, 4), round(post_y, 4), round(post_top, 4)])

        open_side = int(component["open_side"])
        rear_direction = -open_side
        rear_x = x + rear_direction * (sx / 2.0 + motherboard_mount["rear_wall_depth_mm"] / 2.0)
        center_offset = motherboard_mount["rear_wall_center_gap_mm"] / 2.0 + motherboard_mount["rear_wall_width_mm"] / 2.0
        rear_centers: list[list[float]] = []
        for side, label in ((-1.0, "lower"), (1.0, "upper")):
            center = (rear_x, y + side * center_offset, bottom + motherboard_mount["rear_wall_height_mm"] / 2.0)
            parts.append(
                rounded_box(
                    f"{profile_id}_{name}_tall_rear_usb_wall_{label}",
                    (motherboard_mount["rear_wall_depth_mm"], motherboard_mount["rear_wall_width_mm"], motherboard_mount["rear_wall_height_mm"]),
                    center,
                    0.42,
                    case_mat,
                )
            )
            rear_centers.append([round(value, 4) for value in center])

        proxy = rounded_box(
            f"{profile_id}_proxy_{name}",
            (sx, sy, sz),
            (x, y, post_top + sz / 2.0),
            0.5,
            proxy_mat,
        )
        mounting_hole_cutters = [
            cylinder(
                f"{profile_id}_{name}_reference_mount_hole_{index}",
                1.7,
                sz + 1.0,
                (post_x, post_y, post_top + sz / 2.0),
                vertices=48,
            )
            for index, (post_x, post_y) in enumerate(component["mounting_holes"], 1)
        ]
        boolean_difference(proxy, mounting_hole_cutters, "reference_motherboard_holes")
        proxy["component_name"] = component["name"]
        proxy["reference_only"] = True
        proxy["source_board_size_mm"] = component["source_board_size"]
        proxy["source_rotation_degrees"] = component["source_rotation_degrees"]
        mount_info = {
            "retention": motherboard_mount["retention"],
            "post_centers_mm": post_centers,
            "post_outer_diameter_mm": motherboard_mount["post_outer_diameter_mm"],
            "pilot_diameter_mm": motherboard_mount["pilot_diameter_mm"],
            "pilot_depth_mm": pilot_depth,
            "board_bottom_z_mm": post_top,
            "rear_wall_centers_mm": rear_centers,
            "rear_wall_size_mm": [motherboard_mount["rear_wall_depth_mm"], motherboard_mount["rear_wall_width_mm"], motherboard_mount["rear_wall_height_mm"]],
            "usb_open_side": open_side,
        }
        proxy["retention"] = mount_info["retention"]
        return parts, proxy, mount_info

    if kind == "soldered":
        proxy = rounded_box(
            f"{profile_id}_proxy_{name}",
            (sx, sy, sz),
            (x, y, component["bottom_z"] + sz / 2.0),
            min(1.0, sz * 0.15),
            proxy_mat,
        )
        proxy["component_name"] = component["name"]
        proxy["reference_only"] = True
        proxy["retention"] = "factory male header soldered through dedicated motherboard" if component.get("factory_headered") else "soldered directly to dedicated motherboard"
        proxy["source_motherboard_ref"] = component["source_ref"]
        if component.get("radar_face"):
            proxy["radar_face"] = component["radar_face"]
        return parts, proxy, None

    if airflow:
        base_height = airflow["mount_base_height_mm"]
        parts.append(
            rounded_box(
                f"{profile_id}_{name}_tape_base",
                (sx - 8.0, sy - 8.0, base_height),
                (x, y, bottom + base_height / 2.0),
                0.55,
                case_mat,
            )
        )

    for side in (-1.0, 1.0):
        if airflow and airflow["port_face_axis"] == "y" and int(side) == int(airflow["port_face_side"]):
            continue
        parts.append(
            rounded_box(
                f"{profile_id}_{name}_rail_y_{int(side)}",
                (sx + 2.0 * clearance, rail_width, rail_height),
                (x, y + side * (sy / 2.0 + clearance), bottom + rail_height / 2.0),
                0.28,
                case_mat,
            )
        )

    for side in (-1.0, 1.0):
        parts.append(
            rounded_box(
                f"{profile_id}_{name}_endstop_{int(side)}",
                (rail_width, sy + 2.0 * clearance, rail_height),
                (x + side * (sx / 2.0 + clearance), y, bottom + rail_height / 2.0),
                0.28,
                case_mat,
            )
        )

    proxy_floor = bottom + (airflow["mount_base_height_mm"] if airflow else rail_height)
    proxy = rounded_box(
        f"{profile_id}_proxy_{name}",
        (sx, sy, sz),
        (x, y, proxy_floor + sz / 2.0),
        min(1.2, sz * 0.2),
        proxy_mat,
    )
    proxy.display_type = "SOLID"
    proxy["component_name"] = component["name"]
    proxy["reference_only"] = True
    if airflow:
        proxy["airflow_port_face"] = f"{airflow['port_face_axis']}{airflow['port_face_side']:+d}"
        proxy["airflow_installation"] = "Point the small inlet holes and round fan opening toward the exterior shroud."
    return parts, proxy, mount_info


def xiao_antenna_keepout(profile: dict, radio: dict) -> dict:
    """Describe the plastic/air corridor extending from the onboard antenna end."""
    xiao = next(component for component in profile["components"] if component["kind"] == "motherboard")
    offset_x, offset_y = xiao.get("radio_board_center_offset", [0.0, 0.0])
    x, y = xiao["center"][0] + offset_x, xiao["center"][1] + offset_y
    width, depth = xiao.get("radio_board_size", xiao["size"][:2])
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


def make_lid(
    profile: dict,
    fastener: dict,
    case_mat: bpy.types.Material,
    accent_mat: bpy.types.Material,
    fastener_mat: bpy.types.Material,
) -> tuple[list[bpy.types.Object], list[bpy.types.Object], dict]:
    profile_id = profile["id"]
    width, depth, _height = profile["outer"]
    wall = profile["wall"]
    thickness = profile["lid_thickness"]
    inner_width = width - 2.0 * wall
    inner_depth = depth - 2.0 * wall
    lip_height = 0.8
    plate_center_z = lip_height + thickness / 2.0

    plate = rounded_box(
        f"{profile_id}_lid",
        (width, depth, thickness),
        (0.0, 0.0, plate_center_z),
        min(3.5, profile["corner_radius"]),
        case_mat,
    )
    lid_objects: list[bpy.types.Object] = [plate]
    for side in (-1.0, 1.0):
        lid_objects.append(
            rounded_box(
                f"{profile_id}_lid_alignment_y_{int(side)}",
                (inner_width - 18.0, 1.2, lip_height),
                (0.0, side * (inner_depth / 2.0 - 0.75), lip_height / 2.0),
                0.22,
                case_mat,
            )
        )
        lid_objects.append(
            rounded_box(
                f"{profile_id}_lid_alignment_x_{int(side)}",
                (1.2, inner_depth - 18.0, lip_height),
                (side * (inner_width / 2.0 - 0.75), 0.0, lip_height / 2.0),
                0.22,
                case_mat,
            )
        )

    cutters: list[bpy.types.Object] = []
    features = profile.get("lid_features", {})
    for field_index, field in enumerate(features.get("vent_fields", [])):
        cx, cy = field["center"]
        rows, columns = field["rows"], field["columns"]
        slot_x, slot_y = field["slot"]
        spacing_x, spacing_y = field["spacing"]
        for row in range(rows):
            for column in range(columns):
                x = cx + (column - (columns - 1) / 2.0) * spacing_x
                y = cy + (row - (rows - 1) / 2.0) * spacing_y
                cutters.append(
                    rounded_box(
                        f"{profile_id}_lidvent_{field_index}_{row}_{column}",
                        (slot_x, slot_y, thickness + 3.0),
                        (x, y, plate_center_z),
                        slot_y * 0.48,
                        rotation_z=field.get("angle", 0.0),
                    )
                )

    if "light_aperture" in features:
        x, y, aperture = features["light_aperture"]
        cutters.append(cylinder(f"{profile_id}_lux_aperture", aperture / 2.0, thickness + 3.0, (x, y, plate_center_z)))
    if "status_aperture" in features:
        x, y, aperture = features["status_aperture"]
        cutters.append(cylinder(f"{profile_id}_status_aperture", aperture / 2.0, thickness + 3.0, (x, y, plate_center_z)))
    if "radar_window" in features:
        radar = features["radar_window"]
        remaining = radar["remaining_thickness"]
        pocket_depth = thickness - remaining
        cutters.append(
            rounded_box(
                f"{profile_id}_radar_window_recess",
                (radar["size"][0], radar["size"][1], pocket_depth + 0.2),
                (radar["center"][0], radar["center"][1], lip_height + pocket_depth / 2.0 - 0.1),
                2.5,
            )
        )

    boss_centers = fastener_centers(profile, fastener)
    for index, (screw_x, screw_y) in enumerate(boss_centers):
        recess_depth = fastener["head_recess_depth_mm"]
        cutters.append(
            stepped_hole_cutter(
                f"{profile_id}_screw_hole_{index + 1}",
                (screw_x, screw_y),
                fastener["clearance_diameter_mm"] / 2.0,
                fastener["head_recess_diameter_mm"] / 2.0,
                -0.5,
                lip_height + thickness - recess_depth,
                lip_height + thickness + 0.5,
            )
        )
    boolean_difference(plate, cutters, "lid_cut")

    label_z = lip_height + thickness - 0.06
    label_x = -width * 0.08
    decor_proxies = [
        add_text_mesh(
            profile["title"],
            f"{profile_id}_lid_label",
            (label_x, -depth * 0.31, label_z),
            4.0 if width > 90.0 else 3.2,
            0.34,
            width * 0.58,
            accent_mat,
        )
    ]
    decor_proxies.extend(add_circuit_mark(profile_id, (label_x, depth * 0.31), label_z + 0.2, accent_mat))
    for proxy in decor_proxies:
        proxy["reference_only"] = True
        proxy["finish_guide"] = "Optional paint, vinyl, or slicer color-change decoration; excluded from STL for flat printing."

    screw_proxies: list[bpy.types.Object] = list(decor_proxies)
    screw_length = fastener["screw_length_mm"]
    for index, (screw_x, screw_y) in enumerate(boss_centers):
        shaft = cylinder(
            f"{profile_id}_reference_screw_shaft_{index + 1}",
            1.42,
            screw_length,
            (screw_x, screw_y, lip_height + thickness - screw_length / 2.0 + 1.0),
            fastener_mat,
            32,
        )
        head = cylinder(
            f"{profile_id}_reference_screw_head_{index + 1}",
            2.9,
            1.6,
            (screw_x, screw_y, lip_height + thickness + 0.8),
            fastener_mat,
            48,
        )
        for proxy in (shaft, head):
            proxy["reference_only"] = True
            proxy["fastener"] = fastener["description"]
            screw_proxies.append(proxy)

    return lid_objects, screw_proxies, {
        "dimensions": [width, depth, lip_height + thickness],
        "center_x": 0.0,
        "boss_centers": [[round(x, 4), round(y, 4)] for x, y in boss_centers],
    }


def object_bounds(objects: list[bpy.types.Object]) -> tuple[list[float], list[float]]:
    points: list[Vector] = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    minimum = [min(point[index] for point in points) for index in range(3)]
    maximum = [max(point[index] for point in points) for index in range(3)]
    return minimum, maximum


def export_stl(path: Path, objects: list[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.wm.stl_export(
        filepath=str(path),
        check_existing=False,
        ascii_format=False,
        export_selected_objects=True,
        apply_modifiers=True,
        global_scale=1.0,
        use_scene_unit=False,
        forward_axis="Y",
        up_axis="Z",
    )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def binary_stl_stats(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 84:
        raise ValueError(f"STL too short: {path}")
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    if len(data) != 84 + triangle_count * 50:
        raise ValueError(f"Expected binary STL: {path}")
    minimum = [float("inf")] * 3
    maximum = [float("-inf")] * 3
    for triangle in range(triangle_count):
        offset = 84 + triangle * 50 + 12
        values = struct.unpack_from("<9f", data, offset)
        for vertex in range(3):
            for axis in range(3):
                value = values[vertex * 3 + axis]
                minimum[axis] = min(minimum[axis], value)
                maximum[axis] = max(maximum[axis], value)
    return {
        "sha256": file_sha256(path),
        "bytes": len(data),
        "triangles": triangle_count,
        "bounds": {
            "min": [round(value, 4) for value in minimum],
            "max": [round(value, 4) for value in maximum],
            "size": [round(maximum[index] - minimum[index], 4) for index in range(3)],
        },
    }


def parent_objects(name: str, objects: list[bpy.types.Object], origin: tuple[float, float, float] = (0.0, 0.0, 0.0)) -> bpy.types.Object:
    parent = bpy.data.objects.new(name, None)
    parent.empty_display_type = "PLAIN_AXES"
    parent.location = origin
    bpy.context.collection.objects.link(parent)
    for obj in objects:
        world = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = world
    return parent


def look_at(camera: bpy.types.Object, target: tuple[float, float, float]) -> None:
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()


def setup_render_scene() -> tuple[bpy.types.Object, bpy.types.Object]:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.studio_light = "paint.sl"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "BOTH"
    scene.display.shading.curvature_ridge_factor = 1.6
    scene.display.shading.curvature_valley_factor = 1.2
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.color = (0.025, 0.035, 0.055)

    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = "Preview_Camera"
    camera.data.type = "ORTHO"
    scene.camera = camera

    ground = rounded_box("Preview_Ground", (500.0, 340.0, 1.0), (0.0, 0.0, -1.0), 4.0, material("Ground", (0.045, 0.06, 0.085, 1.0), 0.8))
    ground.hide_render = False
    return camera, ground


def render_profile(
    output: Path,
    profile: dict,
    roots: dict[str, bpy.types.Object],
    all_profile_roots: list[bpy.types.Object],
    camera: bpy.types.Object,
) -> None:
    width, depth, height = profile["outer"]
    for root in all_profile_roots:
        hidden = root not in roots.values()
        for obj in [root, *list(root.children_recursive)]:
            obj.hide_render = hidden
            obj.hide_set(hidden)

    body_root = roots["body"]
    lid_root = roots["lid"]
    body_root.location = (0.0, 0.0, 0.0)
    lid_root.location = (width * 1.18, 0.0, height * 0.58)
    lid_root.rotation_euler[1] = math.radians(-12.0)

    camera.location = (width * 1.68, -depth * 1.72, height * 3.0)
    camera.data.ortho_scale = max(width * 1.76, depth * 2.5)
    look_at(camera, (width * 0.55, 0.0, height * 0.52))
    bpy.context.scene.render.filepath = str(output / f"{profile['id']}-exploded.png")
    bpy.ops.render.render(write_still=True)

    lid_root.location = (0.0, 0.0, 0.0)
    lid_root.rotation_euler = (0.0, 0.0, 0.0)


def render_linkedin_hero(
    output: Path,
    profiles: list[dict],
    generated: dict[str, dict],
    camera: bpy.types.Object,
) -> Path:
    """Render one accurate fleet image with a clear air gap around every lid."""
    x_positions = (-130.0, 0.0, 130.0)
    for profile, x in zip(profiles, x_positions):
        roots = generated[profile["id"]]["roots"]
        for root in roots.values():
            for obj in [root, *list(root.children_recursive)]:
                obj.hide_render = False
                obj.hide_set(False)
        roots["body"].location = (x, 30.0, 0.0)
        roots["body"].rotation_euler = (0.0, 0.0, 0.0)
        roots["lid"].location = (x, -92.0, 12.0)
        # Turn the detached lid toward the viewer so its engraved device label
        # reads naturally in the fleet presentation.
        roots["lid"].rotation_euler = (0.0, 0.0, math.radians(180.0))

    scene = bpy.context.scene
    original_resolution = (scene.render.resolution_x, scene.render.resolution_y)
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1000
    camera.location = (0.0, -540.0, 340.0)
    camera.data.ortho_scale = 410.0
    look_at(camera, (0.0, -28.0, 18.0))
    path = output / "homebrain-sensor-fleet-linkedin.png"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    scene.render.resolution_x, scene.render.resolution_y = original_resolution
    return path


def arrange_master(profiles: list[dict], generated: dict[str, dict], all_profile_roots: list[bpy.types.Object]) -> None:
    total = sum(profile["outer"][0] + 30.0 for profile in profiles)
    cursor = -total / 2.0
    for profile in profiles:
        roots = generated[profile["id"]]["roots"]
        width, _depth, height = profile["outer"]
        x = cursor + width / 2.0
        roots["body"].location = (x, 0.0, 0.0)
        roots["lid"].location = (x + width * 0.45, 0.0, height * 0.82)
        roots["lid"].rotation_euler[1] = math.radians(-10.0)
        cursor += width + 30.0
        for root in roots.values():
            for obj in [root, *list(root.children_recursive)]:
                obj.hide_render = False
                obj.hide_set(False)


def main() -> int:
    args = parse_args()
    config_path = args.config.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    profiles = config["profiles"]
    fastener = config["fastener"]
    radio = config["xiao_radio"]
    motherboard_mount = config["motherboard_mount"]
    reset_scene()

    case_mat = material("HomeBrain_Navy", (0.035, 0.09, 0.15, 1.0), 0.4)
    proxy_mat = material("Reference_Components", (0.28, 0.78, 0.68, 1.0), 0.5)
    motherboard_mat = material("Reference_Motherboards", (0.035, 0.31, 0.20, 1.0), 0.38)
    fastener_mat = material("Reference_Fasteners", (0.58, 0.62, 0.67, 1.0), 0.22)
    generated: dict[str, dict] = {}
    all_profile_roots: list[bpy.types.Object] = []

    for profile in profiles:
        profile_id = profile["id"]
        antenna_keepout = xiao_antenna_keepout(profile, radio)
        accent_mat = material(f"Accent_{profile_id}", tuple(profile["accent"]), 0.32)
        body_objects, shell_info = make_shell(profile, fastener, case_mat)
        proxy_objects: list[bpy.types.Object] = []
        motherboard_mount_info = None
        pms5003_airflow_info = None
        for component in profile["components"]:
            cradle, proxy, component_mount_info = add_component_cradle(
                profile_id,
                component,
                profile["bottom"],
                motherboard_mount,
                case_mat,
                motherboard_mat if component["kind"] == "motherboard" else proxy_mat,
            )
            body_objects.extend(cradle)
            proxy_objects.append(proxy)
            if component.get("airflow"):
                airflow_parts, pms5003_airflow_info = add_pms5003_airflow_shroud(profile, component, case_mat)
                body_objects.extend(airflow_parts)
                proxy["airflow_contract"] = json.dumps(pms5003_airflow_info, sort_keys=True)
            if component["kind"] == "motherboard":
                motherboard_mount_info = component_mount_info
                proxy["antenna_mode"] = radio["antenna_mode"]
                proxy["antenna_end"] = radio["antenna_end"]
                proxy["rf_keepout_min_mm"] = antenna_keepout["bounds"][0]
                proxy["rf_keepout_max_mm"] = antenna_keepout["bounds"][1]
                screw_length = fastener["screw_length_mm"]
                board_top = motherboard_mount["post_top_z_mm"] + motherboard_mount["board_thickness_mm"]
                for index, (screw_x, screw_y) in enumerate(component["mounting_holes"], 1):
                    shaft = cylinder(
                        f"{profile_id}_reference_motherboard_screw_shaft_{index}",
                        1.42,
                        screw_length,
                        (screw_x, screw_y, board_top - screw_length / 2.0),
                        fastener_mat,
                        32,
                    )
                    head = cylinder(
                        f"{profile_id}_reference_motherboard_screw_head_{index}",
                        2.9,
                        1.6,
                        (screw_x, screw_y, board_top + 0.8),
                        fastener_mat,
                        48,
                    )
                    for screw_proxy in (shaft, head):
                        screw_proxy["reference_only"] = True
                        screw_proxy["fastener"] = fastener["description"]
                        screw_proxy["purpose"] = "motherboard retention into printed plastic post"
                        proxy_objects.append(screw_proxy)
        lid_objects, screw_proxies, lid_info = make_lid(profile, fastener, case_mat, accent_mat, fastener_mat)

        body_path = output / f"{profile_id}-body.stl"
        lid_path = output / f"{profile_id}-lid.stl"
        export_stl(body_path, body_objects)
        export_stl(lid_path, lid_objects)

        body_root = parent_objects(f"{profile_id.upper()}_BODY_ASSEMBLY", body_objects + proxy_objects)
        lid_root = parent_objects(
            f"{profile_id.upper()}_LID_ASSEMBLY",
            lid_objects + screw_proxies,
            (lid_info["center_x"], 0.0, 0.0),
        )
        all_profile_roots.extend((body_root, lid_root))
        generated[profile_id] = {
            "profile": profile,
            "roots": {"body": body_root, "lid": lid_root},
            "files": {"body": body_path, "lid": lid_path},
            "shell": shell_info,
            "lid": lid_info,
            "antenna_keepout": antenna_keepout,
            "motherboard_mount": motherboard_mount_info,
            "pms5003_airflow": pms5003_airflow_info,
        }

    camera, _ground = setup_render_scene()
    linkedin_hero = None
    if not args.no_render:
        for profile in profiles:
            render_profile(output, profile, generated[profile["id"]]["roots"], all_profile_roots, camera)
        linkedin_hero = render_linkedin_hero(output, profiles, generated, camera)

    arrange_master(profiles, generated, all_profile_roots)
    blend_path = output / "homebrain-sensor-enclosures.blend"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), check_existing=False, compress=True)

    manifest = {
        "schema_version": 2,
        "generator": "scripts/generate-homebrain-enclosures.py",
        "blender_version": bpy.app.version_string,
        "config_sha256": file_sha256(config_path),
        "motherboard_design_sha256": file_sha256(MOTHERBOARD_CONFIG),
        "units": config["units"],
        "fastener": fastener,
        "xiao_radio": radio,
        "motherboard_mount": motherboard_mount,
        "linkedin_hero": {
            "file": linkedin_hero.name,
            "sha256": file_sha256(linkedin_hero),
            "bytes": linkedin_hero.stat().st_size,
            "pixels": [1600, 1000],
        } if linkedin_hero else None,
        "profiles": {},
    }
    for profile in profiles:
        profile_id = profile["id"]
        item = generated[profile_id]
        manifest["profiles"][profile_id] = {
            "outer_mm": profile["outer"],
            "inner_mm": item["shell"]["inner"],
            "body_height_mm": item["shell"]["body_height"],
            "screw_boss_centers_mm": item["shell"]["boss_centers"],
            "antenna_keepout_mm": item["antenna_keepout"],
            "motherboard_mount": item["motherboard_mount"],
            "pms5003_airflow": item["pms5003_airflow"],
            "body": binary_stl_stats(item["files"]["body"]),
            "lid": binary_stl_stats(item["files"]["lid"]),
            "preview": f"{profile_id}-exploded.png" if not args.no_render else None,
        }
    manifest["blend"] = {
        "file": blend_path.name,
        "sha256": file_sha256(blend_path),
        "bytes": blend_path.stat().st_size,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Generated {len(profiles)} HomeBrain enclosures in {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
