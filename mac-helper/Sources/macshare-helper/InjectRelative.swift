// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Relative KVM input while the PC drives this Mac (`inject`). Main has already
// mapped keys and applied speed / reverse scrolling.
import Cocoa

extension Injector {
  func injectRel(_ ev: [String: Any]) {
    guard let t = ev["t"] as? String else { return }
    let num = { (k: String) in (ev[k] as? NSNumber)?.doubleValue ?? 0 }
    let here = { CGEvent(source: nil)?.location ?? .zero }
    switch t {
    case "k.mm":
      let dx = num("dx"), dy = num("dy")
      let cur = here()
      let to = Screens.clamp(CGPoint(x: cur.x + dx, y: cur.y + dy), from: cur)
      var type = CGEventType.mouseMoved
      var b = 0
      if let held = heldButtons.min() {
        b = held
        type = held == 0 ? .leftMouseDragged : held == 1 ? .rightMouseDragged : .otherMouseDragged
      }
      let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: to,
                      mouseButton: b == 0 ? .left : b == 1 ? .right : .center)
      e?.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
      e?.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
      if type != .mouseMoved {
        e?.setIntegerValueField(.mouseEventButtonNumber, value: Int64(b))
        e?.setIntegerValueField(.mouseEventClickState, value: clickCount[b] ?? 1)
      }
      e?.flags = flags
      post(e)
      Capture.shared.checkReturn(to, dx: dx, dy: dy)
    case "k.md", "k.mu":
      if t == "k.mu", num("b") == 0, DragIn.shared.buttonUp() { return } // drop before the drag began
      button(Int(num("b")), down: t == "k.md", at: here())
    case "k.wh":
      scroll(dx: num("dx"), dy: num("dy"), lines: (ev["mode"] as? String) == "line")
    case "k.kd", "k.ku":
      if let code = ev["code"] as? String { key(code, down: t == "k.kd") }
    default:
      log("inject: unknown \(t)")
    }
  }
}
