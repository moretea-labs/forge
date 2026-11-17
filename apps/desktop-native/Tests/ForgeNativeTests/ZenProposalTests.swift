import XCTest
@testable import ForgeNative

final class ZenProposalTests: XCTestCase {
    private let fence=String(repeating:"\u{60}",count:3)

    private func fenced(_ payload:String) -> String {
        "AI 推荐如下：\n" + fence + "forge-proposal\n" + payload + "\n" + fence
    }

    @MainActor
    func testZenProposalReviewSurvivesConversationSwitchWithoutRevivingSupersededAccept() throws {
        let proposalText=fenced(
            #"{"decision":"ACCEPT","operation":"create_requirement","rationale":"可验收","title":"PDF 定位","outcome":"可定位源页","acceptanceCriteria":["准确定位"]}"#
        )
        var accepted=ChatThread(repoId:"repo-a",checkoutId:"checkout-a",readOnly:true,
            readOnlyRepoId:"repo-a",readOnlyCheckoutId:"checkout-a")
        accepted.messages=[ChatMessage(role:"assistant",text:proposalText)]
        accepted.updatedAt=Date(timeIntervalSince1970:100)
        var ordinary=ChatThread(repoId:"repo-a",checkoutId:"checkout-a")
        ordinary.messages=[ChatMessage(role:"assistant",text:"Different Agent task")]
        ordinary.updatedAt=Date(timeIntervalSince1970:200)
        var unrelated=ChatThread(repoId:"repo-b",checkoutId:"checkout-b",readOnly:true,
            readOnlyRepoId:"repo-b",readOnlyCheckoutId:"checkout-b")
        unrelated.messages=[ChatMessage(role:"assistant",text:proposalText)]
        unrelated.updatedAt=Date(timeIntervalSince1970:300)

        let threads=[ordinary,unrelated,accepted]
        let result=ZenWorkspacePane.latestReviewableProposal(
            threads:threads,repoId:"repo-a",checkoutId:"checkout-a")
        XCTAssertEqual(result?.title,"PDF 定位")
        XCTAssertNil(ZenWorkspacePane.latestReviewableProposal(
            threads:threads,repoId:"repo-a",checkoutId:"checkout-other"))

        accepted.messages.append(ChatMessage(role:"user",text:"请重新分析"))
        XCTAssertNil(ZenWorkspacePane.latestReviewableProposal(
            threads:[ordinary,unrelated,accepted],repoId:"repo-a",checkoutId:"checkout-a"))
        accepted.messages=[ChatMessage(role:"assistant",text:proposalText,incomplete:true)]
        XCTAssertNil(ZenWorkspacePane.latestReviewableProposal(
            threads:[accepted],repoId:"repo-a",checkoutId:"checkout-a"))
    }

    @MainActor
    func testZenReviewListsSeparateCompletedProposalsWithoutRevivingStaleThreads() throws {
        func proposal(_ title:String) -> String {
            fenced(
                #"{"decision":"ACCEPT","operation":"create_requirement","rationale":"已确认","title":"TITLE","outcome":"可验收","acceptanceCriteria":["完成"]}"#
                    .replacingOccurrences(of:"TITLE",with:title)
            )
        }
        var first=ChatThread(repoId:"repo-a",checkoutId:"checkout-a",readOnly:true,
            readOnlyRepoId:"repo-a",readOnlyCheckoutId:"checkout-a")
        first.title="最初分析"
        first.messages=[ChatMessage(role:"assistant",text:proposal("第一项"))]
        first.updatedAt=Date(timeIntervalSince1970:100)

        var second=ChatThread(repoId:"repo-a",checkoutId:"checkout-a",readOnly:true,
            readOnlyRepoId:"repo-a",readOnlyCheckoutId:"checkout-a")
        second.title="后续分析"
        second.messages=[ChatMessage(role:"assistant",text:proposal("第二项"))]
        second.updatedAt=Date(timeIntervalSince1970:200)

        var wrongCheckout=second
        wrongCheckout.id=UUID().uuidString
        wrongCheckout.checkoutId="checkout-b"
        var ordinary=second
        ordinary.id=UUID().uuidString
        ordinary.readOnly=false
        var incomplete=second
        incomplete.id=UUID().uuidString
        incomplete.messages=[ChatMessage(role:"assistant",text:proposal("未完成"),incomplete:true)]

        let threads=[first,wrongCheckout,ordinary,incomplete,second]
        let candidates=ZenWorkspacePane.reviewableProposals(
            threads:threads,repoId:"repo-a",checkoutId:"checkout-a")
        XCTAssertEqual(candidates.map(\.threadId),[second.id,first.id])
        XCTAssertEqual(candidates.map(\.proposal.title),["第二项","第一项"])
        XCTAssertTrue(candidates[0].menuLabel.contains("后续分析"))
        XCTAssertTrue(candidates[1].menuLabel.contains("第一项"))
        XCTAssertEqual(ZenWorkspacePane.latestReviewableProposal(
            threads:threads,repoId:"repo-a",checkoutId:"checkout-a")?.title,"第二项")

        first.messages.append(ChatMessage(role:"user",text:"继续重新分析"))
        XCTAssertEqual(ZenWorkspacePane.reviewableProposals(
            threads:[first,second],repoId:"repo-a",checkoutId:"checkout-a").map(\.threadId),[second.id])
        XCTAssertTrue(ZenWorkspacePane.reviewableProposals(
            threads:threads,repoId:"repo-a",checkoutId:"checkout-b").isEmpty)
    }

