import test from 'node:test';
import assert from 'node:assert/strict';
import {scanApFrontInbox} from '../src/ap-front-inbox-scan.ts';
const base='https://api2.frontapp.com';
function fetcher(pages){return async url=>{const u=new URL(url,base);const key=u.pathname+(u.searchParams.get('page')?'?page='+u.searchParams.get('page'):'');if(!(key in pages))throw Error('Unexpected '+key);return pages[key]}};
test('scans complete conversation and message pagination before returning attachments',async()=>{
 const pages={
 '/inboxes/inb_123/conversations':{_results:[{id:'cnv_abc',status:'unassigned',assignee:null,subject:'Invoice'}],_pagination:{next:base+'/inboxes/inb_123/conversations?page=2'}},
 '/inboxes/inb_123/conversations?page=2':{_results:[]},
 '/conversations/cnv_abc/messages':{_results:[{id:'msg_1',body:'Invoice enclosed'}],_pagination:{next:base+'/conversations/cnv_abc/messages?page=2'}},
 '/conversations/cnv_abc/messages?page=2':{_results:[{id:'msg_2',attachments:[{filename:'a.pdf',url:'https://api2.frontapp.com/download/fil_123'}]}]}
 };
 const r=await scanApFrontInbox({inboxId:'inb_123',fetchPage:fetcher(pages)});
 assert.equal(r.length,1);assert.equal(r[0].attachments[0].id,'fil_123');assert.equal(r[0].attachments[0].messageId,'msg_2');
});
test('rejects truncated inbox before processing',async()=>{
 const pages={'/inboxes/inb_123/conversations':{_results:[],_pagination:{next:base+'/inboxes/inb_123/conversations?page=2'}}};
 await assert.rejects(scanApFrontInbox({inboxId:'inb_123',fetchPage:fetcher(pages),maxPages:1}),/Incomplete/);
});
test('rejects cross-origin pagination',async()=>{
 const pages={'/inboxes/inb_123/conversations':{_results:[],_pagination:{next:'https://evil.example/inboxes/inb_123/conversations'}}};
 await assert.rejects(scanApFrontInbox({inboxId:'inb_123',fetchPage:fetcher(pages)}),/Unsafe/);
});
test('rejects missing message history rather than treating conversation as attachment-free',async()=>{
 const pages={'/inboxes/inb_123/conversations':{_results:[{id:'cnv_abc',status:'unassigned',assignee:null}]},'/conversations/cnv_abc/messages':{_results:[]}};
 await assert.rejects(scanApFrontInbox({inboxId:'inb_123',fetchPage:fetcher(pages)}),/Incomplete message/);
});
