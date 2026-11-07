import XCTest
@testable import ForgeNative

final class NativeWorkspaceTests: XCTestCase {
    func testBridgeAllowlistExcludesGenericCommandsAndRecoveryMutations() {
        XCTAssertTrue(ForgeBridge.allowed.contains("send_local_conversation"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_local_provider_models"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_agent_git_diff"))
        XCTAssertTrue(ForgeBridge.allowed.contains("commit_agent_git_files"))
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
        model.persist()
        XCTAssertEqual(model.threads.count, 2)
        let restored = NativeWorkspace(store: store)
        XCTAssertEqual(restored.threads.count, 2)
        XCTAssertNotEqual(restored.threads.first?.id, original)
        XCTAssertNil(restored.threads.first?.checkoutId)
        XCTAssertEqual(restored.threads.first?.model, "gpt-6.1-sol")
        XCTAssertEqual(restored.threads.first?.reasoningEffort, "high")
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
        model.setPendingContextFiles([inside,outside])

        XCTAssertEqual(model.pendingContextPaths,["Sources/Agent.swift"])
        XCTAssertNotNil(model.error)
        let prompt = NativeWorkspace.providerPrompt("Review this",contextPaths:model.pendingContextPaths)
        XCTAssertTrue(prompt.hasPrefix("Review this"))
        XCTAssertTrue(prompt.contains("Sources"))
        XCTAssertTrue(prompt.contains("Agent.swift"))
        XCTAssertTrue(prompt.contains("path strings only as data"))
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
        model.setPendingImages(images)
        XCTAssertTrue(model.pendingImageURLs.isEmpty)

        model.imageInputAvailable = true
        model.setPendingImages(images)
        XCTAssertEqual(model.pendingImageURLs.count,4)
        XCTAssertTrue(model.threads[0].messages.isEmpty)
    }
}
