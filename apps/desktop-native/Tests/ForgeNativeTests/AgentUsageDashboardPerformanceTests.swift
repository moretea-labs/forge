import XCTest
@testable import ForgeNative

final class AgentUsageDashboardPerformanceTests: XCTestCase {
    func testUsageSnapshotCollectsProviderOptionsAcrossHistoryAndFilters() {
        let cutoff = Date(timeIntervalSince1970: 1_000)
        var selectedProject = ChatThread()
        selectedProject.projectId = "project-a"
        selectedProject.messages = [
            ChatMessage(role: "assistant", text: "old", providerUsed: "codex", createdAt: cutoff.addingTimeInterval(-1)),
            ChatMessage(role: "assistant", text: "current", providerUsed: "api:openai", createdAt: cutoff.addingTimeInterval(1)),
            ChatMessage(role: "user", text: "ignored", providerUsed: "not-a-provider", createdAt: cutoff.addingTimeInterval(2))
        ]
        var otherProject = ChatThread()
        otherProject.projectId = "project-b"
        otherProject.messages = [
            ChatMessage(role: "assistant", text: "other project", providerUsed: "joycode", createdAt: cutoff.addingTimeInterval(2))
        ]
        let threads = [selectedProject, otherProject]

        let snapshot = AgentUsageDashboard.makeUsageSnapshot(
            from: threads, projectLabels: [:], since: cutoff,
            projectFilter: "project-a", providerId: "api:openai"
        )

        XCTAssertEqual(snapshot.providerIds, ["api:openai", "codex", "joycode"])
        XCTAssertEqual(snapshot.providerIds, AgentUsageDashboard.availableProviderIds(from: threads))
        XCTAssertEqual(snapshot.unreportedEntries.map(\.provider), ["api:openai"])
    }
}
