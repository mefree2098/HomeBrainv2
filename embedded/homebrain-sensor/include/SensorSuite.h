#pragma once

#include "HomeBrainSensor.h"

#include <Adafruit_BME680.h>
#include <Adafruit_VEML7700.h>
#include <DHT.h>
#include <SensirionI2cScd4x.h>
#include <Wire.h>
#include <ld2410.h>

namespace homebrain {

class SensorSuite {
 public:
  SensorSuite();

  void begin(const RuntimeConfig& config);
  void poll(const RuntimeConfig& config);
  SensorReading capture(const RuntimeConfig& config);
  void addCapabilities(JsonArray target) const;
  void addDiagnostics(JsonObject target, const SensorReading& reading) const;
  bool presenceChanged();
  bool currentPresence(const RuntimeConfig& config);
  bool testPmsCommandPath();
  void prepareForSleep();

 private:
  struct PmSample {
    float pm1 = NAN;
    float pm25 = NAN;
    float pm10 = NAN;
    uint32_t updatedAt = 0;
  };

  bool probeI2c(uint8_t address);
  bool initializeBme680();
  bool initializeScd41(const RuntimeConfig& config);
  void initializeUart(Profile profile);
  void feedPms(uint8_t value);
  void readPmsStream();
  void updateRadar(const RuntimeConfig& config);
  void addDerivedMetrics(SensorReading& reading);
  void addAirQualityMetrics(SensorReading& reading);
  float readBatteryVolts();

  DHT dht_;
  Adafruit_BME680 bme680_;
  Adafruit_VEML7700 veml7700_;
  SensirionI2cScd4x scd41_;
  HardwareSerial sensorUart_;
  ld2410 radar_;

  Profile activeProfile_ = Profile::Auto;
  bool dhtReady_ = false;
  bool bmeReady_ = false;
  bool scdReady_ = false;
  bool scdStarted_ = false;
  bool vemlReady_ = false;
  bool radarReady_ = false;
  bool pmsReady_ = false;
  bool initialized_ = false;
  bool lastReportedPresence_ = false;
  bool presenceTransition_ = false;
  uint32_t lastPresenceAt_ = 0;
  uint32_t lastRadarFrameAt_ = 0;
  float gasBaselineOhms_ = NAN;
  float lastCo2Ppm_ = NAN;
  float lastScdTemperatureC_ = NAN;
  float lastScdHumidityPct_ = NAN;
  PmSample pm_;

  uint8_t pmsFrame_[32] = {};
  uint8_t pmsPosition_ = 0;
  uint32_t pmsFrameCount_ = 0;
};

}  // namespace homebrain
