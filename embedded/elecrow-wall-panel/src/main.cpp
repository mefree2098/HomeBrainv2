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
constexpr unsigned long kOtaStatusReportIntervalMs = 750;
constexpr int kSwipeThreshold = 120;
constexpr int kSwipeVerticalLimit = 90;
constexpr unsigned long kSwipeWindowMs = 350;
constexpr uint16_t kStateJsonCapacity = 24576;
constexpr unsigned long kBrightnessPersistDelayMs = 1000;
constexpr int kBrightnessDefaultPercent = 94;
constexpr int kBrightnessMinPercent = 15;
constexpr int kBrightnessMaxPercent = 100;

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

int gLastEncoderA = LOW;
bool gEncoderPressed = false;
unsigned long gEncoderPressedAt = 0;

bool gPanelActivated = false;
bool gPendingThermostatCommit = false;
bool gThermostatModePickerExpanded = false;
bool gOtaInProgress = false;
int gPendingThermostatValue = 0;
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
lv_obj_t* gHintLabel = nullptr;
lv_obj_t* gFooterLabel = nullptr;
lv_obj_t* gArc = nullptr;
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

bool beginHttpRequest(HTTPClient& http, const String& url) {
  if (url.startsWith("https://")) {
    static WiFiClientSecure secureClient;
    secureClient.setInsecure();
    return http.begin(secureClient, url);
  }

  static WiFiClient plainClient;
  return http.begin(plainClient, url);
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
  lv_obj_set_style_border_width(object, 4, 0);
  lv_obj_set_style_border_color(object, border, 0);
  lv_obj_set_style_border_opa(object, borderOpa, 0);
  lv_obj_set_style_bg_color(object, border, 0);
  lv_obj_set_style_bg_opa(object, bgOpa, 0);
  lv_obj_set_style_shadow_width(object, 0, 0);
  lv_obj_set_style_pad_all(object, 0, 0);
  lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_background(object);
}

