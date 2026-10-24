#!/usr/bin/python3
"""Socket-activated service control. Install root-owned; never execute app code."""

import json
import os
import pwd
import socket
import struct
import subprocess


MAX_REQUEST_BYTES = 256
SYSTEMCTL = "/usr/bin/systemctl"
# No paths, arguments, environment, unit names or executables come from clients.
COMMANDS = {
    "start": ("start", "homebrain.service"),
    "stop": ("stop", "homebrain.service"),
    "restart": ("restart", "homebrain.service"),
    "restore": ("start", "homebrain-restore-helper.service"),
    "ollama-start": ("start", "ollama.service"),
    "ollama-stop": ("stop", "ollama.service"),
    "otbr-start": ("start", "otbr-agent.service"),
    "otbr-stop": ("stop", "otbr-agent.service"),
}
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "HOME": "/"}


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("Duplicate request field")
        obj[key] = value
    return obj


def parse_request(data):
    if len(data) > MAX_REQUEST_BYTES:
        raise ValueError("Request too large")
    request = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(request, dict) or set(request) != {"action"}:
        raise ValueError("Expected exactly one action")
    action = request["action"]
    if not isinstance(action, str) or action not in {"probe", *COMMANDS}:
        raise ValueError("Host operation is not permitted")
    return action


def dispatch(action, runner=subprocess.run):
    if action == "probe":
        return {"ok": True, "stdout": "HomeBrain service control ready", "stderr": "", "code": 0}
    # Tuple lookup only: never invoke a shell, exec checkout code, reload units,
    # install packages, rebuild a kernel, or reboot from this interface.
    verb, unit = COMMANDS[action]
    result = runner(
        [SYSTEMCTL, "--no-ask-password", "--no-block", verb, unit],
        cwd="/", env=SAFE_ENV.copy(), stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=15, check=False,
    )
    return {"ok": result.returncode == 0, "stdout": result.stdout[:4096],
            "stderr": result.stderr[:4096], "code": result.returncode}


def serve(connection, allowed_uid=None, runner=subprocess.run):
    connection.settimeout(5)
    try:
        expected_uid = pwd.getpwnam("homebrain").pw_uid if allowed_uid is None else allowed_uid
        _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != expected_uid:
            raise PermissionError("Caller is not the HomeBrain runtime account")
        data = b""
        while b"\n" not in data:
            chunk = connection.recv(MAX_REQUEST_BYTES + 1 - len(data))
            if not chunk:
                raise ValueError("Incomplete request")
            data += chunk
            if len(data) > MAX_REQUEST_BYTES:
                raise ValueError("Request too large")
        line, trailing = data.split(b"\n", 1)
        if trailing:
            raise ValueError("Only one request is permitted")
        response = dispatch(parse_request(line), runner)
    except (ValueError, UnicodeError, PermissionError, KeyError, socket.timeout):
        response = {"ok": False, "code": 64, "stdout": "", "stderr": "Host operation denied"}
    except (OSError, subprocess.SubprocessError):
        response = {"ok": False, "code": 1, "stdout": "", "stderr": "Host service control failed"}
    connection.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise SystemExit("Run only through the installed socket service")
    with socket.socket(fileno=0) as client:
        serve(client)
