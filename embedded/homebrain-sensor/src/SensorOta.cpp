#include "SensorOta.h"
#include <HTTPClient.h>
#include <esp_ota_ops.h>
#include <mbedtls/sha256.h>

#if !CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE
#error "HomeBrain sensor OTA requires a rollback-enabled bootloader"
#endif

// Override Arduino's default immediate validation; accept only after a reading
// reaches HomeBrain. Otherwise the bootloader restores the previous partition.
extern "C" bool verifyRollbackLater() { return true; }

namespace homebrain {
namespace {
constexpr char OTA_BUILD_MARKER[] = "HOMEBRAIN_SENSOR_OTA:1:seeed-xiao-esp32-c6:" HOMEBRAIN_SENSOR_FIRMWARE_VERSION;
constexpr uint32_t MAX_DOWNLOAD_MS = 180000;
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
  auto client = api.createHttpClient(true);
  if (!client) { fail(api, "OTA requires a trusted HTTPS connection to HomeBrain."); return; }
  api.reportFirmwareStatus(jobId_, "downloading", 0);

  String base = credentials.hubUrl;
  while (base.endsWith("/")) base.remove(base.length() - 1);
  // Construct the path ourselves. Never forward the sensor token to a URL from
  // a manifest, nor follow redirects to another host.
  HTTPClient http;
  http.setConnectTimeout(10000); http.setTimeout(15000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  const String path = "/api/sensor-nodes/" + credentials.nodeId + "/firmware/download/" + jobId_;
  if (!http.begin(*client, base + path)) { fail(api, "Cannot open firmware download."); return; }
  http.addHeader("Authorization", "Sensor " + credentials.deviceToken);
  http.addHeader("Accept-Encoding", "identity");
  const int status = http.GET();
  if (status != 200 || http.getSize() != static_cast<int>(job.size)) {
    http.end(); client.reset(); fail(api, "Firmware download failed or has the wrong length."); return;
  }
  esp_ota_handle_t handle;
  if (esp_ota_begin(partition, job.size, &handle) != ESP_OK) {
    http.end(); client.reset(); fail(api, "Cannot prepare the inactive firmware slot."); return;
  }
  mbedtls_sha256_context hash;
  mbedtls_sha256_init(&hash);
  mbedtls_sha256_starts(&hash, 0);
  uint8_t buffer[2048];
  size_t received = 0;
  const uint32_t started = millis();
  uint32_t lastByteAt = started, lastStatusAt = started;
  String error;
  auto* stream = http.getStreamPtr();
  while (received < job.size) {
    if (millis() - started > MAX_DOWNLOAD_MS || millis() - lastByteAt > 15000) { error = "Firmware download timed out."; break; }
    const size_t available = stream->available();
    if (!available) {
      if (!http.connected()) { error = "Firmware download was interrupted."; break; }
      delay(10); continue;
    }
    const size_t bytes = stream->readBytes(buffer, std::min<size_t>(sizeof(buffer), std::min<size_t>(available, job.size - received)));
    if (!bytes) continue;
    if (mbedtls_sha256_update(&hash, buffer, bytes) != 0 || esp_ota_write(handle, buffer, bytes) != ESP_OK) {
      error = "Writing firmware failed."; break;
    }
    received += bytes; lastByteAt = millis();
    if (millis() - lastStatusAt > 5000) {
      api.reportFirmwareStatus(jobId_, "downloading", min(99U, static_cast<unsigned>(received * 100 / job.size)));
      lastStatusAt = millis();
    }
    delay(1);
  }
  uint8_t actualHash[32];
  mbedtls_sha256_finish(&hash, actualHash);
  mbedtls_sha256_free(&hash);
  http.end(); client.reset();
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
