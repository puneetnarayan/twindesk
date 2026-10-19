// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files dragged in from the PC become a real drag on this Mac ("Drag files across
// the screen edge"). `dragStart` puts a nearly invisible panel under the pointer and
// injects a (marked) left-button-down into it; its mouseDown starts an NSDraggingSession with one
// NSFilePromiseProvider per dragged item. From then on the session follows the PC's injected
// pointer (k.mm arrive as leftMouseDragged), the PC's k.mu {b:0} drops. Main writes the promised
// files: event `dragWrite {drag, index, path}` → cmd `dragWritten {drag, index, error?}`.
// `dragCancel` ends the session over a panel that refuses everything (Esc would go to the
// frontmost app instead). Events: dragStarted {drag}, dragEnded {drag, result: 'dropped'|'none'|'failed'}.
import Cocoa
import UniformTypeIdentifiers

final class DragView: NSView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { DragIn.shared.mouseDown(event, in: self) }
  // As a drop target (only while cancelling): refuse, so the session ends with no operation.
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { [] }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { [] }
  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { false }
}

/// Takes our own file drag at the crossing edge: accepting it ends Finder's drag quietly (no
/// slide-back, no Esc to the frontmost app) while the files carry on to the other computer.
final class CatchView: NSView {
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool { true }
}

final class DragIn: NSObject, NSDraggingSource, NSFilePromiseProviderDelegate {
  static let shared = DragIn()
  private enum Phase { case idle, arming, dragging, cancelling }
  private var phase = Phase.idle
  private var drag = ""
  private var items: [(name: String, dir: Bool)] = []
  private var panel: NSPanel?
  private var catcher: NSPanel?
  private var upPending = false          // the PC let go before the session started
  private var writes: [String: (Error?) -> Void] = [:]   // "drag#index" -> completion (main queue)
  private let queue: OperationQueue = {
    let q = OperationQueue()
    q.qualityOfService = .userInitiated
    return q
  }()

  var active: Bool { phase != .idle }

