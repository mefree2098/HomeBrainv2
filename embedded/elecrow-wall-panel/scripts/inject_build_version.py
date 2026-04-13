Import("env")

import os
from datetime import datetime, timezone


version = os.environ.get("HOMEBRAIN_PANEL_BUILD_VERSION")
if not version:
    version = "panel-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

env.Append(
    CPPDEFINES=[
        ("HOMEBRAIN_PANEL_FIRMWARE_VERSION", '\\"%s\\"' % version),
    ]
)

print(f"HomeBrain panel firmware version: {version}")
