#pragma once

#include "HomeBrainSensor.h"
#include "SensorSuite.h"

#include <Arduino.h>

namespace homebrain {

struct UsbDiagnosticSummary {
  Profile profile = Profile::Auto;
  bool passed = false;
};

Profile detectUsbDiagnosticProfile();
UsbDiagnosticSummary runUsbBenchDiagnostic(SensorSuite& sensors, Profile requestedProfile, Print& output);
bool pollUsbDiagnosticConsole(SensorSuite& sensors, const RuntimeConfig& runtime, Print& output);
bool consumeUsbSetupRequest();

}  // namespace homebrain
