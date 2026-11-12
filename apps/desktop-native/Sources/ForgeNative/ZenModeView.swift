import SwiftUI

// A presentation of existing Repository, Requirement, Plan and Autopilot facts.
// Zen never owns a second plan, project registry, or execution state.
enum ZenScreen {
    case projects, board, canvas
}

enum ZenBoardBucket: Int, CaseIterable {
    case todo, running, done

    var title: String {
        switch self {
        case .todo: return "To do"
        case .running: return "In progress"
        case .done: return "Done"
        }
    }

    static func classify(requirementState: String, runtimeActive: Bool) -> Self {
        if requirementState == "completed" { return .done }
        if runtimeActive { return .running }
        return .todo
    }
}

struct ZenRail: View {
    @Binding var screen: ZenScreen
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing:10) {
            Image(systemName:"square.stack.3d.up.fill")
                .font(.system(size:18,weight:.medium))
                .frame(width:42,height:42)
                .accessibilityLabel("Forge")
                .padding(.bottom,14)
            navigation(.projects,symbol:"square.grid.2x2",label:"全部项目")
            navigation(.board,symbol:"rectangle.split.3x1",label:"工作看板")
            navigation(.canvas,symbol:"point.3.connected.trianglepath.dotted",label:"需求画布")
            Spacer(minLength:12)
            Button(action:onOpenSettings) {
                Image(systemName:"gearshape").frame(width:42,height:40)
            }
            .buttonStyle(.plain)
            .help("设置")
            .accessibilityLabel("设置")
        }
        .padding(.top,14).padding(.bottom,14)
        .frame(width:62)
        .frame(maxHeight:.infinity)
        .background(.regularMaterial)
    }

    private func navigation(_ target:ZenScreen,symbol:String,label:String) -> some View {
        Button { screen=target } label: {
            Image(systemName:symbol)
                .font(.system(size:15,weight:screen == target ? .semibold : .regular))
                .foregroundStyle(screen == target ? Color.primary : Color.secondary)
                .frame(width:42,height:40)
                .background(screen == target ? Color.primary.opacity(0.095) : .clear,
                            in:RoundedRectangle(cornerRadius:11,style:.continuous))
                .contentShape(RoundedRectangle(cornerRadius:11,style:.continuous))
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityIdentifier("zen.nav.\(label)")
    }
}

struct ZenSidebar: View {
    @ObservedObject var model: NativeWorkspace
    @Binding var screen: ZenScreen
    @Binding var focusedRequirementId: String?
    let decisionCount: Int
    let onInbox: () -> Void

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack {
                Text("项目").font(.system(size:13,weight:.semibold))
                Spacer()
                Text("\(model.projects.count)").font(.system(size:11)).foregroundStyle(.secondary)
            }
            .padding(.horizontal,15).frame(height:54)

            Button {
                screen = .projects
            } label: {
                Label("全部项目",systemImage:"square.grid.2x2")
                    .frame(maxWidth:.infinity,alignment:.leading).frame(height:33)
                    .padding(.horizontal,10)
                    .background(screen == .projects ? Color.primary.opacity(0.075) : .clear,
                                in:RoundedRectangle(cornerRadius:9))
            }
            .buttonStyle(.plain)
            .padding(.horizontal,9)

