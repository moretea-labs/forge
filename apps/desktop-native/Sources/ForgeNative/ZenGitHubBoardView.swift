import SwiftUI

// Direct, ephemeral presentation of the configured GitHub Project status field.
// No local status writes and no inference from Requirement / Autopilot.
struct ZenGitHubBoardView: View {
    let items: [ZenGitHubBoardItem]
    let truncated: Bool

    private var statuses: [String] {
        Array(Set(items.map(\.status))).sorted { left,right in
            let priority=["Todo","To do","Backlog","In Progress","In progress","Done"]
            let a=priority.firstIndex(of:left) ?? priority.count
            let b=priority.firstIndex(of:right) ?? priority.count
            return a == b ? left.localizedStandardCompare(right) == .orderedAscending : a < b
        }
    }

    var body: some View {
        GeometryReader { frame in
            ScrollView(.horizontal) {
                HStack(alignment:.top,spacing:14) {
                    ForEach(statuses,id:\.self) { status in
                        let group=items.filter { $0.status == status }
                        VStack(alignment:.leading,spacing:12) {
                            HStack {
                                Text(status).font(.system(size:12,weight:.semibold))
                                Text("\(group.count)")
                                    .font(.system(size:10)).foregroundStyle(.secondary)
                                Spacer()
                            }
                            ScrollView {
                                LazyVStack(spacing:8) {
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
                        .padding(13)
                        .frame(width:max(225,(frame.size.width-76)/3),alignment:.topLeading)
                        .frame(maxHeight:.infinity)
                        .background(Color.primary.opacity(0.025),
                                    in:RoundedRectangle(cornerRadius:12))
                    }
                }
                .padding(.horizontal,24).padding(.bottom,24)
            }
            .scrollIndicators(.hidden)
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
        VStack(alignment:.leading,spacing:8) {
            Text(item.title).font(.system(size:12,weight:.medium))
                .lineLimit(3).frame(maxWidth:.infinity,alignment:.leading)
                .foregroundStyle(.primary)
            HStack {
                Text(item.number.map { "#\($0)" } ?? "Draft")
                    .font(.system(size:10,design:.monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                if item.url != nil {
                    Image(systemName:"arrow.up.right")
                        .font(.system(size:9)).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .background(Color(nsColor:.controlBackgroundColor).opacity(0.7),
                    in:RoundedRectangle(cornerRadius:10))
    }
}
