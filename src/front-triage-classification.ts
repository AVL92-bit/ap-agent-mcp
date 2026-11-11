export type FrontTriageAttachment = {
  filename?: string;
  content_type?: string;
  content_id?: string;
  contentId?: string;
  is_inline?: boolean;
};

export type FrontTriageMessage = {
  subject?: string;
  text?: string;
  blurb?: string;
  body?: string;
  attachments?: FrontTriageAttachment[];
};

const financeWords = /\b(invoice|invoices|credit\s*note|statement|reminder|overdue|payment|bill|billing|accounts\s+payable|balance\s+due|account\s+balance|outstanding\s+balance|account\s+overdue|remittance\s+advice|purchase\s+order)\b/i;
const supportedExtensions = /\.(pdf|doc|docx|xls|xlsx|xlsm)$/i;
const supportedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12"
]);

/** A supported document must be identifiable by its extension or declared MIME type. */
export function isSupportedDocument(a: FrontTriageAttachment): boolean {
  const filename = (a.filename ?? "").trim();
  const mime = (a.content_type ?? "").toLowerCase().split(";")[0].trim();
  return supportedExtensions.test(filename) || supportedMimeTypes.has(mime);
}

/** All attachments remain visible for human review; only supported documents enter assessment. */
export function actionableAttachments(message: FrontTriageMessage): FrontTriageAttachment[] {
  return (message.attachments ?? []).filter(isSupportedDocument);
}

export function classifyFrontCorrespondence(messages: FrontTriageMessage[], subject = ""):
  "finance_correspondence" | "routine_non_finance" | "requires_attachment_review" {
  // Supported documents always require assessment, even when the email has no finance keywords.
  if (messages.some(m => actionableAttachments(m).length > 0)) return "requires_attachment_review";
  const finance = financeWords.test(subject) || messages.some(m =>
    financeWords.test([m.subject,m.text,m.blurb,m.body].filter(Boolean).join(" "))
  );
  if (finance) return "finance_correspondence";
  // Unsupported attachments without finance signals are ambiguous, never auto-archive.
  if (messages.some(m => (m.attachments ?? []).length > 0)) return "requires_attachment_review";
  return "routine_non_finance";
}
