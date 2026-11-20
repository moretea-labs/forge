import XCTest
@testable import ForgeNative

@MainActor
final class ZenReadOnlyReviewTests: XCTestCase {
    func testReviewRestartIdentityTracksWorkspaceAndReviewIntention() {
        func identity(
            project:String? = "PROJECT-a",repo:String? = "repo-a",checkout:String? = "checkout-a",
            record:String = "requirement:REQ-1",role:String = "reviewer",
            focus:String = "usability",providers:[String] = ["api:one"]
        ) -> [String] {
            ZenReadOnlyReviewPane.reviewRequestIdentity(
                projectId:project,repoId:repo,checkoutId:checkout,recordId:record,
                role:role,focus:focus,providers:providers
            )
        }
        let original=identity()
        XCTAssertNotEqual(original,identity(project:"PROJECT-b"))
        XCTAssertNotEqual(original,identity(repo:"repo-b"))
        XCTAssertNotEqual(original,identity(checkout:"checkout-b"))
        XCTAssertNotEqual(original,identity(record:"plan:PLAN-1"))
        XCTAssertNotEqual(original,identity(role:"designer"))
        XCTAssertNotEqual(original,identity(focus:"security"))
        XCTAssertNotEqual(original,identity(providers:["api:two"]))
        XCTAssertNotEqual(original,identity(providers:["api:one","api:two"]))
        XCTAssertEqual(original,identity())
    }

    func testReviewModelResolutionSupportsDefaultApiAliasAndConfiguredProfiles() {
        let settings=LocalApiSettingsDetail(
            provider:"api",endpoint:"https://api.example.com/v1",model:"default-model",
            apiProtocol:"openai",hasKey:true,endpointReady:true,
            joyCodeModel:"joy-model",joyCodeReady:true
        )
        XCTAssertEqual(ZenReadOnlyReviewPane.reviewModelName(provider:"api",settings:settings),"default-model")
        XCTAssertEqual(ZenReadOnlyReviewPane.reviewModelName(provider:"api:legacy-api",settings:settings),"default-model")
        XCTAssertEqual(ZenReadOnlyReviewPane.reviewModelName(provider:"joycode",settings:settings),"joy-model")
        XCTAssertNil(ZenReadOnlyReviewPane.reviewModelName(provider:"codex",settings:settings))
        let unavailable=LocalApiSettingsDetail(
            provider:"api",endpoint:"https://api.example.com/v1",model:"default-model",
            apiProtocol:"openai",hasKey:true,endpointReady:false
        )
        XCTAssertNil(ZenReadOnlyReviewPane.reviewModelName(provider:"api",settings:unavailable))
    }

    func testReviewTransportAlwaysDisablesEffects() {
        let args=ZenReadOnlyReviewPane.effectDisabledRequest(
            conversationId:"review-1",repoId:"repo-a",checkoutId:"checkout-a",
            provider:"api:profile-a",model:"example",prompt:"inspect the requirement"
        )
        XCTAssertEqual(args["allowEffects"] as? Bool,false)
        XCTAssertEqual(args["repoId"] as? String,"repo-a")
        XCTAssertEqual(args["checkoutId"] as? String,"checkout-a")
        XCTAssertEqual(args["provider"] as? String,"api:profile-a")
        let messages=args["messages"] as? [[String:String]]
        XCTAssertEqual(messages?.first?["role"],"user")
        XCTAssertEqual(messages?.first?["content"],"inspect the requirement")
    }

    func testSnapshotRequiresMatchingCanonicalRecordAndRevision() throws {
        let receipt:[String:Any]=[
            "data":["requirement":[
                "requirementId":"REQ-1",
                "revision":3,
                "title":"Primary requirement"
            ]]
        ]
        let text=try ZenReadOnlyReviewPane.canonicalSnapshot(
            receipt,key:"requirement",recordId:"REQ-1"
        )
        XCTAssertTrue(text.contains("\"revision\":3"))
        XCTAssertTrue(text.contains("\"requirementId\":\"REQ-1\""))
        XCTAssertThrowsError(try ZenReadOnlyReviewPane.canonicalSnapshot(
            receipt,key:"requirement",recordId:"REQ-2"
        ))
        XCTAssertThrowsError(try ZenReadOnlyReviewPane.canonicalSnapshot(
            receipt,key:"plan",recordId:"REQ-1"
        ))
    }

    func testUnversionedAndOversizedReviewInputsAreRejected() {
        XCTAssertThrowsError(try ZenReadOnlyReviewPane.canonicalSnapshot(
            ["requirement":["requirementId":"REQ-1","title":"Missing revision"]],
            key:"requirement",recordId:"REQ-1"
        ))
        let oversized=String(repeating:"x",count:50_000)
        XCTAssertThrowsError(try ZenReadOnlyReviewPane.canonicalSnapshot(
            ["plan":["planId":"PLAN-1","revision":1,"goal":oversized]],
            key:"plan",recordId:"PLAN-1"
        ))
    }
}
