/** Inbox VAT policy is sourced solely from config/coding-policies.json.
 * Unknown or unsupported inboxes fail closed; no global VAT fallback exists.
 */
import { readFileSync } from 'node:fs';

export type InboxVatPolicy = Readonly<{recoverInputVat:boolean; purchaseTaxType:string; expenseBasis:'gross'|'net'}>;
type RawInboxVatPolicy = {vat_recovery?:unknown; xero_purchase_tax_type?:unknown; expense_amount_basis?:unknown};
type RawConfig = {vat_policy_scope?:unknown; unconfigured_inbox_behavior?:unknown; inbox_vat_policies?:Record<string,RawInboxVatPolicy>};
const policyFile = new URL('../config/coding-policies.json', import.meta.url);

export function vatPolicyForInbox(inboxId: string | undefined | null): InboxVatPolicy {
  if (!inboxId || !/^inb_[a-zA-Z0-9]+$/.test(inboxId))
    throw new Error(`No explicitly configured VAT policy for Front inbox ${String(inboxId ?? '(missing)')}; processing blocked`);
  let config:RawConfig;
  try { config=JSON.parse(readFileSync(policyFile,'utf8')) as RawConfig; }
  catch { throw new Error('Inbox VAT policy configuration unavailable or invalid; processing blocked'); }
  if (config.vat_policy_scope!=='front_inbox_id' || config.unconfigured_inbox_behavior!=='block_draft_creation')
    throw new Error('Inbox VAT policy configuration is not fail-closed; processing blocked');
  const entry=config.inbox_vat_policies?.[inboxId];
  if (!entry || !Object.prototype.hasOwnProperty.call(config.inbox_vat_policies,inboxId))
    throw new Error(`No explicitly configured VAT policy for Front inbox ${inboxId}; processing blocked`);
  // Only non-recoverable VAT posting is implemented. Future inbox policies
  // must receive a separate validated posting implementation before use.
  if (entry.vat_recovery!=='none' || entry.xero_purchase_tax_type!=='NONE' || entry.expense_amount_basis!=='gross_invoice_amount')
    throw new Error(`Unsupported VAT policy for Front inbox ${inboxId}; processing blocked`);
  return Object.freeze({recoverInputVat:false,purchaseTaxType:'NONE',expenseBasis:'gross'});
}

export function grossExpenseLine(input:{inboxId:string;description:string;gross:number;accountCode:string}) {
  const policy=vatPolicyForInbox(input.inboxId);
  if (policy.recoverInputVat || policy.expenseBasis!=='gross' || policy.purchaseTaxType!=='NONE')
    throw new Error(`Gross-only writer cannot process inbox ${input.inboxId}`);
  if (!Number.isFinite(input.gross) || input.gross<=0 || Math.abs(input.gross*100-Math.round(input.gross*100))>0.00001)
    throw new Error('Valid gross invoice amount required');
  if (!input.accountCode.trim()) throw new Error('Verified account code required');
  return {Description:input.description,Quantity:1,UnitAmount:input.gross,AccountCode:input.accountCode,TaxType:policy.purchaseTaxType};
}
