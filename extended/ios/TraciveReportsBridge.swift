import Foundation
import UIKit

private let tokenEvent = "TraciveReports.accessToken"
private let progressEvent = "TraciveReports.progress"

// Past JavaScript's own limit, so this only ends a request JavaScript cannot answer.
private let tokenAnswerSeconds: TimeInterval = 35

// Not a product limit, the core has those. It only stops a huge file from running the heap out
// before the core sees it.
private let maxSourceBytes = 64 * 1024 * 1024

/// Holds the native core for JavaScript. The module's method queue is the main queue, so every
/// entry point runs on it and the dictionaries need no lock.
@objc(TraciveReportsBridge)
public final class TraciveReportsBridge: NSObject {

  public typealias Resolve = (Any?) -> Void
  public typealias Reject = (String, String, [String: Any]?) -> Void

  private final class Instance {
    let reports: TraciveReports
    var evidence: [Int: PreparedEvidence] = [:]
    var calls: [Int: Task<Void, Never>] = [:]

    init(reports: TraciveReports) {
      self.reports = reports
    }
  }

  private let emit: (String, [String: Any]) -> Void
  private var instances: [Int: Instance] = [:]
  private var tokenWaiters: [Int: CheckedContinuation<String, Error>] = [:]
  private var nextId = 1
  private var screenIsOpen = false

