import SwiftUI

/// Shared native form vocabulary: semantic system colors, no parallel theme engine.
enum ForgeClientDesign {
    enum Spacing {
        static let sheetPadding: CGFloat = 22
        static let section: CGFloat = 18
        static let row: CGFloat = 9
        static let titleDetail: CGFloat = 4
    }
    enum Typography {
        static let sheetTitle: Font = .system(size: 17, weight: .semibold)
        static let sectionTitle: Font = .system(size: 12, weight: .semibold)
        static let body: Font = .system(size: 12)
        static let control: Font = .system(size: 11)
        static let supporting: Font = .system(size: 11)
        static let identifier: Font = .system(size: 11, design: .monospaced)
    }
    enum Size {
        static let approvalSheet: CGFloat = 520
        static let checkpointSheet: CGFloat = 500
        static let taskCreateSheet: CGFloat = 430
        static let taskEditSheet: CGFloat = 465
        static let taskFormContentMaxHeight: CGFloat = 420
        static let acceptanceCriteriaMaxHeight: CGFloat = 120
        static let taskAcceptanceSheet: CGFloat = 490
        static let metadataLabel: CGFloat = 90
    }
}

/// Use type and spacing instead of cards and separator lines.
struct ForgeClientFormSection<Content: View>: View {
    let title: String
    var detail: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.row) {
            Text(title).font(ForgeClientDesign.Typography.sectionTitle)
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(ForgeClientDesign.Typography.supporting)
                    .foregroundStyle(.secondary)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Persistent labels stay visible while fields are being edited.
struct ForgeClientFormField<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: ForgeClientDesign.Spacing.titleDetail) {
            Text(label)
                .font(ForgeClientDesign.Typography.control)
                .foregroundStyle(.secondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ForgeClientMetadataRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ForgeClientDesign.Spacing.row) {
            Text(label)
                .frame(width: ForgeClientDesign.Size.metadataLabel, alignment: .leading)
                .foregroundStyle(.secondary)
            Text(value)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .font(ForgeClientDesign.Typography.control)
        .accessibilityElement(children: .combine)
    }
}
