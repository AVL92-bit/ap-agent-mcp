import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { grossExpenseLine, vatPolicyForInbox } from '../src/inbox-vat-policy.ts';
const inbox='inb_bys7q';
test('practice inbox has explicit no-recovery policy',()=>{
  assert.deepEqual(vatPolicyForInbox(inbox),{recoverInputVat:false,purchaseTaxType:'NONE',expenseBasis:'gross'});
});
for (const [net,vat,gross] of [[90,18,108],[100,20,120],[250,0,250]]) {
  test(`practice inbox gross ${gross} uses NONE (supplier VAT ${vat})`,()=>{
    const line=grossExpenseLine({inboxId:inbox,description:'test',gross,accountCode:'449'});
    assert.equal(line.UnitAmount,net+vat);
    assert.equal(line.TaxType,'NONE');
  });
}
for(const unknown of ['inb_future','',undefined]) {
  test(`unconfigured inbox ${String(unknown)} fails closed`,()=>{
    assert.throws(()=>vatPolicyForInbox(unknown),/No explicitly configured VAT policy/);
    assert.throws(()=>grossExpenseLine({inboxId:unknown,description:'test',gross:108,accountCode:'449'}),/No explicitly configured VAT policy/);
  });
}

// The published policy document must agree with the runtime registry.
import { readFileSync } from 'node:fs';
const configured = JSON.parse(readFileSync(new URL('../config/coding-policies.json', import.meta.url), 'utf8'));
test('published configuration scopes VAT by inbox and agrees with runtime', () => {
  assert.equal(configured.practice_rules.vat_recovery, undefined);
  assert.equal(configured.vat_policy_scope, 'front_inbox_id');
  assert.equal(configured.unconfigured_inbox_behavior, 'block_draft_creation');
  const entry = configured.inbox_vat_policies[inbox];
  assert.deepEqual(entry, {vat_recovery:'none', xero_purchase_tax_type:'NONE', expense_amount_basis:'gross_invoice_amount'});
  const runtime = vatPolicyForInbox(inbox);
  assert.equal(runtime.recoverInputVat, false);
  assert.equal(runtime.purchaseTaxType, entry.xero_purchase_tax_type);
  assert.equal(runtime.expenseBasis, 'gross');
});

test('unsupported future inbox VAT treatment fails closed',()=>{
  const cfgPath=new URL('../config/coding-policies.json',import.meta.url);
  const original=readFileSync(cfgPath,'utf8');
  const fs=writeFileSync;
  try {
    const changed=JSON.parse(original);
    changed.inbox_vat_policies.inb_future={vat_recovery:'full',xero_purchase_tax_type:'INPUT2',expense_amount_basis:'net_invoice_amount'};
    fs(cfgPath,JSON.stringify(changed));
    assert.throws(()=>vatPolicyForInbox('inb_future'),/Unsupported VAT policy/);
  } finally {fs(cfgPath,original);}
});
