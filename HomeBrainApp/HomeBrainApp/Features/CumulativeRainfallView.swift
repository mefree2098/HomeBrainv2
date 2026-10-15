import Charts
import SwiftUI

private struct RainfallChartPoint: Identifiable {
    let date: Date
    let totalIn: Double
    var id: Date { date }
}

/// Shared by iPhone and iPad Weather and Data Platform screens. The server sums
/// canonical station intervals before reducing the number of chart points.
struct CumulativeRainfallView: View {
    let sourceKey: String
    var hours: Int? = nil
    var onHoursChange: ((Int) -> Void)? = nil
    @EnvironmentObject private var session: SessionStore
    @State private var selectedHours = 720
    @State private var points: [RainfallChartPoint] = []
    @State private var totalIn: Double?
    @State private var stationName = "Tempest weather station"
    @State private var firstObservedAt: Date?
    @State private var lastObservedAt: Date?
    @State private var observationCount = 0
    @State private var isLoading = true
    @State private var errorMessage: String?

    private let ranges = [("24H", 24), ("7D", 168), ("30D", 720), ("90D", 2160), ("1Y", 8760)]
    private var rangeHours: Int { hours ?? selectedHours }
    private var requestKey: String { "\(session.sessionContextID)|\(sourceKey)|\(rangeHours)" }
    private var rangeLabel: String { rangeHours >= 24 ? "\(rangeHours / 24) days" : "\(rangeHours) hours" }

    var body: some View {
        HBPanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Cumulative Rainfall", systemImage: "cloud.rain.fill")
                            .font(HBTypography.display(size: 18, weight: .bold))
                            .foregroundStyle(HBPalette.textPrimary)
                        Text("\(stationName) · Last \(rangeLabel)")
                            .font(HBTypography.body(size: 12, weight: .medium))
                            .foregroundStyle(HBPalette.textMuted)
                    }
                    Spacer(minLength: 0)
                }

                Text(totalIn.map { String(format: "%.3f in", $0) } ?? "—")
                    .font(HBTypography.display(size: 30, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(HBPalette.textPrimary)
                    .accessibilityIdentifier("rainfall-total")

                if hours == nil || onHoursChange != nil {
                    ViewThatFits(in: .horizontal) {
                        rangeButtons
                        ScrollView(.horizontal, showsIndicators: false) { rangeButtons }
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(HBTypography.body(size: 13, weight: .medium))
                        .foregroundStyle(HBPalette.textMuted)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else if isLoading && points.isEmpty {
                    ProgressView("Loading rainfall history")
                        .frame(maxWidth: .infinity, minHeight: 210)
                } else if points.isEmpty {
                    Text("No rainfall observations recorded in this time range.")
                        .font(HBTypography.body(size: 13, weight: .medium))
                        .foregroundStyle(HBPalette.textMuted)
                        .frame(maxWidth: .infinity, minHeight: 120)
                } else {
                    Chart(points) { point in
                        AreaMark(x: .value("Observed", point.date), y: .value("Rainfall (in)", point.totalIn))
                            .foregroundStyle(HBPalette.accentBlue.opacity(0.16))
                            .interpolationMethod(.stepEnd)
                        LineMark(x: .value("Observed", point.date), y: .value("Rainfall (in)", point.totalIn))
                            .foregroundStyle(HBPalette.accentBlue)
                            .interpolationMethod(.stepEnd)
                        if points.count == 1 {
                            PointMark(x: .value("Observed", point.date), y: .value("Rainfall (in)", point.totalIn))
                                .foregroundStyle(HBPalette.accentBlue)
                        }
                    }
                    .chartYScale(domain: 0...max(0.01, totalIn ?? 0))
                    .chartYAxisLabel("Rainfall (in)")
                    .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) }
                    .frame(height: 220)
                    .accessibilityLabel("Cumulative rainfall over the last \(rangeLabel)")
                }

                if observationCount > 0, let firstObservedAt, let lastObservedAt {
                    Text("Total recorded from \(firstObservedAt.formatted(date: .abbreviated, time: .shortened)) to \(lastObservedAt.formatted(date: .abbreviated, time: .shortened)) · \(observationCount.formatted()) observations. Gaps in station history are excluded.")
                        .font(HBTypography.body(size: 11, weight: .medium))
                        .foregroundStyle(HBPalette.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: requestKey) {
            points = []
            totalIn = nil
            observationCount = 0
            errorMessage = nil
            repeat {
                await loadRainfall()
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            } while !Task.isCancelled
        }
    }

    private var rangeButtons: some View {
        HStack(spacing: 8) {
            ForEach(ranges, id: \.1) { range in
                Button {
                    if let onHoursChange { onHoursChange(range.1) } else { selectedHours = range.1 }
                } label: {
                    Text(range.0)
                        .font(HBTypography.body(size: 12, weight: .bold))
                        .padding(.horizontal, 4)
                        .frame(minHeight: 30)
                }
                .buttonStyle(.borderedProminent)
                .tint(rangeHours == range.1 ? HBPalette.accentBlue : HBPalette.accentSlate)
                .accessibilityLabel("Rainfall range \(range.0)")
                .accessibilityAddTraits(rangeHours == range.1 ? .isSelected : [])
            }
        }
    }

    private func loadRainfall() async {
        isLoading = true
        defer { if !Task.isCancelled { isLoading = false } }
        do {
            var components = URLComponents()
            components.path = "/api/telemetry/rainfall"
            components.queryItems = [
                URLQueryItem(name: "sourceKey", value: sourceKey),
                URLQueryItem(name: "hours", value: String(rangeHours)),
                URLQueryItem(name: "maxPoints", value: "240")
            ]
            let response = try await session.apiClient.get(components.string ?? "/api/telemetry/rainfall")
            guard !Task.isCancelled else { return }
            let data = JSON.object(JSON.object(response)["data"])
            let rainfall = JSON.object(data["rainfall"])
            let source = JSON.object(data["source"])
            points = JSON.array(data["points"]).compactMap { item in
                let values = JSON.object(item["values"])
                guard let date = JSON.date(from: item["observedAt"]),
                      let value = values["cumulative_rainfall_in"] as? NSNumber else { return nil }
                return RainfallChartPoint(date: date, totalIn: value.doubleValue)
            }
            totalIn = (rainfall["totalIn"] as? NSNumber)?.doubleValue
            stationName = JSON.string(source, "name", fallback: "Tempest weather station")
            firstObservedAt = JSON.date(from: rainfall["firstObservedAt"])
            lastObservedAt = JSON.date(from: rainfall["lastObservedAt"])
            observationCount = JSON.int(rainfall, "observationCount")
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
            points = []
            totalIn = nil
            observationCount = 0
        }
    }

}
