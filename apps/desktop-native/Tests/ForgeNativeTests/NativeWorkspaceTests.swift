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

    @MainActor
    func testPlanningInspectorBindingUpdatesOnlyCurrentConversationContext() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:store)
        let originalId = model.thread?.id

        model.bindCurrentThreadPlanningContext(requirementId:"REQ-inspector",planId:"PLAN-inspector")
        XCTAssertEqual(model.thread?.id,originalId)
        XCTAssertEqual(model.thread?.requirementId,"REQ-inspector")
        XCTAssertEqual(model.thread?.planId,"PLAN-inspector")

        let restored = NativeWorkspace(store:store)
        XCTAssertEqual(restored.thread?.id,originalId)
        XCTAssertEqual(restored.thread?.requirementId,"REQ-inspector")
        XCTAssertEqual(restored.thread?.planId,"PLAN-inspector")

        restored.clearCurrentThreadPlanningContext()
        XCTAssertNil(restored.thread?.requirementId)
        XCTAssertNil(restored.thread?.planId)

        let cleared = NativeWorkspace(store:store)
        XCTAssertNil(cleared.thread?.requirementId)
        XCTAssertNil(cleared.thread?.planId)
    }

    @MainActor
    func testKnowledgeReuseAddsEditableDraftContextWithoutSendingOrDuplicating() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let memory = KnowledgeMemoryDetail(
            id:"memory-1",
            revision:3,
            canonicalText:"Prefer one canonical authority for semantic state.",
            concepts:["authority","semantic-state"],
            facets:["architecture"],
            confidence:0.94,
            scope:KnowledgeScopeDetail(kind:"project",id:"repo-a"),
            provenance:KnowledgeProvenanceDetail(sourceKind:"system_inference",recordedAt:nil)
        )

        model.draft = "Continue the current task."
        let messageCount = model.thread?.messages.count
        model.useKnowledgeInCurrentConversation(memory)

        XCTAssertEqual(model.page,.agent)
        XCTAssertEqual(model.thread?.messages.count,messageCount)
        XCTAssertTrue(model.draft.contains("Continue the current task."))
        XCTAssertTrue(model.draft.contains(memory.canonicalText))
        XCTAssertTrue(model.draft.contains("请参考这条 Forge 项目知识继续当前任务"))

        model.useKnowledgeInCurrentConversation(memory)
        XCTAssertEqual(
            model.draft.components(separatedBy:memory.canonicalText).count - 1,
            1
        )
    }

    func testInitialAgentRecallIsAdvisoryAndAvailableToBothProviderPrompts() {
        let recall = KnowledgeRecallDetail(
            advisoryOnly:true,
            items:[
                KnowledgeRecallItemDetail(
                    memoryId:"project:new",text:"Keep cards flat and preserve current product requirements.",
                    provenance:KnowledgeProvenanceDetail(sourceKind:"controller",recordedAt:"2026-11-11"),
                    recentUsage:nil
                ),
                KnowledgeRecallItemDetail(
                    memoryId:"project:old",text:"Old layout guidance.",
                    provenance:KnowledgeProvenanceDetail(sourceKind:"controller",recordedAt:"2026-10-01"),
                    recentUsage:KnowledgeRecallUsageDetail(rejectedCount:2,staleCount:2)
                )
            ],
            gaps:[],
            repositoryGuidance:[
                KnowledgeRepositoryGuidanceDetail(
                    path:"DESIGN.md",content:"Do not add decorative shadows to cards.",
                    truncated:false
                ),
                KnowledgeRepositoryGuidanceDetail(
                    path:"docs/mvp2/design/design-rules.md",
                    content:"Preserve the original inventory tracking layout.",
                    truncated:true
                )
            ]
        )
        let context = NativeWorkspace.advisoryKnowledgeText(recall)
        XCTAssertNotNil(context)
        XCTAssertTrue(context?.contains("project:new") == true)
        XCTAssertTrue(context?.contains("earlier rejection recorded") == true)
        let codex = NativeWorkspace.providerPrompt(
            "Continue implementation",contextPaths:[],
            requirementId:"REQ-1",advisoryKnowledge:context
        )
        XCTAssertTrue(codex.contains("Forge project knowledge"))
        XCTAssertTrue(codex.contains("repository contracts"))
        XCTAssertTrue(codex.contains("project:old"))
        XCTAssertTrue(codex.contains("DESIGN.md"))
        XCTAssertTrue(codex.contains("Do not add decorative shadows"))
        XCTAssertTrue(codex.contains("partial: read full source before editing"))
        var thread = ChatThread(provider:"api")
        thread.requirementId = "REQ-1"
        let messages = NativeWorkspace.apiTurnMessages(
            thread,prompt:"Continue implementation",contextPaths:[],advisoryKnowledge:context
        )
        XCTAssertEqual(messages.count,1)
        XCTAssertTrue(messages[0]["content"]?.contains("project:new") == true)
        XCTAssertFalse(NativeWorkspace.providerPrompt("Continue",contextPaths:[]).contains("Forge project knowledge"))
        XCTAssertNil(NativeWorkspace.advisoryKnowledgeText(KnowledgeRecallDetail(
            advisoryOnly:true,items:[],gaps:[]
        )))
    }

    @MainActor
    func testKnowledgeInspectorCannotInsertAfterConversationChanges() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let priorThreadId = model.selectedThreadId
        let memory = KnowledgeMemoryDetail(
            id:"old-thread-memory",revision:1,canonicalText:"A previously loaded memory.",
            concepts:[],facets:[],confidence:1,
            scope:KnowledgeScopeDetail(kind:"workspace",id:"workspace"),
            provenance:nil
        )
        model.newThread()
        XCTAssertNotEqual(model.selectedThreadId,priorThreadId)
        model.draft="Current thread draft"
        model.useKnowledgeInCurrentConversation(memory,expectedThreadId:priorThreadId)
        XCTAssertEqual(model.draft,"Current thread draft")
        XCTAssertFalse(model.draft.contains(memory.canonicalText))
        XCTAssertEqual(model.error,"当前会话已切换，请重新选择知识。")
        model.useKnowledgeInCurrentConversation(memory,expectedThreadId:model.selectedThreadId)
        XCTAssertTrue(model.draft.contains(memory.canonicalText))
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
    func testProviderProfileIsThreadOwnedAndCanSwitchAfterHistory() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:store)
        model.localApiSettings = LocalApiSettingsDetail(
            provider:"api",endpoint:"https://api.example.com/v1",model:"model-a",
            apiProtocol:"openai",hasKey:true,endpointReady:true
        )
        XCTAssertEqual(model.selectedProvider,"api:legacy-api")
        model.selectThreadProvider("api:legacy-api")
        XCTAssertEqual(model.thread?.provider,"api:legacy-api")
        model.threads[0].messages.append(ChatMessage(role:"user",text:"hello"))

        model.selectThreadProvider("codex")
        XCTAssertEqual(model.thread?.provider,"codex")
        model.selectThreadProvider("api:legacy-api")
        XCTAssertEqual(model.thread?.provider,"api:legacy-api")

        model.persist()
        let restored = NativeWorkspace(store:store)
        XCTAssertEqual(restored.thread?.provider,"api:legacy-api")
        XCTAssertEqual(restored.selectedProvider,"api:legacy-api")

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

    func testRetryOfIncompleteTurnDoesNotDuplicateUserPromptInModelHistory() {
        var thread = ChatThread(provider:"api")
        thread.messages = [
            ChatMessage(role:"user",text:"previous task"),
            ChatMessage(role:"assistant",text:"previous result"),
            ChatMessage(role:"user",text:"build the feature"),
            ChatMessage(role:"assistant",text:"tool delivery unknown",incomplete:true)
        ]
        let retry = NativeWorkspace.apiTurnMessages(thread,prompt:"build the feature",contextPaths:[])
        XCTAssertEqual(retry.map { $0["role"] },["user","assistant","user"])
        XCTAssertEqual(retry.map { $0["content"] },[
            "previous task","previous result","build the feature"
        ])
        let continuation = NativeWorkspace.apiTurnMessages(thread,prompt:"继续",contextPaths:[])
        XCTAssertEqual(continuation.map { $0["content"] },[
            "previous task","previous result","build the feature","继续"
        ])
        // The source of audit evidence is unchanged, even when history is compacted.
        XCTAssertEqual(thread.messages.count,4)
        XCTAssertEqual(thread.messages[3].incomplete,true)
    }

    @MainActor
    func testAgentComposerUsesSameCheckoutAndProviderReadinessAsSend() async {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        XCTAssertEqual(model.agentSendBlockReason,"Codex 未就绪，请刷新 Provider 状态。")

        model.threads[0].repoId = "repo-test"
        model.threads[0].checkoutId = nil
        XCTAssertEqual(model.agentSendBlockReason,"当前会话缺少 checkout，请重新选择项目。")
        model.threads[0].checkoutId = "checkout-test"
        model.checkoutContextLoading = true
        XCTAssertEqual(model.agentSendBlockReason,"正在验证 checkout，完成后即可发送。")

        model.checkoutContextLoading = false
        XCTAssertEqual(model.agentSendBlockReason,"checkout 不可用，请切换到有效的工作区。")
        model.draft = "implement feature"
        await model.send()
        XCTAssertEqual(model.error,model.agentSendBlockReason)
        XCTAssertEqual(model.draft,"implement feature")
        XCTAssertTrue(model.threads[0].messages.isEmpty)
        model.busy = true
        XCTAssertEqual(model.agentSendBlockReason,"Agent 正在执行当前任务。")
    }

    func testIncompleteManagedProcessIsAvailableToOrdinaryFollowUpWithoutReplaying() {
        var thread = ChatThread(provider:"api")
        thread.messages = [
            ChatMessage(role:"user",text:"run build"),
            ChatMessage(
                role:"assistant",text:"Process accepted",activityEvents:[
                    AgentLiveActivityEvent(
                        phase:"tool",label:"run_command",detail:"proc_abc_123",
                        status:"running",startedAt:"now",completedAt:nil,toolCallId:"call-1"
                    ),
                    AgentLiveActivityEvent(
                        phase:"tool",label:"run_command",detail:"proc_abc_123",
                        status:"unknown",startedAt:"now",completedAt:nil,toolCallId:"call-2"
                    ),
                    AgentLiveActivityEvent(
                        phase:"tool",label:"read_file",detail:"proc_not_ours",
                        status:"running",startedAt:"now",completedAt:nil,toolCallId:"call-3"
                    )
                ],incomplete:true
            )
        ]
        let resumed = NativeWorkspace.apiTurnMessages(thread,prompt:"继续",contextPaths:[])
        XCTAssertEqual(resumed.count,2)
        XCTAssertTrue(resumed[1]["content"]?.contains("proc_abc_123") == true)
        XCTAssertTrue(resumed[1]["content"]?.contains("process_status") == true)
        XCTAssertEqual(resumed[1]["content"]?.components(separatedBy:"proc_abc_123").count,2)
        XCTAssertFalse(resumed[1]["content"]?.contains("proc_not_ours") == true)
        XCTAssertFalse(resumed[1]["content"]?.contains("Process accepted") == true)

        thread.messages[1].activityEvents = [
            AgentLiveActivityEvent(
                phase:"tool",label:"run_command",detail:"proc_wrong;rm",
                status:"running",startedAt:"now",completedAt:nil,toolCallId:"call-4"
            )
        ]
        let invalid = NativeWorkspace.apiTurnMessages(thread,prompt:"继续",contextPaths:[])
        XCTAssertFalse(invalid[1]["content"]?.contains("process_status") == true)
    }

    func testManagedProcessActivityRemainsRunningUntilTerminalReceipt() {
        let events = NativeWorkspace.apiActivityEvents([[
            "name":"run_command","ok":false,"status":"running",
            "processId":"proc_abc_123","toolCallId":"call-1","requestId":"effect-1"
        ]])
        XCTAssertEqual(events?.count,1)
        XCTAssertEqual(events?.first?.status,"running")
        XCTAssertEqual(events?.first?.detail,"proc_abc_123")
    }

    func testApiStreamingPreviewIsBoundedAndBridgePreservesModelEvents() {
        XCTAssertEqual(NativeWorkspace.appendBoundedPreview("ab",delta:"cdef",limit:4),"abcd")
        XCTAssertEqual(NativeWorkspace.appendBoundedPreview("abcd",delta:"next",limit:4),"abcd")
        let modelEvent = #"{"type":"progress","data":{"kind":"text_delta","delta":"Hello","conversationId":"c1"}}"#.data(using:.utf8)!
        let decoded = ForgeApiTurn.decodeEvent(modelEvent)
        XCTAssertEqual((decoded?["data"] as? [String:Any])?["delta"] as? String,"Hello")
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

    func testPrimaryWorkspaceNavigationKeepsRuntimeOutOfPeerDestinations() {
        XCTAssertFalse(NativePage.allCases.contains { $0.rawValue.lowercased().contains("runtime") })
        XCTAssertTrue(NativePage.allCases.contains(.schedule))
        XCTAssertTrue(NativePage.allCases.contains(.plugins))
        XCTAssertTrue(NativePage.allCases.contains(.knowledge))
        XCTAssertTrue(NativePage.allCases.contains(.settings))
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

    func testMcpShellPathQuotingPreservesSpacesAndEmbeddedQuotes() {
        XCTAssertEqual(
            shellQuotedMcpPath("/Users/greyson/Dev Projects/forge"),
            "'/Users/greyson/Dev Projects/forge'"
        )
        XCTAssertEqual(
            shellQuotedMcpPath("/Users/greyson/Dev/grey's repo"),
            "'/Users/greyson/Dev/grey'\\''s repo'"
        )
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
                "repair":["available":true,"label":"Refresh Forge Connector"],
                "setup":[
                    "status":"open",
                    "nextAction":[
                        "id":"runtime.install",
                        "summary":"Install Forge Runtime",
                        "risk":"workspace_write",
                        "requiresUser":false
                    ]
                ]
            ]
        ])
        XCTAssertEqual(connection?.controller.ready,true)
        XCTAssertEqual(connection?.tunnel.ready,false)
        XCTAssertEqual(connection?.repairAvailable,true)
        XCTAssertEqual(connection?.repairLabel,"Refresh Forge Connector")
        XCTAssertEqual(connection?.setup?.status,"open")
        XCTAssertEqual(connection?.setup?.id,"runtime.install")
        XCTAssertEqual(connection?.setup?.summary,"Install Forge Runtime")
        XCTAssertEqual(connection?.setup?.risk,"workspace_write")
        XCTAssertEqual(connection?.setup?.requiresUser,false)
        XCTAssertEqual(NativeWorkspace.connectionLabel(connection),"远程 MCP 未连接")
        let configuredConnection = NativeWorkspace.controllerConnectionDetail([
            "connection":[
                "configured":true,"ready":true,
                "controller":["ready":true,"title":"Controller configured","detail":"setup"],
                "tunnel":["ready":true,"title":"Transport configured","detail":"setup"]
            ]
        ])
        XCTAssertEqual(NativeWorkspace.connectionLabel(configuredConnection),"MCP 配置就绪")
        let unconfiguredConnection = NativeWorkspace.controllerConnectionDetail([
            "connection":[
                "configured":false,"ready":false,
                "controller":["ready":false,"title":"Not configured","detail":""],
                "tunnel":["ready":false,"title":"No transport","detail":""]
            ]
        ])
        XCTAssertEqual(NativeWorkspace.connectionLabel(unconfiguredConnection),"MCP 未配置")
        let authFailedConnection = NativeWorkspace.controllerConnectionDetail([
            "connection":[
                "configured":true,"ready":false,
                "controller":["ready":true,"title":"Controller ready","detail":"local"],
                "tunnel":["ready":false,"title":"认证失败","detail":"远程 MCP 凭据无效"],
                "repair":["available":true]
            ]
        ])
        XCTAssertEqual(authFailedConnection?.tunnel.title,"认证失败")
        XCTAssertEqual(authFailedConnection?.tunnel.detail,"远程 MCP 凭据无效")
        XCTAssertEqual(authFailedConnection?.repairAvailable,true)
        XCTAssertEqual(authFailedConnection?.repairLabel,"重新连接")
        XCTAssertEqual(NativeWorkspace.connectionLabel(authFailedConnection),"远程 MCP 未连接")
        XCTAssertEqual(NativeWorkspace.connectionLabel(nil),"MCP 暂不可用")
        XCTAssertEqual(NativeWorkspace.connectionLabel(nil,loading:true),"正在读取连接")
        XCTAssertEqual(NativeWorkspace.runtimeLabel(nil,loading:false),"Runtime 暂不可用")
        XCTAssertEqual(NativeWorkspace.runtimeLabel(nil,loading:true),"正在读取运行时")
        XCTAssertEqual(NativeWorkspace.runtimeDescription(nil,loading:false),"暂时无法读取 Runtime 状态；可刷新或运行诊断。")
        XCTAssertEqual(NativeWorkspace.runtimeDescription(nil,loading:true),"正在读取主运行时状态。")
        XCTAssertNil(NativeWorkspace.controllerConnectionDetail(["unexpected":true]))
    }

    @MainActor
    func testUnavailableStatusLabelsAreDerivedFromCanonicalWorkspaceState() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))

        XCTAssertEqual(model.connection,"MCP 暂不可用")
        XCTAssertEqual(model.runtimeLabel,"Runtime 暂不可用")
        XCTAssertEqual(model.runtimeDescription,"暂时无法读取 Runtime 状态；可刷新或运行诊断。")

        model.connectionLoading = true
        model.runtimeLoading = true
        XCTAssertEqual(model.connection,"正在读取连接")
        XCTAssertEqual(model.runtimeLabel,"正在读取运行时")
        XCTAssertEqual(model.runtimeDescription,"正在读取主运行时状态。")
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

    func testSavedApiProfileProjectionAndBridgeBoundary() {
        let settings = NativeWorkspace.localApiSettingsDetail([
            "schemaVersion":2,
            "defaultProvider":"api:deepseek",
            "profiles":[
                [
                    "id":"deepseek","providerId":"api:deepseek","label":"DeepSeek",
                    "endpoint":"https://api.deepseek.com","model":"deepseek-flash",
                    "apiProtocol":"openai","credentialRef":"cred_fixture",
                    "hasKey":true,"endpointReady":true
                ],
                [
                    "id":"openai","providerId":"api:openai","label":"OpenAI",
                    "endpoint":"https://api.openai.com/v1","model":"gpt-test",
                    "apiProtocol":"responses","hasKey":true,"endpointReady":true
                ]
            ],
            "joyCodeModel":"JoyAI-Code-1.6","joyCodeReady":false
        ])
        XCTAssertEqual(settings?.schemaVersion,2)
        XCTAssertEqual(settings?.defaultProvider,"api:deepseek")
        XCTAssertEqual(settings?.profiles.count,2)
        XCTAssertEqual(settings?.profile(providerId:"api:deepseek")?.model,"deepseek-flash")
        XCTAssertEqual(settings?.profile(providerId:"api:openai")?.apiProtocol,"responses")
        XCTAssertEqual(settings?.provider,"api")
        XCTAssertEqual(settings?.endpoint,"https://api.deepseek.com")
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

        let pending = NativeWorkspace.apiToolProgressEvents(
            [],
            payload:["name":"run_command","phase":"running",
                     "processId":"proc_abc_123","requestId":"effect-1","toolCallId":"call-3"],
            now:"pending-at"
        )
        XCTAssertEqual(pending.first?.detail,"proc_abc_123")
        let completed = NativeWorkspace.apiToolProgressEvents(
            pending,
            payload:["name":"run_command","phase":"completed",
                     "processId":"proc_abc_123","requestId":"effect-1","toolCallId":"call-3"],
            now:"completed-at"
        )
        XCTAssertEqual(completed.count,1)
        XCTAssertEqual(completed.first?.detail,"proc_abc_123")
        XCTAssertEqual(completed.first?.status,"completed")
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

    func testProjectScheduleRowsDecodeCanonicalSchedulerProjection() {
        let rows = NativeWorkspace.projectScheduleRows([
            "schedules":[[
                "scheduleId":"schedule-1",
                "name":"Watch release",
                "enabled":true,
                "trigger":["type":"interval","everyMinutes":10],
                "operation":"browser_observation",
                "updatedAt":"2026-11-09T00:00:00Z",
                "nextEligibleAt":"2026-11-09T00:10:00Z"
            ]]
        ])
        XCTAssertEqual(rows.count,1)
        XCTAssertEqual(rows[0].scheduleId,"schedule-1")
        XCTAssertEqual(rows[0].trigger,"每 10 分钟")
        XCTAssertEqual(rows[0].operation,"browser_observation")
        XCTAssertTrue(rows[0].enabled)
    }

    func testScheduleEffectsRequireVerifiedCanonicalOutcome() {
        let active = NativeWorkspace.projectScheduleRows([
            "schedules":[["scheduleId":"s1","enabled":true,"operation":"browser_observation"]]
        ])
        let paused = NativeWorkspace.projectScheduleRows([
            "schedules":[["scheduleId":"s1","enabled":false,"operation":"browser_observation"]]
        ])
        XCTAssertNil(NativeWorkspace.scheduleOutcomeWarning(
            action:.pause,receipt:["schedule":["enabled":false]],refreshed:paused,scheduleId:"s1"))
        XCTAssertNil(NativeWorkspace.scheduleOutcomeWarning(
            action:.resume,receipt:["schedule":["enabled":true]],refreshed:active,scheduleId:"s1"))
        XCTAssertNotNil(NativeWorkspace.scheduleOutcomeWarning(
            action:.pause,receipt:["schedule":["enabled":false]],refreshed:active,scheduleId:"s1"))
        XCTAssertNotNil(NativeWorkspace.scheduleOutcomeWarning(
            action:.resume,receipt:["schedule":["enabled":true]],refreshed:paused,scheduleId:"s1"))
        XCTAssertNotNil(NativeWorkspace.scheduleOutcomeWarning(
            action:.pause,receipt:[:],refreshed:[],scheduleId:"s1"))
        XCTAssertNotNil(NativeWorkspace.scheduleOutcomeWarning(
            action:.trigger,receipt:["occurrence":NSNull()],refreshed:active,scheduleId:"s1"))
        XCTAssertNil(NativeWorkspace.scheduleOutcomeWarning(
            action:.trigger,receipt:["occurrence":["occurrenceId":"o1"]],refreshed:active,scheduleId:"s1"))
    }

    func testPluginManagementRowsDecodeOfficialCatalogProjection() {
        let rows = NativeWorkspace.pluginManagementRows([
            "plugins":[[
                "pluginId":"figma",
                "name":"Forge Figma Bridge",
                "version":"0.3.0",
                "description":"Direct Figma bridge",
                "compatible":true,
                "installedVersion":"0.2.0",
                "enabled":true,
                "authorizationCount":2,
                "authorizationExpiresAt":"2026-12-01T00:00:00Z"
            ]]
        ])
        XCTAssertEqual(rows.count,1)
        XCTAssertEqual(rows[0].pluginId,"figma")
        XCTAssertEqual(rows[0].installedVersion,"0.2.0")
        XCTAssertTrue(rows[0].compatible)
        XCTAssertEqual(rows[0].authorizationCount,2)
        XCTAssertEqual(rows[0].authorizationExpiresAt,"2026-12-01T00:00:00Z")
    }

    func testPluginInstallationRequiresConfirmedVersionFromAuthority() {
        let target = NativeWorkspace.pluginManagementRows(["plugins":[[
            "pluginId":"figma","name":"Figma","version":"0.3.0","description":"Bridge",
            "compatible":true,"installedVersion":"0.2.0"
        ]]]).first!
        let current = NativeWorkspace.pluginManagementRows(["plugins":[[
            "pluginId":"figma","name":"Figma","version":"0.3.0","description":"Bridge",
            "compatible":true,"installedVersion":"0.3.0"
        ]]])
        XCTAssertNil(NativeWorkspace.pluginInstallationWarning(target:target,refreshed:current))
        XCTAssertNotNil(NativeWorkspace.pluginInstallationWarning(target:target,refreshed:[target]))
        XCTAssertNotNil(NativeWorkspace.pluginInstallationWarning(target:target,refreshed:[]))
    }

    func testUserRequestCountProjectionDistinguishesExactFromBoundedFallback() {
        let exact:[String:Any] = [
            "items":[],
            "totalCount":7,
            "countExact":true,
            "possiblyTruncated":false
        ]
        XCTAssertEqual(NativeWorkspace.userRequestsTotalCount(exact),7)
        XCTAssertFalse(NativeWorkspace.userRequestsPossiblyTruncated(exact))

        let fallback:[String:Any] = [
            "items":[],
            "totalCount":6,
            "countExact":false,
            "possiblyTruncated":true
        ]
        XCTAssertNil(NativeWorkspace.userRequestsTotalCount(fallback))
        XCTAssertTrue(NativeWorkspace.userRequestsPossiblyTruncated(fallback))
    }

    func testUserRequestFeedbackRequiresMatchingTerminalAuthorityReceipt() {
        XCTAssertTrue(NativeWorkspace.userRequestResolutionConfirmed([
            "data":["item":["requestId":"request-1","status":"resolved"]]
        ],requestId:"request-1"))
        XCTAssertFalse(NativeWorkspace.userRequestResolutionConfirmed([
            "data":["item":["requestId":"request-1","status":"pending"]]
        ],requestId:"request-1"))
        XCTAssertFalse(NativeWorkspace.userRequestResolutionConfirmed([
            "data":["item":["requestId":"request-2","status":"resolved"]]
        ],requestId:"request-1"))
        XCTAssertFalse(NativeWorkspace.userRequestResolutionConfirmed([
            "data":["status":"ok"]
        ],requestId:"request-1"))
    }

    func testUserRequestProjectionFiltersCurrentProjectAndGlobalOnly() {
        let rows = NativeWorkspace.userRequestRows([
            "data":[
                "data":[
                    "items":[
                    [
                        "requestId":"global-1",
                        "kind":"user_action_request",
                        "title":"Login",
                        "summary":"Complete login",
                        "actionRequired":"login",
                        "status":"pending"
                    ],
                    [
                        "requestId":"repo-1",
                        "kind":"user_decision_request",
                        "title":"Approve",
                        "summary":"Approve current project",
                        "actionRequired":"product_decision",
                        "status":"pending",
                        "targetScope":["repoId":"repo-a"]
                    ],
                    [
                        "requestId":"repo-2",
                        "kind":"user_decision_request",
                        "title":"Other",
                        "summary":"Other repository",
                        "actionRequired":"product_decision",
                        "status":"pending",
                        "targetScope":["repoId":"repo-b"]
                    ],
                    [
                        "requestId":"legacy-work-no-repo",
                        "kind":"user_decision_request",
                        "title":"Legacy scoped",
                        "summary":"Scoped work without repository identity",
                        "actionRequired":"product_decision",
                        "status":"pending",
                        "targetScope":["scopeKind":"work","scopeId":"legacy-work"]
                    ],
                    [
                        "requestId":"done",
                        "kind":"user_action_request",
                        "title":"Done",
                        "summary":"Already done",
                        "actionRequired":"login",
                        "status":"resolved"
                    ]
                    ]
                ]
            ]
        ])
        XCTAssertEqual(rows.count,5)
        XCTAssertEqual(
            NativeWorkspace.relevantUserRequestRows(rows,repoId:"repo-a").map(\.requestId),
            ["global-1","repo-1"]
        )
        XCTAssertEqual(
            NativeWorkspace.relevantUserRequestRows(rows,repoId:nil).map(\.requestId),
            ["global-1"]
        )
    }

    func testProjectPluginRowsDecodeBoundedPluginProjection() {
        let rows = NativeWorkspace.projectPluginRows([
            "plugins":[[
                "pluginId":"browser",
                "displayName":"Browser",
                "pluginVersion":"1.2.3",
                "provider":"forge",
                "enabled":true,
                "lifecycle":"enabled",
                "health":"ready",
                "ready":true,
                "capabilities":["Navigate","Read page"],
                "actionCount":4
            ],[
                "pluginId":"browser",
                "displayName":"Browser duplicate scope",
                "enabled":true,
                "lifecycle":"enabled",
                "health":"ready",
                "ready":true,
                "capabilities":["Duplicate"],
                "actionCount":2
            ]]
        ])
        XCTAssertEqual(rows.count,1)
        XCTAssertEqual(rows[0].pluginId,"browser")
        XCTAssertEqual(rows[0].displayName,"Browser")
        XCTAssertEqual(rows[0].capabilities,["Navigate","Read page"])
        XCTAssertEqual(rows[0].actionCount,4)
        XCTAssertTrue(rows[0].ready)
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
    func testProviderProcessNarrationDoesNotBecomeToolCompletionAuthority() {
        XCTAssertNil(NativeWorkspace.modelNarrativeEvent(" \n ",now:"start"))
        let narrative = NativeWorkspace.modelNarrativeEvent(
            String(repeating:"A",count:1300),now:"now"
        )
        XCTAssertEqual(narrative?.phase,"message")
        XCTAssertEqual(narrative?.detail?.count,800)
        let tool = AgentLiveActivityEvent(
            phase:"tool", label:"read_file", detail:nil, status:"running",
            startedAt:"start", completedAt:nil, toolCallId:"call-1"
        )
        let canonical = AgentLiveActivityEvent(
            phase:"tool", label:"read_file", detail:"AGENTS.md", status:"completed",
            startedAt:"start", completedAt:"end", toolCallId:"call-1"
        )
        let merged = NativeWorkspace.mergeActivityReceipts(
            [narrative!,tool], receipts:[canonical]
        )
        XCTAssertEqual(merged.map(\.phase),["message","tool"])
        XCTAssertEqual(merged[1].status,"completed")
        XCTAssertEqual(merged[1].detail,"AGENTS.md")
        let unknown = NativeWorkspace.mergeActivityReceipts([tool],receipts:[])
        XCTAssertEqual(unknown[0].status,"unknown")
        XCTAssertEqual(unknown[0].toolCallId,"call-1")
    }

    func testAgentRichResponseParsesMarkdownTablesAndTasks() {
        let input = """
        # Overview

        A **bold** detail with [link](https://example.com).

        - [ ] Inspect source
        - [x] Verify tests
          1. Record evidence

        | Item | Status |
        | :--- | ---: |
        | Build | PASS |
        | Tests | 71 |

        > Actual check result.

        ---

        ~~~bash
        echo hello
        ~~~
        """
        let result = AgentMessageBlock.parse(input)
        XCTAssertEqual(result[0], .heading(level:1,text:"Overview"))
        XCTAssertEqual(result[1], .markdown("A **bold** detail with [link](https://example.com)."))
        XCTAssertEqual(result[2], .list([
            AgentListItem(marker:"",text:"Inspect source",indent:0,checked:false),
            AgentListItem(marker:"",text:"Verify tests",indent:0,checked:true),
            AgentListItem(marker:"1.",text:"Record evidence",indent:1,checked:nil)
        ]))
        XCTAssertEqual(result[3], .table(headers:["Item","Status"],rows:[
            ["Build","PASS"],["Tests","71"]
        ]))
        XCTAssertEqual(result[4], .quote("Actual check result."))
        XCTAssertEqual(result[5], .divider)
        XCTAssertEqual(result[6], .code(language:"bash",text:"echo hello"))
    }

    func testAgentRichResponseDeclarativeChoicesNeverInvokeNativeExecution() {
        let valid = """
        ~~~forge-options
        {"prompt":"Choose","options":[{"label":"Run tests","value":"Run focused tests"},{"label":"Inspect","value":"Review diff"}]}
        ~~~
        """
        XCTAssertEqual(AgentMessageBlock.parse(valid),[
            .choices(prompt:"Choose", options:[
                AgentResponseChoice(label:"Run tests",value:"Run focused tests"),
                AgentResponseChoice(label:"Inspect",value:"Review diff")
            ])
        ])
        let invalid = """
        ~~~forge-options
        {"prompt":"Single","options":[{"label":"one","value":"one"}]}
        ~~~
        """
        guard case .code(let lang, _) = AgentMessageBlock.parse(invalid).first else {
            return XCTFail("invalid choice payload must stay inert code")
        }
        XCTAssertEqual(lang,"forge-options")
        XCTAssertEqual(AgentMessageBlock.parse("{\"z\":2,\"a\":1}").count,1)
        XCTAssertTrue(AgentMessageBlock.isShellLanguage("BASH"))
        XCTAssertFalse(AgentMessageBlock.isShellLanguage("json"))
        XCTAssertFalse(AgentMessageBlock.isShellLanguage(nil))
        let prompt = AgentMessageBlock.commandExecutionPrompt("git status")
        XCTAssertTrue(prompt.contains("git status"))
        XCTAssertTrue(prompt.contains("Repository AccessPolicy"))
        XCTAssertTrue(prompt.contains("Process"))
    }

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
