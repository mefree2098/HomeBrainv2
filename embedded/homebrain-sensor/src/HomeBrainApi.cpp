#include "HomeBrainApi.h"
#include "ScopedWifiAwake.h"

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
constexpr uint32_t LAN_RETRY_MS = 300000;

bool onWifiSubnet(const IPAddress& address) {
  const bool privateIp = address.type() == IPv4 && (address[0] == 10 ||
    (address[0] == 172 && address[1] >= 16 && address[1] <= 31) ||
    (address[0] == 192 && address[1] == 168));
  const uint32_t local = WiFi.localIP();
  const uint32_t mask = WiFi.subnetMask();
  return privateIp && local && mask && uint32_t(address) != local &&
    ((uint32_t(address) ^ local) & mask) == 0;
}

class SensorHttpClient : public HTTPClient {
 public:
  bool connectLan(WiFiClientSecure& socket, const IPAddress& address) const {
    // HTTPClient parsed the configured HTTPS origin. Only the TCP destination changes.
#ifdef HOMEBRAIN_SENSOR_CA_CERT
    const char* ca = HOMEBRAIN_SENSOR_CA_CERT;
#else
    const char* ca = nullptr;  // createHttpClient installed the certificate bundle.
#endif
    socket.setConnectionTimeout(2500);
    socket.setHandshakeTimeout(4);
    const bool connected = socket.connect(address, _port, _host.c_str(), ca, nullptr, nullptr);
    socket.setConnectionTimeout(HTTP_TIMEOUT_MS);
    socket.setHandshakeTimeout(HTTP_TIMEOUT_MS / 1000);
    return connected;
  }
};
}

struct HomeBrainApi::RequestSession {
  RequestSession(std::unique_ptr<WiFiClient> socket, const String& target)
    : client(std::move(socket)), url(target), localIp(WiFi.localIP()) {}

  // HTTPClient stops its borrowed socket in its destructor. Keep the socket alive until then.
  std::unique_ptr<WiFiClient> client;
  SensorHttpClient http;
  bool localRoute = false;
  String url;
  IPAddress localIp;
};

HomeBrainApi::~HomeBrainApi() = default;

HomeBrainApi::HomeBrainApi(AppCredentials& credentials, ConfigStore& store)
  : credentials_(credentials), store_(store) {}

String HomeBrainApi::normalizedBaseUrl() const {
  String value = credentials_.hubUrl;
  value.trim();
  while (value.endsWith("/")) value.remove(value.length() - 1);
  return value;
}

std::unique_ptr<WiFiClient> HomeBrainApi::createHttpClient(bool requireTls) const {
  if (WiFi.status() != WL_CONNECTED) return nullptr;
  const String url = normalizedBaseUrl();
  std::unique_ptr<WiFiClient> client;
  if (url.startsWith("https://")) {
    if (time(nullptr) < 1700000000) {
      configTime(0, 0, "pool.ntp.org", "time.nist.gov");
      struct tm clock;
      if (!getLocalTime(&clock, HTTP_TIMEOUT_MS)) return nullptr;
    }
    auto* secureClient = new WiFiClientSecure();
#ifdef HOMEBRAIN_SENSOR_CA_CERT
    secureClient->setCACert(HOMEBRAIN_SENSOR_CA_CERT);
#else
    secureClient->setCACertBundle(x509_crt_bundle_start, x509_crt_bundle_end - x509_crt_bundle_start);
#endif
    client.reset(secureClient);
  } else {
    if (requireTls) return nullptr;
    client.reset(new WiFiClient());
  }
  return client;
}

