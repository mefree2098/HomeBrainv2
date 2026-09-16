import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ApplianceIntegrationCard } from "./ApplianceIntegrationCard"
import { ApplianceControls } from "./ApplianceControls"

describe("appliance controls embedded in Settings", () => {
  it("does not nest forms or submit the surrounding Settings form", () => {
    const html = renderToStaticMarkup(<form>
      <ApplianceIntegrationCard provider="econet" />
      <ApplianceIntegrationCard provider="midea" />
      <ApplianceControls device={{ name: "TheaterAC", properties: { source: "midea", appliance: { capabilities: { eco: true } } } }} />
    </form>)
    expect(html.match(/<form\b/g)).toHaveLength(1)
    const buttons = html.match(/<button\b[^>]*>/g) || []
    expect(buttons.length).toBeGreaterThan(3)
    for (const button of buttons) expect(button).toContain('type="button"')
  })
})
