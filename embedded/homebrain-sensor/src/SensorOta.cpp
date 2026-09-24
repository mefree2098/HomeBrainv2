#include "SensorOta.h"
#include <WiFi.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>
#include <esp_ota_ops.h>
#include <esp_wifi.h>
#include <mbedtls/sha256.h>
#include <memory>
#include <type_traits>

#if !CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE
#error "HomeBrain sensor OTA requires a rollback-enabled bootloader"
#endif

// Override Arduino's default immediate validation; accept only after a reading
// reaches HomeBrain. Otherwise the bootloader restores the previous partition.
extern "C" bool verifyRollbackLater() { return true; }

namespace homebrain {
namespace {
constexpr char OTA_BUILD_MARKER[] = "HOMEBRAIN_SENSOR_OTA:1:seeed-xiao-esp32-c6:" HOMEBRAIN_SENSOR_FIRMWARE_VERSION;
constexpr uint32_t MAX_DOWNLOAD_MS = 600000;
constexpr uint32_t PROGRESS_REPORT_INTERVAL_MS = 15000;
constexpr unsigned MAX_DOWNLOAD_RECONNECTS = 8;
struct DownloadHeaders {
  String range;
  String sha256;
};
esp_err_t receiveDownloadHeader(esp_http_client_event_t* event) {
  if (event->event_id == HTTP_EVENT_ON_HEADER && event->user_data && event->header_key && event->header_value) {
    auto& headers = *static_cast<DownloadHeaders*>(event->user_data);
    if (strcasecmp(event->header_key, "Content-Range") == 0) headers.range = event->header_value;
    if (strcasecmp(event->header_key, "X-Content-SHA256") == 0) headers.sha256 = event->header_value;
  }
  return ESP_OK;
}
class OtaWifiPower {
 public:
  OtaWifiPower() : previous_(WiFi.getSleep()) { WiFi.setSleep(false); }
  ~OtaWifiPower() { WiFi.setSleep(previous_); }
 private:
  wifi_ps_type_t previous_;
};
String hexDigest(const uint8_t* bytes) {
  char hex[65];
  for (size_t i = 0; i < 32; ++i) snprintf(hex + i * 2, 3, "%02x", bytes[i]);
  return String(hex);
}
String partitionDigest(const esp_partition_t* partition) {
  uint8_t hash[32];
  return partition && esp_partition_get_sha256(partition, hash) == ESP_OK ? hexDigest(hash) : String();
}
bool validHex(const String& value, size_t length) {
  if (value.length() != length) return false;
  for (size_t i = 0; i < length; ++i) if (!isxdigit(value[i])) return false;
  return true;
}
bool validJobId(const String& id) {
  if (id.length() != 36) return false;
  for (size_t i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
    else if (!isxdigit(id[i])) return false;
  }
  return true;
}
}

bool SensorOta::saveState(const String& phase, const String& error, bool reported) {
  phase_ = phase; error_ = error; reported_ = reported;
  StaticJsonDocument<768> state;
  state["id"] = jobId_; state["sha"] = targetImageSha_;
  state["address"] = targetAddress_;
  state["phase"] = phase_; state["error"] = error_; state["reported"] = reported_;
  String json;
  serializeJson(state, json);
  return storageReady_ && preferences_.putString("state", json) == json.length();
}

void SensorOta::verificationDeadline(void* argument) {
  vTaskDelay(pdMS_TO_TICKS(120000));
  auto* ota = static_cast<SensorOta*>(argument);
  if (ota->pendingVerification_) {
    Serial.println("OTA: new firmware did not report within two minutes; rolling back.");
    esp_ota_mark_app_invalid_rollback_and_reboot();
    ESP.restart();
  }
  vTaskDelete(nullptr);
}

void SensorOta::begin() {
  Serial.println(OTA_BUILD_MARKER);
  storageReady_ = preferences_.begin("hbrain-ota", false);
  StaticJsonDocument<768> state;
  if (storageReady_ && !deserializeJson(state, preferences_.getString("state", "{}"))) {
    jobId_ = state["id"] | ""; targetImageSha_ = state["sha"] | "";
    targetAddress_ = state["address"] | 0U;
    phase_ = state["phase"] | ""; error_ = state["error"] | "";
    reported_ = state["reported"] | false;
  }
  esp_ota_img_states_t bootState;
  const auto* running = esp_ota_get_running_partition();
  pendingVerification_ = esp_ota_get_state_partition(running, &bootState) == ESP_OK
    && bootState == ESP_OTA_IMG_PENDING_VERIFY;
  if (pendingVerification_) {
    if (xTaskCreate(verificationDeadline, "ota-verify", 3072, this, 1, nullptr) != pdPASS) {
      esp_ota_mark_app_invalid_rollback_and_reboot();
    }
  } else if (!jobId_.isEmpty() && phase_ != "failed" && phase_ != "succeeded") {
    // Covers power loss during download, automatic boot rollback, and power
    // loss after validation but before the durable success acknowledgement.
    if (phase_ == "rebooting" && running->address == targetAddress_ && partitionDigest(running) == targetImageSha_) saveState("succeeded");
    else saveState("failed", "Update interrupted or rolled back; previous firmware is running.");
  }
}

void SensorOta::reportSaved(HomeBrainApi& api) {
  if (jobId_.isEmpty() || reported_ || (phase_ != "failed" && phase_ != "succeeded")) return;
  if (api.reportFirmwareStatus(jobId_, phase_.c_str(), phase_ == "succeeded" ? 100 : 0,
      error_, partitionDigest(esp_ota_get_running_partition()))) saveState(phase_, error_, true);
}

void SensorOta::readingAccepted(HomeBrainApi& api) {
  if (pendingVerification_) {
    const auto* running = esp_ota_get_running_partition();
    if (!targetImageSha_.isEmpty() && (running->address != targetAddress_ || partitionDigest(running) != targetImageSha_)) {
      esp_ota_mark_app_invalid_rollback_and_reboot();
      return;
    }
    if (esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) return;
    pendingVerification_ = false;
    if (!jobId_.isEmpty()) saveState("succeeded");
  }
  reportSaved(api);
}

void SensorOta::fail(HomeBrainApi& api, const String& error) {
  Serial.printf("OTA: %s\n", error.c_str());
  saveState("failed", error);
  reportSaved(api);
}

void SensorOta::maybeApply(HomeBrainApi& api, const AppCredentials& credentials,
    const RuntimeConfig& runtime, const SensorReading& reading) {
  const auto& job = runtime.firmwareUpdate;
  if (pendingVerification_ || job.id.isEmpty() || job.id == jobId_) return;
  if (!validJobId(job.id)) return;
  jobId_ = job.id; targetImageSha_ = job.imageSha256;
  targetAddress_ = 0;
  if (job.protocol != 1 || job.hardwareProfile != "seeed-xiao-esp32-c6"
      || !validHex(job.sha256, 64) || !validHex(job.imageSha256, 64)
      || job.size < 320 || job.size > 0x1D0000) { fail(api, "Invalid firmware manifest."); return; }
  if (runtime.profile == Profile::Climate && (!isfinite(reading.batteryVolts) || reading.batteryVolts < 3.6f)) {
    fail(api, "Charge the battery above 3.6 V, then retry the update."); return;
  }
  const auto* partition = esp_ota_get_next_update_partition(nullptr);
  if (!partition || job.size > partition->size) { fail(api, "Firmware does not fit the inactive slot."); return; }
  targetAddress_ = partition->address;
  if (!saveState("downloading")) { fail(api, "Cannot persist update recovery state."); return; }
  // Espressif's OTA examples disable modem power saving during the transfer.
  // Restore the normal policy when an update fails and reporting resumes.
  OtaWifiPower wifiPower;
  String base = credentials.hubUrl;
  while (base.endsWith("/")) base.remove(base.length() - 1);
  if (!base.startsWith("https://")) { fail(api, "OTA requires a trusted HTTPS connection to HomeBrain."); return; }
  api.reportFirmwareStatus(jobId_, "downloading", 0);

  // Erasing an entire slot can block long enough to lose the incoming TCP
  // stream. Finish preparing flash before asking the server to send the image.
  esp_ota_handle_t handle;
  const uint32_t eraseStarted = millis();
  if (esp_ota_begin(partition, job.size, &handle) != ESP_OK) {
    fail(api, "Cannot prepare the inactive firmware slot."); return;
  }
  Serial.printf("OTA: prepared inactive slot in %lu ms.\n",
    static_cast<unsigned long>(millis() - eraseStarted));

  // Construct the path ourselves. Never forward the sensor token to a URL from
  // a manifest, nor follow redirects to another host.
  const String url = base + "/api/sensor-nodes/" + credentials.nodeId + "/firmware/download/" + jobId_;
  esp_http_client_config_t config = {};
  config.url = url.c_str();
  config.timeout_ms = 15000;
  config.buffer_size = 4096;
  config.disable_auto_redirect = true;
  config.keep_alive_enable = true;
  config.event_handler = receiveDownloadHeader;
#ifdef HOMEBRAIN_SENSOR_CA_CERT
  config.cert_pem = HOMEBRAIN_SENSOR_CA_CERT;
#else
  config.crt_bundle_attach = esp_crt_bundle_attach;
#endif
  const String authorization = "Sensor " + credentials.deviceToken;
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  mbedtls_sha256_starts(&hash, 0);
  uint8_t buffer[2048];
  size_t received = 0;
  const uint32_t started = millis();
  uint32_t lastStatusAt = started;
  unsigned lastProgress = 0, connections = 0;
  String error;
  while (received < job.size && error.isEmpty() && millis() - started <= MAX_DOWNLOAD_MS) {
    if (connections++ > MAX_DOWNLOAD_RECONNECTS) { error = "Firmware connection could not recover. Retry the update."; break; }
    if (connections > 1) {
      Serial.printf("OTA: resuming at byte %lu (connection %u).\n", static_cast<unsigned long>(received), connections);
      delay(1000);
    }
    if (WiFi.status() != WL_CONNECTED) {
      WiFi.reconnect();
      const uint32_t reconnectStarted = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - reconnectStarted < 12000) delay(50);
      if (WiFi.status() != WL_CONNECTED) continue;
    }
    DownloadHeaders headers;
    config.user_data = &headers;
    // Each attempt owns its client; hash and flash position survive reconnects.
    std::unique_ptr<std::remove_pointer_t<esp_http_client_handle_t>, decltype(&esp_http_client_cleanup)>
      http(esp_http_client_init(&config), esp_http_client_cleanup);
    if (!http) { error = "Cannot open firmware download."; break; }
    esp_http_client_set_header(http.get(), "Authorization", authorization.c_str());
    esp_http_client_set_header(http.get(), "Accept-Encoding", "identity");
    if (received) {
      const String range = "bytes=" + String(static_cast<unsigned long>(received)) + "-";
      esp_http_client_set_header(http.get(), "Range", range.c_str());
    }
    const esp_err_t opened = esp_http_client_open(http.get(), 0);
    const int64_t length = opened == ESP_OK ? esp_http_client_fetch_headers(http.get()) : -1;
    const int status = esp_http_client_get_status_code(http.get());
    if (opened != ESP_OK || length < 0 || status >= 500) {
      Serial.printf("OTA: connection failed (open=%d, HTTP=%d, errno=%d, Wi-Fi=%d).\n",
        opened, status, esp_http_client_get_errno(http.get()), WiFi.status());
      continue;
    }
    const String expectedRange = "bytes " + String(static_cast<unsigned long>(received)) + "-"
      + String(job.size - 1) + "/" + String(job.size);
    if (status != (received ? 206 : 200) || length != job.size - received
        || headers.sha256 != job.sha256 || (received && headers.range != expectedRange)) {
      error = "Firmware response has the wrong image, length or byte range."; break;
    }
    uint32_t lastByteAt = millis();
    while (received < job.size && millis() - started <= MAX_DOWNLOAD_MS) {
      const int bytes = esp_http_client_read(http.get(), reinterpret_cast<char*>(buffer),
        std::min<size_t>(sizeof(buffer), job.size - received));
      if (bytes == -ESP_ERR_HTTP_EAGAIN || bytes == 0) {
        if (millis() - lastByteAt > 15000 || esp_http_client_is_complete_data_received(http.get())) break;
        delay(10); continue;
      }
      if (bytes < 0) {
        Serial.printf("OTA: stream error %d (errno %d, Wi-Fi %d, RSSI %d).\n",
          bytes, esp_http_client_get_errno(http.get()), WiFi.status(), WiFi.RSSI());
        break;
      }
      if (mbedtls_sha256_update(&hash, buffer, bytes) != 0 || esp_ota_write(handle, buffer, bytes) != ESP_OK) {
        error = "Writing firmware failed."; break;
      }
      received += bytes; lastByteAt = millis();
      const unsigned progress = min(99U, static_cast<unsigned>(received * 100 / job.size));
      // A progress POST opens another TLS connection and pauses this stream.
      // Report useful milestones instead of repeatedly interrupting a slow link.
      if (progress >= lastProgress + 10 && millis() - lastStatusAt > PROGRESS_REPORT_INTERVAL_MS) {
        Serial.printf("OTA: downloaded %u%%, RSSI %d dBm.\n", progress, WiFi.RSSI());
        const uint32_t statusStarted = millis();
        api.reportFirmwareStatus(jobId_, "downloading", progress);
        lastByteAt += millis() - statusStarted;
        lastStatusAt = millis();
        lastProgress = progress;
      }
      delay(1);
    }
  }
  if (received != job.size && error.isEmpty()) error = "Firmware download timed out.";
  uint8_t actualHash[32];
  mbedtls_sha256_finish(&hash, actualHash);
  mbedtls_sha256_free(&hash);
  Serial.printf("OTA: received %lu of %lu bytes in %lu ms.\n",
    static_cast<unsigned long>(received), static_cast<unsigned long>(job.size),
    static_cast<unsigned long>(millis() - started));
  if (error.isEmpty() && hexDigest(actualHash) != job.sha256) error = "Firmware SHA-256 verification failed.";
  if (!error.isEmpty()) { esp_ota_abort(handle); fail(api, error); return; }
  api.reportFirmwareStatus(jobId_, "installing", 100);
  if (esp_ota_end(handle) != ESP_OK || partitionDigest(partition) != job.imageSha256) {
    fail(api, "Firmware image validation failed."); return;
  }
  if (!saveState("rebooting")) { fail(api, "Cannot persist firmware boot confirmation."); return; }
  if (esp_ota_set_boot_partition(partition) != ESP_OK) { fail(api, "Cannot select the new firmware slot."); return; }
  api.reportFirmwareStatus(jobId_, "rebooting", 100);
  delay(100);
  ESP.restart();
}
}