int HomeBrainApi::request(
  const String& method,
  const String& path,
  const String& requestBody,
  String& responseBody,
  bool useSetupCode,
  bool keepAlive
) {
  if (WiFi.status() != WL_CONNECTED) {
    session_.reset();
    return -1;
  }
  ScopedWifiAwake awake;
  const String origin = normalizedBaseUrl();
  const String url = origin + path;
  if (retryLanAt_ && static_cast<int32_t>(millis() - retryLanAt_) >= 0) retryLanAt_ = 0;
  const bool tryLan = keepAlive && origin.startsWith("https://") && origin == lanOrigin_ &&
    !retryLanAt_ && onWifiSubnet(lanAddress_);
  if (session_ && (!keepAlive || session_->url != url || session_->localIp != WiFi.localIP()
                   || session_->localRoute != tryLan
                   || !session_->http.connected())) session_.reset();
  if (!session_) {
    auto client = createHttpClient();
    if (!client) return -1;
    session_ = std::make_unique<RequestSession>(std::move(client), url);
    if (!session_->http.begin(*session_->client, url)) {
      session_.reset();
      return -1;
    }
    if (tryLan) {
      auto& tls = static_cast<WiFiClientSecure&>(*session_->client);
      session_->localRoute = session_->http.connectLan(tls, lanAddress_);
      // An unsuccessful handshake sent no HTTP data. HTTPClient can use normal DNS now.
      if (!session_->localRoute) retryLanAt_ = millis() + LAN_RETRY_MS;
    }
  }
  auto& http = session_->http;
  http.setReuse(keepAlive);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Accept", "application/json");
  http.addHeader("Content-Type", "application/json");
  http.setUserAgent(String("HomeBrainSensor/") + HOMEBRAIN_SENSOR_FIRMWARE_VERSION);
  if (path.endsWith("/readings")) http.addHeader("Prefer", "return=minimal");
  if (useSetupCode) {
    http.addHeader("X-HomeBrain-Sensor-Setup", credentials_.setupCode);
  } else if (!credentials_.deviceToken.isEmpty()) {
    http.addHeader("Authorization", String("Sensor ") + credentials_.deviceToken);
  }

  int statusCode = -1;
  if (method == "GET") statusCode = http.GET();
  else statusCode = http.POST(requestBody);
  if (statusCode > 0) responseBody = http.getString();
  const int size = http.getSize();
  const bool complete = size >= 0 && responseBody.length() == static_cast<size_t>(size);
  http.end();
  if (session_->localRoute && (statusCode != 202 || !complete)) {
    // A failed POST may have reached the hub. Use normal DNS on the next cycle
    // before treating an error from this route as a revoked credential.
    retryLanAt_ = millis() + LAN_RETRY_MS;
    session_.reset();
    return -1;
  }
  if (!keepAlive || statusCode != 202 || !complete || !http.connected()) session_.reset();
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

bool HomeBrainApi::parseConfigResponse(const String& body, RuntimeConfig& runtime) {
  DynamicJsonDocument response(3072);
  StaticJsonDocument<64> filter;
  filter["config"] = true;
  if (deserializeJson(response, body, DeserializationOption::Filter(filter))) return false;
  JsonVariantConst config = response["config"];
  if (config.isNull()) return false;
  const String origin = normalizedBaseUrl();
  IPAddress address(0, 0, 0, 0);
  if (origin.startsWith("https://") && address.fromString(config["hub_lan_ipv4"] | "") &&
      onWifiSubnet(address)) {
    if (lanAddress_ != address || lanOrigin_ != origin) {
      lanAddress_ = address;
      lanOrigin_ = origin;
      retryLanAt_ = 0;
      session_.reset();
    }
  } else {
    lanOrigin_ = "";
  }
  applyRuntimeConfig(config, runtime);
  const JsonVariantConst update = config["firmware_update"];
  runtime.firmwareUpdate.id = update["id"] | "";
  runtime.firmwareUpdate.version = update["version"] | "";
  runtime.firmwareUpdate.sha256 = update["sha256"] | "";
  runtime.firmwareUpdate.imageSha256 = update["image_sha256"] | "";
  runtime.firmwareUpdate.hardwareProfile = update["hardware_profile"] | "";
  runtime.firmwareUpdate.size = update["size"] | 0U;
  runtime.firmwareUpdate.protocol = update["protocol"] | 0;
  return true;
}

bool HomeBrainApi::reportFirmwareStatus(const String& id, const char* phase, uint8_t progress,
    const String& error, const String& imageSha256) {
  StaticJsonDocument<768> document;
  document["id"] = id;
  document["phase"] = phase;
  document["progress"] = progress;
  document["version"] = HOMEBRAIN_SENSOR_FIRMWARE_VERSION;
  document["imageSha256"] = imageSha256;
  document["error"] = error;
  String body, response;
  serializeJson(document, body);
  const int status = request("POST", String("/api/sensor-nodes/") + credentials_.nodeId + "/firmware/status", body, response, false);
  // A superseded job is also acknowledged: do not replay its status forever.
  return status == 410 || classifyResponse(status, response) == ApiResult::Success;
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
  document["ota_protocol"] = 1;
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
  // Climate's PCB has no VBUS sense line; it cannot report charging/USB state.
  if (runtime.profile != Profile::Climate) power["usb_powered"] = reading.usbPowered;

  JsonObject diagnostics = document.createNestedObject("diagnostics");
  diagnostics["signal_rssi_dbm"] = WiFi.RSSI();
  diagnostics["uptime_ms"] = millis();
  diagnostics["wake_count"] = wakeCount;
  diagnostics["free_heap_bytes"] = ESP.getFreeHeap();
  diagnostics["ip_address"] = WiFi.localIP().toString();
  sensors.addDiagnostics(diagnostics, reading);

  String requestBody;
  serializeJson(document, requestBody);
  String responseBody;
  const String path = String("/api/sensor-nodes/") + credentials_.nodeId + "/readings";
  const bool keepAlive = runtime.profile == Profile::Presence && runtime.reportingIntervalSeconds <= 60;
  const int statusCode = request("POST", path, requestBody, responseBody, false, keepAlive);
  const ApiResult result = classifyResponse(statusCode, responseBody);
  if (result != ApiResult::Success) {
    if (session_ && session_->localRoute) retryLanAt_ = millis() + LAN_RETRY_MS;
    session_.reset();
    return result;
  }
  if (parseConfigResponse(responseBody, runtime)) store_.saveRuntime(runtime);
  if (!runtime.firmwareUpdate.id.isEmpty() || runtime.profile != Profile::Presence
      || runtime.reportingIntervalSeconds > 60) session_.reset();
  return ApiResult::Success;
}

}  // namespace homebrain
