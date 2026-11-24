import SwiftUI

/// Forge's primary navigation and frequently used commands share one 24pt
/// outline grid. System symbols remain available for incidental metadata.
enum ForgeGlyphKind: String, CaseIterable {
  case chat, folder, board, tasks, library, analytics, settings
  case back, refresh, compose, search, inbox, inspector, capabilities
  case close, expand, restore, attachment, microphone, stop, send, copy
}

struct ForgeGlyphShape: Shape {
  let kind: ForgeGlyphKind

  func path(in rect: CGRect) -> Path {
    var p = Path()
    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
    func line(_ points: [CGPoint], closed: Bool = false) {
      guard let first = points.first else { return }
      p.move(to: first)
      for point in points.dropFirst() { p.addLine(to: point) }
      if closed { p.closeSubpath() }
    }
    func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat = 2) {
      p.addRoundedRect(in: CGRect(x: x, y: y, width: w, height: h),
                       cornerSize: CGSize(width: r, height: r))
    }
    func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) {
      p.addEllipse(in: CGRect(x: x-r, y: y-r, width: 2*r, height: 2*r))
    }
    switch kind {
    case .chat:
      p.move(to: point(5, 3.5))
      p.addLine(to: point(19, 3.5))
      p.addQuadCurve(to: point(21, 5.5), control: point(21, 3.5))
      p.addLine(to: point(21, 15))
      p.addQuadCurve(to: point(19, 17), control: point(21, 17))
      line([point(19, 17), point(10, 17), point(5, 21), point(5, 17)])
      p.addQuadCurve(to: point(3, 15), control: point(3, 17))
      p.addLine(to: point(3, 5.5))
      p.addQuadCurve(to: point(5, 3.5), control: point(3, 3.5))
      line([point(7, 8), point(17, 8)])
      line([point(7, 12), point(14, 12)])
    case .folder:
      p.move(to: point(3, 19))
      p.addLine(to: point(3, 6))
      p.addQuadCurve(to: point(5, 4), control: point(3, 4))
      line([point(5, 4), point(10, 4), point(13, 7), point(19, 7)])
      p.addQuadCurve(to: point(21, 9), control: point(21, 7))
      p.addLine(to: point(21, 18))
      p.addQuadCurve(to: point(19, 20), control: point(21, 20))
      p.addLine(to: point(5, 20))
      p.addQuadCurve(to: point(3, 19), control: point(3, 20))
    case .board:
      box(3, 4, 18, 16)
      line([point(9, 4), point(9, 20)])
      line([point(15, 4), point(15, 20)])
      line([point(5.5, 8), point(6.5, 8)])
      line([point(11.5, 8), point(12.5, 8)])
      line([point(17.5, 8), point(18.5, 8)])
    case .tasks:
      box(4, 3, 16, 18)
      line([point(7, 9), point(8.5, 10.5), point(11, 7.5)])
      line([point(13, 9), point(17, 9)])
      line([point(7, 15), point(8.5, 16.5), point(11, 13.5)])
      line([point(13, 15), point(17, 15)])
    case .library:
      box(7, 3, 13, 16)
      p.move(to: point(4, 7))
      p.addLine(to: point(4, 19))
      p.addQuadCurve(to: point(6, 21), control: point(4, 21))
      p.addLine(to: point(17, 21))
      line([point(10, 8), point(17, 8)])
      line([point(10, 12), point(15, 12)])
    case .analytics:
      line([point(3, 3), point(3, 21), point(21, 21)])
      box(6, 12, 3, 6, 0.6)
      box(12, 8, 3, 10, 0.6)
      box(18, 4, 3, 14, 0.6)
    case .settings:
      for (y, x) in [(CGFloat(5), CGFloat(9)), (12, 15), (19, 10)] {
        line([point(3, y), point(x-2.5, y)])
        circle(x, y, 2.5)
        line([point(x+2.5, y), point(21, y)])
      }
    case .back:
      line([point(15, 5), point(8, 12), point(15, 19)])
    case .refresh:
      p.addArc(center: point(12, 12), radius: 8, startAngle: .degrees(-35),
               endAngle: .degrees(280), clockwise: false)
      line([point(18, 4), point(18, 9), point(13, 9)])
    case .compose:
      p.move(to: point(11, 4))
      p.addLine(to: point(5, 4))
      p.addQuadCurve(to: point(3, 6), control: point(3, 4))
      p.addLine(to: point(3, 19))
      p.addQuadCurve(to: point(5, 21), control: point(3, 21))
      p.addLine(to: point(18, 21))
      p.addQuadCurve(to: point(20, 19), control: point(20, 21))
      p.addLine(to: point(20, 13))
      line([point(9, 15), point(10, 11), point(18, 3), point(21, 6),
            point(13, 14), point(9, 15)])
    case .search:
      circle(10, 10, 6)
      line([point(14.5, 14.5), point(21, 21)])
    case .inbox:
      line([point(3, 13), point(6, 5), point(18, 5), point(21, 13),
            point(21, 19), point(3, 19)], closed: true)
      line([point(3, 13), point(8, 13), point(10, 16), point(14, 16),
            point(16, 13), point(21, 13)])
    case .inspector:
      box(3, 4, 18, 16)
      line([point(14, 4), point(14, 20)])
      line([point(16.5, 8), point(18.5, 8)])
      line([point(16.5, 12), point(18.5, 12)])
    case .capabilities:
      box(3, 3, 7, 7, 1.5)
      box(14, 3, 7, 7, 1.5)
      box(3, 14, 7, 7, 1.5)
      line([point(17.5, 13.5), point(17.5, 21.5)])
      line([point(13.5, 17.5), point(21.5, 17.5)])
    case .close:
      line([point(6, 6), point(18, 18)])
      line([point(18, 6), point(6, 18)])
    case .expand:
      line([point(14, 4), point(20, 4), point(20, 10)])
      line([point(20, 4), point(13, 11)])
      line([point(10, 20), point(4, 20), point(4, 14)])
      line([point(4, 20), point(11, 13)])
    case .restore:
      line([point(20, 4), point(13, 11), point(13, 5)])
      line([point(13, 11), point(19, 11)])
      line([point(4, 20), point(11, 13), point(11, 19)])
      line([point(11, 13), point(5, 13)])
    case .attachment:
      p.move(to: point(9, 14))
      p.addLine(to: point(15, 8))
      p.addQuadCurve(to: point(18, 11), control: point(18, 6))
      p.addLine(to: point(10, 19))
      p.addQuadCurve(to: point(4, 13), control: point(3, 20))
      p.addLine(to: point(13, 4))
      p.addQuadCurve(to: point(21, 12), control: point(23, 2))
      p.addLine(to: point(13, 20))
    case .microphone:
      box(9, 3, 6, 12, 3)
      p.move(to: point(5, 11))
      p.addQuadCurve(to: point(12, 18), control: point(5, 18))
      p.addQuadCurve(to: point(19, 11), control: point(19, 18))
      line([point(12, 18), point(12, 21)])
      line([point(9, 21), point(15, 21)])
    case .stop:
      box(6, 6, 12, 12, 2)
    case .send:
      line([point(12, 20), point(12, 4)])
      line([point(5, 11), point(12, 4), point(19, 11)])
    case .copy:
      box(8, 8, 13, 13)
      p.move(to: point(16, 5))
      p.addQuadCurve(to: point(14, 3), control: point(16, 3))
      p.addLine(to: point(5, 3))
      p.addQuadCurve(to: point(3, 5), control: point(3, 3))
      p.addLine(to: point(3, 14))
      p.addQuadCurve(to: point(5, 16), control: point(3, 16))
    }
    let scale = min(rect.width, rect.height) / 24
    let transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
      tx: rect.midX - 12*scale, ty: rect.midY - 12*scale)
    return p.applying(transform)
  }
}

struct ForgeGlyph: View {
  enum Role { case chrome, rail, inline }
  let kind: ForgeGlyphKind
  var role: Role = .chrome
  var active: Bool = false

  init(_ kind: ForgeGlyphKind, role: Role = .chrome, active: Bool = false) {
    self.kind = kind
    self.role = role
    self.active = active
  }

  private var size: CGFloat {
    switch role {
    case .chrome: return 16
    case .rail: return 15
    case .inline: return 15
    }
  }

  var body: some View {
    ForgeGlyphShape(kind: kind)
      .stroke(style: StrokeStyle(lineWidth: size * 1.65 / 24, lineCap: .round, lineJoin: .round))
      .foregroundStyle(active ? ForgePalette.ink : ForgePalette.secondary)
      .frame(width: size, height: size)
      .frame(width: role == .chrome ? ForgeClientDesign.Icon.hit : size,
             height: role == .chrome ? ForgeClientDesign.Icon.hit : size)
      .contentShape(Rectangle())
      .accessibilityHidden(true)
  }
}
