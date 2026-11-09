import test from 'node:test';
import assert from 'node:assert/strict';
import {createOTMirror} from '../../src/ot-search-transaction-core.mjs';
import {indexPayload} from '../search-index-core.mjs';
const ot={id:'ot1',path:'ots/ot1',parent:{id:'ots'}};
const other={id:'audit1',path:'otAudit/audit1',parent:{id:'otAudit'}};
function fixture(existing=null){
 const writes=[];
 const transaction={async get(ref){return {exists:()=>existing!==null,data:()=>existing}},set(ref,value){writes.push({op:'set',ref,value});return this},update(ref,value){writes.push({op:'update',ref,value});return this},delete(ref){writes.push({op:'delete',ref});return this}};
 return {t:createOTMirror(transaction,id=>({id,path:`otSearchIndex/${id}`,parent:{id:'otSearchIndex'}}),indexPayload),writes};
}
test('new OT full set writes source and index atomically in staging',()=>{const {t,writes}=fixture();t.set(ot,{code:'RR260001',clientName:'Cliente Uno',version:1});assert.equal(writes.length,2);assert.equal(writes[1].ref.path,'otSearchIndex/ot1');assert.ok(writes[1].value.grams.includes('CLI'));});
test('update without prior read is rejected without writes',()=>{const {t,writes}=fixture();assert.throws(()=>t.update(ot,{clientName:'Nuevo'}),/lectura previa/);assert.equal(writes.length,0);});
test('update with prior read recomputes index',async()=>{const {t,writes}=fixture({code:'RG260002',clientName:'Viejo',version:1});await t.get(ot);t.update(ot,{clientName:'Nuevo',version:2});assert.equal(writes.length,2);assert.ok(writes[1].value.grams.includes('NUE'));assert.equal(writes[1].value.sourceVersion,2);});
test('duplicate OT writes rejected',()=>{const {t,writes}=fixture();t.set(ot,{code:'RR260001'});assert.throws(()=>t.set(ot,{code:'RR260002'}),/múltiples escrituras/);assert.equal(writes.length,2);});
test('merge and deletion blocked',()=>{const {t,writes}=fixture();assert.throws(()=>t.set(ot,{code:'RR260001'},{merge:true}),/merge/);assert.throws(()=>t.delete(ot),/Eliminación/);assert.equal(writes.length,0);});
test('unrelated audit writes pass through unchanged',()=>{const {t,writes}=fixture();t.set(other,{action:'UPDATE'});assert.equal(writes.length,1);});
