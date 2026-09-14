#include "HomeBrainApi.h"
#include "HomeBrainSensor.h"
#include "SensorSuite.h"
#include "UsbBenchDiagnostic.h"

#include <WiFi.h>
#include <WiFiManager.h>
#include <esp_sleep.h>

using namespace homebrain;

namespace {
constexpr char PORTAL_PASSWORD[] = "HomeBrainSetup";
constexpr uint32_t PORTAL_TIMEOUT_SECONDS = 600;
constexpr uint32_t WIFI_RECONNECT_TIMEOUT_MS = 12000;
constexpr uint32_t FAILURE_RETRY_MS = 10000;
constexpr uint32_t UNPROVISIONED_USB_DIAGNOSTIC_WINDOW_MS = 12000;

RTC_DATA_ATTR uint32_t wakeCount = 0;
RTC_DATA_ATTR uint64_t readingSequence = 0;

ConfigStore configStore;
AppCredentials credentials;
RuntimeConfig runtimeConfig;
SensorSuite sensors;
HomeBrainApi* api = nullptr;
uint32_t nextPublishAt = 0;
uint32_t lastPublishAt = 0;
bool pendingPresenceEvent = false;

String portalSsid() {
  String suffix = hardwareId();
  suffix = suffix.substring(suffix.length() - 6);
  return String("HomeBrain-Sensor-") + suffix;
}

void copyString(char* destination, size_t length, const String& source) {
  strlcpy(destination, source.c_str(), length);
}

bool runNetworkSetup(bool forcePortal) {
  char hubUrl[161] = {};
  char nodeId[97] = {};
  char setupCode[49] = {};
  copyString(hubUrl, sizeof(hubUrl), credentials.hubUrl);
  copyString(nodeId, sizeof(nodeId), credentials.nodeId);
  copyString(setupCode, sizeof(setupCode), credentials.setupCode);

  WiFiManager manager;
  WiFiManagerParameter intro("<p>Paste the three values shown in HomeBrain &rarr; Settings &rarr; Sensor Fleet.</p>");
  WiFiManagerParameter hubParameter("hub", "HomeBrain hub URL", hubUrl, sizeof(hubUrl) - 1);
  WiFiManagerParameter nodeParameter("node", "Sensor node ID", nodeId, sizeof(nodeId) - 1);
  WiFiManagerParameter setupParameter(
    "setup",
    "One-time setup code",
    setupCode,
    sizeof(setupCode) - 1,
    "type='text' autocapitalize='characters'"
  );
  manager.addParameter(&intro);
  manager.addParameter(&hubParameter);
  manager.addParameter(&nodeParameter);
  manager.addParameter(&setupParameter);
  manager.setConfigPortalTimeout(PORTAL_TIMEOUT_SECONDS);
  manager.setConnectTimeout(30);
  manager.setConnectRetries(3);
  manager.setHostname(portalSsid().c_str());
  manager.setTitle("HomeBrain Sensor Setup");
  manager.setClass("invert");

  bool saveParameters = false;
  manager.setSaveParamsCallback([&saveParameters]() { saveParameters = true; });

  const String ssid = portalSsid();
  const bool incomplete = credentials.hubUrl.isEmpty()
    || credentials.nodeId.isEmpty()
    || (credentials.deviceToken.isEmpty() && credentials.setupCode.isEmpty());
  const bool connected = (forcePortal || incomplete)
    ? manager.startConfigPortal(ssid.c_str(), PORTAL_PASSWORD)
    : manager.autoConnect(ssid.c_str(), PORTAL_PASSWORD);

  if (saveParameters) {
    credentials.hubUrl = hubParameter.getValue();
    credentials.nodeId = nodeParameter.getValue();
    credentials.setupCode = setupParameter.getValue();
    credentials.hubUrl.trim();
    credentials.nodeId.trim();
    credentials.setupCode.trim();
    while (credentials.hubUrl.endsWith("/")) {
      credentials.hubUrl.remove(credentials.hubUrl.length() - 1);
    }
    configStore.saveCredentials(credentials);
  }
  return connected && WiFi.status() == WL_CONNECTED;
}

void factoryResetIfRequested() {
  pinMode(PIN_SERVICE, INPUT_PULLUP);
  if (digitalRead(PIN_SERVICE) != LOW) return;
  const uint32_t startedAt = millis();
  while (digitalRead(PIN_SERVICE) == LOW && millis() - startedAt < 1800) delay(20);
  if (millis() - startedAt < 1500) return;

  Serial.println("Service input held: clearing Wi-Fi and HomeBrain provisioning.");
  WiFiManager manager;
  manager.resetSettings();
  configStore.clearAll();
  delay(250);
  ESP.restart();
}

bool reconnectWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  WiFi.reconnect();
  const uint32_t deadline = millis() + WIFI_RECONNECT_TIMEOUT_MS;
  while (WiFi.status() != WL_CONNECTED && static_cast<int32_t>(deadline - millis()) > 0) {
    sensors.poll(runtimeConfig);
    delay(50);
  }
  return WiFi.status() == WL_CONNECTED;
}

void enterDeepSleep(uint32_t sleepSeconds) {
  sensors.prepareForSleep();
  WiFi.disconnect(false, false);
  WiFi.mode(WIFI_OFF);
  const uint64_t durationUs = static_cast<uint64_t>(constrain(sleepSeconds, 10U, 86400U)) * 1000000ULL;
  Serial.printf("Sleeping for %lu seconds.\n", static_cast<unsigned long>(sleepSeconds));
  Serial.flush();
  esp_sleep_enable_timer_wakeup(durationUs);
  esp_deep_sleep_start();
}

