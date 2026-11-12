import test from 'node:test';
import assert from 'node:assert/strict';
import { previewApDraftSelection } from '../dist/ap-draft-dry-run.js';

test('Water Plus snapshot dry run preserves supplier, amount and due date uncertainty', async () => {
  const result = await previewApDraftSelection({
    invoiceText: [
      'Summary of Charges: invoice wp-INV13861043',
      'Invoice date 03/11/2026',
      'Water Plus Group Limited (company number 10012579), Water Plus Limited (company number 04141390) and Water Plus Select Limited (company number 03511659).',
      'Cheques should be made payable to Water',
      'Plus Limited. This service is free',
      'Total charges for this period £48.67',
      'Total amount -£10.60',
    ].join('\n'),
    filename:'water-plus.pdf', attachmentId:'fil_50g2yyom',
    contacts:[{id:'existing-water-plus',name:'Water Plus'}],
    accounts:[{code:'457',name:'Light and heat',type:'OVERHEADS',status:'ACTIVE'}],
    historicalAccountCode:'457',
  });
  assert.equal(result.supplier_extracted.value,'Water Plus Limited');
  assert.equal(result.supplier_selected.contact_id,'existing-water-plus');
  assert.equal(result.supplier_selected.strictly_above_50_percent,true);
  assert.equal(result.account_code,'457');
  assert.equal(result.gross_gbp,48.67);
  assert.ok(result.uncertainty_fields.includes('supplier'));
  assert.ok(result.uncertainty_fields.includes('grossAmount'));
  assert.ok(result.uncertainty_fields.includes('dueDate'));
  assert.equal(result.creates_draft,false);
  assert.equal(result.xero_contacts_live_verified,false);
  assert.equal(result.duplicate_check_completed,false);
});

test('snapshot dry run refuses to invent a Xero contact match', async () => {
  await assert.rejects(() => previewApDraftSelection({
    invoiceText:'Invoice INV-123 Supplier Water Plus Limited Total £12.00',
    filename:'invoice.pdf',attachmentId:'fil_test',
    contacts:[{id:'unrelated',name:'Other Company'}],
    accounts:[{code:'457',name:'Light and heat',type:'OVERHEADS',status:'ACTIVE'}],
  }),/No existing Xero supplier contact exceeded 50%/);
});
