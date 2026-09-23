#include "BleProvisioning.h"
#include "HomeBrainApi.h"
#include "UsbBenchDiagnostic.h"

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLESecurity.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <freertos/semphr.h>
#include <atomic>

namespace homebrain {
namespace {
constexpr char SERVICE_UUID[] = "9c2f0001-7d1b-4a2f-9d3b-0f91e6a3b805";
constexpr char INFO_UUID[] = "9c2f0002-7d1b-4a2f-9d3b-0f91e6a3b805";
constexpr char COMMAND_UUID[] = "9c2f0003-7d1b-4a2f-9d3b-0f91e6a3b805";
constexpr char RESPONSE_UUID[] = "9c2f0004-7d1b-4a2f-9d3b-0f91e6a3b805";
constexpr size_t MAX_FRAME = 1536;
constexpr uint32_t WINDOW_MS = 10 * 60 * 1000;
SemaphoreHandle_t inboxMutex = nullptr;
String incoming;
String pending;
bool droppingFrame = false;
std::atomic<bool> acceptingConnections{false};
BLECharacteristic* responseCharacteristic = nullptr;

class Commands : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    const String part = characteristic->getValue();
    xSemaphoreTake(inboxMutex, portMAX_DELAY);
    for (size_t i = 0; i < part.length(); ++i) {
      const char ch = part[i];
      if (ch == '\n') {
        if (!droppingFrame && pending.isEmpty()) pending = incoming;
        incoming = "";
        droppingFrame = false;
      } else if (!droppingFrame) {
        if (incoming.length() >= MAX_FRAME) { incoming = ""; droppingFrame = true; }
        else incoming += ch;
      }
    }
    xSemaphoreGive(inboxMutex);
  }
};

class Connections : public BLEServerCallbacks {
  void onDisconnect(BLEServer*) override {
    xSemaphoreTake(inboxMutex, portMAX_DELAY);
    incoming = "";
    pending = "";
    droppingFrame = false;
    xSemaphoreGive(inboxMutex);
    if (acceptingConnections) BLEDevice::startAdvertising();
  }
};
Commands commands;
Connections connections;

void reply(uint32_t id, const char* state, const char* error = nullptr) {
  StaticJsonDocument<384> value;
  value["id"] = id;
  value["state"] = state;
  if (error) value["error"] = error;
  String encoded;
  serializeJson(value, encoded);
  responseCharacteristic->setValue(encoded);
}

bool bounded(JsonVariantConst value, size_t minimum, size_t maximum) {
  if (!value.is<const char*>()) return false;
  const String text = value.as<String>();
  return text.length() >= minimum && text.length() <= maximum && text.indexOf('\n') < 0 && text.indexOf('\r') < 0;
}
}

