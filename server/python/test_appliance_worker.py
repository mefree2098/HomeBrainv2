import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from msmart.device import AirConditioner as AC
from appliance_worker import Worker, CommandError


class FakeAC:
    def __init__(self, confirm=True):
        self.remote = {"power_state": True, "target_temperature": 23.5, "operational_mode": AC.OperationalMode.COOL}
        self.power_state = False  # Simulates the stale cache after an outage.
        self.confirm = confirm
        self.online = True
        self.min_target_temperature, self.max_target_temperature = 16, 30
        self.supported_operation_modes = [AC.OperationalMode.COOL, AC.OperationalMode.HEAT]
        self.writes = 0

    async def refresh(self):
        for key, value in self.remote.items():
            setattr(self, key, value)

    async def apply(self):
        self.writes += 1
        if self.confirm:
            self.remote = {key: getattr(self, key) for key in self.remote}


class ApplianceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.worker = Worker()
        self.worker.ac_snapshot = lambda d: dict(d.remote)
        self.sleep = patch('appliance_worker.asyncio.sleep', new=AsyncMock())
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    async def test_toggle_reads_actual_power_before_writing(self):
        ac = FakeAC()
        result = await self.worker.ac_command(ac, "toggle", None)
        self.assertFalse(result["power_state"])
        self.assertEqual(ac.writes, 1)

    async def test_unconfirmed_write_fails_instead_of_returning_optimistic_success(self):
        ac = FakeAC(confirm=False)
        with self.assertRaisesRegex(CommandError, "did not confirm"):
            await self.worker.ac_command(ac, "turnoff", None)

    async def test_fahrenheit_temperature_rounds_to_device_increment_without_powering_on(self):
        ac = FakeAC()
        ac.remote["power_state"] = False
        result = await self.worker.ac_command(ac, "settemperature", 74)
        self.assertEqual(result["target_temperature"], 23.5)
        self.assertFalse(result["power_state"])

    async def test_invalid_inputs_never_write_hardware(self):
        ac = FakeAC()
        for action, value in [("settemperature", float('nan')), ("settemperature", 150), ("settemperature", True), ("setmode", "steam"), ("seteco", "false")]:
            with self.assertRaises(CommandError):
                await self.worker.ac_command(ac, action, value)
        self.assertEqual(ac.writes, 0)

    async def test_mode_change_does_not_echo_dry_mode_status_only_fan_code(self):
        ac = FakeAC()
        ac.remote.update(operational_mode=AC.OperationalMode.DRY, fan_speed=101)
        result = await self.worker.ac_command(ac, "setmode", "cool")
        self.assertEqual(result["operational_mode"], AC.OperationalMode.COOL)
        self.assertEqual(result["fan_speed"], AC.FanSpeed.AUTO)

    async def test_named_fan_command_accepts_observed_firmware_alias(self):
        ac = FakeAC()
        ac.remote["fan_speed"] = AC.FanSpeed.HIGH
        ac.supported_fan_speeds = list(AC.FanSpeed)
        original_apply = ac.apply
        async def apply():
            await original_apply()
            ac.remote["fan_speed"] = 30
        ac.apply = apply
        result = await self.worker.ac_command(ac, "setfanspeed", "low")
        self.assertEqual(result["fan_speed"], 30)
        with self.assertRaisesRegex(CommandError, "did not confirm"):
            await self.worker.ac_command(ac, "setfanspeed", "high")

    async def test_dhcp_recovery_matches_paired_id_and_retains_saved_auth(self):
        ac = FakeAC()
        ac.get_capabilities = AsyncMock()
        ac.authenticate = AsyncMock()
        self.worker.config = {"devices": [{"id": "123", "ip": "192.168.1.4", "token": "private-token", "key": "private-key"}]}
        found = [SimpleNamespace(id=999, ip='192.168.1.4', port=6444), SimpleNamespace(id=123, ip='192.168.1.9', port=6444)]
        with patch('msmart.device.AirConditioner', return_value=ac) as constructor, patch('msmart.discover.Discover.discover_single', new=AsyncMock(return_value=found[0])), patch('msmart.discover.Discover.discover', new=AsyncMock(return_value=found)):
            self.assertIs(await self.worker.ac('123'), ac)
        self.assertEqual(constructor.call_args.kwargs['ip'], '192.168.1.9')
        ac.authenticate.assert_awaited_once_with('private-token', 'private-key')
        self.assertEqual(self.worker.config['devices'][0]['ip'], '192.168.1.9')

    async def test_tankless_family_is_not_mislabelled_as_electric(self):
        from pyeconet.equipment.water_heater import WaterHeaterOperationMode
        heater = SimpleNamespace(serial_number='tankless', generic_type='eagleWaterHeater', enabled=True, mode=WaterHeaterOperationMode.ELECTRIC_MODE)
        self.assertEqual(self.worker.heater_snapshot(heater)['mode'], 'enabled')

    async def test_heater_missing_values_remain_unknown_and_leak_capability_is_not_an_alarm(self):
        heater = SimpleNamespace(serial_number='rheem-123', connected=True, alert_count=0, leak_installed=True)
        result = self.worker.heater_snapshot(heater)
        self.assertTrue(result['online'])
        self.assertIsNone(result['targetTemperature'])
        self.assertIsNone(result['waterUsageToday'])
        self.assertTrue(result['leakSensorInstalled'])
        self.assertNotIn('leakDetected', result)
        self.assertEqual(result['alertCount'], 0)


if __name__ == '__main__':
    unittest.main()
