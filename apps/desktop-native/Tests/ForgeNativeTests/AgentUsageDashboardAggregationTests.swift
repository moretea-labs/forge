import XCTest
@testable import ForgeNative

final class AgentUsageDashboardAggregationTests: XCTestCase {
    func testUsageBreakdownAggregatesDailyModelAndProjectTotalsInOneResult() throws {
        let calendar = Calendar(identifier: .gregorian)
        let today = calendar.startOfDay(for: Date(timeIntervalSince1970: 1_800_000_000))
        let yesterday = try XCTUnwrap(calendar.date(byAdding: .day, value: -1, to: today))
        let older = try XCTUnwrap(calendar.date(byAdding: .day, value: -2, to: today))
        func usage(_ total: Int) throws -> AgentTokenUsage {
            try XCTUnwrap(AgentTokenUsage.fromProviderReceipt([
                "inputTokens": total / 2, "outputTokens": total - total / 2,
                "totalTokens": total, "reportedRounds": 1, "totalRounds": 1
            ]))
        }
        func entry(_ id: String, _ date: Date, _ provider: String, _ model: String,
                   _ projectID: String, _ project: String, _ tokens: Int) throws -> AgentUsageDashboard.Entry {
            AgentUsageDashboard.Entry(
                id: id, threadId: "thread-\(id)", messageId: id, threadTitle: id,
                date: date, projectGroupId: projectID, project: project,
                model: model, provider: provider, usage: try usage(tokens)
            )
        }
        let entries = [
            try entry("a", today.addingTimeInterval(3600), "codex", "gpt", "project:a", "Alpha", 30),
            try entry("b", today.addingTimeInterval(7200), "codex", "gpt", "project:a", "Alpha", 20),
            try entry("c", yesterday, "joycode", "sonnet", "project:b", "Beta", 50),
            try entry("d", older, "codex", "gpt", "project:b", "Beta", 10)
        ]
        let result = AgentUsageDashboard.makeUsageBreakdown(
            from: entries, days: 2, today: today, calendar: calendar,
            providerNames: ["codex": "Codex"]
        )
        XCTAssertEqual(result.timeline.map(\.count), [50, 50])
        XCTAssertEqual(result.byModel.map(\.0), ["Codex · gpt", "joycode · sonnet"])
        XCTAssertEqual(result.byModel.map(\.1), [60, 50])
        XCTAssertEqual(result.byProject.map(\.0), ["Beta", "Alpha"])
        XCTAssertEqual(result.byProject.map(\.1), [60, 50])
    }

    func testUsageBreakdownKeepsEmptyDaysAndZeroDayRange() {
        let today = Calendar.current.startOfDay(for: Date())
        let result = AgentUsageDashboard.makeUsageBreakdown(from: [], days: 3, today: today)
        XCTAssertEqual(result.timeline.map(\.count), [0, 0, 0])
        XCTAssertTrue(result.byModel.isEmpty)
        XCTAssertTrue(result.byProject.isEmpty)
        let emptyRange = AgentUsageDashboard.makeUsageBreakdown(from: [], days: 0, today: today)
        XCTAssertTrue(emptyRange.timeline.isEmpty)
    }
}