  @objc public init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
  }

  @objc public func invalidate() {
    instances.values.forEach { $0.calls.values.forEach { $0.cancel() } }
    instances.removeAll()
    // Nothing will ever answer these.
    let waiters = tokenWaiters.values
    tokenWaiters.removeAll()
    waiters.forEach { $0.resume(throwing: CancellationError()) }
  }

  @objc public func create(
    baseUrl: String, appUrlScheme: String, resolve: Resolve, reject: Reject
  ) {
    guard let url = URL(string: baseUrl) else {
      return Self.fail(reject, Self.badArguments)
    }
    let handle = takeId()
    let reports = TraciveReports(
      environment: TraciveEnvironment(baseUrl: url),
      target: ReportFormTarget(scheme: appUrlScheme),
      accessToken: { [weak self] stale in
        guard let self else { throw Self.noAnswer }
        return try await self.askJavaScript(handle: handle, stale: stale)
      })
    instances[handle] = Instance(reports: reports)
    resolve(handle)
  }

  @objc public func dispose(reports: Double) {
    instances.removeValue(forKey: Int(reports))?.calls.values.forEach { $0.cancel() }
  }

  @objc public func requirements(
    reports: Double, call: Double, resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let instance = instance(reports, reject) else { return }
    run(instance, call, resolve, reject) { try await instance.reports.requirements().wire }
  }

  @objc public func prepare(
    reports: Double, call: Double, source: [String: Any], resolve: @escaping Resolve,
    reject: @escaping Reject
  ) {
    guard let instance = instance(reports, reject) else { return }
    guard let mimeType = source["mimeType"] as? String else {
      return Self.fail(reject, Self.badArguments)
    }
    run(instance, call, resolve, reject) { [self] in
      let data = try await Self.read(source)
      let prepared = try await instance.reports.prepare(data, mimeType: mimeType)
      let handle = takeId()
      instance.evidence[handle] = prepared
      return [
        "evidence": handle, "mimeType": prepared.mimeType, "byteCount": prepared.byteCount,
      ] as [String: Any]
    }
  }

  @objc public func releaseEvidence(reports: Double, evidence: Double) {
    instances[Int(reports)]?.evidence[Int(evidence)] = nil
  }

  @objc public func submit(
    reports: Double, call: Double, draft: [String: Any], resolve: @escaping Resolve,
    reject: @escaping Reject
  ) {
    guard let instance = instance(reports, reject) else { return }
    let report: ReportDraft
    do {
      report = try ReportDraft(draft, evidence: instance.evidence)
    } catch {
      return Self.fail(reject, error)
    }
    let id = Int(call)
    let emit = emit
    run(instance, call, resolve, reject) {
      let outcome = try await instance.reports.submit(report) { fraction in
        DispatchQueue.main.async { emit(progressEvent, ["call": id, "fraction": fraction]) }
      }
      switch outcome {
      case .submitted(let reportId, let status):
        return ["outcome": "submitted", "reportId": reportId, "status": status.rawValue]
      case .needsConsent:
        return ["outcome": "needsConsent"]
      case .failed(let error):
        throw error
      }
    }
  }

  @objc public func status(
    reports: Double, call: Double, reportId: String, resolve: @escaping Resolve,
    reject: @escaping Reject
  ) {
    guard let instance = instance(reports, reject) else { return }
    run(instance, call, resolve, reject) { try await instance.reports.status(reportId).rawValue }
  }

  @objc public func cancel(reports: Double, call: Double) {
    instances[Int(reports)]?.calls[Int(call)]?.cancel()
  }

  @objc public func openInTracive(
    reports: Double, reportId: String, resolve: @escaping Resolve, reject: Reject
  ) {
    guard let instance = instance(reports, reject) else { return }
    instance.reports.openInTracive(reportId) { resolve($0) }
  }

  @objc public func presentForm(
    reports: Double, request: [String: Any], resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let instance = instance(reports, reject), claimScreen(reject) else { return }
    Task { @MainActor [self] in
      do {
        let files = request["attachments"] as? [[String: Any]] ?? []
        var attachments: [ReportAttachment] = []
        for file in files {
          let bytes = try await Self.read(file)
          attachments.append(ReportAttachment(bytes: bytes, mimeType: file["mimeType"] as? String ?? ""))
        }
        let prefill = ReportPrefill(
          identifiers: request["identifiers"] as? [String] ?? [],
          incidentDate: (request["incidentDate"] as? String)
            .flatMap(ReportIncidentDate.init(iso8601:)),
          title: request["title"] as? String,
          attachments: attachments)
        TraciveReportForm.present(
          reports: instance.reports, prefill: prefill, theme: Self.theme(request),
          from: try Self.presenter()
        ) { [weak self] outcome in
          self?.screenIsOpen = false
          resolve(outcome.wire)
        }
      } catch {
        screenIsOpen = false
        Self.fail(reject, error)
      }
    }
  }

  @objc public func presentStatus(
    reports: Double, request: [String: Any], resolve: @escaping Resolve, reject: @escaping Reject
  ) {
    guard let instance = instance(reports, reject), claimScreen(reject) else { return }
    Task { @MainActor [self] in
      do {
        TraciveReportStatus.present(
          reports: instance.reports, reportId: request["reportId"] as? String ?? "",
          theme: Self.theme(request), from: try Self.presenter()
        ) { [weak self] outcome in
          self?.screenIsOpen = false
          resolve(outcome == .needsConsent ? "needsConsent" : "closed")
        }
      } catch {
        screenIsOpen = false
        Self.fail(reject, error)
      }
    }
  }

  @objc public func answerToken(request: Double, token: String) {
    tokenWaiters.removeValue(forKey: Int(request))?.resume(returning: token)
  }

  @objc public func failToken(request: Double, failure: [String: Any]) {
    tokenWaiters.removeValue(forKey: Int(request))?.resume(
      throwing: TraciveReportError(
        code: TraciveReportError.Code(rawValue: failure["code"] as? String ?? "") ?? .server,
        message: failure["message"] as? String ?? "The token call failed.",
        httpStatus: (failure["httpStatus"] as? NSNumber)?.intValue,
        retryAfterSeconds: (failure["retryAfterSeconds"] as? NSNumber)?.intValue))
  }

  /// Native never refreshes: a rotating refresh token has one owner, the base SDK in JavaScript.
  private func askJavaScript(handle: Int, stale: String?) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.main.async { [self] in
        let request = takeId()
        tokenWaiters[request] = continuation
        emit(tokenEvent, ["request": request, "reports": handle, "stale": stale ?? NSNull()])
        DispatchQueue.main.asyncAfter(deadline: .now() + tokenAnswerSeconds) { [weak self] in
          self?.tokenWaiters.removeValue(forKey: request)?.resume(
            throwing: TraciveReportError(code: .network, message: "The token call did not answer."))
        }
      }
    }
  }

  private func takeId() -> Int {
    defer { nextId += 1 }
    return nextId
  }

  private func instance(_ reports: Double, _ reject: Reject) -> Instance? {
    if let instance = instances[Int(reports)] { return instance }
    reject("CANCELLED", "This TraciveReports was disposed.", nil)
    return nil
  }

  private func run(
    _ instance: Instance, _ call: Double, _ resolve: @escaping Resolve,
    _ reject: @escaping Reject, _ body: @escaping @MainActor () async throws -> Any?
  ) {
    let id = Int(call)
    instance.calls[id] = Task { @MainActor in
      defer { instance.calls[id] = nil }
      do {
        resolve(try await body())
      } catch {
        Self.fail(reject, error)
      }
    }
  }

  private func claimScreen(_ reject: Reject) -> Bool {
    if screenIsOpen {
      reject("SERVER", "A Tracive screen is already open.", nil)
      return false
    }
    screenIsOpen = true
    return true
  }

  @MainActor
  private static func presenter() throws -> UIViewController {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow)
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    guard let top else {
      throw TraciveReportError(code: .server, message: "There is no view to open it from.")
    }
    return top
  }

  private static func theme(_ request: [String: Any]) -> TraciveReportTheme {
    let radius = (request["cornerRadius"] as? NSNumber).map { CGFloat($0.doubleValue) }
    guard let color = request["primaryColor"] as? NSNumber else {
      return TraciveReportTheme(primaryColor: nil, cornerRadius: radius)
    }
    let argb = color.int64Value
    return TraciveReportTheme(
      primaryColor: UIColor(
        red: CGFloat((argb >> 16) & 0xFF) / 255,
        green: CGFloat((argb >> 8) & 0xFF) / 255,
        blue: CGFloat(argb & 0xFF) / 255,
        alpha: 1),
      cornerRadius: radius)
  }

  private static func read(_ source: [String: Any]) async throws -> Data {
    if let base64 = source["base64"] as? String {
      guard let data = Data(base64Encoded: base64) else {
        throw TraciveReportError(code: .imageUnreadable, message: "The file is not valid base64.")
      }
      return data
    }
    guard let uri = source["uri"] as? String else { throw badArguments }
    return try await Task.detached(priority: .userInitiated) { try readBounded(uri) }.value
  }

  private static func readBounded(_ uri: String) throws -> Data {
    let url = URL(string: uri).flatMap { $0.scheme == nil ? nil : $0 }
      ?? URL(fileURLWithPath: uri)
    do {
      let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= maxSourceBytes else {
        throw TraciveReportError(code: .imageUnreadable, message: "The file is too large to read.")
      }
      return try Data(contentsOf: url, options: .mappedIfSafe)
    } catch let error as TraciveReportError {
      throw error
    } catch {
      throw TraciveReportError(code: .imageUnreadable, message: "The file could not be read.")
    }
  }

  private static let badArguments = TraciveReportError(code: .server, message: "Bad arguments.")
  private static let noAnswer = TraciveReportError(code: .server, message: "The token call failed.")

  private static func fail(_ reject: Reject, _ error: Error) {
    if error is CancellationError {
      return reject("CANCELLED", "The call was cancelled.", nil)
    }
    guard let report = error as? TraciveReportError else {
      return reject("SERVER", "The call failed.", nil)
    }
    var details: [String: Any] = [:]
    if let httpStatus = report.httpStatus { details["httpStatus"] = httpStatus }
    if let retryAfter = report.retryAfterSeconds { details["retryAfterSeconds"] = retryAfter }
    reject(report.code.rawValue, report.message, details)
  }
}

