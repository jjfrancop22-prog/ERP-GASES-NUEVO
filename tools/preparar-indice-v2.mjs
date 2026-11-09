/** Phase 3: admin-only, resumable, dry-run by default. Writes ONLY auxiliary index.
 * Requires firebase-admin installed separately and GOOGLE_APPLICATION_CREDENTIALS.
 * Never activates search in ERP; do not use --apply against production until approved.
 */
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getFirestore,FieldPath} from 'firebase-admin/firestore';
import {indexPayload,matchesIndex} from './search-index-core.mjs';
const argv=process.argv.slice(2);
const arg=k=>argv.find(x=>x.startsWith(`--${k}=`))?.slice(k.length+3);
const project=arg('project');
if(!project||!/^[a-z0-9-]+$/.test(project))throw Error('Indique --project=ID');
const limit=Number(arg('limit')||500);
if(!Number.isSafeInteger(limit)||limit<1||limit>100000)throw Error('--limit debe ser 1..100000');
const apply=argv.includes('--apply');
if(apply&&(!argv.includes('--confirm-backup')||arg('confirm-project')!==project))throw Error('Escritura bloqueada: requiere --confirm-backup --confirm-project=ID');
initializeApp({credential:applicationDefault(),projectId:project});
const db=getFirestore();
let cursor=arg('after')||null,scanned=0,missing=0,stale=0,unchanged=0,written=0,oversized=0;
while(scanned<limit){
 let q=db.collection('ots').orderBy(FieldPath.documentId()).limit(Math.min(100,limit-scanned));
 if(cursor)q=q.startAfter(cursor);
 const page=await q.get();if(page.empty)break;
 const refs=page.docs.map(d=>db.collection('otSearchIndex').doc(d.id));
 const existing=await db.getAll(...refs);
 const batch=db.batch();let queued=0;
 for(let i=0;i<page.docs.length;i++){
  const ot=page.docs[i].data(),id=page.docs[i].id;scanned++;
  try{
   const payload=indexPayload(id,ot);
   if(matchesIndex(id,ot,existing[i].exists?existing[i].data():null)){unchanged++;continue}
   if(existing[i].exists)stale++;else missing++;
   if(apply){batch.set(refs[i],{...payload,sourceUpdatedAt:ot.updatedAt||null,indexedAt:new Date()});queued++}
  }catch(e){oversized++;console.error(e.message)}
 }
 if(apply&&queued){await batch.commit();written+=queued}
 cursor=page.docs.at(-1).id;
 console.log(`Revisadas ${scanned}; faltantes ${missing}; desactualizadas ${stale}; escritas ${written}; cursor ${cursor}`);
 if(page.size<100)break;
}
console.log(JSON.stringify({project,mode:apply?'APPLY':'DRY_RUN',scanned,missing,stale,unchanged,written,oversized,lastCursor:cursor,limitReached:scanned===limit,warning:'No activar la búsqueda indexada hasta integrar actualizaciones automáticas y verificar cobertura total.'},null,2));
if(oversized)process.exitCode=2;
