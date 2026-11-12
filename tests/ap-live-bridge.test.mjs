import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = name => readFileSync(new URL(`../src/${name}`,import.meta.url),'utf8');
test('complete executing MCP tool is application-controlled and explicitly gated',()=>{
 const s=read('index.ts');
 assert.match(s,/registerTool\("run_ap_inbox"/);
 assert.match(s,/AP_INBOX_RUNNER_ENABLED/);
 assert.match(s,/executeCompleteApInbox\(/);
 assert.match(s,/makeDraftCommand:\(conversation,attachment\)=>makeLiveDraftCommand\(conversation,attachment,activeRunClient\)/);
 assert.match(s,/xero:makeLiveXeroDraftPort\(\)/);
});
test('live PDF extraction uses verified Front message and attachment IDs',()=>{
 const s=read('ap-live-document-ports.ts');
 assert.match(s,/messages\/\$\{encodeURIComponent\(attachment.messageId\)\}\/download\/\$\{encodeURIComponent\(attachment.id\)\}/);
 assert.match(s,/extractInvoiceFields\(\{text/);
 assert.match(s,/buildDraftFromAvailableCandidates/);
 assert.match(s,/MAX_BYTES/);
});
test('review writer targets only the agreed Finance review sheet',()=>{
 const s=read('google-sheets-review.ts');
 assert.match(s,/appendApInboxException/);
 assert.match(s,/SPREADSHEET_ID!==EXPECTED_SPREADSHEET_ID/);
 assert.match(s,/inbox:\$\{input.conversationId\}:\$\{input.attachmentId\}/);
});
test('PDF parser receives a copy so the original bytes survive for the model and Xero',()=>{
 const s=read('ap-live-document-ports.ts');
 assert.match(s,/new PDFParse\(\{data:pdf\.bytes\.slice\(\)\}\)/);
});
