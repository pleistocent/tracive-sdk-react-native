import Foundation

// The Swift overlay and screens name these from the base Swift SDK, which is not in this pod: a
// React Native app's base SDK is JavaScript. Each keeps the spelling they use, so their copies
// compile with only the imports removed.

public struct ReportIncidentDate: Hashable, Comparable, Sendable, CustomStringConvertible {
  public let year: Int
  public let month: Int
  public let day: Int

  public init?(iso8601 string: String) {
    let parts = string.split(separator: "-", omittingEmptySubsequences: false)
    guard string.utf8.count == 10, parts.count == 3, let year = Int(parts[0]),
      let month = Int(parts[1]), let day = Int(parts[2]), (1...12).contains(month),
      (1...Self.daysIn(month: month, year: year)).contains(day)
    else { return nil }
    self.year = year
    self.month = month
    self.day = day
  }

  public init(_ date: Date, timeZone: TimeZone = .current) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    year = parts.year ?? 1
    month = parts.month ?? 1
    day = parts.day ?? 1
  }

  public var iso8601: String { String(format: "%04d-%02d-%02d", year, month, day) }

  public var description: String { iso8601 }

  public static func < (lhs: ReportIncidentDate, rhs: ReportIncidentDate) -> Bool {
    (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
  }

  private static func daysIn(month: Int, year: Int) -> Int {
    switch month {
    case 2: return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
    case 4, 6, 9, 11: return 30
    default: return 31
    }
  }
}

public struct ReportAttachment: Sendable {
  public let bytes: Data
  public let mimeType: String
}

public struct TraciveEnvironment {
  public let baseUrl: URL
}

public struct ReportFormTarget {
  public let scheme: String

  public static func `for`(_ environment: TraciveEnvironment) -> ReportFormTarget {
    ReportFormTarget(scheme: "tracive")
  }
}

// Named by `TraciveReports(client:)`, `ReportDraft(query:)` and `ReportPrefill(query:)`, and by the
// catch of the base SDK's errors. Nothing here reaches them: JavaScript answers every token
// request.
public struct TraciveQuery {
  public let searchQueryIndex: String
}

public protocol TraciveTokenSource: Sendable {
  func accessToken() async throws -> String
  func refreshTokens(staleAccessToken: String) async throws -> String
}

public struct TraciveClient {
  public let oauth: (any TraciveTokenSource)?
  public let environment: TraciveEnvironment
}

public enum TraciveError: Error {
  public struct Info {
    public let code: String?
  }

  case invalidToken
  case expiredToken
  case grantRevoked
  case missingScope
  case network
  case server(status: Int, code: String?)
  case proxyModeNotImplemented

  public var info: Info? { nil }
}

// SwiftPM's generated accessor, for the strings the screens read.
extension Bundle {
  static let module: Bundle = {
    let host = Bundle(for: TraciveReportsBridge.self)
    return host.url(forResource: "TraciveSDKExtendedUI", withExtension: "bundle")
      .flatMap(Bundle.init(url:)) ?? host
  }()
}