extension ReportDraft {
  /// JavaScript's key rather than a new one: a retry must send what the first attempt sent. This
  /// pod is one module with the overlay, which is what lets an extension set a `let`.
  fileprivate init(_ wire: [String: Any], evidence held: [Int: PreparedEvidence]) throws {
    let handles = (wire["evidence"] as? [NSNumber] ?? []).map(\.intValue)
    let date = wire["incidentDate"] as? String ?? ""
    guard let incidentDate = ReportIncidentDate(iso8601: date) else {
      throw TraciveReportError(code: .invalidReport, message: "incidentDate is not YYYY-MM-DD.")
    }
    guard handles.allSatisfy({ held[$0] != nil }) else {
      throw TraciveReportError(code: .attachmentInvalid, message: "The evidence was released.")
    }
    identifiers = wire["identifiers"] as? [String] ?? []
    title = wire["title"] as? String ?? ""
    chronology = wire["chronology"] as? String ?? ""
    comment = wire["comment"] as? String
    self.incidentDate = incidentDate
    self.evidence = handles.compactMap { held[$0] }
    acceptedTerms = (wire["terms"] as? [[String: String]] ?? []).compactMap { term in
      guard let id = term["id"], let version = term["version"], let url = term["url"] else {
        return nil
      }
      return RequiredTerm(id: id, version: version, url: url)
    }
    language = wire["language"] as? String
    idempotencyKey = wire["key"] as? String ?? ""
  }
}

extension ReportRequirements {
  fileprivate var wire: [String: Any] {
    [
      "enabled": enabled,
      "remainingToday": remainingToday,
      "limits": [
        "titleMaxLength": limits.titleMaxLength,
        "chronologyMinLength": limits.chronologyMinLength,
        "chronologyMaxLength": limits.chronologyMaxLength,
        "commentMaxLength": limits.commentMaxLength,
        "maxIdentifiers": limits.maxIdentifiers,
        "attachmentsPerIdentifier": limits.attachmentsPerIdentifier,
        "extraAttachmentsWithPhone": limits.extraAttachmentsWithPhone,
        "maxAttachmentBytes": limits.maxAttachmentBytes,
        "attachmentTypes": limits.attachmentTypes,
      ] as [String: Any],
      "terms": terms.map { ["id": $0.id, "version": $0.version, "url": $0.url] },
    ]
  }
}

extension ReportFormOutcome {
  fileprivate var wire: [String: Any] {
    switch self {
    case .submitted(let reportId, let status):
      return ["type": "submitted", "reportId": reportId, "status": status.rawValue]
    case .needsConsent:
      return ["type": "needsConsent"]
    case .cancelled:
      return ["type": "cancelled"]
    }
  }
}
