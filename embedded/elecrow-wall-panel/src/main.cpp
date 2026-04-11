#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include <Arduino_GFX_Library.h>
#include <Adafruit_CST8XX.h>
#include <PCF8574.h>

#include "HomeBrainPanelConfig.h"
#include "HomeBrainPalette.h"

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
constexpr uint8_t kModeSlots = 5;
constexpr uint8_t kPwmChannel = 0;
constexpr uint8_t kPwmResolution = 8;
constexpr uint32_t kPwmFrequency = 5000;
constexpr unsigned long kWifiRetryMs = 15000;
constexpr unsigned long kEncoderLongPressMs = 900;
constexpr unsigned long kStateRefreshFallbackMs = 5000;
constexpr unsigned long kThermostatCommitDelayMs = 400;
constexpr int kSwipeThreshold = 120;
constexpr int kSwipeVerticalLimit = 90;
constexpr unsigned long kSwipeWindowMs = 350;

PCF8574 gPcf8574(0x21);
Adafruit_CST8XX gTouchPanel;

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
  KnobActionConfig knob;
  QuickAction quickActions[kActionSlots];
  uint8_t quickActionCount = 0;
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
int gPendingThermostatValue = 0;
unsigned long gPendingThermostatCommitAt = 0;
unsigned long gLastWifiAttemptAt = 0;
unsigned long gLastStateFetchAt = 0;
unsigned long gLastActivateAttemptAt = 0;

String gStatusLine = "Booting HomeBrain panel...";

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
lv_obj_t* gActionButtons[kActionSlots] = {};
lv_obj_t* gActionTitleLabels[kActionSlots] = {};
lv_obj_t* gActionSubtitleLabels[kActionSlots] = {};

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

bool beginHttpRequest(HTTPClient& http, const String& url) {
  if (url.startsWith("https://")) {
    static WiFiClientSecure secureClient;
    secureClient.setInsecure();
    return http.begin(secureClient, url);
  }

  static WiFiClient plainClient;
  return http.begin(plainClient, url);
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
  return "SURFACE";
}

