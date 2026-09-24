#pragma once
#include "HomeBrainApi.h"

namespace homebrain {
class SensorOta {
 public:
  void begin();
  bool awaitingConfirmation() const { return pendingVerification_; }
  void readingAccepted(HomeBrainApi& api);
  void maybeApply(HomeBrainApi& api, const AppCredentials& credentials,
    const RuntimeConfig& runtime, const SensorReading& reading);

 private:
  bool saveState(const String& phase, const String& error = "", bool reported = false);
  void reportSaved(HomeBrainApi& api);
  void fail(HomeBrainApi& api, const String& error);
  static void verificationDeadline(void* argument);
  Preferences preferences_;
  bool storageReady_ = false;
  volatile bool pendingVerification_ = false;
  String jobId_, targetImageSha_, phase_, error_;
  uint32_t targetAddress_ = 0;
  bool reported_ = false;
};
}
