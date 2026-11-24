import SwiftUI
import AppKit

// Presentation only: GitHub Project and Requirement/Autopilot remain the status authorities.
enum ForgeBoardTone {
    case todo, progress, blocked, done, neutral

    static func forGitHubStatus(_ status:String) -> Self {
        let key=status.lowercased()
            .replacingOccurrences(of:" ",with:"")
            .replacingOccurrences(of:"_",with:"")
            .replacingOccurrences(of:"-",with:"")
        switch key {
        case "todo","backlog","notstarted": return .todo
        case "inprogress","active","doing": return .progress
        case "blocked","waiting","waitingforuser": return .blocked
        case "done","completed","closed": return .done
        default: return .neutral
        }
    }
}

enum ForgeBoardAppearance {
    static let cardSurface = ForgePalette.raisedSurface
    static let columnSpacing: CGFloat = 12
    static let boardInset: CGFloat = 20
    static let columnInset: CGFloat = 12
    static let cardInset: CGFloat = 12
    static let columnSurface = ForgePalette.softFill

    static func marker(_ tone:ForgeBoardTone) -> Color {
        switch tone {
        case .todo: return Color(red:0.59,green:0.57,blue:0.65)
        case .progress: return Color(red:0.17,green:0.47,blue:0.88)
        case .blocked: return Color(red:0.85,green:0.25,blue:0.27)
        case .done: return Color(red:0.39,green:0.50,blue:0.39)
        case .neutral: return .secondary
        }
    }

    static func columnWidth(available:CGFloat,columnCount:Int) -> CGFloat {
        let shown=max(1,min(columnCount,4))
        let spacing=CGFloat(shown-1)*columnSpacing
        return max(216,min(340,(available-2*boardInset-spacing)/CGFloat(shown)))
    }
}

// A read-only projection of the configured GitHub Project, not a second task store.
struct ZenGitHubBoardView: View {
    let items: [ZenGitHubBoardItem]
    let truncated: Bool

    private var statuses: [String] {
        Array(Set(items.map(\.status))).sorted { left,right in
            let priority=["Todo","To do","Backlog","In Progress","In progress","Blocked","Done"]
            let a=priority.firstIndex(of:left) ?? priority.count
            let b=priority.firstIndex(of:right) ?? priority.count
            return a == b ? left.localizedStandardCompare(right) == .orderedAscending : a < b
        }
    }

    var body: some View {
        GeometryReader { frame in
            ScrollView(.horizontal) {
                HStack(alignment:.top,spacing:ForgeBoardAppearance.columnSpacing) {
                    ForEach(statuses,id:\.self) { status in
                        let group=items.filter { $0.status == status }
                        let tone=ForgeBoardTone.forGitHubStatus(status)
                        VStack(alignment:.leading,spacing:13) {
                            HStack(spacing:9) {
                                Circle().fill(ForgeBoardAppearance.marker(tone))
                                    .frame(width:7,height:7)
                                Text(status).font(.system(size:12.5,weight:.semibold))
                                Spacer(minLength:5)
                                Text("\(group.count)")
                                    .font(.system(size:10.5,weight:.medium))
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                            ScrollView {
                                LazyVStack(spacing:9) {
                                    ForEach(group) { item in
                                        if let urlText=item.url,let url=URL(string:urlText),
                                           url.scheme == "https",url.host == "github.com" {
                                            Link(destination:url) { itemRow(item) }
                                                .buttonStyle(.plain)
                                        } else {
                                            itemRow(item)
                                        }
                                    }
                                }
                            }
                            .scrollIndicators(.hidden)
                        }
                        .padding(ForgeBoardAppearance.columnInset)
                        .frame(width:ForgeBoardAppearance.columnWidth(available:frame.size.width,
                                                                      columnCount:statuses.count),
                               alignment:.topLeading)
                        .frame(maxHeight:.infinity)
                        .background(ForgeBoardAppearance.columnSurface,
                                    in:RoundedRectangle(cornerRadius:13,style:.continuous))
                    }
                }
                .padding(.horizontal,ForgeBoardAppearance.boardInset).padding(.bottom,ForgeBoardAppearance.boardInset)
            }
            .scrollIndicators(.hidden)
        }
        .safeAreaInset(edge:.top,spacing:0) {
            if truncated {
                Label("结果已截断，当前只显示部分条目。",systemImage:"info.circle")
                    .font(.system(size:10.5)).foregroundStyle(.secondary)
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .padding(.horizontal,24).padding(.vertical,7)
                    .accessibilityIdentifier("zen.github.board.truncated")
            }
        }
        .overlay {
            if items.isEmpty {
                VStack(spacing:9) {
                    Image(systemName:"rectangle.split.3x1")
                        .font(.system(size:24,weight:.light))
                        .foregroundStyle(.tertiary)
                    Text("项目暂无工作项").font(.system(size:14,weight:.semibold))
                    Text("GitHub Project 中没有返回属于当前仓库的条目。")
                        .font(.system(size:11)).foregroundStyle(.secondary)
                }
                .frame(maxWidth:.infinity,maxHeight:.infinity)
            }
        }
        .accessibilityIdentifier("zen.github.board")
    }

    private func itemRow(_ item:ZenGitHubBoardItem) -> some View {
        VStack(alignment:.leading,spacing:9) {
            Text(item.title)
                .font(.system(size:12.5,weight:.medium))
                .lineLimit(3)
                .frame(maxWidth:.infinity,alignment:.leading)
                .foregroundStyle(.primary)
            HStack {
                Text(item.number.map { "#\($0)" } ?? "Draft")
                    .font(.system(size:10,design:.monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength:4)
                if item.url != nil {
                    Image(systemName:"arrow.up.right")
                        .font(.system(size:10)).foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(ForgeBoardAppearance.cardInset)
        .frame(maxWidth:.infinity,alignment:.leading)
        .background(ForgeBoardAppearance.cardSurface,
                    in:RoundedRectangle(cornerRadius:10,style:.continuous))
    }
}
