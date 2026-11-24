import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct RecordsPane: View {
    @ObservedObject var model: NativeWorkspace
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var authoring: PlanningAuthoringContext?
    @State private var autopilotApproval: AutopilotApprovalContext?
    @State private var checkpointReview: AutopilotCheckpointReview?
    @State private var draftTitle = ""
    @State private var draftOutcome = ""
    @State private var draftCriteria = ""
    @State private var autopilotModel = "deepseek-chat"
    @State private var autopilotTokenBudget = "50000"
    @State private var autopilotTurnBudget = "12"
    @State private var autopilotToolBudget = "32"
    @State private var autopilotCheckpoints = Set<String>()
    @State private var saving = false
    @State private var autopilotSaving = false

    @State private var planningViewMode = "list"
    @State private var hoveredPlanningRecordId: String?
    @State private var planningSearch = ""
    @State private var collapsedPlanningRecordIds = Set<String>()
    @State private var planningZoom: CGFloat = 1
    @State private var planningFitToView = false
    @State private var planningFitScale: CGFloat = 1
    @State private var planningShowUnlinked = false
    @State private var planningScrollTarget: String?

    private let planningNodeWidth: CGFloat = 228
    private let planningNodeHeight: CGFloat = 92
    private let planningColumnGap: CGFloat = 66
    private let planningRowGap: CGFloat = 30
    private let planningLaneHeaderHeight: CGFloat = 36

    var body: some View {
        GeometryReader { geometry in
            let compact = geometry.size.width < 900
            HStack(spacing:0) {
                if !compact || model.selectedRecord == nil {
                    planningNavigator
                        .frame(minWidth:compact ? 0 : 520,maxWidth:.infinity)
                        .padding(.leading,compact ? 8 : 12)
                }

            if let selected = model.records.first(where:{$0.id == model.selectedRecord}) {
                ScrollView {
                    VStack(alignment:.leading,spacing:17) {
                        HStack(alignment:.top,spacing:12) {
                            VStack(alignment:.leading,spacing:7) {
                                Text(selected.title).font(.system(size:18,weight:.medium))
                                Text(planningNodeRole(selected))
                                    .font(.system(size:10,weight:.semibold))
                                    .foregroundStyle(ForgePalette.secondary)
                                Text(selected.recordId).font(.system(size:9.5,design:.monospaced))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer()
                            Button {
                                model.clearRecordSelection()
                            } label: {
                                if compact {
                                    Label("返回规划",systemImage:"chevron.left")
                                        .font(.system(size:11,weight:.medium))
                                } else {
                                    Image(systemName:"xmark")
                                        .font(.system(size:9,weight:.semibold))
                                        .frame(width:24,height:24)
                                }
                            }
                            .buttonStyle(.plain)
                            .help("关闭详情，返回规划")
                            .accessibilityIdentifier("planning.detail.back")
                        }

                        if let recordDetail = model.recordDetail {
                            semanticRecordDetail(recordDetail)
                        }
                    }
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .padding(.horizontal,18).padding(.vertical,20)
                }
                .frame(minWidth:compact ? 0 : 280,
                       idealWidth:compact ? geometry.size.width : 330,
                       maxWidth:compact ? .infinity : 390)
                .overlay(alignment:.leading) {
                    if !compact {
                        Rectangle()
                            .fill(Color.primary.opacity(0.09))
                            .frame(width:1)
                    }
                }
                .padding(.trailing,compact ? 8 : 12)
                .transition(reduceMotion ? .identity : .move(edge:.trailing).combined(with:.opacity))
            }
            }
        }
        .background(ForgePalette.canvas)
        .sheet(item:$authoring) { context in
            planningAuthoringSheet(context)
        }
        .sheet(item:$autopilotApproval) { context in
            autopilotApprovalSheet(context)
        }
        .sheet(item:$checkpointReview) { review in
            AutopilotCheckpointReviewSheet(model:model,review:review) {
                checkpointReview=nil
            }
        }
        .task(id:planningOperationalRefreshKey) {
            guard scenePhase == .active,!model.planningRequirementIds.isEmpty else { return }
            await model.refreshPlanningAutopilotStatuses()
            while !Task.isCancelled {
                do { try await Task.sleep(for:.seconds(12)) }
                catch { return }
                guard !Task.isCancelled else { return }
                await model.refreshPlanningAutopilotStatuses()
            }
        }
    }

    private var planningOperationalRefreshKey: String {
        "\(model.repoId ?? "none")|\(model.checkoutId ?? "none")|\(scenePhase == .active ? "active" : "inactive")|\(model.planningRequirementIds.joined(separator:"|"))"
    }

    private var planningOverview: some View {
        let requirements=model.records.filter { $0.kind == .requirement }
        let plans=model.records.filter { $0.kind == .plan }
        let openCount=requirements.filter { $0.state == "open" }.count
        let completedCount=requirements.filter { $0.state == "completed" }.count
        return HStack(spacing:12) {
            Image(systemName:"folder")
                .foregroundStyle(ForgePalette.secondary)
            VStack(alignment:.leading,spacing:2) {
                Text("当前项目")
                    .font(.system(size:9))
                    .foregroundStyle(ForgePalette.secondary)
                Text(model.semanticProject?.displayName ?? model.project?.label ?? model.repoId ?? "未选择项目")
                    .font(.system(size:11,weight:.semibold))
                    .lineLimit(1)
            }
            Spacer(minLength:4)
            VStack(alignment:.trailing,spacing:3) {
                Text("需求 \(requirements.count)  ·  计划 \(plans.count)")
                    .font(.system(size:10,weight:.medium))
                Text("开放 \(openCount)  ·  已完成 \(completedCount)")
                    .font(.system(size:9))
                    .foregroundStyle(ForgePalette.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal,12).padding(.vertical,10)
        
        .accessibilityIdentifier("planning.project.overview")
    }

    private var planningNavigator: some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(alignment:.top,spacing:8) {
                Text("规划结构").font(.system(size:13,weight:.semibold))
                Spacer(minLength:4)
                Button { beginRequirement() } label: {
                    Image(systemName:"doc.badge.plus")
                        .frame(width:25,height:25)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .help("新建需求")
                .disabled(model.semanticProject?.status != "active")
                Button { beginPlan(requirementId:nil,parentPlanId:nil) } label: {
                    Image(systemName:"plus")
                        .frame(width:25,height:25)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .help("新建计划")
                .disabled(model.semanticProject?.status != "active")
            }
            .padding(.horizontal,13).padding(.top,13).padding(.bottom,9)

            planningOverview
                .padding(.horizontal,13).padding(.bottom,12)

            HStack(spacing:8) {
                Picker("规划视图",selection:$planningViewMode) {
                    Label("关系图",systemImage:"point.3.connected.trianglepath.dotted").tag("map")
                    Label("列表",systemImage:"list.bullet").tag("list")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width:168)
                .onChange(of:planningViewMode) { mode in
                    guard mode == "map",
                          let selectedId=model.selectedRecord,
                          let selected=model.records.first(where:{$0.id == selectedId}),
                          planningParent(of:selected) == nil,
                          (planningChildrenByParent[selected.id] ?? []).isEmpty else { return }
                    planningShowUnlinked = true
                    planningScrollTarget = selected.id
                }

                HStack(spacing:6) {
                    Image(systemName:"magnifyingglass")
                        .font(.system(size:9.5))
                        .foregroundStyle(ForgePalette.secondary)
                    TextField("搜索需求和计划",text:$planningSearch)
                        .textFieldStyle(.plain)
                        .font(.system(size:10.5))
                        .onSubmit {
                            if let first=planningSearchMatches.first {
                                locatePlanningRecord(first)
                            }
                        }
                        .accessibilityIdentifier("planning.search.field")
                    if !planningSearch.isEmpty {
                        Button {
                            planningSearch = ""
                        } label: {
                            Image(systemName:"xmark.circle.fill")
                                .font(.system(size:9.5))
                                .foregroundStyle(ForgePalette.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("清除")
                    }
                }
                .padding(.horizontal,8)
                .frame(minWidth:110,idealWidth:155,maxWidth:190,minHeight:25)
                .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))

                if let focus=planningExecutionFocusRecord,
                   let status=planningExecutionStatus(focus) {
                    Button {
                        locatePlanningRecord(focus)
                    } label: {
                        HStack(spacing:4) {
                            Circle()
                                .fill(planningExecutionColor(status))
                                .frame(width:5.5,height:5.5)
                            Image(systemName:"scope")
                                .font(.system(size:10,weight:.semibold))
                        }
                    }
                    .buttonStyle(.plain)
                    .help("定位执行焦点 · \(planningExecutionLabel(focus,status)) · \(focus.recordId)")
                    .accessibilityLabel("定位执行焦点")
                    .accessibilityValue("\(planningExecutionLabel(focus,status)) · \(focus.recordId)")
                    .accessibilityIdentifier("planning.execution.focus")
                }

                if let refreshError=model.planningAutopilotStatusError {
                    Button {
                        Task { await model.refreshPlanningAutopilotStatuses() }
                    } label: {
                        Image(systemName:"exclamationmark.triangle.fill")
                            .font(.system(size:10))
                            .foregroundStyle(.orange)
                    }
                    .buttonStyle(.plain)
                    .help("执行态刷新失败，点击重试\n\(refreshError)")
                    .accessibilityLabel("执行态刷新失败，点击重试")
                    .accessibilityIdentifier("planning.execution.refresh-error")
                }

                if planningViewMode == "map" {
                    Button {
                        planningFitToView = true
                        planningScrollTarget = "planning.origin"
                    } label: {
                        Image(systemName:"arrow.left.and.right")
                    }
                    .buttonStyle(.plain)
                    .help("适配关系宽度并回到起点")
                    .accessibilityIdentifier("planning.zoom.fit")

                    Button {
                        let base=planningFitToView ? planningFitScale : planningZoom
                        planningZoom = max(0.55,base - 0.1)
                        planningFitToView = false
                    } label: {
                        Image(systemName:"minus.magnifyingglass")
                    }
                    .buttonStyle(.plain)
                    .help("缩小")
                    .accessibilityIdentifier("planning.zoom.out")

                    Text(planningFitToView ? "适配宽度" : "\(Int(planningZoom * 100))%")
                        .font(.system(size:9,design:.monospaced))
                        .foregroundStyle(ForgePalette.secondary)
                        .frame(minWidth:32)

                    Button {
                        let base=planningFitToView ? planningFitScale : planningZoom
                        planningZoom = min(1.6,base + 0.1)
                        planningFitToView = false
                    } label: {
                        Image(systemName:"plus.magnifyingglass")
                    }
                    .buttonStyle(.plain)
                    .help("放大")
                    .accessibilityIdentifier("planning.zoom.in")
                }

                Spacer(minLength:0)

                if planningViewMode == "map",!planningUnlinkedRecords.isEmpty {
                    Button {
                        planningShowUnlinked.toggle()
                        planningFitToView = false
                        planningScrollTarget = "planning.origin"
                    } label: {
                        HStack(spacing:4) {
                            Image(systemName:planningShowUnlinked ? "eye.slash" : "circle.dashed")
                                .font(.system(size:8.5,weight:.semibold))
                            Text(planningShowUnlinked ? "隐藏未关联" : "未关联 \(planningUnlinkedRecords.count)")
                        }
                        .font(.system(size:9,weight:.medium))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ForgePalette.secondary)
                    .help(planningShowUnlinked
                          ? "隐藏没有父子关系的 Requirement / Plan"
                          : "显示 \(planningUnlinkedRecords.count) 个没有父子关系的节点")
                    .accessibilityIdentifier("planning.unlinked.toggle")
                }

                if model.selectedRecord != nil {
                    Button("显示全部") { model.clearRecordSelection() }
                        .buttonStyle(.plain)
                        .font(.system(size:9.5,weight:.medium))
                        .foregroundStyle(ForgePalette.accent)
                }
            }
            .padding(.horizontal,13).padding(.bottom,7)

            if !planningSearch.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
                planningSearchResults
                    .padding(.horizontal,13)
                    .padding(.top,5)
            }

            planningSelectionContext
                .padding(.horizontal,13)
                .padding(.top,6)

            if planningViewMode == "map" {
                planningRelationLegend
                    .padding(.horizontal,13)
                    .padding(.top,4).padding(.bottom,7)
            }

            Divider().opacity(0.55)

            if model.records.isEmpty {
                VStack(alignment:.leading,spacing:8) {
                    Image(systemName:"sparkles.rectangle.stack")
                        .font(.system(size:18))
                        .foregroundStyle(ForgePalette.secondary)
                    Text("这个项目还没有规划树")
                        .font(.system(size:12,weight:.semibold))
                }
                .padding(15)
                .frame(maxWidth:.infinity,alignment:.leading)
                Spacer(minLength:0)
            } else if planningViewMode == "map" {
                if planningVisibleRecords.isEmpty {
                    VStack(alignment:.leading,spacing:10) {
                        Image(systemName:"point.3.connected.trianglepath.dotted")
                            .font(.system(size:20))
                            .foregroundStyle(ForgePalette.secondary)
                        Text("当前没有父子关系可画")
                            .font(.system(size:12,weight:.semibold))
                        if !planningUnlinkedRecords.isEmpty {
                            Button("显示 \(planningUnlinkedRecords.count) 个未关联节点") {
                                planningShowUnlinked = true
                            }
                            .buttonStyle(.plain)
                            .font(.system(size:10,weight:.semibold))
                            .foregroundStyle(ForgePalette.accent)
                        }
                    }
                    .padding(18)
                    .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                } else {
                    planningCanvas
                }
            } else {
                planningList
            }
        }
    }

    private var planningSearchMatches: [ForgeRecord] {
        let needle=planningSearch.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        return Array(model.records.filter {
            $0.title.localizedCaseInsensitiveContains(needle)
                || $0.recordId.localizedCaseInsensitiveContains(needle)
        }.prefix(5))
    }

    private var planningSearchResults: some View {
        VStack(alignment:.leading,spacing:2) {
            if planningSearchMatches.isEmpty {
                Text("没有匹配节点")
                    .font(.system(size:9.5))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.horizontal,8).padding(.vertical,6)
            } else {
                ForEach(planningSearchMatches) { item in
                    Button {
                        locatePlanningRecord(item)
                    } label: {
                        HStack(spacing:7) {
                            Image(systemName:item.kind == .requirement ? "scope" : "arrow.triangle.branch")
                                .font(.system(size:9.5,weight:.semibold))
                            Text(item.title)
                                .font(.system(size:10.5,weight:.medium))
                                .lineLimit(1)
                            Spacer(minLength:4)
                            Text(item.recordId)
                                .font(.system(size:8.5,design:.monospaced))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal,8).frame(height:27)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("planning.search.result.\(item.recordId)")
                }
            }
        }
        .padding(3)
        .background(.thinMaterial,in:RoundedRectangle(cornerRadius:9,style:.continuous))
    }

    private func planningNodeRole(_ item:ForgeRecord) -> String {
        if item.kind == .requirement { return "需求 · Requirement" }
        if item.parentPlanId != nil { return "子计划 · Plan" }
        if item.requirementId != nil { return "主计划 · Plan" }
        return "独立计划 · Plan"
    }

    private var planningSelectedPath: [ForgeRecord] {
        guard let selectedId=model.selectedRecord,
              let selected=model.records.first(where:{ $0.id == selectedId }) else { return [] }
        var path:[ForgeRecord]=[selected]
        var cursor:ForgeRecord?=selected
        var visited:Set<String>=[selected.id]
        while let current=cursor,
              let parent=planningParent(of:current),
              visited.insert(parent.id).inserted {
            path.append(parent)
            cursor=parent
        }
        return path.reversed()
    }

    private var planningSelectedPathIds: Set<String> {
        Set(planningSelectedPath.map(\.id))
    }

    @ViewBuilder
    private var planningSelectionContext: some View {
        if let selectedId=model.selectedRecord,
           let selected=model.records.first(where:{ $0.id == selectedId }) {
            let children=planningChildrenByParent[selected.id] ?? []
            HStack(spacing:8) {
                Image(systemName:"point.3.connected.trianglepath.dotted")
                    .font(.system(size:10,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)

                ScrollView(.horizontal,showsIndicators:false) {
                    HStack(spacing:5) {
                        ForEach(Array(planningSelectedPath.enumerated()),id:\.element.id) { index,node in
                            if index > 0 {
                                Image(systemName:"chevron.right")
                                    .font(.system(size:7,weight:.bold))
                                    .foregroundStyle(ForgePalette.secondary.opacity(0.65))
                            }
                            Button {
                                locatePlanningRecord(node)
                            } label: {
                                HStack(spacing:4) {
                                    Image(systemName:node.kind == .requirement ? "scope" : "arrow.triangle.branch")
                                        .font(.system(size:8.5,weight:.semibold))
                                    Text(node.title)
                                        .font(.system(size:9.5,weight:node.id == selected.id ? .semibold : .medium))
                                        .lineLimit(1)
                                }
                                .foregroundStyle(node.id == selected.id ? ForgePalette.ink : ForgePalette.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Spacer(minLength:4)

                HStack(spacing:5) {
                    Text(planningNodeRole(selected))
                    if !children.isEmpty {
                        Text("·")
                        Text("\(children.count) 个直接子节点")
                    }
                }
                .font(.system(size:9,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
                .lineLimit(1)
            }
            .padding(.horizontal,9).padding(.vertical,7)
            .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
            .accessibilityIdentifier("planning.selection.path")
        }
    }

    private var planningRelationLegend: some View {
        HStack(spacing:7) {
            Label("需求",systemImage:"scope")
            Image(systemName:"arrow.right")
                .font(.system(size:8,weight:.bold))
            Text("根计划")
            Image(systemName:"arrow.right")
                .font(.system(size:8,weight:.bold))
            Text("子计划")
            Spacer(minLength:4)
        }
        .font(.system(size:9.2,weight:.medium))
        .foregroundStyle(ForgePalette.secondary)
        .accessibilityIdentifier("planning.relationship.legend")
    }

    private func locatePlanningRecord(_ item:ForgeRecord) {
        var cursor:ForgeRecord?=item
        var visited=Set<String>()
        while let current=cursor,visited.insert(current.id).inserted {
            if let parent=planningParent(of:current) {
                collapsedPlanningRecordIds.remove(parent.id)
                cursor=parent
            } else {
                cursor=nil
            }
        }
        if planningParent(of:item) == nil,
           (planningChildrenByParent[item.id] ?? []).isEmpty {
            planningShowUnlinked = true
        }
        planningSearch=""
        planningScrollTarget=item.id
        Task { await model.openRecord(item.id) }
    }

    private var planningListVisibleRecords: [ForgeRecord] {
        // planningRecords is canonical preorder: hiding a collapsed parent's
        // descendants requires no second graph or relationship state.
        var result:[ForgeRecord]=[]
        var hiddenBelowDepth:Int?
        for item in model.records {
            if let depth=hiddenBelowDepth {
                if item.depth > depth { continue }
                hiddenBelowDepth=nil
            }
            result.append(item)
            if collapsedPlanningRecordIds.contains(item.id) {
                hiddenBelowDepth=item.depth
            }
        }
        return result
    }

    private var planningList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment:.leading,spacing:5) {
                    ForEach(planningListVisibleRecords) { item in
                        planningListRow(item).id(item.id)
                    }
                }
                .padding(10)
            }
            .scrollIndicators(.visible)
            .onChange(of:planningScrollTarget) { target in
                guard planningViewMode == "list",let target else { return }
                DispatchQueue.main.async {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                        proxy.scrollTo(target,anchor:.center)
                    }
                    planningScrollTarget=nil
                }
            }
        }
    }

    private func planningListRow(_ item:ForgeRecord) -> some View {
        let parent=planningParent(of:item)
        let children=planningChildrenByParent[item.id] ?? []
        let collapsed=collapsedPlanningRecordIds.contains(item.id)
        return HStack(spacing:4) {
            Button {
                Task { await model.openRecord(item.id) }
            } label: {
                HStack(alignment:.center,spacing:10) {
                    Image(systemName:item.kind == .requirement ? "scope" :
                          item.parentPlanId != nil ? "arrow.turn.down.right" : "arrow.triangle.branch")
                        .symbolRenderingMode(.hierarchical)
                        .font(.system(size:12,weight:.medium))
                        .foregroundStyle(item.kind == .requirement ? ForgePalette.ink : ForgePalette.secondary)
                        .frame(width:19,height:20)
                    VStack(alignment:.leading,spacing:4) {
                        HStack(spacing:7) {
                            Text(planningNodeRole(item))
                                .font(.system(size:9,weight:.semibold))
                                .foregroundStyle(ForgePalette.secondary)
                            if item.kind == .requirement,!item.state.isEmpty {
                                Text(item.state == "completed" ? "已完成" :
                                     item.state == "open" ? "开放" :
                                     item.state == "cancelled" ? "已取消" : item.state)
                                    .font(.system(size:9,weight:.medium))
                                    .foregroundStyle(ForgePalette.secondary)
                            }
                            if let status=planningExecutionStatus(item) {
                                Text(planningExecutionLabel(item,status))
                                    .font(.system(size:9,weight:.semibold))
                                    .foregroundStyle(planningExecutionColor(status))
                                    .help(planningExecutionHelp(item,status))
                            }
                            if let parent {
                                Text("属于 \(parent.title)")
                                    .font(.system(size:9))
                                    .foregroundStyle(ForgePalette.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Text(item.title)
                            .font(.system(size:item.kind == .requirement ? 13 : 12.5,
                                          weight:item.kind == .requirement ? .semibold : .medium))
                            .foregroundStyle(ForgePalette.ink)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        Text(item.recordId)
                            .font(.system(size:9,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength:0)
                }
                .padding(.horizontal,8).padding(.vertical,9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("semantic.record.\(item.kind.rawValue).\(item.recordId)")

            if !children.isEmpty {
                Button {
                    if collapsed {
                        collapsedPlanningRecordIds.remove(item.id)
                    } else {
                        collapsedPlanningRecordIds.insert(item.id)
                    }
                } label: {
                    HStack(spacing:4) {
                        Text("\(children.count)")
                            .font(.system(size:9,weight:.medium,design:.monospaced))
                        Image(systemName:collapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size:9,weight:.semibold))
                    }
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(minWidth:38,minHeight:34)
                    .background(ForgePalette.softFill,
                                in:RoundedRectangle(cornerRadius:8,style:.continuous))
                }
                .buttonStyle(.plain)
                .help(collapsed ? "展开 \(children.count) 个直接子节点" : "折叠 \(children.count) 个直接子节点")
                .accessibilityLabel(collapsed ? "展开子节点" : "折叠子节点")
                .accessibilityIdentifier("planning.list.children.\(item.recordId)")
                .padding(.trailing,8)
            }
        }
        .padding(.leading,CGFloat(min(item.depth,6) * 18))
        .frame(maxWidth:.infinity,alignment:.leading)
        .background(item.id == model.selectedRecord ? ForgePalette.selectionStrong :
                    item.kind == .requirement ? ForgePalette.raisedSurface : ForgePalette.softFill.opacity(0.45),
                    in:RoundedRectangle(cornerRadius:10,style:.continuous))
        .overlay(alignment:.leading) {
            if item.kind == .requirement {
                RoundedRectangle(cornerRadius:1.5)
                    .fill(ForgePalette.accent.opacity(0.46))
                    .frame(width:3)
                    .padding(.leading,2)
            }
        }
    }

    private var planningCanvas: some View {
        GeometryReader { viewport in
            let positions = planningCanvasPositions
            let size = planningCanvasSize
            let scale = planningCanvasScale(viewport:viewport.size,content:size)
            let focusIds = planningFocusIds
            let selectedPathIds = planningSelectedPathIds
            let hasSelection = model.selectedRecord != nil
            let columnStep = planningNodeWidth + planningColumnGap
            let maxX = positions.values.map(\.x).max() ?? 0
            let maxDepth = max(0,Int((maxX / max(CGFloat(1),columnStep)).rounded()))

            ScrollViewReader { proxy in
                ScrollView([.horizontal,.vertical]) {
                    ZStack(alignment:.topLeading) {
                        Color.clear
                            .frame(width:1,height:1)
                            .position(x:1,y:1)
                            .id("planning.origin")

                        ForEach(0...maxDepth,id:\.self) { depth in
                            let x=CGFloat(depth) * columnStep
                            RoundedRectangle(cornerRadius:12,style:.continuous)
                                .fill(depth.isMultiple(of:2) ? Color.black.opacity(0.018) : Color.black.opacity(0.010))
                                .frame(width:planningNodeWidth,height:size.height)
                                .offset(x:x,y:0)

                            VStack(alignment:.leading,spacing:2) {
                                Text(depth == 0 ? "起点" : "Plan 第 \(depth) 层")
                                    .font(.system(size:9.5,weight:.semibold))
                                    .foregroundStyle(ForgePalette.ink.opacity(0.82))
                                Text(depth == 0 ? "Requirement / 独立 Plan" : "沿箭头读取父子关系")
                                    .font(.system(size:8.3))
                                    .foregroundStyle(ForgePalette.secondary)
                            }
                            .padding(.horizontal,9)
                            .offset(x:x,y:7)
                        }

                        Canvas { context, _ in
                            for item in planningVisibleRecords {
                                guard let child = positions[item.id],
                                      let parent = planningParent(of:item),
                                      let parentPoint = positions[parent.id] else { continue }
                                let start = CGPoint(
                                    x:parentPoint.x + planningNodeWidth,
                                    y:parentPoint.y + planningNodeHeight / 2
                                )
                                let end = CGPoint(
                                    x:child.x,
                                    y:child.y + planningNodeHeight / 2
                                )
                                let bend = max(start.x + 24,(start.x + end.x) / 2)
                                var path = Path()
                                path.move(to:start)
                                path.addCurve(
                                    to:end,
                                    control1:CGPoint(x:bend,y:start.y),
                                    control2:CGPoint(x:bend,y:end.y)
                                )
                                let onSelectedPath = hasSelection
                                    && selectedPathIds.contains(item.id)
                                    && selectedPathIds.contains(parent.id)
                                let structurallyRelated = !hasSelection
                                    || (focusIds.contains(item.id) && focusIds.contains(parent.id))
                                let edgeColor = onSelectedPath
                                    ? ForgePalette.accent.opacity(0.82)
                                    : (structurallyRelated
                                        ? ForgePalette.accent.opacity(hasSelection ? 0.34 : 0.26)
                                        : ForgePalette.secondary.opacity(0.14))
                                let edgeWidth: CGFloat = onSelectedPath ? 2.35 : (structurallyRelated ? 1.45 : 1)
                                context.stroke(
                                    path,
                                    with:.color(edgeColor),
                                    style:StrokeStyle(lineWidth:edgeWidth,lineCap:.round)
                                )
                                let arrowSize: CGFloat = onSelectedPath ? 7 : (structurallyRelated ? 6 : 5)
                                var arrow = Path()
                                arrow.move(to:end)
                                arrow.addLine(to:CGPoint(x:end.x - arrowSize,y:end.y - arrowSize * 0.72))
                                arrow.move(to:end)
                                arrow.addLine(to:CGPoint(x:end.x - arrowSize,y:end.y + arrowSize * 0.72))
                                context.stroke(
                                    arrow,
                                    with:.color(edgeColor),
                                    style:StrokeStyle(lineWidth:edgeWidth,lineCap:.round,lineJoin:.round)
                                )
                            }
                        }
                        .frame(width:size.width,height:size.height)

                        ForEach(planningVisibleRecords) { item in
                            if let child=positions[item.id],
                               let parent=planningParent(of:item),
                               let parentPoint=positions[parent.id] {
                                let onSelectedPath = hasSelection
                                    && selectedPathIds.contains(item.id)
                                    && selectedPathIds.contains(parent.id)
                                let structurallyRelated = !hasSelection
                                    || (focusIds.contains(item.id) && focusIds.contains(parent.id))
                                if structurallyRelated {
                                let startX=parentPoint.x + planningNodeWidth
                                let endX=child.x
                                let midX=(startX + endX) / 2
                                let midY=((parentPoint.y + child.y) / 2) + planningNodeHeight / 2
                                Text(parent.kind == .requirement ? "拥有" : "细化")
                                    .font(.system(size:7.8,weight:.semibold))
                                    .foregroundStyle(onSelectedPath ? ForgePalette.accent : ForgePalette.secondary)
                                    .padding(.horizontal,5).padding(.vertical,2)
                                    .background(ForgePalette.raisedSurface.opacity(0.94),in:Capsule())
                                    .overlay(Capsule().stroke(
                                        (onSelectedPath ? ForgePalette.accent : ForgePalette.secondary).opacity(0.18),
                                        lineWidth:0.6
                                    ))
                                    .position(x:midX,y:midY)
                                }
                            }
                        }

                        ForEach(planningVisibleRecords) { item in
                            if let point = positions[item.id] {
                                planningCanvasNode(item,focused:!hasSelection || focusIds.contains(item.id))
                                    .offset(x:point.x,y:point.y)
                                    .id(item.id)
                            }
                        }
                    }
                    .frame(width:size.width,height:size.height,alignment:.topLeading)
                    .scaleEffect(scale,anchor:.topLeading)
                    .frame(width:size.width * scale,height:size.height * scale,alignment:.topLeading)
                    .padding(12)
                }
                .scrollIndicators(.visible)
                .onChange(of:planningScrollTarget) { target in
                    guard let target else { return }
                    DispatchQueue.main.async {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                            proxy.scrollTo(target,anchor:.center)
                        }
                        planningScrollTarget=nil
                    }
                }
                .onAppear {
                    planningFitScale=scale
                }
                .onChange(of:scale) { newScale in
                    planningFitScale=newScale
                }
                .overlay(alignment:.bottomLeading) {
                    HStack(spacing:7) {
                        if !collapsedPlanningRecordIds.isEmpty {
                            Button("展开全部") {
                                collapsedPlanningRecordIds.removeAll()
                            }
                            .buttonStyle(.plain)
                            .font(.system(size:9,weight:.medium))
                            .accessibilityIdentifier("planning.expand.all")
                            Divider().frame(height:10)
                        }
                        Text(planningFitToView ? "适配宽度 · \(Int(scale * 100))%" : "\(Int(scale * 100))%")
                    }
                    .font(.system(size:9,design:.monospaced))
                    .foregroundStyle(ForgePalette.secondary.opacity(0.86))
                    .padding(.horizontal,10).padding(.vertical,6)
                    .background(.thinMaterial,in:Capsule())
                    .padding(10)
                }
            }
        }
    }

    private func planningCanvasScale(viewport:CGSize,content:CGSize) -> CGFloat {
        guard planningFitToView else { return planningZoom }
        let width=max(1,viewport.width - 28)
        let fit=width / max(1,content.width)
        return min(1,max(0.72,fit))
    }

    private var planningChildrenByParent: [String:[ForgeRecord]] {
        var result:[String:[ForgeRecord]] = [:]
        for item in model.records {
            guard let parent=planningParent(of:item) else { continue }
            result[parent.id,default:[]].append(item)
        }
        return result
    }

    private var planningUnlinkedRecords: [ForgeRecord] {
        let children=planningChildrenByParent
        return model.records.filter {
            planningParent(of:$0) == nil && (children[$0.id] ?? []).isEmpty
        }
    }

    private var planningGraphRecords: [ForgeRecord] {
        guard !planningShowUnlinked else { return model.records }
        let children=planningChildrenByParent
        return model.records.filter {
            planningParent(of:$0) != nil || !(children[$0.id] ?? []).isEmpty
        }
    }

    private var planningVisibleRecords: [ForgeRecord] {
        let children=planningChildrenByParent
        let graphRecords=planningGraphRecords
        let graphIds=Set(graphRecords.map(\.id))
        var result:[ForgeRecord]=[]
        var visited=Set<String>()

        func append(_ item:ForgeRecord) {
            guard graphIds.contains(item.id),visited.insert(item.id).inserted else { return }
            result.append(item)
            guard !collapsedPlanningRecordIds.contains(item.id) else { return }
            for child in children[item.id] ?? [] where graphIds.contains(child.id) {
                append(child)
            }
        }

        for root in graphRecords where planningParent(of:root) == nil {
            append(root)
        }
        return result
    }

    private var planningCanvasPositions: [String:CGPoint] {
        let children=planningChildrenByParent
        let visible=planningVisibleRecords
        let visibleIds=Set(visible.map(\.id))
        let rowStep=planningNodeHeight + planningRowGap
        let columnStep=planningNodeWidth + planningColumnGap
        var positions:[String:CGPoint] = [:]
        var placed=Set<String>()
        var visiting=Set<String>()
        var nextLeaf:CGFloat=0

        func place(_ item:ForgeRecord,depth:Int) -> CGFloat {
            if let existing=positions[item.id] {
                return existing.y + planningNodeHeight / 2
            }
            if visiting.contains(item.id) {
                let center=planningLaneHeaderHeight + nextLeaf * rowStep + planningNodeHeight / 2
                nextLeaf += 1
                positions[item.id]=CGPoint(x:CGFloat(depth) * columnStep,y:center - planningNodeHeight / 2)
                placed.insert(item.id)
                return center
            }

            visiting.insert(item.id)
            let childItems=(children[item.id] ?? []).filter {
                visibleIds.contains($0.id) && !placed.contains($0.id)
            }
            let center:CGFloat
            if childItems.isEmpty {
                center=planningLaneHeaderHeight + nextLeaf * rowStep + planningNodeHeight / 2
                nextLeaf += 1
            } else {
                let centers=childItems.map { place($0,depth:depth + 1) }
                center=((centers.first ?? 0) + (centers.last ?? 0)) / 2
            }
            visiting.remove(item.id)
            if !placed.contains(item.id) {
                positions[item.id]=CGPoint(x:CGFloat(depth) * columnStep,y:center - planningNodeHeight / 2)
                placed.insert(item.id)
            }
            return positions[item.id]!.y + planningNodeHeight / 2
        }

        let roots=visible.filter { planningParent(of:$0) == nil }
        for root in roots where !placed.contains(root.id) {
            _=place(root,depth:0)
            nextLeaf += 0.35
        }
        for item in visible where !placed.contains(item.id) {
            _=place(item,depth:0)
            nextLeaf += 0.35
        }
        return positions
    }

    private var planningCanvasSize: CGSize {
        let positions=planningCanvasPositions
        let maxX=positions.values.map(\.x).max() ?? 0
        let maxY=positions.values.map(\.y).max() ?? 0
        return CGSize(
            width:max(380,maxX + planningNodeWidth),
            height:max(300,maxY + planningNodeHeight)
        )
    }

    private var planningFocusIds: Set<String> {
        guard let selectedId=model.selectedRecord,
              let selected=model.records.first(where:{ $0.id == selectedId }) else {
            return Set(model.records.map(\.id))
        }
        let children=planningChildrenByParent
        var result:Set<String>=[selected.id]

        var cursor:ForgeRecord?=selected
        var ancestorGuard=Set<String>()
        while let current=cursor,
              ancestorGuard.insert(current.id).inserted,
              let parent=planningParent(of:current) {
            result.insert(parent.id)
            cursor=parent
        }

        var stack=children[selected.id] ?? []
        while let child=stack.popLast() {
            guard result.insert(child.id).inserted else { continue }
            stack.append(contentsOf:children[child.id] ?? [])
        }
        return result
    }

    private func planningParent(of item:ForgeRecord) -> ForgeRecord? {
        guard item.kind == .plan else { return nil }
        if let parentId = item.parentPlanId,!parentId.isEmpty {
            return model.records.first { $0.kind == .plan && $0.recordId == parentId }
        }
        if let requirementId = item.requirementId,!requirementId.isEmpty {
            return model.records.first { $0.kind == .requirement && $0.recordId == requirementId }
        }
        return nil
    }

    private var planningExecutionFocusRecord: ForgeRecord? {
        let activeStates:Set<String>=["running","paused","blocked","failed"]
        for item in model.records where item.kind == .plan {
            guard let status=planningExecutionStatus(item),
                  activeStates.contains(status.runStatus ?? "") else { continue }
            return item
        }
        for item in model.records where item.kind == .requirement {
            guard let status=model.planningAutopilotStatuses[item.recordId] else { continue }
            if status.requiresReapproval || activeStates.contains(status.runStatus ?? "") {
                return item
            }
        }
        return nil
    }

    private func planningExecutionStatus(_ item:ForgeRecord) -> AutopilotStatusDetail? {
        let requirementId = item.kind == .requirement ? item.recordId : item.requirementId
        guard let requirementId,
              let status=model.planningAutopilotStatuses[requirementId] else { return nil }
        if item.kind == .plan {
            guard status.currentPlanId == item.recordId,
                  ["running","paused","blocked","failed"].contains(status.runStatus ?? "") else { return nil }
        } else if !status.authorized && status.runStatus == nil && !status.requiresReapproval {
            return nil
        }
        return status
    }

    private func planningExecutionLabel(_ item:ForgeRecord,_ status:AutopilotStatusDetail) -> String {
        if status.requiresReapproval { return "需重新批准" }
        if item.kind == .plan,
           status.runStatus == "paused",
           status.stopReason == "human_checkpoint:\(item.recordId)" {
            return "等待确认"
        }
        if item.kind == .requirement,
           status.runStatus == "paused",
           status.stopReason?.hasPrefix("human_checkpoint:") == true {
            return "等待确认"
        }
        switch status.runStatus {
        case "running": return status.runtimeActive ? (item.kind == .plan ? "当前执行" : "执行中") : "运行未激活"
        case "paused": return item.kind == .plan ? "当前暂停" : "已暂停"
        case "blocked": return item.kind == .plan ? "当前受阻" : "受阻"
        case "failed": return item.kind == .plan ? "当前失败" : "失败"
        case "completed": return "已完成"
        case "cancelled": return "已取消"
        default: return status.authorized ? "已批准" : "未授权"
        }
    }

    private func planningExecutionColor(_ status:AutopilotStatusDetail) -> Color {
        if status.requiresReapproval { return .orange }
        switch status.runStatus {
        case "running": return status.runtimeActive ? .green : .orange
        case "paused","blocked","failed": return .orange
        case "completed": return .green
        default: return status.authorized ? ForgePalette.accent : ForgePalette.secondary
        }
    }

    private func planningExecutionHelp(_ item:ForgeRecord,_ status:AutopilotStatusDetail) -> String {
        var parts=[planningExecutionLabel(item,status)]
        if let summary=status.lastSummary,!summary.isEmpty { parts.append(summary) }
        if let reason=status.stopReason,!reason.isEmpty { parts.append(reason) }
        return parts.joined(separator:" · ")
    }

    private func planningCanvasNode(_ item:ForgeRecord,focused:Bool) -> some View {
        let selected = item.id == model.selectedRecord
        let hovered = hoveredPlanningRecordId == item.id
        let children=planningChildrenByParent[item.id] ?? []
        let collapsed=collapsedPlanningRecordIds.contains(item.id)
        let execution=planningExecutionStatus(item)
        let nodeBackground:Color = selected
            ? ForgePalette.selectionStrong
            : (item.kind == .requirement ? ForgePalette.accent.opacity(0.075) : ForgePalette.raisedSurface.opacity(0.78))
        return ZStack(alignment:.bottomTrailing) {
            Button {
                Task { await model.openRecord(item.id) }
            } label: {
                VStack(alignment:.leading,spacing:7) {
                    HStack(spacing:6) {
                        Image(systemName:item.kind == .requirement ? "scope" : "arrow.triangle.branch")
                            .symbolRenderingMode(.hierarchical)
                            .font(.system(size:10.5,weight:.semibold))
                        Text(planningNodeRole(item).uppercased())
                            .font(.system(size:8.5,weight:.bold))
                            .tracking(0.45)
                        if item.kind == .requirement,!item.state.isEmpty {
                            Text(item.state.uppercased())
                                .font(.system(size:7.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength:4)
                        if let execution {
                            HStack(spacing:4) {
                                Circle()
                                    .fill(planningExecutionColor(execution))
                                    .frame(width:5.5,height:5.5)
                                Text(planningExecutionLabel(item,execution))
                                    .font(.system(size:8,weight:.semibold))
                                    .lineLimit(1)
                            }
                            .padding(.horizontal,6).padding(.vertical,3)
                            .background(planningExecutionColor(execution).opacity(0.10),in:Capsule())
                            .help(planningExecutionHelp(item,execution))
                        }
                    }
                    .foregroundStyle(item.kind == .requirement ? ForgePalette.ink : ForgePalette.secondary)

                    Text(item.title)
                        .font(.system(size:11.5,weight:item.kind == .requirement ? .semibold : .medium))
                        .foregroundStyle(ForgePalette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth:.infinity,alignment:.leading)

                    Text(item.recordId)
                        .font(.system(size:8.5,design:.monospaced))
                        .foregroundStyle(ForgePalette.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                .padding(11)
                .frame(width:planningNodeWidth,height:planningNodeHeight,alignment:.topLeading)
                .background(nodeBackground,in:RoundedRectangle(cornerRadius:13,style:.continuous))
                .overlay(alignment:.leading) {
                    Capsule()
                        .fill(item.kind == .requirement ? ForgePalette.accent.opacity(0.72) : ForgePalette.secondary.opacity(0.28))
                        .frame(width:3)
                        .padding(.vertical,12)
                        .padding(.leading,2)
                }
                .contentShape(RoundedRectangle(cornerRadius:13,style:.continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(item.title)
            .accessibilityValue({
                let relation=planningNodeRole(item)
                if let execution {
                    return "\(relation) · \(item.recordId) · \(planningExecutionLabel(item,execution))"
                }
                return "\(relation) · \(item.recordId)"
            }())
            .accessibilityIdentifier("semantic.canvas.\(item.kind.rawValue).\(item.recordId)")

            if !children.isEmpty || hovered || selected {
                HStack(spacing:4) {
                    if !children.isEmpty {
                        Button {
                            if collapsed {
                                collapsedPlanningRecordIds.remove(item.id)
                            } else {
                                collapsedPlanningRecordIds.insert(item.id)
                            }
                        } label: {
                            HStack(spacing:3) {
                                Image(systemName:collapsed ? "chevron.right" : "chevron.down")
                                Text("\(children.count)")
                                    .font(.system(size:8.5,weight:.bold,design:.monospaced))
                            }
                            .font(.system(size:9,weight:.bold))
                            .padding(.horizontal,6)
                            .frame(height:22)
                            .background(.thinMaterial,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                        }
                        .buttonStyle(.plain)
                        .help(collapsed ? "展开 \(children.count) 个直接子节点" : "折叠 \(children.count) 个直接子节点")
                        .accessibilityLabel(collapsed ? "展开分支" : "折叠分支")
                        .accessibilityValue("\(children.count) 个直接子节点")
                        .accessibilityIdentifier("planning.collapse.\(item.recordId)")
                    }

                    if hovered || selected {
                        Button {
                        if item.kind == .requirement {
                            beginPlan(requirementId:item.recordId,parentPlanId:nil)
                        } else {
                            beginPlan(requirementId:item.requirementId,parentPlanId:item.recordId)
                        }
                    } label: {
                        Image(systemName:"plus")
                            .font(.system(size:9.5,weight:.bold))
                            .frame(width:24,height:22)
                            .background(.thinMaterial,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                    }
                    .buttonStyle(.plain)
                    .help(item.kind == .requirement ? "添加根 Plan" : "细化子 Plan")

                    Button {
                        if item.kind == .requirement {
                            model.newThreadForRequirement(item.recordId)
                        } else {
                            model.newThread(requirementId:item.requirementId,planId:item.recordId)
                        }
                    } label: {
                        Image(systemName:"bubble.left")
                            .font(.system(size:9.5,weight:.semibold))
                            .frame(width:24,height:22)
                            .background(.thinMaterial,in:RoundedRectangle(cornerRadius:7,style:.continuous))
                    }
                        .buttonStyle(.plain)
                        .help(model.zenRefinementActive ? "自动精化进行中，请先按 Esc 停止" : "以此节点新建会话")
                        .disabled(model.busy || model.zenRefinementActive)
                    }
                }
                .padding(7)
                .transition(reduceMotion ? .identity : .opacity)
            }
        }
        .opacity(focused ? 1 : 0.52)
        .onHover { inside in
            if inside { hoveredPlanningRecordId=item.id }
            else if hoveredPlanningRecordId == item.id { hoveredPlanningRecordId=nil }
        }
        .animation(reduceMotion ? nil : .easeOut(duration:0.12),value:hovered)
        .animation(reduceMotion ? nil : .easeOut(duration:0.16),value:focused)
        .accessibilityElement(children:.contain)
    }

    private func beginRequirement() {
        draftTitle = ""
        draftOutcome = ""
        draftCriteria = ""
        authoring = PlanningAuthoringContext(kind:.requirement,requirementId:nil,parentPlanId:nil)
    }

    private func beginPlan(requirementId:String?,parentPlanId:String?) {
        draftTitle = ""
        draftOutcome = ""
        draftCriteria = ""
        authoring = PlanningAuthoringContext(kind:.plan,requirementId:requirementId,parentPlanId:parentPlanId)
    }

    @ViewBuilder
    private func planningAuthoringSheet(_ context: PlanningAuthoringContext) -> some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                Text(authoringTitle(context)).font(.system(size:18,weight:.semibold))
                Spacer()
                Button { authoring = nil } label: { Image(systemName:"xmark") }
                    .buttonStyle(.plain).disabled(saving)
            }

            if context.kind == .requirement {
                VStack(alignment:.leading,spacing:6) {
                    Text("标题").font(.system(size:11,weight:.medium))
                    TextField("例如：实现无人值守规划",text:$draftTitle)
                        .textFieldStyle(.roundedBorder)
                }
            }

            VStack(alignment:.leading,spacing:6) {
                Text("目标")
                    .font(.system(size:11,weight:.medium))
                TextEditor(text:$draftOutcome)
                    .accessibilityLabel("目标")
                    .accessibilityIdentifier("planning.authoring.goal")
                    .font(.system(size:12))
                    .frame(height:92)
                    .padding(6)
                    .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
            }

            if context.kind == .requirement {
                VStack(alignment:.leading,spacing:6) {
                    Text("验收标准（每行一条，可选）").font(.system(size:11,weight:.medium))
                    TextEditor(text:$draftCriteria)
                        .font(.system(size:12))
                        .frame(height:82)
                        .padding(6)
                        .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:9,style:.continuous))
                }
            }

            HStack {
                Text("只创建需求和计划，不会开始执行。")
                    .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                Spacer()
                Button("取消") { authoring = nil }.disabled(saving)
                Button(saving ? "创建中…" : "创建") { submitAuthoring(context) }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving || draftOutcome.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ||
                              (context.kind == .requirement && draftTitle.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
            }
        }
        .padding(20)
        .frame(width:460)
        .interactiveDismissDisabled(saving)
    }

    private func authoringTitle(_ context: PlanningAuthoringContext) -> String {
        if context.kind == .requirement { return "新建需求" }
        if context.parentPlanId != nil { return "细化子计划" }
        if context.requirementId != nil { return "新建根计划" }
        return "新建计划"
    }

    private func submitAuthoring(_ context: PlanningAuthoringContext) {
        guard !saving else { return }
        saving = true
        Task {
            let created: String?
            switch context.kind {
            case .requirement:
                created = await model.createRequirement(
                    title:draftTitle,
                    outcome:draftOutcome,
                    acceptanceCriteria:draftCriteria.components(separatedBy:.newlines)
                )
            case .plan:
                created = await model.createPlan(
                    objective:draftOutcome,
                    requirementId:context.requirementId,
                    parentPlanId:context.parentPlanId
                )
            }
            saving = false
            if created != nil { authoring = nil }
        }
    }

    @ViewBuilder
    private func autopilotSection(_ requirement:RequirementRecordDetail) -> some View {
        semanticSection("无人值守") {
            VStack(alignment:.leading,spacing:11) {
                let status=model.planningAutopilotStatuses[requirement.requirementId]
                HStack(spacing:8) {
                    Circle()
                        .fill(autopilotStatusColor(status))
                        .frame(width:7,height:7)
                    Text(autopilotStatusLabel(status))
                        .font(.system(size:12,weight:.semibold))
                    if let status,
                       let approved=status.approvedRevision {
                        Text("批准版本 r\(approved)")
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer()
                    if model.autopilotLoading { ProgressView().controlSize(.small) }
                }

                if let status {
                    if status.requiresReapproval {
                        Label("需求已更新，原授权失效，请重新批准。",systemImage:"exclamationmark.triangle.fill")
                            .font(.system(size:10.5)).foregroundStyle(.orange)
                    }
                    HStack(spacing:14) {
                        autopilotMetric("Token","\(status.totalTokens) / \(status.maxTotalTokens.map(String.init) ?? "—")")
                        autopilotMetric("轮次","\(status.turns) / \(status.maxTurns.map(String.init) ?? "—")")
                        autopilotMetric("工具调用","\(status.toolCalls) / \(status.maxToolCalls.map(String.init) ?? "—")")
                        if let modelName=status.model { autopilotMetric("模型",modelName) }
                    }
                    if let currentPlanId=status.currentPlanId,!currentPlanId.isEmpty {
                        HStack(spacing:7) {
                            Image(systemName:"location.fill")
                                .font(.system(size:9))
                                .foregroundStyle(ForgePalette.accent)
                            Text("当前计划")
                                .font(.system(size:9.5,weight:.medium))
                                .foregroundStyle(ForgePalette.secondary)
                            Text(model.records.first(where:{ $0.kind == .plan && $0.recordId == currentPlanId })?.title ?? currentPlanId)
                                .font(.system(size:9.5))
                                .textSelection(.enabled)
                            Spacer()
                            if let plan=model.records.first(where:{ $0.kind == .plan && $0.recordId == currentPlanId }) {
                                Button("定位") { locatePlanningRecord(plan) }
                                    .buttonStyle(.plain)
                                    .font(.system(size:9.5,weight:.medium))
                                    .foregroundStyle(ForgePalette.accent)
                            }
                        }
                    }
                    if let summary=status.lastSummary,!summary.isEmpty {
                        Text(summary)
                            .font(.system(size:10.5))
                            .foregroundStyle(ForgePalette.ink)
                            .textSelection(.enabled)
                    }
                    if let reason=status.stopReason,!reason.isEmpty {
                        Text(reason)
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(ForgePalette.secondary)
                            .textSelection(.enabled)
                    }
                    if let processId=status.pendingProcessId {
                        HStack(spacing:6) {
                            Label("等待 Process 终态回执",systemImage:"hourglass")
                                .font(.system(size:9.5)).foregroundStyle(.orange)
                            Text(processId).font(.system(size:9,design:.monospaced))
                                .foregroundStyle(ForgePalette.secondary).textSelection(.enabled)
                        }
                    }
                    if let requestId=status.pendingCommandRequestId {
                        HStack(spacing:6) {
                            Text(status.pendingProcessId == nil ? "命令受理结果待核对" : "原始请求 ID")
                                .font(.system(size:9.5)).foregroundStyle(.orange)
                            Text(requestId).font(.system(size:9,design:.monospaced))
                                .foregroundStyle(ForgePalette.secondary).textSelection(.enabled)
                        }
                    }
                    if let recoverySummary=status.pendingProcessRecoverySummary {
                        Text(recoverySummary)
                            .font(.system(size:9.5)).foregroundStyle(ForgePalette.secondary)
                    }
                    if !status.providerReady {
                        Text("模型服务未就绪，连接恢复后才能执行。")
                            .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    }
                } else {
                    Text("执行状态尚未确认，请先刷新后再批准或启动。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                }

                if model.autopilotOutcomeUnknown(for:requirement.requirementId) {
                    Text("操作结果未确认。请先刷新执行状态，不要重复提交。")
                        .font(.system(size:10.5)).foregroundStyle(.orange)
                }
                HStack(spacing:8) {
                    let outcomeUnknown=model.autopilotOutcomeUnknown(for:requirement.requirementId)
                    let operation=status?.nextExecutionOperation(outcomeUnknown:outcomeUnknown)
                    if operation == "authorize" {
                        Button(status?.needsBudgetRenewal == true && status?.requiresReapproval == false
                               ? "续期预算" : (status?.requiresReapproval == true ? "重新配置并批准" : "配置并批准")) {
                            beginAutopilotApproval(requirement)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(autopilotSaving || model.autopilotLoading || model.autopilotControlPending)
                    } else if operation == "accept_checkpoint",let status {
                        Button("验收检查点") {
                            checkpointReview=AutopilotCheckpointReview(
                                model:model,requirementId:requirement.requirementId,status:status
                            )
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(autopilotSaving || model.autopilotLoading || model.autopilotControlPending)
                    } else if let operation {
                        Button(operation == "pause" ? "暂停" :
                               operation == "resume" ? (status?.hasPendingProcessRecovery == true ? "核对并恢复" : (status?.runStatus == "running" ? "恢复执行" : "继续")) :
                               status?.runStatus == "completed" ? "再次运行" : "开始无人值守") {
                            runAutopilotAction(requirement.requirementId,operation)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(autopilotSaving || model.autopilotLoading || model.autopilotControlPending)
                    }
                    if status?.authorized == true {
                        Button("重新配置") { beginAutopilotApproval(requirement) }
                            .buttonStyle(.forgeText)
                            .disabled(autopilotSaving || model.autopilotLoading || model.autopilotControlPending
                                      || outcomeUnknown || status?.hasPendingProcessRecovery == true)
                        Button("撤销授权",role:.destructive) {
                            runAutopilotAction(requirement.requirementId,"revoke")
                        }
                        .buttonStyle(.forgeText)
                        .disabled(autopilotSaving || model.autopilotLoading || model.autopilotControlPending
                                  || outcomeUnknown || status?.hasPendingProcessRecovery == true)
                    }
                    Button { Task { await model.loadAutopilotStatus(requirement.requirementId) } } label: {
                        Image(systemName:"arrow.clockwise")
                    }
                    .buttonStyle(.plain)
                    .disabled(model.autopilotLoading)
                }
                Text("批准不会立即运行；仅限当前工作区，不会推送、发布、部署、切换环境或执行破坏性操作。")
                    .font(.system(size:9.5)).foregroundStyle(ForgePalette.secondary)
            }
        }
    }

    private func autopilotMetric(_ label:String,_ value:String) -> some View {
        VStack(alignment:.leading,spacing:2) {
            Text(label).font(.system(size:9)).foregroundStyle(ForgePalette.secondary)
            Text(value).font(.system(size:10.5,weight:.medium,design:.monospaced)).lineLimit(1)
        }
    }

    private func autopilotStatusLabel(_ status:AutopilotStatusDetail?) -> String {
        guard let status else { return "未授权" }
        if status.requiresReapproval { return "需要重新批准" }
        if status.runStatus == "paused",status.stopReason?.hasPrefix("human_checkpoint:") == true { return "等待确认" }
        switch status.runStatus {
        case "running": return status.runtimeActive ? "执行中" : "运行未激活"
        case "paused": return "已暂停"
        case "blocked": return "受阻"
        case "failed": return "失败"
        case "completed": return "已完成"
        case "cancelled": return "已取消"
        default: return status.authorized ? "已批准，未启动" : "未授权"
        }
    }

    private func autopilotStatusColor(_ status:AutopilotStatusDetail?) -> Color {
        guard let status else { return ForgePalette.secondary }
        if status.requiresReapproval || status.runStatus == "failed" || status.runStatus == "blocked" { return .orange }
        if status.runStatus == "running" && status.runtimeActive { return .green }
        if status.authorized { return ForgePalette.ink }
        return ForgePalette.secondary
    }

    private func beginAutopilotApproval(_ requirement:RequirementRecordDetail) {
        guard !model.autopilotOutcomeUnknown(for:requirement.requirementId) else {
            model.error="操作结果未确认（\(requirement.requirementId)）。请先刷新执行状态，不要重复提交。"
            return
        }
        guard let status=model.planningAutopilotStatuses[requirement.requirementId],
              status.requirementRevision == requirement.revision else {
            model.error="执行状态尚未通过当前 Requirement 修订的有效读回确认，请先刷新。"
            return
        }
        guard !status.hasPendingProcessRecovery else {
            model.error=status.pendingProcessRecoverySummary ?? "原命令结果尚未确认，暂不可重新批准或启动新的执行。"
            return
        }
        guard let repoId=model.repoId,let checkoutId=model.checkoutId else {
            model.error="请先选择有效的项目和 Checkout。"
            return
        }
        autopilotModel=status.model ?? "deepseek-chat"
        autopilotTokenBudget=status.maxTotalTokens.map(String.init) ?? "50000"
        autopilotTurnBudget=status.maxTurns.map(String.init) ?? "12"
        autopilotToolBudget=status.maxToolCalls.map(String.init) ?? "32"
        autopilotCheckpoints=Set(status.checkpointPlanIds)
        autopilotApproval=AutopilotApprovalContext(
            repoId:repoId,checkoutId:checkoutId,requirement:requirement,status:status
        )
    }

    @ViewBuilder
    private func autopilotApprovalSheet(_ context:AutopilotApprovalContext) -> some View {
        let contextCurrent=model.repoId == context.repoId && model.checkoutId == context.checkoutId
        let statusIsCurrent=autopilotApprovalStatusIsCurrent(context)
        let outcomeUnknown=model.autopilotOutcomeUnknown(for:context.requirement.requirementId)
        let budgetRenewal=context.status?.needsBudgetRenewal == true && context.status?.requiresReapproval == false
        VStack(alignment:.leading,spacing:16) {
            HStack {
                VStack(alignment:.leading,spacing:4) {
                    Text(budgetRenewal ? "续期执行预算" : "批准无人值守执行")
                        .font(.system(size:18,weight:.semibold))
                    Text(context.requirement.title).lineLimit(2)
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    Text("版本 r\(context.requirement.revision)")
                        .font(.system(size:9.5,design:.monospaced)).foregroundStyle(ForgePalette.secondary)
                }
                Spacer()
                Button { autopilotApproval=nil } label:{ Image(systemName:"xmark") }
                    .buttonStyle(.plain).disabled(autopilotSaving)
            }
            Text(budgetRenewal
                 ? "延续当前模型和人工检查点，按确认的上限开启新预算窗口；累计使用量仍保留。"
                 : "需求更新后，原授权失效，需重新批准。")
                .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
            if !contextCurrent {
                Text("工作区已变更，请重新打开批准面板。")
                    .font(.system(size:11)).foregroundStyle(.orange)
            }
            if outcomeUnknown {
                Text("操作结果未确认。请先刷新执行状态，不要重复提交。")
                    .font(.system(size:11)).foregroundStyle(.orange)
            }
            if !statusIsCurrent {
                Text("执行状态已变化，请关闭面板并刷新后重新批准。")
                    .font(.system(size:11)).foregroundStyle(.orange)
            }
            Grid(alignment:.leading,horizontalSpacing:12,verticalSpacing:10) {
                GridRow {
                    Text("模型")
                    TextField("deepseek-chat",text:$autopilotModel)
                        .textFieldStyle(.roundedBorder).disabled(budgetRenewal)
                }
                GridRow { Text("Token 上限"); TextField("50000",text:$autopilotTokenBudget).textFieldStyle(.roundedBorder) }
                GridRow { Text("最大轮次"); TextField("12",text:$autopilotTurnBudget).textFieldStyle(.roundedBorder) }
                GridRow { Text("最大工具调用"); TextField("32",text:$autopilotToolBudget).textFieldStyle(.roundedBorder) }
            }
            .font(.system(size:11))

            let plans=model.records.filter { $0.kind == .plan && $0.requirementId == context.requirement.requirementId }
            if !plans.isEmpty {
                VStack(alignment:.leading,spacing:7) {
                    Text("人工确认点").font(.system(size:11,weight:.semibold))
                    Text("到达所选计划检查点后会暂停，等待你确认。")
                        .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                    ScrollView {
                        VStack(alignment:.leading,spacing:5) {
                            ForEach(plans) { plan in
                                Toggle(isOn:Binding(
                                    get:{ autopilotCheckpoints.contains(plan.recordId) },
                                    set:{ enabled in
                                        if enabled { autopilotCheckpoints.insert(plan.recordId) }
                                        else { autopilotCheckpoints.remove(plan.recordId) }
                                    }
                                )) {
                                    Text(plan.title).font(.system(size:11)).lineLimit(1)
                                }
                                .toggleStyle(.checkbox)
                                .disabled(budgetRenewal)
                            }
                        }
                    }
                    .frame(maxHeight:130)
                }
            }
            HStack {
                Text("仅允许修改当前工作区；不会自动推送、发布或部署。")
                    .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                Spacer()
                Button("取消") { autopilotApproval=nil }.disabled(autopilotSaving)
                Button(autopilotSaving ? "处理中…" : (budgetRenewal ? "续期预算" : "批准")) {
                    submitAutopilotApproval(context)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!contextCurrent || !statusIsCurrent || outcomeUnknown || autopilotSaving || !approvalBudgetsValid(context)
                          || autopilotModel.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20).frame(width:520)
        .interactiveDismissDisabled(autopilotSaving)
    }

    private func parsedAutopilotBudgets() -> (Int,Int,Int)? {
        guard let tokens=Int(autopilotTokenBudget),tokens >= 1000,tokens <= 500000,
              let turns=Int(autopilotTurnBudget),turns >= 1,turns <= 48,
              let tools=Int(autopilotToolBudget),tools >= 1,tools <= 128 else { return nil }
        return (tokens,turns,tools)
    }

    private func approvalBudgetsValid(_ context:AutopilotApprovalContext) -> Bool {
        guard let budgets=parsedAutopilotBudgets() else { return false }
        guard let prior=context.status,prior.needsBudgetRenewal,!prior.requiresReapproval else { return true }
        guard let tokens=prior.maxTotalTokens,let turns=prior.maxTurns,let tools=prior.maxToolCalls else {
            return false
        }
        return budgets.0 >= tokens && budgets.1 >= turns && budgets.2 >= tools
            && autopilotModel == prior.model && autopilotCheckpoints == Set(prior.checkpointPlanIds)
    }

    private func autopilotApprovalStatusIsCurrent(_ context:AutopilotApprovalContext) -> Bool {
        guard let snapshot=context.status,
              let latest=model.planningAutopilotStatuses[context.requirement.requirementId] else { return false }
        return snapshot.requirementRevision == latest.requirementRevision
            && snapshot.runId == latest.runId && snapshot.runStatus == latest.runStatus
            && snapshot.authorized == latest.authorized && snapshot.requiresReapproval == latest.requiresReapproval
            && snapshot.pendingProcessId == latest.pendingProcessId
            && snapshot.pendingCommandRequestId == latest.pendingCommandRequestId
            && snapshot.maxTotalTokens == latest.maxTotalTokens && snapshot.maxTurns == latest.maxTurns
            && snapshot.maxToolCalls == latest.maxToolCalls && snapshot.checkpointPlanIds == latest.checkpointPlanIds
    }

    private func submitAutopilotApproval(_ context:AutopilotApprovalContext) {
        guard !model.autopilotOutcomeUnknown(for:context.requirement.requirementId) else {
            model.error="操作结果未确认（\(context.requirement.requirementId)）。请先刷新执行状态，不要重复提交。"
            return
        }
        guard autopilotApprovalStatusIsCurrent(context) else {
            model.error="执行状态已变化，请刷新后重新批准。"
            return
        }
        guard model.repoId == context.repoId,model.checkoutId == context.checkoutId else {
            model.error="工作区已变更，请重新打开批准面板。"
            return
        }
        guard approvalBudgetsValid(context),let budgets=parsedAutopilotBudgets(),
              !autopilotSaving else { return }
        autopilotSaving=true
        Task {
            let ok=await model.controlAutopilot(
                requirementId:context.requirement.requirementId,
                operation:"authorize",confirmAuthorization:true,
                expectedRequirementRevision:context.requirement.revision,
                model:autopilotModel.trimmingCharacters(in:.whitespacesAndNewlines),
                maxTotalTokens:budgets.0,maxTurns:budgets.1,maxToolCalls:budgets.2,
                checkpointPlanIds:Array(autopilotCheckpoints).sorted()
            )
            autopilotSaving=false
            if ok { autopilotApproval=nil }
        }
    }

    private func runAutopilotAction(_ requirementId:String,_ operation:String) {
        guard !autopilotSaving else { return }
        autopilotSaving=true
        Task {
            _=await model.controlAutopilot(requirementId:requirementId,operation:operation)
            autopilotSaving=false
        }
    }

    @ViewBuilder
    private func semanticRecordDetail(_ detail: SemanticRecordDetail) -> some View {
        switch detail {
        case .requirement(let requirement):
            VStack(alignment:.leading,spacing:16) {
                HStack(spacing:9) {
                    Button {
                        model.bindCurrentThreadPlanningContext(
                            requirementId:requirement.requirementId,
                            planId:nil,
                            projectId:model.selectedProjectId,
                            repoId:model.projectRepositoryId
                        )
                        if model.error == nil { model.show(.agent) }
                    } label: {
                        Label("在当前会话中继续",systemImage:"arrow.turn.down.right")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.thread == nil)
                    .help("将此需求关联到当前会话，不会修改需求内容。")
                    .accessibilityIdentifier("planning.requirement.use-current")

                    Button {
                        model.newThreadForRequirement(requirement.requirementId)
                    } label: {
                        Label("新建会话",systemImage:"plus.bubble")
                    }
                    .buttonStyle(.forgeText)
                    .disabled(model.busy)

                    Menu {
                        Button {
                            beginPlan(requirementId:requirement.requirementId,parentPlanId:nil)
                        } label: {
                            Label("添加根计划",systemImage:"plus")
                        }
                    } label: {
                        Image(systemName:"ellipsis")
                            .frame(width:24,height:24)
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                    .fixedSize()
                }

                semanticSection("目标") {
                    Text(requirement.outcomeStatement.isEmpty ? "尚未填写目标。" : requirement.outcomeStatement)
                        .font(.system(size:13,weight:.medium))
                        .lineSpacing(4)
                        .textSelection(.enabled)
                }

                if !requirement.progressSummary.isEmpty {
                    semanticSection("当前进度") {
                        Text(requirement.progressSummary)
                            .font(.system(size:12.5))
                            .lineSpacing(4)
                            .textSelection(.enabled)
                    }
                }

                if !requirement.remainingWork.isEmpty {
                    semanticSection("下一步") {
                        VStack(alignment:.leading,spacing:8) {
                            ForEach(Array(requirement.remainingWork.enumerated()),id:\.offset) { index, value in
                                HStack(alignment:.top,spacing:9) {
                                    Text("\(index + 1)")
                                        .font(.system(size:9.5,weight:.semibold,design:.rounded))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .frame(width:17,height:17)
                                        .background(ForgePalette.softFill,in:Circle())
                                    Text(value)
                                        .font(.system(size:12))
                                        .lineSpacing(3)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                }

                autopilotSection(requirement)

                if !requirement.acceptanceCriteria.isEmpty {
                    DisclosureGroup {
                        semanticBulletList(requirement.acceptanceCriteria)
                            .padding(.top,8)
                    } label: {
                        HStack {
                            Text("验收标准")
                            Spacer()
                            Text("\(requirement.acceptanceCriteria.count)")
                                .foregroundStyle(.tertiary)
                        }
                        .font(.system(size:11,weight:.semibold))
                        .foregroundStyle(ForgePalette.secondary)
                    }
                    .padding(.vertical,11)
                    .overlay(alignment:.top) {
                        Rectangle().fill(Color.primary.opacity(0.10)).frame(height:1)
                    }
                }

                DisclosureGroup("记录信息") {
                    VStack(alignment:.leading,spacing:6) {
                        Text(requirement.requirementId)
                            .textSelection(.enabled)
                        Text("版本 r\(requirement.revision) · \(requirement.state)")
                    }
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .padding(.top,7)
                }
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
            }

        case .plan(let plan):
            VStack(alignment:.leading,spacing:16) {
                HStack(spacing:9) {
                    Button {
                        model.bindCurrentThreadPlanningContext(
                            requirementId:plan.requirementId,
                            planId:plan.planId,
                            projectId:model.selectedProjectId,
                            repoId:model.projectRepositoryId
                        )
                        if model.error == nil { model.show(.agent) }
                    } label: {
                        Label("在当前会话中继续",systemImage:"arrow.turn.down.right")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.thread == nil)
                    .help("将此计划关联到当前会话，不会修改计划内容。")
                    .accessibilityIdentifier("planning.plan.use-current")

                    Button {
                        model.newThreadForPlan(plan)
                    } label: {
                        Label("新建会话",systemImage:"plus.bubble")
                    }
                    .buttonStyle(.forgeText)
                    .disabled(model.busy)

                    Menu {
                        Button {
                            beginPlan(requirementId:plan.requirementId,parentPlanId:plan.planId)
                        } label: {
                            Label("细化子计划",systemImage:"arrow.turn.down.right")
                        }
                    } label: {
                        Image(systemName:"ellipsis")
                            .frame(width:24,height:24)
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                    .fixedSize()
                }

                semanticSection("目标") {
                    Text(plan.goal.isEmpty ? "未提供目标。" : plan.goal)
                        .font(.system(size:13,weight:.medium))
                        .lineSpacing(4)
                        .textSelection(.enabled)
                }

                if !plan.items.isEmpty {
                    semanticSection("实施顺序") {
                        VStack(alignment:.leading,spacing:10) {
                            ForEach(Array(plan.items.enumerated()),id:\.element.id) { index,item in
                                HStack(alignment:.top,spacing:9) {
                                    Text("\(index + 1)")
                                        .font(.system(size:9.5,weight:.semibold,design:.rounded))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .frame(width:17,height:17)
                                        .background(ForgePalette.softFill,in:Circle())
                                    VStack(alignment:.leading,spacing:3) {
                                        Text(item.objective)
                                            .font(.system(size:12.5))
                                            .lineSpacing(3)
                                        Text(item.id)
                                            .font(.system(size:9,design:.monospaced))
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                        }
                    }
                }

                if plan.parentPlanId != nil || plan.requirementId != nil {
                    semanticSection("关系") {
                        VStack(alignment:.leading,spacing:5) {
                            if let parentPlanId=plan.parentPlanId,!parentPlanId.isEmpty {
                                semanticRelationButton(
                                    title:"上级计划",
                                    id:parentPlanId,
                                    systemImage:"arrow.turn.up.left"
                                ) {
                                    Task { await model.openPlan(parentPlanId) }
                                }
                            }
                            if let requirementId=plan.requirementId,!requirementId.isEmpty {
                                semanticRelationButton(
                                    title:"所属需求",
                                    id:requirementId,
                                    systemImage:"doc.text"
                                ) {
                                    Task { await model.openRequirement(requirementId) }
                                }
                            }
                        }
                    }
                }

                if !plan.resolvedDecisions.isEmpty || !plan.nonGoals.isEmpty {
                    DisclosureGroup("决策与边界") {
                        VStack(alignment:.leading,spacing:13) {
                            if !plan.resolvedDecisions.isEmpty {
                                VStack(alignment:.leading,spacing:7) {
                                    Text("已确认决策")
                                        .font(.system(size:10.5,weight:.semibold))
                                        .foregroundStyle(ForgePalette.secondary)
                                    semanticBulletList(plan.resolvedDecisions)
                                }
                            }
                            if !plan.nonGoals.isEmpty {
                                VStack(alignment:.leading,spacing:7) {
                                    Text("不做")
                                        .font(.system(size:10.5,weight:.semibold))
                                        .foregroundStyle(ForgePalette.secondary)
                                    semanticBulletList(plan.nonGoals)
                                }
                            }
                        }
                        .padding(.top,9)
                    }
                    .font(.system(size:11,weight:.semibold))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.vertical,11)
                    .overlay(alignment:.top) {
                        Rectangle().fill(Color.primary.opacity(0.10)).frame(height:1)
                    }
                }

                DisclosureGroup("记录信息") {
                    VStack(alignment:.leading,spacing:6) {
                        Text(plan.planId).textSelection(.enabled)
                        Text("revision \(plan.revision)")
                        if let source=plan.sourceBasisRevision,!source.isEmpty {
                            Text("source \(source)").textSelection(.enabled)
                        }
                    }
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .padding(.top,7)
                }
                .font(.system(size:10.5,weight:.medium))
                .foregroundStyle(ForgePalette.secondary)
            }
        }
    }

    private func semanticRelationButton(
        title:String,
        id:String,
        systemImage:String,
        action:@escaping () -> Void
    ) -> some View {
        Button(action:action) {
            HStack(spacing:7) {
                Image(systemName:systemImage)
                    .font(.system(size:9.5))
                    .foregroundStyle(ForgePalette.secondary)
                    .frame(width:16)
                Text(title)
                    .font(.system(size:11,weight:.medium))
                Text(id)
                    .font(.system(size:9.5,design:.monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength:0)
                Image(systemName:"chevron.right")
                    .font(.system(size:8.5,weight:.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(height:29)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func semanticSection<Content:View>(_ title:String,@ViewBuilder content:() -> Content) -> some View {
        VStack(alignment:.leading,spacing:9) {
            Text(title).font(.system(size:11,weight:.semibold)).foregroundStyle(ForgePalette.secondary)
            content()
        }
        .padding(.vertical,12)
        .frame(maxWidth:.infinity,alignment:.leading)
        .overlay(alignment:.top) {
            Rectangle()
                .fill(Color.primary.opacity(0.10))
                .frame(height:1)
        }
    }

    private func semanticBulletList(_ values:[String]) -> some View {
        VStack(alignment:.leading,spacing:7) {
            ForEach(Array(values.enumerated()),id:\.offset) { _, value in
                HStack(alignment:.top,spacing:8) {
                    Circle().frame(width:4,height:4).padding(.top,6)
                    Text(value).font(.system(size:12)).lineSpacing(3).textSelection(.enabled)
                }
            }
        }
    }
}

struct SchedulePane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var expandedIds: Set<String> = []
    @State private var pendingAction: (item: ProjectScheduleDetail, action: ProjectScheduleAction)?

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                if let error = model.error, model.repoId != nil {
                    HStack(alignment:.firstTextBaseline,spacing:9) {
                        Image(systemName:"exclamationmark.circle")
                        Text(error).font(.system(size:11.5)).textSelection(.enabled)
                        Spacer(minLength:8)
                        Button("重试") { Task { await model.loadSchedulePage() } }
                            .buttonStyle(.plain)
                            .disabled(model.schedulesLoading)
                            .accessibilityIdentifier("schedule.retry")
                    }
                    .foregroundStyle(.orange)
                    .padding(.vertical,8)
                    .accessibilityIdentifier("schedule.error")
                }
                if model.repoId == nil {
                    emptyState("先选择项目","选择项目以查看计划任务。")
                } else if model.schedulesLoading && model.schedules.isEmpty {
                    ProgressView("正在读取计划任务…").controlSize(.small)
                } else if model.schedules.isEmpty && model.error == nil {
                    emptyState("暂无计划任务","当前项目尚未配置定时或条件触发任务。")
                } else if !model.schedules.isEmpty {
                    VStack(alignment:.leading,spacing:0) {
                        ForEach(Array(model.schedules.enumerated()),id:\.element.id) { index,item in
                            scheduleRow(item)
                            
                        }
                    }
                }
            }
            .padding(26)
            .frame(maxWidth:960,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.center)
        }
        .confirmationDialog("立即运行任务？",isPresented:Binding(
            get:{ pendingAction != nil },
            set:{ if !$0 { pendingAction = nil } }
        ),titleVisibility:.visible) {
            if let pending = pendingAction {
                Button("立即运行") {
                    let selected = pending
                    pendingAction = nil
                    Task { await model.controlSchedule(selected.item,action:selected.action) }
                }
            }
            Button("取消",role:.cancel) { pendingAction = nil }
        } message: {
            if let pending = pendingAction {
                Text("\(pending.item.name) · \(pending.item.trigger)\n将立即运行此任务。")
            }
        }
    }

    private func scheduleRow(_ item:ProjectScheduleDetail) -> some View {
        VStack(alignment:.leading,spacing:10) {
            HStack(alignment:.top,spacing:10) {
                Button {
                    if !expandedIds.insert(item.id).inserted { expandedIds.remove(item.id) }
                } label: {
                    HStack(alignment:.top,spacing:10) {
                        Circle().fill(item.enabled ? Color.green : Color.secondary)
                            .frame(width:7,height:7).padding(.top,6)
                        VStack(alignment:.leading,spacing:5) {
                            HStack(spacing:7) {
                                Text(item.name).font(.system(size:13,weight:.semibold))
                                    .lineLimit(2)
                                if !item.enabled {
                                    Text("已暂停").font(.system(size:10)).foregroundStyle(.secondary)
                                }
                            }
                            Text(item.trigger).font(.system(size:11.5))
                                .foregroundStyle(ForgePalette.secondary)
                                .lineLimit(2)
                            if let next = item.nextEligibleAt {
                                Text("下次 · \(next)").font(.system(size:10))
                                    .foregroundStyle(.tertiary).lineLimit(1)
                            }
                        }
                        Spacer(minLength:6)
                        Image(systemName:expandedIds.contains(item.id) ? "chevron.up" : "chevron.down")
                            .font(.system(size:10,weight:.medium)).foregroundStyle(.secondary)
                            .padding(.top,5)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(item.name)，\(item.enabled ? "已启用" : "已暂停")，\(expandedIds.contains(item.id) ? "收起详情" : "展开详情")")
                .accessibilityIdentifier("schedule.\(item.scheduleId).details")
                Menu {
                    Button(item.enabled ? "暂停" : "恢复") {
                        Task { await model.controlSchedule(item,action:item.enabled ? .pause : .resume) }
                    }
                    Button("立即运行") {
                        pendingAction = (item,.trigger)
                    }
                    .disabled(!item.enabled)
                } label: {
                    Image(systemName:"ellipsis").frame(width:26,height:26)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .disabled(model.schedulesLoading)
                .accessibilityIdentifier("schedule.\(item.scheduleId).actions")
            }
            if expandedIds.contains(item.id) {
                VStack(alignment:.leading,spacing:9) {
                    if let reason = item.pausedReason,!reason.isEmpty {
                        Label(reason,systemImage:"pause.circle")
                            .font(.system(size:11))
                            .foregroundStyle(.orange)
                    }
                    HStack(spacing:18) {
                        if let last = item.lastTriggeredAt {
                            meta("上次运行",last)
                        } else {
                            meta("上次运行","尚无")
                        }
                        if let next = item.nextEligibleAt {
                            meta("下次运行",next)
                        }
                    }
                    DisclosureGroup("技术信息") {
                        VStack(alignment:.leading,spacing:6) {
                            meta("任务 ID",item.scheduleId)
                            meta("执行动作",item.operation)
                            if let updated = item.updatedAt { meta("更新",updated) }
                        }
                        .padding(.top,7)
                    }
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                }
                .padding(.leading,17)
                .accessibilityIdentifier("schedule.\(item.scheduleId).expanded")
            }
        }.padding(.vertical,12)
    }

    private func meta(_ label:String,_ value:String) -> some View {
        Text("\(label) · \(value)")
            .font(.system(size:10.5,design:.monospaced))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal:false,vertical:true)
    }

    private func emptyState(_ title:String,_ detail:String) -> some View {
        VStack(alignment:.leading,spacing:5) {
            Text(title).font(.system(size:13,weight:.medium))
            Text(detail).font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
        }.padding(.vertical,16)
    }
}

struct PluginsPane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var searchOpen = false
    @State private var query = ""
    @State private var expandedIds: Set<String> = []
    @FocusState private var searchFocused: Bool

    private var visiblePlugins: [ProjectPluginDetail] {
        let term = query.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !term.isEmpty else { return model.plugins }
        return model.plugins.filter { item in
            item.displayName.localizedCaseInsensitiveContains(term)
                || item.pluginId.localizedCaseInsensitiveContains(term)
                || (item.provider?.localizedCaseInsensitiveContains(term) == true)
                || item.capabilities.contains(where:{ $0.localizedCaseInsensitiveContains(term) })
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                PluginSettingsSection(model:model)
                Divider()
                HStack {
                    Text("当前项目").font(.system(size:13,weight:.semibold))
                    Spacer()
                    Button {
                        searchOpen.toggle()
                        if !searchOpen { query = "" }
                        else { searchFocused = true }
                    } label: {
                        Image(systemName:searchOpen ? "xmark" : "magnifyingglass")
                            .frame(width:28,height:28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(searchOpen ? "关闭插件搜索" : "搜索插件")
                    .accessibilityIdentifier("plugins.search.toggle")
                }

                if searchOpen {
                    HStack(spacing:7) {
                        Image(systemName:"magnifyingglass")
                            .foregroundStyle(ForgePalette.secondary)
                        TextField("搜索名称、服务或能力",text:$query)
                            .textFieldStyle(.plain)
                            .focused($searchFocused)
                            .font(.system(size:12))
                            .accessibilityIdentifier("plugins.search.field")
                        if !query.isEmpty {
                            Button { query = "" } label: {
                                Image(systemName:"xmark.circle.fill")
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("清除插件搜索")
                        }
                    }
                    .padding(.vertical,8)
                    
                }
                if let error = model.error, model.repoId != nil {
                    HStack(alignment:.firstTextBaseline,spacing:9) {
                        Image(systemName:"exclamationmark.circle")
                        Text(error).font(.system(size:11.5)).textSelection(.enabled)
                        Spacer(minLength:8)
                        Button("重试") { Task { await model.loadPluginsPage() } }
                            .buttonStyle(.plain)
                            .disabled(model.pluginsLoading)
                            .accessibilityIdentifier("plugins.retry")
                    }
                    .foregroundStyle(.orange)
                    .padding(.vertical,8)
                    .accessibilityIdentifier("plugins.error")
                }
                if model.repoId == nil {
                    emptyState("先选择项目","选择项目后查看可用插件。")
                } else if model.pluginsLoading && model.plugins.isEmpty {
                    ProgressView("正在读取插件…").controlSize(.small)
                } else if model.plugins.isEmpty && model.error == nil {
                    emptyState("暂无插件","当前项目没有可用插件。")
                } else if !model.plugins.isEmpty {
                    if visiblePlugins.isEmpty {
                        emptyState("无匹配插件","试试其他名称或能力关键词。")
                    } else {
                        VStack(alignment:.leading,spacing:0) {
                            Text("显示 \(visiblePlugins.count) / \(model.plugins.count) 项")
                                .font(.system(size:10)).foregroundStyle(.tertiary)
                                .padding(.bottom,6)
                            ForEach(Array(visiblePlugins.enumerated()),id:\.element.id) { index,item in
                                pluginRow(item)
                                
                            }
                        }
                    }
                }
            }
            .padding(26)
            .frame(maxWidth:960,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.center)
        }
    }

    private func pluginRow(_ item:ProjectPluginDetail) -> some View {
        VStack(alignment:.leading,spacing:10) {
            Button {
                if !expandedIds.insert(item.id).inserted { expandedIds.remove(item.id) }
            } label: {
                HStack(alignment:.top,spacing:10) {
                    Circle().fill(!item.enabled ? Color.secondary : (item.ready ? Color.green : Color.orange))
                        .frame(width:7,height:7).padding(.top,6)
                    VStack(alignment:.leading,spacing:5) {
                        HStack(spacing:7) {
                            Text(item.displayName).font(.system(size:13,weight:.semibold))
                                .lineLimit(2)
                            if !item.enabled {
                                Text("已禁用").font(.system(size:10)).foregroundStyle(.secondary)
                            }
                        }
                        Text("\(item.actionCount) 项操作 · \(item.ready ? "可用" : "未就绪")")
                            .font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
                    }
                    Spacer(minLength:6)
                    Image(systemName:expandedIds.contains(item.id) ? "chevron.up" : "chevron.down")
                        .font(.system(size:10,weight:.medium)).foregroundStyle(.secondary)
                        .padding(.top,5)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(item.displayName)，\(item.ready ? "就绪" : "未就绪")，\(expandedIds.contains(item.id) ? "收起详情" : "展开详情")")
            .accessibilityIdentifier("plugins.\(item.pluginId).details")
            if expandedIds.contains(item.id) {
                VStack(alignment:.leading,spacing:11) {
                    if !item.capabilities.isEmpty {
                        Text("可用能力").font(.system(size:10.5,weight:.semibold))
                        LazyVGrid(columns:[GridItem(.adaptive(minimum:180,maximum:300),spacing:12,alignment:.leading)],
                                  alignment:.leading,spacing:7) {
                            ForEach(Array(item.capabilities.enumerated()),id:\.offset) { _, capability in
                                HStack(alignment:.top,spacing:7) {
                                    Image(systemName:"checkmark")
                                        .font(.system(size:8.5,weight:.semibold))
                                        .foregroundStyle(ForgePalette.secondary)
                                        .padding(.top,3)
                                    Text(capability).font(.system(size:11.5))
                                        .foregroundStyle(ForgePalette.ink)
                                        .frame(maxWidth:.infinity,alignment:.leading)
                                        .fixedSize(horizontal:false,vertical:true)
                                }
                            }
                        }
                        if item.capabilities.count < item.actionCount {
                            Text("显示 \(item.capabilities.count) / \(item.actionCount) 项能力。")
                                .font(.system(size:10)).foregroundStyle(.tertiary)
                        }
                    } else {
                        Text("暂无能力说明。")
                            .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                    }

                    DisclosureGroup("技术信息") {
                        LazyVGrid(columns:[GridItem(.adaptive(minimum:180,maximum:300),spacing:12,alignment:.leading)],
                                  alignment:.leading,spacing:8) {
                            meta("插件 ID",item.pluginId)
                            if let version = item.pluginVersion { meta("版本",version) }
                            if let provider = item.provider { meta("Provider",provider) }
                            meta("生命周期",item.lifecycle == "enabled" ? "已启用" : item.lifecycle)
                            meta("健康",item.health == "ready" ? "就绪" : item.health)
                            meta("启用状态",item.enabled ? "已启用" : "已禁用")
                            meta("操作数","\(item.actionCount)")
                        }
                        .padding(.top,7)
                    }
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                }
                .padding(.leading,17)
                .accessibilityIdentifier("plugins.\(item.pluginId).expanded")
            }
        }.padding(.vertical,12)
    }

    private func meta(_ label:String,_ value:String) -> some View {
        Text("\(label) · \(value)")
            .font(.system(size:10.5,design:.monospaced))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal:false,vertical:true)
    }

    private func emptyState(_ title:String,_ detail:String) -> some View {
        VStack(alignment:.leading,spacing:5) {
            Text(title).font(.system(size:13,weight:.medium))
            Text(detail).font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
        }.padding(.vertical,16)
    }
}

struct PluginSettingsSection: View {
    @ObservedObject var model: NativeWorkspace
    @State private var pendingInstallation: PluginManagementItem?
    @State private var expandedAuthorizationPluginId: String?
    @State private var pendingAuthorizationRevocation: PluginAuthorizationItem?

    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                VStack(alignment:.leading,spacing:4) {
                    Text("官方插件").font(.system(size:13,weight:.semibold))
                    Text("安装或更新不会自动授予操作权限。")
                        .font(.system(size:10.5)).foregroundStyle(.tertiary)
                }
                Spacer()
                Button { Task { await model.loadPluginManagement() } } label: {
                    if model.pluginManagementLoading { ProgressView().controlSize(.small) }
                    else { Image(systemName:"arrow.clockwise") }
                }
                .buttonStyle(.plain)
                .disabled(model.pluginManagementLoading)
                .accessibilityLabel("刷新官方插件")
                .accessibilityIdentifier("settings.plugins.refresh")
            }

            if let error = model.pluginManagementError {
                HStack(alignment:.top,spacing:8) {
                    Image(systemName:"exclamationmark.circle")
                    Text(error.contains("controller.plugins") || error.contains("CORE_CAPABILITY")
                         ? "当前无法管理插件；工作区中的插件列表仍可查看。"
                         : "插件状态暂时无法确认。")
                        .font(.system(size:11))
                        .fixedSize(horizontal:false,vertical:true)
                        .textSelection(.enabled)
                        .help(error)
                    Spacer(minLength:6)
                    Button("重试") { Task { await model.loadPluginManagement() } }
                        .buttonStyle(.plain)
                        .disabled(model.pluginManagementLoading)
                        .accessibilityIdentifier("settings.plugins.retry")
                }
                .foregroundStyle(.orange)
                .accessibilityIdentifier("settings.plugins.error")
            }
            if model.pluginManagement.isEmpty {
                if model.pluginManagementLoading {
                    ProgressView("正在读取可安装插件…").controlSize(.small)
                } else if model.pluginManagementError == nil {
                    Text("暂无可安装的官方插件。")
                        .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                }
            } else {
                VStack(alignment:.leading,spacing:0) {
                    ForEach(Array(model.pluginManagement.enumerated()),id:\.element.id) { index,item in
                        VStack(alignment:.leading,spacing:8) {
                            HStack(alignment:.top,spacing:11) {
                                Circle()
                                    .fill(item.installedVersion == nil ? Color.secondary : (item.enabled == false ? Color.orange : Color.green))
                                    .frame(width:7,height:7).padding(.top,6)
                                VStack(alignment:.leading,spacing:4) {
                                    HStack(spacing:7) {
                                        Text(item.name).font(.system(size:11.5,weight:.semibold))
                                        Text(item.version).font(.system(size:9.5,design:.monospaced)).foregroundStyle(.tertiary)
                                    }
                                    Text(item.description).font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary).lineLimit(2)
                                    HStack(spacing:10) {
                                        Text(item.installedVersion.map { "已安装 \($0)" } ?? "未安装")
                                        if item.enabled == false && item.installedVersion != nil { Text("已禁用") }
                                        Button {
                                            if expandedAuthorizationPluginId == item.pluginId {
                                                expandedAuthorizationPluginId = nil
                                            } else {
                                                expandedAuthorizationPluginId = item.pluginId
                                                Task { await model.loadPluginAuthorizations(for:item.pluginId) }
                                            }
                                        } label: {
                                            HStack(spacing:3) {
                                                Text("授权 \(item.authorizationCount)")
                                                Image(systemName:expandedAuthorizationPluginId == item.pluginId ? "chevron.up" : "chevron.down")
                                                    .font(.system(size:8,weight:.medium))
                                            }
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(ForgePalette.accent)
                                        .disabled(model.pluginAuthorizationLoading)
                                        .accessibilityIdentifier("settings.plugins.\(item.pluginId).authorizations")
                                    }
                                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
                                    if !item.compatible {
                                        Text(item.compatibilityReason ?? "当前平台不兼容")
                                            .font(.system(size:10.5)).foregroundStyle(.orange)
                                            .fixedSize(horizontal:false,vertical:true)
                                    }
                                }
                                Spacer(minLength:8)
                                Button(item.installedVersion == item.version ? "已安装" : (item.installedVersion == nil ? "安装" : "更新")) {
                                    pendingInstallation = item
                                }
                                .buttonStyle(.forgeText)
                                .controlSize(.small)
                                .disabled(model.pluginManagementLoading || !item.compatible || item.installedVersion == item.version)
                                .accessibilityIdentifier("settings.plugins.\(item.pluginId).install")
                            }
                            if expandedAuthorizationPluginId == item.pluginId {
                                pluginAuthorizationDetails(for:item)
                                    .padding(.leading,18)
                            }
                        }
                        .padding(.vertical,9)
                        
                    }
                }
            }
        }
        .padding(.vertical,8)
        .confirmationDialog(
            pendingAuthorizationRevocation == nil ? "确认安装官方插件" : "撤销此项授权？",
            isPresented:Binding(
                get:{ pendingInstallation != nil || pendingAuthorizationRevocation != nil },
                set:{ if !$0 { pendingInstallation = nil; pendingAuthorizationRevocation = nil } }
            ),titleVisibility:.visible
        ) {
            if let item = pendingAuthorizationRevocation {
                Button("撤销授权",role:.destructive) {
                    pendingAuthorizationRevocation = nil
                    Task { await model.revokePluginAuthorization(item) }
                }
            } else if let item = pendingInstallation {
                Button(item.installedVersion == nil ? "确认安装" : "确认更新") {
                    pendingInstallation = nil
                    Task { await model.installOfficialPlugin(item) }
                }
            }
            Button("取消",role:.cancel) { pendingInstallation = nil; pendingAuthorizationRevocation = nil }
        } message: {
            if let item = pendingAuthorizationRevocation {
                Text("\(item.capabilityId) · \(item.targetId)\n撤销后，相关操作需要重新授权。")
            } else if let item = pendingInstallation {
                Text("\(item.name) · \(item.version)\n安装或更新不会自动授予操作权限。")
            }
        }
    }

    @ViewBuilder
    private func pluginAuthorizationDetails(for plugin:PluginManagementItem) -> some View {
        VStack(alignment:.leading,spacing:8) {
            if model.pluginAuthorizationLoading {
                ProgressView("正在读取授权…").controlSize(.small)
            }
            if let error = model.pluginAuthorizationError {
                HStack(alignment:.firstTextBaseline,spacing:8) {
                    Text(model.pluginAuthorizationSnapshot?.pluginId == plugin.pluginId
                         ? "无法更新授权，仍显示上次读取结果。"
                         : "无法读取授权，请重试。")
                        .font(.system(size:10.5)).foregroundStyle(.orange).help(error)
                    Button("重试") { Task { await model.loadPluginAuthorizations(for:plugin.pluginId) } }
                        .buttonStyle(.plain)
                        .disabled(model.pluginAuthorizationLoading)
                }
            }
            if let snapshot = model.pluginAuthorizationSnapshot, snapshot.pluginId == plugin.pluginId {
                if snapshot.items.isEmpty {
                    Text("暂无当前账户的有效授权。")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                } else {
                    if snapshot.truncated {
                        Text("显示前 \(snapshot.items.count) 项，共 \(snapshot.totalCount) 项。")
                            .font(.system(size:9.5)).foregroundStyle(.tertiary)
                    }
                    ForEach(snapshot.items) { item in pluginAuthorizationRow(item) }
                }
            }
        }
    }

    private func pluginAuthorizationRow(_ item:PluginAuthorizationItem) -> some View {
        HStack(alignment:.top,spacing:10) {
            VStack(alignment:.leading,spacing:3) {
                Text(item.capabilityId).font(.system(size:10.5,weight:.medium))
                    .lineLimit(2).textSelection(.enabled)
                Text("\(item.targetKind) · \(item.targetId)")
                    .font(.system(size:10)).foregroundStyle(ForgePalette.secondary)
                    .lineLimit(2).textSelection(.enabled)
                Text(item.scopes.joined(separator:" · "))
                    .font(.system(size:9.5)).foregroundStyle(ForgePalette.secondary)
                    .lineLimit(2).textSelection(.enabled)
                Text("到期 \(String(item.expiresAt.prefix(10))) · \(authorizationRiskLabel(item.riskCeiling))")
                    .font(.system(size:9.5)).foregroundStyle(.tertiary)
            }
            Spacer(minLength:8)
            Button("撤销") { pendingAuthorizationRevocation = item }
                .buttonStyle(.plain)
                .foregroundStyle(.red)
                .disabled(model.pluginAuthorizationLoading)
                .accessibilityIdentifier("settings.plugins.authorization.\(item.grantId).revoke")
        }
        .padding(.vertical,6)
        
    }

    private func authorizationRiskLabel(_ value:String) -> String {
        switch value {
        case "readonly": return "只读"
        case "workspace_write": return "工作区写入"
        case "remote_write": return "远程写入"
        default: return value
        }
    }
}

struct RuntimeSettingsSection: View {
    @ObservedObject var model: NativeWorkspace
    @State private var setupController = "chatgpt"
    @State private var copiedMcpCommand: String?

    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            Text("连接").font(.system(size:13,weight:.semibold))

            connectionCard

            Divider()

            externalClientGuide

            Divider()

            DisclosureGroup {
                VStack(alignment:.leading,spacing:12) {
                    runtimeCard
                    if let diagnostics = model.runtimeDiagnostics {
                        Divider()
                        runtimeDiagnostics(diagnostics)
                    }
                }
                .padding(.top,10)
            } label: {
                HStack(spacing:8) {
                    Circle().fill(runtimeColor).frame(width:7,height:7)
                    Text("运行状态与诊断")
                        .font(.system(size:11.5,weight:.semibold))
                    Spacer()
                    Text(model.runtimeLabel)
                        .font(.system(size:10.5))
                        .foregroundStyle(ForgePalette.secondary)
                }
            }
        }
    }

    private func runtimeDiagnostics(_ diagnostics: RuntimeDiagnosticsDetail) -> some View {
        VStack(alignment:.leading,spacing:12) {
            HStack(alignment:.top) {
                VStack(alignment:.leading,spacing:3) {
                    Text("上次诊断").font(.system(size:12,weight:.semibold))
                    if let checkedAt = diagnostics.checkedAt, !checkedAt.isEmpty {
                        Text(checkedAt)
                            .font(.system(size:9.5,design:.monospaced))
                            .foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                    }
                }
                Spacer()
                Text("\(diagnostics.passed) 通过 · \(diagnostics.failed) 失败")
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(diagnostics.ok ? Color.green : Color.orange)
            }
            ForEach(diagnostics.probes) { probe in
                HStack(spacing:9) {
                    Image(systemName:probe.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(probe.ok ? Color.green : Color.orange)
                    Text(probe.label).font(.system(size:11.5))
                    Spacer()
                }
            }
        }
        .padding(.vertical,6)
    }

    private var externalClientGuide: some View {
        DisclosureGroup("在其他客户端使用 Forge") {
            VStack(alignment:.leading,spacing:12) {
                VStack(alignment:.leading,spacing:5) {
                    Text("ChatGPT").font(.system(size:11.5,weight:.semibold))
                    Text("在 ChatGPT 的连接设置中添加 Forge，使用现有 Secure MCP Tunnel 或 HTTPS /mcp 地址。")
                    Text("添加后用下面的提示进行只读连通性验证。")
                    copyableMcpCommand("Use Forge. Call rh_status and report whether the Runtime is ready. Do not modify anything yet.")
                }
                if model.checkoutIsAvailable, let checkoutPath = model.checkoutRoot?.path {
                    let repoArgument = shellQuotedMcpPath(checkoutPath)
                    Divider()
                    VStack(alignment:.leading,spacing:5) {
                        Text("Claude Code").font(.system(size:11.5,weight:.semibold))
                        Text("写入 Claude Code 用户级 MCP 配置；执行后用 claude mcp get forge 验证。")
                        copyableMcpCommand("forge mcp setup claude --repo \(repoArgument) --scope user --profile controller")
                    }
                    Divider()
                    VStack(alignment:.leading,spacing:5) {
                        Text("其他支持 stdio 的 MCP 客户端").font(.system(size:11.5,weight:.semibold))
                        Text("将命令设置为 MCP 服务启动命令；它只会开放当前选中的工作区。")
                        copyableMcpCommand("forge mcp serve --repo \(repoArgument) --transport stdio --profile controller")
                    }
                } else {
                    Text("请先选择项目和工作区，再查看对应的本地连接命令。")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
            }
            .font(.system(size:11))
            .foregroundStyle(ForgePalette.secondary)
            .padding(.top,10)
        }
        .font(.system(size:12))
        .accessibilityIdentifier("connection.external-guide")
    }

    private func copyableMcpCommand(_ command:String) -> some View {
        HStack(spacing:10) {
            Text(command)
                .font(.system(size:10.5,design:.monospaced))
                .textSelection(.enabled)
            Spacer(minLength:8)
            Button(copiedMcpCommand == command ? "已复制" : "复制") {
                NSPasteboard.general.clearContents()
                if NSPasteboard.general.setString(command,forType:.string) {
                    copiedMcpCommand = command
                } else {
                    model.error = "复制失败，请手动选择命令。"
                }
            }
            .buttonStyle(.forgeText)
        }
    }

    private var runtimeCard: some View {
        VStack(alignment:.leading,spacing:13) {
            HStack(spacing:9) {
                Circle().fill(runtimeColor).frame(width:8,height:8)
                Text(model.runtimeLabel)
                    .font(.system(size:14,weight:.semibold))
                Spacer()
                Button("刷新") { Task { await model.loadRuntimePage() } }
                    .buttonStyle(.plain).disabled(model.runtimeLoading)
                    .accessibilityIdentifier("runtime.refresh")
                Button("诊断") { Task { await model.diagnoseRuntime() } }
                    .buttonStyle(.forgeText).disabled(model.runtimeLoading)
                    .accessibilityIdentifier("runtime.diagnose")
            }
            Text(model.runtimeDescription)
                .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            if let status = model.runtimeStatus {
                HStack(spacing:14) {
                    if let release = status.releaseId { runtimeMeta("Release",String(release.prefix(18))) }
                    if let pid = status.pid { runtimeMeta("PID","\(pid)") }
                    runtimeMeta("Reasons","\(status.reasonCount)")
                }
            }
        }
        .padding(.vertical,8)
    }

    private var connectionCard: some View {
        VStack(alignment:.leading,spacing:13) {
            HStack(spacing:9) {
                Circle().fill(connectionColor).frame(width:8,height:8)
                Text(model.connection).font(.system(size:14,weight:.semibold))
                Spacer()
                Button("刷新连接") { Task { await model.loadRuntimePage() } }
                    .buttonStyle(.plain).disabled(model.connectionLoading)
                    .accessibilityIdentifier("connection.refresh")
                if model.connectionStatus?.repairAvailable == true {
                    Button(model.connectionStatus?.repairLabel ?? "重新连接") {
                        Task { await model.repairControllerConnection() }
                    }
                    .buttonStyle(.forgeText).disabled(model.connectionLoading)
                    .accessibilityIdentifier("connection.repair")
                }
            }
            if let status = model.connectionStatus {
                connectionRow("本机服务",status.controller)
                connectionRow("远程连接",status.tunnel)
                if status.ready {
                    Text("连接配置已就绪。请在对应客户端发送一条消息确认可用。")
                        .font(.system(size:11))
                        .foregroundStyle(ForgePalette.secondary)
                }
                if status.configured, !status.ready, let setup = status.setup, let summary = setup.summary {
                    Divider()
                    VStack(alignment:.leading,spacing:6) {
                        HStack(spacing:8) {
                            Text(setup.requiresUser ? "需要你的操作" : "下一步")
                                .font(.system(size:11.5,weight:.semibold))
                            Spacer()
                            Button("重新检测") { Task { await model.loadRuntimePage() } }
                                .buttonStyle(.plain)
                                .disabled(model.connectionLoading)
                        }
                        Text(summary).font(.system(size:11.5)).foregroundStyle(ForgePalette.secondary)
                        if let risk = setup.risk {
                            let riskLabel: String? = switch risk {
                            case "readonly": "只读操作"
                            case "workspace_write": "将修改本机文件或配置"
                            case "remote_write": "将修改远程服务中的数据"
                            case "destructive": "可能删除或覆盖数据"
                            default: nil
                            }
                            if let riskLabel {
                                Text(riskLabel).font(.system(size:10.5)).foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .padding(.top,2)
                    .accessibilityIdentifier("connection.setup.next")
                }
                if !status.configured {
                    Divider()
                    VStack(alignment:.leading,spacing:8) {
                        Text("首次连接").font(.system(size:11.5,weight:.semibold))
                        HStack(spacing:10) {
                            Picker("客户端",selection:$setupController) {
                                Text("ChatGPT").tag("chatgpt")
                                Text("Codex").tag("codex")
                                Text("Claude Code").tag("claude")
                                Text("MCP 客户端").tag("mcp")
                            }
                            .pickerStyle(.menu)
                            .frame(width:220,alignment:.leading)
                            .accessibilityIdentifier("connection.setup.controller")
                            Spacer()
                            Button(model.connectionLoading ? "配置中…" : "保存连接配置") {
                                Task { await model.configureInitialControllerConnection(setupController) }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.connectionLoading)
                            .accessibilityIdentifier("connection.setup.apply")
                        }
                        Text(setupController == "chatgpt" || setupController == "mcp"
                             ? "通过 Forge 远程连接。"
                             : "直接连接本机服务。")
                            .font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
                        Text("保存后，在对应客户端发送一条消息确认可用。")
                            .font(.system(size:10.5)).foregroundStyle(.tertiary)
                    }
                    .padding(.top,2)
                }
            } else {
                Text(model.connectionLoading ? "正在读取连接状态。" : "暂时无法读取连接状态。请刷新后重试。")
                    .font(.system(size:12)).foregroundStyle(ForgePalette.secondary)
            }
        }
        .padding(.vertical,8)
    }

    private var runtimeColor: Color {
        guard let status = model.runtimeStatus else { return .secondary }
        if status.ready && !status.stale { return .green }
        return status.running ? .orange : .red
    }

    private var connectionColor: Color {
        guard let status = model.connectionStatus else { return .secondary }
        return status.ready ? .green : status.configured ? .orange : .red
    }

    private func runtimeMeta(_ label:String,_ value:String) -> some View {
        VStack(alignment:.leading,spacing:2) {
            Text(label).font(.system(size:9.5,weight:.medium)).foregroundStyle(.tertiary)
            Text(value).font(.system(size:10.5,design:.monospaced)).textSelection(.enabled)
        }
    }

    private func connectionRow(_ label:String,_ item:ConnectionComponentDetail) -> some View {
        HStack(alignment:.top,spacing:10) {
            Image(systemName:item.ready ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(item.ready ? Color.green : Color.orange)
            VStack(alignment:.leading,spacing:3) {
                Text("\(label) · \(item.title)").font(.system(size:11.5,weight:.medium))
                Text(item.detail).font(.system(size:11)).foregroundStyle(ForgePalette.secondary)
            }
        }
    }
}

struct KnowledgePane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var selectedMemoryId: String?
    @State private var authoringTarget: KnowledgeAuthoringTarget?

    var body: some View {
        VStack(alignment:.leading,spacing:0) {
            VStack(alignment:.leading,spacing:11) {
                HStack(spacing:8) {
                    HStack(spacing:7) {
                        Image(systemName:"magnifyingglass")
                            .font(.system(size:10))
                            .foregroundStyle(.tertiary)
                        TextField("搜索经验、概念、技术决策…",text:$model.knowledgeQuery)
                            .textFieldStyle(.plain)
                            .font(.system(size:11.5))
                            .onSubmit { runSearch() }
                            .accessibilityIdentifier("knowledge.query")
                        if !model.knowledgeQuery.isEmpty {
                            Button {
                                model.knowledgeQuery=""
                                runSearch()
                            } label: {
                                Image(systemName:"xmark.circle.fill")
                                    .font(.system(size:9.5))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("清除知识搜索")
                        }
                    }
                    .padding(.horizontal,10)
                    .frame(height:34)
                    .background(ForgePalette.softFill,
                                in:RoundedRectangle(cornerRadius:9,style:.continuous))

                    if let result=model.knowledgeResult {
                        Text("\(result.items.count) 条结果")
                            .font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary)
                    }

                    Button { runSearch() } label: {
                        if model.knowledgeLoading {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName:"arrow.right")
                                .font(.system(size:10,weight:.semibold))
                        }
                    }
                    .buttonStyle(.plain)
                    .frame(width:30,height:30)
                    .help("检索")
                    .disabled(model.knowledgeLoading || model.repoId == nil)
                    .accessibilityLabel("检索知识")
                    .accessibilityIdentifier("knowledge.search")

                    Button {
                        guard let repoId = model.repoId, let checkoutId = model.checkoutId else { return }
                        authoringTarget = KnowledgeAuthoringTarget(
                            repoId: repoId, checkoutId: checkoutId,
                            projectLabel: model.project?.label ?? repoId
                        )
                    } label: {
                        Label("新增记忆", systemImage: "plus")
                    }
                    .disabled(model.repoId == nil || model.checkoutId == nil)
                    .accessibilityIdentifier("knowledge.add")
                }
            }
            .padding(.horizontal,22).padding(.top,20).padding(.bottom,14)

            Divider()

            if model.repoId == nil {
                knowledgeEmpty("先选择已注册的 Forge 项目，以限定知识检索范围。")
            } else if model.knowledgeLoading && model.knowledgeResult == nil {
                ProgressView("正在读取知识…")
                    .controlSize(.small)
                    .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else if let result=model.knowledgeResult,result.items.isEmpty {
                knowledgeEmpty("没有匹配的知识记录。换一个更具体的概念或技术决策再试。")
            } else if model.knowledgeResult == nil {
                knowledgeEmpty("输入问题或概念开始检索。")
            } else {
                GeometryReader { geometry in
                    let listWidth=min(max(280,geometry.size.width * 0.34),360)
                    HStack(spacing:0) {
                        knowledgeList
                            .frame(width:listWidth)
                        Divider()
                        knowledgeDetail
                            .frame(maxWidth:.infinity,maxHeight:.infinity)
                    }
                }
            }

            Divider()
            knowledgeStatusBar
        }
        .background(ForgePalette.canvas)
        .sheet(item: $authoringTarget) { target in
            KnowledgeAuthoringSheet(target: target) {
                guard model.repoId == target.repoId, model.checkoutId == target.checkoutId else { return }
                model.knowledgeQuery = ""
                runSearch()
            }
        }
        .onChange(of:model.knowledgeResult?.items.map(\.memory.id) ?? []) { ids in
            if let selectedMemoryId,!ids.contains(selectedMemoryId) {
                self.selectedMemoryId=nil
            }
        }
    }

    private var memories:[KnowledgeMemoryDetail] {
        model.knowledgeResult?.items.map(\.memory) ?? []
    }

    private var selectedMemory:KnowledgeMemoryDetail? {
        if let selectedMemoryId,
           let exact=memories.first(where:{$0.id == selectedMemoryId}) {
            return exact
        }
        return memories.first
    }

    private var knowledgeList: some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:0) {
                ForEach(memories) { memory in
                    let selected=selectedMemory?.id == memory.id
                    Button {
                        selectedMemoryId=memory.id
                    } label: {
                        VStack(alignment:.leading,spacing:6) {
                            HStack(spacing:6) {
                                Text(scopeLabel(memory.scope.kind))
                                    .font(.system(size:9,weight:.semibold))
                                    .foregroundStyle(ForgePalette.secondary)
                                if let concept=memory.concepts.first,!concept.isEmpty {
                                    Text(concept)
                                        .font(.system(size:9.5,weight:.medium))
                                        .lineLimit(1)
                                }
                                Spacer()
                                if selected {
                                    Image(systemName:"chevron.right")
                                        .font(.system(size:8.5,weight:.semibold))
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            Text(memory.canonicalText)
                                .font(.system(size:11.5))
                                .foregroundStyle(ForgePalette.ink)
                                .lineLimit(3)
                                .multilineTextAlignment(.leading)
                            if let source=memory.provenance?.sourceKind,!source.isEmpty {
                                Text(source)
                                    .font(.system(size:9))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.horizontal,14).padding(.vertical,11)
                        .frame(maxWidth:.infinity,alignment:.leading)
                        .contentShape(Rectangle())
                        .background(selected ? ForgePalette.selection.opacity(0.75) : .clear)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("knowledge.result.\(memory.id)")
                    Divider().padding(.leading,14)
                }
            }
        }
        .scrollIndicators(.automatic)
    }

    @ViewBuilder
    private var knowledgeDetail: some View {
        if let memory=selectedMemory {
            ScrollView {
                VStack(alignment:.leading,spacing:16) {
                    VStack(alignment:.leading,spacing:6) {
                        HStack(spacing:7) {
                            Text(scopeLabel(memory.scope.kind))
                                .font(.system(size:9.5,weight:.semibold))
                                .foregroundStyle(ForgePalette.secondary)
                            if let source=memory.provenance?.sourceKind,!source.isEmpty {
                                Text(source)
                                    .font(.system(size:9.5))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        Text(memory.canonicalText)
                            .font(.system(size:14,weight:.medium))
                            .lineSpacing(5)
                            .textSelection(.enabled)
                    }

                    HStack(spacing:9) {
                        Button {
                            model.useKnowledgeInCurrentConversation(memory)
                        } label: {
                            Label("加入当前草稿",systemImage:"text.badge.plus")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || model.thread == nil)
                        .help("加入当前会话草稿，可编辑后再发送；不会自动发送")
                        .accessibilityIdentifier("knowledge.use.\(memory.id)")

                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(memory.canonicalText,forType:.string)
                        } label: {
                            Label("复制",systemImage:"doc.on.doc")
                        }
                        .buttonStyle(.forgeText)
                        .accessibilityIdentifier("knowledge.copy.\(memory.id)")
                    }

                    if !memory.concepts.isEmpty {
                        knowledgeDetailSection("相关概念") {
                            ScrollView(.horizontal) {
                                HStack(spacing:6) {
                                    ForEach(memory.concepts,id:\.self) { concept in
                                        Button(concept) {
                                            model.knowledgeQuery=concept
                                            selectedMemoryId=nil
                                            runSearch()
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size:10,weight:.medium))
                                        .padding(.horizontal,8).frame(height:24)
                                        .background(ForgePalette.softFill,in:Capsule())
                                        .help("检索 \(concept)")
                                    }
                                }
                            }
                            .scrollIndicators(.hidden)
                        }
                    }

                    if !memory.facets.isEmpty {
                        knowledgeDetailSection("适用侧面") {
                            Text(memory.facets.joined(separator:" · "))
                                .font(.system(size:11))
                                .foregroundStyle(ForgePalette.secondary)
                                .textSelection(.enabled)
                        }
                    }

                    DisclosureGroup("来源与元数据") {
                        VStack(alignment:.leading,spacing:7) {
                            knowledgeMetadata("Scope","\(memory.scope.kind) / \(memory.scope.id)")
                            if let source=memory.provenance?.sourceKind,!source.isEmpty {
                                knowledgeMetadata("Source",source)
                            }
                            if let recorded=memory.provenance?.recordedAt,!recorded.isEmpty {
                                knowledgeMetadata("Recorded",recorded)
                            }
                            knowledgeMetadata("Confidence",String(format:"%.2f",memory.confidence))
                            knowledgeMetadata("Revision","r\(memory.revision)")
                            knowledgeMetadata("Memory ID",memory.id)
                        }
                        .padding(.top,9)
                    }
                    .font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary)
                    .padding(.top,2)
                }
                .frame(maxWidth:620,alignment:.leading)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(.horizontal,24).padding(.vertical,22)
            }
            .scrollIndicators(.automatic)
        } else {
            knowledgeEmpty("选择左侧知识记录查看详情。")
        }
    }

    private var knowledgeStatusBar: some View {
        HStack(spacing:7) {
            if let result=model.knowledgeResult {
                Text("检索 \(result.inspected) 条 · 返回 \(result.items.count) 条")
                if result.truncated {
                    Text("· 结果已截断，建议缩小关键词")
                }
                if !result.gaps.isEmpty {
                    Text("· 部分范围不可达")
                        .foregroundStyle(.orange)
                        .help(result.gaps.joined(separator:"、"))
                }
            } else {
                Text("Forge Cognitive · 只读 advisory")
            }
            Spacer()
            Text(model.project?.label ?? "未选择项目")
        }
        .font(.system(size:9.5))
        .foregroundStyle(.tertiary)
        .padding(.horizontal,18)
        .frame(height:33)
    }

    private func knowledgeDetailSection<Content:View>(
        _ title:String,
        @ViewBuilder content:() -> Content
    ) -> some View {
        VStack(alignment:.leading,spacing:8) {
            Text(title)
                .font(.system(size:10.5,weight:.semibold))
                .foregroundStyle(ForgePalette.secondary)
            content()
        }
        .padding(.top,12)
        .overlay(alignment:.top) {
            Rectangle().fill(Color.primary.opacity(0.10)).frame(height:1)
        }
    }

    private func knowledgeMetadata(_ key:String,_ value:String) -> some View {
        HStack(alignment:.top,spacing:10) {
            Text(key)
                .frame(width:72,alignment:.leading)
                .foregroundStyle(.tertiary)
            Text(value)
                .textSelection(.enabled)
                .frame(maxWidth:.infinity,alignment:.leading)
        }
        .font(.system(size:9.5,design:.monospaced))
    }

    private func knowledgeEmpty(_ message:String) -> some View {
        Text(message)
            .font(.system(size:11.5))
            .foregroundStyle(ForgePalette.secondary)
            .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            .padding(22)
    }

    private func scopeLabel(_ kind:String) -> String {
        switch kind {
        case "project": return "项目"
        case "workspace": return "工作空间"
        case "requirement": return "Requirement"
        case "plan": return "Plan"
        default: return kind
        }
    }

    private func runSearch() {
        selectedMemoryId=nil
        Task { await model.searchKnowledge() }
    }
}

struct KnowledgeAuthoringTarget: Identifiable {
    let id = UUID()
    let repoId: String
    let checkoutId: String
    let projectLabel: String
}

struct KnowledgeAuthoringSheet: View {
    let target: KnowledgeAuthoringTarget
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var scope = "project"
    @State private var summary = ""
    @State private var concept = "user.guidance"
    @State private var saving = false
    @State private var failure: String?

    private var valid: Bool {
        let text = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let tag = concept.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && text.unicodeScalars.count <= 2000
            && tag.range(of: "^[a-z][a-z0-9._-]{0,127}$", options: .regularExpression) != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("新增记忆")
                .font(.title2.weight(.semibold))
            Text(target.projectLabel)
                .foregroundStyle(.secondary)
            Picker("适用范围", selection: $scope) {
                Text("当前项目").tag("project")
                Text("工作空间 · 跨项目").tag("workspace")
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("knowledge.add.scope")

            VStack(alignment: .leading, spacing: 6) {
                Text("主题标记")
                    .font(.subheadline.weight(.medium))
                TextField("例如 engineering.root-cause", text: $concept)
                    .accessibilityIdentifier("knowledge.add.concept")
                Text("使用小写英文、数字、点或连字符。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("记忆内容")
                    .font(.subheadline.weight(.medium))
                TextEditor(text: $summary)
                    .font(.body)
                    .frame(minHeight: 150)
                    .padding(6)
                    .background(ForgePalette.softFill,in:RoundedRectangle(cornerRadius:8,style:.continuous))
                    .accessibilityIdentifier("knowledge.add.summary")
                Text("记忆用于相关任务的主动召回，不会覆盖当前指令或授权。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let failure {
                Text(failure)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("knowledge.add.failure")
            }

            HStack {
                Spacer()
                Button(failure == nil ? "取消" : "关闭并核对") {
                    dismiss()
                    if failure != nil { onSaved() }
                }
                .keyboardShortcut(.cancelAction)
                .disabled(saving)
                Button {
                    save()
                } label: {
                    if saving { ProgressView().controlSize(.small) }
                    else { Text("保存") }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!valid || saving || failure != nil)
                .accessibilityIdentifier("knowledge.add.save")
            }
        }
        .padding(24)
        .frame(width: 530)
        .interactiveDismissDisabled(saving)
    }

    private func save() {
        guard valid, !saving, failure == nil else { return }
        saving = true
        let arguments: [String: Any] = [
            "repoId": target.repoId, "checkoutId": target.checkoutId,
            "requestId": "native-user-knowledge-\(target.id.uuidString)",
            "scope": scope, "summary": summary.trimmingCharacters(in: .whitespacesAndNewlines),
            "concept": concept.trimmingCharacters(in: .whitespacesAndNewlines)
        ]
        Task {
            defer { saving = false }
            do {
                let response = try await ForgeBridge.request("record_user_knowledge", arguments)
                guard let ids = response["storedMemoryIds"] as? [String], !ids.isEmpty else {
                    throw ForgeBridgeError.invalidResponse
                }
                dismiss()
                onSaved()
            } catch {
                failure = "保存未确认：\(error.localizedDescription)。关闭后先刷新知识库核对，避免重复写入。"
            }
        }
    }
}

struct ProviderProfileDraft: Identifiable, Equatable {
    let id:String
    var label:String
    var endpoint:String
    var model:String
    var apiProtocol:String
    var credentialRef:String?

    var providerId:String { "api:\(id)" }

    init(_ detail:ApiProviderProfileDetail) {
        id=detail.id
        label=detail.label
        endpoint=detail.endpoint
        model=detail.model
        apiProtocol=detail.apiProtocol
        credentialRef=detail.credentialRef
    }

    init(id:String,label:String,endpoint:String,model:String,apiProtocol:String,credentialRef:String?=nil) {
        self.id=id
        self.label=label
        self.endpoint=endpoint
        self.model=model
        self.apiProtocol=apiProtocol
        self.credentialRef=credentialRef
    }

    func detail(existing:ApiProviderProfileDetail?) -> ApiProviderProfileDetail {
        ApiProviderProfileDetail(
            id:id,providerId:providerId,label:label,endpoint:endpoint,model:model,
            apiProtocol:apiProtocol,credentialRef:credentialRef,
            hasKey:existing?.hasKey ?? false,
            endpointReady:existing?.endpointReady ?? false
        )
    }
}

struct SettingsPane: View {
    @ObservedObject var model: NativeWorkspace
    @State private var defaultProvider = "codex"
    @State private var profiles:[ProviderProfileDraft] = []
    @State private var selectedProfileId = ""
    @State private var joyCodeModel = "JoyAI-Code-1.6"
    @State private var saving = false
    @State private var credentialToDelete: String?
    @State private var testingProfileId: String?
    @State private var connectionFeedback: (profileId:String,passed:Bool,message:String)?

    var body: some View {
        ScrollView {
            VStack(alignment:.leading,spacing:ForgeClientDesign.Spacing.section + 6) {
                Text("设置").font(ForgeClientDesign.Typography.sheetTitle)
                VStack(alignment:.leading,spacing:12) {
                    HStack(spacing:9) {
                        Circle().fill(model.selectedProviderReady ? Color.green : Color.orange)
                            .frame(width:8,height:8)
                        Text("当前会话 · \(selectedProviderLabel)")
                            .font(.system(size:14,weight:.semibold))
                        Spacer()
                        Text(model.selectedProviderReady ? "配置完整" : "待完善")
                            .font(ForgeClientDesign.Typography.supporting)
                            .foregroundStyle(model.selectedProviderReady ? ForgePalette.secondary : Color.orange)
                    }
                    LazyVGrid(columns:[GridItem(.adaptive(minimum:145,maximum:260),spacing:14,alignment:.leading)],
                              alignment:.leading,spacing:10) {
                        settingMeta("会话模型",NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                                    ? (model.selectedApiModel.isEmpty ? "未配置" : model.selectedApiModel)
                                    : (model.selectedAgentModel?.displayName ?? "Codex 默认"))
                        settingMeta("推理强度",model.selectedProvider == "joycode" || NativeWorkspace.matchesExternalProvider(model.selectedProvider)
                                    ? "默认"
                                    : (model.selectedReasoningEffort.isEmpty ? "默认" : model.selectedReasoningEffort))
                        settingMeta("图片输入",model.selectedProviderSupportsImages ? "可用" : "不可用")
                    }
                    Text("默认服务仅用于新会话。")
                        .font(.system(size:10.5)).foregroundStyle(.tertiary)
                }
                .padding(.vertical,10)

                VStack(alignment:.leading,spacing:14) {
                    HStack {
                        VStack(alignment:.leading,spacing:4) {
                            Text("模型与 API").font(.system(size:15,weight:.semibold))
                            Text("保存 API 配置后，可直接测试模型连接。")
                                .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                        }
                        Spacer()
                        Menu {
                            Button("DeepSeek（官方 API）") {
                                addProfile(label:"DeepSeek",endpoint:"https://api.deepseek.com",model:"deepseek-chat",apiProtocol:"openai")
                            }
                            Button("DeepSeek · Zro（第三方兼容）") {
                                addProfile(label:"DeepSeek · Zro",endpoint:"https://zro.moonmath.ai/v1",model:"deepseek-v4.1-flash",apiProtocol:"openai")
                            }
                            Button("OpenAI") {
                                addProfile(label:"OpenAI",endpoint:"https://api.openai.com/v1",model:"",apiProtocol:"responses")
                            }
                            Button("Anthropic") {
                                addProfile(label:"Anthropic",endpoint:"https://api.anthropic.com/v1",model:"",apiProtocol:"anthropic")
                            }
                            Divider()
                            Button("自定义兼容 API") {
                                addProfile(label:"自定义服务",endpoint:"https://api.example.com/v1",model:"",apiProtocol:"openai")
                            }
                        } label: {
                            Label("添加模型服务",systemImage:"plus")
                                .font(.system(size:12,weight:.medium))
                                .foregroundStyle(Color(nsColor:.controlAccentColor))
                        }
                        .menuStyle(.borderlessButton).menuIndicator(.hidden)
                        .fixedSize()
                        .accessibilityIdentifier("settings.profile.add")
                    }

                    HStack(spacing:12) {
                        Text("新会话默认").font(.system(size:10.5,weight:.medium))
                            .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
                        Picker("新会话默认",selection:$defaultProvider) {
                            Text("Codex").tag("codex")
                            ForEach(profiles) { profile in
                                Text(profile.label).tag(profile.providerId)
                            }
                            Text("JoyCode").tag("joycode")
                        }
                        .labelsHidden().pickerStyle(.menu).frame(maxWidth:300,alignment:.leading)
                        .accessibilityIdentifier("settings.default-provider")
                    }

                    if profiles.isEmpty {
                        ForgeInspectorEmptyState(title:"暂无自定义 API 服务",symbol:"server.rack")
                    } else {
                        VStack(alignment:.leading,spacing:16) {
                            // One content column rather than a second fixed sidebar.
                            if profiles.count > 1 {
                            ScrollView(.horizontal) {
                                HStack(spacing:6) {
                                    ForEach(profiles) { profile in
                                        let selected=selectedProfileId == profile.id
                                        Button {
                                            selectedProfileId=profile.id
                                        } label: {
                                            HStack(spacing:6) {
                                                Text(profile.label)
                                                    .font(.system(size:11.5,weight:selected ? .semibold : .medium))
                                                    .lineLimit(1)
                                                if defaultProvider == profile.providerId {
                                                    Image(systemName:"checkmark")
                                                        .font(.system(size:9,weight:.semibold))
                                                } else if profileReady(profile) {
                                                    Circle().fill(Color.green).frame(width:5,height:5)
                                                }
                                            }
                                            .foregroundStyle(selected ? ForgePalette.ink : ForgePalette.secondary)
                                            .padding(.horizontal,9).frame(height:30)
                                            .contentShape(Rectangle())
                                            .forgeChromeSurface(selected:selected,cornerRadius:8)
                                        }
                                        .buttonStyle(.plain)
                                        .accessibilityAddTraits(selected ? [.isSelected] : [])
                                        .accessibilityIdentifier("settings.profile.\(profile.id)")
                                    }
                                }
                                .padding(.vertical,3)
                            }
                            .scrollIndicators(.hidden)
                            .accessibilityIdentifier("settings.profile.selector")
                            }

                            if let index=selectedProfileIndex {
                                HStack {
                                    VStack(alignment:.leading,spacing:4) {
                                        Text(profiles[index].label)
                                            .font(.system(size:15,weight:.semibold))
                                        Text(profileReadiness(profiles[index]))
                                            .font(.system(size:11))
                                            .foregroundStyle(profileReady(profiles[index]) ?
                                                              Color.green : ForgePalette.secondary)
                                    }
                                    Spacer()
                                    Menu {
                                        Button("设为新会话默认") {
                                            defaultProvider=profiles[index].providerId
                                        }
                                        Button("删除配置",role:.destructive) {
                                            deleteProfile(index)
                                        }
                                        .accessibilityIdentifier("settings.profile.delete")
                                    } label: {
                                        Image(systemName:"ellipsis")
                                            .frame(width:28,height:28)
                                    }
                                    .menuStyle(.borderlessButton).menuIndicator(.hidden)
                                }
                                providerEditor(index:index)
                            }
                        }
                    }

                    DisclosureGroup("JoyCode") {
                        VStack(alignment:.leading,spacing:10) {
                    settingsField("JoyCode 模型") {
                        TextField("JoyAI-Code-1.6",text:$joyCodeModel)
                            .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                            .accessibilityIdentifier("settings.joycode-model")
                    }
                    HStack(spacing:7) {
                        Circle().fill(model.localApiSettings?.joyCodeReady == true ? Color.green : Color.orange)
                            .frame(width:7,height:7)
                        Text(model.localApiSettings?.joyCodeReady == true
                             ? "已登录 JoyCode。"
                             : "尚未登录 JoyCode。")
                            .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                    }

                        }
                    }
                    .font(.system(size:12))

                    HStack(spacing:10) {
                        Spacer()
                        Button(saving ? "保存中…" : "保存更改") {
                            saveApiSettings()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(saveDisabled)
                        .accessibilityIdentifier("settings.save")
                    }
                    .frame(maxWidth:514,alignment:.trailing)

                    Text("API Key 安全保存在 macOS 钥匙串中。")
                        .font(.system(size:11)).foregroundStyle(.tertiary)
                }
                .padding(.vertical,10)

                RuntimeSettingsSection(model:model)
            }
            .padding(.horizontal,24).padding(.vertical,24)
            .frame(maxWidth:760,alignment:.leading)
            .frame(maxWidth:.infinity,alignment:.center)
        }
        .task(id:settingsSignature) {
            syncSettingsDraft()
            connectionFeedback=nil
        }
        .onChange(of:profiles) { _ in connectionFeedback=nil }
        .alert("删除 API Key？", isPresented: Binding(
            get: { credentialToDelete != nil },
            set: { if !$0 { credentialToDelete=nil } }
        )) {
            Button("删除", role:.destructive) {
                guard let credentialToDelete else { return }
                deleteCredential(credentialToDelete)
                self.credentialToDelete=nil
            }
            .accessibilityIdentifier("settings.credential.delete.confirm")
            Button("取消", role:.cancel) { credentialToDelete=nil }
        } message: {
            Text("删除后，使用此 API Key 的模型服务将无法连接，直到重新配置密钥。")
        }
    }

    @ViewBuilder
    private func providerEditor(index:Int) -> some View {
        VStack(alignment:.leading,spacing:11) {
            settingsField("名称") {
                TextField("服务名称",text:$profiles[index].label)
                    .textFieldStyle(.plain)
                    .accessibilityIdentifier("settings.profile.name")
            }
            settingsField("服务地址") {
                TextField("https://api.example.com",text:$profiles[index].endpoint)
                    .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                    .accessibilityIdentifier("settings.endpoint")
            }
            settingsField("模型 ID") {
                TextField("模型 ID",text:$profiles[index].model)
                    .textFieldStyle(.plain).font(.system(size:11.5,design:.monospaced))
                    .accessibilityIdentifier("settings.model")
            }
            HStack(spacing:12) {
                Text("API 协议").font(.system(size:10.5,weight:.medium))
                    .foregroundStyle(ForgePalette.secondary).frame(width:82,alignment:.leading)
                Picker("API 协议",selection:$profiles[index].apiProtocol) {
                    Text("OpenAI Chat").tag("openai")
                    Text("OpenAI Responses").tag("responses")
                    Text("Anthropic").tag("anthropic")
                }
                .labelsHidden().pickerStyle(.menu).frame(maxWidth:300,alignment:.leading)
                .accessibilityIdentifier("settings.api-protocol")
            }

            let endpoint=profiles[index].endpoint.trimmingCharacters(in:.whitespacesAndNewlines)
            if endpoint == "https://zro.moonmath.ai/v1" {
                Text("此配置使用 Zro 自己的登录信息，无需在 Forge 重复输入 API Key。")
                    .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
            } else if endpoint.lowercased().hasPrefix("http://localhost")
                        || endpoint.lowercased().hasPrefix("http://127.0.0.1") {
                Text("本机服务不需要 API Key。")
                    .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
            } else {
                settingsField("API Key") {
                    Picker("API Key",selection:$profiles[index].credentialRef) {
                        Text("未选择").tag(nil as String?)
                        ForEach(model.managedApiCredentials.filter { $0.endpoint == endpoint }) { credential in
                            Text("\(credential.label) · \(credential.authorized ? "已授权" : "未授权")")
                                .tag(Optional(credential.credentialRef))
                        }
                    }
                    .labelsHidden().pickerStyle(.menu)
                    .accessibilityIdentifier("settings.credential")
                }
                HStack(spacing:10) {
                    Button("从剪贴板粘贴并授权") { importCredential(index:index) }
                        .buttonStyle(.forgeText)
                        .accessibilityIdentifier("settings.credential.import")
                        .disabled(saving || model.settingsLoading || endpoint.isEmpty)
                    if let credential=selectedCredential(index:index) {
                        Button("从剪贴板更新 API Key") { rotateCredential(credential.credentialRef) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings.credential.rotate")
                        Button(credential.authorized ? "撤销授权" : "授权使用") {
                            setCredentialAuthorization(credential.credentialRef,!credential.authorized)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("settings.credential.authorization")
                        Button("删除 API Key",role:.destructive) {
                            credentialToDelete=credential.credentialRef
                        }
                        .buttonStyle(.plain).foregroundStyle(.red)
                        .accessibilityIdentifier("settings.credential.delete")
                    }
                }
                if let credential=selectedCredential(index:index) {
                    Text("\(credential.hasSecret ? "密钥已保存" : "密钥未找到") · \(credential.authorized ? "已授权使用" : "尚未授权")")
                        .font(.system(size:10.5)).foregroundStyle(ForgePalette.secondary)
                        .accessibilityIdentifier("settings.credential.status")
                }
            }
            HStack(spacing:9) {
                Button(testingProfileId == profiles[index].id ? "验证中…" : "测试连接") {
                    testConnection(profiles[index])
                }
                .buttonStyle(.forgeText)
                .disabled(testingProfileId != nil || saving || model.settingsLoading || !profileReady(profiles[index]))
                .accessibilityIdentifier("settings.profile.test-connection")
                if testingProfileId == profiles[index].id {
                    ProgressView().controlSize(.small)
                }
            }
            if let feedback=connectionFeedback, feedback.profileId == profiles[index].id {
                Text(feedback.message)
                    .font(.system(size:11))
                    .foregroundStyle(feedback.passed ? Color.green : Color.red)
                    .accessibilityIdentifier("settings.profile.connection-result")
            }
            Text("会向当前模型发送一条短消息，可能产生少量 API 费用。")
                .font(.system(size:10.5)).foregroundStyle(.tertiary)
        }
        .padding(.vertical,6)
    }

    private var selectedProfileIndex:Int? {
        profiles.firstIndex { $0.id == selectedProfileId }
    }

    private var selectedProviderLabel:String {
        if model.selectedProvider == "codex" { return "Codex" }
        if model.selectedProvider == "joycode" { return "JoyCode" }
        return model.selectedApiProfile?.label ?? "API 服务"
    }

    private var settingsSignature:String {
        guard let settings=model.localApiSettings else { return "none" }
        let rows=settings.profiles.map {
            [$0.id,$0.label,$0.endpoint,$0.model,$0.apiProtocol,$0.credentialRef ?? ""].joined(separator:"|")
        }.joined(separator:";")
        return [settings.defaultProvider,rows,settings.joyCodeModel].joined(separator:"::")
    }

    private var saveDisabled:Bool {
        if saving || model.settingsLoading || joyCodeModel.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
            return true
        }
        if profiles.contains(where: {
            $0.label.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                || $0.endpoint.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
                || $0.model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty
        }) { return true }
        if defaultProvider == "joycode" && model.localApiSettings?.joyCodeReady != true { return true }
        return false
    }

    private func syncSettingsDraft() {
        guard let settings=model.localApiSettings else { return }
        defaultProvider=settings.defaultProvider
        profiles=settings.profiles.map(ProviderProfileDraft.init)
        if let id=settings.defaultProvider.split(separator:":",maxSplits:1).dropFirst().first,
           profiles.contains(where:{$0.id == String(id)}) {
            selectedProfileId=String(id)
        } else if !profiles.contains(where:{$0.id == selectedProfileId}) {
            selectedProfileId=profiles.first?.id ?? ""
        }
        joyCodeModel=settings.joyCodeModel
    }

    private func addProfile(label:String,endpoint:String,model:String,apiProtocol:String) {
        let id="profile-" + UUID().uuidString.prefix(8).lowercased()
        let profile=ProviderProfileDraft(
            id:String(id),label:label,endpoint:endpoint,model:model,apiProtocol:apiProtocol
        )
        profiles.append(profile)
        selectedProfileId=profile.id
    }

    private func deleteProfile(_ index:Int) {
        guard profiles.indices.contains(index) else { return }
        let providerId=profiles[index].providerId
        profiles.remove(at:index)
        if defaultProvider == providerId { defaultProvider="codex" }
        selectedProfileId=profiles.first?.id ?? ""
    }

    private func existingProfile(_ id:String) -> ApiProviderProfileDetail? {
        model.localApiSettings?.profiles.first { $0.id == id }
    }

    private func profileReady(_ profile:ProviderProfileDraft) -> Bool {
        guard let saved=existingProfile(profile.id), saved.endpointReady else { return false }
        return saved.label == profile.label
            && saved.endpoint == profile.endpoint
            && saved.model == profile.model
            && saved.apiProtocol == profile.apiProtocol
            && saved.credentialRef == profile.credentialRef
    }

    private func profileReadiness(_ profile:ProviderProfileDraft) -> String {
        guard profileReady(profile) else { return "有未保存更改或配置不完整" }
        if let feedback=connectionFeedback, feedback.profileId == profile.id {
            return feedback.passed ? "已保存 · 本次连接正常" : "已保存 · 本次连接失败"
        }
        return "已保存 · 尚未验证"
    }

    private func testConnection(_ profile:ProviderProfileDraft) {
        guard testingProfileId == nil, !saving, !model.settingsLoading, profileReady(profile) else { return }
        testingProfileId=profile.id
        connectionFeedback=nil
        Task {
            let outcome: (passed:Bool,message:String)
            do {
                try await model.testSavedApiProfile(providerId:profile.providerId)
                outcome=(true,"模型已响应，连接正常。")
            } catch {
                let raw=error.localizedDescription
                let detail:String
                if raw.contains("HTTP_401") || raw.contains("HTTP_403") {
                    detail="认证失败，请检查 API Key 和授权。"
                } else if raw.contains("HTTP_404") {
                    detail="模型或接口不存在，请检查模型 ID 和服务地址。"
                } else if raw.contains("HTTP_429") {
                    detail="请求受限，请检查额度或稍后重试。"
                } else if raw.contains("REQUEST_FAILED") {
                    detail="无法连接到服务，请检查网络和 Endpoint。"
                } else if raw.contains("PROFILE_NOT_READY") {
                    detail="当前配置未就绪，请先保存并确认授权。"
                } else {
                    detail="连接失败：\(raw)"
                }
                outcome=(false,detail)
            }
            if profiles.contains(profile) {
                connectionFeedback=(profile.id,outcome.passed,outcome.message)
            }
            testingProfileId=nil
        }
    }

    private func saveApiSettings() {
        guard !saveDisabled else { return }
        saving=true
        let details=profiles.map { $0.detail(existing:existingProfile($0.id)) }
        Task {
            _ = await model.saveLocalApiSettings(
                defaultProvider:defaultProvider,
                profiles:details,
                joyCodeModel:joyCodeModel
            )
            saving=false
        }
    }

    private func selectedCredential(index:Int) -> ManagedApiCredentialDetail? {
        guard profiles.indices.contains(index), let ref=profiles[index].credentialRef else { return nil }
        return model.managedApiCredentials.first { $0.credentialRef == ref }
    }

    private func importCredential(index:Int) {
        guard !saving, profiles.indices.contains(index) else { return }
        let endpoint=profiles[index].endpoint
        saving=true
        Task {
            if let credentialRef=await model.createManagedApiCredential(endpoint:endpoint,label:profiles[index].label) {
                profiles[index].credentialRef=credentialRef
            }
            saving=false
        }
    }

    private func rotateCredential(_ credentialRef:String) {
        guard !saving else { return }
        saving=true
        Task { _ = await model.rotateManagedApiCredential(credentialRef); saving=false }
    }

    private func setCredentialAuthorization(_ credentialRef:String,_ authorized:Bool) {
        guard !saving else { return }
        saving=true
        Task { _ = await model.setManagedApiCredentialAuthorization(credentialRef,authorized:authorized); saving=false }
    }

    private func deleteCredential(_ credentialRef:String) {
        guard !saving else { return }
        saving=true
        Task {
            if await model.deleteManagedApiCredential(credentialRef) {
                for index in profiles.indices where profiles[index].credentialRef == credentialRef {
                    profiles[index].credentialRef=nil
                }
            }
            saving=false
        }
    }

    @ViewBuilder
    private func settingsField<Content:View>(_ label:String,@ViewBuilder content:() -> Content) -> some View {
        // Label-left form row; the field itself carries no box or card.
        HStack(alignment:.firstTextBaseline,spacing:12) {
            Text(label).font(.system(size:11.5))
                .foregroundStyle(ForgePalette.secondary)
                .frame(width:82,alignment:.leading)
            content()
                .padding(.vertical,5)
                .frame(maxWidth:420,alignment:.leading)
                .overlay(alignment:.bottom) {
                    Rectangle().fill(ForgePalette.hairline).frame(height:1)
                }
        }
        .frame(minHeight:30)
    }

    private func settingMeta(_ label:String,_ value:String) -> some View {
        VStack(alignment:.leading,spacing:3) {
            Text(label).font(.system(size:9.5,weight:.medium)).foregroundStyle(.tertiary)
            Text(value)
                .font(.system(size:11.5,weight:.medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .help(value)
                .textSelection(.enabled)
        }
        .frame(maxWidth:.infinity,alignment:.leading)
    }
}