  func start(drag: String, items: [[String: Any]]) {
    if phase != .idle { cancel() }
    if NSApp.activationPolicy() == .prohibited { NSApp.setActivationPolicy(.accessory) } // may own windows
    self.drag = drag
    self.items = items.map { (($0["name"] as? String) ?? "file", ($0["dir"] as? Bool) ?? false) }
    upPending = false
    phase = .arming
    showPanel(size: 240)
    // The click into the panel; once more if the window server wasn't ready for it.
    for delay in [0.06, 0.6] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
        guard phase == .arming, self.drag == drag else { return }
        let p = here()
        releaseButton()
        panel?.setFrameOrigin(cocoa(p, size: 240))
        injector.button(0, down: true, at: p)
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [self] in
      guard phase == .arming, self.drag == drag else { return }
      log("drag: the panel never got the mouse-down")
      releaseButton()
      finish("failed")
    }
  }

  func mouseDown(_ event: NSEvent, in view: NSView) {
    guard phase == .arming else { return }
    let at = view.convert(event.locationInWindow, from: nil)
    let dragging: [NSDraggingItem] = items.enumerated().map { i, it in
      let type: UTType = it.dir ? .folder : (UTType(filenameExtension: (it.name as NSString).pathExtension) ?? .data)
      let provider = NSFilePromiseProvider(fileType: type.identifier, delegate: self)
      provider.userInfo = ["drag": drag, "index": i]
      let d = NSDraggingItem(pasteboardWriter: provider)
      let img = DragIn.image(name: it.name, type: type)
      let o = CGFloat(min(i, 4)) * 3
      d.setDraggingFrame(NSRect(x: at.x - img.size.width / 2 + o, y: at.y - 32 - o, width: img.size.width, height: img.size.height), contents: img)
      return d
    }
    let session = view.beginDraggingSession(with: dragging, event: event, source: self)
    session.animatesToStartingPositionsOnCancelOrFail = false
    session.draggingFormation = .stack
    phase = .dragging
    emit(["event": "dragStarted", "drag": drag])
    DispatchQueue.main.async { [self] in
      if phase == .dragging { hidePanel() }
      if upPending {
        upPending = false
        injector.button(0, down: false, at: here())
      }
    }
  }

  /// k.mu {b:0} from the PC: true when handled here (the session hasn't started yet).
  func buttonUp() -> Bool {
    guard phase == .arming else { return false }
    upPending = true
    return true
  }

  /// End the drag without a drop (owner went home, Esc, drag.cancel, releaseAll).
  func cancel() {
    switch phase {
    case .idle, .cancelling:
      return
    case .arming:
      releaseButton()
      finish("none")
    case .dragging:
      phase = .cancelling
      injector.heldButtons.remove(0) // released here, not by a later releaseAll
      showPanel(size: 160)
      let d = drag
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [self] in
        guard phase == .cancelling, drag == d else { return }
        let p = here()
        injector.mouse(.leftMouseDragged, at: p, button: 0, clickState: 1)
        injector.mouse(.leftMouseUp, at: p, button: 0, clickState: 1)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [self] in
        if phase == .cancelling, drag == d { finish("none") }
      }
    }
  }

  /// Main wrote (or failed to write) the promised item.
  func written(drag: String, index: Int, error: String?) {
    guard let done = writes.removeValue(forKey: "\(drag)#\(index)") else { return }
    done(error.map { NSError(domain: "TwinDesk", code: 1, userInfo: [NSLocalizedDescriptionKey: $0]) })
  }

  private func finish(_ result: String) {
    let d = drag
    phase = .idle
    upPending = false
    hidePanel()
    emit(["event": "dragEnded", "drag": d, "result": result])
  }

  private func releaseButton() {
    if injector.heldButtons.contains(0) { injector.button(0, down: false, at: here()) }
  }

  /// End this Mac's own file drag at `p` (it crossed the edge): drop it on a panel that accepts it.
  func swallowLocalDrag(at p: CGPoint) {
    if NSApp.activationPolicy() == .prohibited { NSApp.setActivationPolicy(.accessory) }
    let c = catcher ?? {
      let w = DragIn.makePanel(CatchView())
      catcher = w
      return w
    }()
    c.setFrame(NSRect(origin: cocoa(p, size: 120), size: NSSize(width: 120, height: 120)), display: false)
    c.orderFrontRegardless()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      injector.mouse(.leftMouseDragged, at: p, button: 0, clickState: 1)
      injector.mouse(.leftMouseDragged, at: p, button: 0, clickState: 1)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
        injector.mouse(.leftMouseUp, at: p, button: 0, clickState: 1)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { c.orderOut(nil) }
      }
    }
  }

  private static func makePanel(_ v: NSView) -> NSPanel {
    let w = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    w.isOpaque = false
    w.backgroundColor = NSColor(white: 1, alpha: 0.01) // fully clear windows let clicks through
    w.hasShadow = false
    w.level = .popUpMenu
    w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    w.isReleasedWhenClosed = false
    w.ignoresMouseEvents = false
    v.registerForDraggedTypes(NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) } + [.fileURL])
    w.contentView = v
    return w
  }

  // ---- the panel under the pointer ----

  private func here() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

  /// Cocoa origin of a size×size panel centred on a CG (top-left) point.
  private func cocoa(_ p: CGPoint, size: CGFloat) -> NSPoint {
    let h = NSScreen.screens.first?.frame.height ?? 0
    return NSPoint(x: p.x - size / 2, y: h - p.y - size / 2)
  }

  private func showPanel(size: CGFloat) {
    let p = panel ?? {
      let w = DragIn.makePanel(DragView())
      panel = w
      return w
    }()
    p.ignoresMouseEvents = false
    p.setFrame(NSRect(origin: cocoa(here(), size: size), size: NSSize(width: size, height: size)), display: false)
    p.orderFrontRegardless()
  }

  private func hidePanel() {
    panel?.orderOut(nil)
  }

  // ---- NSDraggingSource ----

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    context == .outsideApplication ? .copy : []
  }

  func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
    guard phase == .dragging || phase == .cancelling else { return }
    finish(operation.isEmpty ? "none" : "dropped")
  }

  // ---- NSFilePromiseProviderDelegate ----

  private func info(_ p: NSFilePromiseProvider) -> (String, Int)? {
    guard let u = p.userInfo as? [String: Any], let d = u["drag"] as? String, let i = u["index"] as? Int else { return nil }
    return (d, i)
  }

  func filePromiseProvider(_ p: NSFilePromiseProvider, fileNameForType fileType: String) -> String {
    guard let (_, i) = info(p), i < items.count else { return "file" }
    return items[i].name
  }

  func filePromiseProvider(_ p: NSFilePromiseProvider, writePromiseTo url: URL, completionHandler: @escaping (Error?) -> Void) {
    guard let (d, i) = info(p) else { return completionHandler(NSError(domain: "TwinDesk", code: 2)) }
    DispatchQueue.main.async { [self] in
      writes["\(d)#\(i)"] = completionHandler
      emit(["event": "dragWrite", "drag": d, "index": i, "path": url.path])
    }
  }

  func operationQueue(for p: NSFilePromiseProvider) -> OperationQueue { queue }

  // ---- drag image: the Finder look (icon over a name label) ----

  static func image(name: String, type: UTType) -> NSImage {
    let icon = NSWorkspace.shared.icon(for: type)
    let para = NSMutableParagraphStyle()
    para.lineBreakMode = .byTruncatingMiddle
    para.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.white, .paragraphStyle: para,
    ]
    let ts = (name as NSString).size(withAttributes: attrs)
    let lw = min(ts.width + 12, 200), lh = ts.height + 4
    let w = max(64, lw), h = 64 + 4 + lh
    return NSImage(size: NSSize(width: w, height: h), flipped: false) { _ in
      icon.draw(in: NSRect(x: (w - 64) / 2, y: h - 64, width: 64, height: 64))
      let r = NSRect(x: (w - lw) / 2, y: 0, width: lw, height: lh)
      NSColor.controlAccentColor.setFill()
      NSBezierPath(roundedRect: r, xRadius: lh / 2, yRadius: lh / 2).fill()
      (name as NSString).draw(in: r.insetBy(dx: 6, dy: 2), withAttributes: attrs)
      return true
    }
  }
}
