import XCTest

/// Exercise the actual Settings screen in the same stackless shell that exposed the disabled-link bug.
/// Preview mode is synthetic and signed out: this test cannot pair accessories or control a home.
@MainActor
final class AppleHomeNavigationTests: XCTestCase {
    func testAppleHomeSettingsIsTappableAndDismissible() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-ui-preview", "-ui-preview-section", "settings"]
        app.launch()
        let entry = app.buttons["settings-apple-home"]
        XCTAssertTrue(entry.waitForExistence(timeout: 30), "The actual Settings screen must offer an Apple Home entry.")
        XCTAssertTrue(entry.isEnabled, "Apple Home settings must not be a disabled NavigationLink.")
        if !entry.isHittable { app.swipeUp() }
        XCTAssertTrue(entry.isHittable)
        entry.tap()
        let title = app.navigationBars["Siri & Apple Home"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["apple-home-status"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Apple Home settings opened from stackless shell"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["apple-home-done"].tap()
        XCTAssertTrue(entry.waitForExistence(timeout: 10))
        XCTAssertTrue(entry.isEnabled)
    }
}
