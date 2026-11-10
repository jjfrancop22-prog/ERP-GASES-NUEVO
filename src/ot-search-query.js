import {collection,query,where,limit,getDocs,doc,getDoc,startAfter} from 'firebase/firestore';
import {normalizeSearch} from '../tools/search-index-core.mjs';

/** Búsqueda parcial paginada sobre índices históricos. No interpreta resultados
 * incompletos como ausencia de OT: devuelve limited para activar respaldo. */
export async function searchIndexedOT(db,term,{status=null,series='all',max=500,chunk=100}={}){
 const needle=normalizeSearch(term);
 const words=needle.match(/[A-Z0-9]+/g)||[];
 if(words.length!==1||words[0].length<3)return {rows:[],unsupported:true,reads:0,limited:false};
 const gram=words[0].slice(0,3);
 const hits=[];let cursor=null,reads=0,limited=false;
 do {
  const clauses=[where('grams','array-contains',gram)];
  // Filtrar RR/RG EN FIRESTORE antes del límite global, no después.
  if(series!=='all')clauses.push(where('series','==',series));
  clauses.push(limit(Math.min(chunk,max+1-hits.length)));
  if(cursor)clauses.push(startAfter(cursor));
  const snap=await getDocs(query(collection(db,'otSearchIndex'),...clauses));
  reads+=snap.size;
  hits.push(...snap.docs);
  cursor=snap.docs.at(-1);
  if(snap.size<Math.min(chunk,max+1-(hits.length-snap.size)))break;
  if(hits.length>max){limited=true;break}
 }while(cursor);
 if(hits.length>max)limited=true;
 const candidates=hits.slice(0,max);
 const rows=[];let stale=false;
 // Consultar solamente las OT candidatas; evitar ráfagas ilimitadas de lecturas.
 for(let i=0;i<candidates.length;i+=25){
  const docs=await Promise.all(candidates.slice(i,i+25).map(s=>getDoc(doc(db,'ots',s.id))));
  reads+=docs.length;
  docs.forEach((s,j)=>{
   const idx=candidates[i+j].data();
   if(!s.exists()){stale=true;return}
   const r={id:s.id,...s.data()};
   if(idx.sourceVersion!==r.version){stale=true;return}
   if((!status||r.status===status)&&(series==='all'||(r.series||String(r.code||'').slice(0,2))===series)&&
      ['code','clientName','branchName','monitoring'].some(field=>normalizeSearch(r[field]).includes(needle)))rows.push(r);
  });
 }
 return {rows,unsupported:false,limited,stale,reads};
}
