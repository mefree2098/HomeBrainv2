import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ChartContainer } from "@/components/ui/chart"
import { CumulativeRainfallTooltip } from "./CumulativeRainfallChart"

vi.mock("recharts", async (importOriginal) => ({
  ...await importOriginal<typeof import("recharts")>(),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children
}))

describe("cumulative rainfall tooltip", () => {
  const config = { total: { label: "Cumulative rainfall", color: "#38bdf8" } }

  it("uses the observation timestamp when the shared tooltip supplies a metric label", () => {
    const observedAt = new Date("2026-10-15T16:00:00Z").getTime()
    const html = renderToStaticMarkup(
      <ChartContainer config={config}>
        <CumulativeRainfallTooltip active label={observedAt} payload={[
          { dataKey: "total", name: "total", value: 1.277, payload: { observedAt, total: 1.277 } }
        ]} />
      </ChartContainer>
    )
    expect(html).toContain(new Date(observedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))
    expect(html).toContain("1.277 in")
  })

  it.each([undefined, "invalid date"])("keeps rendering when the observation timestamp is %s", (observedAt) => {
    const html = renderToStaticMarkup(
      <ChartContainer config={config}>
        <CumulativeRainfallTooltip active label="Cumulative rainfall" payload={[
          { dataKey: "total", name: "total", value: 0, payload: { observedAt, total: 0 } }
        ]} />
      </ChartContainer>
    )
    expect(html).toContain("0.000 in")
    expect(html).not.toContain("Invalid Date")
  })
})
