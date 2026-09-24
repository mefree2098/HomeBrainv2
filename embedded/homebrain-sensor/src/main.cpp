#include "HomeBrainApi.h"
#include "HomeBrainSensor.h"
#include "SensorSuite.h"
#include "UsbBenchDiagnostic.h"
#include "BleProvisioning.h"
#include "SensorOta.h"

#include <WiFi.h>
#include <esp_sleep.h>
#include <esp_wifi.h>

using namespace homebrain;

namespace {
constexpr uint32_t WIFI_RECONNECT_TIMEOUT_MS = 12000;
constexpr uint32_t FAILURE_RETRY_MS = 10000;
constexpr uint32_t UNPROVISIONED_USB_DIAGNOSTIC_WINDOW_MS = 12000;

RTC_DATA_ATTR uint32_t wakeCount = 0;
RTC_DATA_ATTR uint64_t readingSequence = 0;

ConfigStore configStore;
AppCredentials credentials;
RuntimeConfig runtimeConfig;
SensorSuite sensors;
SensorOta ota;
HomeBrainApi* api = nullptr;
uint32_t nextPublishAt = 0;
uint32_t lastPublishAt = 0;
bool pendingPresenceEvent = false;

bool runNetworkSetup(bool forceBluetooth) {
  const bool incomplete = credentials.hubUrl.isEmpty()
    || credentials.nodeId.isEmpty()
    || (credentials.deviceToken.isEmpty() && credentials.setupCode.isEmpty());
  if (forceBluetooth || incomplete) {
    return runBleProvisioning(credentials, configStore, runtimeConfig, sensors);
  }
  WiFi.mode(WIFI_STA);
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  esp_wifi_set_bandwidth(WIFI_IF_STA, WIFI_BW_HT20);
  WiFi.begin();
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_RECONNECT_TIMEOUT_MS) delay(50);
  return WiFi.status() == WL_CONNECTED;
}

void factoryResetIfRequested() {
  pinMode(PIN_SERVICE, INPUT_PULLUP);
  if (digitalRead(PIN_SERVICE) != LOW) return;
  const uint32_t startedAt = millis();
  while (digitalRead(PIN_SERVICE) == LOW && millis() - startedAt < 1800) delay(20);
  if (millis() - startedAt < 1500) return;

  Serial.println("Service input held: clearing Wi-Fi and HomeBrain provisioning.");
  WiFi.disconnect(true, true);
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
      // A candidate image must not erase the working image's registration.
      // Restarting an unconfirmed image lets the bootloader roll it back.
      if (ota.awaitingConfirmation()) return false;
      Serial.println("HomeBrain rejected the stored device token; setup is required again.");
      credentials.deviceToken = "";
      credentials.setupCode = "";
      configStore.clearDeviceToken();
    }
  }

  for (uint8_t attempt = 0; attempt < 2; ++attempt) {
    if (credentials.setupCode.isEmpty() || attempt > 0) {
      if (!runNetworkSetup(true)) return false;
      // BLE performs activation itself; do not consume the setup code twice.
      if (!credentials.deviceToken.isEmpty()) return true;
    }
    const ApiResult result = api->activate(runtimeConfig);
    if (result == ApiResult::Success) return true;
    Serial.println("Activation failed. Open Add HomeBrain Sensor in the app to retry Bluetooth setup.");
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
    if (!ota.awaitingConfirmation() && runtimeConfig.profile == Profile::Climate && runtimeConfig.deepSleepEnabled) enterDeepSleep(60);
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
    if (ota.awaitingConfirmation()) {
      ESP.restart();
      return;
    }
    Serial.println("The device token was revoked; use Add HomeBrain Sensor to claim it again.");
    configStore.clearDeviceToken();
    delay(500);
    ESP.restart();
  }

  const bool success = result == ApiResult::Success;
  if (success) {
    ota.readingAccepted(*api);
    ota.maybeApply(*api, credentials, runtimeConfig, reading);
  }
  lastPublishAt = millis();
  Serial.printf(
    "Reading %llu %s (%s, RSSI %d dBm).\n",
    readingSequence,
    success ? "accepted" : "failed",
    profileName(runtimeConfig.profile),
    WiFi.RSSI()
  );

  if (!ota.awaitingConfirmation() && runtimeConfig.profile == Profile::Climate && runtimeConfig.deepSleepEnabled) {
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
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    Serial.printf("Wi-Fi disconnected at %lu ms (reason %u).\n",
      static_cast<unsigned long>(millis()), info.wifi_sta_disconnected.reason);
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  ota.begin();
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

  Serial.println("USB diagnostics are built in. Type 'help' after normal startup; manual reset emits a fresh bench report.");
  const bool unprovisioned = credentials.nodeId.isEmpty()
    || (credentials.deviceToken.isEmpty() && credentials.setupCode.isEmpty());
  bool diagnosticRan = false;
  if (unprovisioned && runtimeConfig.profile == Profile::Auto) {
    Serial.println("Unprovisioned USB window: send 'diag air-station', 'diag presence', or 'diag climate' within 12 seconds.");
    const uint32_t diagnosticDeadline = millis() + UNPROVISIONED_USB_DIAGNOSTIC_WINDOW_MS;
    while (!diagnosticRan && static_cast<int32_t>(diagnosticDeadline - millis()) > 0) {
      diagnosticRan = pollUsbDiagnosticConsole(sensors, runtimeConfig, Serial);
      delay(10);
    }
  }
  if (!ota.awaitingConfirmation() && !diagnosticRan && esp_sleep_get_wakeup_cause() != ESP_SLEEP_WAKEUP_TIMER) {
    runUsbBenchDiagnostic(sensors, runtimeConfig.profile, Serial);
  }
  sensors.prepareForSleep();

  if (!runNetworkSetup(consumeUsbSetupRequest())) {
    Serial.println("Network setup unavailable. Existing registration is preserved. Type 'setup' over USB to reopen Bluetooth.");
    // Never reopen an unattended pairing window in a reboot loop.
    while (credentials.nodeId.isEmpty() || credentials.deviceToken.isEmpty()) {
      pollUsbDiagnosticConsole(sensors, runtimeConfig, Serial);
      if (consumeUsbSetupRequest()) runNetworkSetup(true);
      delay(20);
    }
  }

  static HomeBrainApi homeBrainApi(credentials, configStore);
  api = &homeBrainApi;
  if (!provisionWithHomeBrain()) {
    Serial.println("HomeBrain provisioning did not complete; restarting.");
    delay(1000);
    ESP.restart();
  }

  if (runtimeConfig.profile == Profile::Auto) runtimeConfig.profile = detectUsbDiagnosticProfile();

  configStore.saveRuntime(runtimeConfig);
  sensors.begin(runtimeConfig);
  nextPublishAt = millis();
  Serial.printf("Sensor profile ready: %s, report every %lu seconds.\n",
                profileName(runtimeConfig.profile),
                static_cast<unsigned long>(runtimeConfig.reportingIntervalSeconds));
}

void loop() {
  pollUsbDiagnosticConsole(sensors, runtimeConfig, Serial);
  if (consumeUsbSetupRequest()) {
    sensors.prepareForSleep();
    runNetworkSetup(true);
    sensors.begin(runtimeConfig);
    nextPublishAt = millis();
  }
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
