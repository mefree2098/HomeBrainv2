import SwiftUI

struct HomeBrainSensorTelemetryView: View {
    let device: DeviceItem
    private var snapshot: [String: Any] { JSON.object(device.properties["homebrainSensor"]) }

    var body: some View {
        HBDevicePanel {
            VStack(alignment: .leading, spacing: 14) {
                Text("Sensor suite telemetry").font(.headline)
                Text("\(device.isOnline ? "Online" : "Offline") · Last report \(device.lastSeen)")
                    .font(.caption).foregroundStyle(.secondary)
                Text("Firmware \(JSON.string(snapshot, "firmwareVersion")) · \(JSON.string(snapshot, "hardwareId"))")
                    .font(.caption2).foregroundStyle(.secondary)
                NavigationLink {
                    DataPlatformView(initialSourceKey: "device:\(device.id)")
                        .navigationTitle(device.name)
                } label: {
                    Label("View all history graphs", systemImage: "chart.xyaxis.line")
                }
                .buttonStyle(HBSecondaryButtonStyle())

                ForEach(["Measurements", "Power", "Diagnostics"], id: \.self) { section in
                    Text(section).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 145))], alignment: .leading, spacing: 10) {
                        ForEach(HomeBrainSensorTelemetry.rows(snapshot).filter { $0.section == section }) { row in
                            if row.numeric {
                                NavigationLink {
                                    DataPlatformView(initialSourceKey: "device:\(device.id)", initialMetricKey: row.key)
                                        .navigationTitle(row.label)
                                } label: { tile(row) }.buttonStyle(.plain)
                            } else { tile(row) }
                        }
                    }
                }
                Text("Unavailable is not zero. Online means connected, not that every module is healthy. Air, comfort, mold-risk and VOC-trend scores are estimates, not certified measurements.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func tile(_ row: HomeBrainSensorTelemetryRow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(row.label).font(.caption).foregroundStyle(.secondary)
            Text(row.value).font(.subheadline.weight(.semibold))
                .foregroundStyle(!row.available || row.value == "Not reporting" ? Color.orange : Color.primary)
            if row.numeric { Image(systemName: "chart.xyaxis.line").font(.caption2).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
        .background(HBGlassBackground(cornerRadius: 12, variant: .panelSoft))
    }
}
