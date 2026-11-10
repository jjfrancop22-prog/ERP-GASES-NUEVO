import {readExportCache,writeExportCache} from './billing-export-cache.js';
import {db,auth} from './firebase.js';
import {mirrorTransaction,OT_SEARCH_MIRROR_ENABLED} from './ot-search-transaction.js';
import {searchIndexedOT} from './ot-search-query.js';
import {indexPayload,matchesIndex} from '../tools/search-index-core.mjs';
import {collection,doc,getDoc,getDocFromServer,getDocs,query,orderBy,limit,startAfter,startAt,endAt,addDoc,serverTimestamp,runTransaction as firestoreRunTransaction,where,getCountFromServer,onSnapshot,documentId,writeBatch,getDocsFromServer,setDoc} from 'firebase/firestore';
// Feature flag off by default: existing Firestore behavior is unchanged.
// V1.0.0.99: sincronización auxiliar para TODOS los roles operativos autorizados.
// La OT se confirma primero; un fallo auxiliar nunca revierte el commit principal.
// La búsqueda conserva respaldo histórico ante índices obsoletos.
// Cola local persistente: recupera fallos auxiliares tras recargar o reconectar.
// No reemplaza un trigger de servidor: requiere que un usuario autorizado vuelva a abrir la app.
const INDEX_REPAIR_KEY='psi-gases-ot-index-repair-v102';
function pendingRepairs(){try{return JSON.parse(localStorage.getItem(INDEX_REPAIR_KEY)||'[]').filter(x=>typeof x==='string').slice(0,500)}catch{return []}}
function markRepair(id){try{localStorage.setItem(INDEX_REPAIR_KEY,JSON.stringify([...new Set([...pendingRepairs(),id])].slice(-500)))}catch{}}
function clearRepair(id){try{localStorage.setItem(INDEX_REPAIR_KEY,JSON.stringify(pendingRepairs().filter(x=>x!==id)))}catch{}}
async function repairIndex(database,id){
 const otRef=doc(database,'ots',id),idxRef=doc(database,'otSearchIndex',id);
 await firestoreRunTransaction(database,async tx=>{
  const [source,old]=await Promise.all([tx.get(otRef),tx.get(idxRef)]);
  if(!source.exists())return;
  const ot=source.data(),payload=indexPayload(id,ot);
  if(!old.exists()||!matchesIndex(id,ot,old.data()))tx.set(idxRef,payload);
 });
 clearRepair(id);
}
let repairing=false;
export async function retryPendingOTIndexes(){
 if(repairing||!navigator.onLine||!auth.currentUser)return;
 repairing=true;
 try{
  const p=await profile(auth.currentUser.uid);
  if(!p?.active||!['ADMINISTRADOR','OPERACIONES'].includes(p.role))return;
  for(const id of pendingRepairs())try{await repairIndex(db,id)}catch(e){console.warn('Reparación de índice pendiente:',id,e)}
 }finally{repairing=false}
}
// La confirmación de la OT nunca espera la escritura auxiliar del índice.
// Solo se encola la reparación después de confirmar la transacción principal.
function runTransaction(database,callback){
 const touched=new Set();
 return firestoreRunTransaction(database,t=>{
  const wrapped=OT_SEARCH_MIRROR_ENABLED?mirrorTransaction(t,database):t;
  const tracked=new Proxy(wrapped,{get(target,key){
   if(['set','update','delete'].includes(key))return (ref,...args)=>{
    if(ref?.parent?.id==='ots')touched.add(ref.id);
    return target[key](ref,...args);
   };
   const v=target[key];return typeof v==='function'?v.bind(target):v;
  }});
  return callback(tracked);
 }).then(result=>{
  // El commit ya fue confirmado por Firestore: devolver éxito inmediatamente.
  for(const id of touched)markRepair(id);
  if(touched.size){
   // Sin bloquear la interfaz ni el siguiente registro.
   setTimeout(()=>{retryPendingOTIndexes().catch(err=>console.warn('Índices pendientes:',err));},0);
  }
  return result;
 });
}

