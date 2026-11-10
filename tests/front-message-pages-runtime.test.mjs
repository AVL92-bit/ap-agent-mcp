import test from 'node:test';
import assert from 'node:assert/strict';
import {collectFrontMessagePages} from '../src/front-message-pages.ts';
test('collects all pages, preserving every message',async()=>{
  const seen=[];
  const r=await collectFrontMessagePages('cnv_abc',async url=>{
    seen.push(url);
    return seen.length===1 ? {_results:[{id:'one'}],_pagination:{next:'https://api2.frontapp.com/conversations/cnv_abc/messages?page=2'}} : {_results:[{id:'two'}]};
  });
  assert.deepEqual(r.messages,[{id:'one'},{id:'two'}]);
  assert.equal(r.hasMore,false);assert.equal(r.pages,2);
});
test('page cap reports incomplete history',async()=>{
  const r=await collectFrontMessagePages('cnv_abc',async()=>({_results:[1],_pagination:{next:'https://api2.frontapp.com/conversations/cnv_abc/messages?page=2'}}),1);
  assert.equal(r.hasMore,true);assert.deepEqual(r.messages,[1]);
});
test('rejects unsafe or repeated next links',async()=>{
  await assert.rejects(collectFrontMessagePages('cnv_abc',async()=>({_results:[],_pagination:{next:'https://evil.example/messages'}})),/Unsafe/);
  await assert.rejects(collectFrontMessagePages('cnv_abc',async()=>({_results:[],_pagination:{next:'https://api2.frontapp.com/conversations/cnv_abc/messages?limit=100'}})),/Repeated/);
});
