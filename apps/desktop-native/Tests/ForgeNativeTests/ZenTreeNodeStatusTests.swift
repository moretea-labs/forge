import XCTest
@testable import ForgeNative

final class ZenTreeNodeStatusTests: XCTestCase {
    private func record(
        _ id:String,
        kind:SemanticRecordKind,
        state:String = "open",
        requirementId:String? = nil
    ) -> ForgeRecord {
        ForgeRecord(
            recordId:id,title:id,state:state,kind:kind,depth:0,
            requirementId:requirementId,parentPlanId:nil
        )
    }

    private func status(
        runStatus:String? = nil,
        currentPlanId:String? = nil,
        runtimeActive:Bool = false,
        authorized:Bool = false,
        requiresReapproval:Bool = false,
        stopReason:String? = nil
    ) -> AutopilotStatusDetail {
        AutopilotStatusDetail(
            authorized:authorized,provider:nil,providerReady:true,
            runtimeActive:runtimeActive,requiresReapproval:requiresReapproval,
            requirementRevision:nil,approvedRevision:nil,runStatus:runStatus,
            runId:nil,stopReason:stopReason,currentPlanId:currentPlanId,
            lastSummary:nil,evidenceRefs:[],updatedAt:nil,model:nil,
            promptTokens:0,completionTokens:0,totalTokens:0,maxTotalTokens:nil,
            turns:0,maxTurns:nil,toolCalls:0,maxToolCalls:nil,checkpointPlanIds:[]
        )
    }

    func testRequirementLifecycleOverridesStaleExecutionStatus() {
        let active=status(runStatus:"running",currentPlanId:"PLAN-A",runtimeActive:true)
        let statuses=["REQ-A":active]
        let completed=record("REQ-A",kind:.requirement,state:"completed")
        let cancelled=record("REQ-A",kind:.requirement,state:"cancelled")

        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:completed,root:completed,executionStatuses:statuses)?.label,
            "已完成"
        )
        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:cancelled,root:cancelled,executionStatuses:statuses)?.label,
            "已取消"
        )
    }

    func testOnlyTheCurrentPlanShowsLiveExecutionState() {
        let root=record("REQ-A",kind:.requirement)
        let current=record("PLAN-A",kind:.plan,requirementId:root.recordId)
        let other=record("PLAN-B",kind:.plan,requirementId:root.recordId)
        let statuses=[root.recordId:status(
            runStatus:"running",currentPlanId:current.recordId,runtimeActive:true
        )]

        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:root,root:root,executionStatuses:statuses)?.label,
            "执行中"
        )
        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:current,root:root,executionStatuses:statuses)?.label,
            "当前执行"
        )
        XCTAssertNil(
            ZenWorkspacePane.nodeStatus(for:other,root:root,executionStatuses:statuses)
        )
    }

    func testHumanCheckpointAndReapprovalAreVisibleWithoutInventingPlanStatus() {
        let root=record("REQ-A",kind:.requirement)
        let plan=record("PLAN-A",kind:.plan,requirementId:root.recordId)
        let checkpoint=status(
            runStatus:"paused",currentPlanId:plan.recordId,
            stopReason:"human_checkpoint:\(plan.recordId)"
        )
        let statuses=[root.recordId:checkpoint]

        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:root,root:root,executionStatuses:statuses)?.label,
            "等待确认"
        )
        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:plan,root:root,executionStatuses:statuses)?.label,
            "等待确认"
        )

        let approval=["REQ-A":status(requiresReapproval:true)]
        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:root,root:root,executionStatuses:approval)?.label,
            "需重新批准"
        )
        XCTAssertNil(
            ZenWorkspacePane.nodeStatus(for:plan,root:root,executionStatuses:approval)
        )
    }

    func testPlanTypeMarkerDoesNotAppearAsLifecycleOrExecutionStatus() {
        let root=record("REQ-A",kind:.requirement)
        let plan=record("PLAN-A",kind:.plan,state:"Plan",requirementId:root.recordId)
        XCTAssertNil(
            ZenWorkspacePane.nodeStatus(for:plan,root:root,executionStatuses:[:])
        )
    }
}

extension ZenTreeNodeStatusTests {
    func testStaleRunningReceiptAndCompletedRunRemainDistinctFromRequirementLifecycle() {
        let root=record("REQ-A",kind:.requirement)
        let stale=["REQ-A":status(
            runStatus:"running",currentPlanId:"PLAN-A",runtimeActive:false
        )]
        let completedRun=["REQ-A":status(
            runStatus:"completed",currentPlanId:"PLAN-A",runtimeActive:false
        )]

        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:root,root:root,executionStatuses:stale)?.label,
            "运行未激活"
        )
        XCTAssertEqual(
            ZenWorkspacePane.nodeStatus(for:root,root:root,executionStatuses:completedRun)?.label,
            "执行完成"
        )
        XCTAssertEqual(ZenWorkspacePane.inspectorLifecycleLabel(for:root),"未完成")
    }
}
