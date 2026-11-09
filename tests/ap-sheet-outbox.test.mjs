import test from 'node:test';
import assert from 'node:assert/strict';
import {makeApSheetOutbox} from '../src/ap-sheet-outbox.ts';

function fakeDb() {
 const records=new Map();
 return {records, async query(sql,args=[]) {
  if(sql.includes('INSERT INTO ap_sheet_outbox')) {
   if(!records.has(args[0]) || !records.get(args[0]).delivered) records.set(args[0],{payload:JSON.parse(args[1]),delivered:false,attempts:0});
   return {rows:[],rowCount:1};
  }
  if(sql.includes('SELECT source_key,payload')) return {rows:[...records].filter(([,v])=>!v.delivered).map(([source_key,v])=>({source_key,payload:v.payload})).slice(0,args[0])};
  if(sql.includes('SET delivered_at=now()')) { const r=records.get(args[0]);r.delivered=true;r.attempts++;return {rows:[]}; }
  if(sql.includes('SET attempts=attempts+1')) {records.get(args[0]).attempts++;return {rows:[]};}
  if(sql.includes('SELECT count(*)')) return {rows:[{n:[...records.values()].filter(x=>!x.delivered).length}]};
  throw Error('Unexpected SQL '+sql);
 }};
}
const row={conversationId:'cnv_1',attachmentId:'fil_1',outcome:'draft_uncertain',reason:'supplier uncertain',supplier:'Test Supplier'};
test('durable Sheet queue retains failed delivery and replays on next flush',async()=>{
 const db=fakeDb();let calls=0;
 const outbox=makeApSheetOutbox(db,async()=>{calls++;if(calls===1)throw Error('temporary outage');});
 await outbox.enqueue(row);
 assert.deepEqual(await outbox.flush(),{delivered:0,failed:1,pending:1});
 assert.deepEqual(await outbox.flush(),{delivered:1,failed:0,pending:0});
 assert.equal(calls,2);
});
test('re-enqueue of delivered row does not send duplicate',async()=>{
 const db=fakeDb();let calls=0;
 const outbox=makeApSheetOutbox(db,async()=>{calls++;});
 await outbox.enqueue(row);await outbox.flush();await outbox.enqueue(row);await outbox.flush();
 assert.equal(calls,1);
});
