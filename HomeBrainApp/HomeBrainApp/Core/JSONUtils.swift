import Foundation

enum JSON {
    static func object(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    static func array(_ value: Any?) -> [[String: Any]] {
        value as? [[String: Any]] ?? []
    }

    static func string(_ object: [String: Any], _ key: String, fallback: String = "") -> String {
        if let raw = object[key] as? String {
            return raw
        }
        if let raw = object[key] {
            return String(describing: raw)
        }
        return fallback
    }

    static func optionalString(_ object: [String: Any], _ key: String) -> String? {
        if let raw = object[key] as? String, !raw.isEmpty {
            return raw
        }
        return nil
    }

    static func bool(_ object: [String: Any], _ key: String, fallback: Bool = false) -> Bool {
        if let raw = object[key] as? Bool {
            return raw
        }
        if let raw = object[key] as? NSNumber {
            return raw.boolValue
        }
        if let raw = object[key] as? String {
            switch raw.lowercased() {
            case "true", "1", "yes", "on":
                return true
            case "false", "0", "no", "off":
                return false
            default:
                return fallback
            }
        }
        return fallback
    }

    static func int(_ object: [String: Any], _ key: String, fallback: Int = 0) -> Int {
        if let raw = object[key] as? Int {
            return raw
        }
        if let raw = object[key] as? NSNumber {
            return raw.intValue
        }
        if let raw = object[key] as? String, let parsed = Int(raw) {
            return parsed
        }
        return fallback
    }

    static func double(_ object: [String: Any], _ key: String, fallback: Double = 0) -> Double {
        if let raw = object[key] as? Double {
            return raw
        }
        if let raw = object[key] as? NSNumber {
            return raw.doubleValue
        }
        if let raw = object[key] as? String, let parsed = Double(raw) {
            return parsed
        }
        return fallback
    }

    static func id(_ object: [String: Any]) -> String {
        if let primary = optionalString(object, "_id") {
            return primary
        }
        if let fallback = optionalString(object, "id") {
            return fallback
        }
        return UUID().uuidString
    }

    static func date(from value: Any?) -> Date? {
        if let date = value as? Date {
            return date
        }
        if let stringValue = value as? String {
            let iso = ISO8601DateFormatter()
            if let parsed = iso.date(from: stringValue) {
                return parsed
            }

            let fallback = DateFormatter()
            fallback.locale = Locale(identifier: "en_US_POSIX")
            fallback.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
            if let parsed = fallback.date(from: stringValue) {
                return parsed
            }
        }
        return nil
    }

    static func displayDate(from value: Any?) -> String {
        guard let parsed = date(from: value) else {
            if let stringValue = value as? String {
                return stringValue
            }
            return "Never"
        }

        return DateFormatter.localizedString(from: parsed, dateStyle: .short, timeStyle: .short)
    }

    static func prettyString(_ value: Any?) -> String {
        guard let value else {
            return ""
        }

        if let stringValue = value as? String {
            return stringValue
        }

        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted]),
           let rendered = String(data: data, encoding: .utf8) {
            return rendered
        }

        return String(describing: value)
    }
}
