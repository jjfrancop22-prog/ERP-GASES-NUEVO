/**
 * V1.0.0.79: preparación de índice de búsqueda de OT, sin activar consultas.
 * Por defecto SOLO LECTURA. --apply escribe exclusivamente en otSearchIndex/{otId}.
 * No modifica ots, contadores ni reglas. No ejecutar --apply sin respaldo y autorización.
 */
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getFirestore,FieldPath} from 'firebase-admin/firestore';
const args=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith('--')&&x.includes('=')).map(x=>x.slice(2).split(/=(.*)/s).slice(0,2)));
const apply=process.argv.includes('--apply');
if(!args.project||!/^[a-z0-9-]+$/.test(args.project))throw Error('Se requiere --project=ID');
if(apply&&!process.argv.includes('--confirm-backup'))throw Error('Para escribir se requiere --apply --confirm-backup. Haga respaldo primero.');
const max=Math.min(100000,Math.max(1,Number(args.limit)||500));
initializeApp({credential:applicationDefault(),projectId:args.project});
const db=getFirestore();
const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
const trigrams=s=>{const out=new Set();for(const word of norm(s).match(/[A-Z0-9]+/g)||[]){if(word.length<3)continue;for(let i=0;i<=word.length-3;i++)out.add(word.slice(i,i+3));}return [...out].sort()};
let cursor=null,scanned=0,written=0,missing=0,oversized=0;
while(scanned<max){
 const size=Math.min(150,max-scanned);
 let q=db.collection('ots').orderBy(FieldPath.documentId()).limit(size);
 if(cursor)q=q.startAfter(cursor);
 const snap=await q.get();if(snap.empty)break;
 const batch=db.batch();let pending=0;
 for(const d of snap.docs){
  scanned++;const ot=d.data();
  const fields=['code','clientName','branchName','monitoring'];
  if(fields.some(k=>!ot[k]))missing++;
  const text=fields.map(k=>norm(ot[k])).join(' ');
  const grams=trigrams(text);
  if(grams.length>1000){oversized++;continue}
  if(apply){batch.set(db.collection('otSearchIndex').doc(d.id),{
   otId:d.id,code:ot.code||'',series:ot.series||String(ot.code||'').slice(0,2),status:ot.status||'',
   grams,sourceVersion:ot.version||0,sourceUpdatedAt:ot.updatedAt||null,indexVersion:1,
   indexedAt:new Date()
  });pending++}
 }
 if(apply&&pending){await batch.commit();written+=pending}
 cursor=snap.docs.at(-1);if(snap.size<size)break;
 console.log(`Procesadas ${scanned}; indexadas ${written}; modo ${apply?'ESCRITURA':'SIMULACION'}`);
}
console.log(JSON.stringify({project:args.project,mode:apply?'APPLY':'DRY_RUN',scanned,written,missingFields:missing,oversized,limit:max,complete:scanned<max,warning:'Índice auxiliar NO ACTIVADO en ERP. No hay sincronización automática de cambios todavía. No usar para búsquedas hasta implementar actualizaciones transaccionales y reglas.'},null,2));
