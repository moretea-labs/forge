import XCTest
@testable import ForgeNative

final class NativeWorkspaceTests: XCTestCase {
    func testBridgeAllowlistExcludesGenericCommandsAndRecoveryMutations() {
        XCTAssertTrue(ForgeBridge.allowed.contains("send_local_conversation"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_local_provider_models"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_agent_git_diff"))
        XCTAssertTrue(ForgeBridge.allowed.contains("commit_agent_git_files"))
        XCTAssertTrue(ForgeBridge.allowed.contains("restore_agent_git_files"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_local_conversation_activity"))
        XCTAssertTrue(ForgeBridge.allowed.contains("verify_recovery_runtime"))
        XCTAssertTrue(ForgeBridge.allowed.contains("repair_connection"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_local_api_settings"))
        XCTAssertTrue(ForgeBridge.allowed.contains("save_local_api_settings"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_project_requirement_list"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_project_autopilot_statuses"))
        XCTAssertTrue(ForgeBridge.allowed.contains("register_project"))
        XCTAssertTrue(ForgeBridge.allowed.contains("create_requirement"))
        XCTAssertTrue(ForgeBridge.allowed.contains("create_plan"))
        XCTAssertTrue(ForgeBridge.allowed.contains("autopilot_control"))
        XCTAssertTrue(ForgeBridge.allowed.contains("managed_api_credential_control"))
        XCTAssertFalse(ForgeBridge.allowed.contains("send_local_api_conversation"))
        XCTAssertFalse(ForgeBridge.allowed.contains("cancel_local_api_conversation"))
        XCTAssertFalse(ForgeBridge.allowed.contains("read_project_work_list"))
        XCTAssertFalse(ForgeBridge.allowed.contains("read_work_detail"))
        XCTAssertFalse(ForgeBridge.allowed.contains("execute_command"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_repository_access"))
        XCTAssertTrue(ForgeBridge.allowed.contains("set_repository_access"))
        XCTAssertFalse(ForgeBridge.allowed.contains("perform_recovery_action"))
    }

    @MainActor
    func testLocalThreadsPersistWithoutCreatingForgeWork() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = NativeWorkspace(store: store)
        let original = model.threads.first!.id
        model.newThread()
        model.threads[0].model = "gpt-6.1-sol"
        model.threads[0].reasoningEffort = "high"
        model.persist()
        XCTAssertEqual(model.threads.count, 2)
        let restored = NativeWorkspace(store: store)
        XCTAssertEqual(restored.threads.count, 2)
        XCTAssertNotEqual(restored.threads.first?.id, original)
        XCTAssertNil(restored.threads.first?.checkoutId)
        XCTAssertEqual(restored.threads.first?.model, "gpt-6.1-sol")
        XCTAssertEqual(restored.threads.first?.reasoningEffort, "high")
        XCTAssertNil(restored.threads.first?.requirementId)
        XCTAssertNil(restored.threads.first?.planId)
        let persisted = try String(contentsOf:store,encoding:.utf8)
        XCTAssertFalse(persisted.contains("workId"))
    }

    @MainActor
    func testPlanningContextIsOptionalAndPersistsOnlyWhenExplicitlyAttached() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:store)
        XCTAssertNil(model.thread?.requirementId)
        XCTAssertNil(model.thread?.planId)

        model.repoId = "repo_a"
        model.checkoutId = "checkout_a"
        model.newThread(requirementId:"REQ-a",planId:"PLAN-a")
        XCTAssertEqual(model.thread?.repoId,"repo_a")
        XCTAssertEqual(model.thread?.checkoutId,"checkout_a")
        XCTAssertEqual(model.thread?.requirementId,"REQ-a")
        XCTAssertEqual(model.thread?.planId,"PLAN-a")
        model.persist()

        let restored = NativeWorkspace(store:store)
        XCTAssertEqual(restored.thread?.requirementId,"REQ-a")
        XCTAssertEqual(restored.thread?.planId,"PLAN-a")
    }

    func testLegacyMessageDecodesWithoutToolActivity() throws {
        let data = #"{"id":"m1","role":"assistant","text":"done","createdAt":0}"#.data(using:.utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let message = try decoder.decode(ChatMessage.self,from:data)
        XCTAssertEqual(message.text,"done")
        XCTAssertNil(message.attachmentNames)
        XCTAssertNil(message.contextPaths)
        XCTAssertNil(message.toolActivityCount)
        XCTAssertNil(message.activityEvents)
    }

    @MainActor
    func testProviderIsThreadOwnedAndLegacyHistoryStaysCodex() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:store)
        model.localApiSettings = LocalApiSettingsDetail(
            provider:"api",endpoint:"https://api.example.com/v1",model:"model-a",
            apiProtocol:"openai",hasKey:true,endpointReady:true
        )
        XCTAssertEqual(model.selectedProvider,"api")
        model.selectThreadProvider("api")
        XCTAssertEqual(model.thread?.provider,"api")
        model.threads[0].messages.append(ChatMessage(role:"user",text:"hello"))
        model.selectThreadProvider("codex")
        XCTAssertEqual(model.thread?.provider,"api")
        model.persist()
        let restored = NativeWorkspace(store:store)
        XCTAssertEqual(restored.thread?.provider,"api")
        XCTAssertEqual(restored.selectedProvider,"api")

        restored.threads[0].provider = nil
        XCTAssertEqual(restored.selectedProvider,"codex")
    }

    func testApiTurnHistoryAndEffectAuthorizationAreBounded() {
        var thread = ChatThread(provider:"api")
        thread.messages = [
            ChatMessage(role:"user",text:"old user"),
            ChatMessage(role:"assistant",text:"old answer")
        ]
        let messages = NativeWorkspace.apiTurnMessages(
            thread,prompt:"inspect",contextPaths:["src/a.ts"]
        )
        XCTAssertEqual(messages.count,3)
        XCTAssertEqual(messages[0]["content"],"old user")
        XCTAssertEqual(messages[1]["content"],"old answer")
        XCTAssertTrue(messages[2]["content"]?.contains("Forge selected repository file context") == true)
        XCTAssertTrue(messages[2]["content"]?.contains("a.ts") == true)
        XCTAssertFalse(messages[2]["content"]?.contains("Forge optional semantic planning context") == true)
        XCTAssertFalse(messages[0]["content"]?.contains("Forge selected repository file context") == true)

        thread.requirementId = "REQ-a"
        thread.planId = "PLAN-a"
        let attached = NativeWorkspace.apiTurnMessages(thread,prompt:"continue",contextPaths:[])
        XCTAssertTrue(attached.last?["content"]?.contains("Forge optional semantic planning context") == true)
        XCTAssertTrue(attached.last?["content"]?.contains("REQ-a") == true)
        XCTAssertTrue(attached.last?["content"]?.contains("PLAN-a") == true)

        XCTAssertTrue(NativeWorkspace.repositoryAccessAllowsEffects(
            provider:"api",accessMode:"full_access",repoId:"repo",checkoutId:"checkout"
        ))
        XCTAssertTrue(NativeWorkspace.repositoryAccessAllowsEffects(
            provider:"joycode",accessMode:"full_access",repoId:"repo",checkoutId:"checkout"
        ))
        XCTAssertFalse(NativeWorkspace.repositoryAccessAllowsEffects(
            provider:"codex",accessMode:"full_access",repoId:"repo",checkoutId:"checkout"
        ))
        XCTAssertFalse(NativeWorkspace.repositoryAccessAllowsEffects(
            provider:"api",accessMode:"request",repoId:"repo",checkoutId:"checkout"
        ))
        XCTAssertFalse(NativeWorkspace.repositoryAccessAllowsEffects(
            provider:"api",accessMode:"full_access",repoId:"repo",checkoutId:nil
        ))
        XCTAssertEqual(NativeWorkspace.repositoryAccessMode([
            "repositoryPolicy":["mode":"full_access"]
        ]),"full_access")
        XCTAssertEqual(NativeWorkspace.repositoryAccessMode([
            "repositoryPolicy":["mode":"request"]
        ]),"request")
    }

    func testApiTurnHistoryExcludesIncompleteAssistantEvidence() {
        var thread = ChatThread(provider:"api")
        thread.messages = [
            ChatMessage(role:"user",text:"implement the change"),
            ChatMessage(role:"assistant",text:"工具结果需要核对",incomplete:true),
            ChatMessage(role:"user",text:"continue after inspecting the changes"),
            ChatMessage(role:"assistant",text:"Checked the current repository status."),
            ChatMessage(role:"assistant",text:"partial output",incomplete:true)
        ]
        let messages = NativeWorkspace.apiTurnMessages(
            thread,prompt:"finish verification",contextPaths:[]
        )
        XCTAssertEqual(messages.map { $0["role"] },["user","user","assistant","user"])
        XCTAssertEqual(messages.map { $0["content"] },[
            "implement the change",
            "continue after inspecting the changes",
            "Checked the current repository status.",
            "finish verification"
        ])
        // Audit evidence remains intact in the persisted ChatThread.
        XCTAssertEqual(thread.messages.count,5)
        XCTAssertEqual(thread.messages[1].incomplete,true)
    }

    func testNativeApiTurnEventFramingIsTyped() {
        let progress = #"{"type":"progress","data":{"name":"read_file","phase":"started"}}"#.data(using:.utf8)!
        XCTAssertEqual(ForgeApiTurn.decodeEvent(progress)?["type"] as? String,"progress")
        XCTAssertNil(ForgeApiTurn.decodeEvent(Data("{}".utf8)))
    }

    @MainActor
    func testAgentGitDiffKeepsUntrackedOutsideReviewedPatchScope() throws {
        let payload = Data(#"{"repoId":"repo_a","checkoutId":"checkout_a","branch":"work/a","head":"abcdef","staged":false,"paths":[],"nameOnly":["tracked.txt"],"stat":"1 file changed","patch":"diff --git a/tracked.txt b/tracked.txt\n","truncated":false,"untracked":["new.txt"]}"#.utf8)
        let diff = try JSONDecoder().decode(AgentGitDiff.self,from:payload)
        XCTAssertEqual(diff.untrackedFiles,["new.txt"])
        XCTAssertEqual(diff.nameOnly,["tracked.txt"])
        XCTAssertFalse(NativeWorkspace.reviewedChangesMatchPaths(diff,paths:["new.txt"]))
    }

    @MainActor
    func testReviewedChangesRestoreGuardRejectsStagedTruncatedAndWrongCheckout() {
        let valid = AgentGitDiff(
            repoId:"repo_a", checkoutId:"checkout_a", branch:"work/a", head:"abcdef",
            staged:false, paths:["a"], nameOnly:["a"], stat:"1 file changed",
            patch:"diff --git a/a b/a\n", truncated:false
        )
        let staged = AgentGitDiff(
            repoId:"repo_a", checkoutId:"checkout_a", branch:"work/a", head:"abcdef",
            staged:true, paths:["a"], nameOnly:["a"], stat:"1 file changed",
            patch:"diff --git a/a b/a\n", truncated:false
        )
        let truncated = AgentGitDiff(
            repoId:"repo_a", checkoutId:"checkout_a", branch:"work/a", head:"abcdef",
            staged:false, paths:["a"], nameOnly:["a"], stat:"1 file changed",
            patch:"diff --git a/a b/a\n", truncated:true
        )
        XCTAssertTrue(NativeWorkspace.reviewedChangesAreRestorable(
            valid,repoId:"repo_a",checkoutId:"checkout_a"
        ))
        XCTAssertFalse(NativeWorkspace.reviewedChangesAreRestorable(
            staged,repoId:"repo_a",checkoutId:"checkout_a"
        ))
        XCTAssertFalse(NativeWorkspace.reviewedChangesAreRestorable(
            truncated,repoId:"repo_a",checkoutId:"checkout_a"
        ))
        XCTAssertFalse(NativeWorkspace.reviewedChangesAreRestorable(
            valid,repoId:"repo_a",checkoutId:"checkout_b"
        ))
    }

    @MainActor
    func testReviewedChangesPathScopeRequiresExactUntruncatedFileSet() {
        let focused = AgentGitDiff(
            repoId:"repo_a", checkoutId:"checkout_a", branch:"work/a", head:"abcdef",
            staged:false, paths:["a"], nameOnly:["a"], stat:"1 file changed",
            patch:"diff --git a/a b/a\n", truncated:false
        )
        let multi = AgentGitDiff(
            repoId:"repo_a", checkoutId:"checkout_a", branch:"work/a", head:"abcdef",
            staged:false, paths:["a","b"], nameOnly:["a","b"], stat:"2 files changed",
            patch:"diff --git a/a b/a\ndiff --git a/b b/b\n", truncated:false
        )
        let truncated = AgentGitDiff(
            repoId:"repo_a", checkoutId:"checkout_a", branch:"work/a", head:"abcdef",
            staged:false, paths:["a"], nameOnly:["a"], stat:"1 file changed",
            patch:"diff --git a/a b/a\n", truncated:true
        )
        XCTAssertTrue(NativeWorkspace.reviewedChangesMatchPaths(focused,paths:["a"]))
        XCTAssertTrue(NativeWorkspace.reviewedChangesMatchPaths(multi,paths:["b","a"]))
        XCTAssertFalse(NativeWorkspace.reviewedChangesMatchPaths(multi,paths:["a"]))
        XCTAssertFalse(NativeWorkspace.reviewedChangesMatchPaths(truncated,paths:["a"]))
    }

    func testRetiredWorkIsNotANativeNavigationOrBridgeCapability() {
        XCTAssertFalse(NativePage.allCases.contains { $0.rawValue == "Work" })
        XCTAssertFalse(ForgeBridge.allowed.contains("read_project_work_list"))
        XCTAssertFalse(ForgeBridge.allowed.contains("read_work_detail"))
    }

    func testSemanticRecordDetailParsersProjectCanonicalFieldsWithoutWork() {
        let requirement = NativeWorkspace.requirementDetail([
            "data":["requirement":[
                "requirementId":"REQ-a","revision":4,"title":"Desktop",
                "outcomeStatement":"Useful native client","state":"open",
                "acceptanceCriteria":["Agent first","No Work authority"],
                "progressSummary":"Source green","remainingWork":["GUI QA"],
            ]]
        ])
        XCTAssertEqual(requirement?.requirementId,"REQ-a")
        XCTAssertEqual(requirement?.revision,4)
        XCTAssertEqual(requirement?.acceptanceCriteria.count,2)
        XCTAssertEqual(requirement?.remainingWork,["GUI QA"])

        let plan = NativeWorkspace.planDetail([
            "data":["plan":[
                "planId":"PLAN-a","revision":8,"requirementId":"REQ-a","parentPlanId":"PLAN-root",
                "sourceBasisRevision":"abcdef123456","goal":"Ship client",
                "items":[["id":"p1","objective":"Polish UI"]],
                "resolvedDecisions":["One native app"],"nonGoals":["No Work lifecycle"],
            ]]
        ])
        XCTAssertEqual(plan?.planId,"PLAN-a")
        XCTAssertEqual(plan?.requirementId,"REQ-a")
        XCTAssertEqual(plan?.parentPlanId,"PLAN-root")
        XCTAssertEqual(plan?.items.first?.objective,"Polish UI")
        XCTAssertEqual(plan?.resolvedDecisions,["One native app"])
        XCTAssertEqual(plan?.nonGoals,["No Work lifecycle"])

        let autopilot = NativeWorkspace.autopilotStatusDetail([
            "data":[
                "grant":[
                    "grantId":"grant-a",
                    "constraints":[
                        "requirementRevision":3,"model":"deepseek-chat",
                        "maxTotalTokens":50000,"maxTurns":12,"maxToolCalls":32,
                    ],
                ],
                "run":[
                    "status":"paused","stopReason":"human_checkpoint:PLAN-a",
                    "currentPlanId":"PLAN-a","lastSummary":"Checkpoint ready","updatedAt":"2026-11-08T03:00:00Z",
                    "policy":["model":"deepseek-chat","maxTotalTokens":50000,"maxTurns":12,"maxToolCalls":32],
                    "usage":["promptTokens":100,"completionTokens":50,"totalTokens":150,"turns":2,"toolCalls":4],
                ],
                "providerReady":true,"runtimeActive":false,"requiresReapproval":false,
                "requirementRevision":3,"approvedRevision":3,
            ]
        ])
        XCTAssertEqual(autopilot?.authorized,true)
        XCTAssertEqual(autopilot?.providerReady,true)
        XCTAssertEqual(autopilot?.runStatus,"paused")
        XCTAssertEqual(autopilot?.stopReason,"human_checkpoint:PLAN-a")
        XCTAssertEqual(autopilot?.currentPlanId,"PLAN-a")
        XCTAssertEqual(autopilot?.lastSummary,"Checkpoint ready")
        XCTAssertEqual(autopilot?.updatedAt,"2026-11-08T03:00:00Z")
        XCTAssertEqual(autopilot?.totalTokens,150)
        XCTAssertEqual(autopilot?.maxTotalTokens,50000)
        XCTAssertEqual(autopilot?.turns,2)
        XCTAssertEqual(autopilot?.toolCalls,4)

        let map = NativeWorkspace.autopilotStatusMap([
            "statuses":[
                "REQ-a":[
                    "grant":["grantId":"grant-a","constraints":["requirementRevision":3]],
                    "run":["status":"running","currentPlanId":"PLAN-a"],
                    "providerReady":true,"runtimeActive":true,"requiresReapproval":false
                ],
                "REQ-b":["error":"AUTOPILOT_REQUIREMENT_NOT_FOUND"]
            ]
        ])
        XCTAssertEqual(map["REQ-a"]?.runStatus,"running")
        XCTAssertEqual(map["REQ-a"]?.currentPlanId,"PLAN-a")
        XCTAssertNil(map["REQ-b"])
    }

    func testSemanticRecordIdsAreBoundedAndTyped() {
        let uuid = UUID(uuidString:"01234567-89AB-CDEF-0123-456789ABCDEF")!
        XCTAssertEqual(NativeWorkspace.semanticRecordId(prefix:"REQ",uuid:uuid),"REQ-0123456789ab")
        XCTAssertEqual(NativeWorkspace.semanticRecordId(prefix:"PLAN",uuid:uuid),"PLAN-0123456789ab")
    }

    func testProjectRequirementRowsExcludeForeignGlobalRequirementsWithoutGuessing() {
        let rows = NativeWorkspace.projectRequirementRows(
            requirementRows:[
                ["requirementId":"REQ-linked","title":"Linked"],
                ["requirementId":"REQ-local","repoId":"repo-forge","title":"Local standalone"],
                ["requirementId":"REQ-foreign","repoId":"repo-other","title":"Foreign"],
                ["requirementId":"REQ-global","title":"Unscoped global"]
            ],
            planRows:[
                ["planId":"PLAN-a","requirementId":"REQ-linked","goal":"Plan A"]
            ],
            repoId:"repo-forge"
        )
        XCTAssertEqual(rows.compactMap { $0["requirementId"] as? String },["REQ-linked","REQ-local"])
    }

    func testPlanningTreeKeepsRequirementOptionalAndNestsChildPlans() {
        let rows = NativeWorkspace.planningRecords(
            requirementRows:[
                ["requirementId":"REQ-a","title":"Desktop","state":"open"]
            ],
            planRows:[
                ["planId":"PLAN-child","requirementId":"REQ-a","parentPlanId":"PLAN-root","goal":"Child"],
                ["planId":"PLAN-root","requirementId":"REQ-a","goal":"Root"],
                ["planId":"PLAN-free","goal":"Standalone"]
            ]
        )
        XCTAssertEqual(rows.map(\.recordId),["REQ-a","PLAN-root","PLAN-child","PLAN-free"])
        XCTAssertEqual(rows.map(\.depth),[0,1,2,0])
        XCTAssertEqual(rows[0].kind,.requirement)
        XCTAssertEqual(rows[1].kind,.plan)
        XCTAssertNil(rows.last?.requirementId)
    }

    func testLocalProviderReadinessUsesCanonicalStatusField() {
        XCTAssertTrue(NativeWorkspace.localProviderStatusReady([
            "status":"ready","label":"localized provider label"
        ]))
        XCTAssertFalse(NativeWorkspace.localProviderStatusReady([
            "status":"unavailable","label":"Codex 已连接"
        ]))
        XCTAssertFalse(NativeWorkspace.localProviderStatusReady([:]))
    }

    func testRuntimeAndConnectionProjectionsUseCanonicalAuthorityFields() {
        let runtime = NativeWorkspace.runtimeStatusDetail([
            "running":true,"ready":true,"stale":false,
            "reasonCodes":["one"],
            "snapshot":["pid":123,"releaseId":"release-a","endpoint":"http://127.0.0.1:4317","observedAt":"now"]
        ])
        XCTAssertTrue(runtime.running)
        XCTAssertTrue(runtime.ready)
        XCTAssertEqual(runtime.label,"运行时正常")
        XCTAssertEqual(runtime.pid,123)
        XCTAssertEqual(runtime.releaseId,"release-a")
        XCTAssertEqual(runtime.reasonCount,1)

        let diagnostics = NativeWorkspace.runtimeDiagnosticsDetail([
            "ok":false,"at":"now",
            "probes":["runtime_status":["ok":true],"mcp_tools_list":["ok":false]]
        ])
        XCTAssertEqual(diagnostics.passed,1)
        XCTAssertEqual(diagnostics.failed,1)
        XCTAssertEqual(diagnostics.probes.count,2)

        let connection = NativeWorkspace.controllerConnectionDetail([
            "connection":[
                "configured":true,"ready":false,
                "controller":["ready":true,"title":"Controller ready","detail":"local"],
                "tunnel":["ready":false,"title":"Tunnel degraded","detail":"reconnect"],
                "repair":["available":true,"label":"Refresh Forge Connector"]
            ]
        ])
        XCTAssertEqual(connection?.controller.ready,true)
        XCTAssertEqual(connection?.tunnel.ready,false)
        XCTAssertEqual(connection?.repairAvailable,true)
        XCTAssertEqual(connection?.repairLabel,"Refresh Forge Connector")
        XCTAssertEqual(NativeWorkspace.connectionLabel(connection),"远程 MCP 未连接")
        XCTAssertEqual(NativeWorkspace.connectionLabel(nil),"MCP 状态未知")
        XCTAssertNil(NativeWorkspace.controllerConnectionDetail(["unexpected":true]))
    }

    func testKnowledgeProjectionDecodesCanonicalReadOnlyAudit() {
        let result = NativeWorkspace.knowledgeAuditDetail([
            "readonly":true,"advisoryOnly":true,
            "scopes":[["kind":"project","id":"repo-a"]],
            "items":[["memory":[
                "id":"mem-a","revision":2,"canonicalText":"Keep one authority",
                "concepts":["authority"],"facets":["architecture"],"confidence":0.9,
                "scope":["kind":"project","id":"repo-a"],
                "provenance":["sourceKind":"learning","recordedAt":"2026-11-07T00:00:00Z"]
            ]]],
            "inspected":4,"truncated":false,"gaps":[]
        ])
        XCTAssertEqual(result?.readonly,true)
        XCTAssertEqual(result?.advisoryOnly,true)
        XCTAssertEqual(result?.inspected,4)
        XCTAssertEqual(result?.items.first?.memory.canonicalText,"Keep one authority")
        XCTAssertEqual(result?.items.first?.memory.scope.kind,"project")
    }

    func testSavedApiProfileProjectionAndOneShotBridgeBoundary() {
        let settings = NativeWorkspace.localApiSettingsDetail([
            "provider":"api","endpoint":"https://api.example.com/v1",
            "model":"model-a","apiProtocol":"openai","credentialRef":"cred_fixture","hasKey":true,"endpointReady":true
        ])
        XCTAssertEqual(settings?.provider,"api")
        XCTAssertEqual(settings?.endpoint,"https://api.example.com/v1")
        XCTAssertEqual(settings?.model,"model-a")
        XCTAssertEqual(settings?.apiProtocol,"openai")
        XCTAssertEqual(settings?.credentialRef,"cred_fixture")
        XCTAssertEqual(settings?.hasKey,true)
        XCTAssertEqual(settings?.endpointReady,true)
        XCTAssertEqual(settings?.joyCodeModel,"JoyAI-Code-1.6")
        XCTAssertEqual(settings?.joyCodeReady,false)
        XCTAssertFalse(ForgeBridge.allowed.contains("send_local_api_conversation"))
        let credential = NativeWorkspace.managedCredentialDetail([
            "credentialRef":"cred_fixture",
            "label":"Fixture",
            "endpoint":"https://api.example.com/v1",
            "hasSecret":true,
            "authorized":true,
            "expiresAt":"2026-12-01T00:00:00.000Z"
        ])
        XCTAssertEqual(credential?.credentialRef,"cred_fixture")
        XCTAssertEqual(credential?.label,"Fixture")
        XCTAssertEqual(credential?.authorized,true)
        XCTAssertEqual(credential?.hasSecret,true)
        XCTAssertEqual(credential?.expiresAt,"2026-12-01T00:00:00.000Z")
    }

    @MainActor
    func testJoyCodeThreadOwnsProviderAndSnapshotsConfiguredModel() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.localApiSettings = LocalApiSettingsDetail(
            provider:"joycode", endpoint:"https://api.example.com/v1",
            model:"api-model", apiProtocol:"openai", hasKey:true, endpointReady:true,
            joyCodeModel:"JoyAI-Code-1.6", joyCodeReady:true
        )

        model.newThread(provider:"joycode")
        XCTAssertEqual(model.thread?.provider,"joycode")
        XCTAssertEqual(model.thread?.model,"JoyAI-Code-1.6")
        XCTAssertEqual(model.selectedApiModel,"JoyAI-Code-1.6")
        XCTAssertTrue(model.selectedProviderReady)
        XCTAssertTrue(NativeWorkspace.repositoryAccessAllowsEffects(provider:"joycode", accessMode:"full_access", repoId:"repo", checkoutId:"checkout"))
    }

    @MainActor
    func testApiThreadReadinessUsesThreadModelAndSharedEndpoint() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.localApiSettings = LocalApiSettingsDetail(
            provider:"codex", endpoint:"https://api.example.com/v1",
            model:"", apiProtocol:"openai", hasKey:true, endpointReady:true
        )
        model.threads[0].provider = "api"
        model.threads[0].model = "thread-model"
        XCTAssertFalse(model.apiProfileReady)
        XCTAssertTrue(model.selectedProviderReady)

        model.localApiSettings = LocalApiSettingsDetail(
            provider:"codex", endpoint:"",
            model:"", apiProtocol:"openai", hasKey:true, endpointReady:false
        )
        XCTAssertFalse(model.selectedProviderReady)
    }

