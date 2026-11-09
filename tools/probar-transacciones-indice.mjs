import assert from 'node:assert/strict';
import {createOTMirror} from '../src/ot-search-transaction-core.mjs';
import {indexPayload} from './search-index-core.mjs';
const ot = id => ({id,path:`ots/${id}`,parent:{id:'ots'}});
const other = id => ({id,path:`clients/${id}`,parent:{id:'clients'}});
function scenario(initial = null) {
 const operations=[];
 const tx={async get(ref){return {exists:()=>initial!==null,data:()=>initial};},set(ref,payload){operations.push(['set',ref.path,payload]);return this;},update(ref,payload){operations.push(['update',ref.path,payload]);return this;},delete(ref){operations.push(['delete',ref.path]);return this;}};
 return {t:createOTMirror(tx,id=>({path:`otSearchIndex/${id}`}),indexPayload),operations};
}
const base={code:'RR260001',series:'RR',clientName:'Cliente Norte',branchName:'Sucursal Centro',monitoring:'Ruido',status:'PROGRAMADA',version:1};
{
 const {t,operations}=scenario(base); await t.get(ot('a'));
 t.update(ot('a'),{clientName:'Cliente Sur',version:2});
 assert.equal(operations.length,2);assert.equal(operations[0][1],'ots/a');assert.equal(operations[1][1],'otSearchIndex/a');
 assert.ok(operations[1][2].grams.includes('SUR'));assert.equal(operations[1][2].sourceVersion,2);
}
{
 const {t,operations}=scenario();t.set(ot('b'),base);
 assert.equal(operations.length,2);assert.equal(operations[1][2].code,'RR260001');
}
{
 const {t,operations}=scenario(base);
 assert.throws(()=>t.update(ot('c'),{status:'X'}),/lectura previa|requiere lectura previa/);
 assert.throws(()=>t.delete(ot('c')),/bloqueada/);
 assert.equal(operations.length,0);
}
{
 const {t,operations}=scenario(base);await t.get(ot('d'));
 assert.throws(()=>t.set(ot('d'),base,{merge:true}),/merge/);
 assert.equal(operations.length,0);
}
{
 const {t,operations}=scenario(base);t.update(other('x'),{name:'X'});
 assert.equal(operations.length,1);
}
console.log('OK: 5 escenarios de transacción de índice superados (simulación local).');
