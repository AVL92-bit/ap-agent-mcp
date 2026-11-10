import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const classifier=readFileSync(new URL('../src/front-triage-classification.ts',import.meta.url),'utf8');
const runner=source.slice(source.indexOf('server.registerTool("run_ap_correspondence_triage"'),source.indexOf('// FRONT: GET VERIFIED CONVERSATION MESSAGES'));
test('batch runner is server-owned and dry-run by default',()=>{
  assert.match(runner,/execute: z\.boolean\(\)\.default\(false\)/);
  assert.match(runner,/getConversationMessages\(c\.id,100\)/);
  assert.match(runner,/classifyAttachmentFreeCorrespondence\(listing\.messages,c\.subject\)/);
});
test('batch runner does not archive attachments or incomplete histories',()=>{
  assert.match(runner,/listing\.hasMore \|\| !listing\.messages\.length/);
  assert.match(runner,/classification === "requires_attachment_review"/);
  assert.match(runner,/if \(execute && incomplete\) return toolFailure/);
});
test('batch runner only archives routine non-finance mail',()=>{
  assert.match(runner,/if \(classification === "routine_non_finance"\)/);
  assert.match(runner,/await archiveApFrontConversation\(c\.id\)/);
  assert.match(runner,/await applyApFrontTag\(c\.id,"no_attachment"\)/);
});
test('correspondence classifier includes conversation subject',()=>{
  assert.match(classifier,/financeWords\.test\(subject\)/);
});
