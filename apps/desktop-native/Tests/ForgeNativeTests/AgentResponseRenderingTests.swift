import XCTest
@testable import ForgeNative

final class AgentResponseRenderingTests: XCTestCase {
    func testMessageBlockCacheReusesTheSameParsedSnapshot() {
        var parseCount = 0
        let cache = AgentMessageBlockCache { source in
            parseCount += 1
            return AgentMessageBlock.parse(source)
        }
        let text = "# Title\n\n- [ ] First\n- [x] Second"

        let first = cache.blocks(for: text)
        let second = cache.blocks(for: text)

        XCTAssertEqual(first, second)
        XCTAssertEqual(parseCount, 1)
    }

    func testMessageBlockCacheInvalidatesWhenStreamingTextChanges() {
        var parseCount = 0
        let cache = AgentMessageBlockCache { source in
            parseCount += 1
            return AgentMessageBlock.parse(source)
        }

        _ = cache.blocks(for: "Hello")
        let streamed = cache.blocks(for: "Hello world")
        let repeated = cache.blocks(for: "Hello world")

        XCTAssertEqual(streamed, [.markdown("Hello world")])
        XCTAssertEqual(repeated, streamed)
        XCTAssertEqual(parseCount, 2)
    }
}
