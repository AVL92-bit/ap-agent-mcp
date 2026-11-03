// Historical coding evidence assessment: read-only and deliberately conservative.
// This module does not read approved supplier mappings or choose VAT recovery.
import { testPilotXeroInvoiceHistory } from "./xero-invoice-history.js";

type EvidenceLine = {
  supplier: string;
  invoice_number: string;
  date: string | null;
  description: string;
  account_code: string;
  line_amount: number | null;
  historical_tax_type: string | null;
};

type HistoryResult = {
  status: string;
  search_complete: boolean;
  matching_invoice_lines: number;
  historical_bills_scanned: number;
  historical_examples: EvidenceLine[];
};

function descriptionCategory(description: string): string {
  const d = description.toLowerCase();
  // Categories are descriptive groupings, never account-code rules.
  if (/^\s*(vat|value added tax)\s*$/.test(d)) return "separate_vat_line";
  if (/\b(lantum fee|locum fee|admin(?:istration)? fee|service fee)\b/.test(d)) return "service_or_administration_fee";
  if (/\b(gp|session|clinician|locum)\b/.test(d)) return "clinical_session";
  return "other_or_unclassified";
}

export function assessHistoricalEvidence(history: HistoryResult) {
  if (history.status !== "ok" || !Array.isArray(history.historical_examples)) {
    throw new Error("Valid historical evidence is required");
  }
  const lines = history.historical_examples;
  const groups = new Map<string, EvidenceLine[]>();
  for (const line of lines) {
    const category = descriptionCategory(line.description);
    const current = groups.get(category) ?? [];
    current.push(line);
    groups.set(category, current);
  }
  const categories = [...groups.entries()].map(([category, members]) => {
    const counts = new Map<string, number>();
    const invoiceNumbers = new Set<string>();
    for (const line of members) {
      counts.set(line.account_code, (counts.get(line.account_code) ?? 0) + 1);
      if (line.invoice_number) invoiceNumbers.add(line.invoice_number);
    }
    const account_codes = [...counts.entries()]
      .map(([code, line_count]) => ({ code, line_count }))
      .sort((a, b) => b.line_count - a.line_count || a.code.localeCompare(b.code));
    const dominant = account_codes[0];
    return {
      category,
      classification_is_heuristic: true,
      line_count: members.length,
      distinct_invoices: invoiceNumbers.size,
      account_codes,
      consistent_in_returned_sample: account_codes.length === 1,
      most_observed_code: dominant?.code ?? null,
      most_observed_code_share: dominant ? dominant.line_count / members.length : null,
      // Never present a sampled, unvalidated historical code as approved.
      recommendation: null,
      requires_human_accounting_validation: true,
    };
  });
  return {
    status: "ok",
    analysis_type: "historical_evidence_only",
    search_complete: history.search_complete,
    historical_bills_scanned: history.historical_bills_scanned,
    lines_assessed: lines.length,
    categories,
    observations: [
      ...(history.search_complete ? [] : ["Search incomplete; returned lines cannot establish all historical practice"]),
      "Historical consistency is not evidence that a code is correct",
      "Description categories are heuristic and must be verified against source invoices",
      "Inbox-specific VAT treatment is outside this nominal-code assessment",
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
  const history = await testPilotXeroInvoiceHistory(search);
  return assessHistoricalEvidence(history);
}
