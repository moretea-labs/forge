import XCTest
@testable import ForgeNative

final class ZenModeTests: XCTestCase {
    @MainActor
    func testZenProjectSwitchIsBlockedDuringAutomaticRefinementBetweenRounds() {
        XCTAssertTrue(NativeWorkspace.zenProjectSwitchAllowed(busy:false,refinementActive:false))
        XCTAssertFalse(NativeWorkspace.zenProjectSwitchAllowed(busy:false,refinementActive:true))
        XCTAssertFalse(NativeWorkspace.zenProjectSwitchAllowed(busy:true,refinementActive:false))
        XCTAssertFalse(NativeWorkspace.zenProjectSwitchAllowed(busy:true,refinementActive:true))
    }

    func testAutomaticRefinementProtectsConversationIdentityBetweenRounds() {
        let refinementThreadId="thread-a"
        XCTAssertFalse(NativeWorkspace.zenRefinementAllowsConversationContextMutation(refinementActive:true))
        XCTAssertTrue(NativeWorkspace.zenRefinementAllowsConversationContextMutation(refinementActive:false))
        XCTAssertTrue(NativeWorkspace.zenRefinementAllowsThreadSelection(
            refinementActive:true,refinementThreadId:refinementThreadId,requestedThreadId:refinementThreadId
        ))
        XCTAssertFalse(NativeWorkspace.zenRefinementAllowsThreadSelection(
            refinementActive:true,refinementThreadId:refinementThreadId,requestedThreadId:"thread-b"
        ))
        XCTAssertFalse(NativeWorkspace.zenRefinementAllowsThreadSelection(
            refinementActive:true,refinementThreadId:nil,requestedThreadId:"thread-b"
        ))
        XCTAssertFalse(NativeWorkspace.zenRefinementAllowsThreadDeletion(
            refinementActive:true,refinementThreadId:refinementThreadId,
            selectedThreadId:refinementThreadId,targetThreadId:refinementThreadId
        ))
        XCTAssertFalse(NativeWorkspace.zenRefinementAllowsThreadDeletion(
            refinementActive:true,refinementThreadId:refinementThreadId,
            selectedThreadId:"thread-b",targetThreadId:"thread-b"
        ))
        XCTAssertTrue(NativeWorkspace.zenRefinementAllowsThreadDeletion(
            refinementActive:true,refinementThreadId:refinementThreadId,
            selectedThreadId:refinementThreadId,targetThreadId:"old-history"
        ))
        XCTAssertTrue(NativeWorkspace.zenRefinementAllowsThreadDeletion(
            refinementActive:false,refinementThreadId:refinementThreadId,
            selectedThreadId:refinementThreadId,targetThreadId:refinementThreadId
        ))
    }

    func testZenBoardOnlyReportsRunningFromLiveRuntimeReceipt() {
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"open",runtimeActive:false),.todo)
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"open",runtimeActive:true),.running)
    }

    func testCompletedRequirementTakesPrecedenceOverStaleRuntimeState() {
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"completed",runtimeActive:false),.done)
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"completed",runtimeActive:true),.done)
    }

    func testUnknownRequirementStateDoesNotFabricateCompletion() {
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"unknown",runtimeActive:false),.todo)
    }

    func testOnlyAutopilotNodeActionsRequireARepositoryBinding() {
        XCTAssertFalse(ZenNodeAction.addPlan.requiresRepository)
        XCTAssertFalse(ZenNodeAction.edit.requiresRepository)
        XCTAssertFalse(ZenNodeAction.optimize.requiresRepository)
        XCTAssertFalse(ZenNodeAction.review.requiresRepository)
        XCTAssertFalse(ZenNodeAction.complete.requiresRepository)
        XCTAssertFalse(ZenNodeAction.cancel.requiresRepository)
        XCTAssertTrue(ZenNodeAction.toggleExecution.requiresRepository)
        XCTAssertTrue(ZenNodeAction.executionSettings.requiresRepository)
    }
}

