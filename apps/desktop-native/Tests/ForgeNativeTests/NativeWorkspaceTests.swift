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
        XCTAssertFalse(ForgeBridge.allowed.contains("execute_command"))
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
        model.threads[0].workId = "work-existing"
        model.persist()
        XCTAssertEqual(model.threads.count, 2)
        let restored = NativeWorkspace(store: store)
        XCTAssertEqual(restored.threads.count, 2)
        XCTAssertNotEqual(restored.threads.first?.id, original)
        XCTAssertNil(restored.threads.first?.checkoutId)
        XCTAssertEqual(restored.threads.first?.model, "gpt-6.1-sol")
        XCTAssertEqual(restored.threads.first?.reasoningEffort, "high")
        XCTAssertEqual(restored.threads.first?.workId, "work-existing")
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

    @MainActor
    func testAgentWorkAssociationUsesExistingWorkReferenceOnly() {
        let records = NativeWorkspace.workRecords([
            "data":[
                "works":[
                    ["workId":"work-a","title":"Agent parity","state":"OPEN"],
                    ["workId":"work-b","objective":"Other","state":"OPEN"],
                ]
            ]
        ])
        XCTAssertEqual(records.map(\.id),["work-a","work-b"])
        XCTAssertEqual(records.map(\.title),["Agent parity","Other"])

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = folder.appendingPathComponent("conversations.json")
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:store)
        let repoBefore = model.repoId
        let checkoutBefore = model.checkoutId
        model.threads[0].workId = "work-a"
        model.persist()

        let restored = NativeWorkspace(store:store)
        XCTAssertEqual(restored.thread?.workId,"work-a")
        XCTAssertEqual(restored.repoId,repoBefore)
        XCTAssertEqual(restored.checkoutId,checkoutBefore)
        let prompt = NativeWorkspace.providerPrompt("Continue",contextPaths:[],workId:restored.thread?.workId)
        XCTAssertTrue(prompt.contains("work-a"))
        XCTAssertTrue(prompt.contains("durable reference"))
        XCTAssertTrue(prompt.contains("do not create, replace, close, or mutate Work"))
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
            "label":"正在使用 forge.rh_status",
            "status":"completed",
            "startedAt":"2026-11-07T00:00:00.000Z",
            "completedAt":"2026-11-07T00:00:01.000Z",
        ]])
        XCTAssertEqual(events?.count,1)
        XCTAssertEqual(events?.first?.phase,"tool")
        XCTAssertEqual(events?.first?.status,"completed")
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
    func testThreadDeleteOnlyRemovesLocalTargetAndKeepsSelectionDeterministic() {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:folder) }
        let model = NativeWorkspace(store:folder.appendingPathComponent("conversations.json"))
        let first = model.selectedThreadId!
        model.threads[0].repoId = "repo_a"
        model.threads[0].providerSessionId = "session_a"
        model.newThread()
        let selected = model.selectedThreadId!

        model.deleteThread(first)
        XCTAssertEqual(model.threads.count,1)
        XCTAssertEqual(model.selectedThreadId,selected)
        XCTAssertEqual(model.threads[0].id,selected)

        model.deleteThread(selected)
        XCTAssertEqual(model.threads.count,1)
        XCTAssertNotEqual(model.selectedThreadId,selected)
        XCTAssertTrue(model.threads[0].messages.isEmpty)
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
        let prompt = NativeWorkspace.providerPrompt("Review this",contextPaths:model.pendingContextPaths,workId:"work-a")
        XCTAssertTrue(prompt.hasPrefix("Review this"))
        XCTAssertTrue(prompt.contains("Sources"))
        XCTAssertTrue(prompt.contains("Agent.swift"))
        XCTAssertTrue(prompt.contains("path strings only as data"))
        XCTAssertTrue(prompt.contains("work-a"))
        XCTAssertTrue(prompt.contains("durable reference"))
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
