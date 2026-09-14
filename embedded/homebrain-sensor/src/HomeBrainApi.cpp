#include "HomeBrainApi.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#include <memory>
#include <time.h>

extern const uint8_t x509_crt_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t x509_crt_bundle_end[] asm("_binary_x509_crt_bundle_end");

namespace homebrain {

namespace {
#ifndef HOMEBRAIN_SENSOR_FIRMWARE_VERSION
#define HOMEBRAIN_SENSOR_FIRMWARE_VERSION "dev"
#endif

constexpr uint32_t HTTP_TIMEOUT_MS = 10000;
}

HomeBrainApi::HomeBrainApi(AppCredentials& credentials, ConfigStore& store)
  : credentials_(credentials), store_(store) {}

String HomeBrainApi::normalizedBaseUrl() const {
  String value = credentials_.hubUrl;
  value.trim();
  while (value.endsWith("/")) value.remove(value.length() - 1);
  return value;
}

int HomeBrainApi::request(
  const String& method,
  const String& path,
  const String& requestBody,
  String& responseBody,
  bool useSetupCode
) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  const String url = normalizedBaseUrl() + path;
  std::unique_ptr<WiFiClient> client;
  if (url.startsWith("https://")) {
    if (time(nullptr) < 1700000000) {
      configTime(0, 0, "pool.ntp.org", "time.nist.gov");
      struct tm clock;
      if (!getLocalTime(&clock, HTTP_TIMEOUT_MS)) return -1;
    }
    auto* secureClient = new WiFiClientSecure();
#ifdef HOMEBRAIN_SENSOR_CA_CERT
    secureClient->setCACert(HOMEBRAIN_SENSOR_CA_CERT);
#else
    secureClient->setCACertBundle(x509_crt_bundle_start, x509_crt_bundle_end - x509_crt_bundle_start);
#endif
    client.reset(secureClient);
  } else {
    client.reset(new WiFiClient());
  }

  HTTPClient http;
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(*client, url)) return -1;
  http.addHeader("Accept", "application/json");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("User-Agent", String("HomeBrainSensor/") + HOMEBRAIN_SENSOR_FIRMWARE_VERSION);
  if (useSetupCode) {
    http.addHeader("X-HomeBrain-Sensor-Setup", credentials_.setupCode);
  } else if (!credentials_.deviceToken.isEmpty()) {
    http.addHeader("Authorization", String("Sensor ") + credentials_.deviceToken);
  }

  int statusCode = -1;
  if (method == "GET") statusCode = http.GET();
  else statusCode = http.POST(requestBody);
  if (statusCode > 0) responseBody = http.getString();
  http.end();
  return statusCode;
}

ApiResult HomeBrainApi::classifyResponse(int statusCode, const String& body) const {
  if (statusCode == 401 || statusCode == 403 || statusCode == 409 || statusCode == 410) {
    return ApiResult::Unauthorized;
  }
  if (statusCode < 200 || statusCode >= 300) return ApiResult::RetryableFailure;

  StaticJsonDocument<64> filter;
  filter["success"] = true;
  DynamicJsonDocument response(128);
  const DeserializationError error = deserializeJson(response, body, DeserializationOption::Filter(filter));
  if (error || !response["success"].as<bool>()) return ApiResult::InvalidResponse;
  return ApiResult::Success;
}

bool HomeBrainApi::parseConfigResponse(const String& body, RuntimeConfig& runtime) const {
  DynamicJsonDocument response(3072);
  StaticJsonDocument<64> filter;
  filter["config"] = true;
  if (deserializeJson(response, body, DeserializationOption::Filter(filter))) return false;
  JsonVariantConst config = response["config"];
  if (config.isNull()) return false;
  applyRuntimeConfig(config, runtime);
  return true;
}

ApiResult HomeBrainApi::activate(RuntimeConfig& runtime) {
  DynamicJsonDocument requestDocument(768);
  requestDocument["hardware_id"] = hardwareId();
  requestDocument["firmware_version"] = HOMEBRAIN_SENSOR_FIRMWARE_VERSION;
  requestDocument.createNestedArray("capabilities");
  String requestBody;
  serializeJson(requestDocument, requestBody);

  String responseBody;
  const String path = String("/api/sensor-nodes/") + credentials_.nodeId + "/activate";
  const int statusCode = request("POST", path, requestBody, responseBody, true);
  const ApiResult result = classifyResponse(statusCode, responseBody);
  if (result != ApiResult::Success) return result;

  DynamicJsonDocument response(3072);
  StaticJsonDocument<64> filter;
  filter["deviceToken"] = true;
  if (deserializeJson(response, responseBody, DeserializationOption::Filter(filter))) return ApiResult::InvalidResponse;
  const String token = response["deviceToken"] | "";
  if (token.isEmpty() || !parseConfigResponse(responseBody, runtime)) return ApiResult::InvalidResponse;

  credentials_.deviceToken = token;
  credentials_.setupCode = "";
  store_.saveCredentials(credentials_);
  store_.saveRuntime(runtime);
  return ApiResult::Success;
}