extension ZenModeTests {
    @MainActor
    func testWorkbenchEntryAlwaysResetsToBoardAndClearsStaleTaskFocus() {
        let url=FileManager.default.temporaryDirectory
            .appendingPathComponent("forge-workbench-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at:url) }
        let model=NativeWorkspace(store:url)
        model.zenScreen = .canvas
        model.zenFocusedRequirementId = "REQ-OLD-PROJECT"

        model.show(.agent)
        model.openWorkbench()

        XCTAssertTrue(model.zenMode)
        XCTAssertEqual(model.page,.requirement)
        XCTAssertEqual(model.zenScreen,.board)
        XCTAssertNil(model.zenFocusedRequirementId)
    }

    @MainActor
    func testZenIsDefaultWithEmptyConversationStoreAndAgentNavigationIsExplicit() {
        let url=FileManager.default.temporaryDirectory
            .appendingPathComponent("forge-zen-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at:url) }
        let model=NativeWorkspace(store:url)
        XCTAssertTrue(model.zenMode)
        XCTAssertEqual(model.page,.requirement)
        XCTAssertEqual(model.threads.count,1)
        XCTAssertTrue(model.navigationBackStack.isEmpty)

        model.openWorkbench()
        XCTAssertEqual(model.page,.requirement)
        XCTAssertTrue(model.navigationBackStack.isEmpty)

        model.show(.agent)
        XCTAssertFalse(model.zenMode)
        XCTAssertEqual(model.page,.agent)
        model.goBack()
        XCTAssertTrue(model.zenMode)
        XCTAssertEqual(model.page,.requirement)
        XCTAssertTrue(model.navigationBackStack.isEmpty)

        model.show(.agent)
        XCTAssertFalse(model.zenMode)
        XCTAssertEqual(model.page,.agent)
    }
}

extension ZenModeTests {
    func testLocalKanbanUsesCanonicalRequirementAndPlanFacts() {
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"open",runtimeActive:false,hasPlan:true),.planned)
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"open",runtimeActive:true,hasPlan:true),.running)
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"completed",runtimeActive:true,hasPlan:true),.done)
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"cancelled",runtimeActive:true,hasPlan:true),.cancelled)
        XCTAssertEqual(ZenBoardBucket.classify(requirementState:"open",runtimeActive:false,hasPlan:false),.todo)
    }
}