    @MainActor
    func testZenProposalThreadIsReadOnlyAndReviewableInItsProjectContext() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:store)
        model.repoId = "repo-a"
        model.checkoutId = "checkout-a"
        model.selectedProjectId = "project-a"
        model.localApiSettings = LocalApiSettingsDetail(
            provider:"api",endpoint:"https://api.example.com/v1",model:"model-a",
            apiProtocol:"openai",hasKey:true,endpointReady:true
        )
        let provider = try XCTUnwrap(model.readOnlyAnalysisProvider)
        model.newThread(provider:provider,requirementId:"REQ-a",planId:"PLAN-a",readOnly:true)
        var thread = try XCTUnwrap(model.thread)
        XCTAssertEqual(thread.provider,provider)
        XCTAssertEqual(thread.projectId,"project-a")
        XCTAssertEqual(thread.requirementId,"REQ-a")
        XCTAssertEqual(thread.planId,"PLAN-a")
        XCTAssertTrue(NativeWorkspace.readOnlyThreadMatchesContext(
            thread,repoId:"repo-a",checkoutId:"checkout-a",projectId:"project-a"
        ))
        XCTAssertFalse(NativeWorkspace.apiTurnAllowsEffects(
            provider:provider,thread:thread,accessMode:"full_access"
        ))
        thread.messages = [ChatMessage(role:"assistant",text:fenced(
            #"{ "decision":"ACCEPT","operation":"create_requirement","rationale":"已确认","title":"Zen task","outcome":"可验收","acceptanceCriteria":["完成"] }"#
        ))]
        var otherProject = thread
        otherProject.id = UUID().uuidString
        otherProject.projectId = "project-b"
        otherProject.messages = [ChatMessage(role:"assistant",text:fenced(
            #"{ "decision":"ACCEPT","operation":"create_requirement","rationale":"已确认","title":"Wrong project","outcome":"可验收","acceptanceCriteria":["完成"] }"#
        ))]
        otherProject.updatedAt = Date().addingTimeInterval(60)
        XCTAssertEqual(ZenWorkspacePane.latestReviewableProposal(
            threads:[thread,otherProject],repoId:"repo-a",checkoutId:"checkout-a",
            projectId:"project-a"
        )?.title,"Zen task")
    }

    @MainActor
    func testProjectOnlyZenProposalCanBeReviewedWithoutRepositoryCheckout() throws {
        let payload=fenced(
            #"{ "decision":"ACCEPT","operation":"create_requirement","rationale":"项目级目标已确认","title":"完善需求流程","outcome":"项目无仓库也可规划","acceptanceCriteria":["可审阅并登记"] }"#
        )
        var thread=ChatThread(projectId:"project-only",requirementId:nil,readOnly:true)
        thread.messages=[ChatMessage(role:"assistant",text:payload)]
        XCTAssertTrue(NativeWorkspace.readOnlyThreadMatchesContext(
            thread,repoId:nil,checkoutId:nil,projectId:"project-only"
        ))
        XCTAssertFalse(NativeWorkspace.apiTurnAllowsEffects(
            provider:"api",thread:thread,accessMode:"full_access"
        ))
        let candidates=ZenWorkspacePane.reviewableProposals(
            threads:[thread],repoId:nil,checkoutId:nil,projectId:"project-only"
        )
        XCTAssertEqual(candidates.count,1)
        XCTAssertEqual(candidates.first?.proposal.title,"完善需求流程")
        XCTAssertTrue(ZenWorkspacePane.reviewableProposals(
            threads:[thread],repoId:nil,checkoutId:nil,projectId:"other-project"
        ).isEmpty)
    }

    func testZenRefinementRequiresExplicitBoundedStructuredOutcome() {
        XCTAssertEqual(ZenChangeProposal.refinementDirective(from:fenced(#"{"decision":"CONTINUE","rationale":"仍需核对验收证据"}"#)),.continueRefinement)
        XCTAssertEqual(ZenChangeProposal.refinementDirective(from:fenced(#"{"decision":"NEEDS_USER","rationale":"请确认目标用户？"}"#)),.needsUser)
        XCTAssertEqual(ZenChangeProposal.refinementDirective(from:fenced(#"{"decision":"BLOCKED","rationale":"Provider 不可用"}"#)),.blocked)
        XCTAssertEqual(ZenChangeProposal.refinementDirective(from:fenced(#"{"decision":"ACCEPT","operation":"create_requirement","rationale":"目标和验收均已确认","title":"完整流程","outcome":"用户可完成目标","acceptanceCriteria":["流程可用"]}"#)),.accept)
        XCTAssertNil(ZenChangeProposal.refinementDirective(from:"请继续补充信息。"))
        XCTAssertNil(ZenChangeProposal.refinementDirective(from:fenced(#"{"decision":"ACCEPT","rationale":"缺少操作字段"}"#)))
        XCTAssertNil(ZenChangeProposal.refinementDirective(from:fenced(#"{"decision":"CONTINUE","rationale":"继续"}"#)+"\\n"+fenced(#"{"decision":"BLOCKED","rationale":"停止"}"#)))
        XCTAssertEqual([ZenChangeProposal.refinementMaximumRounds,ZenChangeProposal.refinementMaximumTokens,Int(ZenChangeProposal.refinementMaximumDurationSeconds)],[4,20_000,120])
        XCTAssertTrue(ZenChangeProposal.continuationPrompt(round:2,remainingTokens:12_000,remainingSeconds:75).contains("12000 tokens"))
        XCTAssertTrue(ZenChangeProposal.outputContract.contains("完整 Provider usage receipt"))
    }

    @MainActor
    func testZenCreationProposalRequiresExactSelectedDetailReadback() throws {
        let requirementProposal=try ZenChangeProposal.parse(fenced(
            #"{ "decision":"ACCEPT","operation":"create_requirement","rationale":"登记独立目标","title":"Requirement","outcome":"Outcome","acceptanceCriteria":["Ship"] }"#
        ))
        let planProposal=try ZenChangeProposal.parse(fenced(
            #"{ "decision":"ACCEPT","operation":"create_plan","rationale":"按当前需求执行","requirementId":"REQ-1","expectedRequirementRevision":2,"objective":"Plan" }"#
        ))
        func requirementDetail(outcome:String="Outcome",criteria:[String]=["Ship"]) -> RequirementRecordDetail {
            RequirementRecordDetail(
                requirementId:"REQ-1",revision:1,title:"Requirement",outcomeStatement:outcome,
                state:"planned",acceptanceCriteria:criteria,progressSummary:"",remainingWork:[],
                acceptedEvidenceRefs:[],taskStatus:nil,priority:nil,assignee:nil,
                dependencyRequirementIds:[],dependencyRequirements:[],blockingDependencyIds:[],
                dependentRequirements:nil,dependentRequirementsTruncated:nil,dependentRequirementCount:nil
            )
        }
        func planDetail(
            parentRequirementId:String?="REQ-1",goal:String="Plan",requirementBasisRevision:Int?=2
        ) -> PlanRecordDetail {
            PlanRecordDetail(
                planId:"PLAN-1",revision:1,requirementId:parentRequirementId,parentPlanId:nil,
                requirementBasisRevision:requirementBasisRevision,sourceBasisRevision:nil,
                goal:goal,items:[],resolvedDecisions:[],nonGoals:[]
            )
        }
        let requirement=requirementDetail()
        let plan=planDetail()
        XCTAssertTrue(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:requirementProposal,recordId:"REQ-1",
            selectedRecord:"requirement:REQ-1",detail:.requirement(requirement)
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:requirementProposal,recordId:"REQ-1",
            selectedRecord:"plan:REQ-1",detail:.requirement(requirement)
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:requirementProposal,recordId:"REQ-1",
            selectedRecord:"requirement:REQ-2",detail:.requirement(requirement)
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:requirementProposal,recordId:"REQ-1",
            selectedRecord:"requirement:REQ-1",detail:.requirement(requirementDetail(outcome:"Different outcome"))
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:requirementProposal,recordId:"REQ-1",
            selectedRecord:"requirement:REQ-1",detail:.requirement(requirementDetail(criteria:["Different"]))
        ))
        XCTAssertTrue(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:planProposal,recordId:"PLAN-1",
            selectedRecord:"plan:PLAN-1",detail:.plan(plan)
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:planProposal,recordId:"PLAN-1",
            selectedRecord:"plan:PLAN-1",detail:.requirement(requirement)
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:planProposal,recordId:"PLAN-1",
            selectedRecord:"plan:PLAN-2",detail:.plan(plan)
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:planProposal,recordId:"PLAN-1",
            selectedRecord:"plan:PLAN-1",detail:.plan(planDetail(parentRequirementId:"REQ-2"))
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:planProposal,recordId:"PLAN-1",
            selectedRecord:"plan:PLAN-1",detail:.plan(planDetail(goal:"Different plan"))
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:planProposal,recordId:"PLAN-1",
            selectedRecord:"plan:PLAN-1",detail:.plan(planDetail(requirementBasisRevision:1))
        ))
        XCTAssertFalse(ZenProposalReviewSheet.creationReadbackConfirmed(
            proposal:planProposal,recordId:"PLAN-1",
            selectedRecord:"plan:PLAN-1",detail:.plan(planDetail(requirementBasisRevision:nil))
        ))
    }

    func testCreateRequirementIsParsedOnlyFromOneExplicitProposal() throws {
        let proposal=try ZenChangeProposal.parse(fenced(
            #"{"decision":"ACCEPT","operation":"create_requirement","rationale":"独立验收目标","title":"PDF 定位","outcome":"可定位源页","acceptanceCriteria":["定位准确"]}"#
        ))
        XCTAssertEqual(proposal.operation,.createRequirement)
        XCTAssertEqual(proposal.title,"PDF 定位")
        XCTAssertEqual(proposal.acceptanceCriteria,["定位准确"])
    }

    @MainActor
    func testZenAcceptCannotReviseAnotherPlanningContext() throws {
        func proposal(_ operation: String, _ extra: String) throws -> ZenChangeProposal {
            try ZenChangeProposal.parse(fenced(
                "{\"decision\":\"ACCEPT\",\"operation\":\"\(operation)\",\"rationale\":\"已核对\",\(extra)}"
            ))
        }
        let correct = try proposal("revise_plan",
            "\"targetId\":\"PLAN-A\",\"expectedRevision\":2,\"requirementId\":\"REQ-A\",\"objective\":\"更新计划\"")
        XCTAssertTrue(correct.matchesAnalysisContext(requirementId:"REQ-A",planId:"PLAN-A"))
        XCTAssertFalse(correct.matchesAnalysisContext(requirementId:"REQ-B",planId:"PLAN-A"))
        XCTAssertFalse(correct.matchesAnalysisContext(requirementId:"REQ-A",planId:"PLAN-B"))

        let wrongRequirement = try proposal("revise_requirement",
            "\"targetId\":\"REQ-B\",\"expectedRevision\":3,\"title\":\"需求\",\"outcome\":\"目标\",\"acceptanceCriteria\":[]")
        XCTAssertFalse(wrongRequirement.matchesAnalysisContext(requirementId:"REQ-A",planId:nil))
        let wrongParent = try proposal("create_plan",
            "\"requirementId\":\"REQ-B\",\"expectedRequirementRevision\":1,\"objective\":\"新计划\"")
        XCTAssertFalse(wrongParent.matchesAnalysisContext(requirementId:"REQ-A",planId:nil))

        var thread=ChatThread(repoId:"repo-a",checkoutId:"checkout-a",projectId:"project-a",
            requirementId:"REQ-A",planId:"PLAN-A",readOnly:true,
            readOnlyRepoId:"repo-a",readOnlyCheckoutId:"checkout-a")
        thread.messages=[ChatMessage(role:"assistant",text:fenced(
            #"{"decision":"ACCEPT","operation":"revise_plan","rationale":"已核对","targetId":"PLAN-B","expectedRevision":2,"requirementId":"REQ-B","objective":"其他任务的计划"}"#
        ))]
        XCTAssertTrue(ZenWorkspacePane.reviewableProposals(
            threads:[thread],repoId:"repo-a",checkoutId:"checkout-a",projectId:"project-a"
        ).isEmpty)
        thread.messages=[ChatMessage(role:"assistant",text:fenced(
            #"{"decision":"ACCEPT","operation":"revise_plan","rationale":"已核对","targetId":"PLAN-A","expectedRevision":2,"requirementId":"REQ-A","objective":"当前任务的计划"}"#
        ))]
        XCTAssertEqual(ZenWorkspacePane.reviewableProposals(
            threads:[thread],repoId:"repo-a",checkoutId:"checkout-a",projectId:"project-a"
        ).count,1)

        func plan(_ owner:String?,revision:Int = 2) -> PlanRecordDetail {
            PlanRecordDetail(planId:"PLAN-A",revision:revision,requirementId:owner,
                parentPlanId:nil,requirementBasisRevision:nil,sourceBasisRevision:nil,goal:"此前计划",
                items:[],resolvedDecisions:[],nonGoals:[])
        }
        XCTAssertTrue(correct.matchesCurrentPlan(plan("REQ-A")))
        XCTAssertFalse(correct.matchesCurrentPlan(plan("REQ-B")))
        XCTAssertFalse(correct.matchesCurrentPlan(plan(nil)))
        XCTAssertFalse(correct.matchesCurrentPlan(plan("REQ-A",revision:3)))
        let standalone=try proposal("revise_plan",
            "\"targetId\":\"PLAN-A\",\"expectedRevision\":2,\"requirementId\":null,\"objective\":\"独立计划\"")
        XCTAssertTrue(standalone.matchesCurrentPlan(plan(nil)))
        XCTAssertFalse(standalone.matchesCurrentPlan(plan("REQ-A")))
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
        func status(_ state:String,active:Bool=false,ready:Bool=true,authorized:Bool=true,
                    reason:String?=nil,needsReapproval:Bool=false) throws -> AutopilotStatusDetail {
            var run:[String:Any]=["status":state,"runId":"run-one","evidenceRefs":["commit:abc"]]
            if let reason {
                run["stopReason"]=reason
                if reason.hasPrefix("human_checkpoint:") {
                    run["currentPlanId"]=String(reason.dropFirst("human_checkpoint:".count))
                }
            }
            var data:[String:Any] = [
                "run":run,"runtimeActive":active,"providerReady":ready,
                "requiresReapproval":needsReapproval
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
        for reason in ["max_total_tokens_reached","max_turns_reached","max_tool_calls_reached"] {
            let exhausted=try status("paused",reason:reason)
            XCTAssertTrue(exhausted.needsBudgetRenewal)
            XCTAssertEqual(exhausted.nextExecutionOperation(),"authorize")
            XCTAssertEqual(ZenWorkspacePane.executionLabel(
                operation:"authorize",runStatus:"paused",needsBudgetRenewal:exhausted.needsBudgetRenewal
            ),"续期预算")
            XCTAssertEqual(ZenWorkspacePane.executionOperation(status:exhausted,outcomeUnknown:false),"authorize")
            XCTAssertNil(exhausted.nextExecutionOperation(outcomeUnknown:true))
        }
        let humanCheckpoint=try status("paused",reason:"human_checkpoint:PLAN-a")
        XCTAssertFalse(humanCheckpoint.needsBudgetRenewal)
        XCTAssertEqual(humanCheckpoint.checkpointPlanId,"PLAN-a")
        XCTAssertEqual(humanCheckpoint.runId,"run-one")
        XCTAssertEqual(humanCheckpoint.evidenceRefs,["commit:abc"])
        XCTAssertEqual(humanCheckpoint.nextExecutionOperation(),"accept_checkpoint")
        XCTAssertNil(humanCheckpoint.nextExecutionOperation(outcomeUnknown:true))
        let stale=try status("paused",reason:"max_turns_reached",needsReapproval:true)
        XCTAssertEqual(stale.nextExecutionOperation(),"authorize")
        XCTAssertNil(ZenWorkspacePane.executionOperation(status:detached,outcomeUnknown:true))
        XCTAssertNil(ZenWorkspacePane.executionOperation(status:nil,outcomeUnknown:false))
    }

    @MainActor
    func testPlannedRequirementsCanUseZenPlanningAndExecutionUntilTerminal() {
        XCTAssertTrue(ZenWorkspacePane.requirementAllowsActions("planned"))
        XCTAssertTrue(ZenWorkspacePane.requirementAllowsActions("open"))
        XCTAssertFalse(ZenWorkspacePane.requirementAllowsActions("completed"))
        XCTAssertFalse(ZenWorkspacePane.requirementAllowsActions("cancelled"))
    }

    func testZenExecutionApprovalIsBoundToExactProjectAndContextGeneration() throws {
        let requirement=RequirementRecordDetail(
            requirementId:"REQ-one",revision:3,title:"Requirement",outcomeStatement:"Ship safely",
            state:"open",acceptanceCriteria:["Works"],progressSummary:"",remainingWork:[],
            acceptedEvidenceRefs:[],taskStatus:nil,priority:nil,assignee:nil,
            dependencyRequirementIds:[],dependencyRequirements:[],blockingDependencyIds:[],
            dependentRequirements:nil,dependentRequirementsTruncated:nil,dependentRequirementCount:nil
        )
        let status=try XCTUnwrap(NativeWorkspace.autopilotStatusDetail(["data":["providerReady":true]]))
        let approval=ZenExecutionApproval(
            projectId:"project-one",contextGeneration:7,
            repoId:"repo-one",checkoutId:"checkout-one",
            projectLabel:"Project one",checkoutLabel:"main",
            requirement:requirement,status:status,plans:[]
        )
        XCTAssertTrue(approval.matchesCurrentContext(
            projectId:"project-one",repoId:"repo-one",checkoutId:"checkout-one",contextGeneration:7
        ))
        XCTAssertFalse(approval.matchesCurrentContext(
            projectId:"project-two",repoId:"repo-one",checkoutId:"checkout-one",contextGeneration:7
        ))
        XCTAssertFalse(approval.matchesCurrentContext(
            projectId:"project-one",repoId:"repo-one",checkoutId:"checkout-one",contextGeneration:8
        ))
        XCTAssertFalse(approval.matchesCurrentContext(
            projectId:"project-one",repoId:"repo-two",checkoutId:"checkout-one",contextGeneration:7
        ))
    }

    @MainActor
    func testCheckpointReviewIsBoundToExactWorkspaceRunAndPlan() throws {
        let folder=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model=NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.repoId="repo-one"
        model.checkoutId="checkout-one"
        let status=try XCTUnwrap(NativeWorkspace.autopilotStatusDetail(["data":[
            "grant":["grantId":"grant-one"],"providerReady":true,
            "run":["runId":"run-one","status":"paused","stopReason":"human_checkpoint:PLAN-a",
                   "currentPlanId":"PLAN-a","lastSummary":"Review exact plan",
                   "evidenceRefs":["commit:abc"]]
        ]]))
        let review=try XCTUnwrap(AutopilotCheckpointReview(model:model,requirementId:"REQ-one",status:status))
        XCTAssertEqual(review.id,"repo-one|checkout-one|run-one|PLAN-a")
        XCTAssertEqual(review.requirementId,"REQ-one")
        XCTAssertEqual(review.planTitle,"PLAN-a")
        XCTAssertEqual(review.summary,"Review exact plan")
        XCTAssertEqual(review.evidenceRefs,["commit:abc"])
        model.checkoutId=nil
        XCTAssertNil(AutopilotCheckpointReview(model:model,requirementId:"REQ-one",status:status))
    }

    func testRejectsAmbiguousOrUnsafeProposalContent() {
        let valid = fenced(
            #"{"decision":"ACCEPT","operation":"create_plan","rationale":"既有目标下增加方案","requirementId":"REQ-1","expectedRequirementRevision":1,"objective":"原生适配"}"#
        )
        XCTAssertEqual(try ZenChangeProposal.parse(valid).expectedRequirementRevision,1)
        XCTAssertThrowsError(try ZenChangeProposal.parse(valid + "\n" + valid))
        XCTAssertThrowsError(try ZenChangeProposal.parse(fenced(
            "{\"decision\":\"ACCEPT\",\"operation\":\"create_plan\",\"rationale\":\"缺少父版本\",\"requirementId\":\"REQ-1\",\"objective\":\"原生适配\"}"
        )))
        XCTAssertThrowsError(try ZenChangeProposal.parse(fenced(
            "{\"decision\":\"ACCEPT\",\"operation\":\"create_plan\",\"rationale\":\"非法父版本\",\"requirementId\":\"REQ-1\",\"expectedRequirementRevision\":0,\"objective\":\"原生适配\"}"
        )))
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
