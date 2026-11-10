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

const financeWords = /\b(invoice|invoices|credit\s*note|statement|reminder|overdue|payment|bill|billing|accounts\s+payable|balance\s+due)\b/i;
const invoiceName = /\b(invoice|inv[-_ ]?\d|bill|receipt|statement|credit[-_ ]?note)\b/i;

/** Ignore only a demonstrably inline, referenced image asset, never an unverified image invoice. */
export function isVerifiedInlineAsset(a: FrontTriageAttachment, message: FrontTriageMessage): boolean {
  const type = (a.content_type ?? "").toLowerCase().split(";")[0].trim();
  if (!type.startsWith("image/")) return false;
  if (invoiceName.test(a.filename ?? "")) return false;
  const cid = (a.content_id ?? a.contentId ?? "").replace(/^cid:/i, "").replace(/^<|>$/g, "").trim();
  if (!cid) return false;
  const html = message.body ?? "";
  return html.toLowerCase().includes("cid:" + cid.toLowerCase());
}

export function actionableAttachments(message: FrontTriageMessage): FrontTriageAttachment[] {
  return (message.attachments ?? []).filter(a => !isVerifiedInlineAsset(a, message));
}

export function classifyFrontCorrespondence(messages: FrontTriageMessage[], subject = ""):
  "finance_correspondence" | "routine_non_finance" | "requires_attachment_review" {
  if (messages.some(m => actionableAttachments(m).length > 0)) return "requires_attachment_review";
  return financeWords.test(subject) || messages.some(m =>
    financeWords.test([m.subject,m.text,m.blurb,m.body].filter(Boolean).join(" "))
  ) ? "finance_correspondence" : "routine_non_finance";
}
