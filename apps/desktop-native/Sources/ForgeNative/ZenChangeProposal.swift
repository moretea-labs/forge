import Foundation

// Agent output is untrusted until user approval and canonical Forge CAS.
struct ZenChangeProposal: Decodable, Identifiable {
    enum Operation: String, Decodable {
        case createRequirement = "create_requirement"
        case reviseRequirement = "revise_requirement"
        case createPlan = "create_plan"
        case revisePlan = "revise_plan"

        var displayName: String {
            switch self {
            case .createRequirement: return "新增 Requirement"
            case .reviseRequirement: return "修改 Requirement"
            case .createPlan: return "新增 Plan"
            case .revisePlan: return "修改 Plan"
            }
        }
    }

    enum Decision: String, Decodable {
        case accept = "ACCEPT"
    }

    let decision: Decision
    let operation: Operation
    let rationale: String
    let targetId: String?
    let expectedRevision: Int?
    let expectedRequirementRevision: Int?
    let requirementId: String?
    let title: String?
    let outcome: String?
    let acceptanceCriteria: [String]?
    let objective: String?

    var id: String { "\(operation.rawValue):\(targetId ?? requirementId ?? title ?? "new")" }

    enum RefinementDirective: Equatable {
        case accept
        case continueRefinement
        case needsUser
        case blocked
    }

    private struct RefinementSignal: Decodable {
        let decision:String
        let rationale:String
    }

    static let refinementMaximumRounds=4
    static let refinementMaximumTokens=20_000
    static let refinementMaximumDurationSeconds:TimeInterval=120

    // A read-only analysis of one Requirement/Plan must not authorize
    // mutation of a different record just because it shares a Project.
    func matchesAnalysisContext(requirementId focusedRequirementId: String?, planId focusedPlanId: String?) -> Bool {
        if let focusedRequirementId, !focusedRequirementId.isEmpty {
            switch operation {
            case .reviseRequirement:
                guard targetId == focusedRequirementId else { return false }
            case .createPlan, .revisePlan:
                guard requirementId == focusedRequirementId else { return false }
            case .createRequirement:
                break
            }
        }
        if operation == .revisePlan, let focusedPlanId, !focusedPlanId.isEmpty {
            return targetId == focusedPlanId
        }
        return true
    }

    func matchesCurrentPlan(_ plan: PlanRecordDetail) -> Bool {
        operation == .revisePlan
            && plan.planId == targetId
            && plan.revision == expectedRevision
            && plan.requirementId == requirementId
    }

    enum ProposalError: LocalizedError {
        case missing, ambiguous, invalid

        var errorDescription: String? {
            switch self {
            case .missing: return "当前 Agent 回复尚未给出 ACCEPT 提案。请继续补充信息或完成精化后再审阅。"
            case .ambiguous: return "检测到多个提案。请让 Agent 每次只输出一个变更提案。"
            case .invalid: return "提案结构或字段无效，请要求 Agent 按约定重新生成。"
            }
        }
    }

    private static func proposalPayload(from response:String) throws -> Data {
        let fence=String(repeating:"\u{60}",count:3)
        let marker=fence+"forge-proposal"
        let matches=response.components(separatedBy:marker)
        guard matches.count >= 2 else { throw ProposalError.missing }
        guard matches.count == 2 else { throw ProposalError.ambiguous }
        let remainder=matches[1]
        guard let end=remainder.range(of:fence) else { throw ProposalError.invalid }
        let raw=String(remainder[..<end.lowerBound]).trimmingCharacters(in:.whitespacesAndNewlines)
        guard raw.utf8.count <= 20_000,let data=raw.data(using:.utf8) else {
            throw ProposalError.invalid
        }
        return data
    }

    static func parse(_ response:String) throws -> Self {
        let data=try proposalPayload(from:response)
        guard let proposal=try? JSONDecoder().decode(Self.self,from:data),proposal.isValid else {
            throw ProposalError.invalid
        }
        return proposal
    }

    static func refinementDirective(from response:String) -> RefinementDirective? {
        guard let data=try? proposalPayload(from:response),
              let signal=try? JSONDecoder().decode(RefinementSignal.self,from:data),
              !signal.rationale.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { return nil }
        switch signal.decision {
        case "ACCEPT":
            return (try? parse(response)) == nil ? nil : .accept
        case "CONTINUE":
            return .continueRefinement
        case "NEEDS_USER":
            return .needsUser
        case "BLOCKED":
            return .blocked
        default:
            return nil
        }
    }

    static func continuationPrompt(round:Int,remainingTokens:Int,remainingSeconds:Int) -> String {
        """
        继续同一项目与 Requirement 的自动只读精化。这是第 \(round)/\(refinementMaximumRounds) 轮；剩余预算约 \(remainingTokens) tokens、\(remainingSeconds) 秒。
        沿用前面已核实的事实和回执，不重复已完成的读取。只执行下一项必要的只读核实；不要调用写入工具、命令或任何有副作用的能力。
        如果仍有可独立核实的事实，输出 CONTINUE；需要用户提供信息时输出 NEEDS_USER 并提出一个具体问题；遇到真实阻塞输出 BLOCKED；只有事实完整、验收可验证且方案明确时才输出有效 ACCEPT 提案。
        本轮最后必须遵守 forge-proposal 结构化结果约定。
        """
    }