export const pageSize=10;
export async function profile(uid){const s=await getDocFromServer(doc(db,'users',uid));return s.exists()?s.data():null}
export async function page(coll,cursor=null,filter=null,size=pageSize){let constraints=[];if(filter)constraints.push(where(filter.field,Array.isArray(filter.value)?'in':'==',filter.value));constraints.push(orderBy('createdAt','desc'),limit(size));if(cursor)constraints.push(startAfter(cursor));const s=await getDocs(query(collection(db,coll),...constraints));return {rows:s.docs.map(d=>({id:d.id,...d.data()})),cursor:s.docs.at(-1)||null,more:s.docs.length===size}}
const summaryRef=()=>doc(db,'summaries','overview');
function requireCounters(snapshot){if(!snapshot.exists()||snapshot.data().initialized!==true)throw new Error('Contadores sin inicializar. Un administrador debe ejecutar la inicialización segura antes de registrar datos.');return snapshot.data()}
// Un único documento de resumen; la escritura se confirma en la misma transacción que la OT.
export async function createOT(data,user,requestId=crypto.randomUUID()){
 if(!navigator.onLine)throw new Error('Sin conexión: no se puede confirmar la OT.');
 const auto=data.sequenceYear===2026;
 if(!['RR','RG'].includes(data.series))throw new Error('Identificación inválida.');
 const sequenceRef=doc(db,'otSequences',`${data.series}_2026`);
 const otRef=doc(collection(db,'ots'));
 let confirmedCode='';
 await runTransaction(db,async t=>{
  const [summary,seqSnap]=await Promise.all([t.get(summaryRef()),auto?t.get(sequenceRef):Promise.resolve(null)]);
  const previous=requireCounters(summary);
  const n=auto?(seqSnap.exists()?seqSnap.data().last:0)+1:Number(data.sequence);
  if(!Number.isInteger(n)||n<1||n>9999)throw new Error('Correlativo fuera del rango 0001–9999.');
  const code=`${data.series}${String(data.sequenceYear).slice(-2)}${String(n).padStart(4,'0')}`;
  const key=doc(db,'otCodes',code);
  const existing=await t.get(key);
  if(existing.exists())throw new Error('Este código de OT ya existe. Revise la numeración antes de continuar.');
  const status=data.workDate?'PROGRAMADA':'REGISTRADA';
  if(auto)t.set(sequenceRef,{series:data.series,year:2026,last:n,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(key,{otId:otRef.id,requestId,createdBy:user.uid,createdAt:serverTimestamp()});
  t.set(otRef,{...data,sequence:n,code,status,followUp:data.workDate?'OT_PROGRAMADA':'OT_POR_PROGRAMAR',sampledAt:'',receptionOTAt:null,version:1,createdAt:serverTimestamp(),updatedAt:serverTimestamp(),createdBy:user.uid,updatedBy:user.uid});
  t.update(summaryRef(),{counts:{...previous.counts,ots:previous.counts.ots+1},lastMutation:{type:'OT_CREATE',id:otRef.id},updatedAt:serverTimestamp()});
  confirmedCode=code;
 });
 return {id:otRef.id,code:confirmedCode};
}
// Vista previa orientativa; la transacción createOT asigna el correlativo definitivo.
export async function nextOTSequence(series,year){
 if(year!==2026||!['RR','RG'].includes(series))return null;
 const snap=await getDocFromServer(doc(db,'otSequences',`${series}_2026`));
 const last=snap.exists()?Number(snap.data().last):0;
 if(!Number.isInteger(last)||last<0||last>=9999)throw new Error('Contador RR/RG inválido o agotado.');
 return last+1;
}
const DEFAULT_RESPONSIBLES=['JOSÉ NÚÑEZ','JOSÉ VÁSQUEZ','CHRISTINY PÉREZ'];
const responsibleKey=name=>String(name||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ');
export async function listRegistrationResponsibles(){
 const snap=await getDocFromServer(doc(db,'settings','registrationResponsibles'));
 return [...new Map([...DEFAULT_RESPONSIBLES,...(snap.exists()?snap.data().names||[]:[])].map(n=>[responsibleKey(n),n])).values()].sort((a,b)=>a.localeCompare(b,'es'));
}
export async function addRegistrationResponsible(name,user){
 if(!navigator.onLine)throw new Error('Sin conexión.');
 name=String(name||'').trim().replace(/\s+/g,' ').toUpperCase();
 if(!name||name.length>120)throw new Error('Ingrese un nombre válido (máximo 120 caracteres).');
 const ref=doc(db,'settings','registrationResponsibles');
 await runTransaction(db,async t=>{
  const snap=await t.get(ref);const names=snap.exists()?snap.data().names||[]:[];
  if([...DEFAULT_RESPONSIBLES,...names].some(n=>responsibleKey(n)===responsibleKey(name)))throw new Error('El responsable ya existe.');
  if(names.length>=150)throw new Error('Límite de responsables alcanzado.');
  t.set(ref,{names:[...names,name],updatedBy:user.uid,updatedAt:serverTimestamp()});
 });
 return name;
}
export async function updateOT(id,patch,expectedVersion,user,requestId=crypto.randomUUID()){
 if(Object.keys(patch).some(k=>!['monitoring','monitoringId','clientName','clientId','branchName','branchId','type','points','workDate','registeredBy','observations'].includes(k)))throw new Error('Campo no editable.');
 if(!patch.monitoringId||!patch.clientId||!patch.branchId)throw new Error('Debe seleccionar monitoreo, cliente y sucursal del catálogo.');
 if(!Number.isInteger(patch.points)||patch.points<1||patch.points>100)throw new Error('Número de puntos inválido.');
 if(String(patch.observations||'').length>1500)throw new Error('Observaciones demasiado extensas.');
 if(!navigator.onLine)throw new Error('Sin conexión: no se puede confirmar la operación.');
 await runTransaction(db,async t=>{
  const r=doc(db,'ots',id),monitorRef=doc(db,'monitoringCatalog',patch.monitoringId),clientRef=doc(db,'clients',patch.clientId);
  const [s,ms,cs]=await Promise.all([t.get(r),t.get(monitorRef),t.get(clientRef)]);
  if(!s.exists())throw new Error('La OT ya no existe');
  const old=s.data();
  if(old.lastRequestId===requestId&&old.updatedBy===user.uid)return;
  if(old.version!==expectedVersion)throw new Error('La OT ya cambió desde otra computadora.');
  if(!['REGISTRADA','PROGRAMADA'].includes(old.status))throw new Error('No se puede modificar una OT ya recibida en laboratorio.');
  const monitor=ms.data(),client=cs.data();
  if(!ms.exists()||monitor.active===false||monitor.series!==old.series||monitor.name!==patch.monitoring||monitor.type!==patch.type)throw new Error('Monitoreo incompatible con la identificación original.');
  if(!cs.exists()||client.active===false||client.name!==patch.clientName||!(client.branches||[]).some(b=>b.id===patch.branchId&&b.name===patch.branchName&&b.active!==false))throw new Error('Cliente o sucursal no válidos.');
  const workDate=patch.workDate!==undefined?String(patch.workDate):String(old.workDate||'');
  if(workDate&&!/^\d{4}-\d{2}-\d{2}$/.test(workDate))throw new Error('Fecha de inicio inválida.');
  const status=workDate?'PROGRAMADA':'REGISTRADA';
  t.update(r,{...patch,status,followUp:workDate?'OT_PROGRAMADA':'OT_POR_PROGRAMAR',version:expectedVersion+1,lastRequestId:requestId,updatedAt:serverTimestamp(),updatedBy:user.uid});
 });
}
// Guardado único de OT históricas y nuevas, con catálogo RG/RR y auditoría.
export async function saveOTControlled(id,expectedVersion,patch,reason,user){
 if(!navigator.onLine)throw Error('Sin conexión: guardado bloqueado.');
 if(!patch.clientId||!patch.branchId||!patch.monitoringId)throw Error('Seleccione monitoreo, cliente y sucursal del catálogo.');
 if(!Number.isInteger(patch.points)||patch.points<1||patch.points>100)throw Error('Número de puntos inválido.');
 if(String(patch.observations||'').length>1500)throw Error('Observaciones demasiado extensas.');
 if(patch.workDate&&!/^\d{4}-\d{2}-\d{2}$/.test(patch.workDate))throw Error('Fecha inválida.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id);
  const snap=await t.get(ref);
  if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.version!==expectedVersion)throw Error('La OT fue modificada desde otra computadora. Actualice la vista.');
  if(!['REGISTRADA','PROGRAMADA'].includes(old.status))throw Error('Solo se pueden editar OT que no estén enviadas al laboratorio.');
  const series=old.series||String(old.code||'').slice(0,2);
  const monitoringChanged=old.monitoringId!==patch.monitoringId||old.monitoring!==patch.monitoring||old.type!==patch.type;
  const clientChanged=old.clientId!==patch.clientId||old.clientName!==patch.clientName;
  const branchChanged=clientChanged||old.branchId!==patch.branchId||old.branchName!==patch.branchName;
  // Solo consultar los catálogos que realmente se modifican.
  const mr=monitoringChanged?doc(db,'monitoringCatalog',patch.monitoringId):null;
  const cr=branchChanged?doc(db,'clients',patch.clientId):null;
  const ms=mr?await t.get(mr):null;
  const cs=cr?await t.get(cr):null;
  if(monitoringChanged){const m=ms?.data();if(!['RG','RR'].includes(series)||!ms.exists()||m.active===false||m.series!==series||m.name!==patch.monitoring||m.type!==patch.type)throw Error('Seleccione un monitoreo activo de la identificación '+series+'.');}
  if(branchChanged){const c=cs?.data();if(!cs.exists()||c.active===false||c.name!==patch.clientName||!(c.branches||[]).some(b=>b.id===patch.branchId&&b.name===patch.branchName&&b.active!==false))throw Error('Cliente o sucursal no válidos.');}
  // Conservar valores históricos intactos; normalizar solo cuando se selecciona
  // realmente un monitoreo nuevo. No reescribir campos sin cambios.
  const fields=['monitoring','monitoringId','type','clientId','clientName','branchId','branchName','points','workDate','registeredBy','observations'];
  if(!monitoringChanged && String(old.type||'').toUpperCase()===String(patch.type||'').toUpperCase())patch={...patch,type:old.type};
  const changes={},delta={};
  for(const k of fields)if((old[k]??'')!==(patch[k]??'')){
   changes[k]={before:old[k]??null,after:patch[k]??null};delta[k]=patch[k];
  }
  if(!Object.keys(changes).length)throw Error('No hay cambios para guardar.');
  if(String(reason||'').trim().length<10||String(reason||'').trim().length>500)throw Error('Ingrese un motivo entre 10 y 500 caracteres.');
  const finalDate=('workDate' in delta)?delta.workDate:old.workDate;
  const status=finalDate?'PROGRAMADA':'REGISTRADA';
  t.update(ref,{...delta,status,followUp:finalDate?'OT_PROGRAMADA':'OT_POR_PROGRAMAR',version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(doc(collection(db,'otLaboratoryAudit')),{otId:id,code:old.code,action:'EDICION_CONTROLADA_OT',changes,reason:String(reason).trim(),actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Rectificación de datos administrativos históricos sin revalidar el monitoreo antiguo.
export async function correctOTHistoricalDetails(id,expectedVersion,patch,reason,user){
 if(!navigator.onLine)throw Error('Sin conexión: rectificación bloqueada.');
 if(!Number.isInteger(patch.points)||patch.points<1||patch.points>100)throw Error('Número de puntos inválido.');
 if(String(reason||'').trim().length<10)throw Error('Indique un motivo de al menos 10 caracteres.');
 if(!patch.clientId||!patch.branchId)throw Error('Seleccione cliente y sucursal del catálogo.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),clientRef=doc(db,'clients',patch.clientId);
  const [snap,cs]=await Promise.all([t.get(ref),t.get(clientRef)]);
  if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.version!==expectedVersion)throw Error('La OT cambió en otra computadora. Actualice la vista.');
  if(!['REGISTRADA','PROGRAMADA'].includes(old.status))throw Error('La OT ya fue enviada a laboratorio.');
  const c=cs.data();
  if(!cs.exists()||c.active===false||c.name!==patch.clientName||!(c.branches||[]).some(b=>b.id===patch.branchId&&b.name===patch.branchName&&b.active!==false))throw Error('Cliente o sucursal no válidos.');
  const changes={};for(const key of ['clientId','clientName','branchId','branchName','points'])if(old[key]!==patch[key])changes[key]={before:old[key]??null,after:patch[key]};
  if(!Object.keys(changes).length)throw Error('No hay cambios en cliente, sucursal o puntos.');
  t.update(ref,{...patch,version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(doc(collection(db,'otLaboratoryAudit')),{otId:id,code:old.code,action:'RECTIFICAR_DATOS_HISTORICOS',changes,reason:String(reason).trim(),actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Rectificación aislada de fecha: no revalida catálogos históricos ni modifica monitoreo/cliente.
export async function correctOTWorkDate(id,expectedVersion,newDate,reason,user){
 if(!navigator.onLine)throw Error('Sin conexión: rectificación bloqueada.');
 if(newDate&&!/^\d{4}-\d{2}-\d{2}$/.test(newDate))throw Error('Fecha de inicio inválida.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),snap=await t.get(ref);
  if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.version!==expectedVersion)throw Error('La OT cambió en otra computadora. Actualice.');
  if(!['REGISTRADA','PROGRAMADA'].includes(old.status))throw Error('La fecha de inicio está protegida después del envío a laboratorio.');
  if(newDate===String(old.workDate||''))return;
  if(String(reason||'').trim().length<10)throw Error('Indique un motivo de al menos 10 caracteres para rectificar la fecha.');
  t.update(ref,{workDate:newDate,status:newDate?'PROGRAMADA':'REGISTRADA',followUp:newDate?'OT_PROGRAMADA':'OT_POR_PROGRAMAR',version:old.version+1,updatedBy:user.uid,updatedAt:serverTimestamp()});
  t.set(doc(collection(db,'otLaboratoryAudit')),{otId:id,code:old.code,action:'RECTIFICAR_FECHA_INICIO',previousDate:old.workDate||'',newDate,reason:String(reason).trim(),actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Solo la fecha propuesta, mientras la OT espera confirmación oficial de recepción.
export async function correctPendingReceptionDate(id,expectedVersion,newDate,reason,user){
 if(!navigator.onLine)throw Error('Sin conexión: rectificación bloqueada.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(newDate))throw Error('Indique una fecha válida.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),snap=await t.get(ref);
  if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.version!==expectedVersion||old.status!=='EN_LABORATORIO')throw Error('La OT ya cambió o fue recibida oficialmente. Actualice la vista.');
  if(!old.workDate||newDate<old.workDate)throw Error('La recepción no puede ser anterior al inicio del trabajo ('+(old.workDate||'sin fecha')+').');
  const previous=old.laboratory?.proposedReceivedAt||'';
  if(previous===newDate)return;
  if(String(reason||'').trim().length<10)throw Error('Indique un motivo de al menos 10 caracteres.');
  t.update(ref,{'laboratory.proposedReceivedAt':newDate,version:old.version+1,updatedBy:user.uid,updatedAt:serverTimestamp()});
  t.set(doc(collection(db,'otLaboratoryAudit')),{otId:id,code:old.code,action:'RECTIFICAR_RECEPCION_PROPUESTA',previousDate:previous,newDate,reason:String(reason).trim(),actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Anulación lógica: nunca borrar otCodes ni retroceder otSequences.
// Auditoría y cambio de estado en una única transacción atómica.
export async function voidOT(id,expectedVersion,reason,user){
 if(!navigator.onLine)throw new Error('Sin conexión: anulación bloqueada.');
 reason=String(reason||'').trim();if(reason.length<10||reason.length>500)throw new Error('Motivo obligatorio: entre 10 y 500 caracteres.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),audit=doc(collection(db,'otVoidAudit'));
  const [snap,profileSnap]=await Promise.all([t.get(ref),t.get(doc(db,'users',user.uid))]);
  if(!profileSnap.exists()||profileSnap.data().role!=='ADMINISTRADOR'||profileSnap.data().active!==true)throw new Error('Se requiere rol ADMINISTRADOR activo.');
  if(!snap.exists())throw new Error('OT no encontrada.');
  const old=snap.data();if(old.version!==expectedVersion)throw new Error('La OT fue modificada. Actualice la bandeja.');
  if(!['REGISTRADA','PROGRAMADA'].includes(old.status))throw new Error('No se puede anular una OT recibida en laboratorio.');
  t.update(ref,{status:'ANULADA',voidReason:reason,voidedAt:serverTimestamp(),voidedBy:user.uid,version:expectedVersion+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(audit,{otId:id,code:old.code,previousStatus:old.status,reason,actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Fase 1 de laboratorio: ingreso sobre la OT original, sin colecciones duplicadas.
// La transacción compara la versión y evita recepciones simultáneas.
export async function receiveLaboratory(id,expectedVersion,{analyst,receivedAt,service,notes},user){
 if(!navigator.onLine)throw Error('Sin conexión: ingreso no confirmado.');
 analyst=String(analyst||'').trim();notes=String(notes||'').trim();
 if(analyst!=='JOSE VASQUEZ')throw Error('Responsable permitido: JOSE VASQUEZ.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)||!Number.isFinite(Date.parse(receivedAt+'T12:00:00Z')))throw Error('Fecha de recepción inválida.');
 if(!['INTERNO','SUBCONTRATADO'].includes(service)||notes.length>1000)throw Error('Servicio u observaciones inválidos.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),audit=doc(collection(db,'otLaboratoryAudit')),snap=await t.get(ref);
  if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.version!==expectedVersion||old.status!=='EN_LABORATORIO')throw Error('La OT fue modificada o ya ingresó. Actualice la bandeja.');
  if(!old.workDate)throw Error('Complete primero la fecha de inicio de '+old.code+'.');
  if(receivedAt<old.workDate)throw Error('La fecha de recepción de '+old.code+' ('+receivedAt+') no puede ser anterior al inicio del trabajo ('+old.workDate+').');
  t.update(ref,{status:'INFORME_PENDIENTE',followUp:'OT_INGRESADA',sampledAt:receivedAt,receptionOTAt:serverTimestamp(),laboratory:{...old.laboratory,analyst,receivedAt,service,workingDays:service==='INTERNO'?8:15,deadline:labBusinessDeadline(receivedAt,service==='INTERNO'?8:15),notes,receivedBy:user.uid,receivedAtServer:serverTimestamp()},version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(audit,{otId:id,code:old.code,action:'CONFIRM_LAB',previousStatus:old.status,newStatus:'INFORME_PENDIENTE',receivedAt,actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Recepción múltiple atómica: valida todos los documentos antes de escribir alguno.
export async function receiveLaboratoryBatch(ids,{analyst,receivedAt,notes},user){
 if(!navigator.onLine)throw Error('Sin conexión.');
 if(!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length)throw Error('Seleccione entre 1 y 20 OT distintas.');
 if(analyst!=='JOSE VASQUEZ')throw Error('Responsable no permitido.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)||!Number.isFinite(Date.parse(receivedAt+'T12:00:00Z')))throw Error('Fecha inválida.');
 notes=String(notes||'').trim();if(notes.length>1000)throw Error('Observaciones demasiado extensas.');
 const deadline=labBusinessDeadline(receivedAt,8);
 await runTransaction(db,async t=>{
  const refs=ids.map(id=>doc(db,'ots',id));const snaps=[];for(const ref of refs)snaps.push(await t.get(ref));
  const records=snaps.map(s=>s.exists()?s.data():null);
  for(let i=0;i<records.length;i++){const ot=records[i];if(!ot||ot.status!=='EN_LABORATORIO')throw Error('OT '+(ot?.code||ids[i])+' ya no está pendiente de ingreso.');if(!ot.workDate)throw Error('Complete la fecha de inicio de '+ot.code+'.');if(receivedAt<ot.workDate)throw Error('La fecha de recepción ('+receivedAt+') es anterior al inicio del trabajo de '+ot.code+' ('+ot.workDate+'). No se confirmó ninguna OT.');if(ot.laboratory?.service==='SUBCONTRATADO')throw Error('OT '+ot.code+' es SUBCONTRATADA; ingrésela individualmente.');}
  for(let i=0;i<refs.length;i++){const ot=records[i];t.update(refs[i],{status:'INFORME_PENDIENTE',followUp:'OT_INGRESADA',sampledAt:receivedAt,receptionOTAt:serverTimestamp(),laboratory:{...ot.laboratory,analyst,receivedAt,service:'INTERNO',workingDays:8,deadline,notes,receivedBy:user.uid,receivedAtServer:serverTimestamp()},version:ot.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});const audit=doc(collection(db,'otLaboratoryAudit'));t.set(audit,{otId:ids[i],code:ot.code,action:'CONFIRM_LAB_BATCH',previousStatus:ot.status,newStatus:'INFORME_PENDIENTE',receivedAt,service:'INTERNO',deadline,actorId:user.uid,createdAt:serverTimestamp()})}
 });
}
// Entrega real: transición transaccional, auditable y sin duplicación de expedientes.
export async function deliverReport(id,expectedVersion,deliveryRealAt,user){
 if(!navigator.onLine)throw Error('Sin conexión: entrega no confirmada.');
 if(!validReportDate(deliveryRealAt))throw Error('Ingrese una fecha real de entrega válida.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),audit=doc(collection(db,'otReportAudit'));
  const snap=await t.get(ref);if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.version!==expectedVersion||old.status!=='INFORME_PENDIENTE')throw Error('La OT '+old.code+' cambió de estado. Actualice la vista.');
  if(!old.laboratory?.receivedAt)throw Error('La OT '+old.code+' no tiene recepción oficial.');
  t.update(ref,{status:'POR_AUTORIZAR',followUp:'INFORME_POR_AUTORIZAR',deliveryRealAt,report:{...(old.report||{}),deliveryRealAt,deliveredBy:user.uid,deliveredAtServer:serverTimestamp()},version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(audit,{otId:id,code:old.code,action:'REPORT_DELIVER',previousStatus:'INFORME_PENDIENTE',newStatus:'POR_AUTORIZAR',deliveryRealAt,actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Rectificación excepcional: retorna un informe a pendientes sin eliminar su entrega histórica.
export async function returnReportToPending(id,reason,user){
 if(!navigator.onLine)throw Error('Sin conexión. No se modificó la OT.');
 reason=String(reason||'').trim();
 if(reason.length<10||reason.length>500)throw Error('Ingrese un motivo de 10 a 500 caracteres.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),snap=await t.get(ref);
  if(!snap.exists())throw Error('OT no encontrada.');
  const old=snap.data();
  if(old.status!=='POR_AUTORIZAR')throw Error('La OT ya no está en informes por autorizar. Actualice la vista.');
  if(old.authorization?.state)throw Error('La OT ya tiene una decisión de autorización. Requiere revisión administrativa.');
  if(!old.deliveryRealAt)throw Error('No existe una entrega real que rectificar.');
  const audit=doc(collection(db,'otReportAudit'));
  t.update(ref,{status:'INFORME_PENDIENTE',followUp:'OT_INGRESADA',deliveryRealAt:null,report:{...(old.report||{}),deliveryRealAt:null,rectifiedAt:serverTimestamp(),rectifiedBy:user.uid},version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(audit,{otId:id,code:old.code,action:'REPORT_RETURN_TO_PENDING',previousStatus:'POR_AUTORIZAR',newStatus:'INFORME_PENDIENTE',previousDeliveryRealAt:old.deliveryRealAt,reason,actorId:user.uid,createdAt:serverTimestamp()});
 });
}
// Rectificación administrativa de autorización, sin borrar el historial.
export async function returnAuthorizedToAuthorization(id,reason,user){
 if(!navigator.onLine)throw Error('Sin conexión: no se modificó el informe.');
 reason=String(reason||'').trim();
 if(reason.length<10||reason.length>500)throw Error('Indique un motivo entre 10 y 500 caracteres.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),snap=await t.get(ref);
  if(!snap.exists())throw Error('OT no encontrada.');
  const old=snap.data();
  if(old.status!=='AUTORIZADO'||!['1','4'].includes(String(old.authorization?.state)))throw Error('La OT ya no está autorizada pendiente de portal. Actualice la vista.');
  if(old.portalPublishedAt||old.portal?.publishedAt)throw Error('El informe ya fue publicado. No se permite esta rectificación.');
  const audit=doc(collection(db,'otAuthorizationAudit'));
  t.update(ref,{status:'POR_AUTORIZAR',followUp:'INFORME_POR_AUTORIZAR',authorization:null,authorizationAt:null,version:(old.version||0)+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(audit,{otId:id,code:old.code,action:'AUTH_RETURN_TO_AUTHORIZATION',previousStatus:'AUTORIZADO',newStatus:'POR_AUTORIZAR',previousAuthorizationState:String(old.authorization.state),previousAuthorizationAt:old.authorizationAt||null,reason,actorId:user.uid,createdAt:serverTimestamp()});
 });
}
export async function deliverReportsBatch(ids,deliveryRealAt,user){
 if(!navigator.onLine)throw Error('Sin conexión: entrega no confirmada.');
 if(!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length)throw Error('Seleccione de 1 a 20 informes distintos.');
 if(!validReportDate(deliveryRealAt))throw Error('Ingrese una fecha real de entrega válida.');
 await runTransaction(db,async t=>{
  const refs=ids.map(id=>doc(db,'ots',id)),snaps=[];
  for(const ref of refs)snaps.push(await t.get(ref));
  const records=snaps.map(s=>s.exists()?s.data():null);
  for(let i=0;i<records.length;i++){
   const ot=records[i];if(!ot||ot.status!=='INFORME_PENDIENTE')throw Error('OT '+(ot?.code||ids[i])+' ya no está pendiente de informe.');
   if(!ot.laboratory?.receivedAt)throw Error('La OT '+ot.code+' no tiene recepción oficial.');
  }
  for(let i=0;i<refs.length;i++){
   const ot=records[i];t.update(refs[i],{status:'POR_AUTORIZAR',followUp:'INFORME_POR_AUTORIZAR',deliveryRealAt,report:{...(ot.report||{}),deliveryRealAt,deliveredBy:user.uid,deliveredAtServer:serverTimestamp()},version:ot.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
   t.set(doc(collection(db,'otReportAudit')),{otId:ids[i],code:ot.code,action:'REPORT_DELIVER_BATCH',previousStatus:'INFORME_PENDIENTE',newStatus:'POR_AUTORIZAR',deliveryRealAt,actorId:user.uid,createdAt:serverTimestamp()});
  }
 });
}
function validReportDate(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||'')))return false;const d=new Date(date+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===date}
function labBusinessDeadline(date,days){const d=new Date(date+'T12:00:00Z');let n=0;while(n<days){d.setUTCDate(d.getUTCDate()+1);if(d.getUTCDay()!==0&&d.getUTCDay()!==6)n++}return d.toISOString().slice(0,10)}
// Clientes con sucursales embebidas: una lectura por cliente, sin consultas N+1.
// El índice de nombre evita duplicados entre sesiones nuevas de esta versión.
const clientKey=name=>String(name||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ');
export async function addClient(name,user,{taxId='',branches=[]}={}){
 if(!navigator.onLine)throw new Error('Sin conexión: no se puede confirmar el cliente.');
 name=String(name||'').trim().replace(/\s+/g,' ');taxId=String(taxId||'').trim();
 if(!name||name.length>160)throw new Error('Ingrese la razón social (máximo 160 caracteres).');
 const cleaned=branches.map(b=>({id:b.id||crypto.randomUUID(),name:String(b.name||'').trim().replace(/\s+/g,' '),active:b.active!==false}));
 if(!cleaned.length||cleaned.some(b=>!b.name||b.name.length>160))throw new Error('Registre al menos una sucursal válida.');
 if(new Set(cleaned.map(b=>clientKey(b.name))).size!==cleaned.length)throw new Error('Hay sucursales repetidas.');
 const ref=doc(collection(db,'clients')),idx=doc(db,'clientNameKeys',encodeURIComponent(clientKey(name)));
 await runTransaction(db,async t=>{
  const [summary,existing]=await Promise.all([t.get(summaryRef()),t.get(idx)]);
  if(existing.exists())throw new Error('Este cliente ya está registrado. Selecciónelo en el catálogo.');
  const previous=requireCounters(summary);
  t.set(idx,{clientId:ref.id,nameKey:clientKey(name),createdBy:user.uid,createdAt:serverTimestamp()});
  t.set(ref,{name,nameKey:clientKey(name),taxId,branches:cleaned,active:true,createdAt:serverTimestamp(),createdBy:user.uid,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.update(summaryRef(),{counts:{...previous.counts,clients:previous.counts.clients+1},lastMutation:{type:'CLIENT_CREATE',id:ref.id},updatedAt:serverTimestamp()});
 });
 return {id:ref.id,name,taxId,branches:cleaned,active:true};
}
export async function updateClient(id,{name,taxId,branches,active},user){
 if(!navigator.onLine)throw new Error('Sin conexión.');
 const ref=doc(db,'clients',id);
 await runTransaction(db,async t=>{
  const snap=await t.get(ref);if(!snap.exists())throw new Error('Cliente no encontrado.');
  const old=snap.data(),next={};
  if(name!==undefined){
   const cleaned=String(name||'').trim().replace(/\s+/g,' ');
   if(!cleaned||cleaned.length>160)throw new Error('Razón social inválida.');
   const key=clientKey(cleaned);
   if(key!==old.nameKey){
    const indexRef=doc(db,'clientNameKeys',encodeURIComponent(key));
    const existing=await t.get(indexRef);
    if(existing.exists()&&existing.data().clientId!==id)throw new Error('Ya existe un cliente con esa razón social.');
    if(!existing.exists())t.set(indexRef,{clientId:id,nameKey:key,createdBy:user.uid,createdAt:serverTimestamp()});
   }
   next.name=cleaned;next.nameKey=key;
  }
  if(taxId!==undefined)next.taxId=String(taxId).trim();
  if(active!==undefined)next.active=!!active;
  if(branches!==undefined){
   const arr=branches.map(b=>({id:b.id||crypto.randomUUID(),name:String(b.name||'').trim().replace(/\s+/g,' '),active:b.active!==false}));
   if(!arr.length||arr.some(b=>!b.name||b.name.length>160))throw new Error('Debe existir al menos una sucursal.');
   if(new Set(arr.map(b=>clientKey(b.name))).size!==arr.length)throw new Error('Sucursales repetidas.');
   next.branches=arr;
  }
  t.update(ref,{...next,updatedAt:serverTimestamp(),updatedBy:user.uid});
 });
}
// Inicialización segura: con las reglas V1.0.0.8 publicadas, las altas están
// bloqueadas hasta que exista el resumen. No sobrescribe un resumen existente.
export async function initializeCounters(){
 if(!navigator.onLine)throw new Error('Sin conexión.');
 const [ots,clients]=await Promise.all([count('ots'),count('clients')]);
 await runTransaction(db,async t=>{
  const ref=summaryRef(),s=await t.get(ref);
  if(s.exists())throw new Error('Ya existe un resumen. No se sobrescribió.');
  t.set(ref,{initialized:true,counts:{ots,clients},lastMutation:{type:'INITIALIZE',id:'overview'},updatedAt:serverTimestamp()});
 });
 return {ots,clients};
}
export async function checkCounterConsistency(){
 const [ots,clients,s]=await Promise.all([count('ots'),count('clients'),getDocFromServer(summaryRef())]);
 const d=s.exists()?s.data():null;
 return {actual:{ots,clients},summary:d?.initialized?d.counts:null,consistent:!!d?.initialized&&d.counts.ots===ots&&d.counts.clients===clients};
}
export async function countOTStage(status){const s=await getCountFromServer(query(collection(db,'ots'),where('status','==',status)));return s.data().count}
export async function count(coll){const s=await getCountFromServer(collection(db,coll));return s.data().count}

// Una sola suscripción por vista activa; el tamaño de página no limita el histórico.
export function watchPage(coll,{cursor=null,size=10,filter=null,sortField=null,sortDirection="asc",series="all"}={},onData,onError){
 const constraints=[];
 if(filter)constraints.push(where(filter.field,Array.isArray(filter.value)?'in':'==',filter.value));
 if(series!=='all')constraints.push(where('series','==',series));
 if(sortField)constraints.push(orderBy(sortField,sortDirection),limit(size)); // Firestore usa __name__ implícito como desempate; coincide con índices creados.
 else if(filter?.field==='status')constraints.push(orderBy(documentId()),limit(size));
 else constraints.push(orderBy('createdAt','desc'),limit(size));
 if(cursor)constraints.push(startAfter(cursor));
 return onSnapshot(query(collection(db,coll),...constraints),{includeMetadataChanges:true},snap=>onData({
  rows:snap.docs.map(d=>({id:d.id,...d.data()})),
  cursor:snap.docs.at(-1)||null,
  fromCache:snap.metadata.fromCache,
  pending:snap.metadata.hasPendingWrites,
  more:snap.size===size
 }),onError);
}
export async function fetchOT(id){const s=await getDocFromServer(doc(db,'ots',id));return s.exists()?{id:s.id,...s.data()}:null}

// Contadores: snapshot de un único documento, nunca de toda la colección.
// Solo se utiliza si el documento summary/overview ha sido conciliado y marcado initialized=true.
export function watchCounters(onData,onError){
 return onSnapshot(doc(db,'summaries','overview'),{includeMetadataChanges:true},snap=>{
  const d=snap.exists()?snap.data():null;
  onData({ready:!!d?.initialized,counts:d?.counts||{},fromCache:snap.metadata.fromCache,pending:snap.metadata.hasPendingWrites});
 },onError);
}

// Diagnóstico explícito de conectividad real: navigator.onLine no prueba conexión a Firestore.
export async function verifyServer(uid){
 const start=performance.now();
 await getDocFromServer(doc(db,'users',uid));
 return {ok:true,latencyMs:Math.round(performance.now()-start)};
}

// Búsqueda por prefijo con límite fijo; nunca descarga todo el catálogo.
// Paginación alfabética y búsqueda por prefijo sobre el catálogo completo.
// El orden estable nameKey + ID evita saltos al avanzar entre páginas.
export async function clientCatalogPage({cursor=null,size=10,prefix=''}={}){
 const key=clientKey(prefix);const constraints=[orderBy('nameKey'),orderBy(documentId())];
 if(key)constraints.push(where('nameKey','>=',key),where('nameKey','<=',key+'\uf8ff'));
 constraints.push(limit(Math.min(50,Math.max(1,size))));if(cursor)constraints.push(startAfter(cursor));
 const snap=await getDocs(query(collection(db,'clients'),...constraints));
 return {rows:snap.docs.map(d=>({id:d.id,...d.data()})),cursor:snap.docs.at(-1)||null,more:snap.docs.length===Math.min(50,Math.max(1,size))};
}
export async function searchClients(prefix,max=10){
 const key=clientKey(prefix);if(!key)return [];
 const q=query(collection(db,'clients'),orderBy('nameKey'),where('nameKey','>=',key),where('nameKey','<=',key+'\uf8ff'),limit(Math.min(10,max)));
 const snap=await getDocs(q);return snap.docs.map(x=>({id:x.id,...x.data()})).filter(x=>x.active!==false);
}
// Alta atómica de sucursal: dos sesiones no pueden duplicar un nombre normalizado.
export async function addBranch(clientId,name,user){
 if(!navigator.onLine)throw new Error('Sin conexión. No se agregó la sucursal.');
 name=String(name||'').trim().replace(/\s+/g,' ');
 if(!name||name.length>160)throw new Error('Nombre de sucursal inválido.');
 const ref=doc(db,'clients',clientId);let result;
 await runTransaction(db,async t=>{
  const snap=await t.get(ref);if(!snap.exists())throw new Error('El cliente no existe.');
  const client=snap.data();if(client.active===false)throw new Error('El cliente está inactivo.');
  const branches=client.branches||[];
  if(branches.some(b=>clientKey(b.name)===clientKey(name)))throw new Error('Esta sucursal ya existe para el cliente. Selecciónela.');
  const branch={id:crypto.randomUUID(),name,active:true};result={id:clientId,...client,branches:[...branches,branch]};
  t.update(ref,{branches:result.branches,updatedAt:serverTimestamp(),updatedBy:user.uid});
 });return result;
}

// Importador de catálogo: reutiliza la misma transacción de alta del ERP.
// Un cliente por operación, reintentos idempotentes por índice de nombre.
export async function importCatalogClient(record,user){
 if(!record?.name||!Array.isArray(record.branches))throw new Error('Cliente inválido');
 return addClient(record.name,user,{taxId:record.taxId||'',branches:record.branches});
}
export async function lookupCatalogName(name){
 const ref=doc(db,'clientNameKeys',encodeURIComponent(clientKey(name)));
 const idx=await getDocFromServer(ref);
 if(idx.exists())return {exists:true,id:idx.data().clientId};
 // Compatibilidad: clientes antiguos sin índice.
 const matches=await getDocs(query(collection(db,'clients'),where('nameKey','==',clientKey(name)),limit(2)));
 return {exists:!matches.empty,id:matches.docs[0]?.id||null};
}

// Catálogo de monitoreos: ID estable basado en nombre normalizado, sin duplicados concurrentes.
const monitoringKey=name=>String(name||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ');
export async function searchMonitorings(prefix='',max=30){
 const key=monitoringKey(prefix);const n=Math.min(Math.max(Number(max)||30,1),250);
 const base=collection(db,'monitoringCatalog');
 const q=key?query(base,orderBy('nameKey'),where('nameKey','>=',key),where('nameKey','<=',key+'\uf8ff'),limit(n)):query(base,orderBy('nameKey'),limit(n));
 const snap=await getDocs(q);return snap.docs.map(d=>({id:d.id,...d.data()}));
}
export async function listMonitorings(max=30){return searchMonitorings('',max)}
export async function exportAllMonitorings(){
 const base=collection(db,'monitoringCatalog');let cursor=null;const out=[];
 while(true){
  const constraints=[orderBy('nameKey'),limit(100)];if(cursor)constraints.push(startAfter(cursor));
  const snap=await getDocs(query(base,...constraints));
  out.push(...snap.docs.map(d=>({id:d.id,...d.data()})));
  if(snap.size<100)break;
  cursor=snap.docs[snap.docs.length-1];
  if(out.length>10000)throw new Error('Límite de seguridad de 10.000 monitoreos alcanzado.');
 }
 return out;
}

export async function saveMonitoring(item,user){
 if(!navigator.onLine)throw new Error('Sin conexión: no se puede confirmar el catálogo.');
 const name=String(item.name||'').trim().replace(/\s+/g,' '),nameKey=monitoringKey(name);
 if(!name||name.length>160)throw new Error('Nombre inválido (máximo 160 caracteres).');
 if(!['LABORAL','AMBIENTAL'].includes(item.type))throw new Error('Seleccione Laboral o Ambiental.');
 if(!['RR','RG'].includes(item.series))throw new Error('Seleccione RR o RG.');
 const id=encodeURIComponent(nameKey),ref=doc(db,'monitoringCatalog',id);
 if(item.id&&item.id!==id)throw new Error('El nombre de un monitoreo existente no se puede cambiar para conservar la trazabilidad.');
 await runTransaction(db,async t=>{const old=await t.get(ref);
  if(old.exists()&&!item.id)throw new Error('Este monitoreo ya existe. Edítelo desde el catálogo.');
  if(!old.exists()&&item.id)throw new Error('El monitoreo no existe o fue modificado.');
  if(old.exists())t.update(ref,{type:item.type,series:item.series,active:item.active!==false,updatedBy:user.uid,updatedAt:serverTimestamp()});
  else t.set(ref,{name,nameKey,type:item.type,series:item.series,active:item.active!==false,createdBy:user.uid,createdAt:serverTimestamp(),updatedBy:user.uid,updatedAt:serverTimestamp()});
 });return {id,name,nameKey,type:item.type,series:item.series,active:item.active!==false};
}

// Envío a laboratorio: única transición sobre el expediente original.
const validOTDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'));
export async function sendLaboratoryOT(id,expectedVersion,{workDate,receivedAt,reason=''},user){
 if(!navigator.onLine)throw Error('Sin conexión: envío bloqueado.');
 if(!validOTDate(workDate)||!validOTDate(receivedAt))throw Error('Fechas obligatorias y válidas.');
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),audit=doc(collection(db,'otLaboratoryAudit'));
  const snap=await t.get(ref);if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.version!==expectedVersion||!['REGISTRADA','PROGRAMADA'].includes(old.status))throw Error('La OT '+old.code+' cambió. Actualice la bandeja.');
  if(receivedAt<workDate)throw Error('La fecha de recepción ('+receivedAt+') no puede ser anterior al inicio del trabajo ('+workDate+') de '+old.code+'.');
  const changed=!!old.workDate&&old.workDate!==workDate;
  if(changed&&String(reason).trim().length<10)throw Error('Motivo obligatorio para corregir fecha de '+old.code+'.');
  t.update(ref,{status:'EN_LABORATORIO',workDate,followUp:'PENDIENTE_INGRESO',sampledAt:'',receptionOTAt:null,laboratory:{proposedReceivedAt:receivedAt,sentBy:user.uid},version:expectedVersion+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(audit,{otId:id,code:old.code,action:'SEND_LAB',oldWorkDate:old.workDate||'',workDate,receivedAt,reason:String(reason).trim(),actorId:user.uid,createdAt:serverTimestamp()});
 });
}
export async function sendLaboratoryBatch(ids,receivedAt,user){
 if(!navigator.onLine)throw Error('Sin conexión: envío bloqueado.');if(!validOTDate(receivedAt))throw Error('Fecha de recepción inválida.');
 if(!Array.isArray(ids)||ids.length<1||ids.length>100||new Set(ids).size!==ids.length)throw Error('Seleccione entre 1 y 100 OT distintas.');
 // Lectura y validación de todo el lote ANTES de cualquier escritura.
 await runTransaction(db,async t=>{
  const refs=ids.map(id=>doc(db,'ots',id));const snaps=await Promise.all(refs.map(ref=>t.get(ref)));
  const missing=snaps.filter(s=>!s.exists()||!validOTDate(s.data().workDate)).map(s=>s.exists()?s.data().code:s.id);
  if(missing.length)throw Error('Complete fecha de inicio del trabajo para: '+missing.join(', '));
  const wrongDates=snaps.filter(s=>s.exists()&&validOTDate(s.data().workDate)&&receivedAt<s.data().workDate).map(s=>s.data().code+' ('+s.data().workDate+')');
  if(wrongDates.length)throw Error('Recepción '+receivedAt+' anterior al inicio del trabajo de: '+wrongDates.join(', ')+'. No se envió ninguna OT.');
  const invalid=snaps.filter(s=>!['REGISTRADA','PROGRAMADA'].includes(s.data().status)).map(s=>s.data().code);
  if(invalid.length)throw Error('OT ya procesadas o anuladas: '+invalid.join(', '));
  snaps.forEach((snap,i)=>{const old=snap.data(),audit=doc(collection(db,'otLaboratoryAudit'));
   t.update(refs[i],{status:'EN_LABORATORIO',followUp:'PENDIENTE_INGRESO',sampledAt:'',receptionOTAt:null,laboratory:{proposedReceivedAt:receivedAt,sentBy:user.uid},version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
   t.set(audit,{otId:ids[i],code:old.code,action:'SEND_LAB_BATCH',oldWorkDate:old.workDate,workDate:old.workDate,receivedAt,reason:'',actorId:user.uid,createdAt:serverTimestamp()});
  });
 });
}

// Devolución controlada: exclusivamente antes de confirmar ingreso oficial.
export async function returnPendingOTs(ids,reason,user){
 if(!navigator.onLine)throw Error('Sin conexión: devolución bloqueada.');
 const why=String(reason||'').trim();
 if(why.length<10||why.length>500)throw Error('Indique un motivo de 10 a 500 caracteres.');
 if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length)throw Error('Seleccione entre 1 y 20 OT diferentes.');
 await runTransaction(db,async t=>{
  const refs=ids.map(id=>doc(db,'ots',id));const snaps=[];
  for(const ref of refs)snaps.push(await t.get(ref));
  for(let i=0;i<snaps.length;i++){
   const old=snaps[i].data();
   if(!old||old.status!=='EN_LABORATORIO'||old.followUp!=='PENDIENTE_INGRESO'||old.receptionOTAt||old.laboratory?.receivedAt||old.laboratory?.receivedAtServer)
    throw Error('La OT '+(old?.code||ids[i])+' ya no está pendiente de ingreso oficial. No se devolvió ninguna OT.');
  }
  for(let i=0;i<snaps.length;i++){
   const old=snaps[i].data();const status=old.workDate?'PROGRAMADA':'REGISTRADA';
   t.update(refs[i],{status,followUp:old.workDate?'OT_PROGRAMADA':'OT_POR_PROGRAMAR',laboratory:{},version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
   t.set(doc(collection(db,'otLaboratoryAudit')),{otId:ids[i],code:old.code,action:'RETURN_TO_REGISTRATION',previousStatus:old.status,newStatus:status,reason:why,previousProposedReceivedAt:old.laboratory?.proposedReceivedAt||'',actorId:user.uid,createdAt:serverTimestamp()});
  }
 });
}
// Consultas de agregación en servidor: sin descargar documentos de OT.
export async function supervisionCounts(){
 const statuses=['INFORME_PENDIENTE','POR_AUTORIZAR','AUTORIZADO','PUBLICADO','FACTURADO'];
 const values=await Promise.all(statuses.map(async status=>{const snap=await getCountFromServer(query(collection(db,'ots'),where('status','==',status)));return [status,snap.data().count]}));
 const counts=Object.fromEntries(values);
 return {total:Object.values(counts).reduce((a,b)=>a+b,0),...counts};
}

// Autorización de informes: estados 1/4 liberan; 2/3 retienen sin fecha.
function validateAuthorization(state,date){
 const v=String(state);if(!['1','2','3','4'].includes(v))throw Error('Seleccione un estado entre 1 y 4.');
 if(['1','4'].includes(v)&&!validReportDate(date))throw Error('Para estados 1 y 4 se requiere fecha de autorización válida.');
 return {state:v,date:['1','4'].includes(v)?date:null,released:['1','4'].includes(v)};
}
export async function authorizeReport(id,version,state,date,user){
 if(!navigator.onLine)throw Error('Sin conexión: no se guardó la autorización.');const decision=validateAuthorization(state,date);
 await runTransaction(db,async t=>{
  const ref=doc(db,'ots',id),snap=await t.get(ref);if(!snap.exists())throw Error('OT no encontrada.');const old=snap.data();
  if(old.status!=='POR_AUTORIZAR'||old.version!==version)throw Error('La OT '+old.code+' fue modificada. Actualice la vista.');
  if(!old.deliveryRealAt)throw Error('La OT '+old.code+' no tiene entrega real registrada.');
  const status=decision.released?'AUTORIZADO':'POR_AUTORIZAR';
  t.update(ref,{status,followUp:decision.released?'AUTORIZADO_PENDIENTE_PORTAL':'INFORME_RETENIDO',authorization:{state:decision.state,authorizedAt:decision.date,updatedBy:user.uid,updatedAt:serverTimestamp()},authorizationAt:decision.date,version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
  t.set(doc(collection(db,'otAuthorizationAudit')),{otId:id,code:old.code,action:'AUTH_STATE',previousStatus:old.status,newStatus:status,authorizationState:decision.state,authorizationAt:decision.date,actorId:user.uid,createdAt:serverTimestamp()});
 });
}
export async function authorizeReportsBatch(ids,state,date,user){
 if(!navigator.onLine)throw Error('Sin conexión: no se guardó la autorización.');if(!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length)throw Error('Seleccione entre 1 y 20 OT distintas.');const decision=validateAuthorization(state,date);
 await runTransaction(db,async t=>{
  const refs=ids.map(id=>doc(db,'ots',id)),snaps=[];for(const ref of refs)snaps.push(await t.get(ref));
  for(let i=0;i<snaps.length;i++){const old=snaps[i].exists()?snaps[i].data():null;if(!old||old.status!=='POR_AUTORIZAR'||!old.deliveryRealAt)throw Error('OT '+(old?.code||ids[i])+' no está disponible para autorizar. Actualice la vista.');}
  snaps.forEach((snap,i)=>{const old=snap.data(),status=decision.released?'AUTORIZADO':'POR_AUTORIZAR';
   t.update(refs[i],{status,followUp:decision.released?'AUTORIZADO_PENDIENTE_PORTAL':'INFORME_RETENIDO',authorization:{state:decision.state,authorizedAt:decision.date,updatedBy:user.uid,updatedAt:serverTimestamp()},authorizationAt:decision.date,version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});
   t.set(doc(collection(db,'otAuthorizationAudit')),{otId:ids[i],code:old.code,action:'AUTH_STATE_BATCH',previousStatus:old.status,newStatus:status,authorizationState:decision.state,authorizationAt:decision.date,actorId:user.uid,createdAt:serverTimestamp()});
  });
 });
}

// Publicación al portal: cambio atómico, inmutable y auditable.
function validatePortalDate(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||''))||Number.isNaN(Date.parse(date+'T12:00:00')))throw Error('Indique una fecha de publicación válida.');}
function eligibleForPortal(old){return old?.status==='AUTORIZADO'&&['1','4'].includes(String(old.authorization?.state))&&typeof old.authorizationAt==='string'&&old.authorizationAt.length===10&&typeof old.deliveryRealAt==='string'&&old.deliveryRealAt.length===10;}
// Operación extraordinaria: lectura paginada bajo demanda, sin listeners.
export async function previewExtraordinaryPortal(){
 if(!navigator.onLine)throw Error('Se requiere conexión para revisar los informes.');
 const eligible=[], excluded=[];let cursor=null;
 do{
  const clauses=[where('status','==','AUTORIZADO'),orderBy(documentId()),...(cursor?[startAfter(cursor)]:[]),limit(100)];
  const snap=await getDocsFromServer(query(collection(db,'ots'),...clauses));
  for(const d of snap.docs){const r=d.data();
   if(eligibleForPortal(r))eligible.push({id:d.id,code:r.code,version:r.version,series:r.series});
   else excluded.push({code:r.code||d.id,reason:'Autorización o fechas incompletas'});
  }
  cursor=snap.docs.length===100?snap.docs[snap.docs.length-1]:null;
 }while(cursor);
 return {eligible,excluded};
}
export async function publishExtraordinaryPortal(ids,date,user,onProgress){
 if(!navigator.onLine)throw Error('Se requiere conexión.');validatePortalDate(date);
 if(!Array.isArray(ids))throw Error('Selección inválida.');
 const result={published:0,failed:[],skipped:0};
 for(let i=0;i<ids.length;i+=20){
  const group=ids.slice(i,i+20);
  try{await publishPortalBatch(group,date,user);result.published+=group.length;}
  catch(e){ // Aislar registros modificados desde la vista previa; continuar con el resto.
   for(const id of group){try{await publishPortalBatch([id],date,user);result.published++;}
    catch(err){result.failed.push({id,message:err.message});}}
  }
  if(onProgress)onProgress({...result,processed:Math.min(i+20,ids.length),total:ids.length});
 }
 return result;
}
export async function publishPortalOT(id,version,date,user){if(!navigator.onLine)throw Error('Sin conexión: publicación bloqueada.');validatePortalDate(date);await runTransaction(db,async t=>{const ref=doc(db,'ots',id),snap=await t.get(ref),old=snap.data();if(!eligibleForPortal(old)||old.version!==version)throw Error('OT modificada o no autorizada. Actualice la vista.');t.update(ref,{status:'PUBLICADO',followUp:'INFORME_ENVIADO_PORTAL',portalPublishedAt:date,portal:{publishedAt:date,publishedBy:user.uid,updatedAt:serverTimestamp()},version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});t.set(doc(collection(db,'otPortalAudit')),{otId:id,code:old.code,action:'PORTAL_PUBLISH',previousStatus:'AUTORIZADO',newStatus:'PUBLICADO',publishedAt:date,actorId:user.uid,createdAt:serverTimestamp()})})}
export async function publishPortalBatch(ids,date,user){if(!navigator.onLine)throw Error('Sin conexión: publicación bloqueada.');validatePortalDate(date);if(!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length)throw Error('Seleccione de 1 a 20 OT diferentes.');await runTransaction(db,async t=>{const refs=ids.map(id=>doc(db,'ots',id)),snaps=[];for(const ref of refs)snaps.push(await t.get(ref));for(let i=0;i<snaps.length;i++)if(!eligibleForPortal(snaps[i].data()))throw Error('La OT '+(snaps[i].data()?.code||ids[i])+' ya cambió o no cumple autorización. Ninguna OT fue publicada.');snaps.forEach((snap,i)=>{const old=snap.data();t.update(refs[i],{status:'PUBLICADO',followUp:'INFORME_ENVIADO_PORTAL',portalPublishedAt:date,portal:{publishedAt:date,publishedBy:user.uid,updatedAt:serverTimestamp()},version:old.version+1,updatedAt:serverTimestamp(),updatedBy:user.uid});t.set(doc(collection(db,'otPortalAudit')),{otId:ids[i],code:old.code,action:'PORTAL_PUBLISH_BATCH',previousStatus:'AUTORIZADO',newStatus:'PUBLICADO',publishedAt:date,actorId:user.uid,createdAt:serverTimestamp()})})})}

// Facturación desacoplada del expediente técnico: cada OT mantiene un documento
// administrativo propio. No cambia el estado del flujo ni la numeración.
const billStates=['PENDIENTE','FACTURADO','FACTURA PARCIAL','EN ESPERA','NO FACTURAR'];
function validateBilling(data){
 const quote=String(data.quote||'').trim(),invoice=String(data.invoice||'').trim(),invoiceDate=String(data.invoiceDate||''),state=String(data.state||'PENDIENTE'),note=String(data.note||'').trim();
 const subtotal=data.subtotal===''||data.subtotal==null?0:Number(data.subtotal);
 if(quote.length>100||invoice.length>100||note.length>1000)throw Error('Excedió el límite de caracteres de facturación.');
 if(!billStates.includes(state))throw Error('Estado de facturación no permitido.');
 if(invoiceDate&&!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate))throw Error('Fecha de factura inválida.');
 if(!Number.isFinite(subtotal)||subtotal<0||subtotal>999999999)throw Error('Subtotal fuera de rango.');
 if(['FACTURADO','FACTURA PARCIAL'].includes(state)&&(!invoice||!invoiceDate))throw Error('Para facturado o factura parcial se requiere número y fecha de factura.');
 return {quote,invoice,invoiceDate,subtotal,state,note};
}
function billable(ot){return ot&& !['ANULADA','REGISTRADA','PROGRAMADA','EN_LABORATORIO'].includes(ot.status)}
// Las bandejas administrativas parten de las OT con ingreso oficial, no de documentos de factura guardados.
const admittedStatuses=['INFORME_PENDIENTE','POR_AUTORIZAR','AUTORIZADO','PUBLICADO','FACTURADO'];
export async function fetchAdmittedPage(cursor=null,size=10){
 const constraints=[where('status','in',admittedStatuses),orderBy('createdAt','desc'),limit(size)];
 if(cursor)constraints.push(startAfter(cursor));
 const snap=await getDocs(query(collection(db,'ots'),...constraints));
 return {rows:snap.docs.map(d=>({id:d.id,...d.data()})),cursor:snap.docs.at(-1)||null,more:snap.docs.length===size};
}
// Supervisión: consulta global bajo demanda. La navegación normal permanece paginada.
export async function searchSupervisionGlobal(term='',{series='all',status='all',deliveryFrom='',deliveryTo='',authFrom='',authTo='',max=5000}={}){
 const q=String(term||'').trim();
 const normalized=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
 const needle=normalized(q);
 if(q && needle.length<3)return {rows:[],warning:'Ingrese al menos 3 caracteres para buscar globalmente.'};
 let candidates=[],warning='';
 if(/^(RR|RG)\d{6}$/i.test(needle)){
  const exact=await findOTByExactCode(needle);candidates=exact.rows||[];
 }else if(needle){
  const indexed=await searchOTIndexOperational(needle,{series,max:1000});
  candidates=indexed.rows||[];
  if(indexed.unsupported||indexed.stale||indexed.limited||!candidates.length){
   warning='El índice auxiliar puede estar incompleto; se realizó una comprobación adicional del histórico.';
   const fallback=await scanSupervisionCandidates(max);
   candidates=[...new Map([...candidates,...fallback.rows].map(r=>[r.id,r])).values()];
   if(fallback.truncated)warning+=' La comprobación alcanzó el límite de seguridad.';
  }
 }else{
  const scanned=await scanSupervisionCandidates(max);candidates=scanned.rows;
  if(scanned.truncated)warning='La consulta alcanzó el límite de seguridad; reduzca el rango de fechas.';
 }
 const inRange=(v,a,b)=>!a&&!b||!!v&&(!a||v>=a)&&(!b||v<=b);
 const rows=candidates.filter(r=>admittedStatuses.includes(r.status)
  &&(series==='all'||(r.series||String(r.code||'').slice(0,2))===series)
  &&(status==='all'||r.status===status)
  &&(!needle||[r.code,r.clientName,r.branchName,r.monitoring,r.laboratory?.analyst].some(x=>normalized(x).includes(needle)))
  &&inRange(r.deliveryRealAt||r.report?.deliveryRealAt,deliveryFrom,deliveryTo)
  &&inRange(r.authorizationAt||r.report?.authorizationAt,authFrom,authTo));
 return {rows,warning};
}
async function scanSupervisionCandidates(max){
 const rows=[];let cursor=null,truncated=false;
 while(rows.length<max){
  const n=Math.min(200,max-rows.length);
  const clauses=[where('status','in',admittedStatuses),orderBy('createdAt','desc'),limit(n)];
  if(cursor)clauses.push(startAfter(cursor));
  const snap=await getDocs(query(collection(db,'ots'),...clauses));
  rows.push(...snap.docs.map(d=>({id:d.id,...d.data()})));
  if(snap.size<n)break;
  cursor=snap.docs.at(-1);
  if(rows.length>=max){truncated=true;break;}
 }
 return {rows,truncated};
}
// Exportación histórica paginada: nunca depende de los registros de la pantalla.
export async function exportBillingHistory(mode='all',onProgress=()=>{}){
 const uid=auth.currentUser?.uid;
 if(!uid)throw Error('Sesión no disponible. Vuelva a ingresar.');
 const admitted=new Set(['INFORME_PENDIENTE','POR_AUTORIZAR','AUTORIZADO','PUBLICADO','FACTURADO']);
 // La primera descarga es completa. Las siguientes consultan cambios por updatedAt.
 // Revalidación completa cada 15 minutos para cubrir documentos históricos sin updatedAt.
 let cached=null;
 try{cached=await readExportCache(uid)}catch(e){console.warn('Caché no disponible:',e)}
 const now=Date.now(),full=!cached||cached.schema!==1||now-cached.fullAt>15*60*1000;
 let otMap=new Map(full?[]:(cached.ots||[]).map(r=>[r.id,r]));
 let billingMap=new Map(full?[]:(cached.bills||[]).map(r=>[r.id,r.data]));
 const fetchPages=async(col,clauses,onRow)=>{
  let cursor=null,scanned=0;
  do{
   const parts=[...clauses,limit(150)];if(cursor)parts.push(startAfter(cursor));
   const snap=await getDocsFromServer(query(collection(db,col),...parts));
   for(const d of snap.docs)onRow(d);
   scanned+=snap.size;onProgress(otMap.size,billingMap.size,otMap.size);
   cursor=snap.size===150?snap.docs.at(-1):null;
   if(scanned>30000)throw Error('La exportación supera 30.000 documentos.');
  }while(cursor);
 };
 // Se usa un margen de seguridad de 2 minutos para evitar perder escrituras concurrentes.
 // Los documentos sin updatedAt se revisan durante la revalidación completa.
 const since=full?null:new Date(Math.max(0,cached.syncedAt-120000));
 if(full){
  await fetchPages('ots',[orderBy(documentId())],d=>otMap.set(d.id,{id:d.id,...d.data()}));
 }else{
  await fetchPages('ots',[where('updatedAt','>=',since),orderBy('updatedAt')],d=>otMap.set(d.id,{id:d.id,...d.data()}));
 }
 const all=[...otMap.values()];
 const targets=all.filter(r=>admitted.has(r.status));
 if(full){
  // No consultar individualmente documentos ausentes: una sola consulta paginada.
  await fetchPages('otBilling',[orderBy(documentId())],d=>billingMap.set(d.id,d.data()));
 }else{
  await fetchPages('otBilling',[where('updatedAt','>=',since),orderBy('updatedAt')],d=>billingMap.set(d.id,d.data()));
 }
 // La caché guarda exclusivamente los datos obtenidos del servidor.
 try{await writeExportCache(uid,{schema:1,fullAt:full?now:cached.fullAt,syncedAt:now,ots:all,bills:[...billingMap].map(([id,data])=>({id,data}))})}
 catch(e){console.warn('No se pudo persistir la caché de exportación:',e)}
 const rows=(mode==='admitted'?targets:all).map(r=>({...r,billing:billingMap.get(r.id)||null}));
 onProgress(all.length,targets.length,targets.length);
 // Orden predeterminado de exportación: RR primero, RG después;
 // dentro de cada serie, fecha de inicio más antigua primero y código numérico ascendente.
 // Si falta la fecha, el registro queda al final de su serie.
 const seriesRank=r=>String(r.series||r.code||'').toUpperCase().startsWith('RR')?0:String(r.series||r.code||'').toUpperCase().startsWith('RG')?1:2;
 const validDate=r=>{const d=String(r.workDate||'');return /^\d{4}-\d{2}-\d{2}$/.test(d)?d:'9999-12-31'};
 const codeNumber=r=>{const m=String(r.code||'').match(/(\d+)$/);return m?Number(m[1]):Number.MAX_SAFE_INTEGER};
 return rows.sort((a,b)=>seriesRank(a)-seriesRank(b)||validDate(a).localeCompare(validDate(b))||codeNumber(a)-codeNumber(b)||String(a.code||'').localeCompare(String(b.code||''),'es',{numeric:true}));
}
export async function fetchBillingPage(cursor=null,size=10,series='all'){
 // RR/RG: consultar por prefijo de código EN EL SERVIDOR antes de paginar.
 // Evita que una página compuesta por RG parezca vacía al seleccionar RR.
 let result;
 if(series==='all')result=await fetchAdmittedPage(cursor,size);
 else {
  const rows=[];let next=cursor,exhausted=false;
  while(rows.length<size && !exhausted){
   const requested=Math.max(1,size-rows.length);
   const constraints=[orderBy('code'),startAt(series),endAt(series+'\uf8ff'),limit(requested)];
   if(next)constraints.push(startAfter(next));
   const snap=await getDocs(query(collection(db,'ots'),...constraints));
   for(const d of snap.docs){const r={id:d.id,...d.data()};if(billable(r))rows.push(r)}
   next=snap.docs.at(-1)||next;
   exhausted=snap.size<requested;
  }
  // Cursor por último documento escaneado: los resultados sobrantes deben conservarse.
  // Para evitar saltos, usamos lotes de tamaño 1 en el tramo final cuando quedan pocos espacios.
  result={rows:rows.slice(0,size),cursor:next,more:!exhausted};
 }

 const refs=result.rows.map(r=>doc(db,'otBilling',r.id));
 const bills=await Promise.all(refs.map(ref=>getDocFromServer(ref)));
 return {...result,rows:result.rows.map((r,i)=>({...r,billing:bills[i].exists()?bills[i].data():null}))};
}
// Búsqueda global de facturación bajo demanda; conserva documentos administrativos existentes.
export async function searchBillingGlobal(term,series='all'){
 const q=String(term||'').trim();
 if(q.length<3)return {rows:[],warning:'Escriba al menos 3 caracteres.'};
 let result,warning='';
 if(/^(RR|RG)\d{6}$/i.test(q))result=await findOTByExactCode(q);
 else {
  result=await searchOTIndexOperational(q,{series,max:1500});
  if(result.unsupported||result.stale||result.limited||!result.rows.length){
   const prefix=await searchOTIndexedPrefixes(q,75);
   const merged=new Map([...result.rows,...prefix.rows].map(r=>[r.id,r]));
   result={...result,rows:[...merged.values()]};
   warning='La búsqueda parcial puede tener cobertura incompleta. Si falta una OT RR/RG, un administrador debe ejecutar «Generar índice de búsqueda» para reconstruir el índice auxiliar; las OT originales no se modifican.';
  }
 }
 const eligible=result.rows.filter(r=>billable(r)&&(series==='all'||String(r.code||'').toUpperCase().startsWith(series)));
 const rows=[];
 for(let i=0;i<eligible.length;i+=20){
  const chunk=eligible.slice(i,i+20);
  const bills=await Promise.all(chunk.map(r=>getDocFromServer(doc(db,'otBilling',r.id))));
  rows.push(...chunk.map((r,j)=>({...r,billing:bills[j].exists()?bills[j].data():null})));
 }
 rows.sort((a,b)=>String(b.code).localeCompare(String(a.code)));
 if(!rows.length && !warning)warning='Sin coincidencias en el índice. Si conoce una OT que debería aparecer, solicite reconstruir el índice auxiliar desde «Generar índice de búsqueda».';
 return {rows,warning,limited:!!result.limited};
}

export async function saveBilling(id,data,user){
 if(!navigator.onLine)throw Error('Debe estar conectado al servidor para guardar.');
 const clean=validateBilling(data),ref=doc(db,'otBilling',id),otRef=doc(db,'ots',id);
 const expected=Number(data.version||0);
 await runTransaction(db,async t=>{
  const [otSnap,billSnap]=await Promise.all([t.get(otRef),t.get(ref)]);
  const ot=otSnap.data(),old=billSnap.exists()?billSnap.data():null;
  if(!billable(ot))throw Error('La OT ya no está disponible para facturación.');
  if(Number(old?.version||0)!==expected)throw Error('La facturación fue modificada por otro usuario. Actualice antes de guardar.');
  const next={...clean,otId:id,code:ot.code,version:expected+1,updatedBy:user.uid,updatedAt:serverTimestamp()};
  if(old)t.update(ref,next);else t.set(ref,{...next,createdAt:serverTimestamp(),createdBy:user.uid});
  t.set(doc(collection(db,'otBillingAudit')),{otId:id,code:ot.code,action:'BILLING_SAVE',previousVersion:expected,newVersion:expected+1,actorId:user.uid,createdAt:serverTimestamp()});
 });return {...clean,version:expected+1};
}
export async function saveBillingBatch(items,user){
 if(!navigator.onLine)throw Error('Debe estar conectado al servidor para guardar.');
 if(!Array.isArray(items)||items.length<1||items.length>20||new Set(items.map(x=>x.id)).size!==items.length)throw Error('Seleccione entre 1 y 20 OT distintas.');
 const validated=items.map(item=>({...item,clean:validateBilling(item)}));
 await runTransaction(db,async t=>{
  const refs=validated.map(x=>({ot:doc(db,'ots',x.id),bill:doc(db,'otBilling',x.id)}));
  const ots=[];for(const r of refs)ots.push(await t.get(r.ot));
  const bills=[];for(const r of refs)bills.push(await t.get(r.bill));
  validated.forEach((x,i)=>{const ot=ots[i].data(),old=bills[i].exists()?bills[i].data():null,expected=Number(x.version||0);
   if(!billable(ot)||Number(old?.version||0)!==expected)throw Error('OT '+(ot?.code||x.id)+' cambió o no es facturable. Ninguna OT fue guardada.');
   const next={...x.clean,otId:x.id,code:ot.code,version:expected+1,updatedBy:user.uid,updatedAt:serverTimestamp()};
   if(old)t.update(refs[i].bill,next);else t.set(refs[i].bill,{...next,createdAt:serverTimestamp(),createdBy:user.uid});
   t.set(doc(collection(db,'otBillingAudit')),{otId:x.id,code:ot.code,action:'BILLING_BATCH',previousVersion:expected,newVersion:expected+1,actorId:user.uid,createdAt:serverTimestamp()});
  });
 });
}

// Conteos de agregación sobre Firestore: no descargan documentos ni dependen
// del resumen transaccional, que puede contener cifras históricas desfasadas.
export async function countMeasurementOTs(){
 const base=collection(db,'ots');
 const [total,registered,programmed]=await Promise.all([
  getCountFromServer(base),
  getCountFromServer(query(base,where('status','==','REGISTRADA'))),
  getCountFromServer(query(base,where('status','==','PROGRAMADA')))
 ]);
 return {total:total.data().count,pending:registered.data().count+programmed.data().count};
}

// Indicadores del menú: agregaciones independientes de la página visible.
// Los estados posteriores conservan la condición de ingreso oficial al laboratorio.
export async function operationMenuCounts(){
 // Cada indicador es independiente: una consulta fallida no oculta los demás.
 const base=collection(db,'ots');
 const statuses=['REGISTRADA','PROGRAMADA','EN_LABORATORIO','INFORME_PENDIENTE','POR_AUTORIZAR','AUTORIZADO','PUBLICADO','FACTURADO'];
 const results=await Promise.allSettled([
  getCountFromServer(base),
  ...statuses.map(status=>getCountFromServer(query(base,where('status','==',status))))
 ]);
 const value=i=>results[i].status==='fulfilled'?results[i].value.data().count:null;
 const statusCount=Object.fromEntries(statuses.map((status,i)=>[status,value(i+1)]));
 const sum=keys=>keys.every(key=>Number.isFinite(statusCount[key]))?keys.reduce((n,key)=>n+statusCount[key],0):null;
 const counts={
  ots:value(0),
  laboratory:sum(['EN_LABORATORIO','INFORME_PENDIENTE','POR_AUTORIZAR','AUTORIZADO','PUBLICADO','FACTURADO']),
  billing:sum(admittedStatuses),
  supervision:sum(admittedStatuses)
 };
 if(Object.values(counts).every(v=>v===null)){
  const first=results.find(r=>r.status==='rejected');throw first?.reason||new Error('No se pudieron obtener contadores');
 }
 return counts;
}

// V1.0.0.75: consulta puntual de OT por código completo, sin barrer el histórico.
// El filtro de etapa se mantiene en la interfaz, igual que en la búsqueda global anterior.
export async function findOTByExactCode(code){
 const normalized=String(code||'').trim().toUpperCase();
 if(!/^(RG|RR)\d{6}$/.test(normalized))throw new Error('Código de OT inválido para búsqueda exacta.');
 const snap=await getDocs(query(collection(db,'ots'),where('code','==',normalized),limit(2)));
 return {rows:snap.docs.map(d=>({id:d.id,...d.data()})),truncated:false,exact:true};
}

// V1.0.0.77: búsquedas por prefijo usando índices automáticos de campo único.
// No modifica documentos históricos ni exige cambios de reglas.
// Los resultados están acotados; NO equivalen a búsqueda de subcadenas arbitrarias.
export async function searchOTIndexedPrefixes(term, maxPerField=75){
 const value=String(term||'').trim();
 if(value.length<3)return {rows:[],limited:false,unsupported:true};
 const fields=['code','clientName','branchName','monitoring'];
 const candidates=[value,value.toUpperCase(),value.toLowerCase()];
 const seen=new Map();let limited=false;
 const requests=[];
 for(const field of fields)for(const prefix of [...new Set(candidates)]){
  requests.push(getDocs(query(collection(db,'ots'),orderBy(field),startAt(prefix),endAt(prefix+'\uf8ff'),limit(maxPerField))).then(snap=>{
   if(snap.size===maxPerField)limited=true;
   for(const d of snap.docs)seen.set(d.id,{id:d.id,...d.data()});
  }));
 }
 await Promise.all(requests);
 return {rows:[...seen.values()],limited,unsupported:false};
}

// Consulta global explícita y bajo demanda: no se ejecuta al iniciar sesión.
export async function scanOTHistory(max=5000){
 const results=[];let cursor=null;
 while(results.length<max){
  const batchSize=Math.min(250,max-results.length);
  const constraints=[orderBy('createdAt','desc'),limit(batchSize)];
  if(cursor)constraints.push(startAfter(cursor));
  const snap=await getDocs(query(collection(db,'ots'),...constraints));
  results.push(...snap.docs.map(d=>({id:d.id,...d.data()})));
  if(snap.size<batchSize)break;
  cursor=snap.docs.at(-1);if(!cursor)break;
 }
 return {rows:results,truncated:results.length>=max};
}

// Consulta bajo demanda: recorre exclusivamente la etapa solicitada, no todo el histórico.
export async function searchLaboratoryStage(status,term,series='all',max=5000){
 const normalized=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
 const needle=normalized(term.trim());let cursor=null,scanned=0;const rows=[];
 // Código completo: búsqueda indexada exacta; evita recorrer hasta 5.000 OT.
 // Mantener la búsqueda parcial existente para términos incompletos.
 if(/^(RG|RR)\d{6}$/.test(needle)){
  const clauses=[where('status','==',status),where('code','==',needle),limit(2)];
  const snap=await getDocs(query(collection(db,'ots'),...clauses));
  const found=snap.docs.map(d=>({id:d.id,...d.data()})).filter(r=>series==='all'||(r.series||String(r.code).slice(0,2))===series);
  return {rows:found,truncated:false,scanned:snap.size,exact:true};
 }

 while(scanned<max){
  const n=Math.min(250,max-scanned);
  const clauses=[where('status','==',status)];
  // Filtrar por serie en servidor evita leer todos los RG al solicitar RR.
  // Los históricos sin campo series siguen disponibles en la búsqueda RR + RG.
  if(series!=='all')clauses.push(where('series','==',series));
  clauses.push(orderBy(documentId()),limit(n));
  if(cursor)clauses.push(startAfter(cursor));
  const snap=await getDocs(query(collection(db,'ots'),...clauses));
  for(const d of snap.docs){const r={id:d.id,...d.data()};if((series==='all'||(r.series||String(r.code).slice(0,2))===series)&&(!needle||normalized([r.code,r.clientName,r.branchName,r.monitoring].join(' ')).includes(needle)))rows.push(r)}
  scanned+=snap.size;cursor=snap.docs.at(-1);if(snap.size<n) return {rows,truncated:false,scanned};
 }
 return {rows,truncated:true,scanned};
}

// V1.0.0.97: búsqueda indexada con control explícito de cobertura y desactualización.
export async function searchOTIndexOperational(term,options={}){
 return searchIndexedOT(db,term,{max:500,...options});
}

// V1.0.0.94: opt-in diagnostic. No production replacement without verified coverage.
export async function testOTSearchIndex(term,options={}){
 const started=performance.now();
 const result=await searchIndexedOT(db,term,options);
 return {...result,elapsedMs:Math.round(performance.now()-started),mode:'EXPERIMENTAL_INDEX'};
}

// V1.0.0.95: carga administrativa controlada; nunca modifica /ots.
export async function buildSearchIndex({onProgress=()=>{},signal}={}){
 const current=auth.currentUser;
 if(!current)throw Error('Inicie sesión.');
 const ps=await profile(current.uid);
 if(!ps?.active||ps.role!=='ADMINISTRADOR')throw Error('Solo ADMINISTRADOR activo.');
 if(!navigator.onLine)throw Error('Se requiere conexión a Internet.');
 let cursor=null,scanned=0,written=0,unchanged=0;
 do {
  if(signal?.aborted)break;
  let q=query(collection(db,'ots'),orderBy(documentId()),limit(10));
  if(cursor)q=query(collection(db,'ots'),orderBy(documentId()),startAfter(cursor),limit(10));
  const page=await getDocsFromServer(q);
  if(page.empty)break;
  // Las reglas leen la OT fuente para validar cada índice.
  // Firestore limita a 20 accesos a documentos por operación por lotes.
  // Usamos 10 índices por commit para mantener margen para active()/admin().
  const batch=writeBatch(db);
  let changes=0;
  for(const d of page.docs){
   const ot=d.data();
   const payload=indexPayload(d.id,ot);
   // Set sin merge: el índice queda exactamente sincronizado con la OT leída.
   batch.set(doc(db,'otSearchIndex',d.id),payload);
   changes++;
  }
  // Escrituras limitadas a 75 por commit; la OT fuente nunca se altera.
  try { await batch.commit(); } catch(error) {
   throw new Error(`No se pudo guardar el lote después de ${written} índices. ${error?.message||error}`);
  }
  scanned+=page.size;written+=changes;
  cursor=page.docs[page.docs.length-1];
  onProgress({scanned,written,unchanged});
  if(page.size<10)break;
 }while(true);
 return {scanned,written,stopped:!!signal?.aborted};
}

// Perfiles: solo el administrador autenticado puede gestionarlos (reglas Firestore).
export async function listUserProfiles(){
 const snapshot=await getDocs(query(collection(db,'users'),limit(200)));
 return snapshot.docs.map(x=>({uid:x.id,...x.data()})).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'es'));
}
export async function saveUserProfile(profile,actorUid){
 if(!/^[A-Za-z0-9_-]{20,128}$/.test(profile.uid))throw new Error('UID inválido. Copie el UID completo de Firebase Authentication.');
 if(!['ADMINISTRADOR','OPERACIONES'].includes(profile.role))throw new Error('Rol no permitido.');
 if(typeof profile.permissions?.billingAccess!=='boolean')throw new Error('Defina acceso a Facturación.');
 if(!profile.name||!/^\S+@\S+\.\S+$/.test(profile.email))throw new Error('Complete nombre y correo válido.');
 if(profile.uid===actorUid&&(!profile.active||profile.role!=='ADMINISTRADOR'))throw new Error('No puede retirar su propio acceso administrativo.');
 const ref=doc(db,'users',profile.uid);const old=await getDoc(ref);
 await setDoc(ref,{name:profile.name,email:profile.email,role:profile.role,active:profile.active,permissions:{billingAccess:profile.role==='ADMINISTRADOR'||profile.permissions.billingAccess===true},updatedAt:serverTimestamp(),updatedBy:actorUid,...(!old.exists()?{createdAt:serverTimestamp(),createdBy:actorUid}:{})},{merge:true});
}
