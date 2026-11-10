import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSupplier,chooseAccount} from '../src/ap-best-candidate-selection.ts';
test('normalised exact supplier match is certain',()=>{const x=chooseSupplier('Acme Limited',[{id:'a',name:'Acme Ltd'}]);assert.equal(x.value.id,'a');assert.deepEqual(x.uncertainFields,[])});
test('partial supplier match selects best candidate but flags uncertainty',()=>{const x=chooseSupplier('Acme Healthcare',[{id:'a',name:'Acme Healthcare Ltd'}]);assert.equal(x.value.id,'a')});
test('unrelated contact is not selected',()=>assert.equal(chooseSupplier('Water Plus',[{id:'x',name:'City Gas'}]),null));
test('preferred account is certain',()=>{const x=chooseAccount([{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],'449');assert.deepEqual(x.uncertainFields,[])});
test('fallback account is uncertain',()=>{const x=chooseAccount([{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}],undefined,'449');assert.deepEqual(x.uncertainFields,['accountCode'])});
test('bank and liability accounts excluded',()=>{const x=chooseAccount([{code:'001',name:'Bank',type:'BANK',status:'ACTIVE'},{code:'449',name:'Expenses',type:'EXPENSE',status:'ACTIVE'}]);assert.equal(x.value.code,'449')});
