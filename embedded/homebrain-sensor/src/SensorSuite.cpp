#include "SensorSuite.h"

#include <math.h>

namespace homebrain {

namespace {
constexpr uint8_t BME_ADDRESS_PRIMARY = 0x76;
constexpr uint8_t BME_ADDRESS_SECONDARY = 0x77;
constexpr uint8_t SCD41_ADDRESS = 0x62;
constexpr uint8_t VEML7700_ADDRESS = 0x10;
constexpr uint32_t PMS_SAMPLE_MAX_AGE_MS = 15000;

float clampFloat(float value, float minimum, float maximum) {
  return fmaxf(minimum, fminf(maximum, value));
}

float dewPoint(float temperatureC, float humidityPct) {
  if (!isfinite(temperatureC) || !isfinite(humidityPct) || humidityPct <= 0.0f) return NAN;
  constexpr float a = 17.62f;
  constexpr float b = 243.12f;
  const float gamma = logf(humidityPct / 100.0f) + (a * temperatureC) / (b + temperatureC);
  return (b * gamma) / (a - gamma);
}

float absoluteHumidity(float temperatureC, float humidityPct) {
  if (!isfinite(temperatureC) || !isfinite(humidityPct)) return NAN;
  const float saturation = 6.112f * expf((17.67f * temperatureC) / (temperatureC + 243.5f));
  return (saturation * humidityPct * 2.1674f) / (273.15f + temperatureC);
}
}  // namespace

SensorSuite::SensorSuite()
  : dht_(PIN_DHT_DATA, DHT11),
    bme680_(&Wire),
    sensorUart_(1) {}

void SensorSuite::begin(const RuntimeConfig& config) {
  if (initialized_) prepareForSleep();
  dhtReady_ = false;
  bmeReady_ = false;
  scdReady_ = false;
  scdStarted_ = false;
  vemlReady_ = false;
  radarReady_ = false;
  pmsReady_ = false;
  pm_ = {};
  pmsPosition_ = 0;
  pmsFrameCount_ = 0;
  lastCo2Ppm_ = NAN;
  lastScdTemperatureC_ = NAN;
  lastScdHumidityPct_ = NAN;
  lastPresenceAt_ = 0;
  lastRadarFrameAt_ = 0;
  lastReportedPresence_ = false;
  presenceTransition_ = false;
  activeProfile_ = config.profile;
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);

  if (config.profile == Profile::Climate || config.profile == Profile::Presence) {
    pinMode(PIN_DHT_POWER, OUTPUT);
    digitalWrite(PIN_DHT_POWER, HIGH);
    delay(1200);
    dht_.begin();
    dhtReady_ = true;
  }

  bmeReady_ = initializeBme680();
  scdReady_ = initializeScd41(config);
  if (probeI2c(VEML7700_ADDRESS)) {
    vemlReady_ = veml7700_.begin(&Wire);
    if (vemlReady_) {
      veml7700_.setGain(VEML7700_GAIN_1_8);
      veml7700_.setIntegrationTime(VEML7700_IT_100MS);
    }
  }
  initializeUart(config.profile);

  if (config.profile == Profile::Climate) {
    analogReadResolution(12);
    // Arduino-ESP32 requires an initial read to attach the ADC channel before
    // analogSetPinAttenuation can configure that specific pin.
    analogRead(PIN_BATTERY_ADC);
    analogSetPinAttenuation(PIN_BATTERY_ADC, ADC_11db);
  }
  initialized_ = true;
}

