# Shared device visuals

The dashboard, favorites, dashboard device grids, Devices page, and native device control sheets share a quieter surface and state hierarchy. Device identity comes first, followed by the current reading and supported actions. Light state uses amber; thermostat state uses cyan; other device families retain distinct symbols and accents. Existing device data, integration handlers, saved widget geometry, custom titles, energy history, color controls, and management features remain authoritative.

Web primitives live in `client/src/components/devices/`: `DeviceSymbol`, `TemperatureDial`, and `device-visuals.css`. Dashboard composition remains in `dashboard/dashboard-visuals.css`. The temperature arc is decorative SVG; the numeric value and real input controls remain accessible DOM. The shared slider forwards its accessible label to the actual thumb.

Native primitives live in `HomeBrainApp/HomeBrainApp/Features/HBDashboardVisuals.swift`: `HBDevicePanel`, `HBDeviceSymbol`, `HBDeviceTemperatureDial`, and `HBDeviceModeButton`. They support light/dark appearance and native accessibility. Dashboard summaries become a single column at accessibility text sizes. Web decoration respects reduced motion and does not introduce a rendering loop or downloaded graphic assets.

On phone-width web layouts, secondary header actions are available from More controls. Dashboard selection and editing remain available there. Weather details open by click or keyboard rather than competing hover/click state.

## Verification

- Web: `npm --prefix client run lint`, `npm --prefix client run build`, `npm --prefix client test -- --run` (13 tests).
- Native: the `HomeBrainApp` scheme builds for iOS Simulator. `DashboardVisualTests` in `HomeBrainAppleHomeUITests` exercises light brightness/power, thermostat setpoint/mode, the Devices control sheet, and the largest accessibility text size using synthetic signed-out preview data.
- Manual browser verification: desktop dark/light, 390px layout, mobile menu/theme, weather detail popovers, thermostat controls, and dashboard minimize/expand/save.
- Independent comparison against generated visual targets: web and iOS both 8.1/10. Screenshots and review notes are retained outside the source checkout.

To inspect the native dashboard without controlling a real home, launch with `-ui-preview -ui-preview-section dashboard -ui-preview-dashboard-focus visual-pilot`. `-ui-preview-section devices` opens the synthetic Devices page. The preview configuration does not change a user's saved dashboard.

The Freestone web deployment publishes browser UI changes. Native source changes require a separately distributed iOS app build before they appear on installed phones.
