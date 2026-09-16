"""Private JSON-lines transport for Midea LAN and Rheem EcoNet adapters.

Credentials arrive on stdin, never command arguments. One persistent process per
provider keeps LAN sockets and the EcoNet MQTT subscription alive between polls.
"""
import asyncio
import json
import logging
import sys
import time
from datetime import datetime, timezone

logging.disable(logging.CRITICAL)


class CommandError(Exception):
    pass


def label(value):
    return getattr(value, "name", str(value)).lower().replace("fan_only", "fan") if value is not None else None


def optional(obj, name):
    try:
        return getattr(obj, name)
    except (AttributeError, KeyError, TypeError, IndexError, ValueError):
        return None


def enum_value(enum, value):
    for entry in enum:
        if label(entry) == str(value).lower():
            return entry
    raise CommandError("Unsupported setting: " + str(value))


def fahrenheit(value):
    return round(value * 1.8 + 32, 1) if isinstance(value, (float, int)) else None


def finite_number(value):
    import math
    if isinstance(value, bool) or value is None:
        raise CommandError("A numeric temperature or fan speed is required")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise CommandError("A numeric temperature or fan speed is required") from None
    if not math.isfinite(result):
        raise CommandError("The value must be finite")
    return result


class Worker:
    def __init__(self):
        self.config = {}
        self.devices = {}
        self.econet = None
        self.usage_at = 0
        self.rediscovery_at = {}

    async def close(self):
        if self.econet and self.econet._mqtt_client:
            self.econet._mqtt_client.disconnect()
            await asyncio.to_thread(self.econet.unsubscribe)
        self.econet = None
        self.devices = {}

    async def ac(self, identifier):
        from msmart.device import AirConditioner
        if identifier in self.devices:
            return self.devices[identifier]
        saved = next((d for d in self.config.get("devices", []) if str(d["id"]) == identifier), None)
        if not saved:
            raise CommandError("The AC is not paired in HomeBrain")
        if int(saved.get("type", 172)) != 172:
            from msmart.device import CommercialAirConditioner
            AirConditioner = CommercialAirConditioner
        try:
            from msmart.discover import Discover
            discovered = await Discover.discover_single(saved["ip"], auto_connect=False, timeout=3)
            if not discovered or str(discovered.id) != identifier:
                raise CommandError("Saved address no longer belongs to this AC")
            device = AirConditioner(ip=saved["ip"], port=int(saved.get("port", 6444)), device_id=int(identifier))
            if saved.get("token") and saved.get("key"):
                await device.authenticate(saved["token"], saved["key"])
            await device.get_capabilities()
            await device.refresh()
            if not device.online:
                raise CommandError("AC is offline")
        except Exception:
            if time.monotonic() - self.rediscovery_at.get(identifier, -120) < 120:
                raise CommandError("AC is offline; HomeBrain will retry discovery") from None
            self.rediscovery_at[identifier] = time.monotonic()
            from msmart.discover import Discover
            discovered = await Discover.discover(auto_connect=False, timeout=3)
            match = next((d for d in discovered if str(d.id) == identifier), None)
            if not match:
                raise CommandError("AC is offline; check its Wi-Fi connection") from None
            # Use the saved authentication material and match the immutable ID,
            # never substitute a different appliance at the previous IP.
            device = AirConditioner(ip=match.ip, port=match.port, device_id=int(identifier))
            if saved.get("token") and saved.get("key"):
                await device.authenticate(saved["token"], saved["key"])
            await device.get_capabilities()
            await device.refresh()
            if not device.online:
                raise CommandError("AC discovery succeeded but the AC did not respond")
            saved["ip"] = match.ip
            saved["port"] = match.port
        self.devices[identifier] = device
        return device

    def ac_snapshot(self, device):
        return {
            "id": str(device.id), "name": device.name, "ip": device.ip,
            "online": device.online, "power": device.power_state,
            "mode": label(device.operational_mode) if device.power_state else "off",
            "lastActiveMode": label(device.operational_mode),
            "temperature": fahrenheit(device.indoor_temperature),
            "targetTemperature": fahrenheit(device.target_temperature),
            "outdoorTemperature": fahrenheit(device.outdoor_temperature),
            "fanSpeed": label(device.fan_speed) if hasattr(device.fan_speed, "name") else device.fan_speed,
            "swing": label(device.swing_mode), "humidity": device.indoor_humidity,
            "eco": device.eco, "turbo": device.turbo, "sleep": device.sleep,
            "filterAlert": device.filter_alert, "errorCode": device.error_code,
            "powerW": device.get_real_time_power_usage(), "energyKwh": device.get_total_energy_usage(),
            "capabilities": {
                "modes": ["off"] + [label(v) for v in device.supported_operation_modes],
                "fanSpeeds": [label(v) for v in device.supported_fan_speeds],
                "customFanSpeed": device.supports_custom_fan_speed,
                "swings": [label(v) for v in device.supported_swing_modes],
                "minTemperature": fahrenheit(device.min_target_temperature),
                "maxTemperature": fahrenheit(device.max_target_temperature),
                "eco": device.supports_eco, "turbo": device.supports_turbo, "sleep": True,
            }
        }

    async def ac_command(self, device, action, value):
        from msmart.device import AirConditioner as AC
        await device.refresh()
        if not device.online:
            raise CommandError("AC is offline; command was not sent")
        expected = {}
        if action in ("turnon", "turnoff", "toggle"):
            expected["power_state"] = (not device.power_state) if action == "toggle" else action == "turnon"
        elif action == "setmode":
            if value == "off":
                expected["power_state"] = False
            else:
                mode = enum_value(AC.OperationalMode, value)
                if mode not in device.supported_operation_modes:
                    raise CommandError("This AC does not support that mode")
                expected.update(power_state=True, operational_mode=mode)
        elif action == "settemperature":
            target = (finite_number(value) - 32) / 1.8
            if not device.min_target_temperature - .01 <= target <= device.max_target_temperature + .01:
                raise CommandError("Temperature is outside this AC's supported range")
            # Midea represents targets in half degrees Celsius, even with an F display.
            expected["target_temperature"] = round(target * 2) / 2
        elif action == "setfanspeed":
            if isinstance(value, str) and not value.replace('.', '', 1).isnumeric():
                speed = enum_value(AC.FanSpeed, value)
                if speed not in device.supported_fan_speeds:
                    raise CommandError("This AC does not support that fan speed")
            else:
                speed = finite_number(value)
                if not device.supports_custom_fan_speed or not 0 <= speed <= 100:
                    raise CommandError("Custom fan speed is not supported or is out of range")
            expected["fan_speed"] = speed
        elif action == "setswing":
            swing = enum_value(AC.SwingMode, value)
            if swing not in device.supported_swing_modes:
                raise CommandError("This AC does not support that swing setting")
            expected["swing_mode"] = swing
        elif action in ("seteco", "setturbo", "setsleep"):
            prop = action[3:]
            if not isinstance(value, bool):
                raise CommandError("This setting requires true or false")
            if prop != "sleep" and not getattr(device, "supports_" + prop):
                raise CommandError("This AC does not support " + prop)
            expected[prop] = value
        else:
            raise CommandError("Unsupported AC action")
        for key, val in expected.items():
            setattr(device, key, val)
        await device.apply()
        for _ in range(3):
            await asyncio.sleep(.4)
            await device.refresh()
            if device.online and all(getattr(device, key) == val for key, val in expected.items()):
                return self.ac_snapshot(device)
        raise CommandError("The AC did not confirm the requested state; refresh before retrying")

    async def heaters(self):
        from pyeconet.api import EcoNetApiInterface
        from pyeconet.equipment import EquipmentType
        if not self.econet:
            if not self.config.get("email") or not self.config.get("password"):
                raise CommandError("Enter your EcoNet account in HomeBrain Settings")
            self.econet = await EcoNetApiInterface.login(self.config["email"], self.config["password"])
            equipment = await self.econet.get_equipment_by_type([EquipmentType.WATER_HEATER])
            self.devices = {str(d.serial_number): d for d in equipment[EquipmentType.WATER_HEATER]}
            self.econet.subscribe()
        else:
            await self.econet.refresh_equipment()
        return list(self.devices.values())

    def heater_snapshot(self, device):
        mode = optional(device, "mode")
        return {
            "id": str(device.serial_number), "name": optional(device, "device_name"),
            "online": optional(device, "connected") is True,
            "power": optional(device, "enabled"), "mode": label(mode),
            "targetTemperature": optional(device, "set_point"),
            "runningState": optional(device, "running_state"),
            "alertCount": optional(device, "alert_count"),
            "wifiSignal": optional(device, "wifi_signal"),
            "leakSensorInstalled": optional(device, "leak_installed"),
            "shutoffValveOpen": optional(device, "shutoff_valve_open"),
            "hotWaterAvailable": optional(device, "tank_hot_water_availability"),
            "energyUsageToday": optional(device, "todays_energy_usage"),
            "energyType": optional(device, "energy_type"),
            "waterUsageToday": optional(device, "todays_water_usage"),
            "modelType": optional(device, "generic_type"),
            "capabilities": {"monitorOnly": True}
        }

    async def request(self, request):
        op = request.get("op")
        if op == "configure":
            await self.close()
            self.config = request["config"]
            return {"configured": True}
        provider = self.config.get("provider")
        if provider == "midea":
            if op == "discover":
                from msmart.discover import Discover
                devices = await Discover.discover(target=request.get("ip") or "255.255.255.255", auto_connect=True, timeout=5)
                found = []
                for d in devices:
                    if int(d.type) not in (172, 204) or not d.supported or not d.online:
                        continue
                    await d.get_capabilities()
                    await d.refresh()
                    self.devices[str(d.id)] = d
                    # The parent persists these privately and never includes them in HTTP responses.
                    saved = {k: v for k, v in d.to_dict().items() if k in ("id", "ip", "port", "type", "token", "key")}
                    found.append({"connection": saved, "state": self.ac_snapshot(d)})
                return {"discovered": found}
            if op == "command":
                device = await self.ac(str(request["id"]))
                return {"devices": [await self.ac_command(device, request["action"], request.get("value"))]}
            if op == "poll":
                states = []
                for saved in self.config.get("devices", []):
                    identifier = str(saved["id"])
                    try:
                        d = await self.ac(identifier)
                        await d.refresh()
                        if not d.online:
                            raise CommandError("AC is offline")
                        states.append(self.ac_snapshot(d))
                    except Exception:
                        self.devices.pop(identifier, None)
                        states.append({"id": identifier, "online": False, "error": "AC did not respond; check Wi-Fi and saved IP address"})
                return {"devices": states, "connections": self.config.get("devices", [])}
        elif provider == "econet":
            if op != "poll":
                raise CommandError("The water heater integration provides monitoring; heater settings remain in EcoNet")
            heaters = await self.heaters()
            if time.monotonic() - self.usage_at > 900:
                for d in heaters:
                    for method in (d.get_energy_usage, d.get_water_usage):
                        try:
                            await asyncio.wait_for(method(), 12)
                        except Exception:
                            pass  # Usage availability varies by heater model.
                self.usage_at = time.monotonic()
            return {"devices": [self.heater_snapshot(d) for d in heaters]}
        raise CommandError("Unknown appliance operation")


async def main():
    worker = Worker()
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = {}
        try:
            request = json.loads(line)
            result = await asyncio.wait_for(worker.request(request), 75)
            response = {"id": request.get("requestId"), "ok": True, "result": result, "observedAt": datetime.now(timezone.utc).isoformat()}
        except Exception as error:
            message = str(error) if isinstance(error, CommandError) else "Appliance request failed (" + type(error).__name__ + "); check connection and account settings"
            response = {"id": request.get("requestId"), "ok": False, "error": message}
            if worker.config.get("provider") == "econet":
                await worker.close()
        print(json.dumps(response, allow_nan=False), flush=True)
    await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
