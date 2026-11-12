import XCTest
@testable import ForgeNative

@MainActor
final class ZenReadOnlyReviewTests: XCTestCase {
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
