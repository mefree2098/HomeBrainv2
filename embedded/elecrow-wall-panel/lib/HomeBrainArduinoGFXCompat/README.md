# HomeBrain Arduino GFX Compat

This local compatibility library is a minimal subset of the Arduino_GFX files
bundled by ELECROW in their reference firmware repository for the CrowPanel
2.1 inch rotary display:

- Source repository: https://github.com/Elecrow-RD/CrowPanel-2.1inch-HMI-ESP32-Rotary-Display-480-480-IPS-Round-Touch-Knob-Screen
- Bundled library path:
  `example/libraries/GFX_Library_for_Arduino`

Why this exists:

- the current PlatformIO registry release of `GFX Library for Arduino` no
  longer matches the API used by ELECROW's ST7701 RGB panel examples
- this firmware needs the older `Arduino_ST7701_RGBPanel` and
  `Arduino_ESP32RGBPanel` implementation shipped by ELECROW

Only the source files required by this firmware were copied into `src/`.