    @MainActor
    func testApiReadinessFailsClosedWhenEndpointAuthIsNotReady() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.localApiSettings = LocalApiSettingsDetail(
            provider:"api", endpoint:"https://api.example.com/v1",
            model:"model-a", apiProtocol:"openai", hasKey:false, endpointReady:false
        )
        model.threads[0].provider = "api"
        model.threads[0].model = "model-a"
        XCTAssertFalse(model.apiProfileReady)
        XCTAssertFalse(model.selectedProviderReady)

        model.localApiSettings = LocalApiSettingsDetail(
            provider:"api", endpoint:"http://127.0.0.1:11434/v1",
            model:"model-a", apiProtocol:"openai", hasKey:false, endpointReady:true
        )
        XCTAssertTrue(model.apiProfileReady)
        XCTAssertTrue(model.selectedProviderReady)
    }

    @MainActor
    func testApiThreadSnapshotsConfiguredModelInsteadOfFollowingLaterProfileChanges() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.localApiSettings = LocalApiSettingsDetail(
            provider:"api", endpoint:"https://api.example.com/v1",
            model:"model-a", apiProtocol:"openai", hasKey:true, endpointReady:true
        )

        model.newThread(provider:"api")
        XCTAssertEqual(model.thread?.model,"model-a")
        XCTAssertEqual(model.selectedApiModel,"model-a")

        model.localApiSettings = LocalApiSettingsDetail(
            provider:"api", endpoint:"https://api.example.com/v1",
            model:"model-b", apiProtocol:"openai", hasKey:true, endpointReady:true
        )
        XCTAssertEqual(model.thread?.model,"model-a")
        XCTAssertEqual(model.selectedApiModel,"model-a")
    }

    @MainActor
    func testThreadRenamePersistsWithoutChangingConversationBinding() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = NativeWorkspace(store: store)
        let id = model.threads[0].id
        model.threads[0].repoId = "repo_a"
        model.threads[0].checkoutId = "checkout_a"
        model.threads[0].providerSessionId = "session_a"

        model.renameThread(id,to:"  Agent lifecycle polish  ")

        XCTAssertEqual(model.threads[0].title,"Agent lifecycle polish")
        XCTAssertEqual(model.threads[0].repoId,"repo_a")
        XCTAssertEqual(model.threads[0].checkoutId,"checkout_a")
        XCTAssertEqual(model.threads[0].providerSessionId,"session_a")
        let restored = NativeWorkspace(store:store)
        XCTAssertEqual(restored.threads.first?.title,"Agent lifecycle polish")
        XCTAssertEqual(restored.threads.first?.providerSessionId,"session_a")
    }

    @MainActor
    func testCompletedActivityEventsDecodeFromRuntimeResponseShape() {
        let events = NativeWorkspace.decodeActivityEvents([[
            "phase":"tool",
            "label":"正在执行命令",
            "detail":"git status --short",
            "status":"completed",
            "startedAt":"2026-11-07T00:00:00.000Z",
            "completedAt":"2026-11-07T00:00:01.000Z",
        ]])
        XCTAssertEqual(events?.count,1)
        XCTAssertEqual(events?.first?.phase,"tool")
        XCTAssertEqual(events?.first?.detail,"git status --short")
        XCTAssertEqual(events?.first?.status,"completed")
        let legacy = NativeWorkspace.decodeActivityEvents([[
            "phase":"tool",
            "label":"正在使用 forge · rh_status",
            "status":"completed",
            "startedAt":"2026-11-07T00:00:00.000Z",
        ]])
        XCTAssertNil(legacy?.first?.detail)
        XCTAssertNil(NativeWorkspace.decodeActivityEvents([]))
    }

    @MainActor
    func testBusyTurnBlocksConversationAndProjectRebinding() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let first = model.selectedThreadId!
        model.newThread()
        let second = model.selectedThreadId!
        model.selectThread(first)
        model.repoId = "repo_a"
        model.busy = true

        model.selectThread(second)
        XCTAssertEqual(model.selectedThreadId,first)
        model.newThread()
        XCTAssertEqual(model.threads.count,2)
        model.selectProject("repo_b")
        XCTAssertEqual(model.repoId,"repo_a")
        XCTAssertTrue(model.error?.contains("停止正在运行") == true)
    }

    @MainActor
    func testContextNavigationKeepsOriginAndSupportsBack() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))

        let threadId=model.selectedThreadId
        model.page = .agent
        model.show(.knowledge)
        XCTAssertEqual(model.page,.knowledge)
        XCTAssertEqual(model.navigationBackStack,[
            NativeNavigationEntry(page:.agent,threadId:threadId,recordId:nil)
        ])
        XCTAssertTrue(model.canNavigateBack)
        XCTAssertEqual(model.navigationBackLabel,NativePage.agent.rawValue)

        model.show(.requirement)
        XCTAssertEqual(model.navigationBackStack,[
            NativeNavigationEntry(page:.agent,threadId:threadId,recordId:nil),
            NativeNavigationEntry(page:.knowledge,threadId:threadId,recordId:nil)
        ])
        model.goBack()
        XCTAssertEqual(model.page,.knowledge)
        model.goBack()
        XCTAssertEqual(model.page,.agent)
        XCTAssertFalse(model.canNavigateBack)
    }

    @MainActor
    func testOpeningConversationFromProjectScopedPagePreservesReturnPath() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let threadId = model.selectedThreadId!

        model.page = .knowledge
        model.selectThread(threadId)

        XCTAssertEqual(model.page,.agent)
        XCTAssertEqual(model.navigationBackStack,[
            NativeNavigationEntry(page:.knowledge,threadId:threadId,recordId:nil)
        ])
        model.goBack()
        XCTAssertEqual(model.page,.knowledge)
    }

    @MainActor
    func testNavigationEntryPreservesPlanningSelection() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let threadId=model.selectedThreadId

        model.page = .requirement
        model.selectedRecord = "plan:PLAN-123"
        model.show(.knowledge)

        XCTAssertEqual(model.navigationBackStack.last,
                       NativeNavigationEntry(page:.requirement,threadId:threadId,recordId:"plan:PLAN-123"))
    }

    @MainActor
    func testBackRestoresSourceConversationProjectAfterCrossProjectJump() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))

        model.threads[0].repoId = "repo_a"
        model.threads[0].checkoutId = "checkout_a"
        let threadA=model.threads[0].id

        model.repoId = "repo_b"
        model.checkoutId = "checkout_b"
        model.newThread()
        let threadB=model.selectedThreadId!

        model.selectThread(threadA)
        model.page = .knowledge
        model.selectThread(threadB)

        XCTAssertEqual(model.page,.agent)
        XCTAssertEqual(model.repoId,"repo_b")
        XCTAssertEqual(model.navigationBackStack.last,
                       NativeNavigationEntry(page:.knowledge,threadId:threadA,recordId:nil))

        model.goBack()

        XCTAssertEqual(model.page,.knowledge)
        XCTAssertEqual(model.selectedThreadId,threadA)
        XCTAssertEqual(model.repoId,"repo_a")
        XCTAssertEqual(model.checkoutId,"checkout_a")
    }

    @MainActor
    func testOpenProjectReusesMostRecentBoundConversation() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.threads[0].repoId = "repo_a"
        model.threads[0].checkoutId = "checkout_a"
        model.threads[0].updatedAt = Date(timeIntervalSince1970:10)
        let older = model.threads[0].id

        model.repoId = "repo_a"
        model.checkoutId = "checkout_a"
        model.newThread()
        let newer = model.selectedThreadId!
        model.threads[0].updatedAt = Date(timeIntervalSince1970:20)
        model.repoId = "repo_b"
        model.checkoutId = "checkout_b"
        model.newThread()
        let beforeCount = model.threads.count

        model.openProject("repo_a")

        XCTAssertEqual(model.selectedThreadId,newer)
        XCTAssertNotEqual(model.selectedThreadId,older)
        XCTAssertEqual(model.threads.count,beforeCount)
        XCTAssertEqual(model.repoId,"repo_a")
        XCTAssertEqual(model.checkoutId,"checkout_a")
    }

    @MainActor
    func testOpeningCheckoutReusesConversationFromExactWorktreeOnly() {
        let folder=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model=NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.repoId="repo_a"
        model.checkoutId="checkout_primary"
        model.newThread()
        let primaryThread=model.selectedThreadId!
        model.repoId="repo_a"
        model.checkoutId="checkout_linked"
        model.newThread()
        let linkedThread=model.selectedThreadId!
        let originalCount=model.threads.count
        model.openCheckout(inProject:"repo_a",checkoutId:"checkout_primary")
        XCTAssertEqual(model.selectedThreadId,primaryThread)
        XCTAssertNotEqual(model.selectedThreadId,linkedThread)
        XCTAssertEqual(model.checkoutId,"checkout_primary")
        XCTAssertEqual(model.threads.count,originalCount)
    }

    @MainActor
    func testNewThreadInCurrentProjectUsesExistingCheckoutWithoutSecondRegistryPath() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.repoId = "repo_a"
        model.checkoutId = "checkout_a"
        let beforeCount = model.threads.count

        model.newThread(inProject:"repo_a")

        XCTAssertEqual(model.threads.count,beforeCount + 1)
        XCTAssertEqual(model.thread?.repoId,"repo_a")
        XCTAssertEqual(model.thread?.checkoutId,"checkout_a")
    }

    @MainActor
    func testPageTransitionClearsOnlyStalePageError() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.page = .agent
        model.error = "agent error"

        model.show(.agent)
        XCTAssertEqual(model.error,"agent error")

        model.show(.settings)
        XCTAssertNil(model.error)
    }

    @MainActor
    func testConversationSearchToggleOwnsNavigationAndClearSemantics() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.page = .settings
        model.search = "provider"

        model.toggleConversationSearch()
        XCTAssertEqual(model.page,.agent)
        XCTAssertTrue(model.showSearch)
        XCTAssertEqual(model.search,"provider")

        model.toggleConversationSearch()
        XCTAssertFalse(model.showSearch)
        XCTAssertEqual(model.search,"")
    }

    @MainActor
    func testNewThreadLeavesGlobalSearchAndSelectsVisibleDraft() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        model.showSearch = true
        model.search = "no-matching-title"

        model.newThread()

        XCTAssertFalse(model.showSearch)
        XCTAssertEqual(model.search,"")
        XCTAssertEqual(model.visibleThreads.first?.id,model.selectedThreadId)
    }

    @MainActor
    func testThreadDeleteOnlyRemovesLocalTargetAndKeepsSelectionDeterministic() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let first = model.selectedThreadId!
        model.threads[0].repoId = "repo_a"
        model.threads[0].checkoutId = "checkout_a"
        model.threads[0].providerSessionId = "session_a"
        model.newThread()
        let selected = model.selectedThreadId!
        model.threads[0].repoId = "repo_b"
        model.threads[0].checkoutId = "checkout_b"

        model.deleteThread(first)
        XCTAssertEqual(model.threads.count,1)
        XCTAssertEqual(model.selectedThreadId,selected)
        XCTAssertEqual(model.threads[0].id,selected)

        model.draft = "stale draft"
        model.agentChanges = AgentGitDiff(
            repoId:"repo_b",checkoutId:"checkout_b",branch:"main",head:"abc",
            staged:false,paths:[],nameOnly:["A.swift"],
            stat:"",patch:"diff",truncated:false,untracked:[]
        )
        model.changesLoading = true
        model.knowledgeLoading = true
        model.threads.append(ChatThread(repoId:"repo_c",checkoutId:"checkout_c"))
        let fallback = model.threads.last!.id
        model.deleteThread(selected)
        XCTAssertEqual(model.selectedThreadId,fallback)
        XCTAssertEqual(model.repoId,"repo_c")
        XCTAssertEqual(model.checkoutId,"checkout_c")
        XCTAssertEqual(model.draft,"")
        XCTAssertNil(model.agentChanges)
        XCTAssertFalse(model.changesLoading)
        XCTAssertFalse(model.knowledgeLoading)

        model.deleteThread(fallback)
        XCTAssertEqual(model.threads.count,1)
        XCTAssertNotEqual(model.selectedThreadId,fallback)
        XCTAssertTrue(model.threads[0].messages.isEmpty)
    }

    func testAgentTurnFailureSeparatesSafeCancelFromEffectReconciliation() {
        let cancelled = NativeWorkspace.agentTurnFailure("FORGE_DESKTOP_API_TURN_CANCELLED")
        XCTAssertEqual(cancelled.message,"请求已取消。")
        XCTAssertFalse(cancelled.effectReviewRequired)

        let afterTool = NativeWorkspace.agentTurnFailure(
            "FORGE_DESKTOP_API_TURN_CANCELLED_AFTER_TOOL:forge-desktop-api-42"
        )
        XCTAssertTrue(afterTool.message.contains("forge-desktop-api-42"))
        XCTAssertTrue(afterTool.effectReviewRequired)

        let failedAfterTool = NativeWorkspace.agentTurnFailure(
            "FORGE_DESKTOP_API_TURN_FAILED_AFTER_TOOL:forge-desktop-api-77:FORGE_DESKTOP_API_HTTP_503"
        )
        XCTAssertTrue(failedAfterTool.message.contains("forge-desktop-api-77"))
        XCTAssertFalse(failedAfterTool.message.contains("HTTP_503"))
        XCTAssertTrue(failedAfterTool.effectReviewRequired)

        let reconcile = NativeWorkspace.agentTurnFailure(
            "FORGE_DESKTOP_LOCAL_EFFECT_RECONCILIATION_REQUIRED:forge-desktop-api-99:timeout"
        )
        XCTAssertTrue(reconcile.message.contains("forge-desktop-api-99"))
        XCTAssertFalse(reconcile.message.contains("timeout"))
        XCTAssertTrue(reconcile.effectReviewRequired)

        let readOnlyTimeout = NativeWorkspace.agentTurnFailure(
            "FORGE_DESKTOP_LOCAL_TOOL_OUTCOME_UNKNOWN", toolName:"git_status"
        )
        XCTAssertTrue(readOnlyTimeout.message.contains("git_status"))
        XCTAssertTrue(readOnlyTimeout.message.contains("结果未确认"))
        let readTimeout = NativeWorkspace.agentTurnFailure(
            "FORGE_DESKTOP_LOCAL_TOOL_TIMEOUT", toolName:"git_status"
        )
        XCTAssertTrue(readTimeout.message.contains("只读查询超时"))
        XCTAssertFalse(readTimeout.effectReviewRequired)
        XCTAssertFalse(readOnlyTimeout.effectReviewRequired)

        let effectTimeout = NativeWorkspace.agentTurnFailure(
            "FORGE_DESKTOP_LOCAL_EFFECT_RECONCILIATION_REQUIRED:forge-desktop-api-101:FORGE_DESKTOP_LOCAL_TOOL_OUTCOME_UNKNOWN",
            toolName:"apply_patch"
        )
        XCTAssertTrue(effectTimeout.message.contains("forge-desktop-api-101"))
        XCTAssertTrue(effectTimeout.effectReviewRequired)

        let unknown = NativeWorkspace.agentTurnFailure("CUSTOM_PROVIDER_ERROR")
        XCTAssertEqual(unknown.message,"CUSTOM_PROVIDER_ERROR")
        XCTAssertTrue(unknown.effectReviewRequired)
    }

    func testApiToolProgressEventsReconcileByToolCallId() {
        let started = NativeWorkspace.apiToolProgressEvents(
            [],
            payload:["name":"git_status","phase":"started","toolCallId":"call-1"],
            now:"started-at"
        )
        XCTAssertEqual(started.count,1)
        XCTAssertEqual(started.first?.status,"running")

        let finished = NativeWorkspace.apiToolProgressEvents(
            started,
            payload:["name":"git_status","phase":"unknown","toolCallId":"call-1"],
            now:"finished-at"
        )
        XCTAssertEqual(finished.count,1)
        XCTAssertEqual(finished.first?.status,"unknown")
        XCTAssertEqual(finished.first?.startedAt,"started-at")
        XCTAssertEqual(finished.first?.completedAt,"finished-at")
        XCTAssertEqual(finished.first?.toolCallId,"call-1")

        let distinct = NativeWorkspace.apiToolProgressEvents(
            finished,
            payload:["name":"git_status","phase":"started","toolCallId":"call-2"],
            now:"second-start"
        )
        XCTAssertEqual(distinct.count,2)
        XCTAssertNotEqual(distinct[0].id,distinct[1].id)
    }

    func testFailedToolProgressIsPersistableAsUnknown() {
        let running = AgentLiveActivityEvent(
            phase:"tool", label:"apply_patch", detail:"request-1",
            status:"running", startedAt:"started-at", completedAt:nil,
            toolCallId:"call-1"
        )
        let finalized = NativeWorkspace.finalizeFailedToolEvents([running],now:"failed-at")
        XCTAssertEqual(finalized.count,1)
        XCTAssertEqual(finalized.first?.status,"unknown")
        XCTAssertEqual(finalized.first?.completedAt,"failed-at")
        XCTAssertEqual(finalized.first?.detail,"request-1")
    }

    @MainActor
    func testFailedComposerRecoveryNeverOverwritesNewInput() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let id = model.selectedThreadId!
        let image = URL(fileURLWithPath:"/tmp/example.png")

        XCTAssertTrue(model.restoreFailedComposer(
            conversationId:id, prompt:"retry me", imageURLs:[image], contextPaths:["Sources/App.swift"]
        ))
        XCTAssertEqual(model.draft,"retry me")
        XCTAssertEqual(model.pendingImageURLs,[image])
        XCTAssertEqual(model.pendingContextPaths,["Sources/App.swift"])

        model.draft = "new user input"
        model.pendingImageURLs = []
        model.pendingContextPaths = []
        XCTAssertFalse(model.restoreFailedComposer(
            conversationId:id, prompt:"stale failed prompt", imageURLs:[], contextPaths:[]
        ))
        XCTAssertEqual(model.draft,"new user input")
    }

    @MainActor
    func testReeditRestoresValidRepositoryContextButNeverFabricatesImages() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let nested = root.appendingPathComponent("Sources")
        let file = nested.appendingPathComponent("Agent.swift")
        defer { try? FileManager.default.removeItem(at:root) }
        try FileManager.default.createDirectory(at:nested,withIntermediateDirectories:true)
        try Data("source".utf8).write(to:file)

        let model = NativeWorkspace(store:root.appendingPathComponent("conversations.json"))
        model.checkoutRoot = root
        let message = ChatMessage(
            role:"user", text:"change this",
            attachmentNames:["screen.png"], contextPaths:["Sources/Agent.swift"]
        )

        model.reeditMessage(message)

        XCTAssertEqual(model.draft,"change this")
        XCTAssertEqual(model.pendingContextPaths,["Sources/Agent.swift"])
        XCTAssertTrue(model.pendingImageURLs.isEmpty)
        XCTAssertTrue(model.error?.contains("重新附加图片") == true)

        model.busy = true
        model.draft = "keep current"
        model.reeditMessage(ChatMessage(role:"user",text:"must not overwrite"))
        XCTAssertEqual(model.draft,"keep current")
    }

    @MainActor
    func testAttachmentSelectionAppendsDedupesAndDroppedFilesReuseExistingPaths() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let nested = root.appendingPathComponent("Sources")
        let first = nested.appendingPathComponent("First.swift")
        let second = nested.appendingPathComponent("Second.swift")
        defer { try? FileManager.default.removeItem(at:root) }
        try FileManager.default.createDirectory(at:nested,withIntermediateDirectories:true)
        try Data("one".utf8).write(to:first)
        try Data("two".utf8).write(to:second)

        let model = NativeWorkspace(store:root.appendingPathComponent("conversations.json"))
        model.checkoutRoot = root
        model.imageInputAvailable = true
        let image1 = URL(fileURLWithPath:"/tmp/drop-one.png")
        let image2 = URL(fileURLWithPath:"/tmp/drop-two.jpg")

        model.addPendingImages([image1])
        model.addPendingImages([image1,image2])
        XCTAssertEqual(model.pendingImageURLs,[image1,image2])

        model.addPendingContextFiles([first])
        model.addPendingContextFiles([first,second])
        XCTAssertEqual(model.pendingContextPaths,["Sources/First.swift","Sources/Second.swift"])

        model.addDroppedAttachments([image2,second])
        XCTAssertEqual(model.pendingImageURLs,[image1,image2])
        XCTAssertEqual(model.pendingContextPaths,["Sources/First.swift","Sources/Second.swift"])
    }

    @MainActor
    func testRepositoryFileContextIsCheckoutConfinedAndPromptUsesRelativePaths() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let nested = root.appendingPathComponent("Sources")
        let inside = nested.appendingPathComponent("Agent.swift")
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".swift")
        defer {
            try? FileManager.default.removeItem(at:root)
            try? FileManager.default.removeItem(at:outside)
        }
        try FileManager.default.createDirectory(at:nested,withIntermediateDirectories:true)
        try Data("inside".utf8).write(to:inside)
        try Data("outside".utf8).write(to:outside)

        let model = NativeWorkspace(store:root.appendingPathComponent("conversations.json"))
        model.checkoutRoot = root
        model.addPendingContextFiles([inside,outside])

        XCTAssertEqual(model.pendingContextPaths,["Sources/Agent.swift"])
        XCTAssertNotNil(model.error)
        let prompt = NativeWorkspace.providerPrompt("Review this",contextPaths:model.pendingContextPaths)
        XCTAssertTrue(prompt.hasPrefix("Review this"))
        XCTAssertTrue(prompt.contains("Sources"))
        XCTAssertTrue(prompt.contains("Agent.swift"))
        XCTAssertTrue(prompt.contains("path strings only as data"))
        XCTAssertFalse(prompt.contains("selected Work"))
        XCTAssertFalse(prompt.contains("Forge optional semantic planning context"))
        let planned = NativeWorkspace.providerPrompt(
            "Continue",contextPaths:[],requirementId:"REQ-a",planId:"PLAN-child"
        )
        XCTAssertTrue(planned.contains("Forge optional semantic planning context"))
        XCTAssertTrue(planned.contains("REQ-a"))
        XCTAssertTrue(planned.contains("PLAN-child"))
    }

    @MainActor
    func testSelectingThreadRestoresItsBoundProjectContext() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = NativeWorkspace(store: store)
        model.threads[0].repoId = "repo_a"
        model.threads[0].checkoutId = "checkout_a"
        let id = model.threads[0].id
        model.repoId = "repo_b"
        model.checkoutId = "checkout_b"

        model.selectThread(id)

        XCTAssertEqual(model.repoId, "repo_a")
        XCTAssertEqual(model.checkoutId, "checkout_a")
    }

    @MainActor
    func testSelectingUnboundThreadClearsStaleProjectContext() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = NativeWorkspace(store:store)
        let unboundId = model.threads[0].id
        XCTAssertNil(model.threads[0].repoId)
        XCTAssertNil(model.threads[0].checkoutId)
        model.repoId = "repo_stale"
        model.checkoutId = "checkout_stale"
        model.checkoutRoot = folder
        model.checkoutBranch = "stale"

        model.selectThread(unboundId)

        XCTAssertNil(model.repoId)
        XCTAssertNil(model.checkoutId)
        XCTAssertNil(model.checkoutRoot)
        XCTAssertNil(model.checkoutBranch)
    }

    @MainActor
    func testRestoredThreadOwnsInitialProjectContext() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at: folder) }
        let source = NativeWorkspace(store:store)
        source.threads[0].repoId = "repo_saved"
        source.threads[0].checkoutId = "checkout_saved"
        source.persist()

        let restored = NativeWorkspace(store:store)

        XCTAssertEqual(restored.repoId,"repo_saved")
        XCTAssertEqual(restored.checkoutId,"checkout_saved")
        XCTAssertEqual(restored.thread?.repoId,"repo_saved")
        XCTAssertEqual(restored.thread?.checkoutId,"checkout_saved")
    }

    func testRepositoryCheckoutContextUsesRequestedOrActiveCheckoutWithoutFabricatingState() {
        let result: [String:Any] = ["repository":[
            "activeCheckoutId":"checkout_active",
            "checkouts":[
                ["checkoutId":"checkout_active","path":"/tmp/active","branch":"main"],
                ["checkoutId":"checkout_requested","path":"/tmp/requested","branch":"feature"],
                ["checkoutId":"checkout_removed","path":"/tmp/removed","branch":"old","lifecycle":"removed"]
            ]
        ]]
        let active = NativeWorkspace.repositoryCheckoutContext(result,requestedCheckoutId:nil)
        XCTAssertEqual(active.checkoutId,"checkout_active")
        XCTAssertEqual(active.checkoutBranch,"main")
        XCTAssertEqual(active.checkoutRoot?.path,"/tmp/active")

        let requested = NativeWorkspace.repositoryCheckoutContext(result,requestedCheckoutId:"checkout_requested")
        XCTAssertEqual(requested.checkoutId,"checkout_requested")
        XCTAssertEqual(requested.checkoutBranch,"feature")
        XCTAssertEqual(requested.checkoutRoot?.path,"/tmp/requested")

        let removed = NativeWorkspace.repositoryCheckoutContext(result,requestedCheckoutId:"checkout_removed")
        XCTAssertNil(removed.checkoutRoot)
        XCTAssertNil(removed.checkoutBranch)
    }

    func testCheckoutPathValidationRequiresGitMetadata() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }

        XCTAssertFalse(NativeWorkspace.checkoutPathIsGitWorktree(root))
        try Data("gitdir: /tmp/worktree".utf8).write(to:root.appendingPathComponent(".git"))
        XCTAssertTrue(NativeWorkspace.checkoutPathIsGitWorktree(root))
    }

    func testIncompleteAssistantTurnSurvivesPersistenceAndLegacyDecode() throws {
        let message = ChatMessage(role:"assistant",text:"Still running",incomplete:true)
        let data = try JSONEncoder().encode(message)
        let restored = try JSONDecoder().decode(ChatMessage.self,from:data)
        XCTAssertEqual(restored.incomplete,true)

        var previous = try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
        previous.removeValue(forKey:"incomplete")
        let oldData = try JSONSerialization.data(withJSONObject:previous)
        XCTAssertNil(try JSONDecoder().decode(ChatMessage.self,from:oldData).incomplete)
    }

    func testRegistryProjectLabelDoesNotFabricateRepository() {
        let item = ForgeProject(repoId:"r",displayName:"Forge",localRoot:nil,checkoutId:nil,
                                remoteUrl:"https://github.com/moretea-labs/forge.git",defaultBranch:"main")
        XCTAssertEqual(item.label, "moretea-labs/forge")
    }
}


