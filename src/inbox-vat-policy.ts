/** Explicit per-Front-inbox VAT policy. No global fallback is permitted.
 * Configure each additional inbox deliberately before enabling its drafts.
 */
export type InboxVatPolicy = Readonly<{recoverInputVat: boolean; purchaseTaxType: string; expenseBasis: 'gross' | 'net'}>;
const INBOX_VAT_POLICIES: Readonly<Record<string, InboxVatPolicy>> = Object.freeze({
  inb_bys7q: Object.freeze({recoverInputVat: false, purchaseTaxType: 'NONE', expenseBasis: 'gross'}),
});

export function vatPolicyForInbox(inboxId: string | undefined | null): InboxVatPolicy {
  if (!inboxId || !Object.prototype.hasOwnProperty.call(INBOX_VAT_POLICIES, inboxId)) {
    throw new Error(`No explicitly configured VAT policy for Front inbox ${String(inboxId ?? '(missing)')}; processing blocked`);
  }
  return INBOX_VAT_POLICIES[inboxId];
}

/** Gross-only line creation for a non-recoverable-VAT inbox. Other policies
 * require their own explicit posting implementation; never silently use NONE. */
export function grossExpenseLine(input: {inboxId:string;description:string;gross:number;accountCode:string}) {
  const policy=vatPolicyForInbox(input.inboxId);
  if (policy.recoverInputVat || policy.expenseBasis !== 'gross' || policy.purchaseTaxType !== 'NONE')
    throw new Error(`Gross-only draft writer does not support VAT policy for inbox ${input.inboxId}; processing blocked`);
  if(!Number.isFinite(input.gross) || input.gross<=0 ||
      Math.abs(input.gross*100-Math.round(input.gross*100))>0.00001)
    throw new Error('Valid gross invoice amount required for non-recoverable VAT posting');
  if(!input.accountCode.trim()) throw new Error('Verified account code required');
  return {Description:input.description,Quantity:1,UnitAmount:input.gross,
    AccountCode:input.accountCode,TaxType:policy.purchaseTaxType};
}
