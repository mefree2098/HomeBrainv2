# PlatformIO injects both Import and env into SCons extra scripts.
# ruff: noqa: E402, F821
Import("env")

import os
from datetime import datetime, timezone


def cpp_string_literal(value):
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'\\"{escaped}\\"'


def append_optional_string_define(name):
    value = os.environ.get(name)
    if value is None:
        return

    env.Append(
        CPPDEFINES=[
            (name, cpp_string_literal(value)),
        ]
    )


version = os.environ.get("HOMEBRAIN_PANEL_BUILD_VERSION")
if not version:
    version = "panel-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

env.Append(
    CPPDEFINES=[
        ("HOMEBRAIN_PANEL_FIRMWARE_VERSION", cpp_string_literal(version)),
    ]
)

for define_name in [
    "HOMEBRAIN_PANEL_WIFI_SSID",
    "HOMEBRAIN_PANEL_WIFI_PASSWORD",
    "HOMEBRAIN_PANEL_HUB_URL",
    "HOMEBRAIN_PANEL_ID",
    "HOMEBRAIN_PANEL_REGISTRATION_CODE",
    "HOMEBRAIN_PANEL_HOSTNAME",
]:
    append_optional_string_define(define_name)

print(f"HomeBrain panel firmware version: {version}")
