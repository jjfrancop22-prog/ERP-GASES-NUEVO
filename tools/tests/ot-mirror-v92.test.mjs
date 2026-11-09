import test from 'node:test';
import assert from 'node:assert/strict';
import {createOTMirror} from '../../src/ot-search-transaction-core.mjs';
import {indexPayload} from '../search-index-core.mjs';
const ref=(collection,id)=>({id,path:`${collection}/${id}`,parent:{id:collection}});
function setup(existing={}){
 const writes=[];
 const tx={async get(r){const v=existing[r.path];return {exists:()=>v!==undefined,data:()=>v}},set(r,v){writes.push({type:'set',path:r.path,value:v});return this},update(r,v){writes.push({type:'update',path:r.path,value:v});return this},delete(r){writes.push({type:'delete',path:r.path});return this}};
 return {t:createOTMirror(tx,id=>ref('otSearchIndex',id),indexPayload),writes};
}
test('batch publication: reads all first, then mirrors two OTs',async()=>{
 const a=ref('ots','a'),b=ref('ots','b');
 const {t,writes}=setup({'ots/a':{code:'RR260001',status:'AUTORIZADO',version:2},'ots/b':{code:'RG260002',status:'AUTORIZADO',version:3}});
 await t.get(a);await t.get(b);
 t.update(a,{status:'PUBLICADO',version:3});t.update(b,{status:'PUBLICADO',version:4});
 assert.equal(writes.length,4);
 assert.deepEqual(writes.map(x=>x.path),['ots/a','otSearchIndex/a','ots/b','otSearchIndex/b']);
 assert.equal(writes[1].value.status,'PUBLICADO');assert.equal(writes[3].value.sourceVersion,4);
});
test('batch update: missing prior read is rejected',async()=>{
 const a=ref('ots','a'),b=ref('ots','b');const {t,writes}=setup({'ots/a':{code:'RR1'}});
 await t.get(a);t.update(a,{status:'LABORATORIO'});
 assert.throws(()=>t.update(b,{status:'LABORATORIO'}),/lectura previa/);
 assert.equal(writes.length,2); // A real Firestore transaction callback throws: neither staged write commits.
});
test('nested patch preserves other source fields',async()=>{
 const a=ref('ots','a');const {t,writes}=setup({'ots/a':{code:'RR1',clientName:'Cliente Antiguo',laboratory:{receivedAt:'2026-11-01'},version:2}});
 await t.get(a);t.update(a,{'laboratory.receivedAt':'2026-11-08',clientName:'Cliente Nuevo'});
 assert.ok(writes[1].value.grams.includes('NUE'));
});
test('non-OT collection is not mirrored',()=>{
 const {t,writes}=setup();t.update(ref('summaries','overview'),{count:3});
 assert.equal(writes.length,1);assert.equal(writes[0].path,'summaries/overview');
});
test('multiple writes to same OT blocked in batch',async()=>{
 const a=ref('ots','a');const {t,writes}=setup({'ots/a':{code:'RR1'}});
 await t.get(a);t.update(a,{status:'LABORATORIO'});
 assert.throws(()=>t.update(a,{status:'PUBLICADO'}),/múltiples escrituras/);
 assert.equal(writes.length,2);
});
