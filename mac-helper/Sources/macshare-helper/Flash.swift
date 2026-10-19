// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A short animation where the pointer crosses between the computers: a glow on the crossing edge and
// a ring at the pointer that spreads out (arriving here) or closes in (leaving). Drawn in a
// click-through overlay per screen; skipped when Reduce Motion is on.
import Cocoa

final class Flash {
  static let shared = Flash()
  private var overlays: [CGDirectDisplayID: NSPanel] = [:]
  private var hideWork: [CGDirectDisplayID: DispatchWorkItem] = [:]

  /// Create the overlays ahead of time, so the first crossing animates too.
  func prepare() {
    if NSApp.activationPolicy() == .prohibited { NSApp.setActivationPolicy(.accessory) }
    for screen in NSScreen.screens {
      guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { continue }
      let w = overlay(for: id, frame: screen.frame)
      w.alphaValue = 0
      w.orderFrontRegardless()
      w.orderOut(nil)
      w.alphaValue = 1
    }
  }

  func arrive(at p: CGPoint, side: String?) { show(at: p, side: side, arriving: true) }
  func leave(at p: CGPoint, side: String?) { show(at: p, side: side, arriving: false) }

  private func show(at cg: CGPoint, side: String?, arriving: Bool) {
    if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return }
    if NSApp.activationPolicy() == .prohibited { NSApp.setActivationPolicy(.accessory) } // may own windows
    let primaryH = NSScreen.screens.first?.frame.height ?? 0
    let pt = NSPoint(x: cg.x, y: primaryH - cg.y)
    guard let screen = NSScreen.screens.first(where: { NSMouseInRect(pt, $0.frame, false) }) ?? NSScreen.main,
          let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else { return }
    let panel = overlay(for: id, frame: screen.frame)
    guard let root = panel.contentView?.layer else { return }
    let p = CGPoint(x: pt.x - screen.frame.minX, y: pt.y - screen.frame.minY) // in the overlay
    let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB) ?? .systemBlue

    if let side = side { root.addSublayer(glow(side: side, at: p, size: screen.frame.size, color: accent)) }
    root.addSublayer(ring(at: p, color: accent, arriving: arriving))

    panel.orderFrontRegardless()
    hideWork[id]?.cancel()
    let work = DispatchWorkItem { [weak panel] in
      panel?.orderOut(nil)
      panel?.contentView?.layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
    }
    hideWork[id] = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9, execute: work)
  }

  private func overlay(for id: CGDirectDisplayID, frame: NSRect) -> NSPanel {
    if let w = overlays[id] {
      if w.frame != frame { w.setFrame(frame, display: false) }
      return w
    }
    let w = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = false
    w.ignoresMouseEvents = true
    w.level = .screenSaver
    w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    w.isReleasedWhenClosed = false
    w.sharingType = .none // never in a screen capture (Monitor 2)
    let v = NSView(frame: NSRect(origin: .zero, size: frame.size))
    v.wantsLayer = true
    w.contentView = v
    w.setFrame(frame, display: false)
    overlays[id] = w
    return w
  }

  /// A soft bar of light along the crossing edge, centred on the pointer.
  private func glow(side: String, at p: CGPoint, size: CGSize, color: NSColor) -> CALayer {
    let len: CGFloat = 360, thick: CGFloat = 22
    let g = CAGradientLayer()
    let c = color.cgColor, clear = color.withAlphaComponent(0).cgColor
    g.colors = [c, clear]
    switch side {
    case "left":
      g.frame = CGRect(x: 0, y: p.y - len / 2, width: thick, height: len)
      g.startPoint = CGPoint(x: 0, y: 0.5); g.endPoint = CGPoint(x: 1, y: 0.5)
    case "right":
      g.frame = CGRect(x: size.width - thick, y: p.y - len / 2, width: thick, height: len)
      g.startPoint = CGPoint(x: 1, y: 0.5); g.endPoint = CGPoint(x: 0, y: 0.5)
    case "top": // Cocoa y grows upward: the top edge is at size.height
      g.frame = CGRect(x: p.x - len / 2, y: size.height - thick, width: len, height: thick)
      g.startPoint = CGPoint(x: 0.5, y: 1); g.endPoint = CGPoint(x: 0.5, y: 0)
    default:
      g.frame = CGRect(x: p.x - len / 2, y: 0, width: len, height: thick)
      g.startPoint = CGPoint(x: 0.5, y: 0); g.endPoint = CGPoint(x: 0.5, y: 1)
    }
    // Fade the bar's ends too, so it reads as light rather than a block.
    let mask = CAGradientLayer()
    mask.frame = g.bounds
    let vertical = side == "left" || side == "right"
    mask.startPoint = vertical ? CGPoint(x: 0.5, y: 0) : CGPoint(x: 0, y: 0.5)
    mask.endPoint = vertical ? CGPoint(x: 0.5, y: 1) : CGPoint(x: 1, y: 0.5)
    mask.colors = [NSColor.clear.cgColor, NSColor.black.cgColor, NSColor.clear.cgColor]
    g.mask = mask
    g.opacity = 0
    let a = CAKeyframeAnimation(keyPath: "opacity")
    a.values = [0, 1, 0]
    a.keyTimes = [0, 0.2, 1]
    a.duration = 0.7
    a.timingFunction = CAMediaTimingFunction(name: .easeOut)
    g.add(a, forKey: "glow")
    return g
  }

  /// A ring at the pointer: spreads out and fades when arriving, closes in when leaving.
  private func ring(at p: CGPoint, color: NSColor, arriving: Bool) -> CALayer {
    let r: CGFloat = 30
    let s = CAShapeLayer()
    s.bounds = CGRect(x: 0, y: 0, width: r * 2, height: r * 2)
    s.position = p
    s.path = CGPath(ellipseIn: s.bounds.insetBy(dx: 1.5, dy: 1.5), transform: nil)
    s.fillColor = color.withAlphaComponent(0.18).cgColor
    s.strokeColor = color.cgColor
    s.lineWidth = 3
    s.opacity = 0
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = arriving ? 0.35 : 1.5
    scale.toValue = arriving ? 1.35 : 0.25
    let fade = CAKeyframeAnimation(keyPath: "opacity")
    fade.values = arriving ? [0.95, 0.7, 0] : [0, 0.85, 0]
    fade.keyTimes = arriving ? [0, 0.4, 1] : [0, 0.45, 1]
    let group = CAAnimationGroup()
    group.animations = [scale, fade]
    group.duration = arriving ? 0.55 : 0.4
    group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    s.add(group, forKey: "ring")
    return s
  }
}
