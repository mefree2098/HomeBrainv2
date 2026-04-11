#pragma once

#include <Arduino.h>
#include <lvgl.h>

namespace homebrain {
namespace palette {

static constexpr uint32_t kPageTop = 0x061120;
static constexpr uint32_t kPageMid = 0x0B1831;
static constexpr uint32_t kPageBottom = 0x040A17;
static constexpr uint32_t kChrome = 0x081324;
static constexpr uint32_t kPanel = 0x0A1730;
static constexpr uint32_t kPanelSoft = 0x132442;
static constexpr uint32_t kPanelStroke = 0x50A7FF;
static constexpr uint32_t kTextPrimary = 0xF4F8FF;
static constexpr uint32_t kTextSecondary = 0xB6C4DE;
static constexpr uint32_t kTextMuted = 0x8CA0C2;
static constexpr uint32_t kAccentBlue = 0x4AE3FF;
static constexpr uint32_t kAccentPurple = 0x8F9BFF;
static constexpr uint32_t kAccentGreen = 0x33E3AA;
static constexpr uint32_t kAccentYellow = 0xFFE46B;
static constexpr uint32_t kAccentOrange = 0xFFC764;
static constexpr uint32_t kAccentRed = 0xFF8B7F;
static constexpr uint32_t kAccentSlate = 0x8193B2;

static inline lv_color_t hex(uint32_t value) {
  return lv_color_hex(value);
}

static inline lv_color_t accentForName(const String& accent) {
  const String normalized = accent;

  if (normalized == "blue" || normalized == "cyan") {
    return hex(kAccentBlue);
  }
  if (normalized == "purple") {
    return hex(kAccentPurple);
  }
  if (normalized == "green") {
    return hex(kAccentGreen);
  }
  if (normalized == "yellow") {
    return hex(kAccentYellow);
  }
  if (normalized == "orange") {
    return hex(kAccentOrange);
  }
  if (normalized == "red") {
    return hex(kAccentRed);
  }

  return hex(kAccentSlate);
}

}  // namespace palette
}  // namespace homebrain
