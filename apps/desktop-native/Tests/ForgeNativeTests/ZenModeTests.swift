import XCTest
@testable import ForgeNative

final class ZenModeTests: XCTestCase {
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
}

extension ZenModeTests {
    @MainActor
    func testZenIsDefaultWithEmptyConversationStoreAndAgentNavigationIsExplicit() {
        let url=FileManager.default.temporaryDirectory
            .appendingPathComponent("forge-zen-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at:url) }
        let model=NativeWorkspace(store:url)
        XCTAssertTrue(model.zenMode)
        XCTAssertEqual(model.threads.count,1)
        model.show(.agent)
        XCTAssertFalse(model.zenMode)
        model.zenMode=true
        model.show(.requirement)
        XCTAssertTrue(model.zenMode)
    }
}
