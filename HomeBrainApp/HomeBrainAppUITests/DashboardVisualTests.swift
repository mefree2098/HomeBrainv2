import XCTest

/// Exercises real dashboard controls using the signed-out, synthetic preview.
@MainActor
final class DashboardVisualTests: XCTestCase {
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
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Dashboard accessibility text size"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
