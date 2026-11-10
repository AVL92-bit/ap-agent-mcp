import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProvisionalContact,contactIdentity} from '../src/ap-contact-write-intent.ts';
const intent=()=>{const data=new Map();return {get:async n=>data.get(contactIdentity(n)),claim:async n=>{const k=contactIdentity(n);if(data.has(k))return false;data.set(k,null);return true},reconciled:async(n,id)=>{data.set(contactIdentity(n),id)}}};
test('first attempt claims durable intent and records Xero ID',async()=>{
 const i=intent();let writes=0;
 const c=await resolveProvisionalContact({name:'  Example  Ltd ',intent:i,listContacts:async()=>[],postContact:async name=>{writes++;return {id:'c1',name}}});
 assert.equal(c.id,'c1');assert.equal(writes,1);assert.equal(await i.get('example ltd'),'c1');
});
test('ambiguous contact POST cannot be retried blindly',async()=>{
 const i=intent();let writes=0;const run=()=>resolveProvisionalContact({name:'Example Ltd',intent:i,listContacts:async()=>[],postContact:async()=>{writes++;throw Error('timeout')}});
 await assert.rejects(run(),/timeout/);await assert.rejects(run(),/Reconciliation required/);assert.equal(writes,1);
});
test('existing exact Xero contact reconciles previous intent without POST',async()=>{
 const i=intent();await i.claim('Example Ltd');let writes=0;
 const c=await resolveProvisionalContact({name:'EXAMPLE LTD',intent:i,listContacts:async()=>[{id:'c9',name:'Example Ltd'}],postContact:async()=>{writes++;throw Error('unexpected')}});
 assert.equal(c.id,'c9');assert.equal(writes,0);assert.equal(await i.get('Example Ltd'),'c9');
});
test('ambiguous duplicate exact Xero contacts cannot be selected silently',async()=>{
 const i=intent();await assert.rejects(resolveProvisionalContact({name:'Acme',intent:i,listContacts:async()=>[{id:'1',name:'Acme'},{id:'2',name:'ACME'}],postContact:async()=>{throw Error('unexpected')}}),/Multiple Xero contacts/);
});