extension NativeWorkspaceTests {
    func testLiveActivityTimelineDecodesAndRemainsBackwardCompatible() throws {
        let current = Data("""
        {"conversationId":"c1","status":"running","phase":"tool","toolActivityCount":1,"lastActivity":"正在使用 forge.rh_status","events":[{"phase":"thinking","label":"正在推理","status":"completed","startedAt":"2026-11-07T00:00:00.000Z","completedAt":"2026-11-07T00:00:01.000Z"},{"phase":"tool","label":"正在使用 forge.rh_status","status":"active","startedAt":"2026-11-07T00:00:01.000Z"}]}
        """.utf8)
        let activity = try JSONDecoder().decode(AgentLiveActivity.self, from: current)
        XCTAssertEqual(activity.events?.count, 2)
        XCTAssertEqual(activity.priorEvents.map(\.label), ["正在推理"])
        XCTAssertEqual(activity.recentPriorEvents.map(\.label), ["正在推理"])

        let legacy = Data("""
        {"conversationId":"c2","status":"running","phase":"thinking","toolActivityCount":0,"lastActivity":"正在推理"}
        """.utf8)
        let legacyActivity = try JSONDecoder().decode(AgentLiveActivity.self, from: legacy)
        XCTAssertNil(legacyActivity.events)
        XCTAssertTrue(legacyActivity.recentPriorEvents.isEmpty)
    }
}