bool runBleProvisioning(AppCredentials& credentials, ConfigStore& store, RuntimeConfig& runtime, SensorSuite& sensors) {
  const bool configured = !credentials.nodeId.isEmpty() && !credentials.deviceToken.isEmpty();
  const Profile detected = runtime.profile == Profile::Auto ? detectUsbDiagnosticProfile() : runtime.profile;
  const String name = String("HomeBrain-") + hardwareId().substring(hardwareId().length() - 6);
  if (!inboxMutex) inboxMutex = xSemaphoreCreateMutex();
  incoming = "";
  pending = "";
  droppingFrame = false;
  BLEDevice::init(name);
  BLEDevice::setMTU(247);
  // Standard LE Secure Connections, encrypted GATT writes. This board has no
  // display/keypad: Just Works does not claim MITM authentication. Setup is
  // physically limited to an unclaimed boot or explicit local setup request.
  BLESecurity::setAuthenticationMode(false, false, true);
  BLESecurity::setCapability(ESP_IO_CAP_NONE);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(&connections);
  BLEService* service = server->createService(SERVICE_UUID);
  BLECharacteristic* info = service->createCharacteristic(INFO_UUID, BLECharacteristic::PROPERTY_READ);
  BLECharacteristic* command = service->createCharacteristic(COMMAND_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_ENC);
  responseCharacteristic = service->createCharacteristic(RESPONSE_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_READ_ENC);
  command->setCallbacks(&commands);
  StaticJsonDocument<512> identity;
  identity["protocol"] = 1;
  identity["hardwareId"] = hardwareId();
  identity["firmwareVersion"] = HOMEBRAIN_SENSOR_FIRMWARE_VERSION;
  identity["profile"] = profileName(detected);
  identity["configured"] = configured;
  if (configured) identity["nodeId"] = credentials.nodeId;
  String encoded;
  serializeJson(identity, encoded);
  info->setValue(encoded);
  reply(0, "ready");
  service->start();
  auto* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  acceptingConnections = true;
  advertising->start();
  Serial.printf("Bluetooth setup ready: %s (10-minute local setup window). No credentials are printed.\n", name.c_str());
  WiFi.mode(WIFI_STA);

  bool success = false;
  uint32_t scanId = 0;
  bool scanning = false;
  int networkCount = 0;
  const uint32_t started = millis();
  while (millis() - started < WINDOW_MS) {
    if (pollUsbDiagnosticConsole(sensors, runtime, Serial)) sensors.prepareForSleep();
    consumeUsbSetupRequest(); // Already in the local setup window.
    if (scanning) {
      const int result = WiFi.scanComplete();
      if (result != WIFI_SCAN_RUNNING) {
        scanning = false;
        networkCount = result < 0 ? 0 : result;
        reply(scanId, result < 0 ? "error" : "scanned", result < 0 ? "Wi-Fi scan failed. Try again." : nullptr);
      }
    }
    String frame;
    xSemaphoreTake(inboxMutex, portMAX_DELAY);
    if (!pending.isEmpty()) { frame = pending; pending = ""; }
    xSemaphoreGive(inboxMutex);
    if (frame.isEmpty()) { delay(10); continue; }
    DynamicJsonDocument request(2304);
    if (deserializeJson(request, frame)) { reply(0, "error", "Invalid setup request."); continue; }
    frame = "";
    const uint32_t id = request["id"] | 0U;
    const String op = request["op"] | "";
    if (op == "scan") {
      if (scanning) { reply(id, "error", "Scan already running."); continue; }
      WiFi.scanDelete();
      scanId = id;
      scanning = true;
      reply(id, "scanning");
      const int result = WiFi.scanNetworks(true);
      if (result == WIFI_SCAN_FAILED) { scanning = false; reply(id, "error", "Wi-Fi scan failed."); }
    } else if (op == "cancel") {
      reply(id, "cancelled");
      delay(500);
      break;
    } else if (op == "networks") {
      if (scanning) { reply(id, "error", "Scan is not ready."); continue; }
      const int offset = constrain(request["offset"] | 0, 0, networkCount);
      StaticJsonDocument<1024> page;
      page["id"] = id;
      page["state"] = "networks";
      JsonArray items = page.createNestedArray("networks");
      int next = offset;
      // Two SSIDs keep even control-character escaped data below 512 bytes.
      while (next < networkCount && items.size() < 2) {
        const String ssid = WiFi.SSID(next);
        if (!ssid.isEmpty()) {
          JsonObject item = items.createNestedObject();
          item["ssid"] = ssid;
          item["rssi"] = WiFi.RSSI(next);
          item["secure"] = WiFi.encryptionType(next) != WIFI_AUTH_OPEN;
        }
        ++next;
      }
      page["next"] = next < networkCount ? next : -1;
      String result;
      serializeJson(page, result);
      responseCharacteristic->setValue(result);
    } else if (op == "configure") {
      if (!bounded(request["ssid"], 1, 32) || !bounded(request["password"], 0, 64)
          || !bounded(request["hubUrl"], 9, 160) || !bounded(request["nodeId"], 24, 24)
          || !bounded(request["setupCode"], configured ? 0 : 1, 48)) {
        reply(id, "error", "Invalid network or registration. Retry setup from HomeBrain."); continue;
      }
      AppCredentials candidate = credentials;
      const String hub = request["hubUrl"].as<String>();
      const String node = request["nodeId"].as<String>();
      if (!hub.startsWith("https://") || hub.indexOf('@') >= 0 || hub.indexOf('?', 8) >= 0 || hub.indexOf('#') >= 0) {
        reply(id, "error", "Bluetooth onboarding requires an HTTPS HomeBrain address."); continue;
      }
      bool validNode = true;
      for (size_t i = 0; i < node.length(); ++i) if (!isxdigit(static_cast<unsigned char>(node[i]))) validNode = false;
      bool validHub = hub.length() > 8;
      for (size_t i = 8; i < hub.length(); ++i) {
        const char c = hub[i];
        if (!isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '.' && c != ':' && c != '/') validHub = false;
      }
      if (!validNode || !validHub || hub[8] == '/' || hub[8] == ':') {
        reply(id, "error", "Invalid HomeBrain registration address."); continue;
      }
      if (configured && (hub != credentials.hubUrl || node != credentials.nodeId)) {
        reply(id, "error", "This device belongs to another registration. Existing credentials were preserved."); continue;
      }
      candidate.hubUrl = hub;
      candidate.nodeId = node;
      if (!configured) candidate.setupCode = request["setupCode"].as<String>();
      String ssid = request["ssid"].as<String>();
      String password = request["password"].as<String>();
      request.clear();
      acceptingConnections = false;
      advertising->stop();
      if (scanning) { WiFi.scanDelete(); scanning = false; }
      wifi_config_t previousWifi = {};
      const bool hadWifi = esp_wifi_get_config(WIFI_IF_STA, &previousWifi) == ESP_OK;
      WiFi.persistent(false);
      reply(id, "connecting");
      WiFi.begin(ssid.c_str(), password.c_str());
      password = "";
      ssid = "";
      const uint32_t connectStarted = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - connectStarted < 30000) delay(50);
      RuntimeConfig candidateRuntime = runtime;
      if (WiFi.status() == WL_CONNECTED) {
        reply(id, "activating");
        HomeBrainApi candidateApi(candidate, store);
        const ApiResult result = configured ? candidateApi.fetchConfig(candidateRuntime) : candidateApi.activate(candidateRuntime);
        success = result == ApiResult::Success;
      }
      if (success) {
        // Persist Wi-Fi only after the network AND authenticated hub work.
        wifi_config_t acceptedWifi = {};
        esp_wifi_get_config(WIFI_IF_STA, &acceptedWifi);
        esp_wifi_set_storage(WIFI_STORAGE_FLASH);
        esp_wifi_set_config(WIFI_IF_STA, &acceptedWifi);
        memset(&acceptedWifi, 0, sizeof(acceptedWifi));
        memset(&previousWifi, 0, sizeof(previousWifi));
        credentials = candidate;
        runtime = candidateRuntime;
        store.saveCredentials(credentials);
        store.saveRuntime(runtime);
        reply(id, "complete");
        Serial.println("Bluetooth setup complete; HomeBrain activation verified.");
        delay(3000); // Let the client read the terminal status before disconnecting.
        break;
      }
      if (hadWifi) {
        esp_wifi_set_config(WIFI_IF_STA, &previousWifi);
        esp_wifi_connect();
      }
      memset(&previousWifi, 0, sizeof(previousWifi));
      reply(id, "error", "Could not connect to Wi-Fi or HomeBrain. Check the password and internet access, then retry.");
      acceptingConnections = true;
      if (server->getConnectedCount() == 0) advertising->start();
    } else {
      reply(id, "error", "Unsupported setup operation.");
    }
  }
  acceptingConnections = false;
  advertising->stop();
  WiFi.scanDelete();
  BLEDevice::deinit(false);
  responseCharacteristic = nullptr;
  incoming = "";
  pending = "";
  return success;
}
}
