import XCTest

/// Exercises real dashboard controls using the signed-out, synthetic preview.
@MainActor
final class DashboardVisualTests: XCTestCase {
    private func attachScreenshot(_ name: String, from app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSecurityAndClimateFitHalfWidthIPadWidgets() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "ipad-overview", "-ui-preview-weather-source", "tempest", "-homebrain.ios.theme-mode", "dark", "-homebrain.ios.main-menu-collapsed.regular", "YES"]
        app.launch()
        guard app.frame.width >= 1_000 else { throw XCTSkip("Exercises two widgets side by side on iPad") }
        let sensor = app.buttons["dashboard-sensor-preview-front-door-sensor"]
        XCTAssertTrue(sensor.waitForExistence(timeout: 30))
        let name = sensor.staticTexts["Front Door Sensor"]
        XCTAssertGreaterThanOrEqual(name.frame.width, 110, "Names need usable width beside the sensor icon")
        XCTAssertLessThanOrEqual(name.frame.height, 55, "Sensor names must not wrap one letter per line")
        let state = sensor.staticTexts["Closed"]
        XCTAssertLessThanOrEqual(state.frame.height, 25, "The complete sensor state must fit on one line")
        let climate = app.staticTexts["Climate"]
        XCTAssertGreaterThan(climate.frame.minX, sensor.frame.maxX, "Exercise the half-width layout from the regression")
        let location = app.staticTexts["Current location"]
        XCTAssertTrue(location.isHittable)
        XCTAssertGreaterThanOrEqual(location.frame.width, 100, "Provider badges must not squeeze the location into an ellipsis")
        let aqi = app.buttons["Open AQI details"]
        XCTAssertTrue(aqi.isHittable)
        attachScreenshot("iPad half-width Security and Climate", from: app)
        aqi.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        let doorLock = app.buttons["dashboard-lock-preview-lock"]
        reveal(doorLock, in: app)
        XCTAssertTrue(doorLock.isHittable)
        XCTAssertGreaterThanOrEqual(doorLock.frame.width, 160, "Lock controls must adapt to their own inset width")
        attachScreenshot("iPad security lower controls", from: app)
    }

    func testIPadSecurityReflowsWithSidebarAndRotation() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "ipad-overview", "-ui-preview-weather-source", "tempest", "-homebrain.ios.theme-mode", "light"]
        app.launch()
        guard app.frame.width >= 1_000 else { throw XCTSkip("Exercises iPad sidebar and rotation") }
        let sensor = app.buttons["dashboard-sensor-preview-front-door-sensor"]
        XCTAssertTrue(sensor.waitForExistence(timeout: 30))
        if app.buttons["Collapse main menu"].isHittable { app.buttons["Collapse main menu"].tap() }
        XCTAssertLessThanOrEqual(sensor.staticTexts["Front Door Sensor"].frame.height, 55)
        app.buttons["Expand main menu"].tap()
        XCTAssertLessThanOrEqual(sensor.staticTexts["Front Door Sensor"].frame.height, 55)
        XCTAssertGreaterThanOrEqual(sensor.staticTexts["Front Door Sensor"].frame.width, 110)
        XCUIDevice.shared.orientation = .portrait
        let rotationSettled = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in app.buttons.matching(identifier: "dashboard-sensor-preview-front-door-sensor").count == 1 }, object: nil
        )
        XCTAssertEqual(XCTWaiter.wait(for: [rotationSettled], timeout: 5), .completed)
        reveal(sensor, in: app)
        XCTAssertTrue(sensor.isHittable)
        XCTAssertLessThanOrEqual(sensor.staticTexts["Front Door Sensor"].frame.height, 55)
        XCTAssertGreaterThanOrEqual(sensor.staticTexts["Front Door Sensor"].frame.width, 110)
        attachScreenshot("iPad portrait after sidebar reflow", from: app)
    }

    func testIPadSecuritySupportsAccessibilityText() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "ipad-overview", "-homebrain.ios.theme-mode", "dark", "-homebrain.ios.main-menu-collapsed.regular", "YES", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        guard app.frame.width >= 1_000 else { throw XCTSkip("Exercises accessibility text in a half-width iPad widget") }
        let sensor = app.buttons["dashboard-sensor-preview-front-door-sensor"]
        XCTAssertTrue(app.staticTexts["Security Center"].waitForExistence(timeout: 30))
        let stay = app.buttons["Arm Stay"]
        let away = app.buttons["Arm Away"]
        XCTAssertGreaterThanOrEqual(stay.staticTexts["Arm Stay"].frame.width, 100)
        XCTAssertGreaterThanOrEqual(away.frame.minY, stay.frame.maxY, "Large alarm labels need separate full-width buttons")
        let name = sensor.staticTexts["Front Door Sensor"]
        reveal(name, in: app)
        XCTAssertTrue(name.isHittable)
        XCTAssertEqual(app.scrollViews.containing(.button, identifier: sensor.identifier).count, 1)
        XCTAssertGreaterThanOrEqual(name.frame.width, 250)
        XCTAssertLessThanOrEqual(name.frame.maxX, sensor.frame.maxX)
        XCTAssertLessThanOrEqual(name.frame.height, 150, "Large names should wrap into words, not individual letters")
        attachScreenshot("iPad security with accessibility text", from: app)
    }

    func testSecurityUsesOneScrollSurfaceOnPhone() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "security", "-homebrain.ios.theme-mode", "dark"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Security Center"].waitForExistence(timeout: 30))
        XCTAssertEqual(app.scrollViews.containing(.button, identifier: "dashboard-sensor-preview-front-door-sensor").count, 1, "Phone security sensors must scroll with the dashboard instead of clipping inside a second scroll view")
        XCTAssertGreaterThanOrEqual(app.buttons["Arm Stay"].frame.height, 44)
        attachScreenshot("iPhone Air Security Center", from: app)
        let lastLock = app.buttons["dashboard-lock-preview-back-door-lock"]
        reveal(lastLock, in: app)
        XCTAssertTrue(lastLock.isHittable, "The final lock must remain reachable through the dashboard scroll")
        XCTAssertEqual(app.scrollViews.containing(.button, identifier: "dashboard-lock-preview-back-door-lock").count, 1)
        attachScreenshot("iPhone Air security lower controls", from: app)
    }

    func testClimateDetailsOpenAndDismissOnPhone() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "weather", "-ui-preview-weather-source", "tempest", "-homebrain.ios.theme-mode", "dark"]
        app.launch()
        let aqi = app.buttons["Open AQI details"]
        XCTAssertTrue(aqi.waitForExistence(timeout: 30))
        XCTAssertTrue(aqi.isHittable)
        let uv = app.buttons["Open UV details"]
        XCTAssertTrue(uv.isHittable)
        XCTAssertLessThanOrEqual(uv.frame.maxX, app.frame.maxX)
        let temperature = app.staticTexts["climate-summary-temperature"]
        XCTAssertGreaterThan(aqi.frame.minX, temperature.frame.maxX, "Air readings should use the space beside the temperature")
        let wind = app.buttons["Open Live Wind details"]
        XCTAssertLessThan(wind.frame.minY - temperature.frame.minY, 260, "The phone summary should not push weather metrics down with empty space")
        attachScreenshot("iPhone Air Climate", from: app)
        aqi.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        XCTAssertTrue(aqi.waitForExistence(timeout: 10))
        XCTAssertTrue(aqi.isHittable)
        reveal(wind, in: app)
        XCTAssertTrue(wind.isHittable)
        wind.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
    }

    func testClimateSummaryExpandsForAccessibilityText() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "weather", "-ui-preview-weather-source", "tempest", "-homebrain.ios.theme-mode", "light", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let temperature = app.staticTexts["climate-summary-temperature"]
        XCTAssertTrue(temperature.waitForExistence(timeout: 30))
        let aqi = app.buttons["Open AQI details"]
        reveal(aqi, in: app)
        XCTAssertTrue(aqi.isHittable)
        XCTAssertGreaterThanOrEqual(aqi.frame.minY, temperature.frame.maxY)
        let uv = app.buttons["Open UV details"]
        XCTAssertGreaterThanOrEqual(aqi.frame.minX, app.frame.minX)
        XCTAssertLessThanOrEqual(uv.frame.maxX, app.frame.maxX)
        attachScreenshot("Climate with accessibility text", from: app)
        let indoor = app.buttons["Open Indoor Air details"].firstMatch
        reveal(indoor, in: app)
        XCTAssertTrue(indoor.isHittable)
        indoor.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
    }

    func testDenseLightingKeepsNamesAndControlsInLandscape() {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "lighting", "-homebrain.ios.theme-mode", "dark"]
        app.launch()
        let title = app.staticTexts["dashboard-device-name-preview-theater-2"]
        XCTAssertTrue(title.waitForExistence(timeout: 30))
        if app.buttons["Collapse main menu"].isHittable { app.buttons["Collapse main menu"].tap() }
        XCTAssertEqual(title.label, "Theater Ceiling Accent Strip")
        let slider = app.sliders["Brightness for Theater Ceiling Accent Strip"]
        reveal(slider, in: app)
        XCTAssertTrue(slider.isHittable)
        XCTAssertGreaterThanOrEqual(slider.frame.width, 170, "Dense cards need enough usable width for names and controls")
        let previous = slider.value as? String
        slider.adjust(toNormalizedSliderPosition: 0.4)
        XCTAssertNotEqual(slider.value as? String, previous)
        let off = app.buttons["Turn Off Theater Ceiling Accent Strip"]
        reveal(off, in: app)
        XCTAssertGreaterThanOrEqual(off.frame.height, 44)
        off.tap()
        XCTAssertTrue(app.buttons["Turn On Theater Ceiling Accent Strip"].waitForExistence(timeout: 5))
        attachScreenshot("Adaptive theater lighting landscape", from: app)
    }

    func testSmallLightingWidgetPreservesFullIdentityAndColor() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "lighting-small", "-homebrain.ios.theme-mode", "light"]
        app.launch()
        let title = app.staticTexts["dashboard-device-name-preview-theater-0"]
        XCTAssertTrue(title.waitForExistence(timeout: 30))
        if app.buttons["Collapse main menu"].isHittable { app.buttons["Collapse main menu"].tap() }
        let color = app.buttons["Set color for Theater Wall Sconce Left"]
        // Stay in the card padding: a drag through its brightness slider edits it instead of scrolling.
        let cardSwipeX = title.frame.minX - 8
        revealInNarrowWidget(color, in: app, atX: cardSwipeX)
        XCTAssertTrue(color.isHittable)
        XCTAssertGreaterThanOrEqual(color.frame.width, 44)
        XCTAssertGreaterThanOrEqual(color.frame.minY, title.frame.maxY, "Color controls must not squeeze the name")
        attachScreenshot("Small lighting widget", from: app)
        color.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5), "The native color picker must open")
        app.buttons["Sliders"].tap()
        // Green starts inside the track; the red thumb starts at the clipped landscape edge.
        let green = app.sliders["Green"]
        XCTAssertTrue(green.waitForExistence(timeout: 5))
        let originalGreen = green.value as? String
        green.adjust(toNormalizedSliderPosition: 0.2)
        let selectedGreen = green.value as? String
        XCTAssertNotEqual(selectedGreen, originalGreen)
        attachScreenshot("Lighting color picker", from: app)
        app.buttons["Done"].tap()
        color.tap()
        app.buttons["Sliders"].tap()
        let restoredPercent = try XCTUnwrap(Double((green.value as? String ?? "").replacingOccurrences(of: "%", with: "")))
        let selectedPercent = try XCTUnwrap(Double((selectedGreen ?? "").replacingOccurrences(of: "%", with: "")))
        // Device colors use 8-bit RGB, while the system slider reports rounded percentages.
        XCTAssertEqual(restoredPercent, selectedPercent, accuracy: 1, "The selected color must persist on the device")
        app.buttons["Done"].tap()
        let lastControl = app.buttons["Turn On Theater Ceiling Fan Power"]
        revealInNarrowWidget(lastControl, in: app, atX: cardSwipeX)
        XCTAssertTrue(lastControl.isHittable, "The last device must remain reachable in a narrow widget")
    }

    func testDenseLightingExpandsForAccessibilityText() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "lighting", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let name = app.staticTexts["dashboard-device-name-preview-theater-2"]
        XCTAssertTrue(name.waitForExistence(timeout: 30))
        let slider = app.sliders["Brightness for Theater Ceiling Accent Strip"]
        reveal(slider, in: app)
        XCTAssertTrue(slider.isHittable)
        XCTAssertGreaterThan(slider.frame.width, 250)
        XCTAssertLessThanOrEqual(slider.frame.maxX, app.frame.maxX)
        attachScreenshot("Lighting with accessibility text", from: app)
    }

    private func revealInNarrowWidget(_ element: XCUIElement, in app: XCUIApplication, atX x: CGFloat) {
        // A small widget may occupy only the left quarter of a landscape dashboard.
        // Swipe inside its cards, rather than the empty center of the app window.
        let normalizedX = (x - app.frame.minX) / app.frame.width
        for _ in 0..<20 {
            if element.isHittable { return }
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: normalizedX, dy: 0.8))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: normalizedX, dy: 0.25))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<8 {
            if element.isHittable { return }
            app.swipeUp()
        }
    }

    func testPilotControlsKeepTheirBehavior() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "visual-pilot"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Welcome home."].waitForExistence(timeout: 30))
        let brightness = app.sliders["Brightness for Patio Lights"]
        reveal(brightness, in: app)
        XCTAssertTrue(brightness.isHittable)
        let previousBrightness = brightness.value as? String
        brightness.adjust(toNormalizedSliderPosition: 0.4)
        XCTAssertNotEqual(brightness.value as? String, previousBrightness)
        let off = app.buttons["Turn off Patio Lights"]
        reveal(off, in: app)
        off.tap()
        XCTAssertTrue(app.buttons["Turn on Patio Lights"].waitForExistence(timeout: 5))
        app.buttons["Turn on Patio Lights"].tap()
        XCTAssertTrue(app.buttons["Turn off Patio Lights"].waitForExistence(timeout: 5))

        let target = app.sliders["Target temperature for Upstairs Climate Array"]
        reveal(target, in: app)
        XCTAssertTrue(target.isHittable)
        let previousTarget = target.value as? String
        target.adjust(toNormalizedSliderPosition: 0.6)
        XCTAssertNotEqual(target.value as? String, previousTarget)
        let heat = app.buttons["Heat"]
        reveal(heat, in: app)
        heat.tap()
        XCTAssertTrue(heat.isSelected)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Pilot thermostat after control"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testDeviceListOpensNativeControls() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "devices"]
        app.launch()
        let controls = app.buttons["Open controls for Upstairs Climate Array"]
        XCTAssertTrue(controls.waitForExistence(timeout: 30))
        reveal(controls, in: app)
        controls.tap()
        app.swipeUp()
        let target = app.sliders["Target temperature for Upstairs Climate Array"]
        reveal(target, in: app)
        XCTAssertTrue(target.isHittable)
        let previous = target.value as? String
        target.adjust(toNormalizedSliderPosition: 0.8)
        XCTAssertNotEqual(target.value as? String, previous)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Shared native thermostat controls"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testDashboardControlsRemainReachableWithLargeText() {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "dashboard", "-ui-preview-dashboard-focus", "visual-pilot", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Welcome home."].waitForExistence(timeout: 30))
        let brightness = app.sliders["Brightness for Patio Lights"]
        reveal(brightness, in: app)
        XCTAssertTrue(brightness.isHittable)
        let target = app.sliders["Target temperature for Upstairs Climate Array"]
        reveal(target, in: app)
        XCTAssertTrue(target.isHittable)
        let auto = app.buttons["Auto"]
        reveal(auto, in: app)
        XCTAssertTrue(auto.isHittable)
        XCTAssertGreaterThan(auto.frame.width, 250, "Large text mode labels need a full-width button")
        let cool = app.buttons["Cool"]
        XCTAssertGreaterThanOrEqual(cool.frame.minY, auto.frame.maxY, "Mode buttons must stack at accessibility text sizes")
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Dashboard accessibility text size"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