void styleBackdropLine(
  lv_obj_t* line,
  const lv_point_t* points,
  uint8_t pointCount,
  lv_color_t color,
  lv_opa_t opacity = LV_OPA_40,
  uint8_t width = 4
) {
  lv_line_set_points(line, points, pointCount);
  lv_obj_clear_flag(line, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_clear_flag(line, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_line_color(line, color, 0);
  lv_obj_set_style_line_opa(line, opacity, 0);
  lv_obj_set_style_line_width(line, width, 0);
  lv_obj_set_style_line_rounded(line, true, 0);
  lv_obj_add_flag(line, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_background(line);
}

void hideWeatherBackdrop() {
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

  if (mode.id != "thermostat" || mode.metaWeatherIcon.isEmpty()) {
    return;
  }

  const String icon = mode.metaWeatherIcon;
  const lv_color_t sunColor = mode.metaWeatherIsDay
    ? hex(homebrain::palette::kAccentYellow)
    : hex(homebrain::palette::kAccentPurple);
  const lv_color_t cloudColor = hex(homebrain::palette::kTextMuted);
  const lv_color_t rainColor = hex(homebrain::palette::kAccentBlue);
  const lv_color_t snowColor = hex(homebrain::palette::kTextSecondary);
  const lv_color_t fogColor = hex(homebrain::palette::kAccentSlate);
  const lv_color_t stormColor = hex(homebrain::palette::kAccentOrange);

  const bool showSun = icon == "sunny" || icon == "partly-cloudy";
  const bool showCloud = icon != "sunny";
  const bool showRain = icon == "drizzle" || icon == "rain" || icon == "sleet";
  const bool showSnow = icon == "snow";
  const bool showFog = icon == "fog";
  const bool showStorm = icon == "storm";

  if (showSun && gWeatherSunCore) {
    lv_obj_set_style_border_color(gWeatherSunCore, sunColor, 0);
    lv_obj_set_style_bg_color(gWeatherSunCore, sunColor, 0);
    lv_obj_clear_flag(gWeatherSunCore, LV_OBJ_FLAG_HIDDEN);
    for (uint8_t index = 0; index < 8; index += 1) {
      lv_obj_set_style_line_color(gWeatherSunRays[index], sunColor, 0);
      lv_obj_clear_flag(gWeatherSunRays[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  if (showCloud && gWeatherCloudBase) {
    lv_obj_set_style_border_color(gWeatherCloudBase, cloudColor, 0);
    lv_obj_clear_flag(gWeatherCloudBase, LV_OBJ_FLAG_HIDDEN);
    for (uint8_t index = 0; index < 3; index += 1) {
      lv_obj_set_style_border_color(gWeatherCloudPuffs[index], cloudColor, 0);
      lv_obj_clear_flag(gWeatherCloudPuffs[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  if (showRain) {
    for (uint8_t index = 0; index < 3; index += 1) {
      lv_obj_set_style_line_color(gWeatherRainLines[index], rainColor, 0);
      lv_obj_clear_flag(gWeatherRainLines[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  if (showSnow) {
    for (uint8_t index = 0; index < 6; index += 1) {
      lv_obj_set_style_line_color(gWeatherSnowLines[index], snowColor, 0);
      lv_obj_clear_flag(gWeatherSnowLines[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  if (showFog) {
    for (uint8_t index = 0; index < 2; index += 1) {
      lv_obj_set_style_line_color(gWeatherFogLines[index], fogColor, 0);
      lv_obj_clear_flag(gWeatherFogLines[index], LV_OBJ_FLAG_HIDDEN);
    }
  }

  if (showStorm && gWeatherBolt) {
    lv_obj_set_style_line_color(gWeatherBolt, stormColor, 0);
    lv_obj_clear_flag(gWeatherBolt, LV_OBJ_FLAG_HIDDEN);
  }
}

void hideActionButton(uint8_t index);

void hideAllActionButtons() {
  for (uint8_t index = 0; index < kActionSlots; index += 1) {
    hideActionButton(index);
  }
}

void applyDefaultTextLayout() {
  lv_obj_clear_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);

  lv_obj_set_pos(gTitleLabel, 0, 62);
  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &lv_font_montserrat_24, 0);

  lv_obj_set_pos(gCenterValueLabel, 0, 146);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &lv_font_montserrat_48, 0);

  lv_obj_set_pos(gSecondaryLabel, 0, 324);
  lv_obj_set_width(gSecondaryLabel, lv_pct(100));
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &lv_font_montserrat_32, 0);
}

void renderThermostatOverview(const ModeSnapshot& mode) {
  lv_obj_clear_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);

  lv_obj_set_pos(gTitleLabel, 0, 62);
  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &lv_font_montserrat_24, 0);
  lv_label_set_text(gTitleLabel, "Thermostat");

  lv_obj_set_pos(gCenterValueLabel, 0, 150);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &lv_font_montserrat_48, 0);
  lv_label_set_text(gCenterValueLabel, mode.centerValue.c_str());

  lv_obj_set_pos(gSecondaryLabel, 0, 334);
  lv_obj_set_width(gSecondaryLabel, lv_pct(100));
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &lv_font_montserrat_32, 0);
  const String setPointValue = String(mode.knob.value) + String("°");
  lv_label_set_text(gSecondaryLabel, setPointValue.c_str());

  lv_obj_set_pos(gHintLabel, 0, 376);
  lv_obj_set_width(gHintLabel, lv_pct(100));
  lv_obj_set_style_text_align(gHintLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gHintLabel, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(gHintLabel, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(gHintLabel, "Set point");
}

void renderThermostatAdjustment(const ModeSnapshot& mode) {
  lv_obj_clear_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);

  lv_obj_set_pos(gTitleLabel, 0, 62);
  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &lv_font_montserrat_24, 0);
  lv_label_set_text(gTitleLabel, "Thermostat");

  lv_obj_set_pos(gCenterValueLabel, 0, 164);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &lv_font_montserrat_48, 0);
  const String adjustmentValue = String(mode.knob.value) + String("°");
  lv_label_set_text(gCenterValueLabel, adjustmentValue.c_str());
}

void renderSettingsMode(const ModeSnapshot& mode) {
  lv_obj_clear_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);

  lv_obj_set_pos(gTitleLabel, 0, 62);
  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &lv_font_montserrat_24, 0);
  lv_label_set_text(gTitleLabel, "Settings");

  lv_obj_set_pos(gCenterValueLabel, 0, 138);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &lv_font_montserrat_48, 0);
  lv_label_set_text(gCenterValueLabel, mode.centerValue.c_str());

  lv_obj_set_pos(gSecondaryLabel, 0, 230);
  lv_obj_set_width(gSecondaryLabel, lv_pct(100));
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(gSecondaryLabel, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(gSecondaryLabel, mode.secondaryValue.c_str());

  lv_obj_set_pos(gHintLabel, 40, 268);
  lv_obj_set_width(gHintLabel, 400);
  lv_obj_set_style_text_align(gHintLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gHintLabel, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(gHintLabel, hex(homebrain::palette::kTextMuted), 0);
  lv_label_set_text(gHintLabel, mode.hint.c_str());
}

void updateFooter() {
  String footer = wifiSummary();
  if (!gState.room.isEmpty()) {
    footer = gState.room + " · " + footer;
  }
  if (!gStatusLine.isEmpty()) {
    footer += " · " + gStatusLine;
  }
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
  static const lv_coord_t kButtonX[kActionSlots] = {30, 248, 30, 248};
  static const lv_coord_t kButtonY[kActionSlots] = {300, 300, 390, 390};
  static const lv_coord_t kButtonWidth = 202;
  static const lv_coord_t kButtonHeight = 80;

  for (uint8_t index = 0; index < kActionSlots; index += 1) {
    lv_obj_set_style_text_font(gActionTitleLabels[index], &lv_font_montserrat_16, 0);
    lv_obj_set_style_text_font(gActionSubtitleLabels[index], &lv_font_montserrat_12, 0);
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
      lv_obj_clear_flag(gActionSubtitleLabels[index], LV_OBJ_FLAG_HIDDEN);
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
  ModeSnapshot* mode = currentMode();
  if (!mode) {
    hideWeatherBackdrop();
    applyDefaultTextLayout();
    lv_label_set_text(gTitleLabel, "HomeBrain");
    lv_label_set_text(gCenterValueLabel, "SYNC");
    lv_label_set_text(gSecondaryLabel, "Connecting");
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
    renderWeatherBackdrop(*mode);
    if (gPendingThermostatCommit) {
      renderThermostatAdjustment(*mode);
    } else {
      renderThermostatOverview(*mode);
    }
    renderThermostatButtons(*mode);
  } else if (mode->id == "settings") {
    hideWeatherBackdrop();
    renderSettingsMode(*mode);
    renderStandardButtons(*mode);
  } else {
    hideWeatherBackdrop();
    applyDefaultTextLayout();
    lv_label_set_text(gTitleLabel, mode->title.c_str());
    lv_label_set_text(gCenterValueLabel, mode->centerValue.c_str());
    lv_label_set_text(gSecondaryLabel, mode->secondaryValue.c_str());
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

  DynamicJsonDocument filterDocument(4096);
  buildPanelStateFilter(filterDocument);

  const DeserializationError error = deserializeJson(
    responseDocument,
    http.getStream(),
    DeserializationOption::Filter(filterDocument)
  );
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
  hideAllActionButtons();
  lv_obj_add_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_flag(gFooterLabel, LV_OBJ_FLAG_HIDDEN);

  lv_obj_clear_flag(gTitleLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gCenterValueLabel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_clear_flag(gSecondaryLabel, LV_OBJ_FLAG_HIDDEN);

  lv_obj_set_pos(gTitleLabel, 0, 76);
  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &lv_font_montserrat_24, 0);
  lv_label_set_text(gTitleLabel, title.c_str());

  lv_obj_set_pos(gCenterValueLabel, 0, 160);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &lv_font_montserrat_48, 0);
  const String percentLabel = String(progress) + String("%");
  lv_label_set_text(gCenterValueLabel, percentLabel.c_str());

  lv_obj_set_pos(gSecondaryLabel, 40, 328);
  lv_obj_set_width(gSecondaryLabel, 400);
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(gSecondaryLabel, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(gSecondaryLabel, message.c_str());

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
  if (!beginHttpRequest(http, gState.ota.downloadUrl)) {
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
    fetchPanelState();
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
  lv_obj_set_style_text_font(gActionTitleLabels[index], &lv_font_montserrat_16, 0);

  gActionSubtitleLabels[index] = lv_label_create(column);
  lv_label_set_long_mode(gActionSubtitleLabels[index], LV_LABEL_LONG_CLIP);
  lv_obj_set_width(gActionSubtitleLabels[index], lv_pct(100));
  lv_obj_set_style_text_align(gActionSubtitleLabels[index], LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gActionSubtitleLabels[index], &lv_font_montserrat_12, 0);
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
  lv_obj_set_style_text_font(gModeBadgeLabel, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(gModeBadgeLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gModeBadgeLabel, "BOOT");
  lv_obj_add_flag(gModeBadge, LV_OBJ_FLAG_HIDDEN);

  gTitleLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gTitleLabel, 0, 54);
  lv_obj_set_width(gTitleLabel, lv_pct(100));
  lv_obj_set_style_text_align(gTitleLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gTitleLabel, &lv_font_montserrat_24, 0);
  lv_obj_set_style_text_color(gTitleLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gTitleLabel, "HomeBrain");

  gCenterValueLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gCenterValueLabel, 0, 124);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &lv_font_montserrat_48, 0);
  lv_obj_set_style_text_color(gCenterValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gCenterValueLabel, "--");

  gSecondaryLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gSecondaryLabel, 70, 194);
  lv_obj_set_width(gSecondaryLabel, 340);
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &lv_font_montserrat_22, 0);
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

  static const lv_point_t kSunRayPoints[8][2] = {
    {{240, 68}, {240, 96}},
    {{286, 84}, {272, 106}},
    {{314, 128}, {290, 140}},
    {{318, 188}, {290, 182}},
    {{286, 232}, {272, 212}},
    {{194, 232}, {208, 212}},
    {{164, 188}, {190, 182}},
    {{166, 128}, {190, 140}}
  };
  static const lv_point_t kRainPoints[3][2] = {
    {{182, 234}, {168, 260}},
    {{228, 242}, {214, 268}},
    {{274, 234}, {260, 260}}
  };
  static const lv_point_t kSnowPoints[6][2] = {
    {{178, 236}, {198, 258}},
    {{178, 258}, {198, 236}},
    {{188, 230}, {188, 264}},
    {{246, 236}, {266, 258}},
    {{246, 258}, {266, 236}},
    {{256, 230}, {256, 264}}
  };
  static const lv_point_t kFogPoints[2][2] = {
    {{168, 232}, {304, 232}},
    {{182, 254}, {318, 254}}
  };
  static const lv_point_t kBoltPoints[5] = {
    {252, 212},
    {228, 258},
    {252, 258},
    {236, 300},
    {282, 238}
  };

  gWeatherSunCore = lv_obj_create(gMainCard);
  styleBackdropShape(
    gWeatherSunCore,
    182,
    98,
    116,
    116,
    hex(homebrain::palette::kAccentYellow),
    LV_RADIUS_CIRCLE,
    LV_OPA_40,
    LV_OPA_10
  );

  for (uint8_t index = 0; index < 8; index += 1) {
    gWeatherSunRays[index] = lv_line_create(gMainCard);
    styleBackdropLine(gWeatherSunRays[index], kSunRayPoints[index], 2, hex(homebrain::palette::kAccentYellow));
  }

  gWeatherCloudPuffs[0] = lv_obj_create(gMainCard);
  styleBackdropShape(gWeatherCloudPuffs[0], 150, 150, 64, 64, hex(homebrain::palette::kTextMuted), LV_RADIUS_CIRCLE);
  gWeatherCloudPuffs[1] = lv_obj_create(gMainCard);
  styleBackdropShape(gWeatherCloudPuffs[1], 192, 124, 90, 90, hex(homebrain::palette::kTextMuted), LV_RADIUS_CIRCLE);
  gWeatherCloudPuffs[2] = lv_obj_create(gMainCard);
  styleBackdropShape(gWeatherCloudPuffs[2], 250, 152, 66, 66, hex(homebrain::palette::kTextMuted), LV_RADIUS_CIRCLE);
  gWeatherCloudBase = lv_obj_create(gMainCard);
  styleBackdropShape(gWeatherCloudBase, 144, 176, 178, 50, hex(homebrain::palette::kTextMuted), 26);

  for (uint8_t index = 0; index < 3; index += 1) {
    gWeatherRainLines[index] = lv_line_create(gMainCard);
    styleBackdropLine(gWeatherRainLines[index], kRainPoints[index], 2, hex(homebrain::palette::kAccentBlue));
  }

  for (uint8_t index = 0; index < 6; index += 1) {
    gWeatherSnowLines[index] = lv_line_create(gMainCard);
    styleBackdropLine(gWeatherSnowLines[index], kSnowPoints[index], 2, hex(homebrain::palette::kTextSecondary), LV_OPA_40, 3);
  }

  for (uint8_t index = 0; index < 2; index += 1) {
    gWeatherFogLines[index] = lv_line_create(gMainCard);
    styleBackdropLine(gWeatherFogLines[index], kFogPoints[index], 2, hex(homebrain::palette::kAccentSlate), LV_OPA_30, 4);
  }

  gWeatherBolt = lv_line_create(gMainCard);
  styleBackdropLine(gWeatherBolt, kBoltPoints, 5, hex(homebrain::palette::kAccentOrange), LV_OPA_50, 5);

  gHintLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gHintLabel, 70, 268);
  lv_obj_set_width(gHintLabel, 340);
  lv_obj_set_style_text_align(gHintLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gHintLabel, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(gHintLabel, hex(homebrain::palette::kTextMuted), 0);
  lv_label_set_text(gHintLabel, "Swipe between surfaces. The knob adapts to the current mode.");
  lv_obj_add_flag(gHintLabel, LV_OBJ_FLAG_HIDDEN);

  gFooterLabel = lv_label_create(gMainCard);
  lv_obj_set_width(gFooterLabel, 320);
  lv_obj_set_pos(gFooterLabel, 80, 292);
  lv_obj_set_style_text_align(gFooterLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gFooterLabel, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(gFooterLabel, hex(homebrain::palette::kTextMuted), 0);
  lv_label_set_text(gFooterLabel, "Booting HomeBrain panel...");
  lv_obj_add_flag(gFooterLabel, LV_OBJ_FLAG_HIDDEN);

  createActionButton(0, 30, 300);
  createActionButton(1, 248, 300);
  createActionButton(2, 30, 390);
  createActionButton(3, 248, 390);
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
  gPendingThermostatCommit = true;
  gPendingThermostatValue = value;
  gPendingThermostatCommitAt = millis();
}

void commitPendingThermostatValueIfReady() {
  if (!gPendingThermostatCommit) {
    return;
  }

  if (millis() - gPendingThermostatCommitAt < kThermostatCommitDelayMs) {
    return;
  }

  ModeSnapshot* mode = currentMode();
  if (!mode || mode->id != "thermostat" || mode->metaDeviceId.isEmpty()) {
    gPendingThermostatCommit = false;
    return;
  }

  StaticJsonDocument<256> request;
  request["type"] = "thermostat.set_temperature";
  request["targetId"] = mode->metaDeviceId;
  request["value"] = gPendingThermostatValue;

  gPendingThermostatCommit = false;

  if (postPanelJson(panelActionUrl(), request)) {
    setStatusLine("Setpoint " + String(gPendingThermostatValue) + " sent");
    fetchPanelState();
  } else {
    setStatusLine("Setpoint update failed");
    renderMode();
  }
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
    const int next = constrain(
      mode->knob.value + (direction * max(1, mode->knob.step)),
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

    mode->centerValue = String(next) + String("°");
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
  if (currentA != gLastEncoderA && currentA == HIGH) {
    // Match the physical bezel direction to the UI contract:
    // clockwise increases, counterclockwise decreases.
    const int direction = (digitalRead(kEncoderBPin) == LOW) ? -1 : 1;
    handleEncoderTurn(direction);
  }
  gLastEncoderA = currentA;

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

  if (gPendingThermostatCommit) {
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
  gLastEncoderA = digitalRead(kEncoderAPin);

  setupWiFi();
}

void loop() {
  lv_tick_inc(5);
  lv_timer_handler();
  pollEncoder();
  commitPendingThermostatValueIfReady();
  persistBrightnessIfReady();
  ensureWiFiConnected();
  maybeRefreshState();
  maybeApplyOtaUpdate();
  delay(5);
}