bool provisionWithHomeBrain() {
  if (!credentials.deviceToken.isEmpty()) {
    const ApiResult result = api->fetchConfig(runtimeConfig);
    if (result == ApiResult::Success || result == ApiResult::RetryableFailure) return true;
    if (result == ApiResult::Unauthorized) {
      Serial.println("HomeBrain rejected the stored device token; setup is required again.");
      credentials.deviceToken = "";
      credentials.setupCode = "";
      configStore.clearDeviceToken();
    }
  }

  for (uint8_t attempt = 0; attempt < 2; ++attempt) {
    if (credentials.setupCode.isEmpty() || attempt > 0) {
      if (!runNetworkSetup(true)) return false;
    }
    const ApiResult result = api->activate(runtimeConfig);
    if (result == ApiResult::Success) return true;
    Serial.println("Activation failed. Reopening the setup portal so the provisioning values can be corrected.");
  }
  return false;
}

void publishNow() {
  const Profile previousProfile = runtimeConfig.profile;
  const SensorReading reading = sensors.capture(runtimeConfig);
  ++readingSequence;

  if (!reconnectWifi()) {
    Serial.println("Wi-Fi reconnect failed; reading will be retried on the next cycle.");
    nextPublishAt = millis() + FAILURE_RETRY_MS;
    if (runtimeConfig.profile == Profile::Climate && runtimeConfig.deepSleepEnabled) enterDeepSleep(60);
    return;
  }

  const ApiResult result = api->publish(
    reading,
    sensors,
    runtimeConfig,
    readingSequence,
    wakeCount
  );
  if (result == ApiResult::Unauthorized) {
    Serial.println("The device token was revoked; hold SERVICE to GND during boot and enter the new setup code.");
    configStore.clearDeviceToken();
    delay(500);
    ESP.restart();
  }

  const bool success = result == ApiResult::Success;
  lastPublishAt = millis();
  Serial.printf(
    "Reading %llu %s (%s, RSSI %d dBm).\n",
    readingSequence,
    success ? "accepted" : "failed",
    profileName(runtimeConfig.profile),
    WiFi.RSSI()
  );

  if (runtimeConfig.profile == Profile::Climate && runtimeConfig.deepSleepEnabled) {
    enterDeepSleep(success ? runtimeConfig.reportingIntervalSeconds : 60);
  }
  if (runtimeConfig.profile != previousProfile) {
    Serial.println("Sensor profile changed; restarting to reconfigure hardware buses.");
    delay(250);
    ESP.restart();
  }
  nextPublishAt = millis() + (success
    ? runtimeConfig.reportingIntervalSeconds * 1000UL
    : FAILURE_RETRY_MS);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(250);
  ++wakeCount;
  Serial.printf("\nHomeBrain Sensor %s, wake %lu, hardware %s\n",
                HOMEBRAIN_SENSOR_FIRMWARE_VERSION,
                static_cast<unsigned long>(wakeCount),
                hardwareId().c_str());

  if (!configStore.begin()) {
    Serial.println("Could not open persistent configuration; restarting.");
    delay(1000);
    ESP.restart();
  }
  configStore.load(credentials, runtimeConfig);
  factoryResetIfRequested();

  Serial.println("USB diagnostics are built in. Type 'help' after normal startup; resetting always emits a fresh bench report.");
  const bool unprovisioned = credentials.nodeId.isEmpty()
    || (credentials.deviceToken.isEmpty() && credentials.setupCode.isEmpty());
  bool diagnosticRan = false;
  if (unprovisioned && runtimeConfig.profile == Profile::Auto) {
    Serial.println("Unprovisioned USB window: send 'diag air-station' within 12 seconds to force the Atmosphere test.");
    const uint32_t diagnosticDeadline = millis() + UNPROVISIONED_USB_DIAGNOSTIC_WINDOW_MS;
    while (!diagnosticRan && static_cast<int32_t>(diagnosticDeadline - millis()) > 0) {
      diagnosticRan = pollUsbDiagnosticConsole(sensors, runtimeConfig, Serial);
      delay(10);
    }
  }
  if (!diagnosticRan) {
    runUsbBenchDiagnostic(sensors, runtimeConfig.profile, Serial);
  }
  sensors.prepareForSleep();

  if (!runNetworkSetup(false)) {
    Serial.println("Wi-Fi setup timed out; restarting.");
    delay(1000);
    ESP.restart();
  }

  static HomeBrainApi homeBrainApi(credentials, configStore);
  api = &homeBrainApi;
  if (!provisionWithHomeBrain()) {
    Serial.println("HomeBrain provisioning did not complete; restarting.");
    delay(1000);
    ESP.restart();
  }

  configStore.saveRuntime(runtimeConfig);
  sensors.begin(runtimeConfig);
  nextPublishAt = millis();
  Serial.printf("Sensor profile ready: %s, report every %lu seconds.\n",
                profileName(runtimeConfig.profile),
                static_cast<unsigned long>(runtimeConfig.reportingIntervalSeconds));
}

void loop() {
  pollUsbDiagnosticConsole(sensors, runtimeConfig, Serial);
  sensors.poll(runtimeConfig);
  const uint32_t now = millis();
  if (runtimeConfig.profile == Profile::Presence && sensors.presenceChanged()) {
    pendingPresenceEvent = true;
  }
  const bool regularReportDue = static_cast<int32_t>(now - nextPublishAt) >= 0;
  const bool presenceEventDue = runtimeConfig.profile == Profile::Presence
    && pendingPresenceEvent
    && (lastPublishAt == 0 || now - lastPublishAt >= 1000);
  if (regularReportDue || presenceEventDue) {
    pendingPresenceEvent = false;
    publishNow();
  }
  delay(10);
}
