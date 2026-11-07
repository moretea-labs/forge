import XCTest
@testable import ForgeNative

final class NativeWorkspaceTests: XCTestCase {
    func testBridgeAllowlistExcludesGenericCommandsAndRecoveryMutations() {
        XCTAssertTrue(ForgeBridge.allowed.contains("send_local_conversation"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_local_provider_models"))
        XCTAssertTrue(ForgeBridge.allowed.contains("read_agent_git_diff"))
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
        XCTAssertNil(message.toolActivityCount)
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
