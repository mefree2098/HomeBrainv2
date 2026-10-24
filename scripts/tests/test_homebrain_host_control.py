import importlib.util
import json
import socket
import struct
import subprocess
import unittest
from unittest import mock
from pathlib import Path

spec = importlib.util.spec_from_file_location("host_control", Path(__file__).parents[1] / "homebrain-host-control.py")
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class Connection:
    def __init__(self, data, uid=1234):
        self.data, self.uid, self.response = data, uid, None

    def settimeout(self, value):
        self.timeout = value

    def getsockopt(self, *_):
        return struct.pack("3i", 9876, self.uid, 1234)

    def recv(self, limit):
        chunk, self.data = self.data[:limit], self.data[limit:]
        return chunk

    def sendall(self, data):
        self.response = json.loads(data)


class HostControlTests(unittest.TestCase):
    def setUp(self):
        if not hasattr(socket, "SO_PEERCRED"):
            # The installed service is Linux-only; exercise protocol fakes on macOS.
            patch = mock.patch.object(socket, "SO_PEERCRED", 17, create=True)
            patch.start()
            self.addCleanup(patch.stop)

    def test_probe_authenticates_without_executing_a_command(self):
        c = Connection(b'{"action":"probe"}\n')
        control.serve(c, allowed_uid=1234, runner=lambda *_a, **_k: self.fail("executed command"))
        self.assertTrue(c.response["ok"])

    def test_wrong_peer_uid_is_denied_before_read_or_execution(self):
        for uid in (0, 1000, 65534):
            c = Connection(b'{"action":"restart"}\n', uid=uid)
            control.serve(c, allowed_uid=1234, runner=lambda *_a, **_k: self.fail("executed command"))
            self.assertFalse(c.response["ok"])
            self.assertEqual(c.data, b'{"action":"restart"}\n')

    def test_only_fixed_unit_operations_can_be_executed(self):
        for action, expected in control.COMMANDS.items():
            calls = []
            def run(argv, **kwargs):
                calls.append((argv, kwargs))
                return subprocess.CompletedProcess(argv, 0, "", "")
            c = Connection((json.dumps({"action": action}) + "\n").encode())
            control.serve(c, allowed_uid=1234, runner=run)
            self.assertTrue(c.response["ok"])
            argv, options = calls[0]
            self.assertEqual(argv, ["/usr/bin/systemctl", "--no-ask-password", "--no-block", *expected])
            self.assertNotIn("shell", options)
            self.assertEqual(options["cwd"], "/")
            self.assertEqual(options["env"], control.SAFE_ENV)
            self.assertEqual(options["stdin"], subprocess.DEVNULL)

    def test_rejects_execution_paths_units_arguments_environment_and_reboots(self):
        for request in (
            {"action": "exec", "command": "/bin/sh"},
            {"action": "restart", "unit": "ssh.service"},
            {"action": "restart", "args": ["--root=/tmp"]},
            {"action": "restart", "env": {"PATH": "/tmp"}},
            {"action": "restart; sh"}, {"action": "../restart"},
            {"action": "reboot"}, {"action": "kernel-apply"},
            {"action": "install"}, {"action": ["restart"]}, {}, [], None,
        ):
            c = Connection((json.dumps(request) + "\n").encode())
            control.serve(c, allowed_uid=1234, runner=lambda *_a, **_k: self.fail("executed command"))
            self.assertFalse(c.response["ok"], request)

    def test_rejects_duplicate_fields_and_multiple_requests(self):
        for data in (b'{"action":"probe","action":"restart"}\n', b'{"action":"probe"}\n{}\n'):
            c = Connection(data)
            control.serve(c, allowed_uid=1234)
            self.assertFalse(c.response["ok"])

    def test_rejects_oversized_incomplete_and_invalid_input(self):
        for data in (b"x" * 257, b'{"action":"probe"}', b"\xff\n", b"not-json\n"):
            c = Connection(data)
            control.serve(c, allowed_uid=1234)
            self.assertFalse(c.response["ok"])

    def test_command_failure_is_returned_and_output_is_bounded(self):
        c = Connection(b'{"action":"restart"}\n')
        control.serve(c, allowed_uid=1234, runner=lambda *a, **k: subprocess.CompletedProcess(a, 1, "x" * 9000, "y" * 9000))
        self.assertFalse(c.response["ok"])
        self.assertEqual(len(c.response["stdout"]), 4096)
        self.assertEqual(len(c.response["stderr"]), 4096)

    def test_command_timeout_does_not_leak_internal_details(self):
        def timeout(*_a, **_k):
            raise subprocess.TimeoutExpired("private internal command", 15)
        c = Connection(b'{"action":"restart"}\n')
        control.serve(c, allowed_uid=1234, runner=timeout)
        self.assertEqual(c.response["stderr"], "Host service control failed")

    @unittest.skipUnless(hasattr(socket, "SO_PEERCRED"), "Linux peer credentials")
    def test_real_kernel_peer_credentials(self):
        import os
        import threading
        client, server = socket.socketpair()
        with client, server:
            worker = threading.Thread(target=control.serve, args=(server,), kwargs={"allowed_uid": os.getuid()})
            worker.start()
            client.sendall(b'{"action":"probe"}\n')
            self.assertTrue(json.loads(client.recv(4096))["ok"])
            worker.join(5)
            self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