            Button(action:onInbox) {
                HStack(spacing:9) {
                    Image(systemName:"tray").frame(width:18)
                    Text("需要决策")
                    Spacer()
                    if decisionCount > 0 {
                        Text("\(decisionCount)")
                            .font(.system(size:10,weight:.semibold))
                            .foregroundStyle(.orange)
                    }
                }
                .frame(height:34).padding(.horizontal,10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal,9)
            .accessibilityIdentifier("zen.inbox")

            Text("项目").font(.system(size:10,weight:.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal,19).padding(.top,25).padding(.bottom,8)

            ScrollView {
                LazyVStack(alignment:.leading,spacing:3) {
                    ForEach(model.projects) { project in
                        Button {
                            model.focusZenProject(project.repoId)
                            focusedRequirementId = nil
                            screen = .board
                        } label: {
                            HStack(spacing:9) {
                                Image(systemName:"folder")
                                    .font(.system(size:11)).foregroundStyle(.secondary)
                                    .frame(width:17)
                                Text(project.displayName)
                                    .font(.system(size:12,weight:model.repoId == project.repoId ? .semibold : .regular))
                                    .lineLimit(1)
                                Spacer(minLength:0)
                                if model.repoId == project.repoId {
                                    Circle().fill(Color.accentColor.opacity(0.7))
                                        .frame(width:5,height:5)
                                }
                            }
                            .padding(.horizontal,10).frame(height:35)
                            .background(model.repoId == project.repoId ? Color.primary.opacity(0.075) : .clear,
                                        in:RoundedRectangle(cornerRadius:9))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("zen.project.\(project.repoId)")
                    }
                }
                .padding(.horizontal,9)
            }
            .scrollIndicators(.hidden)
            Spacer(minLength:0)
            if let project=model.project {
                HStack(spacing:7) {
                    Circle().fill(Color.accentColor.opacity(0.7)).frame(width:6,height:6)
                    Text(project.displayName).lineLimit(1)
                }
                .font(.system(size:10,weight:.medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal,16).padding(.bottom,16)
            }
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.leading)
        .background(.ultraThinMaterial)
    }
}

struct ZenWorkspacePane: View {
    @ObservedObject var model: NativeWorkspace
    @Binding var screen: ZenScreen
    @Binding var focusedRequirementId: String?
    let onOpenAgent: (ForgeRecord, String, String?) -> Void

    @State private var showingRequirementSheet = false
    @State private var showingPlanSheet = false
    @State private var pendingReviewRecord: ForgeRecord?
    @State private var newTitle = ""
    @State private var newOutcome = ""
    @State private var newCriteria = ""
    @State private var newPlanGoal = ""
    @State private var saving = false

    private var requirements: [ForgeRecord] {
        model.records.filter { $0.kind == .requirement }
    }

    private func bucket(_ item:ForgeRecord) -> ZenBoardBucket {
        ZenBoardBucket.classify(
            requirementState:item.state,
            runtimeActive:model.planningAutopilotStatuses[item.recordId]?.runtimeActive == true
        )
    }

    var body: some View {
        VStack(spacing:0) {
            HStack(spacing:10) {
                if screen == .canvas {
                    Button {
                        screen = .board
                        focusedRequirementId = nil
                        model.clearRecordSelection()
                    } label: {
                        Image(systemName:"chevron.left").frame(width:28,height:28)
                    }
                    .buttonStyle(.plain).help("返回看板")
                }
                VStack(alignment:.leading,spacing:3) {
                    Text(screen == .projects ? "全部项目" :
                         screen == .board ? (model.project?.displayName ?? "工作看板") :
                         (requirements.first(where:{$0.recordId == focusedRequirementId})?.title ?? "Requirement"))
                        .font(.system(size:18,weight:.semibold))
                        .lineLimit(1)
                    Text(screen == .canvas ? "Requirement → Plan" :
                         screen == .board ? "需求与交付" : "选择项目开始")
                        .font(.system(size:10.5)).foregroundStyle(.secondary)
                }
                Spacer(minLength:0)
                if screen == .board {
                    Button {
                        newTitle = ""; newOutcome = ""; newCriteria = ""
                        showingRequirementSheet = true
                    } label: {
                        Label("新需求",systemImage:"plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.repoId == nil)
                    .accessibilityIdentifier("zen.requirement.new")
                }
                Button {
                    if model.repoId != nil {
                        Task {
                            await model.loadPage()
                            await model.refreshPlanningAutopilotStatuses()
                        }
                    }
                } label: {
                    Image(systemName:"arrow.clockwise").frame(width:28,height:28)
                }
                .buttonStyle(.plain)
                .disabled(model.repoId == nil)
                .help("刷新当前项目")
            }
            .padding(.horizontal,24).frame(height:66)

            if let error=model.error {
                HStack {
                    Image(systemName:"exclamationmark.circle")
                    Text(error).textSelection(.enabled)
                    Spacer()
                    Button("关闭") { model.error=nil }
                }
                .font(.system(size:11))
                .foregroundStyle(.orange)
                .padding(.horizontal,24).padding(.vertical,8)
            }

            switch screen {
            case .projects:
                projectOverview
            case .board:
                boardView
            case .canvas:
                canvasContent
            }
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
        .background(Color(nsColor:.textBackgroundColor))
        .sheet(isPresented:$showingRequirementSheet) { createRequirementSheet }
        .sheet(isPresented:$showingPlanSheet) { createPlanSheet }
        .sheet(item:$pendingReviewRecord) { item in
            ZenReviewSheet(model:model,record:item) { prompt,provider in
                pendingReviewRecord = nil
                onOpenAgent(item,prompt,provider)
            }
        }
        .task(id:model.planningRequirementIds.joined(separator:"|")) {
            if !model.planningRequirementIds.isEmpty {
                await model.refreshPlanningAutopilotStatuses()
            }
        }
    }

    private var projectOverview: some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:0) {
                ForEach(model.projects) { project in
                    Button {
                        model.focusZenProject(project.repoId)
                        focusedRequirementId = nil
                        screen = .board
                    } label: {
                        HStack(spacing:15) {
                            Image(systemName:"folder")
                                .font(.system(size:17)).foregroundStyle(.secondary)
                                .frame(width:35,height:38)
                            VStack(alignment:.leading,spacing:4) {
                                Text(project.displayName).font(.system(size:14,weight:.medium))
                                Text(project.defaultBranch ?? project.localRoot ?? project.repoId)
                                    .font(.system(size:11)).foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName:"chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(.vertical,12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
            }
            .padding(.horizontal,29).padding(.top,20)
        }
        .overlay {
            if model.projects.isEmpty {
                ZenEmptyState(title:"暂无项目",subtitle:"请先在 Forge 中注册项目。",symbol:"folder")
            }
        }
    }

    private var boardView: some View {
        VStack(alignment:.leading,spacing:0) {
            if model.repoId == nil {
                ZenEmptyState(title:"选择项目",subtitle:"从左侧选择要推进的项目。",symbol:"folder")
                Spacer()
            } else {
                HStack(spacing:12) {
                    Text("\(requirements.count) 个 Requirement")
                    Text("\(requirements.filter{$0.state == "completed"}.count) 已完成")
                    Spacer()
                    if let issue=model.planningAutopilotStatusError {
                        Text(issue).foregroundStyle(.orange).lineLimit(1)
                    }
                }
                .font(.system(size:11)).foregroundStyle(.secondary)
                .padding(.horizontal,24).padding(.bottom,13)

                GeometryReader { frame in
                    ScrollView(.horizontal) {
                        HStack(alignment:.top,spacing:14) {
                            ForEach(ZenBoardBucket.allCases,id:\.rawValue) { stage in
                                let items = requirements.filter { bucket($0) == stage }
                                VStack(alignment:.leading,spacing:0) {
                                    HStack(spacing:9) {
                                        Circle()
                                            .fill(stage == .done ? Color.green.opacity(0.75) :
                                                  stage == .running ? Color.accentColor : Color.secondary.opacity(0.5))
                                            .frame(width:7,height:7)
                                        Text(stage.title).font(.system(size:12,weight:.semibold))
                                        Text("\(items.count)").font(.system(size:10)).foregroundStyle(.secondary)
                                        Spacer()
                                    }
                                    .padding(.bottom,13)
                                    ScrollView {
                                        LazyVStack(spacing:8) {
                                            ForEach(items) { item in
                                                Button {
                                                    focusedRequirementId = item.recordId
                                                    screen = .canvas
                                                    Task { await model.openRecord(item.id) }
                                                } label: {
                                                    VStack(alignment:.leading,spacing:9) {
                                                        Text(item.title)
                                                            .font(.system(size:12,weight:.medium))
                                                            .foregroundStyle(.primary)
                                                            .multilineTextAlignment(.leading)
                                                            .frame(maxWidth:.infinity,alignment:.leading)
                                                            .lineLimit(3)
                                                        HStack(spacing:7) {
                                                            Text(item.recordId)
                                                                .font(.system(size:9,design:.monospaced))
                                                                .lineLimit(1).truncationMode(.middle)
                                                            Spacer(minLength:0)
                                                            if let status=model.planningAutopilotStatuses[item.recordId],
                                                               stage == .running {
                                                                Text(status.runStatus ?? "执行中")
                                                                    .font(.system(size:9))
                                                            }
                                                        }
                                                        .foregroundStyle(.secondary)
                                                    }
                                                    .padding(12)
                                                    .background(Color(nsColor:.controlBackgroundColor).opacity(0.7),
                                                                in:RoundedRectangle(cornerRadius:10))
                                                    .contentShape(RoundedRectangle(cornerRadius:10))
                                                }
                                                .buttonStyle(.plain)
                                                .accessibilityIdentifier("zen.requirement.\(item.recordId)")
                                            }
                                        }
                                    }
                                    .scrollIndicators(.hidden)
                                }
                                .padding(13)
                                .frame(width:max(225,(frame.size.width - 76)/3),alignment:.topLeading)
                                .frame(maxHeight:.infinity)
                                .background(Color.primary.opacity(0.025),
                                            in:RoundedRectangle(cornerRadius:12))
                            }
                        }
                        .padding(.horizontal,24).padding(.bottom,24)
                    }
                    .scrollIndicators(.hidden)
                }
                if requirements.isEmpty {
                    Text("当前项目还没有 Requirement")
                        .font(.system(size:12)).foregroundStyle(.secondary)
                        .frame(maxWidth:.infinity)
                        .padding(.bottom,20)
                }
            }
        }
    }

    private var canvasContent: some View {
        Group {
            if let root = requirements.first(where:{$0.recordId == focusedRequirementId}) {
                HStack(spacing:0) {
                    ZenTreeCanvas(root:root,records:model.records,selectedId:model.selectedRecord) { item in
                        Task { await model.openRecord(item.id) }
                    }
                    if let selected = model.records.first(where:{$0.id == model.selectedRecord}),
                       selected.id == root.id || selected.requirementId == root.recordId {
                        detailInspector(selected)
                            .frame(width:320)
                            .background(.ultraThinMaterial)
                    }
                }
            } else {
                ZenEmptyState(title:"选择 Requirement",subtitle:"从工作看板选择一个需求查看计划树。",symbol:"point.3.connected.trianglepath.dotted")
            }
        }
    }

    private func detailInspector(_ item:ForgeRecord) -> some View {
        ScrollView {
            VStack(alignment:.leading,spacing:15) {
                HStack {
                    Text(item.kind == .requirement ? "Requirement" : "Plan")
                        .font(.system(size:10,weight:.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Text(item.state).font(.system(size:10)).foregroundStyle(.secondary)
                }
                Text(item.title).font(.system(size:16,weight:.semibold))
                Text(item.recordId).font(.system(size:10,design:.monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Divider()
                switch model.recordDetail {
                case .requirement(let detail) where item.kind == .requirement:
                    Text("目标").font(.system(size:12,weight:.semibold))
                    Text(detail.outcomeStatement).font(.system(size:12))
                        .textSelection(.enabled)
                    if !detail.acceptanceCriteria.isEmpty {
                        Divider()
                        Text("验收标准").font(.system(size:12,weight:.semibold))
                        ForEach(detail.acceptanceCriteria,id:\.self) { criterion in
                            Label(criterion,systemImage:"circle")
                                .font(.system(size:11))
                        }
                    }
                    if !detail.remainingWork.isEmpty {
                        Divider()
                        Text("尚待完成").font(.system(size:12,weight:.semibold))
                        ForEach(detail.remainingWork,id:\.self) { work in
                            Text("· \(work)").font(.system(size:11))
                        }
                    }
                case .plan(let detail) where item.kind == .plan:
                    Text("目标").font(.system(size:12,weight:.semibold))
                    Text(detail.goal).font(.system(size:12)).textSelection(.enabled)
                    Divider()
                    Text("计划事项").font(.system(size:12,weight:.semibold))
                    ForEach(detail.items) { step in
                        Text(step.objective).font(.system(size:11))
                            .frame(maxWidth:.infinity,alignment:.leading)
                    }
                default:
                    ProgressView().controlSize(.small)
                }

                Divider()
                Button {
                    onOpenAgent(item,"请基于当前 Requirement / Plan 的实际修订与关联信息分析并提出最小必要优化，先给出差异和影响范围，不要在未经确认时新增同义记录。",nil)
                } label: {
                    Label("使用 Agent 优化",systemImage:"sparkles")
                }
                .buttonStyle(.bordered)
                Button {
                    pendingReviewRecord = item
                } label: {
                    Label("Review",systemImage:"checkmark.seal")
                }
                .buttonStyle(.bordered)
                if item.kind == .requirement {
                    Button {
                        newPlanGoal = ""
                        showingPlanSheet = true
                    } label: {
                        Label("新增 Plan",systemImage:"plus")
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(18)
            .frame(maxWidth:.infinity,alignment:.leading)
        }
        .accessibilityIdentifier("zen.record.inspector")
    }

    private var createRequirementSheet: some View {
        VStack(alignment:.leading,spacing:12) {
            Text("新建 Requirement").font(.system(size:17,weight:.semibold))
            TextField("名称",text:$newTitle)
            TextField("预期结果",text:$newOutcome,axis:.vertical).lineLimit(3...5)
            TextField("验收标准（每行一项）",text:$newCriteria,axis:.vertical).lineLimit(3...6)
            HStack {
                Spacer()
                Button("取消") { showingRequirementSheet=false }
                Button(saving ? "保存中…" : "创建") {
                    saving=true
                    Task {
                        let id=await model.createRequirement(
                            title:newTitle,outcome:newOutcome,
                            acceptanceCriteria:newCriteria.components(separatedBy:.newlines)
                        )
                        saving=false
                        if let id {
                            focusedRequirementId=id
                            screen = .canvas
                            showingRequirementSheet=false
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || newTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                          || newOutcome.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22).frame(width:430)
        .accessibilityIdentifier("zen.requirement.create")
    }

    private var createPlanSheet: some View {
        VStack(alignment:.leading,spacing:12) {
            Text("新增 Plan").font(.system(size:17,weight:.semibold))
            TextField("计划目标",text:$newPlanGoal,axis:.vertical).lineLimit(3...5)
            HStack {
                Spacer()
                Button("取消") { showingPlanSheet=false }
                Button(saving ? "保存中…" : "创建") {
                    saving=true
                    Task {
                        let id=await model.createPlan(objective:newPlanGoal,
                                                      requirementId:focusedRequirementId,
                                                      parentPlanId:nil)
                        saving=false
                        if id != nil { showingPlanSheet=false }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || newPlanGoal.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22).frame(width:400)
    }
}

private struct ZenTreeCanvas: View {
    let root: ForgeRecord
    let records: [ForgeRecord]
    let selectedId: String?
    let onSelect: (ForgeRecord) -> Void

    private var levels: [[ForgeRecord]] {
        var result:[[ForgeRecord]]=[[root]]
        var visited:Set<String>=[root.id]
        while let parents=result.last, !parents.isEmpty, result.count < 10 {
            var next:[ForgeRecord]=[]
            for parent in parents {
                let children=records.filter { record in
                    guard record.kind == .plan else { return false }
                    if parent.kind == .requirement {
                        return record.requirementId == root.recordId && record.parentPlanId == nil
                    }
                    return record.requirementId == root.recordId && record.parentPlanId == parent.recordId
                }
                for child in children where visited.insert(child.id).inserted {
                    next.append(child)
                }
            }
            if next.isEmpty { break }
            result.append(next)
        }
        return result
    }

    private func position(_ row:Int,_ index:Int,width:CGFloat,columns:Int) -> CGPoint {
        let columnWidth=width/CGFloat(max(1,columns))
        return CGPoint(x:columnWidth * (CGFloat(index) + 0.5),y:CGFloat(row)*156+89)
    }

    var body: some View {
        GeometryReader { viewport in
            let rows=levels
            let maxNodes=rows.map(\.count).max() ?? 1
            let width=max(viewport.size.width,CGFloat(maxNodes)*240+70)
            let height=max(viewport.size.height,CGFloat(rows.count)*156+60)
            ScrollView([.horizontal,.vertical]) {
                ZStack(alignment:.topLeading) {
                    Canvas { context,_ in
                        for row in 1..<rows.count {
                            for (index,child) in rows[row].enumerated() {
                                let parents=rows[row-1]
                                guard let parentIndex=parents.firstIndex(where:{ parent in
                                    child.parentPlanId == parent.recordId
                                    || (parent.kind == .requirement && child.parentPlanId == nil)
                                }) else { continue }
                                let start=position(row-1,parentIndex,width:width,columns:parents.count)
                                let end=position(row,index,width:width,columns:rows[row].count)
                                var path=Path()
                                path.move(to:CGPoint(x:start.x,y:start.y+41))
                                path.addCurve(to:CGPoint(x:end.x,y:end.y-41),
                                              control1:CGPoint(x:start.x,y:(start.y+end.y)/2),
                                              control2:CGPoint(x:end.x,y:(start.y+end.y)/2))
                                context.stroke(path,with:.color(.secondary.opacity(0.28)),
                                               style:StrokeStyle(lineWidth:1.2,lineCap:.round))
                            }
                        }
                    }
                    .frame(width:width,height:height)

                    ForEach(0..<rows.count,id:\.self) { row in
                        ForEach(Array(rows[row].enumerated()),id:\.element.id) { index,item in
                            Button { onSelect(item) } label: {
                                VStack(alignment:.leading,spacing:7) {
                                    HStack(spacing:7) {
                                        Image(systemName:item.kind == .requirement ? "scope" : "list.bullet.rectangle")
                                            .font(.system(size:12)).foregroundStyle(.secondary)
                                        Text(item.kind == .requirement ? "Requirement" : "Plan")
                                            .font(.system(size:10,weight:.semibold))
                                            .foregroundStyle(.secondary)
                                        Spacer()
                                    }
                                    Text(item.title).font(.system(size:12,weight:.medium))
                                        .foregroundStyle(.primary)
                                        .lineLimit(2).multilineTextAlignment(.leading)
                                    Text(item.recordId)
                                        .font(.system(size:9,design:.monospaced))
                                        .foregroundStyle(.secondary).lineLimit(1)
                                }
                                .frame(width:184,height:62,alignment:.topLeading)
                                .padding(10)
                                .background(item.id == selectedId
                                            ? Color.accentColor.opacity(0.09)
                                            : Color(nsColor:.controlBackgroundColor),
                                            in:RoundedRectangle(cornerRadius:12))
                                .contentShape(RoundedRectangle(cornerRadius:12))
                            }
                            .buttonStyle(.plain)
                            .position(position(row,index,width:width,columns:rows[row].count))
                            .accessibilityIdentifier("zen.canvas.node.\(item.recordId)")
                        }
                    }
                }
                .frame(width:width,height:height)
            }
            .scrollIndicators(.visible)
        }
        .background(Color(nsColor:.textBackgroundColor))
        .accessibilityIdentifier("zen.requirement.canvas")
    }
}

private struct ZenEmptyState: View {
    let title: String
    let subtitle: String
    let symbol: String

    var body: some View {
        VStack(spacing:10) {
            Image(systemName:symbol)
                .font(.system(size:25,weight:.light))
                .foregroundStyle(.tertiary)
            Text(title).font(.system(size:14,weight:.semibold))
            Text(subtitle).font(.system(size:11)).foregroundStyle(.secondary)
        }
        .frame(maxWidth:.infinity,maxHeight:.infinity)
    }
}

private enum ZenReviewRole: String, CaseIterable, Identifiable {
    case product = "产品"
    case staff = "Staff Engineer"
    case quality = "质量与验收"
    var id: String { rawValue }
    var focus: String {
        switch self {
        case .product: return "用户价值、范围、验收标准和需求重复"
        case .staff: return "架构边界、实现可行性、耦合和技术风险"
        case .quality: return "验收标准、测试证据、失败风险及未验证项"
        }
    }
}

private struct ZenReviewSheet: View {
    @ObservedObject var model: NativeWorkspace
    let record: ForgeRecord
    let onStart: (String, String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var role: ZenReviewRole = .staff
    @State private var provider = ""

    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                Text("Review").font(.system(size:17,weight:.semibold))
                Spacer()
                Button { dismiss() } label: { Image(systemName:"xmark") }
                    .buttonStyle(.plain)
                    .accessibilityLabel("取消 Review")
            }
            Text(record.title).font(.system(size:12)).lineLimit(2)
            Divider()
            Picker("审查角色",selection:$role) {
                ForEach(ZenReviewRole.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.menu)
            Text(role.focus).font(.system(size:11)).foregroundStyle(.secondary)
            Picker("Provider / Model",selection:$provider) {
                Text("默认 Provider").tag("")
                Text("Codex").tag("codex")
                if model.localApiSettings?.joyCodeReady == true {
                    Text("JoyCode · \(model.localApiSettings?.joyCodeModel ?? "JoyCode")").tag("joycode")
                }
                ForEach(model.localApiSettings?.profiles.filter(\.endpointReady) ?? []) { profile in
                    Text("\(profile.label) · \(profile.model)").tag(profile.providerId)
                }
            }
            .pickerStyle(.menu)
            Text("只读审查，不自动修改 Requirement 或 Plan。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("在 Agent 中审查") {
                    let instruction = "请扮演\(role.rawValue)，对当前 \(record.kind == .requirement ? "Requirement" : "Plan") 做只读 Review。重点检查：\(role.focus)。按问题、证据、优先级、建议的结构返回，明确记录修订与不确定性；不要直接写入或新增 Requirement / Plan，也不要修改源码。"
                    dismiss()
                    onStart(instruction,provider.isEmpty ? nil : provider)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(22)
        .frame(width:420)
        .accessibilityIdentifier("zen.review.configure")
    }
}
