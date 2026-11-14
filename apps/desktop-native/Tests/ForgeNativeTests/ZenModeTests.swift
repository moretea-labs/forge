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

extension ZenModeTests {
    func testTreeGeometryKeepsEachPlanSubtreeTogetherAndCentersParents() {
        func plan(_ id:String,_ parent:String?) -> ForgeRecord {
            ForgeRecord(recordId:id,title:id,state:"open",kind:.plan,depth:1,
                        requirementId:"REQ-TREE",parentPlanId:parent)
        }
        let root=ForgeRecord(recordId:"REQ-TREE",title:"工作台",state:"open",
                             kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        let left=plan("LEFT",nil),right=plan("RIGHT",nil)
        let l1=plan("L1","LEFT"),l2=plan("L2","LEFT"),l3=plan("L3","LEFT")
        let r1=plan("R1","RIGHT")
        let rows=[[root],[left,right],[l1,l2,l3,r1]]
        let layout=ZenTreeGeometry(rows:rows,viewport:CGSize(width:600,height:470))
        let x:(ForgeRecord,Int)->CGFloat={layout.point(for:$0,row:$1).x}

        XCTAssertEqual(layout.parentById[l1.id],left.id)
        XCTAssertEqual(layout.parentById[r1.id],right.id)
        XCTAssertEqual(x(left,1),(x(l1,2)+x(l3,2))/2,accuracy:0.01)
        XCTAssertEqual(x(right,1),x(r1,2),accuracy:0.01)
        XCTAssertEqual(x(root,0),(x(left,1)+x(right,1))/2,accuracy:0.01)
        XCTAssertLessThan(x(l3,2),x(r1,2))
        XCTAssertGreaterThanOrEqual(x(r1,2)-x(l3,2),ZenTreeGeometry.columnStep)
        XCTAssertGreaterThanOrEqual(layout.width,4*ZenTreeGeometry.columnStep+70)
    }

    func testTreeGeometryCentersSingleRequirementInAvailableViewport() {
        let root=ForgeRecord(recordId:"REQ-ONE",title:"单节点",state:"open",
                             kind:.requirement,depth:0,requirementId:nil,parentPlanId:nil)
        let layout=ZenTreeGeometry(rows:[[root]],viewport:CGSize(width:900,height:500))
        XCTAssertEqual(layout.point(for:root,row:0).x,450,accuracy:0.01)
        XCTAssertEqual(layout.parentById.count,0)
        XCTAssertEqual(layout.width,900)
    }
}
