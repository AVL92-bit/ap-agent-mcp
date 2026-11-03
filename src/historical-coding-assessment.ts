// Read-only historical nominal coding assessment. No supplier policy mappings.
import { testPilotXeroInvoiceHistory } from "./xero-invoice-history.js";

type EvidenceLine = {
  supplier: string;
  invoice_number: string;
  date: string | null;
  description: string;
  account_code: string;
  account_name?: string | null;
  account_status?: string | null;
  account_type?: string | null;
  line_amount: number | null;
  historical_tax_type: string | null;
  historical_tax_amount?: number | null;
  invoice_total?: number | null;
};

type HistoryResult = {
  status: string;
  search_complete: boolean;
  matching_invoice_lines: number;
  historical_bills_scanned: number;
  matching_bills_in_returned_lines?: number;
  distinct_matching_invoices?: number;
  pages_scanned?: number;
  stop_reason?: string;
  historical_examples: EvidenceLine[];
};

export function descriptionCategory(description: string): string {
  const d = description.trim().toLowerCase();
  if (/^(vat|value added tax)(\s+(on|@|amount|charge|20%|5%))?\s*$/.test(d)) return "separately_described_vat";
  if (/\b(lantum fee|locum fee|admin(?:istration)? fee|service fee|booking fee|platform fee)\b/.test(d)) return "service_or_administration_fee";
  if (/\b(gp|session|clinician|locum|doctor)\b/.test(d)) return "clinical_session";
  return "other_or_unclassified";
}

export function assessHistoricalEvidence(history: HistoryResult) {
  if (history.status !== "ok" || !Array.isArray(history.historical_examples)) {
    throw new Error("Valid historical evidence is required");
  }
  const lines = history.historical_examples;
  const vatLines = lines.filter(x => descriptionCategory(x.description) === "separately_described_vat");
  const costLines = lines.filter(x => descriptionCategory(x.description) !== "separately_described_vat");
  const groups = new Map<string, EvidenceLine[]>();
  for (const line of costLines) {
    const category = descriptionCategory(line.description);
    groups.set(category, [...(groups.get(category) ?? []), line]);
  }
  const categories = [...groups.entries()].map(([category, members]) => {
    const byCode = new Map<string, EvidenceLine[]>();
    for (const line of members) {
      byCode.set(line.account_code, [...(byCode.get(line.account_code) ?? []), line]);
    }
    const account_codes = [...byCode.entries()].map(([code, matches]) => ({
      code,
      name: matches.find(x => x.account_name)?.account_name ?? null,
      account_status: matches.find(x => x.account_status)?.account_status ?? null,
      account_type: matches.find(x => x.account_type)?.account_type ?? null,
      line_count: matches.length,
      distinct_invoices: new Set(matches.map(x => x.invoice_number)).size,
    })).sort((a,b) => b.line_count-a.line_count || a.code.localeCompare(b.code));
    const dominant = account_codes[0];
    const distinctInvoices = new Set(members.map(x => x.invoice_number)).size;
    const hasAmbiguousClassification = category === "other_or_unclassified";
    const validAccount = dominant?.name && dominant.account_status === "ACTIVE";
    // Conservative, human-review-only suggestion; never authorises a draft.
    const sufficient = history.search_complete && !hasAmbiguousClassification &&
      distinctInvoices >= 5 && members.length >= 5 &&
      dominant?.line_count / members.length >= 0.9 && validAccount;
    return {
      category,
      classification_is_heuristic: true,
      line_count: members.length,
      distinct_invoices: distinctInvoices,
      account_codes,
      consistent_in_returned_sample: account_codes.length === 1,
      most_observed_code: dominant?.code ?? null,
      most_observed_code_share: dominant ? dominant.line_count / members.length : null,
      human_review_suggestion: sufficient ? {
        account_code: dominant.code,
        account_name: dominant.name,
        basis: "Dominant code among comparable historical descriptions; verify against source invoice",
      } : null,
      recommendation_blockers: [
        ...(!history.search_complete ? ["historical_search_incomplete"] : []),
        ...(distinctInvoices < 5 ? ["fewer_than_five_distinct_invoices"] : []),
        ...(hasAmbiguousClassification ? ["unclassified_description"] : []),
        ...(!validAccount ? ["active_account_name_not_verified"] : []),
        ...(dominant && dominant.line_count / members.length < 0.9 ? ["conflicting_historical_codes"] : []),
      ],
      requires_human_accounting_validation: true,
    };
  });
  return {
    status: "ok",
    analysis_type: "historical_evidence_with_conditional_human_review_suggestions",
    search_complete: history.search_complete,
    stop_reason: history.stop_reason ?? (history.search_complete ? "end_of_history" : "unknown"),
    pages_scanned: history.pages_scanned ?? null,
    historical_bills_scanned: history.historical_bills_scanned,
    matching_invoices: history.distinct_matching_invoices ?? new Set(lines.map(x => x.invoice_number)).size,
    lines_assessed: lines.length,
    nominal_cost_lines_assessed: costLines.length,
    separately_described_vat_lines: vatLines.length,
    vat_line_handling: "Excluded from nominal category frequency; retained as invoice reconciliation evidence. Do not add VAT twice.",
    categories,
    observations: [
      ...(history.search_complete ? [] : ["Search incomplete; results do not establish all historical practice"]),
      "Historical consistency does not establish correctness",
      "Description categories are heuristic; verify against the invoice",
      "Inbox-specific VAT recovery rules remain unchanged",
    ],
    account_code_selected: false,
    bills_created: false,
    bills_modified: false,
  };
}

export async function assessPilotHistoricalCoding(search: {
  supplier_name?: string;
  description_query?: string;
}) {
  if (!search.supplier_name?.trim() && !search.description_query?.trim()) {
    throw new Error("A supplier or description is required");
  }
  return assessHistoricalEvidence(await testPilotXeroInvoiceHistory(search));
}