    static let outputContract = """
    只进行需求/计划的只读分析，禁止调用任何写入工具、命令、源码修改、计划创建或任务执行。
    先从 Forge 现有记录确认目标项目、Requirement/Plan ID、最新 revision 和真实工作区证据；项目没有仓库时，不得假设文件或命令可用。
    自动精化最多 \(refinementMaximumRounds) 轮、累计 \(refinementMaximumTokens) tokens、\(Int(refinementMaximumDurationSeconds)) 秒。客户端按完整 Provider usage receipt 与实际耗时停止；无法核实 token 用量时不得继续自动轮次。若最终 ACCEPT 本轮自身达到或超过预算，停止自动精化但保留有效提案供人工审阅；绝不自动写入。
    每轮结束都必须恰好输出一个 Markdown fenced JSON 块，语言标识为 forge-proposal，且包含 decision 和非空 rationale：
    - CONTINUE：仍有可由你独立完成的只读核实，rationale 指明下一项必要证据；客户端会自动继续下一轮。
    - NEEDS_USER：必须由用户补充信息，rationale 给出一个最少且具体的问题；停止自动精化并等待用户。
    - BLOCKED：存在真实权限、数据或能力阻塞，rationale 说明阻塞；停止自动精化。
    - ACCEPT：仅当事实完整、方案可验收且你明确接受最终内容时使用，并完整填写下方提案字段。工具成功、空闲或普通文本都不能推导 ACCEPT。
    CONTINUE / NEEDS_USER / BLOCKED 只填写 decision 和 rationale，不附带可写入提案。
    ACCEPT 只绑定同一个 JSON 块中的内容及对应 revision 字段；修改既有记录使用 expectedRevision，新增 Plan 使用 expectedRequirementRevision。不得为未核实的内容输出 ACCEPT。
    (a) 改变既有 Requirement 目标使用 revise_requirement；
    (b) 在既有目标下改变方法使用 revise_plan；
    (c) 独立可验收的新目标使用 create_requirement；
    (d) 既有需求需要新实施路线使用 create_plan。
    优先复用，不要创建同义记录。如果无法确认真实记录、修订版本或目标，输出 NEEDS_USER 或 BLOCKED，不输出可应用提案。
    ACCEPT 提案 JSON 必须符合：
    {
      "decision": "ACCEPT",
      "operation": "create_requirement | revise_requirement | create_plan | revise_plan",
      "rationale": "选择修改或新增的依据与影响范围",
      "targetId": null,
      "expectedRevision": null,
      "expectedRequirementRevision": null,
      "requirementId": null,
      "title": null,
      "outcome": null,
      "acceptanceCriteria": [],
      "objective": null
    }
    字段按操作填写：新增 Requirement 需要 title/outcome/acceptanceCriteria；
    修改 Requirement 需要 targetId/expectedRevision/title/outcome/acceptanceCriteria；
    新增 Plan 需要 requirementId/expectedRequirementRevision/objective；expectedRequirementRevision 必须是刚读取并核实的父 Requirement 当前语义版本；
    修改 Plan 需要 targetId/expectedRevision/requirementId/objective；requirementId 必须与当前 Plan 的所属 Requirement 一致，独立 Plan 填 null。
    当前分析会话如果已关联 Requirement 或 Plan，则任何修改提案不得指向其他记录。
    每次只提一个独立变更，不输出多个代码块。最终写入必须由用户在 Zen 中明确批准。
    """
    var isValid: Bool {
        guard decision == .accept else { return false }
        func valid(_ value:String?,limit:Int) -> Bool {
            guard let text=value?.trimmingCharacters(in:.whitespacesAndNewlines) else { return false }
            return !text.isEmpty && text.count <= limit
        }
        let criteria=acceptanceCriteria ?? []
        guard valid(rationale,limit:2000),criteria.count <= 50,
              criteria.allSatisfy({valid($0,limit:500)}) else { return false }
        switch operation {
        case .createRequirement:
            return valid(title,limit:240) && valid(outcome,limit:2000)
                && !criteria.isEmpty && targetId == nil && expectedRevision == nil
                && expectedRequirementRevision == nil
        case .reviseRequirement:
            return valid(targetId,limit:160) && (expectedRevision ?? 0) > 0
                && valid(title,limit:240) && valid(outcome,limit:2000)
                && acceptanceCriteria != nil && expectedRequirementRevision == nil
        case .createPlan:
            return valid(requirementId,limit:160) && (expectedRequirementRevision ?? 0) > 0
                && valid(objective,limit:2000) && targetId == nil && expectedRevision == nil
        case .revisePlan:
            return valid(targetId,limit:160) && (expectedRevision ?? 0) > 0
                && valid(objective,limit:2000) && expectedRequirementRevision == nil
        }
    }
}
