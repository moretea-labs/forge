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
    let parseCountAfterFirst = parseCount
    let second = cache.blocks(for: text)

    XCTAssertEqual(first, second)
    XCTAssertEqual(parseCount, parseCountAfterFirst)
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

  func testMessageBlockCacheReusesCompletedParagraphsDuringAppendOnlyStreaming() {
    var parsedInputs: [String] = []
    let cache = AgentMessageBlockCache { source in
      parsedInputs.append(source)
      return AgentMessageBlock.parse(source)
    }
    let initial = "First paragraph\n\nSecond paragraph"

    _ = cache.blocks(for: initial)
    let updated = cache.blocks(for: initial + " updated")
    let final = cache.blocks(for: initial + " updated again")

    XCTAssertEqual(
      updated,
      [.markdown("First paragraph"), .markdown("Second paragraph updated")]
    )
    XCTAssertEqual(
      final,
      [.markdown("First paragraph"), .markdown("Second paragraph updated again")]
    )
    XCTAssertEqual(
      parsedInputs,
      [
        initial,
        "Second paragraph",
        "Second paragraph updated",
        "Second paragraph updated again",
      ]
    )
  }

  func testMessageBlockCacheDoesNotCheckpointBlankLinesInsideFencedCode() {
    var parsedInputs: [String] = []
    let cache = AgentMessageBlockCache { source in
      parsedInputs.append(source)
      return AgentMessageBlock.parse(source)
    }
    let codeTail = "\u{60}\u{60}\u{60}swift\nlet a = 1\n\nlet b = 2"
    let initial = "Before\n\n" + codeTail
    _ = cache.blocks(for: initial)

    let completed = cache.blocks(for: initial + "\n\u{60}\u{60}\u{60}\n\nAfter")

    XCTAssertEqual(
      completed,
      [
        .markdown("Before"),
        .code(language: "swift", text: "let a = 1\n\nlet b = 2"),
        .markdown("After"),
      ]
    )
    XCTAssertEqual(
      parsedInputs,
      [
        initial,
        codeTail,
        codeTail + "\n\u{60}\u{60}\u{60}\n\n",
        "After",
      ]
    )
  }

  func testIncrementalBlockCacheMatchesFullParserAcrossMixedMarkdownChunks() {
    let cache = AgentMessageBlockCache()
    let chunks = [
      "# Header\n\n",
      "A paragraph\ncontinued\n\n",
      "- first\n- second\n\n",
      "> quote\n> second\n\n",
      "| Key | Value |\n| --- | --- |\n| a | b |\n\n",
      "\u{60}\u{60}\u{60}swift\nlet x = 1\n\nlet y = 2\n\u{60}\u{60}\u{60}\n\n",
      "tail",
    ]
    var accumulated = ""

    for chunk in chunks {
      accumulated += chunk
      XCTAssertEqual(
        cache.blocks(for: accumulated),
        AgentMessageBlock.parse(accumulated),
        "Incremental parse diverged after chunk: \(chunk)"
      )
    }
  }

  func testMessageBlockCacheRebuildsWhenAnEarlierParagraphChanges() {
    let cache = AgentMessageBlockCache()
    _ = cache.blocks(for: "Original paragraph\n\nUnchanged tail")

    let rebuilt = cache.blocks(for: "Edited paragraph\n\nUnchanged tail")

    XCTAssertEqual(
      rebuilt,
      [.markdown("Edited paragraph"), .markdown("Unchanged tail")]
    )
  }

  func testMessageBlockCacheDoesNotApplyJSONSpecialCaseToLaterParagraph() {
    let cache = AgentMessageBlockCache()
    let incomplete = "Intro\n\n{\"state\":"
    _ = cache.blocks(for: incomplete)

    let completed = cache.blocks(for: incomplete + "\"ready\"}")

    XCTAssertEqual(
      completed,
      [.markdown("Intro"), .markdown("{\"state\":\"ready\"}")]
    )
  }

  func testMessageBlockCachePreservesJSONPresentationDuringStreaming() {
    var parsedInputs: [String] = []
    let cache = AgentMessageBlockCache { source in
      parsedInputs.append(source)
      return AgentMessageBlock.parse(source)
    }
    _ = cache.blocks(for: "{\"state\":")
    let completed = cache.blocks(for: "{\"state\":\"ready\"}")

    guard case .code(let language, _) = completed.first else {
      return XCTFail("Expected JSON to remain a formatted code block")
    }
    XCTAssertEqual(language, "json")
    XCTAssertEqual(parsedInputs, ["{\"state\":", "{\"state\":\"ready\"}"])
  }

  func testAgentScrollMetricsQuantizesScrollOffsetToFourPointBuckets() {
    XCTAssertEqual(AgentScrollMetrics.quantizedOffset(-4), 0)
    XCTAssertEqual(AgentScrollMetrics.quantizedOffset(3.99), 0)
    XCTAssertEqual(AgentScrollMetrics.quantizedOffset(4), 4)
    XCTAssertEqual(AgentScrollMetrics.quantizedOffset(7.99), 4)
    XCTAssertEqual(AgentScrollMetrics.quantizedOffset(8), 8)
  }

  func testAgentScrollMetricsTrackerSeparatesGeometrySamplesFromFollowStateTransitions() {
    let tracker = AgentScrollMetricsTracker()

    let initial = tracker.update(
      AgentScrollMetrics(offset: 450, contentHeight: 1_000, viewportHeight: 500)
    )
    XCTAssertEqual(initial.initialIsNearBottom, true)
    XCTAssertFalse(initial.movedAway)
    XCTAssertFalse(initial.contentGrew)

    let subThresholdMovement = tracker.update(
      AgentScrollMetrics(offset: 449, contentHeight: 1_000, viewportHeight: 500)
    )
    XCTAssertFalse(subThresholdMovement.movedAway)
    XCTAssertFalse(subThresholdMovement.movedToBottom)

    let userScrollAway = tracker.update(
      AgentScrollMetrics(offset: 438, contentHeight: 1_000, viewportHeight: 500)
    )
    XCTAssertTrue(userScrollAway.movedAway)

    let userReturnsToBottom = tracker.update(
      AgentScrollMetrics(offset: 450, contentHeight: 1_000, viewportHeight: 500)
    )
    XCTAssertTrue(userReturnsToBottom.movedToBottom)
    XCTAssertTrue(userReturnsToBottom.isNearBottom)

    let contentGrowsWhilePinned = tracker.update(
      AgentScrollMetrics(offset: 450, contentHeight: 1_200, viewportHeight: 500)
    )
    XCTAssertTrue(contentGrowsWhilePinned.contentGrew)
    XCTAssertFalse(contentGrowsWhilePinned.isNearBottom)
    XCTAssertFalse(contentGrowsWhilePinned.movedAway)
  }

  func testSelectedChecklistItemsUsesInitialAndUserOverridesWithoutBodyRescans() {
    let blocks: [AgentMessageBlock] = [
      .markdown("Choose one"),
      .list([
        AgentListItem(marker: "", text: "Already checked", indent: 0, checked: true),
        AgentListItem(marker: "", text: "Initially unchecked", indent: 0, checked: false),
        AgentListItem(marker: "•", text: "Ordinary item", indent: 0, checked: nil),
      ]),
      .list([
        AgentListItem(marker: "", text: "Second group", indent: 0, checked: false)
      ]),
    ]

    XCTAssertEqual(
      AgentMessageBlock.selectedChecklistItems(in: blocks, selections: [:]),
      ["Already checked"]
    )
    XCTAssertEqual(
      AgentMessageBlock.selectedChecklistItems(
        in: blocks,
        selections: ["1:0": false, "1:1": true, "2:0": true]
      ),
      ["Initially unchecked", "Second group"]
    )
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
    XCTAssertEqual(splitCount, 1)
  }

  func testCodeBlockLineCacheSplitsOnlyNewCompletedRowsDuringStreaming() {
    var splitInputs: [String] = []
    let cache = AgentCodeBlockLineCache { source in
      splitInputs.append(source)
      return source.components(separatedBy: "\n")
    }

    let first = cache.lines(for: "one\ntwo")
    let second = cache.lines(for: "one\ntwo\nthree")
    let third = cache.lines(for: "one\ntwo\nthree\nfour")
    let trailingEmpty = cache.lines(for: "one\ntwo\nthree\nfour\n")

    XCTAssertEqual(first, ["one", "two"])
    XCTAssertEqual(second, ["one", "two", "three"])
    XCTAssertEqual(third, ["one", "two", "three", "four"])
    XCTAssertEqual(trailingEmpty, ["one", "two", "three", "four", ""])
    XCTAssertEqual(splitInputs, ["one", "two", "three", "four"])
  }

  func testCodeBlockLineCacheRebuildsWhenEarlierCodeChanges() {
    let cache = AgentCodeBlockLineCache()
    _ = cache.lines(for: "one\ntwo\nthree")

    let rebuilt = cache.lines(for: "zero\ntwo\nthree")

    XCTAssertEqual(rebuilt, ["zero", "two", "three"])
  }
}