void setStatusLine(const String& status) {
  gStatusLine = status;
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

void initBacklight() {
  ledcSetup(kPwmChannel, kPwmFrequency, kPwmResolution);
  ledcAttachPin(kBacklightPin, kPwmChannel);
  ledcWrite(kPwmChannel, 240);
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
  gState = PanelState();
  gState.panelId = jsonVariantToString(state["panel"]["id"]);
  gState.panelName = jsonVariantToString(state["panel"]["name"]);
  gState.room = jsonVariantToString(state["panel"]["room"]);
  gState.panelStatus = jsonVariantToString(state["panel"]["status"]);
  gState.hardwareProfile = jsonVariantToString(state["panel"]["hardwareProfile"]);
  gState.pollIntervalMs = state["transport"]["pollIntervalMs"] | kStateRefreshFallbackMs;

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
    for (uint8_t index = 0; index < kModeSlots; index += 1) {
      if (!gState.modes[index].id.isEmpty()) {
        gState.modeOrder[gState.modeCount] = gState.modes[index].id;
        gState.modeCount += 1;
      }
    }
  }

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

  lv_obj_set_style_radius(button, 24, 0);
  lv_obj_set_style_border_width(button, 1, 0);
  lv_obj_set_style_border_color(button, accent, 0);
  lv_obj_set_style_bg_color(button, hex(homebrain::palette::kPanelSoft), 0);
  lv_obj_set_style_bg_opa(button, LV_OPA_80, 0);
  lv_obj_set_style_shadow_width(button, 0, 0);
  lv_obj_set_style_pad_all(button, 14, 0);
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

void renderMode() {
  ModeSnapshot* mode = currentMode();
  if (!mode) {
    lv_label_set_text(gModeBadgeLabel, "CONNECTING");
    lv_label_set_text(gTitleLabel, "HomeBrain");
    lv_label_set_text(gCenterValueLabel, "--");
    lv_label_set_text(gSecondaryLabel, "Waiting for panel state");
    lv_label_set_text(gHintLabel, "Connect to Wi-Fi and fetch HomeBrain panel state.");
    updateFooter();
    return;
  }

  const lv_color_t accent = accentForName(mode->accent);
  lv_label_set_text(gModeBadgeLabel, modeLabel(mode->id).c_str());
  lv_label_set_text(gTitleLabel, mode->title.c_str());
  lv_label_set_text(gCenterValueLabel, mode->centerValue.c_str());
  lv_label_set_text(gSecondaryLabel, mode->secondaryValue.c_str());
  lv_label_set_text(gHintLabel, mode->hint.c_str());

  lv_obj_set_style_border_color(gMainCard, accent, 0);
  lv_obj_set_style_arc_color(gArc, hex(homebrain::palette::kPanelStroke), LV_PART_MAIN);
  lv_obj_set_style_arc_color(gArc, accent, LV_PART_INDICATOR);
  lv_arc_set_range(gArc, mode->knob.minValue, mode->knob.maxValue);
  lv_arc_set_value(gArc, mode->knob.value);

  for (uint8_t index = 0; index < kActionSlots; index += 1) {
    if (index < mode->quickActionCount && mode->quickActions[index].valid) {
      const QuickAction& action = mode->quickActions[index];
      lv_obj_clear_flag(gActionButtons[index], LV_OBJ_FLAG_HIDDEN);
      styleButton(gActionButtons[index], action);
      lv_label_set_text(gActionTitleLabels[index], action.label.c_str());
      lv_label_set_text(gActionSubtitleLabels[index], action.subtitle.c_str());
      lv_obj_set_style_text_color(gActionTitleLabels[index], hex(homebrain::palette::kTextPrimary), 0);
      lv_obj_set_style_text_color(gActionSubtitleLabels[index], accentForName(action.accent), 0);
    } else {
      lv_obj_add_flag(gActionButtons[index], LV_OBJ_FLAG_HIDDEN);
      lv_label_set_text(gActionTitleLabels[index], "");
      lv_label_set_text(gActionSubtitleLabels[index], "");
    }
  }

  updateFooter();
}

void changeMode(int delta) {
  if (!gState.loaded || gState.modeCount == 0) {
    return;
  }

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

bool postPanelJson(const String& url, JsonDocument& requestDocument, JsonDocument& responseDocument) {
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

  const String payload = http.getString();
  http.end();

  const DeserializationError error = deserializeJson(responseDocument, payload);
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

  const String payload = http.getString();
  http.end();

  const DeserializationError error = deserializeJson(responseDocument, payload);
  if (error) {
    return false;
  }

  return statusCode >= 200 && statusCode < 300;
}

bool activatePanel() {
  StaticJsonDocument<512> request;
  StaticJsonDocument<1024> response;
  request["ipAddress"] = WiFi.localIP().toString();
  request["firmwareVersion"] = HOMEBRAIN_PANEL_FIRMWARE_VERSION;

  const bool ok = postPanelJson(panelActivateUrl(), request, response);
  if (ok) {
    gPanelActivated = true;
    setStatusLine("Panel activated");
    return true;
  }

  setStatusLine("Activation failed");
  return false;
}

bool fetchPanelState() {
  DynamicJsonDocument response(32768);
  const bool ok = getPanelJson(panelStateUrl(), response);
  if (!ok) {
    setStatusLine("State refresh failed");
    return false;
  }

  if (!parseState(response)) {
    setStatusLine("State payload invalid");
    return false;
  }

  gLastStateFetchAt = millis();
  setStatusLine("Live");
  renderMode();
  return true;
}

void dispatchQuickAction(const QuickAction& action) {
  if (!action.valid || action.type.isEmpty() || action.type == "panel.noop") {
    return;
  }

  StaticJsonDocument<512> request;
  DynamicJsonDocument response(2048);

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

  if (postPanelJson(panelActionUrl(), request, response)) {
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

  const intptr_t buttonIndex = reinterpret_cast<intptr_t>(lv_event_get_user_data(event));
  ModeSnapshot* mode = currentMode();
  if (!mode) {
    return;
  }

  if (buttonIndex < 0 || buttonIndex >= mode->quickActionCount) {
    return;
  }

  dispatchQuickAction(mode->quickActions[buttonIndex]);
}

void createActionButton(uint8_t index, lv_coord_t x, lv_coord_t y) {
  gActionButtons[index] = lv_btn_create(gMainCard);
  lv_obj_set_size(gActionButtons[index], 180, 92);
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
  lv_obj_set_style_text_font(gActionTitleLabels[index], &lv_font_montserrat_18, 0);

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

  lv_obj_t* glowLeft = lv_obj_create(gScreen);
  lv_obj_set_size(glowLeft, 220, 220);
  lv_obj_set_style_radius(glowLeft, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(glowLeft, hex(homebrain::palette::kAccentBlue), 0);
  lv_obj_set_style_bg_opa(glowLeft, LV_OPA_20, 0);
  lv_obj_set_style_border_width(glowLeft, 0, 0);
  lv_obj_set_style_shadow_width(glowLeft, 0, 0);
  lv_obj_set_pos(glowLeft, -40, 24);

  lv_obj_t* glowRight = lv_obj_create(gScreen);
  lv_obj_set_size(glowRight, 240, 240);
  lv_obj_set_style_radius(glowRight, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(glowRight, hex(homebrain::palette::kAccentPurple), 0);
  lv_obj_set_style_bg_opa(glowRight, LV_OPA_20, 0);
  lv_obj_set_style_border_width(glowRight, 0, 0);
  lv_obj_set_style_shadow_width(glowRight, 0, 0);
  lv_obj_set_pos(glowRight, 280, 42);

  gMainCard = lv_obj_create(gScreen);
  lv_obj_set_size(gMainCard, 430, 430);
  lv_obj_center(gMainCard);
  lv_obj_clear_flag(gMainCard, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_radius(gMainCard, 44, 0);
  lv_obj_set_style_bg_color(gMainCard, hex(homebrain::palette::kPanel), 0);
  lv_obj_set_style_bg_opa(gMainCard, LV_OPA_85, 0);
  lv_obj_set_style_border_width(gMainCard, 1, 0);
  lv_obj_set_style_border_color(gMainCard, hex(homebrain::palette::kPanelStroke), 0);
  lv_obj_set_style_shadow_width(gMainCard, 0, 0);
  lv_obj_set_style_pad_all(gMainCard, 0, 0);

  gModeBadge = lv_obj_create(gMainCard);
  lv_obj_set_size(gModeBadge, 128, 34);
  lv_obj_set_pos(gModeBadge, 24, 22);
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

  gTitleLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gTitleLabel, 24, 72);
  lv_obj_set_style_text_font(gTitleLabel, &lv_font_montserrat_22, 0);
  lv_obj_set_style_text_color(gTitleLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gTitleLabel, "HomeBrain");

  gCenterValueLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gCenterValueLabel, 0, 134);
  lv_obj_set_width(gCenterValueLabel, lv_pct(100));
  lv_obj_set_style_text_align(gCenterValueLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gCenterValueLabel, &lv_font_montserrat_28, 0);
  lv_obj_set_style_text_color(gCenterValueLabel, hex(homebrain::palette::kTextPrimary), 0);
  lv_label_set_text(gCenterValueLabel, "--");

  gSecondaryLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gSecondaryLabel, 36, 188);
  lv_obj_set_width(gSecondaryLabel, 360);
  lv_obj_set_style_text_align(gSecondaryLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gSecondaryLabel, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(gSecondaryLabel, hex(homebrain::palette::kTextSecondary), 0);
  lv_label_set_text(gSecondaryLabel, "Waiting for panel state");

  gArc = lv_arc_create(gMainCard);
  lv_obj_set_size(gArc, 232, 232);
  lv_obj_set_pos(gArc, 98, 94);
  lv_arc_set_rotation(gArc, 135);
  lv_arc_set_bg_angles(gArc, 0, 270);
  lv_arc_set_range(gArc, 0, 100);
  lv_arc_set_value(gArc, 50);
  lv_obj_remove_style(gArc, nullptr, LV_PART_KNOB);
  lv_obj_clear_flag(gArc, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_width(gArc, 10, LV_PART_MAIN);
  lv_obj_set_style_arc_width(gArc, 10, LV_PART_INDICATOR);
  lv_obj_set_style_arc_opa(gArc, LV_OPA_60, LV_PART_MAIN);

  gHintLabel = lv_label_create(gMainCard);
  lv_obj_set_pos(gHintLabel, 36, 268);
  lv_obj_set_width(gHintLabel, 360);
  lv_obj_set_style_text_align(gHintLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gHintLabel, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(gHintLabel, hex(homebrain::palette::kTextMuted), 0);
  lv_label_set_text(gHintLabel, "Swipe between surfaces. The knob adapts to the current mode.");

  createActionButton(0, 20, 316);
  createActionButton(1, 230, 316);
  createActionButton(2, 20, 214);
  createActionButton(3, 230, 214);

  gFooterLabel = lv_label_create(gScreen);
  lv_obj_set_width(gFooterLabel, 420);
  lv_obj_set_pos(gFooterLabel, 30, 452);
  lv_obj_set_style_text_align(gFooterLabel, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(gFooterLabel, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(gFooterLabel, hex(homebrain::palette::kTextMuted), 0);
  lv_label_set_text(gFooterLabel, "Booting HomeBrain panel...");
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
  DynamicJsonDocument response(1024);
  request["type"] = "thermostat.set_temperature";
  request["targetId"] = mode->metaDeviceId;
  request["value"] = gPendingThermostatValue;

  if (postPanelJson(panelActionUrl(), request, response)) {
    setStatusLine("Setpoint " + String(gPendingThermostatValue) + " sent");
    fetchPanelState();
  } else {
    setStatusLine("Setpoint update failed");
    renderMode();
  }

  gPendingThermostatCommit = false;
}

void handleEncoderTurn(int direction) {
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
    mode->centerValue = String(next) + String("°");
    queueThermostatCommit(next);
    setStatusLine("Adjusting setpoint");
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
  const int currentA = digitalRead(kEncoderAPin);
  if (currentA != gLastEncoderA && currentA == HIGH) {
    const int direction = (digitalRead(kEncoderBPin) == LOW) ? 1 : -1;
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

  if (!gPanelActivated) {
    if (millis() - gLastActivateAttemptAt < 10'000UL) {
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
  ensureWiFiConnected();
  maybeRefreshState();
  delay(5);
}
