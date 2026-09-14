#include "HomeBrainSensor.h"

#include <WiFi.h>

namespace homebrain {

namespace {
constexpr char PREF_NAMESPACE[] = "hbrain-sensor";
}

const char* profileName(Profile profile) {
  switch (profile) {
    case Profile::AirStation: return "air-station";
    case Profile::Climate: return "climate";
    case Profile::Presence: return "presence";
    default: return "auto";
  }
}

Profile parseProfile(const String& value) {
  if (value.equalsIgnoreCase("air-station")) return Profile::AirStation;
  if (value.equalsIgnoreCase("climate")) return Profile::Climate;
  if (value.equalsIgnoreCase("presence")) return Profile::Presence;
  return Profile::Auto;
}

String hardwareId() {
  const uint64_t mac = ESP.getEfuseMac();
  char value[32];
  snprintf(
    value,
    sizeof(value),
    "XIAO-C6-%02X%02X%02X%02X%02X%02X",
    static_cast<uint8_t>(mac >> 40),
    static_cast<uint8_t>(mac >> 32),
    static_cast<uint8_t>(mac >> 24),
    static_cast<uint8_t>(mac >> 16),
    static_cast<uint8_t>(mac >> 8),
    static_cast<uint8_t>(mac)
  );
  return String(value);
}

bool ConfigStore::begin() {
  return preferences_.begin(PREF_NAMESPACE, false);
}

void ConfigStore::end() {
  preferences_.end();
}

void ConfigStore::load(AppCredentials& credentials, RuntimeConfig& runtime) {
  credentials.hubUrl = preferences_.getString("hub", "http://homebrain.local:3000");
  credentials.nodeId = preferences_.getString("node", "");
  credentials.setupCode = preferences_.getString("setup", "");
  credentials.deviceToken = preferences_.getString("token", "");

  runtime.profile = parseProfile(preferences_.getString("profile", "auto"));
  runtime.reportingIntervalSeconds = preferences_.getUInt("interval", 300);
  runtime.deepSleepEnabled = preferences_.getBool("sleep", true);
  runtime.temperatureOffsetC = preferences_.getFloat("temp_off", 0.0f);
  runtime.humidityOffsetPct = preferences_.getFloat("hum_off", 0.0f);
  runtime.altitudeMeters = preferences_.getFloat("altitude", 0.0f);
  runtime.presenceHoldSeconds = preferences_.getUShort("pres_hold", 30);
  runtime.tokenVersion = preferences_.getUInt("token_ver", 0);
}

void ConfigStore::saveCredentials(const AppCredentials& credentials) {
  preferences_.putString("hub", credentials.hubUrl);
  preferences_.putString("node", credentials.nodeId);
  preferences_.putString("setup", credentials.setupCode);
  preferences_.putString("token", credentials.deviceToken);
}

void ConfigStore::saveRuntime(const RuntimeConfig& runtime) {
  preferences_.putString("profile", profileName(runtime.profile));
  preferences_.putUInt("interval", runtime.reportingIntervalSeconds);
  preferences_.putBool("sleep", runtime.deepSleepEnabled);
  preferences_.putFloat("temp_off", runtime.temperatureOffsetC);
  preferences_.putFloat("hum_off", runtime.humidityOffsetPct);
  preferences_.putFloat("altitude", runtime.altitudeMeters);
  preferences_.putUShort("pres_hold", runtime.presenceHoldSeconds);
  preferences_.putUInt("token_ver", runtime.tokenVersion);
}

void ConfigStore::clearSetupCode() {
  preferences_.remove("setup");
}

void ConfigStore::clearDeviceToken() {
  preferences_.remove("token");
}

void ConfigStore::clearAll() {
  preferences_.clear();
}

bool applyRuntimeConfig(JsonVariantConst source, RuntimeConfig& runtime) {
  if (source.isNull() || !source.is<JsonObjectConst>()) return false;
  const String schema = source["schema"] | "";
  if (schema != CONFIG_SCHEMA) return false;

  const Profile previousProfile = runtime.profile;
  runtime.profile = parseProfile(String(source["profile"] | "auto"));
  runtime.reportingIntervalSeconds = constrain(
    static_cast<uint32_t>(source["reporting_interval_seconds"] | 300U),
    10U,
    86400U
  );
  runtime.deepSleepEnabled = source["deep_sleep_enabled"] | (runtime.profile == Profile::Climate);
  JsonObjectConst calibration = source["calibration"].as<JsonObjectConst>();
  runtime.temperatureOffsetC = constrain(
    static_cast<float>(calibration["temperature_offset_c"] | 0.0f), -20.0f, 20.0f
  );
  runtime.humidityOffsetPct = constrain(
    static_cast<float>(calibration["humidity_offset_pct"] | 0.0f), -50.0f, 50.0f
  );
  runtime.altitudeMeters = constrain(
    static_cast<float>(calibration["altitude_meters"] | 0.0f), -500.0f, 9000.0f
  );
  runtime.presenceHoldSeconds = constrain(
    static_cast<uint16_t>(source["presence_hold_seconds"] | 30U),
    static_cast<uint16_t>(0),
    static_cast<uint16_t>(3600)
  );
  runtime.tokenVersion = source["token_version"] | 0U;
  return previousProfile != runtime.profile;
}

float batteryPercentFromVoltage(float volts) {
  // Piecewise approximation of a lightly loaded 1-cell LiPo discharge curve.
  constexpr float voltage[] = {3.20f, 3.50f, 3.65f, 3.72f, 3.79f, 3.87f, 3.95f, 4.05f, 4.20f};
  constexpr float percent[] = {0.0f, 5.0f, 12.0f, 25.0f, 45.0f, 65.0f, 78.0f, 90.0f, 100.0f};
  if (volts <= voltage[0]) return 0.0f;
  if (volts >= voltage[8]) return 100.0f;
  for (size_t index = 1; index < 9; ++index) {
    if (volts <= voltage[index]) {
      const float ratio = (volts - voltage[index - 1]) / (voltage[index] - voltage[index - 1]);
      return percent[index - 1] + ratio * (percent[index] - percent[index - 1]);
    }
  }
  return 0.0f;
}

}  // namespace homebrain
