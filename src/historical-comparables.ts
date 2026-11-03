// Read-only investigation of a specified historical coding exception.
// Person/description search terms must be supplied by the reviewer, not inferred as verified identities.
import { testPilotXeroInvoiceHistory } from "./xero-invoice-history.js";

type HistoryLine = {
  invoice_number: string;
  date: string | null;
  description: string;
  account_code: string;
  account_name?: string | null;
  line_amount: number | null;
};

type History = {
  status: string;
  search_complete: boolean;
  stop_reason?: string;
  historical_bills_scanned: number;
  distinct_matching_invoices?: number;
  historical_examples: HistoryLine[];
};

function containsTerm(description: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(description);
}

export function compareHistoricalInvoiceLine(
  history: History,
  targetInvoice: string,
  terms: string[],
) {
  if (history.status !== "ok" || !Array.isArray(history.historical_examples)) {
    throw new Error("Valid historical evidence is required");
  }
  const targets = history.historical_examples.filter(
    line => line.invoice_number.toLowerCase() === targetInvoice.trim().toLowerCase(),
  );
  if (targets.length !== 1) {
    return {
      status: "needs_review",
      reason: targets.length === 0 ? "target_invoice_not_found" : "target_has_multiple_lines_select_line_first",
      matching_target_lines: targets.length,
      search_complete: history.search_complete,
      account_code_selected: false,
      bills_created: false,
      bills_modified: false,
    };
  }
  const target = targets[0];
  const comparables = history.historical_examples.filter(line =>
    line.invoice_number.toLowerCase() !== targetInvoice.trim().toLowerCase() &&
    !/^(vat|value added tax)(\s|$)/i.test(line.description.trim()) &&
    terms.some(term => containsTerm(line.description, term)),
  );
  const codeCounts = new Map<string, { count: number; invoices: Set<string>; name: string | null }>();
  for (const line of comparables) {
    const existing = codeCounts.get(line.account_code) ?? {
      count: 0, invoices: new Set<string>(), name: line.account_name ?? null,
    };
    existing.count++;
    existing.invoices.add(line.invoice_number);
    codeCounts.set(line.account_code, existing);
  }
  const codes = [...codeCounts.entries()].map(([code, data]) => ({
    code, account_name: data.name, lines: data.count, distinct_invoices: data.invoices.size,
  })).sort((a, b) => b.lines - a.lines || a.code.localeCompare(b.code));
  const dominant = codes[0];
  const strongAlternative = Boolean(history.search_complete && dominant &&
    dominant.code !== target.account_code && dominant.distinct_invoices >= 3 &&
    dominant.lines / comparables.length >= 0.9);
  return {
    status: "ok",
    target_invoice: targetInvoice,
    target_line: target,
    reviewer_supplied_match_terms: terms,
    matching_method: "case_insensitive_literal_description_term_match_not_identity_verification",
    search_complete: history.search_complete,
    stop_reason: history.stop_reason ?? null,
    historical_bills_scanned: history.historical_bills_scanned,
    matching_supplier_invoices: history.distinct_matching_invoices ?? null,
    comparable_lines: comparables.length,
    comparable_distinct_invoices: new Set(comparables.map(x => x.invoice_number)).size,
    comparable_account_codes: codes,
    examples: comparables.slice(0, 12),
    assessment: !history.search_complete ? "incomplete_history" :
      strongAlternative ? "potential_historical_coding_anomaly_review_source_evidence" :
      comparables.length === 0 ? "no_comparables_found" : "insufficient_evidence_to_flag_anomaly",
    potential_alternative_code_for_review: strongAlternative ? dominant.code : null,
    limitations: [
      "Description matches do not verify clinician identity or role on the invoice date",
      "Historical practice does not establish the correct accounting treatment",
      "Source invoice was not reviewed; do not treat a potential anomaly as a confirmed error",
      "No historical or new invoice will be changed by this tool",
    ],
    account_code_selected: false,
    bills_created: false,
    bills_modified: false,
  };
}

export async function investigatePilotHistoricalCodingException(input: {
  supplier_name: string;
  invoice_number: string;
  comparison_terms: string[];
}) {
  if (!input.supplier_name.trim() || !input.invoice_number.trim() ||
      input.comparison_terms.length === 0 || input.comparison_terms.length > 5 ||
      input.comparison_terms.some(term => term.trim().length < 3)) {
    throw new Error("Provide supplier, invoice number and 1–5 meaningful comparison terms");
  }
  const history = await testPilotXeroInvoiceHistory({ supplier_name: input.supplier_name });
  return compareHistoricalInvoiceLine(history, input.invoice_number, input.comparison_terms);
}
