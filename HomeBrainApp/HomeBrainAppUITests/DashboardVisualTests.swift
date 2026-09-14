import XCTest

/// Exercises real dashboard controls using the signed-out, synthetic preview.
@MainActor
final class DashboardVisualTests: XCTestCase {
    private func attachScreenshot(_ name: String, from app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
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
        attachScreenshot("iPhone Air Climate", from: app)
        aqi.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        XCTAssertTrue(aqi.waitForExistence(timeout: 10))
        XCTAssertTrue(aqi.isHittable)
        let wind = app.buttons["Open Live Wind details"]
        reveal(wind, in: app)
        XCTAssertTrue(wind.isHittable)
        wind.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
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
