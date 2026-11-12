import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSupplier,chooseAccount} from '../src/ap-best-candidate-selection.ts';
test('normalised exact supplier match is certain',()=>{const x=chooseSupplier('Acme Limited',[{id:'a',name:'Acme Ltd'}]);assert.equal(x.value.id,'a');assert.deepEqual(x.uncertainFields,[])});
test('partial supplier match selects best candidate but flags uncertainty',()=>{const x=chooseSupplier('Acme Healthcare',[{id:'a',name:'Acme Healthcare Ltd'}]);assert.equal(x.value.id,'a')});
test('unrelated contact is not selected',()=>assert.equal(chooseSupplier('Water Plus',[{id:'x',name:'City Gas'}]),null));
test('preferred account is certain',()=>{const x=chooseAccount([{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],'449');assert.deepEqual(x.uncertainFields,[])});
test('contact default purchase account is used only without supplier history, and is uncertain',()=>{const x=chooseAccount([{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],undefined,'449');assert.equal(x.value.code,'449');assert.deepEqual(x.uncertainFields,['accountCode'])});
test('no generic fallback: without supplier history or contact default there is no account',()=>{assert.equal(chooseAccount([{code:'001',name:'Bank',type:'BANK',status:'ACTIVE'},{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}]),null)});
test('bank and liability accounts are never selected, even from history',()=>{assert.equal(chooseAccount([{code:'001',name:'Bank',type:'BANK',status:'ACTIVE'}],'001'),null)});

test('strictly greater than 40 percent supplier score qualifies',()=>{
 const match=chooseSupplier('Alpha Beta Gamma',[{id:'a',name:'Alpha Delta Gamma'}]);
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

test('"(DD)" and "Direct Debit" tags in Xero contact names are ignored',()=>{
 const m=chooseSupplier('Healthtech 1',[{id:'h',name:'Healthtech-1 (DD)'},{id:'x',name:'Other Ltd'}]);
 assert.equal(m?.value.id,'h'); assert.equal(m?.score,1); assert.deepEqual(m?.uncertainFields,[]);
 assert.equal(chooseSupplier('Wavenet Limited',[{id:'w',name:'Wavenet (DD)'}])?.score,1);
});
test('a contact name fully contained in the document supplier is the same supplier',()=>{
 for (const [doc,contact] of [['Henry Schein Medical','Henry Schein'],['Modulr Finance Limited','Modulr (DD)'],['Aventis Pharma trading as Sanofi','Aventis Pharma/ Sanofi (DD)']]) {
  const m=chooseSupplier(doc,[{id:'c',name:contact},{id:'x',name:'Unrelated Supplies Ltd'}]);
  assert.deepEqual(m?.uncertainFields,[],doc);
 }
});
test('containment is not certain when another contact also qualifies',()=>{
 const m=chooseSupplier('Henry Schein Medical',[{id:'a',name:'Henry Schein'},{id:'b',name:'Schein'}]);
 assert.deepEqual(m?.uncertainFields,['supplier']);
});
