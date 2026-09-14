#include "UsbBenchDiagnostic.h"

#include <ArduinoJson.h>
#include <Wire.h>
#include <math.h>

namespace homebrain {

namespace {
constexpr uint8_t BME_ADDRESS_PRIMARY = 0x76;
constexpr uint8_t BME_ADDRESS_SECONDARY = 0x77;
constexpr uint8_t SCD41_ADDRESS = 0x62;
constexpr uint8_t VEML7700_ADDRESS = 0x10;
constexpr char DIAGNOSTIC_SCHEMA[] = "homebrain.usb-diagnostic.v1";

bool probe(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool inRange(float value, float minimum, float maximum) {
  return isfinite(value) && value >= minimum && value <= maximum;
}

void setFloat(JsonObject target, const char* name, float value) {
  if (isfinite(value)) target[name] = value;
  else target[name] = nullptr;
}

Profile parseDiagnosticProfile(String value) {
  value.trim();
  value.toLowerCase();
  if (value == "air-station" || value == "atmosphere") return Profile::AirStation;
  if (value == "presence") return Profile::Presence;
  if (value == "climate") return Profile::Climate;
  return Profile::Auto;
}
}  // namespace

Profile detectUsbDiagnosticProfile() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
  const bool hasAirSensor = probe(BME_ADDRESS_PRIMARY)
    || probe(BME_ADDRESS_SECONDARY)
    || probe(SCD41_ADDRESS);
  const bool hasLightSensor = probe(VEML7700_ADDRESS);
  Wire.end();
  if (hasAirSensor) return Profile::AirStation;
  if (hasLightSensor) return Profile::Presence;
  return Profile::Climate;
}

UsbDiagnosticSummary runUsbBenchDiagnostic(
  SensorSuite& sensors,
  Profile requestedProfile,
  Print& output
) {
  const Profile profile = requestedProfile == Profile::Auto
    ? detectUsbDiagnosticProfile()
    : requestedProfile;

  output.println("USB_DIAGNOSTIC_BEGIN");
  output.printf("USB bench diagnostic profile: %s\n", profileName(profile));

  RuntimeConfig diagnosticConfig;
  diagnosticConfig.profile = profile;
  diagnosticConfig.deepSleepEnabled = false;
  diagnosticConfig.reportingIntervalSeconds = 30;
  sensors.begin(diagnosticConfig);
  const SensorReading reading = sensors.capture(diagnosticConfig);

  const bool bmeAck = probe(BME_ADDRESS_PRIMARY) || probe(BME_ADDRESS_SECONDARY);
  const bool scdAck = probe(SCD41_ADDRESS);
  const bool vemlAck = probe(VEML7700_ADDRESS);
  const bool bmeReading = inRange(reading.pressureHpa, 250.0f, 1200.0f)
    && inRange(reading.gasResistanceOhms, 1.0f, 100000000.0f)
    && inRange(reading.temperatureC, -40.0f, 85.0f)
    && inRange(reading.humidityPct, 0.0f, 100.0f);
  const bool scdReading = inRange(reading.co2Ppm, 250.0f, 40000.0f);
  const bool vemlReading = inRange(reading.illuminanceLux, 0.0f, 200000.0f);
  const bool pmsReading = inRange(reading.pm1Ugm3, 0.0f, 5000.0f)
    && inRange(reading.pm25Ugm3, 0.0f, 5000.0f)
    && inRange(reading.pm10Ugm3, 0.0f, 5000.0f);
  const bool pmsCommandPath = profile == Profile::AirStation
    ? sensors.testPmsCommandPath()
    : false;

  DynamicJsonDocument document(3072);
  document["schema"] = DIAGNOSTIC_SCHEMA;
  document["hardware_id"] = hardwareId();
  document["profile"] = profileName(profile);
  JsonObject modules = document.createNestedObject("modules");

  JsonObject bme = modules.createNestedObject("bme680");
  bme["i2c_ack"] = bmeAck;
  bme["reading_valid"] = bmeReading;
  setFloat(bme, "temperature_c", reading.temperatureC);
  setFloat(bme, "humidity_pct", reading.humidityPct);
  setFloat(bme, "pressure_hpa", reading.pressureHpa);
  setFloat(bme, "gas_resistance_ohms", reading.gasResistanceOhms);

  JsonObject scd = modules.createNestedObject("scd41");
  scd["i2c_ack"] = scdAck;
  scd["reading_valid"] = scdReading;
  setFloat(scd, "co2_ppm", reading.co2Ppm);

  JsonObject veml = modules.createNestedObject("veml7700");
  veml["i2c_ack"] = vemlAck;
  veml["reading_valid"] = vemlReading;
  setFloat(veml, "illuminance_lux", reading.illuminanceLux);

  JsonObject pms = modules.createNestedObject("pms5003");
  pms["checksum_valid_frame"] = pmsReading;
  pms["two_way_uart"] = pmsCommandPath;
  setFloat(pms, "pm1_ugm3", reading.pm1Ugm3);
  setFloat(pms, "pm25_ugm3", reading.pm25Ugm3);
  setFloat(pms, "pm10_ugm3", reading.pm10Ugm3);

  JsonArray failures = document.createNestedArray("failures");
  bool passed = false;
  if (profile == Profile::AirStation) {
    if (!bmeAck) failures.add("bme680-no-i2c-ack");
    else if (!bmeReading) failures.add("bme680-invalid-reading");
    if (!scdAck) failures.add("scd41-no-i2c-ack");
    else if (!scdReading) failures.add("scd41-invalid-reading");
    if (!vemlAck) failures.add("veml7700-no-i2c-ack");
    else if (!vemlReading) failures.add("veml7700-invalid-reading");
    if (!pmsReading) failures.add("pms5003-no-valid-frame");
    if (!pmsCommandPath) failures.add("pms5003-two-way-uart-failed");
    passed = failures.size() == 0;
  } else {
    failures.add("profile-diagnostic-not-yet-implemented");
  }
  document["passed"] = passed;

  serializeJson(document, output);
  output.println();
  output.printf("USB_DIAGNOSTIC_RESULT: %s\n", passed ? "PASS" : "FAIL");
  output.println("USB_DIAGNOSTIC_END");
  return {profile, passed};
}

bool pollUsbDiagnosticConsole(
  SensorSuite& sensors,
  const RuntimeConfig& runtime,
  Print& output
) {
  static String command;
  bool ranDiagnostic = false;
  while (Serial.available() > 0) {
    const char value = static_cast<char>(Serial.read());
    if (value != '\r' && value != '\n') {
      if (command.length() < 80) command += value;
      continue;
    }
    command.trim();
    if (command.isEmpty()) continue;
    if (command == "help") {
      output.println("USB commands: diag | diag air-station | help");
    } else if (command == "diag" || command.startsWith("diag ")) {
      const Profile requested = command == "diag"
        ? (runtime.profile == Profile::Auto ? detectUsbDiagnosticProfile() : runtime.profile)
        : parseDiagnosticProfile(command.substring(5));
      runUsbBenchDiagnostic(sensors, requested, output);
      if (requested != runtime.profile && runtime.profile != Profile::Auto) {
        sensors.begin(runtime);
      }
      ranDiagnostic = true;
    } else {
      output.println("Unknown USB command. Type: help");
    }
    command = "";
  }
  return ranDiagnostic;
}

}  // namespace homebrain
