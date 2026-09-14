#pragma once

#include "HomeBrainSensor.h"
#include "SensorSuite.h"

namespace homebrain {

enum class ApiResult : uint8_t {
  Success,
  Unauthorized,
  RetryableFailure,
  InvalidResponse
};

class HomeBrainApi {
 public:
  HomeBrainApi(AppCredentials& credentials, ConfigStore& store);

  ApiResult activate(RuntimeConfig& runtime);
  ApiResult fetchConfig(RuntimeConfig& runtime);
  ApiResult publish(
    const SensorReading& reading,
    const SensorSuite& sensors,
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
    bool useSetupCode
  );
  ApiResult classifyResponse(int statusCode, const String& body) const;
  bool parseConfigResponse(const String& body, RuntimeConfig& runtime) const;
  String normalizedBaseUrl() const;
  void addFloat(JsonObject target, const char* key, float value, uint8_t digits = 2) const;

  AppCredentials& credentials_;
  ConfigStore& store_;
};

}  // namespace homebrain
