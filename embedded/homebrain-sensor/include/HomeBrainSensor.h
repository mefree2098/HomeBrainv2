#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>

namespace homebrain {

constexpr char READING_SCHEMA[] = "homebrain.sensor.reading.v1";
constexpr char CONFIG_SCHEMA[] = "homebrain.sensor.config.v1";

constexpr uint8_t PIN_BATTERY_ADC = D0;   // GPIO0 / A0
constexpr uint8_t PIN_SERVICE = D1;       // GPIO1, short to GND during boot
constexpr uint8_t PIN_DHT_DATA = D2;      // GPIO2
constexpr uint8_t PIN_DHT_POWER = D3;     // GPIO21
constexpr uint8_t PIN_I2C_SDA = D4;       // GPIO22
constexpr uint8_t PIN_I2C_SCL = D5;       // GPIO23
constexpr uint8_t PIN_UART_TX = D6;       // GPIO16
constexpr uint8_t PIN_UART_RX = D7;       // GPIO17

enum class Profile : uint8_t {
  Auto,
  AirStation,
  Climate,
  Presence
};

struct AppCredentials {
  String hubUrl;
  String nodeId;
  String setupCode;
  String deviceToken;
};

struct FirmwareUpdate {
  String id;
  String version;
  String sha256;
  String imageSha256;
  String hardwareProfile;
  uint32_t size = 0;
  uint8_t protocol = 0;
};

struct RuntimeConfig {
  Profile profile = Profile::Auto;
  uint32_t reportingIntervalSeconds = 300;
  bool deepSleepEnabled = true;
  float temperatureOffsetC = 0.0f;
  float humidityOffsetPct = 0.0f;
  float altitudeMeters = 0.0f;
  uint16_t presenceHoldSeconds = 30;
  uint32_t tokenVersion = 0;
  FirmwareUpdate firmwareUpdate;  // Live command; never saved as runtime configuration.
};

struct SensorReading {
  float temperatureC = NAN;
  float humidityPct = NAN;
  float dewPointC = NAN;
  float absoluteHumidityGm3 = NAN;
  float pressureHpa = NAN;
  float gasResistanceOhms = NAN;
  float airQualityScore = NAN;
  float vocTrendIndex = NAN;
  float comfortScore = NAN;
  float moldRiskScore = NAN;
  float co2Ppm = NAN;
  float pm1Ugm3 = NAN;
  float pm25Ugm3 = NAN;
  float pm10Ugm3 = NAN;
  float illuminanceLux = NAN;
  bool hasPresence = false;
  bool presencePresent = false;
  float movingDistanceCm = NAN;
  float stationaryDistanceCm = NAN;
  float movingEnergyPct = NAN;
  float stationaryEnergyPct = NAN;
  float batteryVolts = NAN;
  float batteryPct = NAN;
  bool usbPowered = false;
};

const char* profileName(Profile profile);
Profile parseProfile(const String& value);
String hardwareId();

class ConfigStore {
 public:
  bool begin();
  void end();
  void load(AppCredentials& credentials, RuntimeConfig& runtime);
  void saveCredentials(const AppCredentials& credentials);
  void saveRuntime(const RuntimeConfig& runtime);
  void clearSetupCode();
  void clearDeviceToken();
  void clearAll();

 private:
  Preferences preferences_;
};

bool applyRuntimeConfig(JsonVariantConst source, RuntimeConfig& runtime);
float batteryPercentFromVoltage(float volts);

}  // namespace homebrain
