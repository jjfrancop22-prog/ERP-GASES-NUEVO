/** Canonical search-index schema v2. Shared by migration and verification.
 * No Firebase imports; deterministic and safe to test offline.
 */
export const INDEX_VERSION = 2;
export const SEARCH_FIELDS = ['code','clientName','branchName','monitoring'];
export function normalizeSearch(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim()}
export function searchGrams(ot){
 const terms=new Set();
 for(const field of SEARCH_FIELDS){
  for(const word of (normalizeSearch(ot[field]).match(/[A-Z0-9]+/g)||[])){
   if(word.length<3)continue;
   for(let i=0;i<=word.length-3;i++)terms.add(word.slice(i,i+3));
  }
 }
 return [...terms].sort();
}
export function indexPayload(id,ot){
 const grams=searchGrams(ot);
 if(grams.length>1000)throw Error(`OT ${id}: supera 1000 fragmentos`);
 return {otId:id,code:ot.code||'',series:ot.series||String(ot.code||'').slice(0,2),status:ot.status||'',grams,sourceVersion:ot.version||0,indexVersion:INDEX_VERSION};
}
export function matchesIndex(id,ot,index){
 if(!index)return false;
 const expected=indexPayload(id,ot);
 return Object.entries(expected).every(([key,value])=>JSON.stringify(value)===JSON.stringify(index[key]));
}
