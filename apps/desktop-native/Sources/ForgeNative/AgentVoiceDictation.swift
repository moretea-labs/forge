import AVFoundation
import Foundation
import Speech

// Draft-only voice input. Speech never sends a message or executes a tool.
@MainActor
final class AgentVoiceDictation: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var isStarting = false
    @Published private(set) var transcript = ""
    @Published private(set) var error: String?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var sessionID = UUID()

    nonisolated static func mergedDraft(_ existing: String, transcript: String) -> String {
        let words = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return existing }
        guard !existing.isEmpty else { return words }
        return existing + (existing.last?.isWhitespace == true ? "" : "\n") + words
    }

    func start() async {
        guard !isRecording, !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        let attemptID = UUID()
        sessionID = attemptID
        error = nil
        transcript = ""

        guard let recognizer = SFSpeechRecognizer(locale: Locale.current)
                ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            error = "当前系统语言的语音识别不可用。"
            return
        }

        let speechPermission = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { value in continuation.resume(returning: value) }
        }
        guard sessionID == attemptID else { return }
        guard speechPermission == .authorized else {
            error = "需要在系统设置中允许 Forge 使用语音识别。"
            return
        }
        let microphoneAllowed = await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { value in continuation.resume(returning: value) }
        }
        guard sessionID == attemptID else { return }
        guard microphoneAllowed else {
            error = "需要在系统设置中允许 Forge 使用麦克风。"
            return
        }

        let input = engine.inputNode
        let audioFormat = input.outputFormat(forBus: 0)
        guard audioFormat.sampleRate > 0, audioFormat.channelCount > 0 else {
            error = "无法取得可用的麦克风音频格式。"
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let session = attemptID
        self.request = request
        input.installTap(onBus: 0, bufferSize: 1024, format: audioFormat) { buffer, _ in
            request.append(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            self.request = nil
            self.error = "麦克风启动失败：" + error.localizedDescription
            return
        }
        isRecording = true
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, failure in
            Task { @MainActor [weak self] in
                guard let self, self.sessionID == session else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal { self.stop() }
                }
                if let failure {
                    self.error = "语音识别中断：" + failure.localizedDescription
                    self.stop()
                }
            }
        }
    }

    func stop() {
        sessionID = UUID()
        if engine.isRunning { engine.stop() }
        if request != nil { engine.inputNode.removeTap(onBus: 0) }
        request?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        isRecording = false
    }
}