extension ZenModeTests {
    func testCreatedPlanReadbackRequiresTheExactPlanRecord() {
        let requirement=ForgeRecord(recordId:"PLAN-NEW",title:"same id requirement",state:"open",
                                    kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        let plan=ForgeRecord(recordId:"PLAN-NEW",title:"created plan",state:"open",
                             kind:.plan,depth:1,requirementId:nil,parentPlanId:nil)
        XCTAssertNil(ZenWorkspacePane.createdPlanRecord("PLAN-NEW",in:[requirement]))
        XCTAssertNil(ZenWorkspacePane.createdPlanRecord("PLAN-MISSING",in:[plan]))
        XCTAssertEqual(ZenWorkspacePane.createdPlanRecord("PLAN-NEW",in:[requirement,plan])?.title,
                       "created plan")
    }

    func testCreatedRequirementReadbackRequiresTheExactRequirementRecord() {
        let plan=ForgeRecord(recordId:"REQ-NEW",title:"same id plan",state:"open",
                             kind:.plan,depth:1,requirementId:nil,parentPlanId:nil)
        let requirement=ForgeRecord(recordId:"REQ-NEW",title:"created task",state:"open",
                                     kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        XCTAssertNil(ZenWorkspacePane.createdRequirementRecord("REQ-NEW",in:[plan]))
        XCTAssertNil(ZenWorkspacePane.createdRequirementRecord("REQ-MISSING",in:[requirement]))
        XCTAssertEqual(ZenWorkspacePane.createdRequirementRecord("REQ-NEW",in:[plan,requirement])?.title,
                       "created task")
    }

    func testCreatedRecordDetailRequiresMatchingIdentityAndProjection() {
        let requirement = ForgeRecord(
            recordId:"REQ-NEW",title:"created task",state:"open",kind:.requirement,
            depth:0,requirementId:"REQ-NEW",parentPlanId:nil
        )
        let requirementDetail = RequirementRecordDetail(
            requirementId:"REQ-NEW",revision:1,title:"created task",outcomeStatement:"Ship safely",
            state:"open",acceptanceCriteria:["Works"],progressSummary:"",
            remainingWork:[],acceptedEvidenceRefs:[],taskStatus:"planned",priority:"normal",
            assignee:nil,dependencyRequirementIds:[],dependencyRequirements:[],
            blockingDependencyIds:[],dependentRequirements:nil,
            dependentRequirementsTruncated:nil,dependentRequirementCount:nil
        )
        XCTAssertTrue(ZenWorkspacePane.createdRecordDetailMatches(
            requirement,detail:.requirement(requirementDetail)
        ))
        XCTAssertFalse(ZenWorkspacePane.createdRecordDetailMatches(requirement,detail:nil))
        XCTAssertFalse(ZenWorkspacePane.createdRecordDetailMatches(
            requirement,detail:.requirement(RequirementRecordDetail(
                requirementId:"REQ-NEW",revision:1,title:"stale title",outcomeStatement:"Ship safely",
                state:"open",acceptanceCriteria:["Works"],progressSummary:"",
                remainingWork:[],acceptedEvidenceRefs:[],taskStatus:"planned",priority:"normal",
                assignee:nil,dependencyRequirementIds:[],dependencyRequirements:[],
                blockingDependencyIds:[],dependentRequirements:nil,
                dependentRequirementsTruncated:nil,dependentRequirementCount:nil
            ))
        ))
        XCTAssertFalse(ZenWorkspacePane.createdRecordDetailMatches(
            requirement,detail:.requirement(RequirementRecordDetail(
                requirementId:"REQ-OTHER",revision:1,title:"created task",outcomeStatement:"Ship safely",
                state:"open",acceptanceCriteria:["Works"],progressSummary:"",
                remainingWork:[],acceptedEvidenceRefs:[],taskStatus:"planned",priority:"normal",
                assignee:nil,dependencyRequirementIds:[],dependencyRequirements:[],
                blockingDependencyIds:[],dependentRequirements:nil,
                dependentRequirementsTruncated:nil,dependentRequirementCount:nil
            ))
        ))

        let plan = ForgeRecord(
            recordId:"PLAN-NEW",title:"Root plan",state:"Plan",kind:.plan,
            depth:1,requirementId:"REQ-NEW",parentPlanId:nil
        )
        let planDetail = PlanRecordDetail(
            planId:"PLAN-NEW",revision:1,requirementId:"REQ-NEW",parentPlanId:nil,
            requirementBasisRevision:nil,sourceBasisRevision:nil,
            goal:"Root plan",items:[],resolvedDecisions:[],nonGoals:[]
        )
        XCTAssertTrue(ZenWorkspacePane.createdRecordDetailMatches(plan,detail:.plan(planDetail)))
        XCTAssertFalse(ZenWorkspacePane.createdRecordDetailMatches(
            plan,detail:.plan(PlanRecordDetail(
                planId:"PLAN-NEW",revision:1,requirementId:"REQ-NEW",parentPlanId:"PLAN-OTHER",
                requirementBasisRevision:nil,sourceBasisRevision:nil,
                goal:"Root plan",items:[],resolvedDecisions:[],nonGoals:[]
            ))
        ))
        XCTAssertFalse(ZenWorkspacePane.createdRecordDetailMatches(
            plan,detail:.requirement(requirementDetail)
        ))
    }

    func testRequirementBoardSortPreservesSourceOrderAndUsesStablePriorityRanking() {
        func task(_ id:String,_ title:String,_ priority:String?) -> ForgeRecord {
            ForgeRecord(
                recordId:id,title:title,state:"open",kind:.requirement,depth:0,
                requirementId:nil,parentPlanId:nil,priority:priority
            )
        }
        let items=[
            task("REQ-normal","Normal","normal"),
            task("REQ-urgent","Urgent","urgent"),
            task("REQ-unset","Unset",nil),
            task("REQ-high-a","High A","high"),
            task("REQ-low","Low","low"),
            task("REQ-high-b","High B","high")
        ]
        XCTAssertEqual(
            ZenWorkspacePane.sortRequirements(items,order:.source).map(\.recordId),
            items.map(\.recordId)
        )
        XCTAssertEqual(
            ZenWorkspacePane.sortRequirements(items,order:.priority).map(\.recordId),
            ["REQ-urgent","REQ-high-a","REQ-high-b","REQ-normal","REQ-low","REQ-unset"]
        )
        XCTAssertEqual(
            ZenWorkspacePane.sortRequirements(items,order:.title).map(\.recordId),
            ["REQ-high-a","REQ-high-b","REQ-low","REQ-normal","REQ-unset","REQ-urgent"]
        )
        XCTAssertEqual(items.map(\.recordId),["REQ-normal","REQ-urgent","REQ-unset","REQ-high-a","REQ-low","REQ-high-b"])
    }

    func testSearchMatchesTaskTitleIdAssigneeStatusAndPriorityWithoutMutatingSource() {
        let items = [
            ForgeRecord(recordId:"REQ-CANVAS-1",title:"画布交互优化",state:"open",
                        kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil,
                        taskStatus:"active",priority:"urgent",assignee:"editor"),
            ForgeRecord(recordId:"REQ-OTHER-2",title:"原生项目管理",state:"open",
                        kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        ]
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"  canvas  ").map(\.recordId),
                       ["REQ-CANVAS-1"])
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"  项目管理 ").map(\.recordId),
                       ["REQ-OTHER-2"])
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"editor").map(\.recordId),
                       ["REQ-CANVAS-1"])
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"进行中").map(\.recordId),
                       ["REQ-CANVAS-1"])
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"紧急").map(\.recordId),
                       ["REQ-CANVAS-1"])
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"无匹配").count,0)
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"  ").count,2)
        XCTAssertEqual(items.count,2)
    }
}

