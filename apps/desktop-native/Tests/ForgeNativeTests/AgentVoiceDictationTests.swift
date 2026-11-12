import XCTest
@testable import ForgeNative

final class AgentVoiceDictationTests: XCTestCase {
    func testVoiceDictationOnlyAppendsRecognizedTextToExistingDraft() {
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("",transcript:"  修改 UI  "), "修改 UI")
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("检查项目",transcript:"继续执行"),
                       "检查项目\n继续执行")
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("检查项目\n",transcript:"继续执行"),
                       "检查项目\n继续执行")
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("不要覆盖",transcript:"  "), "不要覆盖")
    }
}
