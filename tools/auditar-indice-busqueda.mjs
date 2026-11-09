/**
 * V1.0.0.78 - Auditoría de preparación del índice de búsqueda.
 * SOLO LECTURA. No migra ni modifica documentos.
 * Requiere: npm install --no-save firebase-admin
 * Credenciales: GOOGLE_APPLICATION_CREDENTIALS=/ruta/credenciales.json
 * Ejecución: node tools/auditar-indice-busqueda.mjs --project=ID --limit=500
 */
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getFirestore,FieldPath} from 'firebase-admin/firestore';
const args=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--')&&x.includes('=')).map(x=>x.slice(2).split(/=(.*)/s).slice(0,2)));
if(!args.project || !/^[a-z0-9-]+$/.test(args.project))throw Error('Especifique --project=ID_DEL_PROYECTO');
const max=Math.min(10000,Math.max(1,Number(args.limit)||500));
initializeApp({credential:applicationDefault(),projectId:args.project});
const db=getFirestore();let cursor=null,seen=0,missing=0,invalid=0,byStatus={};
const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
const tokenize=v=>[...new Set((norm(v).match(/[A-Z0-9]+/g)||[]).flatMap(w=>w.length>=3?Array.from({length:w.length-2},(_,i)=>w.slice(i,i+3)):[w]))];
while(seen<max){
 const size=Math.min(200,max-seen);let q=db.collection('ots').orderBy(FieldPath.documentId()).limit(size);
 if(cursor)q=q.startAfter(cursor);
 const snap=await q.get();if(snap.empty)break;
 for(const doc of snap.docs){const d=doc.data();seen++;byStatus[d.status||'(sin estado)']=(byStatus[d.status||'(sin estado)']||0)+1;
  const keys=['code','clientName','branchName','monitoring'];if(keys.some(k=>!d[k]))missing++;
  const tokens=tokenize(keys.map(k=>d[k]).join(' '));if(tokens.length>1000)invalid++;
 }
 cursor=snap.docs.at(-1);if(snap.size<size)break;
}
console.log(JSON.stringify({project:args.project,documentsAudited:seen,limit:max,missingSearchFields:missing,over1000Trigrams:invalid,byStatus,mode:'READ_ONLY',warning:'Muestra limitada; no representa necesariamente toda la colección. No se creó ni activó índice.'},null,2));
