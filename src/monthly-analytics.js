import {db} from './firebase.js';
import {collection,query,where,Timestamp,getAggregateFromServer,count,sum} from 'firebase/firestore';
const CACHE_KEY='psi-gases-monthly-analytics-v131';
const TTL=15*60*1000;
const key=(y,m)=>`${y}-${String(m).padStart(2,'0')}`;
/** Work dates are ISO YYYY-MM-DD strings; createdAt is a Firestore Timestamp.
 * Historical imports commonly receive a new createdAt at import time, so workDate
 * is the default operational reporting basis, never silently mixed with createdAt.
 */
export async function monthlyAnalytics(year,month,{force=false,basis='workDate'}={}){
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw Error('Mes inválido');
 if(!['workDate','createdAt'].includes(basis))throw Error('Fecha de referencia inválida');
 const period=key(year,month),cacheId=`${basis}:${period}`;
 if(!force){try{const cached=JSON.parse(sessionStorage.getItem(CACHE_KEY)||'{}')[cacheId];if(cached&&Date.now()-cached.at<TTL)return {...cached.value,cached:true}}catch{}}
 const start=basis==='createdAt'?Timestamp.fromDate(new Date(Date.UTC(year,month-1,1))):period+'-01';
 const end=basis==='createdAt'?Timestamp.fromDate(new Date(Date.UTC(year,month,1))):key(month===12?year+1:year,month===12?1:month+1)+'-01';
 const rows=await Promise.all(['RR','RG'].map(async series=>{
  const q=query(collection(db,'ots'),where('series','==',series),where(basis,'>=',start),where(basis,'<',end));
  let snapshot;
  try { snapshot=await getAggregateFromServer(q,{orders:count(),points:sum('points')}); }
  catch(error){ if(error?.code==='failed-precondition'){throw new Error(`Falta habilitar el índice compuesto de ots: series + ${basis} + points (ASC). Publíquelo desde firestore.indexes.json y espere a que esté habilitado.`)} throw error; }
  return {series,orders:Number(snapshot.data().orders||0),points:Number(snapshot.data().points||0)};
 }));
 const value={period,basis,rows,at:Date.now()};
 try{const store=JSON.parse(sessionStorage.getItem(CACHE_KEY)||'{}');store[cacheId]={value,at:Date.now()};sessionStorage.setItem(CACHE_KEY,JSON.stringify(store))}catch{}
 return value;
}