bool SensorSuite::probeI2c(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

bool SensorSuite::initializeBme680() {
  uint8_t address = 0;
  if (probeI2c(BME_ADDRESS_PRIMARY)) address = BME_ADDRESS_PRIMARY;
  else if (probeI2c(BME_ADDRESS_SECONDARY)) address = BME_ADDRESS_SECONDARY;
  if (!address || !bme680_.begin(address, &Wire)) return false;

  bme680_.setTemperatureOversampling(BME680_OS_8X);
  bme680_.setHumidityOversampling(BME680_OS_2X);
  bme680_.setPressureOversampling(BME680_OS_4X);
  bme680_.setIIRFilterSize(BME680_FILTER_SIZE_3);
  bme680_.setGasHeater(320, 150);
  return true;
}

bool SensorSuite::initializeScd41(const RuntimeConfig& config) {
  if (!probeI2c(SCD41_ADDRESS)) return false;
  scd41_.begin(Wire, SCD41_I2C_ADDR_62);
  delay(30);
  scd41_.wakeUp();
  scd41_.stopPeriodicMeasurement();
  if (scd41_.reinit() != 0) return false;
  if (config.altitudeMeters > 0.0f) {
    scd41_.setSensorAltitude(static_cast<uint16_t>(clampFloat(config.altitudeMeters, 0.0f, 3000.0f)));
  }
  scdStarted_ = scd41_.startPeriodicMeasurement() == 0;
  return scdStarted_;
}

void SensorSuite::initializeUart(Profile profile) {
  if (profile == Profile::AirStation) {
    sensorUart_.begin(9600, SERIAL_8N1, PIN_UART_RX, PIN_UART_TX);
    pmsReady_ = true;
  } else if (profile == Profile::Presence) {
    sensorUart_.begin(256000, SERIAL_8N1, PIN_UART_RX, PIN_UART_TX);
    radarReady_ = radar_.begin(sensorUart_, false);
  }
}

void SensorSuite::poll(const RuntimeConfig& config) {
  if (activeProfile_ == Profile::AirStation) readPmsStream();
  if (activeProfile_ == Profile::Presence) updateRadar(config);
}

void SensorSuite::feedPms(uint8_t value) {
  if (pmsPosition_ == 0 && value != 0x42) return;
  if (pmsPosition_ == 1 && value != 0x4D) {
    pmsPosition_ = value == 0x42 ? 1 : 0;
    return;
  }

  pmsFrame_[pmsPosition_++] = value;
  if (pmsPosition_ < sizeof(pmsFrame_)) return;
  pmsPosition_ = 0;

  const uint16_t frameLength = (static_cast<uint16_t>(pmsFrame_[2]) << 8) | pmsFrame_[3];
  uint16_t checksum = 0;
  for (size_t index = 0; index < 30; ++index) checksum += pmsFrame_[index];
  const uint16_t expected = (static_cast<uint16_t>(pmsFrame_[30]) << 8) | pmsFrame_[31];
  if (frameLength != 28 || checksum != expected) return;

  // Atmospheric-environment values, not the factory calibration chamber values.
  pm_.pm1 = static_cast<float>((static_cast<uint16_t>(pmsFrame_[10]) << 8) | pmsFrame_[11]);
  pm_.pm25 = static_cast<float>((static_cast<uint16_t>(pmsFrame_[12]) << 8) | pmsFrame_[13]);
  pm_.pm10 = static_cast<float>((static_cast<uint16_t>(pmsFrame_[14]) << 8) | pmsFrame_[15]);
  pm_.updatedAt = millis();
  ++pmsFrameCount_;
}

void SensorSuite::readPmsStream() {
  while (sensorUart_.available() > 0) feedPms(static_cast<uint8_t>(sensorUart_.read()));
}

void SensorSuite::updateRadar(const RuntimeConfig& config) {
  radar_.read();
  if (radar_.isConnected()) lastRadarFrameAt_ = millis();
  if (!radar_.isConnected()) return;
  if (radar_.presenceDetected()) lastPresenceAt_ = millis();
  const bool present = currentPresence(config);
  if (present != lastReportedPresence_) {
    lastReportedPresence_ = present;
    presenceTransition_ = true;
  }
}

bool SensorSuite::currentPresence(const RuntimeConfig& config) {
  if (radar_.presenceDetected()) return true;
  if (lastPresenceAt_ == 0) return false;
  return millis() - lastPresenceAt_ <= static_cast<uint32_t>(config.presenceHoldSeconds) * 1000UL;
}

bool SensorSuite::presenceChanged() {
  const bool changed = presenceTransition_;
  presenceTransition_ = false;
  return changed;
}

bool SensorSuite::testPmsCommandPath() {
  if (!initialized_ || activeProfile_ != Profile::AirStation) return false;

  auto sendCommand = [this](uint8_t command, uint16_t data) {
    uint8_t frame[7] = {
      0x42,
      0x4D,
      command,
      static_cast<uint8_t>(data >> 8),
      static_cast<uint8_t>(data & 0xFF),
      0,
      0,
    };
    uint16_t checksum = 0;
    for (uint8_t index = 0; index < 5; ++index) checksum += frame[index];
    frame[5] = static_cast<uint8_t>(checksum >> 8);
    frame[6] = static_cast<uint8_t>(checksum & 0xFF);
    sensorUart_.write(frame, sizeof(frame));
    sensorUart_.flush();
  };

  auto waitForFrameAfter = [this](uint32_t previousCount, uint32_t timeoutMs) {
    const uint32_t deadline = millis() + timeoutMs;
    while (pmsFrameCount_ == previousCount && static_cast<int32_t>(deadline - millis()) > 0) {
      readPmsStream();
      delay(5);
    }
    return pmsFrameCount_ > previousCount;
  };

  uint32_t baseline = pmsFrameCount_;
  if (!waitForFrameAfter(baseline, 2500)) return false;

  // Enter passive mode, discard the command acknowledgement, and verify that
  // the periodic stream actually becomes quiet. This proves the XIAO TX wire.
  sendCommand(0xE1, 0x0000);
  delay(350);
  while (sensorUart_.available() > 0) sensorUart_.read();
  pmsPosition_ = 0;
  const uint32_t quietBaseline = pmsFrameCount_;
  const uint32_t quietDeadline = millis() + 1400;
  while (static_cast<int32_t>(quietDeadline - millis()) > 0) {
    readPmsStream();
    delay(5);
  }
  const bool becameQuiet = pmsFrameCount_ == quietBaseline;

  // Request exactly one frame in passive mode. Receiving it proves the PMS TX
  // wire and completes the two-way UART test. Always restore active streaming.
  pmsPosition_ = 0;
  const uint32_t requestBaseline = pmsFrameCount_;
  sendCommand(0xE2, 0x0000);
  const bool requestReturnedFrame = waitForFrameAfter(requestBaseline, 2500);
  sendCommand(0xE1, 0x0001);
  delay(100);
  while (sensorUart_.available() > 0) sensorUart_.read();
  pmsPosition_ = 0;
  return becameQuiet && requestReturnedFrame;
}

SensorReading SensorSuite::capture(const RuntimeConfig& config) {
  SensorReading reading;
  reading.usbPowered = config.profile != Profile::Climate;

  if (bmeReady_ && bme680_.performReading()) {
    reading.temperatureC = bme680_.temperature + config.temperatureOffsetC;
    reading.humidityPct = clampFloat(bme680_.humidity + config.humidityOffsetPct, 0.0f, 100.0f);
    reading.pressureHpa = bme680_.pressure / 100.0f;
    reading.gasResistanceOhms = static_cast<float>(bme680_.gas_resistance);
  } else if (dhtReady_) {
    for (uint8_t attempt = 0; attempt < 2; ++attempt) {
      const float humidity = dht_.readHumidity();
      const float temperature = dht_.readTemperature();
      // A newly powered DHT11 can return an invalid frame or checksum-valid
      // zero humidity. Wait for a fresh measurement before reporting it absent.
      if (isfinite(temperature) && temperature >= -10.0f && temperature <= 60.0f
          && isfinite(humidity) && humidity > 0.0f && humidity <= 100.0f) {
        reading.temperatureC = temperature + config.temperatureOffsetC;
        reading.humidityPct = clampFloat(humidity + config.humidityOffsetPct, 0.0f, 100.0f);
        break;
      }
      if (attempt == 0) delay(2200);
    }
  }

  if (scdReady_) {
    // Never carry old measurements into a new report if this read fails.
    lastCo2Ppm_ = NAN;
    lastScdTemperatureC_ = NAN;
    lastScdHumidityPct_ = NAN;
    bool dataReady = false;
    const uint32_t deadline = millis() + 5200;
    do {
      poll(config);
      if (scd41_.getDataReadyStatus(dataReady) != 0) break;
      if (dataReady) break;
      if (!dataReady) delay(50);
    } while (static_cast<int32_t>(deadline - millis()) > 0);

    if (dataReady) {
      uint16_t co2 = 0;
      float temperature = NAN;
      float humidity = NAN;
      if (scd41_.readMeasurement(co2, temperature, humidity) == 0 && co2 > 0) {
        lastCo2Ppm_ = static_cast<float>(co2);
        lastScdTemperatureC_ = temperature;
        lastScdHumidityPct_ = humidity;
      }
    }
    reading.co2Ppm = lastCo2Ppm_;
    if (!isfinite(reading.temperatureC) && isfinite(lastScdTemperatureC_)) {
      reading.temperatureC = lastScdTemperatureC_ + config.temperatureOffsetC;
    }
    if (!isfinite(reading.humidityPct) && isfinite(lastScdHumidityPct_)) {
      reading.humidityPct = clampFloat(lastScdHumidityPct_ + config.humidityOffsetPct, 0.0f, 100.0f);
    }
  }

  if (vemlReady_ && probeI2c(VEML7700_ADDRESS)) {
    const float lux = veml7700_.readLux(VEML_LUX_AUTO);
    if (isfinite(lux) && lux >= 0.0f) reading.illuminanceLux = lux;
  }

  if (pmsReady_) {
    const uint32_t waitUntil = millis() + 2500;
    while ((pm_.updatedAt == 0 || millis() - pm_.updatedAt > PMS_SAMPLE_MAX_AGE_MS)
           && static_cast<int32_t>(waitUntil - millis()) > 0) {
      readPmsStream();
      delay(5);
    }
    if (pm_.updatedAt > 0 && millis() - pm_.updatedAt <= PMS_SAMPLE_MAX_AGE_MS) {
      reading.pm1Ugm3 = pm_.pm1;
      reading.pm25Ugm3 = pm_.pm25;
      reading.pm10Ugm3 = pm_.pm10;
    }
  }

  if (activeProfile_ == Profile::Presence) {
    for (uint8_t count = 0; count < 20; ++count) {
      updateRadar(config);
      delay(5);
    }
    reading.hasPresence = radarReady_ && lastRadarFrameAt_ > 0 && radar_.isConnected();
    reading.presencePresent = reading.hasPresence && currentPresence(config);
    if (reading.hasPresence && radar_.movingTargetDetected()) {
      reading.movingDistanceCm = radar_.movingTargetDistance();
      reading.movingEnergyPct = radar_.movingTargetEnergy();
    }
    if (reading.hasPresence && radar_.stationaryTargetDetected()) {
      reading.stationaryDistanceCm = radar_.stationaryTargetDistance();
      reading.stationaryEnergyPct = radar_.stationaryTargetEnergy();
    }
  }

  if (activeProfile_ == Profile::Climate) {
    reading.batteryVolts = readBatteryVolts();
    reading.batteryPct = batteryPercentFromVoltage(reading.batteryVolts);
  }

  addDerivedMetrics(reading);
  addAirQualityMetrics(reading);
  return reading;
}

void SensorSuite::addDerivedMetrics(SensorReading& reading) {
  reading.dewPointC = dewPoint(reading.temperatureC, reading.humidityPct);
  reading.absoluteHumidityGm3 = absoluteHumidity(reading.temperatureC, reading.humidityPct);

  if (isfinite(reading.temperatureC) && isfinite(reading.humidityPct)) {
    const float temperaturePenalty = fabsf(reading.temperatureC - 22.0f) * 5.0f;
    const float humidityPenalty = fabsf(reading.humidityPct - 45.0f) * 1.2f;
    reading.comfortScore = clampFloat(100.0f - temperaturePenalty - humidityPenalty, 0.0f, 100.0f);

    const float dewMargin = reading.temperatureC - reading.dewPointC;
    const float humidityRisk = clampFloat((reading.humidityPct - 55.0f) * 2.2f, 0.0f, 100.0f);
    const float condensationRisk = clampFloat((8.0f - dewMargin) * 12.5f, 0.0f, 100.0f);
    reading.moldRiskScore = fmaxf(humidityRisk, condensationRisk);
  }
}

void SensorSuite::addAirQualityMetrics(SensorReading& reading) {
  if (isfinite(reading.gasResistanceOhms) && reading.gasResistanceOhms > 0.0f) {
    if (!isfinite(gasBaselineOhms_)) gasBaselineOhms_ = reading.gasResistanceOhms;
    // Slow baseline adaptation. This is a relative VOC trend, never a calibrated TVOC value.
    gasBaselineOhms_ = gasBaselineOhms_ * 0.995f + reading.gasResistanceOhms * 0.005f;
    reading.vocTrendIndex = clampFloat(100.0f * gasBaselineOhms_ / reading.gasResistanceOhms, 0.0f, 500.0f);
  }

  float penalty = 0.0f;
  bool hasAirMetric = false;
  if (isfinite(reading.co2Ppm)) {
    penalty += clampFloat((reading.co2Ppm - 600.0f) / 14.0f, 0.0f, 45.0f);
    hasAirMetric = true;
  }
  if (isfinite(reading.pm25Ugm3)) {
    penalty += clampFloat(reading.pm25Ugm3 * 1.5f, 0.0f, 45.0f);
    hasAirMetric = true;
  }
  if (isfinite(reading.vocTrendIndex)) {
    penalty += clampFloat((reading.vocTrendIndex - 100.0f) * 0.12f, 0.0f, 20.0f);
    hasAirMetric = true;
  }
  if (hasAirMetric) reading.airQualityScore = clampFloat(100.0f - penalty, 0.0f, 100.0f);
}

float SensorSuite::readBatteryVolts() {
  float totalMillivolts = 0.0f;
  for (uint8_t sample = 0; sample < 16; ++sample) {
    totalMillivolts += static_cast<float>(analogReadMilliVolts(PIN_BATTERY_ADC));
    delay(2);
  }
  // Two external 200k resistors form BAT+ -> R1 -> A0 -> R2 -> GND (1:2).
  return (totalMillivolts / 16.0f) * 2.0f / 1000.0f;
}

void SensorSuite::addDiagnostics(JsonObject target, const SensorReading& reading) const {
  if (activeProfile_ == Profile::AirStation) {
    target["bme680_available"] = bmeReady_ && isfinite(reading.pressureHpa) && isfinite(reading.gasResistanceOhms);
    target["scd41_available"] = scdReady_ && isfinite(reading.co2Ppm);
    target["pms5003_available"] = pmsReady_ && isfinite(reading.pm25Ugm3);
  } else {
    target["dht11_available"] = dhtReady_ && isfinite(reading.temperatureC) && isfinite(reading.humidityPct);
    if (activeProfile_ == Profile::Presence) target["ld2410_available"] = reading.hasPresence;
  }
  if (activeProfile_ != Profile::Climate) target["veml7700_available"] = vemlReady_ && isfinite(reading.illuminanceLux);
  if (isfinite(reading.temperatureC)) {
    target["temperature_source"] = bmeReady_ && isfinite(reading.pressureHpa) ? "bme680" : scdReady_ ? "scd41" : "dht11";
  }
}

void SensorSuite::addCapabilities(JsonArray target) const {
  if (dhtReady_ || bmeReady_ || scdReady_) target.add("climate");
  if (bmeReady_) {
    target.add("pressure");
    target.add("voc-trend");
  }
  if (scdReady_) target.add("co2");
  if (vemlReady_) target.add("illuminance");
  if (pmsReady_ && pm_.updatedAt > 0) target.add("particulate");
  if (radarReady_ && lastRadarFrameAt_ > 0) target.add("presence");
  if (activeProfile_ == Profile::Climate) target.add("battery");
}

void SensorSuite::prepareForSleep() {
  if (!initialized_) return;
  if (scdStarted_) scd41_.stopPeriodicMeasurement();
  if (dhtReady_) digitalWrite(PIN_DHT_POWER, LOW);
  Wire.end();
  sensorUart_.end();
  initialized_ = false;
}

}  // namespace homebrain
