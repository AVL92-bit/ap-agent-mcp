export const FRONT_OUTCOME_POLICY = {
    draft_clean: { tag: 'AP Agent reviewed', archive: true, sheet: false },
    draft_uncertain: { tag: 'Human review', archive: false, sheet: true },
    xero_existing: { tag: 'AP Agent reviewed', archive: true, sheet: false },
    technical_failure: { tag: 'Human review', archive: false, sheet: true },
    finance_no_attachment: { tag: 'No attachment - Human review', archive: false, sheet: false },
    non_finance_no_attachment: { tag: 'AP Agent reviewed', archive: true, sheet: false },
};
export function classifyNoAttachment(text) {
    return /\b(invoice|statement|reminder|overdue|credit note|payment due|bill|accounts payable)\b/i.test(text)
        ? 'finance_no_attachment' : 'non_finance_no_attachment';
}
