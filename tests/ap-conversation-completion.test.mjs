import test from 'node:test';
import assert from 'node:assert/strict';
import {decideDocumentConversation} from '../src/ap-conversation-completion.ts';
const d=(id,disposition)=>({attachmentId:id,disposition});
test('all drafts attached can archive',()=>assert.equal(decideDocumentConversation([d('a','xero_draft_attached'),d('b','xero_existing_verified')]).archive,true));
test('one unprocessed attachment prevents archive',()=>assert.equal(decideDocumentConversation([d('a','xero_draft_attached'),d('b','unprocessed')]).archive,false));
test('uncertain draft keeps conversation open',()=>assert.equal(decideDocumentConversation([d('a','draft_uncertain_attached')]).tag,'Human review'));
test('processing failure keeps conversation open',()=>assert.equal(decideDocumentConversation([d('a','processing_failure')]).archive,false));
test('no attachments cannot count as Xero completion',()=>assert.equal(decideDocumentConversation([]).archive,false));
test('duplicate attachment identity cannot count twice',()=>assert.equal(decideDocumentConversation([d('a','xero_draft_attached'),d('a','xero_existing_verified')]).archive,false));

test('receipt alongside a clean draft does not stop archiving', async () => {
  const { decideDocumentConversation } = await import(new URL('../dist/ap-conversation-completion.js', import.meta.url));
  const d = decideDocumentConversation([{attachmentId:'inv',disposition:'xero_draft_attached'},{attachmentId:'rcpt',disposition:'supporting_document'}]);
  assert.equal(d.archive, true); assert.equal(d.tag, 'AP Agent reviewed');
});
test('receipt alongside an uncertain draft: Human review, left open', async () => {
  const { decideDocumentConversation } = await import(new URL('../dist/ap-conversation-completion.js', import.meta.url));
  const d = decideDocumentConversation([{attachmentId:'inv',disposition:'draft_uncertain_attached'},{attachmentId:'rcpt',disposition:'supporting_document'}]);
  assert.equal(d.archive, false); assert.equal(d.tag, 'Human review');
});
test('receipt-only conversation: Human review, left open', async () => {
  const { decideDocumentConversation } = await import(new URL('../dist/ap-conversation-completion.js', import.meta.url));
  const d = decideDocumentConversation([{attachmentId:'rcpt',disposition:'supporting_document'}]);
  assert.equal(d.archive, false); assert.equal(d.tag, 'Human review'); assert.match(d.reason, /supporting documents/);
});
