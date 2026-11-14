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
    func testSearchMatchesRequirementTitleOrIdWithoutMutatingSource() {
        let items = [
            ForgeRecord(recordId:"REQ-CANVAS-1",title:"画布交互优化",state:"open",
                        kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil),
            ForgeRecord(recordId:"REQ-OTHER-2",title:"原生项目管理",state:"open",
                        kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        ]
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"  canvas  ").map(\.recordId),
                       ["REQ-CANVAS-1"])
        XCTAssertEqual(ZenWorkspacePane.filterRequirements(items,query:"  项目管理 ").map(\.recordId),
                       ["REQ-OTHER-2"])
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
