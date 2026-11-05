import UIKit

/// Presents one report package in the "Open in" sheet and reports which app received it.
///
/// Called on the main thread only. The resolution follows the order iOS delivers the callbacks in:
/// `willBeginSendingToApplication`, then `didDismissOpenInMenu`, then
/// `didEndSendingToApplication`. The first decides; a dismiss with no send before it is a cancel.
@objc(TraciveReportFormPresenter)
public final class TraciveReportFormPresenter: NSObject, UIDocumentInteractionControllerDelegate {
  /// Kept until the transfer ends: UIKit holds the delegate weakly and drops the hand-off when the
  /// controller is released.
  private var controller: UIDocumentInteractionController?
  private var completion: ((String) -> Void)?
  private var sending = false
  private var sheetWatch: VanishedSheetWatch?

  /// `completion` receives the receiving app's bundle id, or `""` when nothing was sent. `failure`
  /// receives a fixed code; neither ever carries the package.
  @objc public func present(
    packageJson: String,
    fileName: String,
    anchor: UIView?,
    fallback: UIViewController?,
    completion: @escaping (String) -> Void,
    failure: @escaping (String) -> Void
  ) {
    guard controller == nil else {
      failure("E_BUSY")
      return
    }
    let url: URL
    do {
      url = try Self.write(packageJson, named: fileName)
    } catch {
      failure("E_WRITE")
      return
    }

    let sourceView: UIView
    let sourceRect: CGRect
    if let anchor, anchor.window != nil {
      sourceView = anchor
      sourceRect = anchor.bounds
    } else if let view = fallback?.view {
      sourceView = view
      sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY, width: 1, height: 1)
    } else {
      failure("E_NO_VIEW")
      return
    }

    let controller = UIDocumentInteractionController(url: url)
    controller.delegate = self
    self.controller = controller
    self.completion = completion
    self.sending = false
    sheetWatch = VanishedSheetWatch(window: sourceView.window) { [weak self] in
      guard let self, !self.sending else { return }
      self.resolve("")
      self.controller = nil
    }
    if !controller.presentOpenInMenu(from: sourceRect, in: sourceView, animated: true) {
      self.controller = nil
      self.completion = nil
      stopSheetWatch()
      failure("E_PRESENT")
    }
  }

  public func documentInteractionController(
    _ controller: UIDocumentInteractionController,
    willBeginSendingToApplication application: String?
  ) {
    sending = true
    resolve(application ?? "")
  }

  public func documentInteractionControllerDidDismissOpenInMenu(
    _ controller: UIDocumentInteractionController
  ) {
    if sending { return }
    resolve("")
    self.controller = nil
  }

  public func documentInteractionController(
    _ controller: UIDocumentInteractionController,
    didEndSendingToApplication application: String?
  ) {
    self.controller = nil
    sending = false
  }

  private func resolve(_ bundleId: String) {
    stopSheetWatch()
    let completion = self.completion
    self.completion = nil
    completion?(bundleId)
  }

  private func stopSheetWatch() {
    sheetWatch?.stop()
    sheetWatch = nil
  }

  /// A fresh folder per call under `tmp/tracive-sdk/report/`, after removing what earlier calls left.
  private static func write(_ packageJson: String, named fileName: String) throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("tracive-sdk", isDirectory: true)
      .appendingPathComponent("report", isDirectory: true)
    try? FileManager.default.removeItem(at: root)
    let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(fileName, isDirectory: false)
    try Data(packageJson.utf8).write(to: url, options: .atomic)
    return url
  }
}

/// Notices the "Open in" sheet has gone without a word to its delegate. iPadOS takes it down when
/// the device rotates and calls no delegate method at all, so the call would never return and every
/// later one would be refused with `E_BUSY`.
///
/// The sheet is presented after `presentOpenInMenu` returns, so each check looks for it first. Once
/// seen, it must be gone on two checks in a row, so that a delegate answer already on its way still
/// decides the outcome.
private final class VanishedSheetWatch: NSObject {
  private weak var window: UIWindow?
  private weak var topBefore: UIViewController?
  private weak var sheet: UIViewController?
  private var seen = false
  private var goneChecks = 0
  private var timer: Timer?
  private let onVanished: () -> Void

  /// Create it just before presenting, while `window`'s top view controller is the one the sheet
  /// will cover.
  init(window: UIWindow?, onVanished: @escaping () -> Void) {
    self.window = window
    self.topBefore = Self.topViewController(of: window)
    self.onVanished = onVanished
    super.init()
    timer = Timer.scheduledTimer(
      timeInterval: 0.5, target: self, selector: #selector(check), userInfo: nil, repeats: true)
  }

  /// The timer holds this object until stopped.
  func stop() {
    timer?.invalidate()
    timer = nil
  }

  @objc private func check() {
    guard seen else {
      if let top = Self.topViewController(of: window), top !== topBefore {
        sheet = top
        seen = true
      }
      return
    }
    goneChecks = sheet?.presentingViewController == nil ? goneChecks + 1 : 0
    guard goneChecks >= 2 else { return }
    stop()
    onVanished()
  }

  private static func topViewController(of window: UIWindow?) -> UIViewController? {
    var top = window?.rootViewController
    while let presented = top?.presentedViewController, !presented.isBeingDismissed {
      top = presented
    }
    return top
  }
}
