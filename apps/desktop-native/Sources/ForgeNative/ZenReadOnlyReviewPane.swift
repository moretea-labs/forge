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
    @State private var reviewGeneration = UUID()

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
            Text("同一份 Forge 记录会发送给所选模型服务进行审查。已禁用执行工具的写入能力，审查意见不会自动应用。")
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
                Button("取消审查") { cancelReview() }
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth:.infinity,alignment:.leading)
        .task(id:Self.reviewRequestIdentity(
            repoId:model.repoId,checkoutId:model.checkoutId,
            recordId:record.id,role:role,focus:focus,providers:providers
        )) { await run() }
        .onDisappear { cancelReview() }
        .accessibilityIdentifier("zen.review.readonly.results")
    }


    // The review is scoped to a specific workspace and review intention.
    // Changing any input cancels the previous SwiftUI task and starts fresh.
    static func reviewRequestIdentity(
        repoId:String?,checkoutId:String?,recordId:String,
        role:String,focus:String,providers:[String]
    ) -> [String] {
        [repoId ?? "",checkoutId ?? "",recordId,role,focus] + providers
    }

    // Keep the security-critical API transport contract in one testable path.
    // The model can only use tools exposed by the native helper; false is a
    // request ceiling even when the repository currently grants Full Access.
    static func effectDisabledRequest(
        conversationId:String, repoId:String, checkoutId:String,
        provider:String, model:String, prompt:String
    ) -> [String:Any] {
        [
            "conversationId":conversationId,
            "provider":provider,
            "model":model,
            "allowEffects":false,
            "repoId":repoId,
            "checkoutId":checkoutId,
            "messages":[["role":"user","content":prompt]]
        ]
    }

    static func canonicalSnapshot(
        _ result:[String:Any], key:String,recordId:String
    ) throws -> String {
        let data=result["data"] as? [String:Any] ?? result
        guard (key == "requirement" || key == "plan"),
              let source=data[key] as? [String:Any],
              let id=source[key == "requirement" ? "requirementId" : "planId"] as? String,
              id == recordId,
              let revision=source["revision"] as? Int,revision > 0,
              JSONSerialization.isValidJSONObject(source),
              let payload=try? JSONSerialization.data(withJSONObject:source,options:[.sortedKeys]),
              let text=String(data:payload,encoding:.utf8),
              text.utf8.count <= 48_000 else {
            throw ForgeBridgeError.invalidResponse
        }
        return text
    }

    private func cancelReview() {
        reviewGeneration = UUID()
        activeTurn?.cancel()
        activeTurn = nil
        reviewing = nil
    }

    private func run() async {
        let generation = UUID()
        reviewGeneration = generation
        activeTurn?.cancel()
        activeTurn = nil
        outputs = []
        error = nil
        reviewing = nil
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
            let sourceText=try Self.canonicalSnapshot(
                data,key:record.kind == .requirement ? "requirement" : "plan",
                recordId:record.recordId
            )

            for provider in providers {
                if Task.isCancelled || reviewGeneration != generation { return }
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
                guard reviewGeneration == generation else { return }
                reviewing="\(name) 审查中"
                let prompt="""
                请作为\(role)提供独立审查意见。关注：\(focus)。
                输入是 Forge 只读快照，不允许依赖其他模型的结果。请逐项给出：
                发现的问题、证据/缺失证据、严重性、可操作建议和不确定性。
                不要声称已运行测试、修改文件或完成验收。不要请求任何工具写入。
                
                \(sourceText)
                """
                let conversationId=UUID().uuidString
                let turn=try ForgeBridge.startApiTurn(Self.effectDisabledRequest(
                    conversationId:conversationId,repoId:repoId,checkoutId:checkoutId,
                    provider:provider,model:name,prompt:prompt
                ))
                guard reviewGeneration == generation, !Task.isCancelled else {
                    turn.cancel()
                    return
                }
                activeTurn=turn
                let result=try await turn.wait { _ in }
                guard reviewGeneration == generation, !Task.isCancelled else { return }
                activeTurn=nil
                guard model.repoId == repoId,
                      model.checkoutId == checkoutId else { return }
                guard let output=result["output"] as? String,
                      !output.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {
                    throw ForgeBridgeError.invalidResponse
                }
                outputs.append(ReviewOutput(provider:provider,model:name,response:output))
            }
        } catch {
            guard reviewGeneration == generation, !Task.isCancelled else { return }
            self.error="审查未全部完成：\(error.localizedDescription)"
        }
        guard reviewGeneration == generation else { return }
        reviewing=nil
        activeTurn=nil
    }
}
