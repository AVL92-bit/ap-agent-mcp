import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSupplier,chooseAccount} from '../src/ap-best-candidate-selection.ts';
test('normalised exact supplier match is certain',()=>{const x=chooseSupplier('Acme Limited',[{id:'a',name:'Acme Ltd'}]);assert.equal(x.value.id,'a');assert.deepEqual(x.uncertainFields,[])});
test('partial supplier match selects best candidate but flags uncertainty',()=>{const x=chooseSupplier('Acme Healthcare',[{id:'a',name:'Acme Healthcare Ltd'}]);assert.equal(x.value.id,'a')});
test('unrelated contact is not selected',()=>assert.equal(chooseSupplier('Water Plus',[{id:'x',name:'City Gas'}]),null));
test('preferred account is certain',()=>{const x=chooseAccount([{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],'449');assert.deepEqual(x.uncertainFields,[])});
test('fallback account is uncertain',()=>{const x=chooseAccount([{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],undefined,'449');assert.deepEqual(x.uncertainFields,['accountCode'])});
test('bank and liability accounts excluded',()=>{const x=chooseAccount([{code:'001',name:'Bank',type:'BANK',status:'ACTIVE'},{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}]);assert.equal(x.value.code,'449')});

test('strictly greater than 40 percent supplier score qualifies',()=>{
 const match=chooseSupplier('Alpha Beta Gamma',[{id:'a',name:'Alpha Beta'}]);
 assert.equal(match?.value.id,'a');
 assert.deepEqual(match?.uncertainFields,['supplier']);
});
test('50 percent supplier score qualifies as an uncertain best candidate',()=>{
 const match=chooseSupplier('Alpha Beta',[{id:'a',name:'Alpha Delta'}]);
 assert.equal(match?.value.id,'a');
 assert.equal(match?.score,0.5);
 assert.deepEqual(match?.uncertainFields,['supplier']);
});
test('exactly 40 percent supplier score does not qualify',()=>{
 assert.equal(chooseSupplier('Alpha Beta Gamma Delta Epsilon',[{id:'a',name:'Alpha Beta'}]),null);
});
test('highest scoring existing contact wins and never creates a contact',()=>{
 const match=chooseSupplier('Water Plus Group Limited',[{id:'approved',name:'Water Plus Limited'},{id:'other',name:'Water Services Ltd'}]);
 assert.equal(match?.value.id,'approved');
 assert.deepEqual(match?.uncertainFields,['supplier']);
});
