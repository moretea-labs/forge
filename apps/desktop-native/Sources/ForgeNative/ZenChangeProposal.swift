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
    let requirementId: String?
    let title: String?
    let outcome: String?
    let acceptanceCriteria: [String]?
    let objective: String?

    var id: String { "\(operation.rawValue):\(targetId ?? requirementId ?? title ?? "new")" }

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

    static func parse(_ response: String) throws -> Self {
        let fence = String(repeating:"\u{60}",count:3)
        let marker = fence + "forge-proposal"
        let matches = response.components(separatedBy:marker)
        guard matches.count >= 2 else { throw ProposalError.missing }
        guard matches.count == 2 else { throw ProposalError.ambiguous }
        let remainder = matches[1]
        guard let end = remainder.range(of:fence) else { throw ProposalError.invalid }
        let raw = String(remainder[..<end.lowerBound]).trimmingCharacters(in:.whitespacesAndNewlines)
        guard raw.utf8.count <= 20_000,
              let data=raw.data(using:.utf8),
              let proposal=try? JSONDecoder().decode(Self.self,from:data),
              proposal.isValid else { throw ProposalError.invalid }
        return proposal
    }


    static let outputContract = """
    只进行需求/计划的只读分析，禁止调用任何写入工具、命令、源码修改、计划创建或任务执行。
    这是一个可多轮澄清和修订的会话。先从 Forge 的现有记录确认目标项目、Requirement/Plan ID 和最新 revision，判断：
    如果目标、验收标准、现有记录或 revision 尚未核实，先用普通文本提出最少必要问题并等待用户补充，不要输出 forge-proposal。
    只有在事实完整、方案可验收且你明确接受最终内容时，才输出 decision="ACCEPT"。该 ACCEPT 只绑定同一个 JSON 块中的内容及 expectedRevision；不得为未核实的内容输出 ACCEPT。
    (a) 改变既有 Requirement 目标使用 revise_requirement；
    (b) 在既有目标下改变方法使用 revise_plan；
    (c) 独立可验收的新目标使用 create_requirement；
    (d) 既有需求需要新实施路线使用 create_plan。
    优先复用，不要创建同义记录。如果无法确认真实记录、修订版本或目标，请解释阻塞，不输出可应用提案。
    最终接受后恰好输出一个 Markdown fenced JSON 块，语言标识为 forge-proposal。JSON 必须符合：
    {
      "decision": "ACCEPT",
      "operation": "create_requirement | revise_requirement | create_plan | revise_plan",
      "rationale": "选择修改或新增的依据与影响范围",
      "targetId": null,
      "expectedRevision": null,
      "requirementId": null,
      "title": null,
      "outcome": null,
      "acceptanceCriteria": [],
      "objective": null
    }
    字段按操作填写：新增 Requirement 需要 title/outcome/acceptanceCriteria；
    修改 Requirement 需要 targetId/expectedRevision/title/outcome/acceptanceCriteria；
    新增 Plan 需要 requirementId/objective；
    修改 Plan 需要 targetId/expectedRevision/objective。
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
        case .reviseRequirement:
            return valid(targetId,limit:160) && (expectedRevision ?? 0) > 0
                && valid(title,limit:240) && valid(outcome,limit:2000)
                && acceptanceCriteria != nil
        case .createPlan:
            return valid(requirementId,limit:160) && valid(objective,limit:2000)
                && targetId == nil && expectedRevision == nil
        case .revisePlan:
            return valid(targetId,limit:160) && (expectedRevision ?? 0) > 0
                && valid(objective,limit:2000)
        }
    }
}
