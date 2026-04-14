#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include <Arduino_GFX_Library.h>
#include <Adafruit_CST8XX.h>
#include <PCF8574.h>
#include <Preferences.h>

#include "HomeBrainPanelConfig.h"
#include "HomeBrainPanelAssets.h"
#include "HomeBrainPalette.h"

SET_LOOP_TASK_STACK_SIZE(16 * 1024);

namespace {

using homebrain::palette::accentForName;
using homebrain::palette::hex;

constexpr uint8_t kI2cSdaPin = 38;
constexpr uint8_t kI2cSclPin = 39;
constexpr uint8_t kEncoderAPin = 42;
constexpr uint8_t kEncoderBPin = 4;
constexpr uint8_t kBacklightPin = 6;
constexpr uint8_t kTouchAddress = 0x15;
constexpr uint16_t kScreenWidth = 480;
constexpr uint16_t kScreenHeight = 480;
constexpr uint8_t kActionSlots = 4;
constexpr uint8_t kRemoteModeSlots = 5;
constexpr uint8_t kSettingsModeSlot = 5;
constexpr uint8_t kModeSlots = 6;
constexpr uint8_t kPwmChannel = 0;
constexpr uint8_t kPwmResolution = 8;
constexpr uint32_t kPwmFrequency = 5000;
constexpr unsigned long kWifiRetryMs = 15000;
constexpr unsigned long kEncoderLongPressMs = 900;
constexpr unsigned long kStateRefreshFallbackMs = 5000;
constexpr unsigned long kThermostatCommitDelayMs = 3000;
constexpr unsigned long kThermostatDispatchDelayMs = 75;
constexpr unsigned long kDeviceLevelCommitDelayMs = 3000;
constexpr unsigned long kDeviceLevelDispatchDelayMs = 45;
constexpr unsigned long kOtaStatusReportIntervalMs = 750;
constexpr int kSwipeThreshold = 120;
constexpr int kSwipeVerticalLimit = 90;
constexpr unsigned long kSwipeWindowMs = 350;
constexpr uint16_t kStateJsonCapacity = 32768;
constexpr unsigned long kBrightnessPersistDelayMs = 1000;
constexpr int kBrightnessDefaultPercent = 94;
constexpr int kBrightnessMinPercent = 15;
constexpr int kBrightnessMaxPercent = 100;
constexpr int kTemperatureUnavailable = -1000;
constexpr int kDefaultEncoderDeltaThreshold = 4;
constexpr int kFastEncoderDeltaThreshold = 2;
constexpr int kUltraFastEncoderDeltaThreshold = 1;
constexpr unsigned long kEncoderAccelerationFastMs = 80;
constexpr unsigned long kEncoderAccelerationFasterMs = 45;
constexpr unsigned long kEncoderAccelerationFastestMs = 20;
constexpr lv_coord_t kZoomNormal = 256;
constexpr lv_coord_t kThermostatCenterZoom = 256;
constexpr lv_coord_t kThermostatAdjustmentZoom = 256;
constexpr lv_coord_t kThermostatWeatherZoom = 352;
constexpr lv_opa_t kThermostatWeatherOpacity = static_cast<lv_opa_t>(72);

PCF8574 gPcf8574(0x21);
Adafruit_CST8XX gTouchPanel;
Preferences gPreferences;

Arduino_ESP32RGBPanel* gBus = new Arduino_ESP32RGBPanel(
  16, 2, 1,
  40, 7, 15, 41,
  46, 3, 8, 18, 17,
  14, 13, 12, 11, 10, 9,
  5, 45, 48, 47, 21
);

Arduino_ST7701_RGBPanel* gGfx = new Arduino_ST7701_RGBPanel(
  gBus,
  GFX_NOT_DEFINED,
  0,
  false,
  kScreenWidth,
  kScreenHeight,
  st7701_type5_init_operations,
  sizeof(st7701_type5_init_operations),
  true,
  10, 4, 20,
  10, 4, 20
);

lv_disp_draw_buf_t gDrawBuffer;
lv_color_t* gDrawBufferA = nullptr;
lv_color_t* gDrawBufferB = nullptr;

struct QuickAction {
  bool valid = false;
  bool destructive = false;
  String id;
  String label;
  String subtitle;
  String type;
  String targetId;
  String action;
  String value;
  String accent;
};

struct KnobActionConfig {
  String kind = "none";
  int minValue = 0;
  int maxValue = 100;
  int step = 1;
  int value = 0;
  QuickAction clockwiseAction;
  QuickAction counterclockwiseAction;
  QuickAction pressAction;
  QuickAction longPressAction;
};

struct ModeSnapshot {
  String id;
  String title;
  String centerValue;
  String secondaryValue;
  String hint;
  String accent;
  String metaDeviceId;
  String metaMode;
  String metaWeatherIcon;
  String metaWeatherCondition;
  bool metaWeatherIsDay = true;
  int metaCurrentTemperature = kTemperatureUnavailable;
  int metaTargetTemperature = kTemperatureUnavailable;
  KnobActionConfig knob;
  QuickAction quickActions[kActionSlots];
  uint8_t quickActionCount = 0;
};

struct OtaSnapshot {
  bool active = false;
  bool available = false;
  String status;
  String phase;
  int progress = 0;
  String jobId;
  String targetVersion;
  String message;
  String downloadUrl;
  size_t bytesTotal = 0;
};

struct PanelState {
  String panelId;
  String panelName;
  String room;
  String panelStatus;
  String hardwareProfile;
  unsigned long pollIntervalMs = kStateRefreshFallbackMs;
  String modeOrder[kModeSlots];
  uint8_t modeCount = 0;
  ModeSnapshot modes[kModeSlots];
  OtaSnapshot ota;
  bool loaded = false;
};

PanelState gState;
uint8_t gCurrentModeIndex = 0;

bool gSwipeTracking = false;
bool gSwipeConsumed = false;
int gSwipeStartX = 0;
int gSwipeStartY = 0;
unsigned long gSwipeStartedAt = 0;

uint8_t gLastEncoderState = 0;
int8_t gEncoderDeltaAccumulator = 0;
bool gEncoderPressed = false;
unsigned long gEncoderPressedAt = 0;
unsigned long gLastEncoderTurnAt = 0;
int gLastEncoderDirection = 0;

bool gPanelActivated = false;
bool gPendingThermostatCommit = false;
bool gThermostatModePickerExpanded = false;
bool gOtaInProgress = false;
int gPendingThermostatValue = 0;
bool gPendingDeviceLevelCommit = false;
String gPendingDeviceLevelTargetId;
int gPendingDeviceLevelValue = 0;
unsigned long gPendingDeviceLevelCommitAt = 0;
bool gQueuedThermostatDispatch = false;
String gQueuedThermostatDeviceId;
int gQueuedThermostatValue = 0;
unsigned long gQueuedThermostatDispatchAt = 0;
bool gQueuedDeviceLevelDispatch = false;
String gQueuedDeviceLevelTargetId;
int gQueuedDeviceLevelValue = 0;
unsigned long gQueuedDeviceLevelDispatchAt = 0;
unsigned long gPendingThermostatCommitAt = 0;
unsigned long gLastOtaStatusPostAt = 0;
unsigned long gLastWifiAttemptAt = 0;
unsigned long gLastStateFetchAt = 0;
unsigned long gLastActivateAttemptAt = 0;
unsigned long gBrightnessChangedAt = 0;

int gBrightnessPercent = kBrightnessDefaultPercent;
bool gPendingBrightnessPersist = false;

String gStatusLine = "Booting HomeBrain panel...";
String gActiveOtaJobId;
String gBlockedOtaJobId;

lv_obj_t* gScreen = nullptr;
lv_obj_t* gMainCard = nullptr;
lv_obj_t* gModeBadge = nullptr;
lv_obj_t* gModeBadgeLabel = nullptr;
lv_obj_t* gTitleLabel = nullptr;
lv_obj_t* gCenterValueLabel = nullptr;
lv_obj_t* gSecondaryLabel = nullptr;
lv_obj_t* gRoomValueLabel = nullptr;
lv_obj_t* gRoomSubtitleLabel = nullptr;
lv_obj_t* gHintLabel = nullptr;
lv_obj_t* gFooterLabel = nullptr;
lv_obj_t* gArc = nullptr;
lv_obj_t* gCenterTapButton = nullptr;
lv_obj_t* gWeatherGlyphImage = nullptr;
lv_obj_t* gWeatherBadgeCard = nullptr;
lv_obj_t* gWeatherSunCore = nullptr;
lv_obj_t* gWeatherCloudPuffs[3] = {};
lv_obj_t* gWeatherCloudBase = nullptr;
lv_obj_t* gWeatherRainLines[3] = {};
lv_obj_t* gWeatherSnowLines[6] = {};
lv_obj_t* gWeatherFogLines[2] = {};
lv_obj_t* gWeatherSunRays[8] = {};
lv_obj_t* gWeatherBolt = nullptr;
lv_obj_t* gActionButtons[kActionSlots] = {};
lv_obj_t* gActionTitleLabels[kActionSlots] = {};
lv_obj_t* gActionSubtitleLabels[kActionSlots] = {};
int8_t gActionMappings[kActionSlots] = {-1, -1, -1, -1};

String normalizeHubUrl() {
  String base = String(HOMEBRAIN_PANEL_HUB_URL);
  while (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base;
}

String panelBasePath() {
  return "/api/panels/" + String(HOMEBRAIN_PANEL_ID);
}

String panelStateUrl() {
  return normalizeHubUrl() + panelBasePath() + "/state";
}

String panelActionUrl() {
  return normalizeHubUrl() + panelBasePath() + "/actions";
}

String panelActivateUrl() {
  return normalizeHubUrl() + panelBasePath() + "/activate";
}

String panelOtaStatusUrl() {
  return normalizeHubUrl() + panelBasePath() + "/ota/status";
}

String jsonVariantToString(JsonVariantConst value) {
  if (value.isNull()) {
    return "";
  }
  if (value.is<const char*>()) {
    return String(value.as<const char*>());
  }
  if (value.is<bool>()) {
    return value.as<bool>() ? "true" : "false";
  }
  if (value.is<long>()) {
    return String(value.as<long>());
  }
  if (value.is<unsigned long>()) {
    return String(value.as<unsigned long>());
  }
  if (value.is<double>()) {
    return String(value.as<double>(), 0);
  }
  return "";
}

int normalizeBrightnessPercent(int value) {
  return constrain(value, kBrightnessMinPercent, kBrightnessMaxPercent);
}

uint8_t brightnessPercentToPwm(int value) {
  const int normalized = normalizeBrightnessPercent(value);
  return static_cast<uint8_t>(map(normalized, 0, 100, 0, 255));
}

String brightnessLabel(int value) {
  return String(normalizeBrightnessPercent(value)) + String("%");
}

enum class HttpRequestChannel : uint8_t {
  Default = 0,
  OtaDownload = 1
};

bool beginHttpRequest(
  HTTPClient& http,
  const String& url,
  HttpRequestChannel channel = HttpRequestChannel::Default
) {
  const size_t channelIndex = static_cast<size_t>(channel);

  if (url.startsWith("https://")) {
    static WiFiClientSecure secureClients[2];
    WiFiClientSecure& secureClient = secureClients[channelIndex];
    secureClient.setInsecure();
    return http.begin(secureClient, url);
  }

  static WiFiClient plainClients[2];
  WiFiClient& plainClient = plainClients[channelIndex];
  return http.begin(plainClient, url);
}

String otaDownloadUrlWithCredentials() {
  if (gState.ota.downloadUrl.isEmpty()) {
    return "";
  }

  const bool hasQuery = gState.ota.downloadUrl.indexOf('?') >= 0;
  return gState.ota.downloadUrl
    + (hasQuery ? "&" : "?")
    + "code="
    + HOMEBRAIN_PANEL_REGISTRATION_CODE;
}

void buildPanelStateFilter(JsonDocument& filterDocument) {
  filterDocument.clear();

  JsonObject state = filterDocument["state"].to<JsonObject>();
  JsonObject panel = state["panel"].to<JsonObject>();
  panel["id"] = true;
  panel["name"] = true;
  panel["room"] = true;
  panel["status"] = true;
  panel["hardwareProfile"] = true;

  JsonObject transport = state["transport"].to<JsonObject>();
  transport["pollIntervalMs"] = true;

  JsonObject ota = state["ota"].to<JsonObject>();
  ota["active"] = true;
  ota["available"] = true;
  ota["status"] = true;
  ota["phase"] = true;
  ota["progress"] = true;
  ota["jobId"] = true;
  ota["targetVersion"] = true;
  ota["message"] = true;
  ota["downloadUrl"] = true;
  ota["bytesTotal"] = true;

  JsonArray modeOrder = state["modeOrder"].to<JsonArray>();
  modeOrder.add(true);

  JsonObject modes = state["modes"].to<JsonObject>();
  const char* modeIds[] = {"thermostat", "room", "home", "media", "quiet"};
  for (const char* modeId : modeIds) {
    JsonObject mode = modes[modeId].to<JsonObject>();
    mode["title"] = true;
    mode["centerValue"] = true;
    mode["secondaryValue"] = true;
    mode["hint"] = true;
    mode["accent"] = true;

    JsonObject knob = mode["knob"].to<JsonObject>();
    knob["kind"] = true;
    knob["min"] = true;
    knob["max"] = true;
    knob["step"] = true;
    knob["value"] = true;

    const char* knobActionKeys[] = {"clockwiseAction", "counterclockwiseAction", "pressAction", "longPressAction"};
    for (const char* knobActionKey : knobActionKeys) {
      JsonObject knobAction = knob[knobActionKey].to<JsonObject>();
      knobAction["id"] = true;
      knobAction["label"] = true;
      knobAction["subtitle"] = true;
      knobAction["type"] = true;
      knobAction["targetId"] = true;
      knobAction["action"] = true;
      knobAction["value"] = true;
      knobAction["accent"] = true;
      knobAction["destructive"] = true;
    }

    JsonObject meta = mode["meta"].to<JsonObject>();
    meta["deviceId"] = true;
    meta["mode"] = true;
    meta["currentTemperature"] = true;
    meta["targetTemperature"] = true;
    meta["weatherIcon"] = true;
    meta["weatherCondition"] = true;
    meta["weatherIsDay"] = true;

    JsonArray quickActions = mode["quickActions"].to<JsonArray>();
    JsonObject quickAction = quickActions.createNestedObject();
    quickAction["id"] = true;
    quickAction["label"] = true;
    quickAction["subtitle"] = true;
    quickAction["type"] = true;
    quickAction["targetId"] = true;
    quickAction["action"] = true;
    quickAction["value"] = true;
    quickAction["accent"] = true;
    quickAction["destructive"] = true;
  }
}

String wifiSummary() {
  if (WiFi.status() != WL_CONNECTED) {
    return "Wi-Fi reconnecting";
  }

  return String("Wi-Fi ") + WiFi.localIP().toString();
}

String modeLabel(const String& modeId) {
  if (modeId == "thermostat") {
    return "THERMOSTAT";
  }
  if (modeId == "room") {
    return "ROOM";
  }
  if (modeId == "home") {
    return "HOME";
  }
  if (modeId == "media") {
    return "MEDIA";
  }
  if (modeId == "quiet") {
    return "QUIET";
  }
  if (modeId == "settings") {
    return "SETTINGS";
  }
  return "SURFACE";
}

void setStatusLine(const String& status) {
  if (gStatusLine == status) {
    return;
  }
  gStatusLine = status;
  Serial.println(String("[status] ") + status);
}

void configurePcf8574() {
  Wire.begin(kI2cSdaPin, kI2cSclPin);
  gPcf8574.pinMode(P0, OUTPUT);
  gPcf8574.pinMode(P2, OUTPUT);
  gPcf8574.pinMode(P3, OUTPUT);
  gPcf8574.pinMode(P4, OUTPUT);
  gPcf8574.pinMode(P5, INPUT_PULLUP);
  gPcf8574.begin();
}

void resetDisplayAndTouch() {
  gPcf8574.digitalWrite(P3, HIGH);
  delay(100);

  gPcf8574.digitalWrite(P4, HIGH);
  delay(100);
  gPcf8574.digitalWrite(P4, LOW);
  delay(120);
  gPcf8574.digitalWrite(P4, HIGH);
  delay(120);

  gPcf8574.digitalWrite(P0, HIGH);
  delay(100);
  gPcf8574.digitalWrite(P0, LOW);
  delay(120);
  gPcf8574.digitalWrite(P0, HIGH);
  delay(120);

  gPcf8574.digitalWrite(P2, HIGH);
  delay(120);
}

void applyBacklightBrightness(int brightnessPercent) {
  gBrightnessPercent = normalizeBrightnessPercent(brightnessPercent);
  ledcWrite(kPwmChannel, brightnessPercentToPwm(gBrightnessPercent));
}

void setBacklightBrightness(int brightnessPercent, bool persist = true) {
  const int normalized = normalizeBrightnessPercent(brightnessPercent);
  if (normalized == gBrightnessPercent) {
    return;
  }

  applyBacklightBrightness(normalized);
  if (persist) {
    gPendingBrightnessPersist = true;
    gBrightnessChangedAt = millis();
  }
}

void loadPersistentDeviceSettings() {
  if (!gPreferences.begin("hb-panel", false)) {
    return;
  }

  gBrightnessPercent = normalizeBrightnessPercent(
    gPreferences.getInt("brightness", kBrightnessDefaultPercent)
  );
}

void initBacklight() {
  ledcSetup(kPwmChannel, kPwmFrequency, kPwmResolution);
  ledcAttachPin(kBacklightPin, kPwmChannel);
  applyBacklightBrightness(gBrightnessPercent);
}

void displayFlush(lv_disp_drv_t* disp, const lv_area_t* area, lv_color_t* colorBuffer) {
  const uint32_t width = static_cast<uint32_t>(area->x2 - area->x1 + 1);
  const uint32_t height = static_cast<uint32_t>(area->y2 - area->y1 + 1);
#if (LV_COLOR_16_SWAP != 0)
  gGfx->draw16bitBeRGBBitmap(area->x1, area->y1, reinterpret_cast<uint16_t*>(&colorBuffer->full), width, height);
#else
  gGfx->draw16bitRGBBitmap(area->x1, area->y1, reinterpret_cast<uint16_t*>(&colorBuffer->full), width, height);
#endif
  lv_disp_flush_ready(disp);
}

void changeMode(int delta);
void queueDeviceLevelCommit(const String& targetId, int value);
bool commitPendingDeviceLevelNow();
void commitPendingDeviceLevelIfReady();
void queueDeviceLevelDispatch(const String& targetId, int value);
bool toggleRoomLight(ModeSnapshot& mode);
void hideRoomSurfaceLabels();
int activeEncoderThreshold();
int encoderStepAmount(const ModeSnapshot& mode, int direction);

void touchpadRead(lv_indev_drv_t* indevDriver, lv_indev_data_t* data) {
  LV_UNUSED(indevDriver);

  if (gOtaInProgress) {
    data->state = LV_INDEV_STATE_REL;
    return;
  }

  if (!gTouchPanel.touched()) {
    data->state = LV_INDEV_STATE_REL;
    gSwipeTracking = false;
    gSwipeConsumed = false;
    return;
  }

  const CST_TS_Point point = gTouchPanel.getPoint(0);
  const int x = point.x;
  const int y = point.y - 20;

  data->state = LV_INDEV_STATE_PR;
  data->point.x = x;
  data->point.y = y;

  if (!gSwipeTracking) {
    gSwipeTracking = true;
    gSwipeConsumed = false;
    gSwipeStartX = x;
    gSwipeStartY = y;
    gSwipeStartedAt = millis();
    return;
  }

  if (gSwipeConsumed) {
    return;
  }

  const int deltaX = x - gSwipeStartX;
  const int deltaY = abs(y - gSwipeStartY);
  const unsigned long elapsed = millis() - gSwipeStartedAt;

  if (elapsed > kSwipeWindowMs || deltaY > kSwipeVerticalLimit) {
    return;
  }

  if (deltaX >= kSwipeThreshold) {
    changeMode(-1);
    gSwipeConsumed = true;
    return;
  }

  if (deltaX <= -kSwipeThreshold) {
    changeMode(1);
    gSwipeConsumed = true;
  }
}

ModeSnapshot* currentMode() {
  if (!gState.loaded || gState.modeCount == 0 || gCurrentModeIndex >= gState.modeCount) {
    return nullptr;
  }
  const String& modeId = gState.modeOrder[gCurrentModeIndex];
  for (uint8_t index = 0; index < kModeSlots; index += 1) {
    if (gState.modes[index].id == modeId) {
      return &gState.modes[index];
    }
  }
  return nullptr;
}

void resetModeSnapshot(ModeSnapshot& mode) {
  mode = ModeSnapshot();
}

void parseQuickAction(JsonObjectConst object, QuickAction& action) {
  action.valid = true;
  action.id = jsonVariantToString(object["id"]);
  action.label = jsonVariantToString(object["label"]);
  action.subtitle = jsonVariantToString(object["subtitle"]);
  action.type = jsonVariantToString(object["type"]);
  action.targetId = jsonVariantToString(object["targetId"]);
  action.action = jsonVariantToString(object["action"]);
  action.value = jsonVariantToString(object["value"]);
  action.accent = jsonVariantToString(object["accent"]);
  action.destructive = object["destructive"] | false;
}

void parseKnob(JsonObjectConst object, ModeSnapshot& mode) {
  mode.knob.kind = jsonVariantToString(object["kind"]);
  mode.knob.minValue = object["min"] | 0;
  mode.knob.maxValue = object["max"] | 100;
  mode.knob.step = object["step"] | 1;
  mode.knob.value = object["value"] | 0;

  const JsonObjectConst clockwise = object["clockwiseAction"].as<JsonObjectConst>();
  if (!clockwise.isNull()) {
    parseQuickAction(clockwise, mode.knob.clockwiseAction);
  }

  const JsonObjectConst counterclockwise = object["counterclockwiseAction"].as<JsonObjectConst>();
  if (!counterclockwise.isNull()) {
    parseQuickAction(counterclockwise, mode.knob.counterclockwiseAction);
  }

  const JsonObjectConst press = object["pressAction"].as<JsonObjectConst>();
  if (!press.isNull()) {
    parseQuickAction(press, mode.knob.pressAction);
  }

  const JsonObjectConst longPress = object["longPressAction"].as<JsonObjectConst>();
  if (!longPress.isNull()) {
    parseQuickAction(longPress, mode.knob.longPressAction);
  }
}

QuickAction makeLocalQuickAction(
  const String& id,
  const String& label,
  const String& subtitle,
  const String& type,
  const String& value,
  const String& accent,
  bool destructive = false
) {
  QuickAction action;
  action.valid = true;
  action.id = id;
  action.label = label;
  action.subtitle = subtitle;
  action.type = type;
  action.value = value;
  action.accent = accent;
  action.destructive = destructive;
  return action;
}

ModeSnapshot buildLocalSettingsMode() {
  ModeSnapshot mode;
  mode.id = "settings";
  mode.title = "Settings";
  mode.centerValue = brightnessLabel(gBrightnessPercent);
  mode.secondaryValue = "Display brightness";
  mode.hint = "Rotate to dim or brighten the orb.";
  mode.accent = "cyan";
  mode.knob.kind = "range";
  mode.knob.minValue = kBrightnessMinPercent;
  mode.knob.maxValue = kBrightnessMaxPercent;
  mode.knob.step = 5;
  mode.knob.value = gBrightnessPercent;
  mode.quickActions[0] = makeLocalQuickAction(
    "settings-night",
    "Night",
    "25%",
    "panel.local.brightness_preset",
    "25",
    "purple"
  );
  mode.quickActions[1] = makeLocalQuickAction(
    "settings-balanced",
    "Balanced",
    "60%",
    "panel.local.brightness_preset",
    "60",
    "blue"
  );
  mode.quickActions[2] = makeLocalQuickAction(
    "settings-bright",
    "Bright",
    "100%",
    "panel.local.brightness_preset",
    "100",
    "yellow"
  );
  mode.quickActions[3] = makeLocalQuickAction(
    "settings-reboot",
    "Restart",
    "Reboot orb",
    "panel.local.reboot",
    "",
    "red",
    true
  );
  mode.quickActionCount = 4;
  return mode;
}

void installLocalSettingsMode() {
  gState.modes[kSettingsModeSlot] = buildLocalSettingsMode();

  bool found = false;
  for (uint8_t index = 0; index < gState.modeCount; index += 1) {
    if (gState.modeOrder[index] == "settings") {
      found = true;
      break;
    }
  }

  if (!found && gState.modeCount < kModeSlots) {
    gState.modeOrder[gState.modeCount] = "settings";
    gState.modeCount += 1;
  }
}

void parseModeSnapshot(const String& modeId, JsonObjectConst object, ModeSnapshot& mode) {
  resetModeSnapshot(mode);
  mode.id = modeId;
  mode.title = jsonVariantToString(object["title"]);
  mode.centerValue = jsonVariantToString(object["centerValue"]);
  mode.secondaryValue = jsonVariantToString(object["secondaryValue"]);
  mode.hint = jsonVariantToString(object["hint"]);
  mode.accent = jsonVariantToString(object["accent"]);

  const JsonObjectConst knob = object["knob"].as<JsonObjectConst>();
  if (!knob.isNull()) {
    parseKnob(knob, mode);
  }

  const JsonObjectConst meta = object["meta"].as<JsonObjectConst>();
  if (!meta.isNull()) {
    mode.metaDeviceId = jsonVariantToString(meta["deviceId"]);
    mode.metaMode = jsonVariantToString(meta["mode"]);
    mode.metaCurrentTemperature = meta["currentTemperature"] | kTemperatureUnavailable;
    mode.metaTargetTemperature = meta["targetTemperature"] | kTemperatureUnavailable;
    mode.metaWeatherIcon = jsonVariantToString(meta["weatherIcon"]);
    mode.metaWeatherCondition = jsonVariantToString(meta["weatherCondition"]);
    mode.metaWeatherIsDay = meta["weatherIsDay"] | true;
  }

  const JsonArrayConst quickActions = object["quickActions"].as<JsonArrayConst>();
  mode.quickActionCount = 0;
  for (JsonObjectConst actionObject : quickActions) {
    if (mode.quickActionCount >= kActionSlots) {
      break;
    }
    parseQuickAction(actionObject, mode.quickActions[mode.quickActionCount]);
    mode.quickActionCount += 1;
  }
}

bool parseState(JsonDocument& document) {
  JsonObjectConst root = document.as<JsonObjectConst>();
  JsonObjectConst state = root["state"].as<JsonObjectConst>();
  if (state.isNull()) {
    return false;
  }

  const String previousModeId = currentMode() ? currentMode()->id : "";
  gThermostatModePickerExpanded = false;
  gState = PanelState();
  gState.panelId = jsonVariantToString(state["panel"]["id"]);
  gState.panelName = jsonVariantToString(state["panel"]["name"]);
  gState.room = jsonVariantToString(state["panel"]["room"]);
  gState.panelStatus = jsonVariantToString(state["panel"]["status"]);
  gState.hardwareProfile = jsonVariantToString(state["panel"]["hardwareProfile"]);
  gState.pollIntervalMs = state["transport"]["pollIntervalMs"] | kStateRefreshFallbackMs;
  gState.ota.active = state["ota"]["active"] | false;
  gState.ota.available = state["ota"]["available"] | false;
  gState.ota.status = jsonVariantToString(state["ota"]["status"]);
  gState.ota.phase = jsonVariantToString(state["ota"]["phase"]);
  gState.ota.progress = state["ota"]["progress"] | 0;
  gState.ota.jobId = jsonVariantToString(state["ota"]["jobId"]);
  gState.ota.targetVersion = jsonVariantToString(state["ota"]["targetVersion"]);
  gState.ota.message = jsonVariantToString(state["ota"]["message"]);
  gState.ota.downloadUrl = jsonVariantToString(state["ota"]["downloadUrl"]);
  gState.ota.bytesTotal = state["ota"]["bytesTotal"] | 0;
  if (!gState.ota.jobId.isEmpty() && gState.ota.jobId != gBlockedOtaJobId && gState.ota.jobId != gActiveOtaJobId) {
    gBlockedOtaJobId = "";
  }

  const JsonObjectConst modes = state["modes"].as<JsonObjectConst>();
  parseModeSnapshot("thermostat", modes["thermostat"].as<JsonObjectConst>(), gState.modes[0]);
  parseModeSnapshot("room", modes["room"].as<JsonObjectConst>(), gState.modes[1]);
  parseModeSnapshot("home", modes["home"].as<JsonObjectConst>(), gState.modes[2]);
  parseModeSnapshot("media", modes["media"].as<JsonObjectConst>(), gState.modes[3]);
  parseModeSnapshot("quiet", modes["quiet"].as<JsonObjectConst>(), gState.modes[4]);

  const JsonArrayConst modeOrder = state["modeOrder"].as<JsonArrayConst>();
  gState.modeCount = 0;
  for (JsonVariantConst entry : modeOrder) {
    if (gState.modeCount >= kModeSlots) {
      break;
    }
    gState.modeOrder[gState.modeCount] = jsonVariantToString(entry);
    gState.modeCount += 1;
  }

  if (gState.modeCount == 0) {
    for (uint8_t index = 0; index < kRemoteModeSlots; index += 1) {
      if (!gState.modes[index].id.isEmpty()) {
        gState.modeOrder[gState.modeCount] = gState.modes[index].id;
        gState.modeCount += 1;
      }
    }
  }

  installLocalSettingsMode();

  gState.loaded = true;

  if (!previousModeId.isEmpty()) {
    for (uint8_t index = 0; index < gState.modeCount; index += 1) {
      if (gState.modeOrder[index] == previousModeId) {
        gCurrentModeIndex = index;
        return true;
      }
    }
  }

  if (gCurrentModeIndex >= gState.modeCount) {
    gCurrentModeIndex = 0;
  }

  return true;
}

void styleButton(lv_obj_t* button, const QuickAction& action) {
  const lv_color_t accent = action.destructive ? hex(homebrain::palette::kAccentRed) : accentForName(action.accent);

  lv_obj_set_style_radius(button, 36, 0);
  lv_obj_set_style_border_width(button, 1, 0);
  lv_obj_set_style_border_color(button, accent, 0);
  lv_obj_set_style_bg_color(button, hex(homebrain::palette::kPanelSoft), 0);
  lv_obj_set_style_bg_opa(button, LV_OPA_90, 0);
  lv_obj_set_style_shadow_width(button, 0, 0);
  lv_obj_set_style_pad_all(button, 12, 0);
}

String compactTemperatureValue(const String& value) {
  String compact;
  for (size_t index = 0; index < value.length(); index += 1) {
    const char character = value.charAt(index);
    if ((character >= '0' && character <= '9') || character == '-' || character == '.') {
      compact += character;
    }
  }

  return compact.length() > 0 ? compact : value;
}

String formatTemperatureDegrees(const String& value, int fallback) {
  String formatted = compactTemperatureValue(value);
  if (formatted.isEmpty()) {
    formatted = String(fallback);
  }
  if (!formatted.endsWith("°")) {
    formatted += String("°");
  }
  return formatted;
}

String formatTemperatureDegreesFromNumber(int value) {
  return String(value) + String("°");
}

bool isNumericDisplayValue(const String& value) {
  bool hasDigit = false;
  for (size_t index = 0; index < value.length(); index += 1) {
    const char character = value.charAt(index);
    if (character >= '0' && character <= '9') {
      hasDigit = true;
      continue;
    }
    if (character == '%' || character == '.' || character == '-' || character == ' ' || character == 0xB0) {
      continue;
    }
    return false;
  }
  return hasDigit;
}

void styleSurfaceTitle(lv_obj_t* label, lv_coord_t y, lv_coord_t zoom = 256) {
  lv_obj_clear_flag(label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_set_width(label, lv_pct(100));
  lv_obj_align(label, LV_ALIGN_TOP_MID, 0, y);
  lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(label, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(label, zoom, 0);
  lv_obj_set_style_text_letter_space(label, 1, 0);
  lv_obj_set_style_text_color(label, hex(homebrain::palette::kTextPrimary), 0);
}

void styleSurfaceSubtitle(lv_obj_t* label, lv_coord_t y, bool muted = false, lv_coord_t zoom = 228) {
  lv_obj_clear_flag(label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_set_width(label, lv_pct(100));
  lv_obj_align(label, LV_ALIGN_TOP_MID, 0, y);
  lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(label, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(label, zoom, 0);
  lv_obj_set_style_text_letter_space(label, 0, 0);
  lv_obj_set_style_text_color(
    label,
    muted ? hex(homebrain::palette::kTextSecondary) : hex(homebrain::palette::kTextPrimary),
    0
  );
}

void hideTextLabel(lv_obj_t* label) {
  lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
  lv_label_set_text(label, "");
}

void setSurfaceTitleText(const String& text, lv_coord_t y, lv_coord_t zoom = 256) {
  styleSurfaceTitle(gTitleLabel, y, zoom);
  lv_label_set_text(gTitleLabel, text.c_str());
}

void setSurfaceSubtitleText(const String& text, lv_coord_t y, bool muted = false, lv_coord_t zoom = 228) {
  if (text.isEmpty()) {
    hideTextLabel(gSecondaryLabel);
    return;
  }

  styleSurfaceSubtitle(gSecondaryLabel, y, muted, zoom);
  lv_label_set_text(gSecondaryLabel, text.c_str());
}

void styleHelperLabel(lv_obj_t* label, lv_coord_t y, const String& text) {
  if (text.isEmpty()) {
    lv_obj_add_flag(label, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(label, "");
    return;
  }

  lv_obj_clear_flag(label, LV_OBJ_FLAG_HIDDEN);
  lv_obj_set_width(label, 360);
  lv_obj_align(label, LV_ALIGN_TOP_MID, 0, y);
  lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(label, &hb_font_space_grotesk_20, 0);
  lv_obj_set_style_transform_zoom(label, 256, 0);
  lv_obj_set_style_text_color(label, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(label, text.c_str());
}

void styleSurfaceCenterValue(
  const String& value,
  lv_coord_t yOffset = 0,
  lv_coord_t numericZoom = 256,
  lv_coord_t textZoom = 420
) {
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_align(gCenterValueLabel, LV_ALIGN_CENTER, 0, yOffset);
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  if (isNumericDisplayValue(value)) {
    lv_obj_set_style_text_font(gCenterValueLabel, &hb_font_orbitron_80, 0);
    lv_obj_set_style_transform_zoom(gCenterValueLabel, numericZoom, 0);
  } else {
    lv_obj_set_style_text_font(gCenterValueLabel, &hb_font_orbitron_28, 0);
    lv_obj_set_style_transform_zoom(gCenterValueLabel, textZoom, 0);
  }
  lv_obj_set_style_text_letter_space(gCenterValueLabel, 0, 0);
  lv_obj_set_style_text_color(gCenterValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gCenterValueLabel, value.c_str());
}

void applyActionButtonFonts(
  const lv_font_t* titleFont,
  lv_coord_t titleZoom,
  const lv_font_t* subtitleFont,
  lv_coord_t subtitleZoom
) {
  for (uint8_t index = 0; index < kActionSlots; index += 1) {
    lv_obj_set_style_text_font(gActionTitleLabels[index], titleFont, 0);
    lv_obj_set_style_transform_zoom(gActionTitleLabels[index], titleZoom, 0);
    lv_obj_set_style_text_font(gActionSubtitleLabels[index], subtitleFont, 0);
    lv_obj_set_style_transform_zoom(gActionSubtitleLabels[index], subtitleZoom, 0);
  }
}

String jsonMessage(JsonVariantConst value) {
  if (value.isNull()) {
    return "";
  }

  if (value.is<const char*>()) {
    return String(value.as<const char*>());
  }

  if (value.is<String>()) {
    return value.as<String>();
  }

  return "";
}

String summarizeActionFailure(JsonDocument& response, const String& fallbackMessage) {
  const JsonVariantConst root = response.as<JsonVariantConst>();
  String message = jsonMessage(root["message"]);

  if (message.isEmpty()) {
    message = jsonMessage(root["error"]);
  }

  if (message.indexOf("No access token available") >= 0
      || message.indexOf("Please authorize the application") >= 0) {
    return "Reconnect SmartThings";
  }

  if (message.indexOf("timed out") >= 0) {
    return "Hub request timed out";
  }

  if (message.length() > 34) {
    message.remove(34);
  }

  return message.isEmpty() ? fallbackMessage : message;
}

String summarizePanelActionFailure(JsonDocument& response) {
  return summarizeActionFailure(response, "Setpoint update failed");
}

const lv_img_dsc_t* thermostatWeatherGlyph(const ModeSnapshot& mode) {
  const String icon = mode.metaWeatherIcon.isEmpty() ? "cloudy" : mode.metaWeatherIcon;

  if (icon == "sunny") {
    return mode.metaWeatherIsDay ? &hb_weather_thermometer_sun : &hb_weather_moon_star;
  }
  if (icon == "partly-cloudy") {
    return mode.metaWeatherIsDay ? &hb_weather_cloud_sun : &hb_weather_cloud_moon;
  }
  if (icon == "fog") {
    return &hb_weather_cloud_fog;
  }
  if (icon == "drizzle" || icon == "rain") {
    return &hb_weather_cloud_rain;
  }
  if (icon == "sleet" || icon == "snow") {
    return &hb_weather_cloud_snow;
  }
  if (icon == "storm") {
    return &hb_weather_zap;
  }
  return &hb_weather_cloud;
}

void styleBackdropShape(
  lv_obj_t* object,
  lv_coord_t x,
  lv_coord_t y,
  lv_coord_t width,
  lv_coord_t height,
  lv_color_t border,
  lv_coord_t radius = LV_RADIUS_CIRCLE,
  lv_opa_t borderOpa = LV_OPA_50,
  lv_opa_t bgOpa = LV_OPA_TRANSP
) {
  lv_obj_set_pos(object, x, y);
  lv_obj_set_size(object, width, height);
  lv_obj_clear_flag(object, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_clear_flag(object, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_radius(object, radius, 0);
  lv_obj_set_style_border_width(object, 5, 0);
  lv_obj_set_style_border_color(object, border, 0);
  lv_obj_set_style_border_opa(object, borderOpa, 0);
  lv_obj_set_style_bg_color(object, border, 0);
  lv_obj_set_style_bg_opa(object, bgOpa, 0);
  lv_obj_set_style_shadow_width(object, 0, 0);
  lv_obj_set_style_pad_all(object, 0, 0);
  lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
}

void styleBackdropLine(
  lv_obj_t* line,
  const lv_point_t* points,
  uint8_t pointCount,
  lv_color_t color,
  lv_opa_t opacity = static_cast<lv_opa_t>(56),
  uint8_t width = 5
) {
  lv_line_set_points(line, points, pointCount);
  lv_obj_clear_flag(line, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_clear_flag(line, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_line_color(line, color, 0);
  lv_obj_set_style_line_opa(line, opacity, 0);
  lv_obj_set_style_line_width(line, width, 0);
  lv_obj_set_style_line_rounded(line, true, 0);
  lv_obj_add_flag(line, LV_OBJ_FLAG_HIDDEN);
}

void hideWeatherBackdrop() {
  if (gWeatherGlyphImage) {
    lv_obj_add_flag(gWeatherGlyphImage, LV_OBJ_FLAG_HIDDEN);
  }
  if (gWeatherBadgeCard) {
    lv_obj_add_flag(gWeatherBadgeCard, LV_OBJ_FLAG_HIDDEN);
  }
  if (gWeatherSunCore) {
    lv_obj_add_flag(gWeatherSunCore, LV_OBJ_FLAG_HIDDEN);
  }
  if (gWeatherCloudBase) {
    lv_obj_add_flag(gWeatherCloudBase, LV_OBJ_FLAG_HIDDEN);
  }
  if (gWeatherBolt) {
    lv_obj_add_flag(gWeatherBolt, LV_OBJ_FLAG_HIDDEN);
  }

  for (uint8_t index = 0; index < 3; index += 1) {
    if (gWeatherCloudPuffs[index]) {
      lv_obj_add_flag(gWeatherCloudPuffs[index], LV_OBJ_FLAG_HIDDEN);
    }
    if (gWeatherRainLines[index]) {
      lv_obj_add_flag(gWeatherRainLines[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  for (uint8_t index = 0; index < 6; index += 1) {
    if (gWeatherSnowLines[index]) {
      lv_obj_add_flag(gWeatherSnowLines[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  for (uint8_t index = 0; index < 2; index += 1) {
    if (gWeatherFogLines[index]) {
      lv_obj_add_flag(gWeatherFogLines[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  for (uint8_t index = 0; index < 8; index += 1) {
    if (gWeatherSunRays[index]) {
      lv_obj_add_flag(gWeatherSunRays[index], LV_OBJ_FLAG_HIDDEN);
    }
  }
}

void renderWeatherBackdrop(const ModeSnapshot& mode) {
  hideWeatherBackdrop();

  if (mode.id != "thermostat") {
    return;
  }

  if (gWeatherGlyphImage) {
    lv_img_set_src(gWeatherGlyphImage, thermostatWeatherGlyph(mode));
    lv_img_set_zoom(gWeatherGlyphImage, kThermostatWeatherZoom);
    lv_obj_align(gWeatherGlyphImage, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_img_opa(gWeatherGlyphImage, kThermostatWeatherOpacity, 0);
    lv_obj_clear_flag(gWeatherGlyphImage, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_background(gWeatherGlyphImage);
  }
}

void hideActionButton(uint8_t index);

void hideAllActionButtons() {
  for (uint8_t index = 0; index < kActionSlots; index += 1) {
    hideActionButton(index);
  }
}

String roomLevelDisplayValue(int brightness) {
  const int normalized = constrain(brightness, 0, 100);
  return normalized <= 0 ? "Off" : String(normalized) + String("%");
}

void syncRoomModeLocalState(ModeSnapshot& mode, int brightness) {
  const int normalized = constrain(brightness, mode.knob.minValue, mode.knob.maxValue);
  mode.knob.value = normalized;
  mode.centerValue = roomLevelDisplayValue(normalized);

  if (mode.metaDeviceId.isEmpty()) {
    return;
  }

  const bool isOn = normalized > 0;
  mode.knob.pressAction = makeLocalQuickAction(
    isOn ? "room-light-off" : "room-light-on",
    isOn ? "Off" : "On",
    mode.secondaryValue.isEmpty() ? "Lights" : mode.secondaryValue,
    "device.control",
    String(isOn ? 0 : 100),
    isOn ? "red" : "cyan",
    isOn
  );
  mode.knob.pressAction.targetId = mode.metaDeviceId;
  mode.knob.pressAction.action = "set_brightness";
}

void setCenterTapEnabled(bool enabled) {
  if (!gCenterTapButton) {
    return;
  }

  if (enabled) {
    lv_obj_clear_flag(gCenterTapButton, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(gCenterTapButton);
    return;
  }

  lv_obj_add_flag(gCenterTapButton, LV_OBJ_FLAG_HIDDEN);
}

void hideRoomSurfaceLabels() {
  if (gRoomValueLabel) {
    lv_obj_add_flag(gRoomValueLabel, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(gRoomValueLabel, "");
  }

  if (gRoomSubtitleLabel) {
    lv_obj_add_flag(gRoomSubtitleLabel, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(gRoomSubtitleLabel, "");
  }
}

void applyDefaultTextLayout() {
  hideRoomSurfaceLabels();
  lv_obj_clear_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);
  hideTextLabel(gHintLabel);

  styleSurfaceTitle(gTitleLabel, 72);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_align(gCenterValueLabel, LV_ALIGN_CENTER, 0, -22);
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(gCenterValueLabel, 300, 0);
  lv_obj_set_style_text_color(gCenterValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  styleSurfaceSubtitle(gSecondaryLabel, 254, true, 210);
}

void renderThermostatOverview(const ModeSnapshot& mode) {
  lv_obj_clear_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);
  const String currentValue = mode.metaCurrentTemperature != kTemperatureUnavailable
    ? formatTemperatureDegreesFromNumber(mode.metaCurrentTemperature)
    : formatTemperatureDegrees(mode.centerValue, mode.knob.value);

  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_align(gTitleLabel, LV_ALIGN_TOP_MID, 0, 58);
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(gTitleLabel, kZoomNormal, 0);
  lv_obj_set_style_text_letter_space(gTitleLabel, 1, 0);
  lv_obj_set_style_text_color(gTitleLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gTitleLabel, "Thermostat");

  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_align(gCenterValueLabel, LV_ALIGN_CENTER, 0, 0);
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &hb_font_orbitron_100, 0);
  lv_obj_set_style_transform_zoom(gCenterValueLabel, kThermostatCenterZoom, 0);
  lv_obj_set_style_text_letter_space(gCenterValueLabel, 0, 0);
  lv_obj_set_style_text_color(gCenterValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gCenterValueLabel, currentValue.c_str());

  lv_obj_set_width(gSecondaryLabel, lv_pct(100));
  lv_obj_align(gSecondaryLabel, LV_ALIGN_CENTER, 0, 138);
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(gSecondaryLabel, kZoomNormal, 0);
  lv_obj_set_style_text_letter_space(gSecondaryLabel, 0, 0);
  lv_obj_set_style_text_color(gSecondaryLabel, hex(homebrain::palette::kTextPrimary), 0);
  const String setPointValue = String(mode.knob.value) + String("°");
  lv_label_set_text(gSecondaryLabel, setPointValue.c_str());

  lv_obj_set_width(gHintLabel, lv_pct(100));
  lv_obj_align(gHintLabel, LV_ALIGN_CENTER, 0, 174);
  lv_obj_set_width(gHintLabel, lv_pct(100));
  lv_obj_set_style_text_align(gHintLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gHintLabel, &hb_font_space_grotesk_20, 0);
  lv_obj_set_style_transform_zoom(gHintLabel, kZoomNormal, 0);
  lv_obj_set_style_text_color(gHintLabel, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(gHintLabel, "Set point");

  lv_obj_move_foreground(gTitleLabel);
  lv_obj_move_foreground(gCenterValueLabel);
  lv_obj_move_foreground(gSecondaryLabel);
  lv_obj_move_foreground(gHintLabel);
  lv_obj_move_foreground(gFooterLabel);
}

void renderThermostatAdjustment(const ModeSnapshot& mode) {
  lv_obj_add_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);

  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_align(gCenterValueLabel, LV_ALIGN_CENTER, 0, 0);
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &hb_font_orbitron_100, 0);
  lv_obj_set_style_transform_zoom(gCenterValueLabel, kThermostatAdjustmentZoom, 0);
  lv_obj_set_style_text_letter_space(gCenterValueLabel, 0, 0);
  lv_obj_set_style_text_color(gCenterValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  const String adjustmentValue = String(mode.knob.value) + String("°");
  lv_label_set_text(gCenterValueLabel, adjustmentValue.c_str());

  lv_obj_move_foreground(gCenterValueLabel);
  lv_obj_move_foreground(gFooterLabel);
}

void renderSettingsMode(const ModeSnapshot& mode) {
  setSurfaceTitleText(mode.title.isEmpty() ? "Settings" : mode.title, 72);
  setSurfaceSubtitleText(mode.secondaryValue, 112, true, 204);
  styleSurfaceCenterValue(mode.centerValue, -28, 224, 420);
  styleHelperLabel(gHintLabel, 246, mode.hint);
}

void renderRoomMode(const ModeSnapshot& mode) {
  const String roomTitle = mode.title.isEmpty() ? "Room" : mode.title;
  const String roomSubtitle = mode.secondaryValue.isEmpty() ? "Lights" : mode.secondaryValue;
  const String roomValue = mode.centerValue.isEmpty()
    ? roomLevelDisplayValue(mode.knob.kind == "range" ? mode.knob.value : 0)
    : mode.centerValue;
  const String roomHint = mode.hint.isEmpty()
    ? "Tap to toggle. Rotate to dim or brighten."
    : mode.hint;

  hideTextLabel(gSecondaryLabel);
  hideTextLabel(gCenterValueLabel);
  setSurfaceTitleText(roomTitle, 74);
  if (gRoomSubtitleLabel) {
    lv_obj_clear_flag(gRoomSubtitleLabel, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_width(gRoomSubtitleLabel, lv_pct(100));
    lv_obj_align(gRoomSubtitleLabel, LV_ALIGN_TOP_MID, 0, 116);
    lv_obj_set_style_text_align(gRoomSubtitleLabel, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_font(gRoomSubtitleLabel, &hb_font_orbitron_28, 0);
    lv_obj_set_style_transform_zoom(gRoomSubtitleLabel, 210, 0);
    lv_obj_set_style_text_letter_space(gRoomSubtitleLabel, 0, 0);
    lv_obj_set_style_text_color(gRoomSubtitleLabel, hex(homebrain::palette::kTextSecondary), 0);
    lv_label_set_text(gRoomSubtitleLabel, roomSubtitle.c_str());
  }

  if (gRoomValueLabel) {
    lv_obj_clear_flag(gRoomValueLabel, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_width(gRoomValueLabel, lv_pct(100));
    lv_obj_align(gRoomValueLabel, LV_ALIGN_CENTER, 0, 12);
    lv_obj_set_style_text_align(gRoomValueLabel, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_style_text_letter_space(gRoomValueLabel, 0, 0);
    lv_obj_set_style_text_color(gRoomValueLabel, hex(homebrain::palette::kTextPrimary), 0);
    if (isNumericDisplayValue(roomValue)) {
      lv_obj_set_style_text_font(gRoomValueLabel, &hb_font_orbitron_100, 0);
      lv_obj_set_style_transform_zoom(gRoomValueLabel, 196, 0);
    } else {
      lv_obj_set_style_text_font(gRoomValueLabel, &hb_font_orbitron_28, 0);
      lv_obj_set_style_transform_zoom(gRoomValueLabel, 360, 0);
    }
    lv_label_set_text(gRoomValueLabel, roomValue.c_str());
  }

  styleHelperLabel(gHintLabel, 330, roomHint);
  lv_obj_move_foreground(gTitleLabel);
  if (gRoomSubtitleLabel) {
    lv_obj_move_foreground(gRoomSubtitleLabel);
  }
  if (gRoomValueLabel) {
    lv_obj_move_foreground(gRoomValueLabel);
  }
  lv_obj_move_foreground(gHintLabel);
  lv_obj_move_foreground(gFooterLabel);
}

void renderSecurityMode(const ModeSnapshot& mode) {
  setSurfaceTitleText(mode.title, 74);
  hideTextLabel(gSecondaryLabel);
  styleSurfaceCenterValue(mode.centerValue, -26, 208, 292);
  styleHelperLabel(gHintLabel, 266, mode.secondaryValue);
}

void renderMediaSurface(const ModeSnapshot& mode) {
  setSurfaceTitleText(mode.title, 74);
  styleSurfaceCenterValue(mode.centerValue, -24, 208, 504);
  setSurfaceSubtitleText(mode.secondaryValue, 246, true, 192);
  styleHelperLabel(gHintLabel, 286, mode.hint);
}

void updateFooter() {
  String footer = wifiSummary();
  if (!gState.room.isEmpty()) {
    footer = gState.room + " · " + footer;
  }
  if (!gStatusLine.isEmpty()) {
    footer += " · " + gStatusLine;
  }
  lv_obj_clear_flag(gFooterLabel, LV_OBJ_FLAG_HIDDEN);
  lv_label_set_text(gFooterLabel, footer.c_str());
}

void hideActionButton(uint8_t index) {
  gActionMappings[index] = -1;
  lv_obj_add_flag(gActionButtons[index], LV_OBJ_FLAG_HIDDEN);
  lv_label_set_text(gActionTitleLabels[index], "");
  lv_label_set_text(gActionSubtitleLabels[index], "");
}

void showActionButton(
  uint8_t slot,
  int8_t actionIndex,
  const QuickAction& action,
  lv_coord_t x,
  lv_coord_t y,
  lv_coord_t width,
  lv_coord_t height,
  bool showSubtitle
) {
  gActionMappings[slot] = actionIndex;
  lv_obj_set_pos(gActionButtons[slot], x, y);
  lv_obj_set_size(gActionButtons[slot], width, height);
  lv_obj_clear_flag(gActionButtons[slot], LV_OBJ_FLAG_HIDDEN);
  styleButton(gActionButtons[slot], action);
  lv_label_set_text(gActionTitleLabels[slot], action.label.c_str());
  lv_obj_set_style_text_color(gActionTitleLabels[slot], hex(homebrain::palette::kTextPrimary), 0);

  if (showSubtitle && !action.subtitle.isEmpty()) {
    lv_label_set_text(gActionSubtitleLabels[slot], action.subtitle.c_str());
    lv_obj_set_style_text_color(gActionSubtitleLabels[slot], accentForName(action.accent), 0);
    lv_obj_clear_flag(gActionSubtitleLabels[slot], LV_OBJ_FLAG_HIDDEN);
  } else {
    lv_label_set_text(gActionSubtitleLabels[slot], "");
    lv_obj_add_flag(gActionSubtitleLabels[slot], LV_OBJ_FLAG_HIDDEN);
  }
}

int8_t findThermostatActionIndex(const ModeSnapshot& mode, const String& value) {
  for (uint8_t index = 0; index < mode.quickActionCount; index += 1) {
    if (mode.quickActions[index].value == value) {
      return static_cast<int8_t>(index);
    }
  }
  return mode.quickActionCount > 0 ? 0 : -1;
}

void renderStandardButtons(const ModeSnapshot& mode) {
  static const lv_coord_t kButtonX[kActionSlots] = {50, 256, 50, 256};
  static const lv_coord_t kButtonY[kActionSlots] = {300, 300, 382, 382};
  static const lv_coord_t kButtonWidth = 174;
  static const lv_coord_t kButtonHeight = 72;

  applyActionButtonFonts(&hb_font_orbitron_28, 176, &hb_font_space_grotesk_20, 168);

  for (uint8_t index = 0; index < kActionSlots; index += 1) {
    if (index < mode.quickActionCount && mode.quickActions[index].valid) {
      showActionButton(
        index,
        static_cast<int8_t>(index),
        mode.quickActions[index],
        kButtonX[index],
        kButtonY[index],
        kButtonWidth,
        kButtonHeight,
        true
      );
    } else {
      hideActionButton(index);
    }
  }
}

void renderSecurityButtons(const ModeSnapshot& mode) {
  hideAllActionButtons();
  applyActionButtonFonts(&hb_font_orbitron_28, 168, &hb_font_space_grotesk_20, 164);

  if (mode.quickActionCount == 0) {
    return;
  }

  if (mode.quickActionCount == 1 && mode.quickActions[0].valid) {
    showActionButton(0, 0, mode.quickActions[0], 74, 314, 332, 84, false);
    return;
  }

  if (mode.quickActionCount > 0 && mode.quickActions[0].valid) {
    showActionButton(0, 0, mode.quickActions[0], 64, 314, 156, 78, false);
  }
  if (mode.quickActionCount > 1 && mode.quickActions[1].valid) {
    showActionButton(1, 1, mode.quickActions[1], 260, 314, 156, 78, false);
  }
}

void renderMediaButtons(const ModeSnapshot& mode) {
  hideAllActionButtons();
  applyActionButtonFonts(&hb_font_orbitron_28, 182, &hb_font_space_grotesk_20, 164);

  if (mode.quickActionCount == 1 && mode.quickActions[0].valid) {
    showActionButton(0, 0, mode.quickActions[0], 96, 322, 288, 66, false);
    return;
  }

  if (mode.quickActionCount > 0 && mode.quickActions[0].valid) {
    showActionButton(0, 0, mode.quickActions[0], 88, 322, 144, 66, false);
  }
  if (mode.quickActionCount > 1 && mode.quickActions[1].valid) {
    showActionButton(1, 1, mode.quickActions[1], 248, 322, 144, 66, false);
  }
}

void renderSettingsButtons(const ModeSnapshot& mode) {
  static const lv_coord_t kButtonX[kActionSlots] = {84, 248, 84, 248};
  static const lv_coord_t kButtonY[kActionSlots] = {286, 286, 360, 360};
  static const lv_coord_t kButtonWidth = 148;
  static const lv_coord_t kButtonHeight = 64;

  hideAllActionButtons();
  applyActionButtonFonts(&hb_font_orbitron_28, 164, &hb_font_space_grotesk_20, 160);

  for (uint8_t index = 0; index < kActionSlots; index += 1) {
    if (index < mode.quickActionCount && mode.quickActions[index].valid) {
      showActionButton(
        index,
        static_cast<int8_t>(index),
        mode.quickActions[index],
        kButtonX[index],
        kButtonY[index],
        kButtonWidth,
        kButtonHeight,
        false
      );
    } else {
      hideActionButton(index);
    }
  }
}

void renderThermostatButtons(const ModeSnapshot& mode) {
  (void)mode;
  hideAllActionButtons();
}

void renderMode() {
  hideRoomSurfaceLabels();
  ModeSnapshot* mode = currentMode();
  if (!mode) {
    hideWeatherBackdrop();
    setCenterTapEnabled(false);
    applyDefaultTextLayout();
    setSurfaceTitleText("HomeBrain", 84);
    styleSurfaceCenterValue("SYNC", -24, 220, 332);
    setSurfaceSubtitleText("Connecting", 258, true, 210);
    lv_obj_set_style_arc_color(gArc, hex(homebrain::palette::kPanelStroke), LV_PART_MAIN);
    lv_obj_set_style_arc_color(gArc, hex(homebrain::palette::kAccentBlue), LV_PART_INDICATOR);
    lv_arc_set_range(gArc, 0, 100);
    lv_arc_set_value(gArc, 18);
    hideAllActionButtons();
    updateFooter();
    return;
  }

  const lv_color_t accent = accentForName(mode->accent);
  lv_obj_set_style_arc_color(gArc, hex(homebrain::palette::kPanelStroke), LV_PART_MAIN);
  lv_obj_set_style_arc_color(gArc, accent, LV_PART_INDICATOR);
  if (mode->knob.kind == "range") {
    lv_arc_set_range(gArc, mode->knob.minValue, mode->knob.maxValue);
    lv_arc_set_value(gArc, mode->knob.value);
  } else {
    lv_arc_set_range(gArc, 0, 100);
    lv_arc_set_value(gArc, 100);
  }

  if (mode->id == "thermostat" && mode->knob.kind == "range" && !mode->metaDeviceId.isEmpty()) {
    setCenterTapEnabled(false);
    if (gPendingThermostatCommit) {
      hideWeatherBackdrop();
      renderThermostatAdjustment(*mode);
    } else {
      renderWeatherBackdrop(*mode);
      renderThermostatOverview(*mode);
    }
    renderThermostatButtons(*mode);
  } else if (mode->id == "settings") {
    hideWeatherBackdrop();
    setCenterTapEnabled(false);
    renderSettingsMode(*mode);
    renderSettingsButtons(*mode);
  } else if (mode->id == "room") {
    hideWeatherBackdrop();
    setCenterTapEnabled(true);
    renderRoomMode(*mode);
    hideAllActionButtons();
  } else if (mode->id == "home") {
    hideWeatherBackdrop();
    setCenterTapEnabled(false);
    renderSecurityMode(*mode);
    renderSecurityButtons(*mode);
  } else if (mode->id == "media") {
    hideWeatherBackdrop();
    setCenterTapEnabled(true);
    renderMediaSurface(*mode);
    renderMediaButtons(*mode);
  } else {
    hideWeatherBackdrop();
    setCenterTapEnabled(false);
    applyDefaultTextLayout();
    lv_label_set_text(gTitleLabel, mode->title.c_str());
    styleSurfaceCenterValue(mode->centerValue, -22, 216, 280);
    setSurfaceSubtitleText(mode->secondaryValue, 254, true, 210);
    styleHelperLabel(gHintLabel, 308, mode->hint);
    renderStandardButtons(*mode);
  }

  updateFooter();
}

void changeMode(int delta) {
  if (gOtaInProgress) {
    return;
  }

  if (!gState.loaded || gState.modeCount == 0) {
    return;
  }

  gThermostatModePickerExpanded = false;
  gEncoderDeltaAccumulator = 0;
  gLastEncoderTurnAt = 0;
  gLastEncoderDirection = 0;

  const int next = static_cast<int>(gCurrentModeIndex) + delta;
  if (next < 0) {
    gCurrentModeIndex = gState.modeCount - 1;
  } else if (next >= gState.modeCount) {
    gCurrentModeIndex = 0;
  } else {
    gCurrentModeIndex = static_cast<uint8_t>(next);
  }

  setStatusLine("Swiped to " + modeLabel(gState.modeOrder[gCurrentModeIndex]));
  renderMode();
}

bool postPanelJson(const String& url, JsonDocument& requestDocument, JsonDocument* responseDocument = nullptr) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  HTTPClient http;
  if (!beginHttpRequest(http, url)) {
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-HomeBrain-Panel-Code", HOMEBRAIN_PANEL_REGISTRATION_CODE);

  String body;
  serializeJson(requestDocument, body);
  const int statusCode = http.POST(body);
  if (statusCode <= 0) {
    http.end();
    return false;
  }

  if (responseDocument == nullptr) {
    http.end();
    return statusCode >= 200 && statusCode < 300;
  }

  const DeserializationError error = deserializeJson(*responseDocument, http.getStream());
  http.end();
  if (error) {
    return false;
  }

  return statusCode >= 200 && statusCode < 300;
}

bool getPanelJson(const String& url, JsonDocument& responseDocument) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  HTTPClient http;
  if (!beginHttpRequest(http, url)) {
    return false;
  }

  http.addHeader("X-HomeBrain-Panel-Code", HOMEBRAIN_PANEL_REGISTRATION_CODE);
  const int statusCode = http.GET();
  if (statusCode <= 0) {
    http.end();
    return false;
  }

  const DeserializationError error = deserializeJson(responseDocument, http.getStream());
  http.end();
  if (error) {
    Serial.println(String("[panel] state parse failed: ") + error.c_str());
    return false;
  }

  return statusCode >= 200 && statusCode < 300;
}

bool activatePanel() {
  StaticJsonDocument<512> request;
  request["ipAddress"] = WiFi.localIP().toString();
  request["firmwareVersion"] = HOMEBRAIN_PANEL_FIRMWARE_VERSION;

  const bool ok = postPanelJson(panelActivateUrl(), request);
  if (ok) {
    gPanelActivated = true;
    setStatusLine("Panel activated");
    return true;
  }

  setStatusLine("Activation failed");
  return false;
}

bool fetchPanelState() {
  DynamicJsonDocument response(kStateJsonCapacity);
  const bool ok = getPanelJson(panelStateUrl(), response);
  if (!ok) {
    setStatusLine("State refresh failed");
    return false;
  }

  if (!parseState(response)) {
    setStatusLine("State payload invalid");
    Serial.println("[panel] state payload missing expected fields");
    return false;
  }

  gLastStateFetchAt = millis();
  setStatusLine("Live");
  Serial.println("[panel] state refreshed successfully");
  renderMode();
  return true;
}

void renderOtaProgressScreen(const String& title, int progress, const String& message) {
  hideWeatherBackdrop();
  setCenterTapEnabled(false);
  hideRoomSurfaceLabels();
  hideAllActionButtons();
  lv_obj_add_flag(gFooterLabel, LV_OBJ_FLAG_HIDDEN);

  const String percentLabel = String(progress) + String("%");
  setSurfaceTitleText(title, 82);
  styleSurfaceCenterValue(percentLabel, -6, 224, 380);
  hideTextLabel(gSecondaryLabel);
  styleHelperLabel(gHintLabel, 314, message);

  lv_obj_set_style_arc_color(gArc, hex(homebrain::palette::kPanelStroke), LV_PART_MAIN);
  lv_obj_set_style_arc_color(gArc, hex(homebrain::palette::kAccentBlue), LV_PART_INDICATOR);
  lv_arc_set_range(gArc, 0, 100);
  lv_arc_set_value(gArc, progress);
}

bool reportOtaStatus(
  const String& phase,
  int progress,
  const String& message,
  size_t bytesTransferred = 0,
  size_t bytesTotal = 0,
  const String& error = ""
) {
  if (gActiveOtaJobId.isEmpty()) {
    return false;
  }

  StaticJsonDocument<512> request;
  request["jobId"] = gActiveOtaJobId;
  request["phase"] = phase;
  request["progress"] = progress;
  request["message"] = message;
  request["bytesTransferred"] = static_cast<unsigned long>(bytesTransferred);
  request["bytesTotal"] = static_cast<unsigned long>(bytesTotal);
  request["currentVersion"] = HOMEBRAIN_PANEL_FIRMWARE_VERSION;
  if (!error.isEmpty()) {
    request["error"] = error;
  }

  return postPanelJson(panelOtaStatusUrl(), request);
}

bool handleLocalPanelAction(const QuickAction& action) {
  if (!action.valid || !action.type.startsWith("panel.local.")) {
    return false;
  }

  if (action.type == "panel.local.brightness_preset") {
    setBacklightBrightness(action.value.toInt());
    installLocalSettingsMode();
    setStatusLine("Brightness " + brightnessLabel(gBrightnessPercent));
    renderMode();
    return true;
  }

  if (action.type == "panel.local.reboot") {
    setStatusLine("Restarting orb");
    renderOtaProgressScreen("Restarting", 100, "Rebooting the hardware orb...");
    delay(300);
    ESP.restart();
    return true;
  }

  return false;
}

bool performOtaUpdate() {
  if (gOtaInProgress || !gState.ota.available || gState.ota.downloadUrl.isEmpty() || gState.ota.jobId.isEmpty()) {
    return false;
  }

  gOtaInProgress = true;
  gActiveOtaJobId = gState.ota.jobId;
  gLastOtaStatusPostAt = 0;
  setStatusLine("Installing OTA update");
  renderOtaProgressScreen("Updating", 60, "Preparing secure download...");
  reportOtaStatus("downloading", 0, "Preparing OTA download...");

  HTTPClient http;
  const String downloadUrl = otaDownloadUrlWithCredentials();
  if (!beginHttpRequest(http, downloadUrl, HttpRequestChannel::OtaDownload)) {
    gOtaInProgress = false;
    gBlockedOtaJobId = gActiveOtaJobId;
    setStatusLine("OTA download failed");
    reportOtaStatus("failed", 0, "Unable to open OTA download stream.", 0, gState.ota.bytesTotal, "download-open-failed");
    fetchPanelState();
    renderMode();
    return false;
  }

  http.addHeader("X-HomeBrain-Panel-Code", HOMEBRAIN_PANEL_REGISTRATION_CODE);
  const int statusCode = http.GET();
  if (statusCode < 200 || statusCode >= 300) {
    http.end();
    gOtaInProgress = false;
    gBlockedOtaJobId = gActiveOtaJobId;
    setStatusLine("OTA package unavailable");
    reportOtaStatus("failed", 0, "HomeBrain could not stream the OTA package.", 0, gState.ota.bytesTotal, String(statusCode));
    fetchPanelState();
    renderMode();
    return false;
  }

  const int contentLength = http.getSize();
  const size_t totalBytes = contentLength > 0
    ? static_cast<size_t>(contentLength)
    : (gState.ota.bytesTotal > 0 ? gState.ota.bytesTotal : 0);
  if (!Update.begin(contentLength > 0 ? static_cast<size_t>(contentLength) : UPDATE_SIZE_UNKNOWN)) {
    const String errorMessage = Update.errorString();
    http.end();
    gOtaInProgress = false;
    gBlockedOtaJobId = gActiveOtaJobId;
    setStatusLine("OTA partition unavailable");
    reportOtaStatus("failed", 0, "Update partition is not ready for OTA.", 0, totalBytes, errorMessage);
    fetchPanelState();
    renderMode();
    return false;
  }

  WiFiClient* stream = http.getStreamPtr();
  uint8_t buffer[1024];
  size_t totalWritten = 0;
  unsigned long lastChunkAt = millis();

  while (http.connected() && (contentLength < 0 || totalWritten < static_cast<size_t>(contentLength))) {
    const size_t availableBytes = stream->available();
    if (availableBytes == 0) {
      if (millis() - lastChunkAt > 15000UL) {
        Update.abort();
        http.end();
        gOtaInProgress = false;
        gBlockedOtaJobId = gActiveOtaJobId;
        setStatusLine("OTA download timed out");
        reportOtaStatus("failed", 0, "OTA download timed out.", totalWritten, totalBytes, "download-timeout");
        fetchPanelState();
        renderMode();
        return false;
      }
      delay(10);
      continue;
    }

    const size_t toRead = min(availableBytes, sizeof(buffer));
    const size_t bytesRead = stream->readBytes(buffer, toRead);
    if (bytesRead == 0) {
      continue;
    }

    lastChunkAt = millis();
    const size_t written = Update.write(buffer, bytesRead);
    if (written != bytesRead) {
      const String errorMessage = Update.errorString();
      Update.abort();
      http.end();
      gOtaInProgress = false;
      gBlockedOtaJobId = gActiveOtaJobId;
      setStatusLine("OTA write failed");
      reportOtaStatus("failed", 0, "Writing the OTA image failed.", totalWritten, totalBytes, errorMessage);
      fetchPanelState();
      renderMode();
      return false;
    }

    totalWritten += written;
    const int rawProgress = totalBytes > 0
      ? static_cast<int>((totalWritten * 100UL) / totalBytes)
      : min(99, max(0, gState.ota.progress));

    renderOtaProgressScreen("Updating", min(98, max(60, rawProgress)), "Downloading firmware package...");
    if (millis() - gLastOtaStatusPostAt >= kOtaStatusReportIntervalMs) {
      reportOtaStatus("downloading", rawProgress, "Downloading firmware package...", totalWritten, totalBytes);
      gLastOtaStatusPostAt = millis();
    }
  }

  http.end();
  renderOtaProgressScreen("Updating", 96, "Validating and finalizing firmware...");
  reportOtaStatus("installing", 100, "Validating firmware image...", totalWritten, totalBytes);

  if (!Update.end()) {
    const String errorMessage = Update.errorString();
    Update.abort();
    gOtaInProgress = false;
    gBlockedOtaJobId = gActiveOtaJobId;
    setStatusLine("OTA validation failed");
    reportOtaStatus("failed", 0, "OTA validation failed.", totalWritten, totalBytes, errorMessage);
    fetchPanelState();
    renderMode();
    return false;
  }

  if (!Update.isFinished()) {
    Update.abort();
    gOtaInProgress = false;
    gBlockedOtaJobId = gActiveOtaJobId;
    setStatusLine("OTA incomplete");
    reportOtaStatus("failed", 0, "The OTA write did not finish cleanly.", totalWritten, totalBytes, "update-incomplete");
    fetchPanelState();
    renderMode();
    return false;
  }

  reportOtaStatus("rebooting", 100, "Rebooting into the new HomeBrain firmware...", totalWritten, totalBytes);
  renderOtaProgressScreen("Updating", 100, "Rebooting into the new firmware...");
  delay(400);
  ESP.restart();
  return true;
}

void maybeApplyOtaUpdate() {
  if (WiFi.status() != WL_CONNECTED || gOtaInProgress) {
    return;
  }

  if (!gState.ota.available || gState.ota.downloadUrl.isEmpty() || gState.ota.jobId.isEmpty()) {
    return;
  }

  if (gBlockedOtaJobId == gState.ota.jobId) {
    return;
  }

  performOtaUpdate();
}

void dispatchQuickAction(const QuickAction& action) {
  if (!action.valid || action.type.isEmpty() || action.type == "panel.noop") {
    return;
  }

  if (handleLocalPanelAction(action)) {
    return;
  }

  StaticJsonDocument<512> request;

  request["type"] = action.type;
  if (!action.targetId.isEmpty()) {
    request["targetId"] = action.targetId;
  }
  if (!action.action.isEmpty()) {
    request["action"] = action.action;
  }
  if (!action.value.isEmpty()) {
    request["value"] = action.value;
  }

  if (postPanelJson(panelActionUrl(), request)) {
    setStatusLine(action.label + " sent");
    renderMode();
    if (action.type != "harmony.command") {
      fetchPanelState();
    }
    return;
  }

  setStatusLine(action.label + " failed");
  renderMode();
}

void buttonEventHandler(lv_event_t* event) {
  if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
    return;
  }

  const intptr_t slotIndex = reinterpret_cast<intptr_t>(lv_event_get_user_data(event));
  ModeSnapshot* mode = currentMode();
  if (!mode) {
    return;
  }

  if (slotIndex < 0 || slotIndex >= kActionSlots) {
    return;
  }

  const int8_t actionIndex = gActionMappings[slotIndex];
  if (actionIndex < 0 || actionIndex >= mode->quickActionCount) {
    return;
  }

  if (mode->id == "room") {
    toggleRoomLight(*mode);
    return;
  }

  if (mode->id == "thermostat") {
    const int8_t currentActionIndex = findThermostatActionIndex(*mode, mode->metaMode);
    if (slotIndex == 0 && actionIndex == currentActionIndex) {
      gThermostatModePickerExpanded = !gThermostatModePickerExpanded;
      renderMode();
      return;
    }
    gThermostatModePickerExpanded = false;
  }

  dispatchQuickAction(mode->quickActions[actionIndex]);
}

void centerTapEventHandler(lv_event_t* event) {
  if (lv_event_get_code(event) != LV_EVENT_CLICKED) {
    return;
  }

  ModeSnapshot* mode = currentMode();
  if (!mode) {
    return;
  }

  if (mode->id == "room") {
    toggleRoomLight(*mode);
    return;
  }

  if (mode->id == "media") {
    dispatchQuickAction(mode->knob.pressAction);
  }
}

void createActionButton(uint8_t index, lv_coord_t x, lv_coord_t y) {
  gActionButtons[index] = lv_btn_create(gMainCard);
  lv_obj_set_size(gActionButtons[index], 202, 80);
  lv_obj_set_pos(gActionButtons[index], x, y);
  lv_obj_add_flag(gActionButtons[index], LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_event_cb(gActionButtons[index], buttonEventHandler, LV_EVENT_CLICKED, reinterpret_cast<void*>(static_cast<intptr_t>(index)));

  lv_obj_t* column = lv_obj_create(gActionButtons[index]);
  lv_obj_set_size(column, lv_pct(100), lv_pct(100));
  lv_obj_center(column);
  lv_obj_clear_flag(column, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(column, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_bg_opa(column, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(column, 0, 0);
  lv_obj_set_style_pad_all(column, 0, 0);
  lv_obj_set_flex_flow(column, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_flex_align(column, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);

  gActionTitleLabels[index] = lv_label_create(column);
  lv_label_set_long_mode(gActionTitleLabels[index], LV_LABEL_LONG_CLIP);
  lv_obj_set_width(gActionTitleLabels[index], lv_pct(100));
  lv_obj_set_style_text_align(gActionTitleLabels[index], LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gActionTitleLabels[index], &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(gActionTitleLabels[index], 176, 0);
  lv_obj_set_style_text_letter_space(gActionTitleLabels[index], 1, 0);

  gActionSubtitleLabels[index] = lv_label_create(column);
  lv_label_set_long_mode(gActionSubtitleLabels[index], LV_LABEL_LONG_CLIP);
  lv_obj_set_width(gActionSubtitleLabels[index], lv_pct(100));
  lv_obj_set_style_text_align(gActionSubtitleLabels[index], LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gActionSubtitleLabels[index], &hb_font_space_grotesk_20, 0);
  lv_obj_set_style_transform_zoom(gActionSubtitleLabels[index], 168, 0);
}

void createUi() {
  gScreen = lv_scr_act();
  lv_obj_set_style_bg_color(gScreen, hex(homebrain::palette::kPageBottom), 0);
  lv_obj_set_style_bg_grad_color(gScreen, hex(homebrain::palette::kPageTop), 0);
  lv_obj_set_style_bg_grad_dir(gScreen, LV_GRAD_DIR_VER, 0);

  gMainCard = lv_obj_create(gScreen);
  lv_obj_set_size(gMainCard, 480, 480);
  lv_obj_center(gMainCard);
  lv_obj_clear_flag(gMainCard, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_radius(gMainCard, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_opa(gMainCard, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(gMainCard, 0, 0);
  lv_obj_set_style_shadow_width(gMainCard, 0, 0);
  lv_obj_set_style_pad_all(gMainCard, 0, 0);

  gModeBadge = lv_obj_create(gMainCard);
  lv_obj_set_size(gModeBadge, 136, 34);
  lv_obj_align(gModeBadge, LV_ALIGN_TOP_MID, 0, 20);
  lv_obj_clear_flag(gModeBadge, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_radius(gModeBadge, 18, 0);
  lv_obj_set_style_bg_color(gModeBadge, hex(homebrain::palette::kPanelSoft), 0);
  lv_obj_set_style_bg_opa(gModeBadge, LV_OPA_80, 0);
  lv_obj_set_style_border_width(gModeBadge, 1, 0);
  lv_obj_set_style_border_color(gModeBadge, hex(homebrain::palette::kPanelStroke), 0);

  gModeBadgeLabel = lv_label_create(gModeBadge);
  lv_obj_center(gModeBadgeLabel);
  lv_obj_set_style_text_font(gModeBadgeLabel, &hb_font_space_grotesk_20, 0);
  lv_obj_set_style_transform_zoom(gModeBadgeLabel, 172, 0);
  lv_obj_set_style_text_color(gModeBadgeLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gModeBadgeLabel, "BOOT");
  lv_obj_add_flag(gModeBadge, LV_OBJ_FLAG_HIDDEN);

  gTitleLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gTitleLabel, 0, 54);
  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &hb_font_orbitron_28, 0);
  lv_obj_set_style_text_letter_space(gTitleLabel, 1, 0);
  lv_obj_set_style_text_color(gTitleLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gTitleLabel, "HomeBrain");

  gCenterValueLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gCenterValueLabel, 0, 124);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(gCenterValueLabel, 340, 0);
  lv_obj_set_style_text_color(gCenterValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gCenterValueLabel, "--");

  gSecondaryLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gSecondaryLabel, 70, 194);
  lv_obj_set_width(gSecondaryLabel, 340);
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(gSecondaryLabel, 204, 0);
  lv_obj_set_style_text_color(gSecondaryLabel, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(gSecondaryLabel, "Waiting for panel state");

  gArc = lv_arc_create(gMainCard);
  lv_obj_set_size(gArc, 468, 468);
  lv_obj_set_pos(gArc, 6, 6);
  lv_arc_set_rotation(gArc, 90);
  lv_arc_set_bg_angles(gArc, 0, 359);
  lv_arc_set_range(gArc, 0, 100);
  lv_arc_set_value(gArc, 50);
  lv_obj_remove_style(gArc, nullptr, LV_PART_KNOB);
  lv_obj_clear_flag(gArc, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_width(gArc, 24, LV_PART_MAIN);
  lv_obj_set_style_arc_width(gArc, 24, LV_PART_INDICATOR);
  lv_obj_set_style_arc_opa(gArc, LV_OPA_70, LV_PART_MAIN);

  gWeatherGlyphImage = lv_img_create(gMainCard);
  lv_obj_add_flag(gWeatherGlyphImage, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gWeatherGlyphImage, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(gWeatherGlyphImage, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_img_opa(gWeatherGlyphImage, kThermostatWeatherOpacity, 0);
  lv_obj_align(gWeatherGlyphImage, LV_ALIGN_CENTER, 0, 0);
  lv_obj_move_background(gWeatherGlyphImage);

  static const lv_point_t kSunRayPoints[8][2] = {
    {{166, 36}, {166, 16}},
    {{197, 47}, {211, 33}},
    {{208, 77}, {229, 77}},
    {{197, 108}, {211, 122}},
    {{166, 119}, {166, 139}},
    {{135, 108}, {121, 122}},
    {{124, 77}, {103, 77}},
    {{135, 47}, {121, 33}}
  };
  static const lv_point_t kRainPoints[3][2] = {
    {{86, 168}, {74, 198}},
    {{122, 178}, {110, 208}},
    {{160, 168}, {148, 198}}
  };
  static const lv_point_t kSnowPoints[6][2] = {
    {{88, 168}, {108, 188}},
    {{88, 188}, {108, 168}},
    {{98, 158}, {98, 198}},
    {{146, 168}, {166, 188}},
    {{146, 188}, {166, 168}},
    {{156, 158}, {156, 198}}
  };
  static const lv_point_t kFogPoints[2][2] = {
    {{66, 170}, {196, 170}},
    {{78, 196}, {208, 196}}
  };
  static const lv_point_t kBoltPoints[5] = {
    {164, 118},
    {142, 164},
    {170, 164},
    {152, 212},
    {190, 152}
  };

  gWeatherBadgeCard = lv_obj_create(gMainCard);
  lv_obj_set_pos(gWeatherBadgeCard, 110, 108);
  lv_obj_set_size(gWeatherBadgeCard, 260, 260);
  lv_obj_clear_flag(gWeatherBadgeCard, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_clear_flag(gWeatherBadgeCard, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_radius(gWeatherBadgeCard, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_opa(gWeatherBadgeCard, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(gWeatherBadgeCard, 0, 0);
  lv_obj_set_style_shadow_width(gWeatherBadgeCard, 0, 0);
  lv_obj_set_style_pad_all(gWeatherBadgeCard, 0, 0);
  lv_obj_add_flag(gWeatherBadgeCard, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_background(gWeatherBadgeCard);

  gWeatherSunCore = lv_obj_create(gWeatherBadgeCard);
  styleBackdropShape(
    gWeatherSunCore,
    146,
    57,
    40,
    40,
    hex(homebrain::palette::kAccentYellow),
    LV_RADIUS_CIRCLE,
    static_cast<lv_opa_t>(40),
    LV_OPA_TRANSP
  );
  lv_obj_set_style_border_width(gWeatherSunCore, 8, 0);

  for (uint8_t index = 0; index < 8; index += 1) {
    gWeatherSunRays[index] = lv_line_create(gWeatherBadgeCard);
    styleBackdropLine(gWeatherSunRays[index], kSunRayPoints[index], 2, hex(homebrain::palette::kAccentYellow));
    lv_obj_set_style_line_width(gWeatherSunRays[index], 8, 0);
  }

  gWeatherCloudPuffs[0] = lv_obj_create(gWeatherBadgeCard);
  styleBackdropShape(gWeatherCloudPuffs[0], 54, 104, 46, 46, hex(homebrain::palette::kTextPrimary), LV_RADIUS_CIRCLE, static_cast<lv_opa_t>(56));
  lv_obj_set_style_border_width(gWeatherCloudPuffs[0], 8, 0);
  gWeatherCloudPuffs[1] = lv_obj_create(gWeatherBadgeCard);
  styleBackdropShape(gWeatherCloudPuffs[1], 88, 76, 74, 74, hex(homebrain::palette::kTextPrimary), LV_RADIUS_CIRCLE, static_cast<lv_opa_t>(56));
  lv_obj_set_style_border_width(gWeatherCloudPuffs[1], 8, 0);
  gWeatherCloudPuffs[2] = lv_obj_create(gWeatherBadgeCard);
  styleBackdropShape(gWeatherCloudPuffs[2], 146, 108, 44, 44, hex(homebrain::palette::kTextPrimary), LV_RADIUS_CIRCLE, static_cast<lv_opa_t>(56));
  lv_obj_set_style_border_width(gWeatherCloudPuffs[2], 8, 0);
  gWeatherCloudBase = lv_obj_create(gWeatherBadgeCard);
  styleBackdropShape(gWeatherCloudBase, 56, 124, 134, 30, hex(homebrain::palette::kTextPrimary), 15, static_cast<lv_opa_t>(56));
  lv_obj_set_style_border_width(gWeatherCloudBase, 8, 0);

  for (uint8_t index = 0; index < 3; index += 1) {
    gWeatherRainLines[index] = lv_line_create(gWeatherBadgeCard);
    styleBackdropLine(gWeatherRainLines[index], kRainPoints[index], 2, hex(homebrain::palette::kAccentBlue));
    lv_obj_set_style_line_width(gWeatherRainLines[index], 8, 0);
  }

  for (uint8_t index = 0; index < 6; index += 1) {
    gWeatherSnowLines[index] = lv_line_create(gWeatherBadgeCard);
    styleBackdropLine(gWeatherSnowLines[index], kSnowPoints[index], 2, hex(homebrain::palette::kTextSecondary), LV_OPA_40, 6);
  }

  for (uint8_t index = 0; index < 2; index += 1) {
    gWeatherFogLines[index] = lv_line_create(gWeatherBadgeCard);
    styleBackdropLine(gWeatherFogLines[index], kFogPoints[index], 2, hex(homebrain::palette::kAccentSlate), LV_OPA_30, 8);
  }

  gWeatherBolt = lv_line_create(gWeatherBadgeCard);
  styleBackdropLine(gWeatherBolt, kBoltPoints, 5, hex(homebrain::palette::kAccentOrange), LV_OPA_50, 8);

  gHintLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gHintLabel, 70, 268);
  lv_obj_set_width(gHintLabel, 340);
  lv_obj_set_style_text_align(gHintLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gHintLabel, &hb_font_space_grotesk_20, 0);
  lv_obj_set_style_transform_zoom(gHintLabel, 188, 0);
  lv_obj_set_style_text_color(gHintLabel, hex(homebrain::palette::kTextMuted), 0);
  lv_label_set_text(gHintLabel, "Swipe between surfaces. The knob adapts to the current mode.");
  lv_obj_add_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);

  gFooterLabel = lv_label_create(gMainCard);
  lv_obj_set_width(gFooterLabel, 380);
  lv_obj_align(gFooterLabel, LV_ALIGN_BOTTOM_MID, 0, -18);
  lv_obj_set_style_text_align(gFooterLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gFooterLabel, &hb_font_space_grotesk_20, 0);
  lv_obj_set_style_transform_zoom(gFooterLabel, 160, 0);
  lv_obj_set_style_text_color(gFooterLabel, hex(homebrain::palette::kTextMuted), 0);
  lv_label_set_text(gFooterLabel, "Booting HomeBrain panel...");
  lv_obj_add_flag(gFooterLabel, LV_OBJ_FLAG_HIDDEN);

  gCenterTapButton = lv_btn_create(gMainCard);
  lv_obj_set_size(gCenterTapButton, 176, 176);
  lv_obj_align(gCenterTapButton, LV_ALIGN_CENTER, 0, 0);
  lv_obj_set_style_radius(gCenterTapButton, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_opa(gCenterTapButton, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(gCenterTapButton, 0, 0);
  lv_obj_set_style_shadow_width(gCenterTapButton, 0, 0);
  lv_obj_set_style_outline_width(gCenterTapButton, 0, 0);
  lv_obj_add_flag(gCenterTapButton, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_event_cb(gCenterTapButton, centerTapEventHandler, LV_EVENT_CLICKED, nullptr);

  gRoomSubtitleLabel = lv_label_create(gMainCard);
  lv_obj_set_width(gRoomSubtitleLabel, lv_pct(100));
  lv_obj_align(gRoomSubtitleLabel, LV_ALIGN_TOP_MID, 0, 116);
  lv_obj_set_style_text_align(gRoomSubtitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gRoomSubtitleLabel, &hb_font_orbitron_28, 0);
  lv_obj_set_style_transform_zoom(gRoomSubtitleLabel, 210, 0);
  lv_obj_set_style_text_color(gRoomSubtitleLabel, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(gRoomSubtitleLabel, "");
  lv_obj_add_flag(gRoomSubtitleLabel, LV_OBJ_FLAG_HIDDEN);

  gRoomValueLabel = lv_label_create(gMainCard);
  lv_obj_set_width(gRoomValueLabel, lv_pct(100));
  lv_obj_align(gRoomValueLabel, LV_ALIGN_CENTER, 0, 12);
  lv_obj_set_style_text_align(gRoomValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gRoomValueLabel, &hb_font_orbitron_100, 0);
  lv_obj_set_style_transform_zoom(gRoomValueLabel, 196, 0);
  lv_obj_set_style_text_color(gRoomValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gRoomValueLabel, "");
  lv_obj_add_flag(gRoomValueLabel, LV_OBJ_FLAG_HIDDEN);

  createActionButton(0, 50, 300);
  createActionButton(1, 256, 300);
  createActionButton(2, 50, 382);
  createActionButton(3, 256, 382);
}

void setupDisplay() {
  gGfx->begin();
  gGfx->fillScreen(BLACK);

  if (!gTouchPanel.begin(&Wire, kTouchAddress)) {
    setStatusLine("Touch controller not found");
  }

  lv_init();

  const size_t drawBufferPixels = kScreenWidth * 60;
  gDrawBufferA = static_cast<lv_color_t*>(heap_caps_malloc(drawBufferPixels * sizeof(lv_color_t), MALLOC_CAP_SPIRAM));
  gDrawBufferB = static_cast<lv_color_t*>(heap_caps_malloc(drawBufferPixels * sizeof(lv_color_t), MALLOC_CAP_SPIRAM));
  lv_disp_draw_buf_init(&gDrawBuffer, gDrawBufferA, gDrawBufferB, drawBufferPixels);

  static lv_disp_drv_t displayDriver;
  lv_disp_drv_init(&displayDriver);
  displayDriver.hor_res = kScreenWidth;
  displayDriver.ver_res = kScreenHeight;
  displayDriver.flush_cb = displayFlush;
  displayDriver.draw_buf = &gDrawBuffer;
  lv_disp_drv_register(&displayDriver);

  static lv_indev_drv_t inputDriver;
  lv_indev_drv_init(&inputDriver);
  inputDriver.type = LV_INDEV_TYPE_POINTER;
  inputDriver.read_cb = touchpadRead;
  lv_indev_drv_register(&inputDriver);

  createUi();
  renderMode();
}

void setupWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOMEBRAIN_PANEL_HOSTNAME);
  WiFi.begin(HOMEBRAIN_PANEL_WIFI_SSID, HOMEBRAIN_PANEL_WIFI_PASSWORD);
  gLastWifiAttemptAt = millis();
  setStatusLine("Connecting Wi-Fi");
}

void ensureWiFiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  const unsigned long now = millis();
  if (now - gLastWifiAttemptAt < kWifiRetryMs) {
    return;
  }

  WiFi.disconnect();
  WiFi.begin(HOMEBRAIN_PANEL_WIFI_SSID, HOMEBRAIN_PANEL_WIFI_PASSWORD);
  gLastWifiAttemptAt = now;
  gPanelActivated = false;
  setStatusLine("Retrying Wi-Fi");
  renderMode();
}

void queueThermostatCommit(int value) {
  gQueuedThermostatDispatch = false;
  gQueuedThermostatDeviceId = "";
  gPendingThermostatCommit = true;
  gPendingThermostatValue = value;
  gPendingThermostatCommitAt = millis();
}

bool commitPendingThermostatValueNow() {
  if (!gPendingThermostatCommit) {
    return false;
  }

  ModeSnapshot* mode = currentMode();
  if (!mode || mode->id != "thermostat" || mode->metaDeviceId.isEmpty()) {
    gPendingThermostatCommit = false;
    return false;
  }

  gQueuedThermostatDeviceId = mode->metaDeviceId;
  gQueuedThermostatValue = gPendingThermostatValue;
  gQueuedThermostatDispatchAt = millis() + kThermostatDispatchDelayMs;
  gQueuedThermostatDispatch = true;
  gPendingThermostatCommit = false;
  renderMode();
  return true;
}

void dispatchQueuedThermostatCommitIfReady() {
  if (!gQueuedThermostatDispatch) {
    return;
  }

  if (millis() < gQueuedThermostatDispatchAt) {
    return;
  }

  if (gQueuedThermostatDeviceId.isEmpty()) {
    gQueuedThermostatDispatch = false;
    return;
  }

  StaticJsonDocument<256> request;
  request["type"] = "thermostat.set_temperature";
  request["targetId"] = gQueuedThermostatDeviceId;
  request["value"] = gQueuedThermostatValue;

  const int committedValue = gQueuedThermostatValue;
  gQueuedThermostatDispatch = false;
  gQueuedThermostatDeviceId = "";

  DynamicJsonDocument response(1024);
  if (postPanelJson(panelActionUrl(), request, &response)) {
    setStatusLine("Setpoint " + String(committedValue) + " sent");
    fetchPanelState();
    return;
  }

  const String failureStatus = summarizePanelActionFailure(response);
  fetchPanelState();
  setStatusLine(failureStatus);
  renderMode();
}

void commitPendingThermostatValueIfReady() {
  if (!gPendingThermostatCommit) {
    return;
  }

  if (millis() - gPendingThermostatCommitAt < kThermostatCommitDelayMs) {
    return;
  }

  commitPendingThermostatValueNow();
}

void queueDeviceLevelCommit(const String& targetId, int value) {
  if (targetId.isEmpty()) {
    return;
  }

  gQueuedDeviceLevelDispatch = false;
  gQueuedDeviceLevelTargetId = "";
  gPendingDeviceLevelCommit = true;
  gPendingDeviceLevelTargetId = targetId;
  gPendingDeviceLevelValue = constrain(value, 0, 100);
  gPendingDeviceLevelCommitAt = millis();
}

bool commitPendingDeviceLevelNow() {
  if (!gPendingDeviceLevelCommit) {
    return false;
  }

  if (gPendingDeviceLevelTargetId.isEmpty()) {
    gPendingDeviceLevelCommit = false;
    return false;
  }

  gQueuedDeviceLevelTargetId = gPendingDeviceLevelTargetId;
  gQueuedDeviceLevelValue = gPendingDeviceLevelValue;
  gQueuedDeviceLevelDispatchAt = millis() + kDeviceLevelDispatchDelayMs;
  gQueuedDeviceLevelDispatch = true;
  gPendingDeviceLevelCommit = false;
  gPendingDeviceLevelTargetId = "";
  return true;
}

void commitPendingDeviceLevelIfReady() {
  if (!gPendingDeviceLevelCommit) {
    return;
  }

  if (millis() - gPendingDeviceLevelCommitAt < kDeviceLevelCommitDelayMs) {
    return;
  }

  commitPendingDeviceLevelNow();
}

void queueDeviceLevelDispatch(const String& targetId, int value) {
  if (targetId.isEmpty()) {
    return;
  }

  gQueuedDeviceLevelTargetId = targetId;
  gQueuedDeviceLevelValue = constrain(value, 0, 100);
  gQueuedDeviceLevelDispatchAt = millis() + kDeviceLevelDispatchDelayMs;
  gQueuedDeviceLevelDispatch = true;
}

void dispatchQueuedDeviceLevelIfReady() {
  if (!gQueuedDeviceLevelDispatch) {
    return;
  }

  if (millis() < gQueuedDeviceLevelDispatchAt) {
    return;
  }

  if (gQueuedDeviceLevelTargetId.isEmpty()) {
    gQueuedDeviceLevelDispatch = false;
    return;
  }

  StaticJsonDocument<256> request;
  request["type"] = "device.control";
  request["targetId"] = gQueuedDeviceLevelTargetId;
  request["action"] = "set_brightness";
  request["value"] = gQueuedDeviceLevelValue;

  gQueuedDeviceLevelDispatch = false;
  gQueuedDeviceLevelTargetId = "";

  DynamicJsonDocument response(1024);
  if (postPanelJson(panelActionUrl(), request, &response)) {
    fetchPanelState();
    return;
  }

  const String failureStatus = summarizeActionFailure(response, "Light update failed");
  fetchPanelState();
  setStatusLine(failureStatus);
  renderMode();
}

bool toggleRoomLight(ModeSnapshot& mode) {
  if (mode.id != "room" || mode.metaDeviceId.isEmpty()) {
    return false;
  }

  const int nextValue = mode.knob.value > 0 ? 0 : 100;
  gPendingDeviceLevelCommit = false;
  gPendingDeviceLevelTargetId = "";
  syncRoomModeLocalState(mode, nextValue);
  queueDeviceLevelDispatch(mode.metaDeviceId, nextValue);
  setStatusLine(nextValue > 0 ? "Lights 100%" : "Lights off");
  renderMode();
  return true;
}

int activeEncoderThreshold() {
  ModeSnapshot* mode = currentMode();
  if (!mode) {
    return kDefaultEncoderDeltaThreshold;
  }

  if ((mode->id == "room" || mode->id == "settings") && mode->knob.kind == "range") {
    return kUltraFastEncoderDeltaThreshold;
  }

  if (mode->id == "media" && mode->knob.kind == "relative") {
    return kUltraFastEncoderDeltaThreshold;
  }

  return kDefaultEncoderDeltaThreshold;
}

int encoderStepAmount(const ModeSnapshot& mode, int direction) {
  const int baseStep = max(1, mode.knob.step);
  if (mode.knob.kind != "range") {
    return baseStep;
  }

  if (mode.id != "room" && mode.id != "settings") {
    return baseStep;
  }

  const unsigned long now = millis();
  const bool sameDirection = gLastEncoderTurnAt != 0 && direction == gLastEncoderDirection;
  const unsigned long elapsedMs = sameDirection ? now - gLastEncoderTurnAt : ULONG_MAX;
  gLastEncoderTurnAt = now;
  gLastEncoderDirection = direction;

  if (elapsedMs <= kEncoderAccelerationFastestMs) {
    return baseStep * 10;
  }
  if (elapsedMs <= kEncoderAccelerationFasterMs) {
    return baseStep * 5;
  }
  if (elapsedMs <= kEncoderAccelerationFastMs) {
    return baseStep * 3;
  }

  return baseStep;
}

void persistBrightnessIfReady() {
  if (!gPendingBrightnessPersist) {
    return;
  }

  if (millis() - gBrightnessChangedAt < kBrightnessPersistDelayMs) {
    return;
  }

  gPreferences.putInt("brightness", gBrightnessPercent);
  gPendingBrightnessPersist = false;
}

void handleEncoderTurn(int direction) {
  if (gOtaInProgress) {
    return;
  }

  ModeSnapshot* mode = currentMode();
  if (!mode) {
    return;
  }

  if (mode->knob.kind == "range") {
    const int stepAmount = encoderStepAmount(*mode, direction);
    const int next = constrain(
      mode->knob.value + (direction * stepAmount),
      mode->knob.minValue,
      mode->knob.maxValue
    );
    if (next == mode->knob.value) {
      return;
    }

    mode->knob.value = next;
    if (mode->id == "thermostat") {
      queueThermostatCommit(next);
      setStatusLine("Adjusting setpoint");
      renderMode();
      return;
    }

    if (mode->id == "settings") {
      setBacklightBrightness(next);
      installLocalSettingsMode();
      setStatusLine("Brightness " + brightnessLabel(gBrightnessPercent));
      renderMode();
      return;
    }

    if (mode->id == "room") {
      syncRoomModeLocalState(*mode, next);
      queueDeviceLevelCommit(mode->metaDeviceId, next);
      setStatusLine("Lights " + roomLevelDisplayValue(next));
      renderMode();
      return;
    }

    mode->centerValue = String(next);
    renderMode();
    return;
  }

  if (mode->knob.kind == "relative") {
    if (direction > 0 && mode->knob.clockwiseAction.valid) {
      dispatchQuickAction(mode->knob.clockwiseAction);
      return;
    }
    if (direction < 0 && mode->knob.counterclockwiseAction.valid) {
      dispatchQuickAction(mode->knob.counterclockwiseAction);
    }
  }
}

void pollEncoder() {
  if (gOtaInProgress) {
    return;
  }

  const int currentA = digitalRead(kEncoderAPin);
  const int currentB = digitalRead(kEncoderBPin);
  const uint8_t currentState = static_cast<uint8_t>((currentA << 1) | currentB);
  if (currentState != gLastEncoderState) {
    int8_t delta = 0;
    switch ((gLastEncoderState << 2) | currentState) {
      case 0b0001:
      case 0b0111:
      case 0b1110:
      case 0b1000:
        delta = 1;
        break;
      case 0b0010:
      case 0b1011:
      case 0b1101:
      case 0b0100:
        delta = -1;
        break;
      default:
        delta = 0;
        break;
    }

    gLastEncoderState = currentState;
    if (delta != 0) {
      gEncoderDeltaAccumulator += delta;
      const int encoderThreshold = activeEncoderThreshold();
      while (gEncoderDeltaAccumulator >= encoderThreshold) {
        handleEncoderTurn(1);
        gEncoderDeltaAccumulator -= encoderThreshold;
      }
      while (gEncoderDeltaAccumulator <= -encoderThreshold) {
        handleEncoderTurn(-1);
        gEncoderDeltaAccumulator += encoderThreshold;
      }
    }
  }

  const bool pressed = gPcf8574.digitalRead(P5, true) == LOW;
  if (pressed && !gEncoderPressed) {
    gEncoderPressed = true;
    gEncoderPressedAt = millis();
    return;
  }

  if (!pressed && gEncoderPressed) {
    const unsigned long heldMs = millis() - gEncoderPressedAt;
    gEncoderPressed = false;

    ModeSnapshot* mode = currentMode();
    if (!mode) {
      return;
    }

    if (heldMs >= kEncoderLongPressMs) {
      dispatchQuickAction(mode->knob.longPressAction);
      return;
    }

    if (mode->id == "room") {
      toggleRoomLight(*mode);
      return;
    }

    if (mode->id == "thermostat" && gPendingThermostatCommit) {
      commitPendingThermostatValueNow();
      return;
    }

    dispatchQuickAction(mode->knob.pressAction);
  }
}

void maybeRefreshState() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (gOtaInProgress) {
    return;
  }

  if (gPendingThermostatCommit
      || gQueuedThermostatDispatch
      || gPendingDeviceLevelCommit
      || gQueuedDeviceLevelDispatch) {
    return;
  }

  if (!gPanelActivated) {
    if (millis() - gLastActivateAttemptAt < 10000UL) {
      return;
    }
    gLastActivateAttemptAt = millis();
    activatePanel();
    return;
  }

  const unsigned long interval = gState.loaded ? gState.pollIntervalMs : kStateRefreshFallbackMs;
  if (millis() - gLastStateFetchAt < interval) {
    return;
  }

  fetchPanelState();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  loadPersistentDeviceSettings();
  configurePcf8574();
  resetDisplayAndTouch();
  initBacklight();
  setupDisplay();

  pinMode(kEncoderAPin, INPUT);
  pinMode(kEncoderBPin, INPUT);
  gLastEncoderState = static_cast<uint8_t>((digitalRead(kEncoderAPin) << 1) | digitalRead(kEncoderBPin));
  gEncoderDeltaAccumulator = 0;
  gLastEncoderTurnAt = 0;
  gLastEncoderDirection = 0;

  setupWiFi();
}

void loop() {
  lv_tick_inc(5);
  lv_timer_handler();
  pollEncoder();
  commitPendingThermostatValueIfReady();
  commitPendingDeviceLevelIfReady();
  persistBrightnessIfReady();
  ensureWiFiConnected();
  dispatchQueuedThermostatCommitIfReady();
  dispatchQueuedDeviceLevelIfReady();
  maybeRefreshState();
  maybeApplyOtaUpdate();
  delay(5);
}
