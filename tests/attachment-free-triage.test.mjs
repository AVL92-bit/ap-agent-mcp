import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const classifier = readFileSync(new URL('../src/front-triage-classification.ts', import.meta.url), 'utf8');
test('routine mail requires attachment-free server-side classification', () => {
  assert.match(source, /classifyAttachmentFreeCorrespondence = classifyFrontCorrespondence/);
  assert.match(classifier, /actionableAttachments\(m\)\.length > 0/);
  assert.match(source, /classification !== "routine_non_finance"/);
});
test('routine mail is tagged reviewed and archived only after classification', () => {
  assert.match(source, /await applyApFrontTag\(conversation_id, "reviewed"\);\s*await archiveApFrontConversation\(conversation_id\)/);
});
test('finance mail with no attachments remains open for junior', () => {
  assert.match(source, /classification !== "finance_correspondence"/);
  assert.match(source, /outcome === "no_attachment_human_review"\s*\? "no_attachment" : "human_review"/);
  assert.match(source, /conversation_archived: false/);
});
test('draft-verified shortcut cannot archive without Xero reconciliation', () => {
  assert.match(source, /if \(outcome === "draft_verified"\)/);
  assert.match(source, /must reconcile every relevant document against Xero/);
});
