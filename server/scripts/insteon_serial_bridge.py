#!/usr/bin/env python3
"""
Minimal local serial <-> TCP bridge for INSTEON PLM fallback.
Uses only Python stdlib so HomeBrain can bridge without node-serialport.
"""

import argparse
import fcntl
import os
import selectors
import signal
import socket
import sys
import termios


BAUD_MAP = {
    1200: termios.B1200,
    2400: termios.B2400,
    4800: termios.B4800,
    9600: termios.B9600,
    19200: termios.B19200,
    38400: termios.B38400,
    57600: termios.B57600,
    115200: termios.B115200,
}


class SerialTcpBridge:
    def __init__(self, serial_path: str, host: str, port: int, baud: int) -> None:
        self.serial_path = serial_path
        self.host = host
        self.port = port
        self.baud = baud
        self.running = True

        self.selector = selectors.DefaultSelector()
        self.serial_fd = None
        self.server_socket = None
        self.client_socket = None
        self.serial_to_client = bytearray()
        self.client_to_serial = bytearray()

    def _log(self, message: str) -> None:
        print(message, file=sys.stderr, flush=True)

    def _configure_serial(self) -> None:
        if self.baud not in BAUD_MAP:
            raise RuntimeError(f"Unsupported baud rate: {self.baud}")

        self.serial_fd = os.open(self.serial_path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(self.serial_fd)

        # iflag, oflag, cflag, lflag
        attrs[0] = termios.IGNPAR
        attrs[1] = 0
        attrs[2] = termios.CLOCAL | termios.CREAD | termios.CS8
        attrs[3] = 0

        attrs[2] &= ~termios.PARENB
        attrs[2] &= ~termios.CSTOPB
        attrs[2] &= ~termios.CSIZE
        attrs[2] |= termios.CS8

        if hasattr(termios, "CRTSCTS"):
            attrs[2] &= ~termios.CRTSCTS

        attrs[4] = BAUD_MAP[self.baud]
        attrs[5] = BAUD_MAP[self.baud]
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0

        termios.tcflush(self.serial_fd, termios.TCIFLUSH)
        termios.tcsetattr(self.serial_fd, termios.TCSANOW, attrs)
        fcntl.fcntl(self.serial_fd, fcntl.F_SETFL, os.O_NONBLOCK)

    def _close_client(self) -> None:
        if not self.client_socket:
            return
        try:
            self.selector.unregister(self.client_socket)
        except Exception:
            pass
        try:
            self.client_socket.close()
        except Exception:
            pass
        self.client_socket = None
        self.serial_to_client.clear()
        self.client_to_serial.clear()
        self._update_serial_events()

    def _update_serial_events(self) -> None:
        if self.serial_fd is None:
            return
        events = selectors.EVENT_READ
        if self.client_to_serial:
            events |= selectors.EVENT_WRITE
        try:
            self.selector.modify(self.serial_fd, events, "serial")
        except Exception:
            pass

    def _update_client_events(self) -> None:
        if not self.client_socket:
            return
        events = selectors.EVENT_READ
        if self.serial_to_client:
            events |= selectors.EVENT_WRITE
        try:
            self.selector.modify(self.client_socket, events, "client")
        except Exception:
            pass

    def _accept_client(self) -> None:
        client, addr = self.server_socket.accept()
        client.setblocking(False)
        try:
            client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass

        if self.client_socket:
            self._close_client()

        self.client_socket = client
        self.selector.register(self.client_socket, selectors.EVENT_READ, "client")
        self._log(f"Client connected from {addr[0]}:{addr[1]}")

    def _read_serial(self) -> None:
        if self.serial_fd is None:
            return
        try:
            data = os.read(self.serial_fd, 4096)
        except BlockingIOError:
            return
        except OSError as error:
            raise RuntimeError(f"Serial read failed: {error}") from error

        if not data:
            return
        if not self.client_socket:
            return
        self.serial_to_client.extend(data)
        self._update_client_events()

    def _write_serial(self) -> None:
        if self.serial_fd is None or not self.client_to_serial:
            return
        try:
            written = os.write(self.serial_fd, self.client_to_serial)
        except BlockingIOError:
            return
        except OSError as error:
            raise RuntimeError(f"Serial write failed: {error}") from error

        if written > 0:
            del self.client_to_serial[:written]
        self._update_serial_events()

    def _read_client(self) -> None:
        if not self.client_socket:
            return
        try:
            data = self.client_socket.recv(4096)
        except BlockingIOError:
            return
        except OSError:
            self._close_client()
            return

        if not data:
            self._close_client()
            return

        self.client_to_serial.extend(data)
        self._update_serial_events()

    def _write_client(self) -> None:
        if not self.client_socket or not self.serial_to_client:
            return
        try:
            written = self.client_socket.send(self.serial_to_client)
        except BlockingIOError:
            return
        except OSError:
            self._close_client()
            return

        if written > 0:
            del self.serial_to_client[:written]
        self._update_client_events()

    def start(self) -> int:
        self._configure_serial()
        self.selector.register(self.serial_fd, selectors.EVENT_READ, "serial")

        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind((self.host, self.port))
        self.server_socket.listen(1)
        self.server_socket.setblocking(False)
        self.selector.register(self.server_socket, selectors.EVENT_READ, "accept")

        bound_port = self.server_socket.getsockname()[1]
        print(f"BRIDGE_READY {bound_port}", flush=True)
        self._log(f"Bridge listening on {self.host}:{bound_port} for {self.serial_path}")
        return bound_port

    def stop(self) -> None:
        self.running = False

    def run(self) -> None:
        while self.running:
            events = self.selector.select(timeout=0.25)
            for key, mask in events:
                if key.data == "accept":
                    self._accept_client()
                    continue

                if key.data == "serial":
                    if mask & selectors.EVENT_READ:
                        self._read_serial()
                    if mask & selectors.EVENT_WRITE:
                        self._write_serial()
                    continue

                if key.data == "client":
                    if mask & selectors.EVENT_READ:
                        self._read_client()
                    if mask & selectors.EVENT_WRITE:
                        self._write_client()
                    continue

    def cleanup(self) -> None:
        try:
            self._close_client()
        except Exception:
            pass

        if self.server_socket:
            try:
                self.selector.unregister(self.server_socket)
            except Exception:
                pass
            try:
                self.server_socket.close()
            except Exception:
                pass
            self.server_socket = None

        if self.serial_fd is not None:
            try:
                self.selector.unregister(self.serial_fd)
            except Exception:
                pass
            try:
                os.close(self.serial_fd)
            except Exception:
                pass
            self.serial_fd = None

        try:
            self.selector.close()
        except Exception:
            pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="INSTEON local serial TCP bridge")
    parser.add_argument("--serial", required=True, help="Serial device path, e.g. /dev/serial/by-id/...")
    parser.add_argument("--host", default="127.0.0.1", help="TCP listen host")
    parser.add_argument("--port", type=int, default=0, help="TCP listen port (0 = auto)")
    parser.add_argument("--baud", type=int, default=19200, help="Serial baud rate")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    bridge = SerialTcpBridge(args.serial, args.host, args.port, args.baud)

    def _signal_handler(_signum, _frame):
        bridge.stop()

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    try:
        bridge.start()
        bridge.run()
        return 0
    except Exception as error:
        print(f"BRIDGE_ERROR {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        bridge.cleanup()


if __name__ == "__main__":
    sys.exit(main())
