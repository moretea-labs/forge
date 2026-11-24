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

    func testInlineMarkdownCacheReusesAttributedParsingForSameSnapshot() {
        var parseCount = 0
        let cache = AgentInlineMarkdownCache { source in
            parseCount += 1
            return AttributedString(source)
        }

        let first = cache.attributedString(for: "**stable text**")
        let second = cache.attributedString(for: "**stable text**")

        XCTAssertNotNil(first)
        XCTAssertEqual(first, second)
        XCTAssertEqual(parseCount, 1)
    }

    func testInlineMarkdownCacheInvalidatesOnlyWhenSourceChanges() {
        var parseCount = 0
        let cache = AgentInlineMarkdownCache { source in
            parseCount += 1
            return AttributedString(source)
        }

        _ = cache.attributedString(for: "first")
        _ = cache.attributedString(for: "first")
        let updated = cache.attributedString(for: "second")

        XCTAssertEqual(String(updated!.characters), "second")
        XCTAssertEqual(parseCount, 2)
    }

    func testCodeBlockLineCacheReusesSplitRowsForSameSnapshot() {
        var splitCount = 0
        let cache = AgentCodeBlockLineCache { source in
            splitCount += 1
            return source.components(separatedBy: "\n")
        }

        let first = cache.lines(for: "one\ntwo\n")
        let second = cache.lines(for: "one\ntwo\n")

        XCTAssertEqual(first, ["one", "two", ""])
        XCTAssertEqual(second, first)
        XCTAssertEqual(splitCount, 1)

        XCTAssertEqual(cache.lines(for: "one\ntwo\nthree"), ["one", "two", "three"])
        XCTAssertEqual(splitCount, 2)
    }
}