extension ZenModeTests {
    func testUnifiedSidebarSelectionUsesCurrentPageWithoutDuplicateModeState() {
        XCTAssertEqual(ForgeSidebarDestination.resolve(zenMode:true,page:.requirement),.workbench)
        XCTAssertEqual(ForgeSidebarDestination.resolve(zenMode:true,page:.agent),.workbench)

        let cases: [(NativePage,ForgeSidebarDestination)] = [
            (.agent,.agent),(.schedule,.automations),
            (.assets,.resources),(.knowledge,.resources),
            (.usage,.analytics),(.plugins,.settings),(.settings,.settings),
            (.requirement,.workbench),(.plan,.workbench)
        ]
        for (page,expected) in cases {
            XCTAssertEqual(ForgeSidebarDestination.resolve(zenMode:false,page:page),expected)
        }
    }
}

extension ZenModeTests {
    func testTreeGeometryKeepsEachPlanSubtreeTogetherAndCentersParents() {
        func plan(_ id:String,_ parent:String?) -> ForgeRecord {
            ForgeRecord(recordId:id,title:id,state:"open",kind:.plan,depth:1,
                        requirementId:"REQ-TREE",parentPlanId:parent)
        }
        let root=ForgeRecord(recordId:"REQ-TREE",title:"工作台",state:"open",
                             kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        let left=plan("LEFT",nil),right=plan("RIGHT",nil)
        let l1=plan("L1","LEFT"),l2=plan("L2","LEFT"),l3=plan("L3","LEFT")
        let r1=plan("R1","RIGHT")
        let rows=[[root],[left,right],[l1,l2,l3,r1]]
        let layout=ZenTreeGeometry(rows:rows,viewport:CGSize(width:600,height:470))
        let x:(ForgeRecord,Int)->CGFloat={layout.point(for:$0,row:$1).x}

        XCTAssertEqual(layout.parentById[l1.id],left.id)
        XCTAssertEqual(layout.parentById[r1.id],right.id)
        XCTAssertEqual(x(left,1),(x(l1,2)+x(l3,2))/2,accuracy:0.01)
        XCTAssertEqual(x(right,1),x(r1,2),accuracy:0.01)
        XCTAssertEqual(x(root,0),(x(left,1)+x(right,1))/2,accuracy:0.01)
        XCTAssertLessThan(x(l3,2),x(r1,2))
        XCTAssertGreaterThanOrEqual(x(r1,2)-x(l3,2),ZenTreeGeometry.columnStep)
        XCTAssertGreaterThanOrEqual(layout.width,4*ZenTreeGeometry.columnStep+70)
        XCTAssertGreaterThan(ZenTreeGeometry.rowStep,ZenTreeGeometry.nodeHeight)
    }

    func testTreeGeometryCentersSingleRequirementInAvailableViewport() {
        let root=ForgeRecord(recordId:"REQ-ONE",title:"单节点",state:"open",
                             kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        let layout=ZenTreeGeometry(rows:[[root]],viewport:CGSize(width:900,height:500))
        XCTAssertEqual(layout.point(for:root,row:0).x,450,accuracy:0.01)
        XCTAssertEqual(layout.parentById.count,0)
        XCTAssertEqual(layout.width,900)
    }
}

extension ZenModeTests {
    func testSidebarRecentsAreQuickSwitchesWithoutDuplicatingCurrentProject() {
        let projects=["A","B","C","D"].map {
            ForgeProject(repoId:$0,displayName:$0,localRoot:nil,
                         checkoutId:nil,remoteUrl:nil,defaultBranch:nil)
        }
        var older=ChatThread()
        older.repoId="B"
        older.updatedAt=Date(timeIntervalSince1970:10)
        var newer=ChatThread()
        newer.repoId="C"
        newer.updatedAt=Date(timeIntervalSince1970:20)

        XCTAssertEqual(
            ZenSidebar.recentProjects(projects,threads:[older,newer],
                                      selectedRepoId:"A",limit:2).map(\.repoId),
            ["C","B"]
        )
        XCTAssertEqual(
            ZenSidebar.recentProjects(projects,threads:[older,newer],
                                      selectedRepoId:nil,limit:3).map(\.repoId),
            ["C","B"]
        )
        XCTAssertTrue(
            ZenSidebar.recentProjects(projects,threads:[],
                                      selectedRepoId:"D",limit:7).isEmpty
        )
    }
}

extension ZenModeTests {
    func testInspectorShowsOnlyKnownRequirementLifecycleNotPlanTypeMarker() {
        func record(_ state:String,kind:SemanticRecordKind) -> ForgeRecord {
            ForgeRecord(recordId:"REC",title:"Sample",state:state,kind:kind,depth:0,
                        requirementId:nil,parentPlanId:nil)
        }
        XCTAssertEqual(ZenWorkspacePane.inspectorLifecycleLabel(
            for:record("open",kind:.requirement)),"未完成")
        XCTAssertEqual(ZenWorkspacePane.inspectorLifecycleLabel(
            for:record("completed",kind:.requirement)),"已完成")
        XCTAssertEqual(ZenWorkspacePane.inspectorLifecycleLabel(
            for:record("cancelled",kind:.requirement)),"已取消")
        XCTAssertNil(ZenWorkspacePane.inspectorLifecycleLabel(
            for:record("Plan",kind:.plan)))
        XCTAssertNil(ZenWorkspacePane.inspectorLifecycleLabel(
            for:record("unknown",kind:.requirement)))
    }
}


extension ZenModeTests {
    func testBoardCompletionCountUsesSameDoneProjectionAsColumns() {
        let record:(String,String,String?) -> ForgeRecord = { id,state,status in
            ForgeRecord(recordId:id,title:id,state:state,kind:.requirement,depth:0,
                        requirementId:nil,parentPlanId:nil,taskStatus:status)
        }
        let items=[record("completed","completed","cancelled"),record("task-done","open","done"),
                   record("active","open","active"),record("cancelled","cancelled","done")]
        XCTAssertEqual(ZenBoardBucket.completedCount(items),2)
    }
}


extension ZenModeTests {
    func testProjectDetailUsesCanonicalLocalizedTaskStatusLabels() {
        XCTAssertEqual(ZenWorkspacePane.taskStatusLabel("planned"), "待开始")
        XCTAssertEqual(ZenWorkspacePane.taskStatusLabel("active"), "进行中")
        XCTAssertEqual(ZenWorkspacePane.taskStatusLabel("waiting_for_user"), "待你处理")
        XCTAssertEqual(ZenWorkspacePane.taskStatusLabel("done"), "已完成")
        XCTAssertEqual(ZenWorkspacePane.taskStatusLabel("cancelled"), "已取消")
        XCTAssertEqual(ZenWorkspacePane.taskStatusLabel("unknown"), "unknown")
        XCTAssertNil(ZenWorkspacePane.taskStatusLabel(nil))
    }
}

extension ZenModeTests {
    private func autopilotStatus(
        _ runStatus:String,runtimeActive:Bool=false,pendingProcessId:String?=nil
    ) throws -> AutopilotStatusDetail {
        var run:[String:Any] = ["status":runStatus]
        if let pendingProcessId { run["pendingProcessId"]=pendingProcessId }
        return try XCTUnwrap(NativeWorkspace.autopilotStatusDetail([
            "data":["runtimeActive":runtimeActive,"run":run]
        ]))
    }

    private func requirement(
        _ id:String,state:String="open",taskStatus:String?="active"
    ) -> ForgeRecord {
        ForgeRecord(recordId:id,title:id,state:state,kind:.requirement,depth:0,
                    requirementId:nil,parentPlanId:nil,taskStatus:taskStatus)
    }

    func testBoardAndListShareCanonicalPerRequirementAutopilotStatusProjection() throws {
        let active=requirement("REQ-active")
        let paused=try autopilotStatus("paused")
        let blocked=try autopilotStatus("blocked")
        let failed=try autopilotStatus("failed")

        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:active,executionStatuses:[active.recordId:paused]
        )?.label,"已暂停")
        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:active,executionStatuses:[active.recordId:blocked]
        )?.label,"受阻")
        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:active,executionStatuses:[active.recordId:failed]
        )?.label,"执行失败")
        XCTAssertEqual(ZenBoardBucket.classify(
            requirementState:active.state,taskStatus:active.taskStatus,runtimeActive:paused.runtimeActive
        ),.active)

        let running=requirement("REQ-running")
        let live=try autopilotStatus("running",runtimeActive:true)
        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:running,executionStatuses:[running.recordId:live]
        )?.label,"执行中")
        XCTAssertEqual(ZenBoardBucket.classify(
            requirementState:running.state,taskStatus:running.taskStatus,runtimeActive:live.runtimeActive
        ),.running)

        let inactive=try autopilotStatus("running",runtimeActive:false)
        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:running,executionStatuses:[running.recordId:inactive]
        )?.label,"运行未激活")
        XCTAssertEqual(ZenBoardBucket.classify(
            requirementState:running.state,taskStatus:running.taskStatus,runtimeActive:inactive.runtimeActive
        ),.active)

        let pending=try autopilotStatus("failed",pendingProcessId:"process-original")
        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:active,executionStatuses:[active.recordId:pending]
        )?.label,"等待原命令回执")

        let planned=requirement("REQ-planned",state:"planned",taskStatus:"planned")
        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:planned,executionStatuses:[planned.recordId:paused]
        )?.label,"已暂停")
    }

    @MainActor
    func testUnresolvedOutcomeOverridesTerminalRequirementUntilExactReadback() throws {
        let folder=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model=NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.selectedProjectId="project-a"
        model.repoId="repo-a"
        model.checkoutId="checkout-a"
        let completed=requirement("REQ-completed",state:"completed",taskStatus:"done")
        let cancelled=requirement("REQ-cancelled",state:"cancelled",taskStatus:"cancelled")
        let stale=try autopilotStatus("paused")

        XCTAssertEqual(ZenBoardBucket.classify(
            requirementState:completed.state,taskStatus:completed.taskStatus,runtimeActive:stale.runtimeActive
        ),.done)
        XCTAssertEqual(ZenBoardBucket.classify(
            requirementState:cancelled.state,taskStatus:cancelled.taskStatus,runtimeActive:stale.runtimeActive
        ),.cancelled)
        XCTAssertNil(ZenWorkspacePane.requirementExecutionStatus(
            for:completed,executionStatuses:[completed.recordId:stale]
        ))
        XCTAssertNil(ZenWorkspacePane.requirementExecutionStatus(
            for:cancelled,executionStatuses:[cancelled.recordId:stale]
        ))

        model.markAutopilotOutcomeUnknown(
            projectId:"project-a",repoId:"repo-a",checkoutId:"checkout-a",requirementId:completed.recordId
        )
        model.markAutopilotOutcomeUnknown(
            projectId:"project-a",repoId:"repo-a",checkoutId:"checkout-a",requirementId:cancelled.recordId
        )
        for item in [completed,cancelled] {
            XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
                for:item,executionStatuses:[item.recordId:stale],
                unresolvedOutcomeRequirementIds:model.unresolvedAutopilotRequirementIds
            )?.label,"操作结果未确认")
        }

        model.resolveAutopilotOutcomeUnknown(
            projectId:"project-a",repoId:"repo-a",checkoutId:"checkout-a",requirementId:completed.recordId
        )
        XCTAssertNil(ZenWorkspacePane.requirementExecutionStatus(
            for:completed,executionStatuses:[completed.recordId:stale],
            unresolvedOutcomeRequirementIds:model.unresolvedAutopilotRequirementIds
        ))
        XCTAssertEqual(ZenWorkspacePane.requirementExecutionStatus(
            for:cancelled,executionStatuses:[cancelled.recordId:stale],
            unresolvedOutcomeRequirementIds:model.unresolvedAutopilotRequirementIds
        )?.label,"操作结果未确认")
    }
}
