#pragma once

#include "HomeBrainSensor.h"

namespace homebrain {
class SensorSuite;
// Only called for an unclaimed board or a physical/USB-requested setup window.
// Keeps existing credentials on cancellation; never exports device tokens.
bool runBleProvisioning(AppCredentials& credentials, ConfigStore& store, RuntimeConfig& runtime, SensorSuite& sensors);
}
