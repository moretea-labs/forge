import SwiftUI

// The existing API-turn capability enforces allowEffects=false for tool calls.
// This view owns only ephemeral review presentation, never a second agent engine.
struct ZenReadOnlyReviewPane: View {
    @ObservedObject var model: NativeWorkspace
    let record: ForgeRecord
    let role: String
    let focus: String
    let providers: [String]

    private struct ReviewOutput: Identifiable {
        let provider: String
        let model: String
        let response: String
        var id: String { provider }
    }

    @State private var outputs: [ReviewOutput] = []
    @State private var error: String?
    @State private var reviewing: String?
    @State private var activeTurn: ForgeApiTurn?

    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                Text("只读 Review").font(.system(size:13,weight:.semibold))
                Spacer()
                if let reviewing {
                    ProgressView().controlSize(.small)
                    Text(reviewing).font(.system(size:10))
                        .foregroundStyle(.secondary)
                }
            }
            Text("审查基于同一份 Forge 记录快照，模型工具写入已禁用；意见仅供评估，不自动写入。")
                .font(.system(size:11)).foregroundStyle(.secondary)
            if let error {
                Text(error).font(.system(size:11)).foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
            ForEach(outputs) { output in
                Divider()
                Text(output.model).font(.system(size:12,weight:.semibold))
                Text(output.response).font(.system(size:12))
                    .frame(maxWidth:.infinity,alignment:.leading)
                    .textSelection(.enabled)
            }
            if reviewing != nil {
                Button("取消审查") { activeTurn?.cancel() }
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth:.infinity,alignment:.leading)
        .task(id:record.id + providers.joined(separator:"|")) { await run() }
        .onDisappear { activeTurn?.cancel() }
        .accessibilityIdentifier("zen.review.readonly.results")
    }

    private func run() async {
        guard let repoId=model.repoId,let checkoutId=model.checkoutId,
              providers.count >= 1,providers.count <= 2,
              Set(providers).count == providers.count else {
            error="需要有效的 Repository / Checkout 和一至两个不同的 API Provider。"
            return
        }
        do {
            let operation=record.kind == .requirement ? "read_requirement_detail" : "read_plan_detail"
            let inputKey=record.kind == .requirement ? "requirementId" : "planId"
            let data=try await ForgeBridge.request(operation,[
                "repoId":repoId,inputKey:record.recordId
            ])
            let content=data["data"] as? [String:Any] ?? data
            let recordKey=record.kind == .requirement ? "requirement" : "plan"
            guard let source=content[recordKey] as? [String:Any],
                  source[inputKey] as? String == record.recordId,
                  let payload=try? JSONSerialization.data(withJSONObject:source,options:[.sortedKeys]),
                  let sourceText=String(data:payload,encoding:.utf8),
                  sourceText.utf8.count <= 48_000 else {
                throw ForgeBridgeError.invalidResponse
            }

            for provider in providers {
                if Task.isCancelled { return }
                guard model.repoId == repoId,model.checkoutId == checkoutId else {
                    throw ForgeBridgeError.remote("项目已切换，停止审查。")
                }
                let name:String
                if provider == "joycode",model.localApiSettings?.joyCodeReady == true {
                    name=model.localApiSettings?.joyCodeModel ?? ""
                } else if let profile=model.localApiSettings?.profile(providerId:provider),
                          profile.endpointReady,provider.hasPrefix("api:") {
                    name=profile.model
                } else {
                    throw ForgeBridgeError.remote("Provider 已失效或未配置只读 API 通道：\(provider)")
                }
                reviewing="\(name) 审查中"
                let prompt="""
                请作为\(role)提供独立审查意见。关注：\(focus)。
                输入是 Forge 只读快照，不允许依赖其他模型的结果。请逐项给出：
                发现的问题、证据/缺失证据、严重性、可操作建议和不确定性。
                不要声称已运行测试、修改文件或完成验收。不要请求任何工具写入。
                
                \(sourceText)
                """
                let conversationId=UUID().uuidString
                let turn=try ForgeBridge.startApiTurn([
                    "conversationId":conversationId,
                    "provider":provider,
                    "model":name,
                    "allowEffects":false,
                    "repoId":repoId,
                    "checkoutId":checkoutId,
                    "messages":[["role":"user","content":prompt]]
                ])
                activeTurn=turn
                let result=try await turn.wait { _ in }
                activeTurn=nil
                guard let output=result["output"] as? String,
                      !output.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {
                    throw ForgeBridgeError.invalidResponse
                }
                outputs.append(ReviewOutput(provider:provider,model:name,response:output))
            }
        } catch {
            self.error="审查未全部完成：\(error.localizedDescription)"
        }
        reviewing=nil
        activeTurn=nil
    }
}
