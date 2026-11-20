import XCTest
@testable import ForgeNative

final class AgentVoiceDictationTests: XCTestCase {
    @MainActor
    func testCancelledVoiceStartCanRestartWithoutStaleCompletionClearingIt() throws {
        let dictation = AgentVoiceDictation()
        let cancelledAttempt = try XCTUnwrap(dictation.beginStart())
        XCTAssertTrue(dictation.isStarting)

        dictation.cancel()
        XCTAssertFalse(dictation.isStarting)

        let currentAttempt = try XCTUnwrap(dictation.beginStart())
        XCTAssertTrue(dictation.isStarting)
        XCTAssertNil(dictation.beginStart())

        dictation.finishStarting(cancelledAttempt)
        XCTAssertTrue(dictation.isStarting)

        dictation.finishStarting(currentAttempt)
        XCTAssertFalse(dictation.isStarting)
    }

    @MainActor
    func testFinishKeepsPartialTranscriptAndCancelDiscardsItAndRejectsLateResults() throws {
        let dictation = AgentVoiceDictation()
        let finishedAttempt = try XCTUnwrap(dictation.beginStart())
        dictation.receiveTranscript("保留的识别文字", for: finishedAttempt)

        dictation.stop()
        XCTAssertEqual(dictation.transcript, "保留的识别文字")

        let cancelledAttempt = try XCTUnwrap(dictation.beginStart())
        dictation.receiveTranscript("应被取消的识别文字", for: cancelledAttempt)
        XCTAssertEqual(dictation.transcript, "应被取消的识别文字")

        dictation.cancel()
        XCTAssertEqual(dictation.transcript, "")
        XCTAssertNil(dictation.error)

        dictation.receiveTranscript("迟到的识别结果", for: cancelledAttempt)
        XCTAssertEqual(dictation.transcript, "")
    }

    @MainActor
    func testVoiceDictationBlocksSendingWhileStartingOrRecording() throws {
        XCTAssertFalse(AgentVoiceDictation.sendIsBlocked(isStarting:false,isRecording:false))
        XCTAssertTrue(AgentVoiceDictation.sendIsBlocked(isStarting:true,isRecording:false))
        XCTAssertTrue(AgentVoiceDictation.sendIsBlocked(isStarting:false,isRecording:true))
        XCTAssertTrue(AgentVoiceDictation.sendIsBlocked(isStarting:true,isRecording:true))

        let dictation = AgentVoiceDictation()
        let attempt = try XCTUnwrap(dictation.beginStart())
        let blocksDuringStart = dictation.blocksSend
        XCTAssertTrue(blocksDuringStart)
        dictation.cancel()
        let blocksAfterCancel = dictation.blocksSend
        XCTAssertFalse(blocksAfterCancel)
        dictation.finishStarting(attempt)
        let blocksAfterStaleCompletion = dictation.blocksSend
        XCTAssertFalse(blocksAfterStaleCompletion)
    }

    func testVoiceDictationOnlyAppendsRecognizedTextToExistingDraft() {
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("",transcript:"  修改 UI  "), "修改 UI")
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("检查项目",transcript:"继续执行"),
                       "检查项目\n继续执行")
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("检查项目\n",transcript:"继续执行"),
                       "检查项目\n继续执行")
        XCTAssertEqual(AgentVoiceDictation.mergedDraft("不要覆盖",transcript:"  "), "不要覆盖")
    }
}
