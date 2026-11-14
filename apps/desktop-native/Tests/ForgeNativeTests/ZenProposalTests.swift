import XCTest
@testable import ForgeNative

final class ZenProposalTests: XCTestCase {
    private let fence=String(repeating:"\u{60}",count:3)

    private func fenced(_ payload:String) -> String {
        "AI 推荐如下：\n" + fence + "forge-proposal\n" + payload + "\n" + fence
    }

    func testCreateRequirementIsParsedOnlyFromOneExplicitProposal() throws {
        let proposal=try ZenChangeProposal.parse(fenced(
            #"{"decision":"ACCEPT","operation":"create_requirement","rationale":"独立验收目标","title":"PDF 定位","outcome":"可定位源页","acceptanceCriteria":["定位准确"]}"#
        ))
        XCTAssertEqual(proposal.operation,.createRequirement)
        XCTAssertEqual(proposal.title,"PDF 定位")
        XCTAssertEqual(proposal.acceptanceCriteria,["定位准确"])
    }

    func testReviseRequirementRequiresOriginalRevisionAndCriteria() throws {
        let proposal=try ZenChangeProposal.parse(fenced(
            #"{"decision":"ACCEPT","operation":"revise_requirement","rationale":"细化已有需求","targetId":"REQ-1","expectedRevision":3,"title":"需求","outcome":"新目标","acceptanceCriteria":[]}"#
        ))
        XCTAssertEqual(proposal.expectedRevision,3)
        XCTAssertEqual(proposal.targetId,"REQ-1")
        XCTAssertThrowsError(try ZenChangeProposal.parse(fenced(
            #"{"decision":"ACCEPT","operation":"revise_requirement","rationale":"缺少验收标准","targetId":"REQ-1","expectedRevision":3,"title":"需求","outcome":"新目标"}"#
        )))
    }

    @MainActor
    func testZenExecutionUsesResumeForDetachedRunningRunAndReconcilesUnknownOutcome() throws {
        func status(_ state:String,active:Bool=false,ready:Bool=true,authorized:Bool=true) throws -> AutopilotStatusDetail {
            var data:[String:Any] = [
                "run":["status":state],"runtimeActive":active,"providerReady":ready
            ]
            if authorized { data["grant"] = ["grantId":"grant-one"] }
            return try XCTUnwrap(NativeWorkspace.autopilotStatusDetail(["data":data]))
        }
        let detached=try status("running")
        XCTAssertEqual(ZenWorkspacePane.executionOperation(status:detached,outcomeUnknown:false),"resume")
        XCTAssertEqual(ZenWorkspacePane.executionLabel(operation:"resume",runStatus:"running"),"恢复执行")
        XCTAssertEqual(ZenWorkspacePane.executionOperation(status:try status("running",active:true),outcomeUnknown:false),"pause")
        XCTAssertEqual(ZenWorkspacePane.executionOperation(status:try status("paused"),outcomeUnknown:false),"resume")
        XCTAssertEqual(ZenWorkspacePane.executionOperation(status:try status("failed"),outcomeUnknown:false),"resume")
        XCTAssertEqual(ZenWorkspacePane.executionOperation(status:try status("idle"),outcomeUnknown:false),"start")
        XCTAssertEqual(ZenWorkspacePane.executionOperation(status:try status("idle",authorized:false),outcomeUnknown:false),"authorize")
        XCTAssertNil(ZenWorkspacePane.executionOperation(status:try status("paused",ready:false),outcomeUnknown:false))
        XCTAssertNil(ZenWorkspacePane.executionOperation(status:detached,outcomeUnknown:true))
        XCTAssertNil(ZenWorkspacePane.executionOperation(status:nil,outcomeUnknown:false))
    }

    func testRejectsAmbiguousOrUnsafeProposalContent() {
        let valid = fenced(
            #"{"decision":"ACCEPT","operation":"create_plan","rationale":"既有目标下增加方案","requirementId":"REQ-1","objective":"原生适配"}"#
        )
        XCTAssertThrowsError(try ZenChangeProposal.parse(valid + "\n" + valid))
        XCTAssertThrowsError(try ZenChangeProposal.parse("没有提案"))
        XCTAssertThrowsError(try ZenChangeProposal.parse(fenced(
            #"{"decision":"ACCEPT","operation":"revise_plan","rationale":"未验证版本","targetId":"PLAN-1","expectedRevision":0,"objective":"目标"}"#
        )))
        XCTAssertThrowsError(try ZenChangeProposal.parse(fenced(
            #"{"decision":"ACCEPT","operation":"delete_requirement","rationale":"非法操作","targetId":"REQ-1"}"#
        )))
        XCTAssertThrowsError(try ZenChangeProposal.parse(fenced(
            #"{"decision":"CONTINUE","operation":"create_plan","rationale":"尚未接受","requirementId":"REQ-1","objective":"原生适配"}"#
        )))
    }
}
