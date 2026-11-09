import test from 'node:test';
import assert from 'node:assert/strict';
import {makeApDocumentJournal,ensureApDocumentJournal} from '../src/ap-document-journal.ts';
test('journal initializes and binds source identity and digest',async()=>{
 const calls=[]; const client={query:async(sql,args)=>{calls.push({sql,args});return {rowCount:1}}};
 await ensureApDocumentJournal(client);
 const journal=makeApDocumentJournal(client);
 await journal.begin('cnv_1','fil_1','a'.repeat(64));
 await journal.complete('cnv_1','fil_1','draft_verified','xero-1');
 assert.match(calls[0].sql,/CREATE TABLE IF NOT EXISTS/);
 assert.match(calls[1].sql,/ALTER TABLE/);
 assert.deepEqual(calls[2].args,['cnv_1','fil_1','a'.repeat(64)]);
 assert.deepEqual(calls[3].args,['cnv_1','fil_1','draft_verified','xero-1']);
});
test('journal rejects changed source and invalid outcome',async()=>{
 const client={query:async()=>({rowCount:0})};const journal=makeApDocumentJournal(client);
 await assert.rejects(journal.begin('cnv_1','fil_1','a'.repeat(64)),/changed/);
 await assert.rejects(journal.complete('cnv_1','fil_1','approved'),/Invalid/);
});
