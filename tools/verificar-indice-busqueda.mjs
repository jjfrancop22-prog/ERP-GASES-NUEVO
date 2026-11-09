/** V1.0.0.82: verificación de cobertura del índice auxiliar. SOLO LECTURA.
 * Uso: GOOGLE_APPLICATION_CREDENTIALS=... node tools/verificar-indice-busqueda.mjs --project=nuevo-erp-gases --limit=500
 * Nunca escribe, modifica o elimina datos.
 */
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getFirestore,FieldPath} from 'firebase-admin/firestore';
const opts=Object.fromEntries(process.argv.slice(2).filter(a=>a.startsWith('--')&&a.includes('=')).map(a=>a.slice(2).split(/=(.*)/s).slice(0,2)));
if(!opts.project||!/^[a-z0-9-]+$/.test(opts.project))throw Error('Especifique --project=ID');
const max=Number(opts.limit||500);
if(!Number.isSafeInteger(max)||max<1||max>100000)throw Error('--limit debe estar entre 1 y 100000');
initializeApp({credential:applicationDefault(),projectId:opts.project});
const db=getFirestore();
const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
const grams=s=>{const out=new Set();for(const word of norm(s).match(/[A-Z0-9]+/g)||[])for(let i=0;i<=word.length-3;i++)out.add(word.slice(i,i+3));return [...out].sort()};
let cursor=null,checked=0,missing=0,stale=0,correct=0,oversized=0;
const samples=[];
while(checked<max){
 let q=db.collection('ots').orderBy(FieldPath.documentId()).limit(Math.min(100,max-checked));
 if(cursor)q=q.startAfter(cursor);
 const page=await q.get();if(page.empty)break;
 const refs=page.docs.map(d=>db.collection('otSearchIndex').doc(d.id));
 const indexed=await db.getAll(...refs);
 for(let i=0;i<page.docs.length;i++){
  const d=page.docs[i],ot=d.data(),idx=indexed[i];checked++;
  if(!idx.exists){missing++;if(samples.length<20)samples.push({otId:d.id,issue:'MISSING'});continue}
  const expected=grams(['code','clientName','branchName','monitoring'].map(k=>ot[k]).join(' '));
  if(expected.length>1000){oversized++;continue}
  const actual=idx.data();
  if(actual.indexVersion!==1||actual.otId!==d.id||actual.code!==(ot.code||'')||actual.status!==(ot.status||'')||JSON.stringify(actual.grams)!==JSON.stringify(expected)){
   stale++;if(samples.length<20)samples.push({otId:d.id,issue:'STALE'});
  }else correct++;
 }
 cursor=page.docs.at(-1);if(page.size<100)break;
}
console.log(JSON.stringify({project:opts.project,checked,correct,missing,stale,oversized,samples,coveragePercent:checked?Number((100*correct/checked).toFixed(2)):0,complete:checked<max,readOnly:true,warning:'No activar búsqueda exclusiva por índice mientras falten documentos o no exista sincronización transaccional de altas/ediciones/cambios de etapa.'},null,2));
if(missing||stale||oversized)process.exitCode=2;