extension NativeWorkspaceTests {
    func testAgentMessageBlocksSeparateMarkdownAndFencedCodeWithoutDuplicatingContent() {
        let text = "**Done**\n\n```swift\nlet answer = 42\nprint(answer)\n```\n\nNext step."
        XCTAssertEqual(AgentMessageBlock.parse(text),[
            .markdown("**Done**"),
            .code(language:"swift",text:"let answer = 42\nprint(answer)"),
            .markdown("Next step.")
        ])
    }

    func testAgentMessageBlocksKeepUnclosedFenceAsCode() {
        XCTAssertEqual(
            AgentMessageBlock.parse("Before\n```\nline 1\nline 2"),
            [.markdown("Before"),.code(language:nil,text:"line 1\nline 2")]
        )
    }
}


extension NativeWorkspaceTests {
    @MainActor
    func testPendingImageDraftIsCapabilityGatedBoundedAndNotPersistedAsPaths() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = NativeWorkspace(store: store)

        let images = (0..<5).map { URL(fileURLWithPath:"/tmp/image-\($0).png") }
        model.imageInputAvailable = false
        model.addPendingImages(images)
        XCTAssertTrue(model.pendingImageURLs.isEmpty)

        model.imageInputAvailable = true
        model.addPendingImages(images)
        XCTAssertEqual(model.pendingImageURLs.count,4)
        XCTAssertTrue(model.threads[0].messages.isEmpty)
    }
}
