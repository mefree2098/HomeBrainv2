#pragma once

#include "HomeBrainSensor.h"
#include "SensorSuite.h"
#include <WiFiClient.h>
#include <memory>
#include <functional>

namespace homebrain {

enum class ApiResult : uint8_t {
  Success,
  Unauthorized,
  RetryableFailure,
  InvalidResponse
};

class ScopedWifiAwake;

class HomeBrainApi {
 public:
  HomeBrainApi(AppCredentials& credentials, ConfigStore& store);
  ~HomeBrainApi();

  ApiResult activate(RuntimeConfig& runtime);
  ApiResult fetchConfig(RuntimeConfig& runtime);
  std::unique_ptr<WiFiClient> createHttpClient(bool requireTls = false) const;
  bool reportFirmwareStatus(const String& id, const char* phase, uint8_t progress,
    const String& error = "", const String& imageSha256 = "");
  ApiResult publish(
    const SensorReading& reading,
    SensorSuite& sensors,
    RuntimeConfig& runtime,
    uint64_t sequence,
    uint32_t wakeCount
  );

 private:
  int request(
    const String& method,
    const String& path,
    const String& requestBody,
    String& responseBody,
    bool useSetupCode,
    bool keepAlive = false,
    const std::function<void()>& pollSensors = {}
  );
  ApiResult classifyResponse(int statusCode, const String& body) const;
  bool parseConfigResponse(const String& body, RuntimeConfig& runtime);
  String normalizedBaseUrl() const;
  void addFloat(JsonObject target, const char* key, float value, uint8_t digits = 2) const;

  IPAddress lanAddress_;
  String lanOrigin_;
  uint32_t retryLanAt_ = 0;
  uint32_t lastUploadMs_ = 0;
  int lastUploadStatus_ = 0;
  std::unique_ptr<ScopedWifiAwake> wiredWifi_;
  struct RequestSession;
  std::unique_ptr<RequestSession> session_;
  AppCredentials& credentials_;
  ConfigStore& store_;
};

}  // namespace homebrain
