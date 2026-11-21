#pragma once

#include <WiFi.h>

namespace homebrain {

// Keep acknowledgements flowing throughout TLS transfers, then restore the
// previous modem power mode, including on connection failures and early returns.
class ScopedWifiAwake {
 public:
  ScopedWifiAwake() : previous_(WiFi.getSleep()) {
    if (previous_ != WIFI_PS_NONE) WiFi.setSleep(false);
  }

  ~ScopedWifiAwake() {
    if (previous_ != WIFI_PS_NONE) WiFi.setSleep(previous_);
  }

  ScopedWifiAwake(const ScopedWifiAwake&) = delete;
  ScopedWifiAwake& operator=(const ScopedWifiAwake&) = delete;

 private:
  wifi_ps_type_t previous_;
};

}  // namespace homebrain