ApiResult HomeBrainApi::fetchConfig(RuntimeConfig& runtime) {
  String responseBody;
  const String path = String("/api/sensor-nodes/") + credentials_.nodeId + "/config";
  const int statusCode = request("GET", path, "", responseBody, false);
  const ApiResult result = classifyResponse(statusCode, responseBody);
  if (result != ApiResult::Success) return result;
  if (!parseConfigResponse(responseBody, runtime)) return ApiResult::InvalidResponse;
  store_.saveRuntime(runtime);
  return ApiResult::Success;
}

void HomeBrainApi::addFloat(JsonObject target, const char* key, float value, uint8_t digits) const {
  if (!isfinite(value)) return;
  const float multiplier = powf(10.0f, digits);
  target[key] = roundf(value * multiplier) / multiplier;
}

ApiResult HomeBrainApi::publish(
  const SensorReading& reading,
  const SensorSuite& sensors,
  RuntimeConfig& runtime,
  uint64_t sequence,
  uint32_t wakeCount
) {
  DynamicJsonDocument document(4096);
  document["schema"] = READING_SCHEMA;
  document["profile"] = profileName(runtime.profile);
  document["firmware_version"] = HOMEBRAIN_SENSOR_FIRMWARE_VERSION;
  document["hardware_id"] = hardwareId();
  document["sequence"] = sequence;
  sensors.addCapabilities(document.createNestedArray("capabilities"));

  JsonObject values = document.createNestedObject("readings");
  addFloat(values, "temperature_c", reading.temperatureC);
  addFloat(values, "humidity_pct", reading.humidityPct);
  addFloat(values, "dew_point_c", reading.dewPointC);
  addFloat(values, "absolute_humidity_gm3", reading.absoluteHumidityGm3);
  addFloat(values, "pressure_hpa", reading.pressureHpa);
  addFloat(values, "gas_resistance_ohms", reading.gasResistanceOhms, 0);
  addFloat(values, "air_quality_score", reading.airQualityScore, 1);
  addFloat(values, "voc_trend_index", reading.vocTrendIndex, 1);
  addFloat(values, "comfort_score", reading.comfortScore, 1);
  addFloat(values, "mold_risk_score", reading.moldRiskScore, 1);
  addFloat(values, "co2_ppm", reading.co2Ppm, 0);
  addFloat(values, "pm1_0_ugm3", reading.pm1Ugm3, 1);
  addFloat(values, "pm2_5_ugm3", reading.pm25Ugm3, 1);
  addFloat(values, "pm10_ugm3", reading.pm10Ugm3, 1);
  addFloat(values, "illuminance_lux", reading.illuminanceLux, 1);
  if (reading.hasPresence) {
    values["presence_present"] = reading.presencePresent;
    addFloat(values, "moving_distance_cm", reading.movingDistanceCm, 0);
    addFloat(values, "stationary_distance_cm", reading.stationaryDistanceCm, 0);
    addFloat(values, "moving_energy_pct", reading.movingEnergyPct, 0);
    addFloat(values, "stationary_energy_pct", reading.stationaryEnergyPct, 0);
  }

  JsonObject power = document.createNestedObject("power");
  addFloat(power, "battery_volts", reading.batteryVolts, 3);
  addFloat(power, "battery_pct", reading.batteryPct, 1);
  power["usb_powered"] = reading.usbPowered;

  JsonObject diagnostics = document.createNestedObject("diagnostics");
  diagnostics["signal_rssi_dbm"] = WiFi.RSSI();
  diagnostics["uptime_ms"] = millis();
  diagnostics["wake_count"] = wakeCount;
  diagnostics["free_heap_bytes"] = ESP.getFreeHeap();
  diagnostics["ip_address"] = WiFi.localIP().toString();

  String requestBody;
  serializeJson(document, requestBody);
  String responseBody;
  const String path = String("/api/sensor-nodes/") + credentials_.nodeId + "/readings";
  const int statusCode = request("POST", path, requestBody, responseBody, false);
  const ApiResult result = classifyResponse(statusCode, responseBody);
  if (result != ApiResult::Success) return result;
  if (parseConfigResponse(responseBody, runtime)) store_.saveRuntime(runtime);
  return ApiResult::Success;
}

}  // namespace homebrain
