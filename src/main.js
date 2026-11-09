import {clearExportCache} from './billing-export-cache.js';
import {monthlyAnalytics} from './monthly-analytics.js';
import {testOTSearchIndex,buildSearchIndex,retryPendingOTIndexes} from './data.js';
import './style.css';
import {auth} from './firebase.js';
import {onAuthStateChanged,signInWithEmailAndPassword,signOut} from 'firebase/auth';
import {doc,onSnapshot,collection,query,orderBy,limit,addDoc,serverTimestamp,Timestamp,getDoc} from 'firebase/firestore';
import {db} from './firebase.js';
import {profile,page,createOT,addClient,updateClient,updateOT,saveOTControlled,correctOTHistoricalDetails,correctOTWorkDate,correctPendingReceptionDate,voidOT,sendLaboratoryOT,sendLaboratoryBatch,receiveLaboratory,receiveLaboratoryBatch,returnPendingOTs,deliverReport,deliverReportsBatch,returnReportToPending,returnAuthorizedToAuthorization,authorizeReport,authorizeReportsBatch,publishPortalOT,publishPortalBatch,fetchBillingPage,searchBillingGlobal,exportBillingHistory,fetchAdmittedPage,searchSupervisionGlobal,saveBilling,saveBillingBatch,fetchOT,count,supervisionCounts,watchPage,watchCounters,countOTStage,countMeasurementOTs,operationMenuCounts,verifyServer,initializeCounters,checkCounterConsistency,searchClients,clientCatalogPage,addBranch,importCatalogClient,lookupCatalogName,searchMonitorings,saveMonitoring,listMonitorings,exportAllMonitorings,nextOTSequence,scanOTHistory,searchOTIndexedPrefixes,searchOTIndexOperational,searchLaboratoryStage,findOTByExactCode,listRegistrationResponsibles,addRegistrationResponsible,listUserProfiles,saveUserProfile} from './data.js';
const $=s=>document.querySelector(s);const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sections=[['dashboard','▦','Centro de control'],['trace','⌕','Consulta y trazabilidad'],['ots','◈','Mediciones ambientales'],['laboratory','⚗','Ingreso de laboratorio'],['billing','▣','Facturación'],['supervision','◉','Supervisión de informes'],['clients','♧','Clientes'],['monitorings','◫','Catálogo de monitoreos'],['users','♙','Usuarios y permisos'],['migration','⇧','Importación histórica'],['diagnostics','◉','Diagnóstico Firebase']];
const APP_VERSION='V1.0.1.34';
// Resolución visual por ID: NO escribe en las OT ni altera sus nombres históricos.
// Una lectura por cliente distinto (máximo 15 min en memoria); sin listeners adicionales.
const catalogNameCache=new Map();
async function displayCatalogNames(rows){
 const ids=[...new Set(rows.map(r=>r.clientId).filter(Boolean))];
 await Promise.all(ids.map(async id=>{
  const old=catalogNameCache.get(id);
  if(old && Date.now()-old.at<15*60*1000)return;
  if(!navigator.onLine)return;
  try{const snap=await getDoc(doc(db,'clients',id));catalogNameCache.set(id,{at:Date.now(),data:snap.exists()?snap.data():null});}
  catch(err){console.warn('Nombre de catálogo no disponible; se conserva el de la OT',err)}
 }));
 return rows.map(r=>{
  const client=catalogNameCache.get(r.clientId)?.data;
  if(!client)return r;
  const branch=(client.branches||[]).find(b=>b.id===r.branchId);
  return {...r,clientName:client.name||r.clientName,branchName:branch?.name||r.branchName};
 });
}

const BUILD_LABEL=APP_VERSION+' · RECTIFICACIÓN DE AUTORIZACIÓN';
const labGlobal={active:false,rows:[],token:0,timer:null,truncated:false,cache:new Map()};
const otGlobal={cache:null,loadedAt:0,fullCache:null,fullLoadedAt:0,scanPromise:null,active:false,loading:false,timer:null,token:0};
const state={user:null,profile:null,view:'dashboard',rows:{},busy:false,watchStop:null,watchView:null,watchGeneration:0,lastSync:null,paging:{},counterStop:null,serverVerified:false,selectedOTs:new Map(),selectedLabOTs:new Map(),selectedReportOTs:new Map(),selectedAuthOTs:new Map(),selectedPortalOTs:new Map(),selectedBillingOTs:new Map(),billingDrafts:new Map()};
function stopCounters(){if(state.counterStop){state.counterStop();state.counterStop=null}}
// V1.0.0.66: valores persistentes; ninguna consulta periódica ni conteos vacíos al navegar.
let menuCountTimer=null,menuCountBusy=false,menuCountGeneration=0,menuCountLastAt=0;
let menuCountValues=null,menuCountPromise=null,menuCountQueued=false;
const MENU_CACHE_KEY='psi-gases-menu-counts-v68';
let menuSummaryStop=null;
try{const saved=JSON.parse(localStorage.getItem(MENU_CACHE_KEY)||'null')||JSON.parse(sessionStorage.getItem('psi-gases-menu-counts-v66')||'null');if(saved&&saved.values&&Number.isFinite(saved.at)){menuCountValues=saved.values;menuCountLastAt=saved.at}}catch{}
function paintMenuCounts(){
 if(!menuCountValues)return;
 for(const [id,value] of Object.entries(menuCountValues)){
  const el=document.getElementById('nav-'+id+'-total');
  if(el&&Number.isFinite(value)){el.textContent=value.toLocaleString('es-EC');el.hidden=false;el.title='Último conteo confirmado por Firestore';}
 }
}
async function refreshMenuCounts(force=false){
 if(!state.user||!state.profile||!navigator.onLine)return;
 paintMenuCounts();
 if(menuCountPromise){if(force)menuCountQueued=true;return menuCountPromise;}
 // Conteos costosos: una sola lectura inicial por sesión; las operaciones locales pueden forzar actualización.
 if(!force&&menuCountValues&&Date.now()-menuCountLastAt<15*60*1000)return;
 menuCountBusy=true;
 menuCountPromise=(async()=>{
  try{
   const counts=await operationMenuCounts();
   menuCountValues={...(menuCountValues||{}),...Object.fromEntries(Object.entries(counts).filter(([k,v])=>k!=='ots'&&Number.isFinite(v)))};menuCountLastAt=Date.now();
   try{localStorage.setItem(MENU_CACHE_KEY,JSON.stringify({values:menuCountValues,at:menuCountLastAt}))}catch{}
   paintMenuCounts();
  }catch(e){console.warn('Contadores: se conserva el último valor conocido',e);paintMenuCounts()}
  finally{menuCountBusy=false;menuCountPromise=null;if(menuCountQueued){menuCountQueued=false;queueMicrotask(()=>refreshMenuCounts(true))}}
 })();
 return menuCountPromise;
}
function startMenuCounts(){
 menuCountGeneration++;paintMenuCounts();refreshMenuCounts();
 // ÚNICA suscripción compartida al resumen ya transaccional (OT y clientes).
 // No se crean listeners por pestaña ni por filtro.
 if(!menuSummaryStop)menuSummaryStop=watchCounters(({ready,counts})=>{
  if(!ready||!Number.isFinite(counts?.ots))return;
  menuCountValues={...(menuCountValues||{}),ots:counts.ots};
  try{localStorage.setItem(MENU_CACHE_KEY,JSON.stringify({values:menuCountValues,at:menuCountLastAt}))}catch{}
  paintMenuCounts();
  if(measurementCountValues){measurementCountValues.total=counts.ots;try{sessionStorage.setItem('psi-gases-measurement-counts-v66',JSON.stringify(measurementCountValues))}catch{}}
  if(state.view==='ots'){
   const total=document.querySelector('#ot-global-total');if(total)total.textContent=counts.ots.toLocaleString('es-EC');
  }
 },err=>console.warn('Resumen central no disponible',err));
}
function stopMenuCounts(){menuCountGeneration++;if(menuCountTimer)clearInterval(menuCountTimer);menuCountTimer=null;if(menuSummaryStop){menuSummaryStop();menuSummaryStop=null}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshMenuCounts();if(state.view==='laboratory')refreshLaboratoryStageCounts(true)}});
window.addEventListener('online',()=>{if(state.view==='laboratory')setTimeout(()=>refreshLaboratoryStageCounts(true),1400);setTimeout(()=>refreshMenuCounts(),1200);setTimeout(()=>retryPendingOTIndexes().catch(console.warn),2500)});
function stopWatch(){state.watchGeneration++;if(state.watchStop){state.watchStop();state.watchStop=null}state.watchView=null}
function syncLabel(message){const el=$('#sync-label');if(el)el.textContent=message}
window.addEventListener('online',()=>{state.serverVerified=false;syncLabel('Reconectando · esperando confirmación del servidor');});
window.addEventListener('offline',()=>{state.serverVerified=false;syncLabel('SIN CONEXIÓN · operaciones críticas bloqueadas');});

const role=()=>state.profile?.role||'SIN PERFIL';const isAdmin=()=>role()==='ADMINISTRADOR';
const canBilling=()=>isAdmin()||(role()==='OPERACIONES'&&state.profile?.permissions?.billingAccess===true);
function toast(message,bad=false){let el=$('#toast');if(!el)return;el.textContent=message;el.className='notice'+(bad?' warn':'');el.classList.remove('hide');setTimeout(()=>el.classList.add('hide'),6500)}
function login(){document.querySelector('#app').innerHTML=`<div class="login-wrap"><div class="login-side"><div style="font-size:25px;font-weight:800">◈ PSI <span style="opacity:.7">/ NEXTGEN</span></div><h1>Gestión ambiental.<br>Una nueva era.</h1><p>Plataforma independiente para mediciones ambientales, laboratorio, informes y control administrativo. Diseñada para trabajar con agilidad y trazabilidad.</p><div style="margin-top:55px;font-size:12px;letter-spacing:2px">ERP GASES NEXTGEN · 2027 · ${APP_VERSION}</div></div><div class="login-card"><form id="login" class="login-box"><div class="chip" style="display:inline-block;margin-bottom:20px">● ACCESO SEGURO</div><h2>Bienvenido de nuevo</h2><p class="muted">Ingrese con su cuenta de Firebase Authentication.</p><label class="field">Correo electrónico<input name="email" type="email" autocomplete="username" required placeholder="correo@psi.com.ec"></label><label class="field">Contraseña<input name="password" type="password" autocomplete="current-password" required placeholder="••••••••"></label><button class="btn">Ingresar al sistema →</button><div class="error" id="login-error"></div><p class="muted" style="margin-top:24px">Proyecto: nuevo-erp-gases · Plan Spark · ${APP_VERSION}</p></form></div></div>`;$('#login').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;$('#login-error').textContent='';try{await signInWithEmailAndPassword(auth,e.target.email.value.trim(),e.target.password.value)}catch(err){$('#login-error').textContent='No fue posible ingresar: '+err.code;b.disabled=false}}}
function shell(){
 const p=state.profile;
 const catalogOpen=state.view==='clients'||state.view==='monitorings'||sessionStorage.getItem('psi-catalog-open')==='1';
 const navButton=([id,icon,label],sub=false)=>`<button class="nav ${sub?'nav-sub':''} ${state.view===id?'active':''}" data-nav="${id}" title="${escape(label)}"><span class="nav-icon" aria-hidden="true">${icon}</span><span class="nav-text">${escape(label)}</span>${['ots','laboratory','billing','supervision'].includes(id)?`<span class="nav-count" id="nav-${id}-total" title="Conteo del flujo en Firestore">—</span>`:''}</button>`;
 const operations=sections.filter(x=>['ots','laboratory','supervision'].includes(x[0])||(x[0]==='billing'&&canBilling()));
 const admin=isAdmin()?sections.filter(x=>['users','migration','diagnostics'].includes(x[0])):[];
 $('#app').innerHTML=`<div class="app"><aside class="sidebar"><div class="brand"><div class="brand-mark">◈</div><div class="brand-text"><strong>PSI GASES</strong><small>NEXTGEN · 2027</small></div></div><div class="sidebar-scroll"><div class="nav-label">GENERAL</div>${navButton(sections[0])}${navButton(sections.find(x=>x[0]==='trace'))}<div class="nav-label nav-group">OPERACIONES</div>${operations.map(x=>navButton(x)).join('')}<div class="nav-label nav-group">ADMINISTRACIÓN</div><button class="nav nav-catalog-toggle ${catalogOpen?'expanded':''} ${['clients','monitorings'].includes(state.view)?'catalog-active':''}" id="catalog-toggle" aria-expanded="${catalogOpen}" aria-controls="catalog-submenu" title="Catálogos"><span class="nav-icon">▤</span><span class="nav-text">Catálogos</span><span class="nav-chevron" aria-hidden="true">⌄</span></button><div class="catalog-submenu ${catalogOpen?'':'hide'}" id="catalog-submenu">${navButton(sections.find(x=>x[0]==='clients'),true)}${navButton(sections.find(x=>x[0]==='monitorings'),true)}</div>${admin.map(x=>navButton(x)).join('')}</div><div class="sidebar-bottom"><span class="app-version">${APP_VERSION} · Versión instalada</span><br><span class="online-dot"></span> Firebase Spark<br><span style="color:#8fc0a8">Sincronización selectiva</span></div></aside><div class="main"><header class="top"><div class="crumb">PSI / ERP Gases <strong id="current-title">${escape(sections.find(x=>x[0]===state.view)?.[2])}</strong></div><div class="top-actions"><button id="update-alert" class="update-alert hide" type="button" title="Cargar nueva versión" aria-live="polite">⬆ Nueva actualización disponible · Actualizar</button><span class="version-chip" title="Versión instalada">${APP_VERSION}</span><span class="sync-status" title="Consultas a Firestore bajo demanda"><span class="online-dot"></span> <span id="sync-label">Spark · sincronización selectiva</span></span><button class="btn alt notify-trigger" id="notify-toggle" type="button" title="Eventos de las últimas 48 horas">🔔 <span id="notify-count">—</span></button><span class="chip">● ${escape(role())}</span><span class="avatar">${escape((p?.name||state.user.email||'U').slice(0,1).toUpperCase())}</span><button id="logout" class="btn alt">Salir</button></div></header><main class="content" id="content"></main></div></div>`;
 paintMenuCounts();initNotificationsUI();document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{stopWatch();stopCounters();state.view=b.dataset.nav;if(state.view==='billing'&&!canBilling()){state.view='dashboard';return shell()}if(['clients','monitorings'].includes(state.view))sessionStorage.setItem('psi-catalog-open','1');shell();render();refreshMenuCounts()});
 $('#catalog-toggle').onclick=()=>{const sub=$('#catalog-submenu');const open=sub.classList.toggle('hide')===false;$('#catalog-toggle').setAttribute('aria-expanded',String(open));$('#catalog-toggle').classList.toggle('expanded',open);sessionStorage.setItem('psi-catalog-open',open?'1':'0')};
 $('#update-alert').onclick=async()=>{if(!confirm('Hay una nueva versión disponible. ¿Actualizar ahora? Los formularios sin guardar se perderán.'))return;try{const reg=await navigator.serviceWorker?.getRegistration();await reg?.update()}catch{}location.reload()};checkForUpdates();
 $('#logout').onclick=()=>{stopAccessProfile();stopWatch();stopCounters();stopMenuCounts();menuCountValues=null;localStorage.removeItem(MENU_CACHE_KEY);clearExportCache().finally(()=>signOut(auth))};render();startMenuCounts()
}
function hero(title,desc,extra=''){$('#content').innerHTML=`<div class="hero"><div><div class="eyebrow">PSI · SISTEMA DE GESTIÓN AMBIENTAL</div><h1>${title}</h1><p>${desc}</p></div><div class="hero-badge"><strong>2027</strong>ERP GASES NEXTGEN</div></div>${extra}${["ots","laboratory","billing","supervision"].includes(state.view)?`<div class="psi-status-guide" aria-label="Leyenda de estados"><span class="psi-guide-title">SEGUIMIENTO VISUAL</span><span class="psi-guide-item psi-guide-ok"><i></i>En plazo</span><span class="psi-guide-item psi-guide-warn"><i></i>Próximo a vencer</span><span class="psi-guide-item psi-guide-danger"><i></i>Vencido</span><span class="psi-guide-item psi-guide-progress"><i></i>En proceso</span><span class="psi-guide-item psi-guide-neutral"><i></i>Sin fecha</span><span class="psi-guide-help">Los semáforos de plazo se calculan con fechas reales disponibles.</span></div>`:""}<div id="toast" class="hide"></div>`}

// Notificaciones acotadas: una sola suscripción de 20 documentos, solo con sesión activa.
// La expiración visual es de 48 h; el TTL del servidor se habilita por separado.
const EVENT_MS=48*60*60*1000;
let notificationStop=null,notificationRows=[],notificationOpen=false;
const eventLabels={REGISTER:'Monitoreo registrado',RECEPTION:'Fecha de recepción confirmada',AUTHORIZATION:'Informe autorizado'};
async function emitEvent(type,code,otId){
 if(!state.user||!navigator.onLine||!eventLabels[type])return;
 await addDoc(collection(db,'otNotifications'),{type,code:String(code||'').slice(0,30),otId:String(otId||''),actorId:state.user.uid,createdAt:serverTimestamp(),expiresAt:Timestamp.fromMillis(Date.now()+EVENT_MS)});
}
function stopNotifications(){if(notificationStop){notificationStop();notificationStop=null}notificationRows=[];notificationOpen=false}
function startNotifications(){stopNotifications();if(!state.user)return;
 notificationStop=onSnapshot(query(collection(db,'otNotifications'),orderBy('createdAt','desc'),limit(20)),snap=>{
  notificationRows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.createdAt?.toMillis&&x.createdAt.toMillis()>Date.now()-EVENT_MS);
  paintNotifications();
 },err=>{console.warn('Notificaciones no disponibles:',err.code||err.message);const e=$('#notify-count');if(e)e.textContent='—'});
}
function initNotificationsUI(){const b=$('#notify-toggle');if(!b)return;b.onclick=()=>{notificationOpen=!notificationOpen;paintNotifications()};paintNotifications()}
function paintNotifications(){const count=$('#notify-count');if(count)count.textContent=String(notificationRows.length);
 document.querySelector('#notification-popover')?.remove();if(!notificationOpen||!count)return;
 const box=document.createElement('div');box.id='notification-popover';box.className='notification-popover';
 box.innerHTML='<h3>🔔 Actividad reciente</h3><small>Solo últimos 2 días · máximo 20 eventos</small>'+ (notificationRows.length?notificationRows.map(x=>`<button class="notification-item" data-event-ot="${escape(x.code)}"><b>${escape(x.code)}</b> · ${escape(eventLabels[x.type]||x.type)}<small>${escape(x.createdAt?.toDate?.().toLocaleString('es-EC')||'Reciente')}</small></button>`).join(''):'<p class="muted">Sin eventos recientes.</p>');
 document.querySelector('.top-actions')?.appendChild(box);
 box.querySelectorAll('[data-event-ot]').forEach(b=>b.onclick=()=>{notificationOpen=false;state.view='trace';stopWatch();stopCounters();shell();render();const inp=$('#trace-code');if(inp){inp.value=b.dataset.eventOt;$('#trace-search').click()}});
}
async function traceView(){
 $('#content').innerHTML=`<section class="panel trace-panel"><h2>⌕ Consulta inteligente de OT</h2><p class="muted">Busca por correlativo (00120), código completo (RR260120) o serie (RR-00120). Consultas puntuales, sin descargar el histórico.</p><div class="trace-search"><input id="trace-code" placeholder="Ej.: 00120 · RR260120 · RG-00120" maxlength="24" autocomplete="off"><button class="btn" id="trace-search">⌕ Buscar expediente</button></div><div id="trace-results" aria-live="polite" class="muted">Escriba un código para consultar.</div></section>`;
 const input=$('#trace-code'),out=$('#trace-results');let request=0;
 const dateText=v=>{if(!v)return 'Sin confirmar';if(typeof v?.toDate==='function')return v.toDate().toLocaleString('es-EC');return String(v)};
 const openDetail=r=>{
  document.querySelector('#trace-dialog')?.remove();
  const steps=[['Registro de monitoreo',r.createdAt||r.workDate],['Recepción de laboratorio',r.laboratory?.receivedAt],['Entrega de informe',r.deliveryRealAt||r.report?.deliveryRealAt],['Autorización',r.authorizationAt],['Publicación',r.portalPublishedAt]];
  const host=document.createElement('div');host.id='trace-dialog';host.className='trace-overlay';host.innerHTML=`<div class="trace-modal" role="dialog" aria-modal="true" aria-label="Expediente ${escape(r.code)}"><div class="trace-modal-head"><div><small>PSI GASES · TRAZABILIDAD</small><h2>${escape(r.code)} <span class="tag">${escape(r.status||'Sin estado')}</span></h2></div><button type="button" class="btn alt" id="trace-close">✕ Cerrar</button></div><div class="trace-facts"><div><small>Cliente</small><b>${escape(r.clientName||'—')}</b></div><div><small>Sucursal</small><b>${escape(r.branchName||'—')}</b></div><div><small>Monitoreo</small><b>${escape(r.monitoring||'—')}</b></div><div><small>Puntos</small><b>${escape(r.points??'—')}</b></div><div><small>Fecha de trabajo</small><b>${escape(dateText(r.workDate))}</b></div><div><small>Responsable</small><b>${escape(r.laboratory?.analyst||'—')}</b></div></div><h3>Recorrido del expediente</h3><div class="trace-timeline-vertical">${steps.map(([label,value],i)=>`<div class="trace-step ${value?'done':''}"><span>${value?'✓':'○'} ${i+1}. ${escape(label)}</span><small>${escape(dateText(value))}</small></div>`).join('')}</div>${canBilling()?'<p class="muted">Los detalles económicos se consultan únicamente desde Facturación.</p>':''}</div>`;
  document.body.appendChild(host);host.querySelector('#trace-close').onclick=()=>host.remove();host.onclick=e=>{if(e.target===host)host.remove()};host.onkeydown=e=>{if(e.key==='Escape')host.remove()};host.querySelector('#trace-close').focus();
 };
 const search=async()=>{const token=++request;const raw=input.value.trim().toUpperCase().replace(/[\s-]/g,'');let codes=[];
  if(/^(RR|RG)\d{6}$/.test(raw))codes=[raw];
  else {const match=raw.match(/^(RR|RG)?(\d{1,4})$/);if(!match){out.textContent='Use un correlativo de 1 a 4 dígitos (ej. 00120), o el código completo RR260120.';return}
   const series=match[1]?[match[1]]:['RR','RG'];const n=String(Number(match[2])).padStart(4,'0');
   // Prioridad al año operativo actual; los demás años se consultan solo si no hay resultados.
   const yy=String(new Date().getFullYear()).slice(-2);codes=series.map(prefix=>prefix+yy+n);
  }
  out.textContent='Buscando en Firebase…';
  try{let results=await Promise.all(codes.map(c=>findOTByExactCode(c)));let rows=results.flatMap(r=>r.rows);
   if(!rows.length&&!/^(RR|RG)\d{6}$/.test(raw)){
    const match=raw.match(/^(RR|RG)?(\d{1,4})$/),series=match[1]?[match[1]]:['RR','RG'],n=String(Number(match[2])).padStart(4,'0');
    const years=[2026,2027,2025,2024,2023,2022,2021,2020].filter(y=>String(y).slice(-2)!==String(new Date().getFullYear()).slice(-2));
    for(const year of years){const checks=await Promise.all(series.map(prefix=>findOTByExactCode(prefix+String(year).slice(-2)+n)));rows.push(...checks.flatMap(r=>r.rows));if(rows.length)break}
   }
   if(token!==request||state.view!=='trace')return;
   if(!rows.length){out.textContent='No se encontraron coincidencias en los años consultados. Verifique el código completo en Mediciones ambientales.';return}
   const unique=await displayCatalogNames([...new Map(rows.map(r=>[r.id,r])).values()]);if(token!==request||state.view!=='trace')return;out.innerHTML=`<p class="muted">${unique.length} expediente(s) encontrado(s).</p><div class="trace-cards">${unique.map((r,i)=>`<article class="trace-result"><div><h3>${escape(r.code)}</h3><p>${escape(r.clientName||'Cliente no registrado')} · ${escape(r.branchName||'Sin sucursal')}</p><small>${escape(r.status||'Sin estado')} · ${escape(r.points??'—')} puntos</small></div><button class="btn" data-trace-open="${i}">Ver expediente →</button></article>`).join('')}</div>`;
   out.querySelectorAll('[data-trace-open]').forEach(btn=>btn.onclick=()=>openDetail(unique[Number(btn.dataset.traceOpen)]));
  }catch(e){if(token===request)out.textContent='No se pudo consultar Firebase: '+(e.message||e.code)}
 };
 $('#trace-search').onclick=search;input.onkeydown=e=>{if(e.key==='Enter')search()};
}

function render(){if(state.view==='billing'&&!canBilling()){state.view='dashboard';shell();return}if(['users','migration','diagnostics'].includes(state.view)&&!isAdmin()){state.view='dashboard';shell();return}if(state.view==='trace')traceView();else if(state.view==='dashboard')dashboard();else if(state.view==='ots')listView('ots');else if(state.view==='clients')clientsCatalogView();else if(state.view==='monitorings')monitoringsView();else if(state.view==='laboratory')listView('laboratory');else if(state.view==='billing')billingView();else if(state.view==='supervision')supervisionView();else if(state.view==='users')users();else if(state.view==='diagnostics')diagnostics();else migration()}
function dashboard(){
 stopCounters();
 hero('Centro de control inteligente','Indicadores verificables, seguimiento por etapas y alertas operativas sin lecturas masivas.');
 $('#content').insertAdjacentHTML('beforeend',`<section class="control26"><div class="section-heading"><div><h2>Panorama general · PSI Gases</h2><p>Conteos consolidados y bandejas operativas. Las cifras no disponibles se muestran como pendientes, nunca como cero.</p></div><button id="refresh-counts" class="btn alt">↻ Actualizar indicadores</button></div><p id="counter-info" class="muted">Esperando datos de Firestore…</p><div class="control26-kpis"><article class="control26-card blue"><small>OT registradas · histórico</small><strong id="m-ots">—</strong><span>Resumen central</span></article><article class="control26-card green"><small>Clientes registrados</small><strong id="m-clients">—</strong><span>Catálogo central</span></article><article class="control26-card amber"><small>Por enviar a laboratorio</small><strong id="c26-pending">—</strong><span>Bandeja de registro</span></article><article class="control26-card teal"><small>Ingresadas al laboratorio</small><strong id="c26-admitted">—</strong><span>Expedientes técnicos</span></article></div><div class="control26-grid"><div class="panel"><h3>◉ Distribución operativa confirmada</h3><p class="muted">Comparación de las bandejas disponibles, sin estimar estados no consultados.</p><div id="c26-bars" class="control26-bars"><p class="muted">Esperando contadores…</p></div><small id="c26-source" class="muted">Sin consultas masivas adicionales.</small></div><div class="panel"><h3>⚑ Semáforo de gestión</h3><div class="control26-alerts"><div><b class="control26-dot green"></b><strong>Verde · operativo</strong><small>Conectado y con datos confirmados.</small></div><div><b class="control26-dot amber"></b><strong>Ámbar · seguimiento</strong><small>Órdenes pendientes de envío o revisión.</small></div><div><b class="control26-dot red"></b><strong>Rojo · vencimiento</strong><small>Solo se activa con fechas máximas verificadas.</small></div><div><b class="control26-dot gray"></b><strong>Gris · sin dato</strong><small>No se interpreta como cumplimiento.</small></div></div><p id="c26-alert" class="control26-notice">Los vencimientos globales requieren un agregado transaccional específico; no se calculan leyendo todas las OT al abrir el panel.</p></div></div><div class="panel control27-panel"><div class="section-heading"><div><h3>📊 Producción mensual · RR y RG</h3><p>OT generadas en el mes y suma real de puntos por serie. Seleccione la fecha de referencia: inicio del trabajo (histórico) o creación en Firebase. No se mezclan ambas fechas.</p></div><div class="control27-actions"><label>Fecha de referencia <select id="c27-basis"><option value="workDate">Inicio del trabajo · histórico</option><option value="createdAt">Creación en Firebase</option></select></label><label>Mes <input type="month" id="c27-month"></label><button class="btn alt" id="c27-update">↻ Consultar mes</button></div></div><p id="c27-status" class="muted">Seleccione un mes para consultar.</p><div class="control27-cards" id="c27-cards"></div><div id="c27-chart" class="control27-chart"></div><small class="muted">Cálculos agregados en Firestore (COUNT y SUM); no se descargan las OT. Se reutilizan durante 15 minutos por sesión. La consulta puede requerir índices compuestos; las OT históricas sin fecha de creación no se incluyen. Los puntos reflejan el valor actual de cada OT.</small></div><div class="panel"><h3>Ruta de trazabilidad</h3><div class="control26-flow"><span>01 · Registro</span><span>02 · Laboratorio</span><span>03 · Informe</span><span>04 · Autorización</span><span>05 · Portal</span><span>06 · Facturación</span></div><p class="muted">Cada proceso mantiene sus permisos y registros de auditoría. La información económica permanece exclusivamente en Facturación.</p></div></section>`);
 const monthInput=$('#c27-month');monthInput.value=new Date().toISOString().slice(0,7);
 let analyticsToken=0;
 const loadMonthly=async(force=false)=>{
  const token=++analyticsToken,btn=$('#c27-update'),status=$('#c27-status');
  const [y,m]=monthInput.value.split('-').map(Number);
  if(!y||!m)return;
  btn.disabled=true;status.textContent='Consultando agregados RR y RG en Firestore…';
  try{
   const data=await monthlyAnalytics(y,m,{force,basis:$('#c27-basis').value});if(token!==analyticsToken||state.view!=='dashboard')return;
   const rr=data.rows.find(r=>r.series==='RR'),rg=data.rows.find(r=>r.series==='RG');
   const total=rr.orders+rg.orders,points=rr.points+rg.points;
   const fmt=n=>n.toLocaleString('es-EC',{maximumFractionDigits:2});
   $('#c27-cards').innerHTML=[['RR · OT generadas',rr.orders,'blue'],['RR · puntos',rr.points,'blue'],['RG · OT generadas',rg.orders,'green'],['RG · puntos',rg.points,'green'],['Total OT del mes',total,'teal'],['Total puntos del mes',points,'teal']].map(([label,n,tone])=>`<article class="control26-card ${tone}"><small>${label}</small><strong>${fmt(n)}</strong><span>${escape(data.period)}</span></article>`).join('');
   const max=Math.max(1,rr.orders,rg.orders,rr.points,rg.points);
   $('#c27-chart').innerHTML=`<h4>Comparación RR / RG · OT y puntos</h4>`+[['RR · OT',rr.orders],['RG · OT',rg.orders],['RR · puntos',rr.points],['RG · puntos',rg.points]].map(([label,n])=>`<div class="control26-bar"><div><span>${label}</span><b>${fmt(n)}</b></div><i><em style="width:${100*n/max}%"></em></i></div>`).join('');
   status.textContent=`${data.cached?'Caché temporal':'Agregado confirmado en servidor'} · ${data.basis==='workDate'?'Inicio del trabajo':'Creación en Firebase'} · ${data.period} · ${total} OT · ${fmt(points)} puntos`;
  }catch(err){if(token!==analyticsToken)return;status.textContent='No fue posible consultar los agregados: '+(err.code||err.message)+'. Revise los índices de Firestore y vuelva a intentar.';$('#c27-cards').innerHTML='';$('#c27-chart').innerHTML='';}
  finally{if(token===analyticsToken)btn.disabled=false}
 };
 $('#c27-update').onclick=()=>loadMonthly(true);
 monthInput.onchange=()=>loadMonthly();
 $('#c27-basis').onchange=()=>loadMonthly();
 loadMonthly();
 const paint=()=>{
  if(state.view!=='dashboard')return;
  const vals=menuCountValues||{};
  const get=(keys)=>{for(const k of keys){if(Number.isFinite(vals[k]))return vals[k]}return null};
  const pending=get(['otsPending','registered','pending','measurementsPending','otsRegistered']);
  const admitted=get(['laboratory','admitted','laboratoryTotal']);
  const entries=[['Por enviar a laboratorio',pending],['Ingresadas al laboratorio',admitted]];
  const set=(id,v)=>{const el=$(id);if(el)el.textContent=Number.isFinite(v)?v.toLocaleString('es-EC'):'—'};
  set('#c26-pending',pending);set('#c26-admitted',admitted);
  const known=entries.filter(x=>Number.isFinite(x[1]));const max=Math.max(1,...known.map(x=>x[1]));
  $('#c26-bars').innerHTML=known.length?known.map(([name,n])=>`<div class="control26-bar"><div><span>${escape(name)}</span><b>${n.toLocaleString('es-EC')}</b></div><i><em style="width:${Math.max(n?2:0,100*n/max)}%"></em></i></div>`).join(''):'<p class="muted">No hay conteos de etapa confirmados en el resumen disponible. Consulte las bandejas para sus indicadores específicos.</p>';
  $('#c26-source').textContent=menuCountLastAt?'Última consulta de bandejas: '+new Date(menuCountLastAt).toLocaleString('es-EC')+' · Los datos pueden estar en caché.':'Conteos por etapa aún no disponibles.';
  $('#c26-alert').textContent=Number.isFinite(pending)&&pending>0?`${pending.toLocaleString('es-EC')} OT pendientes de envío a laboratorio. Revisar la bandeja antes de programar.`:'Los vencimientos globales requieren un agregado transaccional específico; no se infieren a partir de una página de 10 OT.';
 };
 paint();
 state.counterStop=watchCounters(({ready,counts,fromCache,pending})=>{
  if(state.view!=='dashboard')return;
  if(ready){$('#counter-info').textContent=fromCache?'Datos del resumen en caché · esperando confirmación del servidor.':pending?'Resumen con cambios pendientes.':'Resumen central confirmado por Firestore.';$('#m-ots').textContent=Number.isFinite(counts.ots)?counts.ots.toLocaleString('es-EC'):'—';$('#m-clients').textContent=Number.isFinite(counts.clients)?counts.clients.toLocaleString('es-EC'):'—';paint()}
  else $('#counter-info').textContent='Resumen central no inicializado. Puede consultar los totales manualmente sin descargar el histórico.';
 },err=>{const e=$('#counter-info');if(e)e.textContent='Error de sincronización: '+(err.code||'desconocido')});
 $('#refresh-counts').onclick=async()=>{const btn=$('#refresh-counts');btn.disabled=true;try{const [ots,clients]=await Promise.all([count('ots'),count('clients')]);$('#m-ots').textContent=ots.toLocaleString('es-EC');$('#m-clients').textContent=clients.toLocaleString('es-EC');await refreshMenuCounts(true);paint();toast('Indicadores consultados correctamente')}catch(e){toast('No se pudieron consultar los indicadores: '+e.message,true)}finally{btn.disabled=false}};
}
const tableConfigs={ots:['Órdenes de trabajo','Registro de mediciones y seguimiento ambiental.','ots'],clients:['Clientes','Catálogo compartido de clientes.','clients'],laboratory:['Ingreso de laboratorio','Recepción transaccional de OT y responsable técnico.','ots'],reports:['Informes y autorización','Seguimiento de expedientes y autorizaciones.','ots'],billing:['Facturación','Gestión administrativa de órdenes de trabajo.','ots']};
function pagingState(view){return state.paging[view] ||= {size:10,index:0,cursors:[null]}}
function listView(view){
 if(view==='ots')return environmentalMenu();
 if(view==='laboratory')return laboratoryPipeline();
 const [title,desc]=tableConfigs[view];const create=view==='ots'||view==='clients';
 hero(title,desc);
 $('#content').insertAdjacentHTML('beforeend',`<div class="section-heading"><div><h2>${title}</h2><p>Sincronización automática de la página visible; el histórico se consulta por páginas.</p></div>${create?`<button class="btn" id="create">+ ${view==='ots'?'Nueva OT':'Nuevo cliente'}</button>`:''}</div><div class="panel"><div class="toolbar"><label class="muted" for="page-size">Registros por página</label><select id="page-size" aria-label="Registros por página"><option value="10">10</option><option value="25">25</option><option value="50">50</option></select><button id="prev" class="btn ghost" disabled>← Anterior</button><button id="next" class="btn ghost" disabled>Siguiente →</button><button id="refresh" class="btn alt">↻ Actualizar vista</button><span class="muted" id="page-status">Conectando…</span></div><div class="table-wrap"><table class="table"><thead><tr>${(view==='clients'?['Cliente','Estado','Registro']:['Código','Cliente','Tipo','Estado','Fecha',...(['ots','laboratory'].includes(view)?['Acciones']:[])]).map(t=>`<th>${t}</th>`).join('')}</tr></thead><tbody id="rows"><tr><td colspan="5" class="empty">Cargando página visible…</td></tr></tbody></table></div></div><div id="modal"></div>`);
 const p=pagingState(view);$('#page-size').value=String(p.size);
 $('#page-size').onchange=e=>{p.size=Number(e.target.value);p.index=0;p.cursors=[null];attachPage(view)};
 $('#prev').onclick=()=>{if(p.index>0){p.index--;attachPage(view)}};
 $('#next').onclick=()=>{if(!state.rows[view]?.length||!p.hasMore||!p.lastCursor)return;p.cursors[p.index+1]=p.lastCursor;p.index++;attachPage(view)};
 $('#refresh').onclick=()=>attachPage(view);
 if(create)$('#create').onclick=()=>view==='ots'?otForm():clientForm();
 attachPage(view);
}

function billingView(){
 if(!canBilling()){state.view='dashboard';shell();return}
 stopWatch();hero('Facturación · control administrativo','Registro de cotizaciones, facturas y estados sin alterar el expediente técnico.');
 $('#content').insertAdjacentHTML('beforeend',`<div class="billing-dashboard" id="billing-dashboard" aria-label="Resumen de facturación de la página consultada"><div class="billing-dashboard-heading"><strong>Resumen de facturación</strong><span>Indicadores de la página consultada · sin lecturas adicionales</span></div><div class="billing-dashboard-grid" id="billing-dashboard-grid"><div class="billing-kpi"><strong>—</strong><small>Consultando…</small></div></div></div><div class="section-heading"><div><h2>Facturación de órdenes de trabajo</h2><p>Edición por registro, borradores locales y selección acumulativa entre páginas. Datos técnicos de solo lectura.</p></div></div><div class="panel"><div class="ot-filter-line"><input id="bill-search" type="search" placeholder="Buscar código, cliente o sucursal en todas las OT (mínimo 3 caracteres)…"><div class="ot-filter-controls"><label>Serie <select id="bill-series"><option value="all">RR + RG</option><option>RR</option><option>RG</option></select></label><label>Estado <select id="bill-status"><option value="all">Todos</option><option>PENDIENTE</option><option>FACTURADO</option><option>FACTURA PARCIAL</option><option>EN ESPERA</option><option>NO FACTURAR</option></select></label></div></div><div class="ot-batch-bar"><button class="btn alt" id="bill-select-visible">☑ Seleccionar visibles</button><button class="btn ghost" id="bill-clear">Limpiar selección</button><span class="tag" id="bill-selected">0 seleccionadas</span><label>Fecha de factura común <input id="bill-date" type="date"></label><button class="btn alt" id="bill-apply-date">Aplicar a borradores</button><button class="btn" id="bill-save-batch">Guardar seleccionadas</button></div><p class="muted">La selección se conserva al cambiar de filtro o página (máximo 20). Aplicar fecha solo modifica los borradores; «Guardar seleccionadas» confirma los cambios en Firebase. Los datos de cada OT se verifican antes de guardar.</p><div class="toolbar"><label>Registros por página <select id="bill-size"><option>10</option><option>25</option><option>50</option></select></label><button class="btn ghost" id="bill-prev">← Anterior</button><button class="btn ghost" id="bill-next">Siguiente →</button><button class="btn alt" id="bill-refresh">↻ Actualizar</button><span id="bill-info" class="muted">Consultando…</span></div><div class="billing-export-actions" style="display:flex;flex-wrap:wrap;gap:10px;margin:14px 0;align-items:center"><button class="btn alt" id="bill-export-all">⬇ Excel · Total de OT registradas</button><button class="btn" id="bill-export-admitted">⬇ Excel · OT ingresadas al laboratorio</button><span class="muted" id="bill-export-progress">Histórico completo · Orden predeterminado: RR → RG; fecha antigua → reciente; código menor → mayor. Acceso restringido.</span></div><div class="table-wrap"><table class="table billing-table"><thead><tr>${['Sel.','Código / etapa','Cliente / sucursal','Monitoreo / puntos','Recepción','Cotización','Factura','Fecha factura','Subtotal ($)','Estado','Observaciones','Acción'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody id="bill-rows"></tbody></table></div></div>`);
 const exportBilling=async(mode,button)=>{
  if(!canBilling()){toast('Sin autorización para exportar Facturación.',true);return}
  const old=button.textContent;button.disabled=true;button.textContent="⏳ Generando Excel…";
  const progress=$('#bill-export-progress');
  if(progress)progress.textContent='Preparando descarga completa desde Firebase…';
  try{
   const rows=await exportBillingHistory(mode,(scanned,processed,total)=>{if(progress)progress.textContent=total?`Consultadas ${scanned} OT · Documentos administrativos ${processed}/${total}`:`Consultadas ${scanned} OT…`});
   if(!rows.length)throw Error('No hay registros para exportar.');
   const {default:ExcelJS}=await import('exceljs');const wb=new ExcelJS.Workbook();wb.creator='PSI ERP GASES';wb.created=new Date();
   const ws=wb.addWorksheet(mode==='all'?'Total OT':'Ingresadas laboratorio',{views:[{state:'frozen',ySplit:7,xSplit:2}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0}});
   const cols=[['Código',r=>r.code,16],['Serie',r=>r.series,9],['Estado técnico',r=>r.status,23],['Cliente',r=>r.clientName,35],['Sucursal',r=>r.branchName,26],['Monitoreo',r=>r.monitoring,42],['Tipo',r=>r.type,16],['Puntos',r=>r.points,10],['Fecha inicio',r=>r.workDate,17],['Fecha recepción',r=>r.laboratory?.receivedAt||r.sampledAt,19],['Fecha máxima',r=>r.laboratory?.deadline||r.deadline,19],['Entrega real',r=>r.deliveryRealAt||r.report?.deliveryRealAt,18],['Autorización',r=>r.authorizationAt,18],['Estado autorización',r=>r.authorization?.state,20],['Fecha portal',r=>r.portalPublishedAt,18],['Cotización',r=>r.billing?.quote,20],['Factura',r=>r.billing?.invoice,20],['Fecha factura',r=>r.billing?.invoiceDate,18],['Subtotal (USD)',r=>r.billing?.subtotal,18],['Estado facturación',r=>r.billing?.state||'PENDIENTE',21],['Observaciones técnicas',r=>r.observations,45],['Observaciones administrativas',r=>r.billing?.note,45]];
   const n=cols.length,blue='173B5C',white='FFFFFF';ws.mergeCells(1,1,2,n);let c=ws.getCell(1,1);c.value='PSI  |  PRODUCTOS Y SERVICIOS INDUSTRIALES';c.font={name:'Arial',size:13,bold:true,color:{argb:white}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:blue}};c.alignment={vertical:'middle',indent:1};ws.getRow(1).height=23;ws.getRow(2).height=12;
   ws.mergeCells(3,1,3,n);c=ws.getCell(3,1);c.value=mode==='all'?'CONTROL ADMINISTRATIVO · TOTAL DE ÓRDENES DE TRABAJO':'CONTROL ADMINISTRATIVO · OT CON INGRESO OFICIAL';c.font={name:'Arial',size:11,bold:true,color:{argb:blue}};ws.getRow(3).height=23;
   ws.mergeCells(4,1,4,n);c=ws.getCell(4,1);c.value=`Generado: ${new Date().toLocaleString('es-EC')}    |    Total exportado: ${rows.length}    |    Orden: RR → RG · fecha antigua → reciente · código ascendente`;c.font={name:'Arial',size:9,color:{argb:'52677A'}};ws.getRow(4).height=19;
   ws.mergeCells(5,1,5,n);c=ws.getCell(5,1);c.value='Documento interno confidencial · Uso exclusivo de Administración y Facturación · Datos confirmados en Firestore';c.font={name:'Arial',size:9,italic:true,color:{argb:'167A70'}};ws.getRow(5).height=19;ws.getRow(6).height=8;
   const h=ws.getRow(7);h.values=[,...cols.map(x=>x[0])];h.height=30;h.eachCell(c=>{c.font={name:'Arial',size:9,bold:true,color:{argb:white}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:blue}};c.alignment={vertical:'middle',horizontal:'center',wrapText:true}});
   const dateCols=new Set([9,10,11,12,13,15,18]);
   rows.forEach((r,i)=>{const row=ws.getRow(i+8);row.values=[,...cols.map(([,fn],j)=>{const v=fn(r);if(dateCols.has(j+1)&&typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)){const [y,m,d]=v.split('-').map(Number);return new Date(y,m-1,d)}return v??''})];row.height=25;row.eachCell({includeEmpty:true},(c,j)=>{c.font={name:'Arial',size:9,color:{argb:'233849'},bold:j===1};c.alignment={vertical:'middle',wrapText:true};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:i%2?'F0F5F7':'FFFFFF'}};c.border={bottom:{style:'hair',color:{argb:'DCE6EA'}}};if(c.value instanceof Date)c.numFmt='dd/mm/yyyy';if(j===19&&typeof c.value==='number')c.numFmt='#,##0.00'})});
   cols.forEach((x,i)=>ws.getColumn(i+1).width=x[2]);ws.autoFilter={from:{row:7,column:1},to:{row:7,column:n}};ws.printTitlesRow='1:7';ws.headerFooter.oddFooter='PSI · Documento interno confidencial                         Página &P de &N';
   const buffer=await wb.xlsx.writeBuffer();const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`PSI_GASES_${mode==='all'?'TOTAL_OT':'OT_INGRESADAS'}_${new Date().toISOString().slice(0,10)}.xlsx`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);progress.textContent=`Excel generado: ${rows.length} registros`;toast('Excel generado: '+rows.length+' OT.');
  }catch(e){progress.textContent='Error de exportación';toast('No se pudo generar Excel: '+e.message,true)}finally{button.disabled=false;button.textContent=old}
 };
 $('#bill-export-all').onclick=e=>exportBilling('all',e.currentTarget);
 $('#bill-export-admitted').onclick=e=>exportBilling('admitted',e.currentTarget);
 const p=pagingState('billing');let loaded=[],version=0,loading=false,globalRows=null,searchTimer=null,searchWarning='';$('#bill-size').value=p.size;
 const draft=(r)=>{if(!state.billingDrafts.has(r.id))state.billingDrafts.set(r.id,{quote:r.billing?.quote||'',invoice:r.billing?.invoice||'',invoiceDate:r.billing?.invoiceDate||'',subtotal:r.billing?.subtotal??'',state:r.billing?.state||'PENDIENTE',note:r.billing?.note||'',version:r.billing?.version||0});return state.billingDrafts.get(r.id)};
 const eligible=r=>r.status!=='ANULADA'&&!['REGISTRADA','PROGRAMADA','EN_LABORATORIO'].includes(r.status);
 const visible=()=>{const term=$('#bill-search').value.toLocaleLowerCase('es'),series=$('#bill-series').value,st=$('#bill-status').value;return (globalRows||loaded).filter(r=>eligible(r)&&(series==='all'||r.series===series)&&(st==='all'||draft(r).state===st)&&[r.code,r.clientName,r.branchName,r.monitoring,draft(r).quote,draft(r).invoice].join(' ').toLocaleLowerCase('es').includes(term))};
 const updateSelected=()=>{$('#bill-selected').textContent=state.selectedBillingOTs.size+' seleccionadas'};
 const updateBillingDashboard=()=>{
  const eligibleRows=(globalRows||loaded).filter(eligible), filteredRows=visible();
  const states=['FACTURADO','FACTURA PARCIAL','PENDIENTE','EN ESPERA','NO FACTURAR'];
  const counts=Object.fromEntries(states.map(k=>[k,eligibleRows.filter(r=>draft(r).state===k).length]));
  const subtotal=eligibleRows.reduce((sum,r)=>{const n=Number(draft(r).subtotal);return sum+(Number.isFinite(n)&&n>0?n:0)},0);
  const cards=[['OT consultadas',eligibleRows.length],['Facturadas',counts.FACTURADO],['Factura parcial',counts['FACTURA PARCIAL']],['Pendientes',counts.PENDIENTE],['En espera',counts['EN ESPERA']],['No facturar',counts['NO FACTURAR']],['Subtotal de página',new Intl.NumberFormat('es-EC',{style:'currency',currency:'USD'}).format(subtotal)],['Visibles con filtros',filteredRows.length]];
  $('#billing-dashboard-grid').innerHTML=cards.map(([label,value])=>`<div class="billing-kpi"><strong>${escape(String(value))}</strong><small>${escape(label)}</small></div>`).join('');
 };

 const paint=()=>{const rows=visible();$('#bill-rows').innerHTML=rows.length?rows.map(r=>{const d=draft(r);return `<tr data-bill-row="${escape(r.id)}"><td><input type="checkbox" data-bill-check="${escape(r.id)}" ${state.selectedBillingOTs.has(r.id)?'checked':''} aria-label="Seleccionar ${escape(r.code)}"></td><td><b>${escape(r.code)}</b><small class="ot-cell-secondary">${escape(r.status)}</small></td><td><b>${escape(r.clientName)}</b><small class="ot-cell-secondary">${escape(r.branchName)}</small></td><td>${escape(r.monitoring)}<small class="ot-cell-secondary">${escape(r.points)} punto(s)</small></td><td>${escape(r.laboratory?.receivedAt||r.sampledAt||'—')}</td><td><input data-bill-field="quote" maxlength="100" value="${escape(d.quote)}" placeholder="COT-0000"></td><td><input data-bill-field="invoice" maxlength="100" value="${escape(d.invoice)}" placeholder="Factura"></td><td><input data-bill-field="invoiceDate" type="date" value="${escape(d.invoiceDate)}"></td><td><input data-bill-field="subtotal" type="number" min="0" max="999999999" step="0.01" value="${escape(d.subtotal)}"></td><td><select data-bill-field="state">${['PENDIENTE','FACTURADO','FACTURA PARCIAL','EN ESPERA','NO FACTURAR'].map(x=>`<option ${d.state===x?'selected':''}>${x}</option>`).join('')}</select></td><td><textarea data-bill-field="note" maxlength="1000" rows="2" placeholder="Observaciones administrativas">${escape(d.note)}</textarea></td><td><button class="btn" data-bill-save="${escape(r.id)}">Guardar</button></td></tr>`}).join(''):'<tr><td colspan="12" class="empty">No hay registros coincidentes en esta página.</td></tr>';
 $('#bill-info').textContent=globalRows!==null?`Búsqueda global · ${rows.length} coincidencias${searchWarning?' · '+searchWarning:''}`:`Página ${p.index+1} · ${rows.length} visibles de ${loaded.length} consultadas · ${loading?'Consultando…':'Sincronizado con servidor'}`;$('#bill-prev').disabled=globalRows!==null||p.index===0;$('#bill-next').disabled=globalRows!==null||!p.hasMore;updateSelected();updateBillingDashboard();
 $('#bill-rows').querySelectorAll('[data-bill-row]').forEach(tr=>{const id=tr.dataset.billRow;tr.querySelectorAll('[data-bill-field]').forEach(el=>el.addEventListener('input',()=>{draft((globalRows||loaded).find(r=>r.id===id))[el.dataset.billField]=el.value;updateBillingDashboard()}));tr.querySelector('[data-bill-check]').onchange=e=>{if(e.target.checked){if(state.selectedBillingOTs.size>=20){e.target.checked=false;return toast('Máximo 20 OT por operación.',true)}state.selectedBillingOTs.set(id,(globalRows||loaded).find(r=>r.id===id).code)}else state.selectedBillingOTs.delete(id);updateSelected()};tr.querySelector('[data-bill-save]').onclick=async e=>{const b=e.currentTarget;b.disabled=true;try{const result=await saveBilling(id,draft((globalRows||loaded).find(r=>r.id===id)),state.user);state.billingDrafts.set(id,{...result});toast('Facturación guardada: '+(globalRows||loaded).find(r=>r.id===id).code)}catch(err){toast(err.message,true)}finally{b.disabled=false}}});};
 const load=async()=>{const token=++version;globalRows=null;loading=true;$('#bill-info').textContent='Consultando servidor…';try{const result=await fetchBillingPage(p.cursors[p.index]||null,p.size);if(token!==version||state.view!=='billing')return;loaded=await displayCatalogNames(result.rows);if(token!==version||state.view!=='billing')return;p.hasMore=result.more;p.lastCursor=result.cursor;for(const r of loaded)if(!state.billingDrafts.has(r.id))draft(r);loading=false;paint()}catch(e){loading=false;$('#bill-info').textContent='Error: '+e.message;toast(e.message,true)}};
 $('#bill-size').onchange=e=>{p.size=Number(e.target.value);p.index=0;p.cursors=[null];load()};$('#bill-prev').onclick=()=>{if(p.index){p.index--;load()}};$('#bill-next').onclick=()=>{if(p.hasMore&&p.lastCursor){p.cursors[p.index+1]=p.lastCursor;p.index++;load()}};$('#bill-refresh').onclick=()=>{state.billingDrafts.clear();if($('#bill-search').value.trim().length>=3)runGlobal();else load()};
 const runGlobal=async()=>{const term=$('#bill-search').value.trim(),token=++version;if(term.length<3){globalRows=null;searchWarning='';if(term.length)$('#bill-info').textContent='Escriba al menos 3 caracteres para buscar globalmente.';await load();return}$('#bill-info').textContent='Buscando en índice global…';try{const result=await searchBillingGlobal(term,$('#bill-series').value);if(token!==version||state.view!=='billing')return;globalRows=await displayCatalogNames(result.rows);if(token!==version||state.view!=='billing')return;searchWarning=result.warning||'';for(const r of globalRows)draft(r);paint()}catch(e){if(token!==version)return;$('#bill-info').textContent='Error de búsqueda: '+e.message;toast(e.message,true)}};
 $('#bill-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(runGlobal,400)});
 $('#bill-series').addEventListener('change',()=>{if($('#bill-search').value.trim().length>=3)runGlobal();else paint()});
 $('#bill-status').addEventListener('change',paint);
 $('#bill-select-visible').onclick=()=>{for(const r of visible()){if(state.selectedBillingOTs.size>=20)break;state.selectedBillingOTs.set(r.id,r.code)}paint()};$('#bill-clear').onclick=()=>{state.selectedBillingOTs.clear();paint()};$('#bill-apply-date').onclick=()=>{const date=$('#bill-date').value;if(!date)return toast('Seleccione una fecha.',true);for(const id of state.selectedBillingOTs.keys()){const d=state.billingDrafts.get(id);if(d)d.invoiceDate=date}paint();toast('Fecha aplicada a los borradores seleccionados. Falta guardar.')};
 $('#bill-save-batch').onclick=async e=>{const ids=[...state.selectedBillingOTs.keys()];if(!ids.length)return toast('Seleccione OT para guardar.',true);const missing=ids.filter(id=>!state.billingDrafts.has(id));if(missing.length)return toast('Vuelva a cargar las OT seleccionadas antes de guardar: '+missing.map(id=>state.selectedBillingOTs.get(id)).join(', '),true);if(!confirm('¿Guardar la facturación de '+ids.length+' OT seleccionadas?'))return;const b=e.currentTarget;b.disabled=true;try{await saveBillingBatch(ids.map(id=>({id,...state.billingDrafts.get(id)})),state.user);for(const id of ids)state.billingDrafts.delete(id);state.selectedBillingOTs.clear();toast('Facturación guardada para '+ids.length+' OT.');await load()}catch(err){toast(err.message,true)}finally{b.disabled=false}};load();
}

function laboratoryPipeline(){
 stopWatch();hero('Ingreso de laboratorio','Flujo controlado: Laboratorio → Informes pendientes → Por autorizar → Autorizados / Portal.');
 const tabs=[['EN_LABORATORIO','Laboratorio'],['INFORME_PENDIENTE','Informes pendientes'],['POR_AUTORIZAR','Informes por autorizar'],['AUTORIZADO','Autorizados / Portal']];
 $('#content').insertAdjacentHTML('beforeend',`<div class="environment-tabs lab-pipeline-tabs">${tabs.map(([k,n],i)=>`<button class="environment-tab ${i===0?'active':''}" data-lab-tab="${k}">${n} <span class="tag" data-lab-count="${k}">—</span></button>`).join('')}</div><div class="lab-overview" id="lab-overview" aria-label="Indicadores de la página consultada"></div><div class="section-heading"><div><h2 id="lab-stage-title">Laboratorio · pendiente de ingreso</h2><p id="lab-stage-note">Las OT enviadas esperan confirmación oficial antes de pasar a informes pendientes.</p></div></div><div class="panel"><div class="ot-filter-line"><input type="search" id="lab-search" placeholder="Buscar en toda la etapa: código, cliente, sucursal o monitoreo…"><div class="ot-filter-controls"><label>Serie <select id="lab-series"><option value="all">RR + RG</option><option value="RR">RR</option><option value="RG">RG</option></select></label><label>Orden <select id="lab-sort"><option value="desc">Código descendente</option><option value="asc">Código ascendente</option><option value="receptionAsc">Recepción prevista · más antigua primero</option><option value="receptionDesc">Recepción prevista · más reciente primero</option><option value="workAsc">Inicio de trabajo · más antiguo primero</option><option value="workDesc">Inicio de trabajo · más reciente primero</option></select></label></div></div><div class="ot-batch-bar" id="lab-batch-bar"><button class="btn alt" id="lab-select-visible">☑ Seleccionar visibles</button><button class="btn ghost" id="lab-clear-selection">Limpiar selección</button><button class="btn" id="lab-batch-send">Confirmar ingreso múltiple</button><button class="btn alt" id="lab-batch-return">Devolver seleccionadas</button><span class="tag" id="lab-selected-count">0 seleccionadas</span><small class="muted">Selección conservada entre filtros y páginas · máximo 20 por envío</small></div><div id="report-stage-tools" hidden><div class="report-metrics" id="report-metrics"></div><div class="ot-batch-bar"><button class="btn alt" id="report-select-visible">☑ Seleccionar visibles</button><button class="btn ghost" id="report-clear-selection">Limpiar selección</button><button class="btn" id="report-batch-deliver">Registrar entrega múltiple</button><span class="tag" id="report-selected-count">0 seleccionadas</span><small class="muted">Selección acumulativa entre páginas y filtros · máximo 20 OT</small></div><p class="muted">La fecha de entrega real confirma el informe y lo traslada a «Informes por autorizar».</p></div><div id="portal-stage-tools" hidden><div class="report-metrics" id="portal-metrics"></div><div class="ot-batch-bar"><button class="btn alt" id="portal-select-visible">☑ Seleccionar visibles</button><button class="btn ghost" id="portal-clear-selection">Limpiar selección</button><span class="tag" id="portal-selected-count">0 seleccionadas</span><label>Fecha de envío al portal <input id="portal-batch-date" type="date" required></label><button class="btn" id="portal-batch-save">Enviar seleccionados al portal</button></div><p class="muted">Solo informes autorizados con estado 1 o 4. Selección acumulativa entre filtros y páginas (máximo 20). Los publicados desaparecen de esta bandeja y permanecen en Supervisión de informes.</p></div><div id="auth-stage-tools" hidden><div class="report-metrics" id="auth-metrics"></div><div class="ot-batch-bar"><button class="btn alt" id="auth-select-visible">☑ Seleccionar visibles</button><button class="btn ghost" id="auth-clear-selection">Limpiar selección</button><label>Estado <select id="auth-batch-state"><option value="">Seleccione estado</option><option value="1">1 · INFORMES LISTOS</option><option value="2">2 · INFORMES RETENIDOS</option><option value="3">3 · TRABAJO SIN OC / FACTURACIÓN EN SEGUIMIENTO</option><option value="4">4 · PROYECTO FT</option></select></label><label>Fecha autorización <input id="auth-batch-date" type="date"></label><button class="btn" id="auth-batch-save">Guardar seleccionados</button><span class="tag" id="auth-selected-count">0 seleccionadas</span></div><p class="muted">Estados 1 y 4: requieren fecha y pasan a Autorizados / Portal. Estados 2 y 3: permanecen retenidos en esta bandeja, sin fecha de autorización. Selección acumulativa entre filtros y páginas, máximo 20 OT.</p></div><div class="toolbar"><label>Registros por página <select id="page-size"><option>10</option><option>25</option><option>50</option></select></label><button id="prev" class="btn ghost">← Anterior</button><button id="next" class="btn ghost">Siguiente →</button><button id="refresh" class="btn alt">↻ Actualizar</button><span id="page-status" class="muted">Consultando…</span></div><div class="table-wrap"><table class="table"><thead><tr><th>Código / Estado</th><th>Cliente / Sucursal</th><th>Monitoreo</th><th>Tipo</th><th>Puntos</th><th>Fecha inicio</th><th>Acción</th></tr></thead><tbody id="rows"></tbody></table></div><p class="muted">La etapa se consulta directamente en Firestore. Los códigos completos RG/RR se consultan directamente; las búsquedas parciales usan el índice auxiliar; mínimo 3 caracteres; el orden por fecha usa paginación indexada en vivo y excluye OT sin fecha; sin búsqueda, la página se sincroniza en vivo.</p></div><div id="modal"></div>`);
 state.labStage='EN_LABORATORIO';paintLaboratoryCounts();refreshLaboratoryStageCounts();const p=pagingState('laboratory');$('#page-size').value=String(p.size);
 document.querySelectorAll('[data-lab-tab]').forEach(b=>b.onclick=()=>{state.labStage=b.dataset.labTab;labGlobal.token++;labGlobal.active=false;$('#lab-search').value='';p.index=0;p.cursors=[null];document.querySelectorAll('[data-lab-tab]').forEach(x=>x.classList.toggle('active',x===b));paintLaboratoryStageHeading();$('#lab-stage-note').textContent=state.labStage==='EN_LABORATORIO'?'Confirme el ingreso oficial para trasladar la OT a Informes pendientes.':state.labStage==='INFORME_PENDIENTE'?'Registre la fecha real de entrega para enviar el informe a autorización.':'Bandeja de seguimiento de la etapa.';refreshLaboratoryStageCounts();attachPage('laboratory')});
 $('#page-size').onchange=e=>{p.size=Number(e.target.value);p.index=0;p.cursors=[null];if(labGlobal.active)renderLabGlobal();else attachPage('laboratory')};
 $('#prev').onclick=()=>{if(p.index>0){p.index--;if(labGlobal.active)renderLabGlobal();else attachPage('laboratory')}};
 $('#next').onclick=()=>{if(labGlobal.active){if((p.index+1)*p.size<labGlobal.rows.length){p.index++;renderLabGlobal()}}else if(p.hasMore&&p.lastCursor){p.cursors[p.index+1]=p.lastCursor;p.index++;attachPage('laboratory')}};
 $('#refresh').onclick=()=>{labGlobal.cache.clear();refreshLaboratoryStageCounts(true);return labGlobal.active?runLabGlobal():attachPage('laboratory')};
 $('#lab-select-visible').onclick=()=>{for(const r of state.rows.laboratory||[]){if(r.status==='EN_LABORATORIO')state.selectedLabOTs.set(r.id,r.code)}paintRows('laboratory')};$('#lab-clear-selection').onclick=()=>{state.selectedLabOTs.clear();paintRows('laboratory')};$('#lab-batch-send').onclick=()=>laboratoryBatchForm();$('#lab-batch-return').onclick=()=>returnOTDialog([...state.selectedLabOTs.keys()]);
 $('#report-select-visible').onclick=()=>{for(const r of state.rows.laboratory||[]){if(r.status==='INFORME_PENDIENTE')state.selectedReportOTs.set(r.id,r.code)}paintRows('laboratory')};$('#report-clear-selection').onclick=()=>{state.selectedReportOTs.clear();paintRows('laboratory')};$('#report-batch-deliver').onclick=()=>reportDeliveryBatchForm();
 $('#portal-select-visible').onclick=()=>{for(const r of state.rows.laboratory||[]){if(r.status==='AUTORIZADO'&&state.selectedPortalOTs.size<20)state.selectedPortalOTs.set(r.id,r.code)}paintRows('laboratory')};$('#portal-clear-selection').onclick=()=>{state.selectedPortalOTs.clear();paintRows('laboratory')};$('#portal-batch-date').value=localToday();$('#portal-batch-save').onclick=()=>portalBatchSave();
 $('#auth-select-visible').onclick=()=>{for(const r of state.rows.laboratory||[]){if(r.status==='POR_AUTORIZAR' && state.selectedAuthOTs.size<20)state.selectedAuthOTs.set(r.id,r.code)}paintRows('laboratory')};$('#auth-clear-selection').onclick=()=>{state.selectedAuthOTs.clear();paintRows('laboratory')};$('#auth-batch-date').value=localToday();$('#auth-batch-state').onchange=e=>{$('#auth-batch-date').disabled=['2','3'].includes(e.target.value)};$('#auth-batch-save').onclick=()=>authorizationBatchSave();
 $('#lab-search').oninput=()=>{clearTimeout(labGlobal.timer);labGlobal.timer=setTimeout(runLabGlobal,350)};$('#lab-series').onchange=()=>{const p=pagingState('laboratory');p.index=0;p.cursors=[null];runLabGlobal()};$('#lab-sort').onchange=()=>{const p=pagingState('laboratory');p.index=0;p.cursors=[null];runLabGlobal()};attachPage('laboratory');
}
function sortLaboratoryRows(input){
 const mode=$('#lab-sort')?.value||'desc';
 const field=mode.startsWith('reception')?'reception':mode.startsWith('work')?'work':'code';
 const dir=['asc','receptionAsc','workAsc'].includes(mode)?1:-1;
 const date=r=>field==='reception'?String(r.laboratory?.proposedReceivedAt||''):String(r.workDate||'');
 return [...input].sort((a,b)=>{
  if(field==='code')return dir*String(a.code||'').localeCompare(String(b.code||''),'es',{numeric:true});
  const av=date(a),bv=date(b);
  if(!av&&!bv)return String(a.code||'').localeCompare(String(b.code||''),'es',{numeric:true});
  if(!av)return 1;if(!bv)return -1;
  return dir*av.localeCompare(bv)||String(a.code||'').localeCompare(String(b.code||''),'es',{numeric:true});
 });
}
function labIndexedSort(){const mode=$('#lab-sort')?.value||'desc';return !$('#lab-search')?.value.trim()&&['receptionAsc','receptionDesc','workAsc','workDesc'].includes(mode)}
function labNeedsGlobal(){return !!($('#lab-search')?.value.trim()||(!labIndexedSort()&&($('#lab-series')?.value!=='all'||!['asc','desc'].includes($('#lab-sort')?.value||'desc'))))}
function renderLabGlobal(){
 if(state.view!=='laboratory'||!labGlobal.active)return;
 const p=pagingState('laboratory');
 const all=sortLaboratoryRows(labGlobal.rows);
 p.index=Math.min(p.index,Math.max(0,Math.ceil(all.length/p.size)-1));
 state.rows.laboratory=all.slice(p.index*p.size,(p.index+1)*p.size);paintRows('laboratory');
 $('#prev').disabled=p.index===0;$('#next').disabled=(p.index+1)*p.size>=all.length;
 $('#page-status').textContent=`Consulta global ordenada · ${all.length} coincidencias · Página ${p.index+1}${labGlobal.truncated?' · límite 5000 consultadas':''}`;
}
async function runLabGlobal(){
 if(state.view!=='laboratory')return;
 const term=$('#lab-search')?.value.trim()||'',token=++labGlobal.token,p=pagingState('laboratory');p.index=0;
 if(!labNeedsGlobal()){labGlobal.active=false;attachPage('laboratory');return}
 labGlobal.active=true;stopWatch();$('#page-status').textContent='Buscando en toda la etapa…';
 try{
  const series=$('#lab-series').value;
  // Nunca explorar toda una etapa para una búsqueda textual. El índice auxiliar
  // consulta candidatos acotados; términos cortos requieren más caracteres.
  const exact=/^(RG|RR)\d{6}$/i.test(term);
  const normalized=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  let result;
  if(term && !exact && normalized(term).replace(/[^A-Z0-9]/g,'').length<3){
   labGlobal.rows=[];labGlobal.truncated=false;renderLabGlobal();
   $('#page-status').textContent='Escriba al menos 3 caracteres para buscar en toda la etapa.';return;
  }
  if(term && !exact){
   const indexed=await searchOTIndexOperational(term,{status:state.labStage,series,max:500});
   if(indexed.unsupported||indexed.limited||indexed.stale){
    labGlobal.rows=[];labGlobal.truncated=false;renderLabGlobal();
    $('#page-status').textContent='Consulta no concluyente: refine la búsqueda o repare el índice.';return;
   }
   result={rows:indexed.rows,truncated:false};
  }else if(exact){
   result=await searchLaboratoryStage(state.labStage,term,series,2);
  }else{
   // Ordenación global sin texto: máximo 250 OT, no 5000. Avisar del límite.
   result=await searchLaboratoryStage(state.labStage,'',series,100);
  }
  if(token!==labGlobal.token||state.view!=='laboratory')return;
  labGlobal.rows=await displayCatalogNames(result.rows);if(token!==labGlobal.token||state.view!=='laboratory')return;labGlobal.truncated=result.truncated;renderLabGlobal();
  if(result.truncated)toast('Límite de 5000 OT alcanzado: el ordenamiento puede no incluir toda la etapa. Refine la búsqueda.',true);
 }catch(e){if(token===labGlobal.token){$('#page-status').textContent='Error de búsqueda';toast(e.message,true)}}
}
function supervisionView(){
 stopWatch();hero('Supervisión de informes','Consulta consolidada de OT ingresadas oficialmente al laboratorio, con trazabilidad y filtros.');
 const stages=[['total','TOTAL INGRESADOS'],['INFORME_PENDIENTE','INFORMES PENDIENTES'],['POR_AUTORIZAR','EN AUTORIZACIÓN'],['AUTORIZADO','PENDIENTES PORTAL'],['PUBLICADO','ENVIADOS AL PORTAL'],['FACTURADO','FACTURADOS / CERRADOS']];
 $('#content').insertAdjacentHTML('beforeend',`<div class="section-heading"><div><h2>Control general de informes</h2><p>Los estados futuros se incorporarán conforme se habiliten sus procesos operativos.</p></div><button class="btn alt" id="sup-reload">↻ Actualizar indicadores</button></div><div class="sup-metrics">${stages.map(([k,n])=>`<div class="sup-metric"><strong id="sup-${k}">—</strong><small>${n}</small></div>`).join('')}<div class="sup-metric"><strong id="sup-expired">—</strong><small>VENCIDOS · pendiente de plazos</small></div><div class="sup-metric"><strong id="sup-progress">—</strong><small>AVANCE PROMEDIO · pendiente de definición</small></div></div><div class="panel"><div class="ot-filter-line"><input id="sup-search" type="search" placeholder="Buscar en todas las OT: código, cliente, sucursal, monitoreo o analista…"><div class="ot-filter-controls"><label>Serie <select id="sup-series"><option value="all">RR + RG</option><option>RR</option><option>RG</option></select></label><label>Estado <select id="sup-status"><option value="all">Todos</option>${stages.slice(1).map(([k,n])=>`<option value="${k}">${n}</option>`).join('')}</select></label><label>Orden <select id="sup-order"><option value="desc">↓ Código descendente</option><option value="asc">↑ Código ascendente</option></select></label></div></div><div class="sup-export"><strong>📅 Filtros y exportación</strong><div class="sup-date-grid"><label>Entrega real · desde<input type="date" id="sup-delivery-from"></label><label>Entrega real · hasta<input type="date" id="sup-delivery-to"></label><label>Autorización · desde<input type="date" id="sup-auth-from"></label><label>Autorización · hasta<input type="date" id="sup-auth-to"></label></div><div class="toolbar"><button class="btn alt" id="sup-apply">Aplicar filtros</button><button class="btn ghost" id="sup-clear">Limpiar fechas</button><button class="btn alt" id="sup-export-delivery">Excel por entrega real</button><button class="btn alt" id="sup-export-auth">Excel por autorización</button><button class="btn" id="sup-export-all">Excel consolidado filtrado</button><span class="muted">Descarga de todas las coincidencias consultadas, no solo la página visible. Formato Excel (.xlsx), sin información de facturación.</span></div></div><div class="toolbar"><label>Registros por página <select id="sup-size"><option>10</option><option>25</option><option>50</option></select></label><button class="btn ghost" id="sup-prev">← Anterior</button><button class="btn ghost" id="sup-next">Siguiente →</button><span class="muted" id="sup-info">Consultando…</span></div><div class="table-wrap"><table class="table sup-table"><thead><tr>${['Código / estado','Analista','Cliente / sucursal','Monitoreo','Puntos','Recepción','F. máxima','Entrega real','Autorización','Portal','Facturación','Avance'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody id="sup-rows"></tbody></table></div><p class="muted">Se muestran únicamente OT con ingreso oficial confirmado. Los campos no registrados se presentan como pendientes, sin inventar fechas ni porcentajes.</p></div>`);
 const p=pagingState('supervision');$('#sup-size').value=String(p.size);let raw=[],visible=[],globalRows=null,globalWarning='',token=0;
 const statusName=x=>({'INFORME_PENDIENTE':'Informe pendiente','POR_AUTORIZAR':'Por autorizar','AUTORIZADO':'Autorizado','PUBLICADO':'Publicado','FACTURADO':'Facturado'}[x]||x||'—');
 const value=(r,keys)=>keys.reduce((a,k)=>a??k.split('.').reduce((v,part)=>v?.[part],r),null);
 const isGlobal=()=>!!($('#sup-search').value.trim()||$('#sup-series').value!=='all'||$('#sup-status').value!=='all'||['sup-delivery-from','sup-delivery-to','sup-auth-from','sup-auth-to'].some(id=>$('#'+id).value));
 const renderRows=()=>{
 const source=globalRows||raw;
 const sorted=[...source].sort((a,b)=>($('#sup-order').value==='asc'?1:-1)*String(a.code||'').localeCompare(String(b.code||'')));
 visible=globalRows?sorted.slice(p.index*p.size,(p.index+1)*p.size):sorted;
 $('#sup-rows').innerHTML=visible.length?visible.map(r=>`<tr><td><b>${escape(r.code)}</b><small class="ot-cell-secondary">${escape(statusName(r.status))}</small></td><td>${escape(r.laboratory?.analyst||'—')}</td><td><b>${escape(r.clientName||'—')}</b><small class="ot-cell-secondary">${escape(r.branchName||'—')}</small></td><td>${escape(r.monitoring||'—')}</td><td>${escape(r.points??'—')}</td><td>${escape(r.laboratory?.receivedAt||'—')}</td><td>${escape(value(r,['deadline','laboratory.deadline'])||'—')}</td><td>${escape(value(r,['deliveryRealAt','report.deliveryRealAt'])||'—')}</td><td>${escape(value(r,['authorizationAt','report.authorizationAt'])||'—')}</td><td>${escape(value(r,['portalPublishedAt','portal.publishedAt'])||'Pendiente')}</td><td>${canBilling()?escape(value(r,['billing.state','billingStatus'])||'Sin consultar'):'Restringido'}</td><td>${Number.isFinite(r.progress)?escape(r.progress)+'%':'—'}</td></tr>`).join(''):'<tr><td colspan="12" class="empty">No hay coincidencias con los filtros aplicados.</td></tr>';
 $('#sup-info').textContent=globalRows?`Búsqueda global · ${globalRows.length} coincidencias · Página ${p.index+1}${globalWarning?' · '+globalWarning:''}`:`Página ${p.index+1} · ${raw.length} consultadas · sincronizado con servidor`;
 $('#sup-prev').disabled=p.index===0;$('#sup-next').disabled=globalRows?(p.index+1)*p.size>=globalRows.length:!p.hasMore;
 };
 const attach=async()=>{
  stopWatch();const generation=++token;$('#sup-info').textContent='Consultando Firestore…';
  try{
   if(isGlobal()){
    const data=await searchSupervisionGlobal($('#sup-search').value,{series:$('#sup-series').value,status:$('#sup-status').value,deliveryFrom:$('#sup-delivery-from').value,deliveryTo:$('#sup-delivery-to').value,authFrom:$('#sup-auth-from').value,authTo:$('#sup-auth-to').value});
    if(state.view!=='supervision'||generation!==token)return;
    globalRows=await displayCatalogNames(data.rows);if(state.view!=='supervision'||generation!==token)return;globalWarning=data.warning||'';p.hasMore=false;renderRows();
   }else{
    globalRows=null;globalWarning='';const cursor=p.cursors[p.index]||null;
    const data=await fetchAdmittedPage(cursor,p.size);
    if(state.view!=='supervision'||generation!==token)return;
    p.hasMore=data.more;p.lastCursor=data.cursor;raw=await displayCatalogNames(data.rows);if(state.view!=='supervision'||generation!==token)return;renderRows();
   }
  }catch(err){if(generation===token){globalRows=null;raw=[];$('#sup-rows').innerHTML='<tr><td colspan="12" class="empty">Error de consulta. Revise los índices y la conexión.</td></tr>';$('#sup-info').textContent='Error: '+err.message;}}
 };
 const refreshMetrics=async()=>{try{const result=await supervisionCounts();if(state.view!=='supervision')return;for(const [key] of stages)$('#sup-'+key).textContent=result[key]??0;}catch(err){toast('No se pudieron consultar los indicadores: '+err.message,true)}};
 $('#sup-reload').onclick=refreshMetrics;
 $('#sup-size').onchange=e=>{p.size=Number(e.target.value);p.index=0;p.cursors=[null];if(globalRows)renderRows();else attach()};
 $('#sup-prev').onclick=()=>{if(p.index){p.index--;if(globalRows)renderRows();else attach()}};
 $('#sup-next').onclick=()=>{if(globalRows){if((p.index+1)*p.size<globalRows.length){p.index++;renderRows()}}else if(p.hasMore&&p.lastCursor){p.cursors[p.index+1]=p.lastCursor;p.index++;attach()}};
 let searchTimer;
 const apply=()=>{clearTimeout(searchTimer);p.index=0;p.cursors=[null];attach()};
 $('#sup-search').addEventListener('input',()=>{clearTimeout(searchTimer);if($('#sup-search').value.trim().length>0&&$('#sup-search').value.trim().length<3){$('#sup-info').textContent='Escriba al menos 3 caracteres.';return}searchTimer=setTimeout(apply,350)});
 ['sup-series','sup-status'].forEach(id=>$('#'+id).addEventListener('change',apply));
 $('#sup-order').addEventListener('change',renderRows);
 $('#sup-apply').onclick=apply;
 $('#sup-clear').onclick=()=>{['sup-delivery-from','sup-delivery-to','sup-auth-from','sup-auth-to'].forEach(id=>$('#'+id).value='');apply()};
 const exportColumns=[['Código','code'],['Serie','series'],['Estado general','status'],['Analista','laboratory.analyst'],['Cliente','clientName'],['Sucursal','branchName'],['Monitoreo','monitoring'],['Tipo','type'],['Puntos','points'],['Fecha inicio','workDate'],['Fecha recepción','laboratory.receivedAt'],['Fecha máxima','laboratory.deadline'],['Entrega real','deliveryRealAt'],['Fecha autorización','authorizationAt'],['Estado autorización','authorization.state'],['Fecha envío portal','portalPublishedAt'],['Observaciones OT','observations']];
 const exportCSV=async(kind)=>{
  const btn=$('#sup-export-'+kind);const old=btn.textContent;btn.disabled=true;btn.textContent='Consultando histórico…';
  try{
   const result=await searchSupervisionGlobal($('#sup-search').value,{series:$('#sup-series').value,status:$('#sup-status').value,deliveryFrom:$('#sup-delivery-from').value,deliveryTo:$('#sup-delivery-to').value,authFrom:$('#sup-auth-from').value,authTo:$('#sup-auth-to').value});
   if(result.warning&&/límite de seguridad|incompleto|parcial/i.test(result.warning))throw Error('La consulta no garantiza cobertura completa: '+result.warning+' No se generó un archivo incompleto.');
   let rows=result.rows;
   const get=(r,path)=>path.split('.').reduce((v,k)=>v?.[k],r);
   if(kind==='delivery')rows=rows.filter(r=>r.deliveryRealAt||r.report?.deliveryRealAt);
   if(kind==='auth')rows=rows.filter(r=>r.authorizationAt||r.report?.authorizationAt);
   if(!rows.length)throw Error('No hay registros con la fecha solicitada y los filtros actuales.');
   const dateKey=kind==='auth'?'authorizationAt':'deliveryRealAt';
   rows.sort((a,b)=>String(get(b,dateKey)||'').localeCompare(String(get(a,dateKey)||''))||String(b.code||'').localeCompare(String(a.code||'')));
   btn.textContent='Preparando Excel profesional…';
   const {default:ExcelJS}=await import('exceljs');
   const wb=new ExcelJS.Workbook();
   wb.creator='PSI · ERP Gases NEXTGEN';wb.created=new Date();
   const ws=wb.addWorksheet('Trazabilidad',{views:[{state:'frozen',ySplit:8,xSplit:2}],pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0}});
   const cols=exportColumns.filter(([label])=>!/(factura|cotizaci[oó]n|subtotal|cobranza)/i.test(label));
   const n=cols.length;
   const titles={delivery:'CONTROL POR ENTREGA REAL',auth:'CONTROL POR AUTORIZACIÓN',all:'TRAZABILIDAD CONSOLIDADA'};
   const blue='173B5C', teal='167A70', pale='EAF2F5', white='FFFFFF';
   ws.mergeCells(1,1,2,n);
   const title=ws.getCell(1,1);title.value='PSI  |  PRODUCTOS Y SERVICIOS INDUSTRIALES';title.font={name:'Arial',size:13,bold:true,color:{argb:white}};title.fill={type:'pattern',pattern:'solid',fgColor:{argb:blue}};title.alignment={vertical:'middle',horizontal:'left',indent:1};
   ws.getRow(1).height=22;ws.getRow(2).height=12;
   ws.mergeCells(3,1,3,n);const sub=ws.getCell(3,1);sub.value=titles[kind];sub.font={name:'Arial',size:11,bold:true,color:{argb:blue}};sub.alignment={vertical:'middle',indent:1};ws.getRow(3).height=22;
   ws.mergeCells(4,1,4,n);const meta=ws.getCell(4,1);meta.value='Fecha de exportación: '+new Date().toLocaleDateString('es-EC')+'     |     Informes: '+rows.length+'     |     Series: '+($('#sup-series').value==='all'?'RR + RG':$('#sup-series').value);meta.font={name:'Arial',size:9,color:{argb:'52677A'}};meta.alignment={indent:1};ws.getRow(4).height=18;
   ws.mergeCells(5,1,5,n);const periods=ws.getCell(5,1);periods.value='Entrega real: '+($('#sup-delivery-from').value||'Sin límite')+' a '+($('#sup-delivery-to').value||'Sin límite')+'     |     Autorización: '+($('#sup-auth-from').value||'Sin límite')+' a '+($('#sup-auth-to').value||'Sin límite');periods.font={name:'Arial',size:9,color:{argb:'52677A'}};periods.alignment={indent:1};ws.getRow(5).height=18;
   ws.mergeCells(6,1,6,n);ws.getCell(6,1).value='Documento técnico de seguimiento · Sin información de facturación';ws.getCell(6,1).font={name:'Arial',size:9,italic:true,color:{argb:teal}};ws.getCell(6,1).alignment={indent:1};ws.getRow(6).height=18;
   ws.getRow(7).height=8;
   const header=ws.getRow(8);header.values=[,...cols.map(c=>c[0])];header.height=30;
   header.eachCell(c=>{c.font={name:'Arial',size:9,bold:true,color:{argb:white}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:blue}};c.alignment={vertical:'middle',horizontal:'center',wrapText:true};c.border={bottom:{style:'thin',color:{argb:teal}}}});
   const dateFields=new Set(['workDate','laboratory.receivedAt','laboratory.deadline','deliveryRealAt','authorizationAt','portalPublishedAt']);
   rows.forEach((r,i)=>{
    const row=ws.getRow(i+9);
    row.values=[,...cols.map(([label,key])=>{
     let v=get(r,key)??(key==='laboratory.deadline'?r.deadline:key==='deliveryRealAt'?r.report?.deliveryRealAt:key==='authorizationAt'?r.report?.authorizationAt:'');
     if(dateFields.has(key)&&typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)){const [y,m,d]=v.split('-').map(Number);return new Date(y,m-1,d)}
     return v??'';
    })];
    row.height=27;
    row.eachCell({includeEmpty:true},(c,j)=>{c.font={name:'Arial',size:9,color:{argb:'233849'},bold:j===1};c.alignment={vertical:'middle',wrapText:true,horizontal:j===9?'center':'left'};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:i%2===0?'FFFFFF':'F0F5F7'}};c.border={bottom:{style:'hair',color:{argb:'DCE6EA'}}};if(c.value instanceof Date)c.numFmt='dd/mm/yyyy'});
   });
   const widths={'Código':16,'Serie':9,'Estado general':20,'Analista':23,'Cliente':38,'Sucursal':27,'Monitoreo':45,'Tipo':16,'Puntos':10,'Fecha inicio':17,'Fecha recepción':19,'Fecha máxima':18,'Entrega real':18,'Fecha autorización':20,'Estado autorización':21,'Fecha envío portal':20,'Observaciones OT':52};
   cols.forEach(([label],i)=>{ws.getColumn(i+1).width=widths[label]||20});
   ws.autoFilter={from:{row:8,column:1},to:{row:8,column:n}};
   ws.headerFooter.oddFooter='PSI · Control técnico de informes                 Página &P de &N';
   ws.printTitlesRow='1:8';
   const buffer=await wb.xlsx.writeBuffer();
   const blob=new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
   const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='PSI_GASES_'+kind.toUpperCase()+'_'+new Date().toISOString().slice(0,10)+'.xlsx';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
   toast('Exportados '+rows.length+' informes.');
  }catch(err){toast('No se pudo exportar: '+err.message,true)}finally{btn.disabled=false;btn.textContent=old}
 };
 ['delivery','auth','all'].forEach(kind=>$('#sup-export-'+kind).onclick=()=>exportCSV(kind));
 attach();refreshMetrics();
}
function environmentalMenu(){
 stopWatch();
 hero('Mediciones ambientales','Registro técnico de órdenes de trabajo y consulta eficiente de mediciones registradas.');
 $('#content').insertAdjacentHTML('beforeend',`<div class="environment-tabs" role="tablist" aria-label="Mediciones ambientales"><button type="button" class="environment-tab" id="tab-register" role="tab" aria-selected="false">＋ Registro de medición ambiental</button><button type="button" class="environment-tab" id="tab-registered" role="tab" aria-selected="false">▤ Mediciones registradas <span class="tab-count" id="ot-tab-pending">—</span></button></div><div id="environment-body"></div><div id="toast" class="hide"></div>`);
 const show=(tab)=>{
  stopWatch();
  const register=tab==='register';
  $('#tab-register').classList.toggle('active',register);$('#tab-registered').classList.toggle('active',!register);
  $('#tab-register').setAttribute('aria-selected',String(register));$('#tab-registered').setAttribute('aria-selected',String(!register));
  $('#environment-body').innerHTML=register?`<div id="modal"></div>`:`<div class="section-heading"><div><h2>Mediciones registradas</h2><p>Histórico paginado con búsqueda global bajo demanda y filtros sobre todas las OT.</p></div><button type="button" class="btn alt" id="go-register">＋ Nueva medición</button></div><div class="ot-count-summary" aria-label="Indicadores operativos"><div class="ot-count-card"><small>OT PENDIENTES DE ENVÍO A LABORATORIO</small><strong id="ot-pending-total">—</strong><span>Solo registradas y programadas · todas las páginas</span></div><div class="ot-count-card"><small>TOTAL DE MEDICIONES REGISTRADAS</small><strong id="ot-global-total">—</strong><span>Conteo real de documentos en Firestore</span></div></div><p class="muted" id="ot-global-status" role="status">Consultando conteos reales…</p><div class="ot-series-note" aria-label="Filtro de serie"><span class="ot-series-dot"></span><strong>Histórico RR + RG</strong><span>Los filtros consultan el histórico completo al aplicarlos. Los indicadores superiores son globales.</span></div><div class="panel ot-list-panel"><div class="ot-filter-line"><input id="ot-filter-text" type="search" placeholder="Buscar en TODAS las OT: código, cliente, sucursal o monitoreo…" autocomplete="off" aria-label="Buscar en la página visible"><div class="ot-filter-controls"><label>Ordenar <select id="ot-filter-sort"><option value="code">Código OT</option><option value="client">Cliente</option><option value="date">Fecha de inicio</option></select></label><label>Dirección <select id="ot-filter-direction"><option value="desc">↓ Descendente</option><option value="asc">↑ Ascendente</option></select></label><label>Serie <select id="ot-filter-series"><option value="all">RR + RG</option><option value="RR">RR</option><option value="RG">RG</option></select></label><label>Estado <select id="ot-filter-status"><option value="all">Todos</option><option value="OT REGISTRADA">OT registrada</option><option value="OT PROGRAMADA">OT programada</option><option value="OT RECIBIDA">OT recibida</option></select></label><button type="button" class="btn alt" id="ot-clear-filters">✕ Limpiar filtros</button><span class="ot-filter-note" id="ot-filter-scope">Sin filtros · página en vivo</span></div></div><div class="toolbar"><label class="muted" for="page-size">Registros por página</label><select id="page-size" aria-label="Registros por página"><option value="10">10</option><option value="25">25</option><option value="50">50</option></select><button id="prev" class="btn ghost" disabled>← Anterior</button><button id="next" class="btn ghost" disabled>Siguiente →</button><button id="refresh" class="btn alt">↻ Actualizar vista</button><span class="muted" id="page-status">Conectando…</span></div><div class="ot-batch-bar"><button class="btn alt" id="select-visible">☑ Seleccionar visibles</button><button class="btn ghost" id="clear-selected">Limpiar selección</button><span id="ot-selected-count" class="tag">0 seleccionadas</span><button class="btn" id="send-selected">✚ Enviar seleccionadas a laboratorio</button></div><div class="table-wrap"><table class="table"><thead><tr><th>Sel.</th><th>Código / Estado</th><th>Cliente / Sucursal</th><th>Monitoreo</th><th>Tipo</th><th>Puntos</th><th>Inicio</th><th>Acciones</th></tr></thead><tbody id="rows"><tr><td colspan="8" class="empty">Consultando página visible…</td></tr></tbody></table></div></div><div id="modal"></div>`;
  if(register){otForm();refreshMeasurementCounts();return;}
  $('#go-register').onclick=()=>show('register');
  stopCounters();
  refreshMeasurementCounts();
  const p=pagingState('ots');$('#page-size').value=String(p.size);
  $('#page-size').onchange=e=>{p.size=Number(e.target.value);p.index=0;p.cursors=[null];if(otGlobal.active)renderGlobalOTPage();else attachPage('ots')};
  $('#prev').onclick=()=>{if(p.index>0){p.index--;if(otGlobal.active)renderGlobalOTPage();else attachPage('ots')}};
  $('#next').onclick=()=>{if(otGlobal.active){p.index++;renderGlobalOTPage()}else if(state.rows.ots?.length&&p.hasMore&&p.lastCursor){p.cursors[p.index+1]=p.lastCursor;p.index++;attachPage('ots')}};
  $('#refresh').onclick=()=>{if(otGlobal.active){otGlobal.cache=null;otGlobal.fullCache=null;otGlobal.fullLoadedAt=0;runGlobalOTFilter(true)}else attachPage('ots')};$('#select-visible').onclick=()=>{(state.rows.ots||[]).filter(r=>['REGISTRADA','PROGRAMADA'].includes(r.status)).forEach(r=>state.selectedOTs.set(r.id,r.code));paintRows('ots')};$('#clear-selected').onclick=()=>{state.selectedOTs.clear();paintRows('ots')};$('#send-selected').onclick=()=>openBatchSend();['ot-filter-text','ot-filter-sort','ot-filter-direction','ot-filter-series','ot-filter-status'].forEach(id=>$('#'+id).addEventListener('input',()=>{clearTimeout(otGlobal.timer);otGlobal.timer=setTimeout(()=>runGlobalOTFilter(),id==='ot-filter-text'?350:0)}));$('#ot-clear-filters').onclick=()=>{for(const id of ['ot-filter-text'])$('#'+id).value='';for(const id of ['ot-filter-sort','ot-filter-direction','ot-filter-series','ot-filter-status'])$('#'+id).selectedIndex=0;runGlobalOTFilter()};otGlobal.active=false;attachPage('ots');
 };
 $('#tab-register').onclick=()=>show('register');$('#tab-registered').onclick=()=>show('registered');
 window.showRegisteredMeasurements=()=>{if(state.view==='ots')show('registered')};
 show('register');
}
let measurementCountLastAt=0;
let measurementCountValues=null;
try{measurementCountValues=JSON.parse(sessionStorage.getItem('psi-gases-measurement-counts-v66')||'null')}catch{}
function paintMeasurementCounts(){if(!measurementCountValues)return;const {total,pending}=measurementCountValues;for(const [id,n] of [['#ot-global-total',total],['#ot-pending-total',pending],['#ot-tab-pending',pending]]){const el=$(id);if(el&&Number.isFinite(n))el.textContent=n.toLocaleString('es-EC')}}
let measurementCountInFlight=false;
let measurementCountRefreshNeeded=false;
// Actualización local confirmada: no requiere nuevas lecturas de Firestore.
// El total general sigue sincronizado con summaries/overview.
function applyConfirmedNewOT(){
 const previous=measurementCountValues||{};
 const totalFromSummary=menuCountValues?.ots;
 measurementCountValues={
  total:Number.isFinite(totalFromSummary)?totalFromSummary:Number.isFinite(previous.total)?previous.total+1:undefined,
  pending:Number.isFinite(previous.pending)?previous.pending+1:undefined
 };
 measurementCountLastAt=Date.now();
 try{sessionStorage.setItem('psi-gases-measurement-counts-v66',JSON.stringify(measurementCountValues))}catch{}
 paintMeasurementCounts();
 // Si no existía un valor inicial, verificarlo mediante la consulta normal.
 if(!Number.isFinite(measurementCountValues.pending))refreshMeasurementCounts(true);
}

async function refreshMeasurementCounts(force=false){
 paintMeasurementCounts();
 if(state.view!=='ots'||(!force&&measurementCountValues&&Date.now()-measurementCountLastAt<15*60*1000))return;
 measurementCountLastAt=Date.now();
 if(measurementCountInFlight){measurementCountRefreshNeeded=true;return}
 measurementCountInFlight=true;
 try{
  const result=await countMeasurementOTs();
  measurementCountValues=result;try{sessionStorage.setItem('psi-gases-measurement-counts-v66',JSON.stringify(result))}catch{}
  if(state.view!=='ots')return;
  const show=(id,n)=>{const el=$(id);if(el)el.textContent=n.toLocaleString('es-EC')};
  show('#ot-global-total',result.total);
  show('#ot-pending-total',result.pending);
  show('#ot-tab-pending',result.pending);
  // El menú principal muestra el total histórico, no las OT pendientes.
  const badge=$('#nav-ots-total');if(badge){badge.hidden=false;badge.textContent=result.total.toLocaleString('es-EC')}
  const note=$('#ot-global-status');if(note)note.textContent='Conteos verificados en servidor · no dependen de la página ni del resumen histórico';
 }catch(err){
  const note=$('#ot-global-status');if(note)note.textContent='No fue posible verificar los conteos: '+(err.code||err.message);
 }finally{
  measurementCountInFlight=false;
  if(measurementCountRefreshNeeded){measurementCountRefreshNeeded=false;setTimeout(refreshMeasurementCounts,400)}
 }
}
function otHasGlobalFilters(){return !!($('#ot-filter-text')?.value.trim()||($('#ot-filter-status')?.value!=='all')||($('#ot-filter-sort')?.value!=='code')||($('#ot-filter-direction')?.value!=='desc'))}
function filteredOTHistory(){
 const normalize=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
 const text=normalize($('#ot-filter-text')?.value.trim());const series=$('#ot-filter-series')?.value||'all',status=$('#ot-filter-status')?.value||'all';
 const field=$('#ot-filter-sort')?.value||'code',direction=$('#ot-filter-direction')?.value==='asc'?1:-1;
 return (otGlobal.cache||[]).filter(r=>['REGISTRADA','PROGRAMADA'].includes(r.status)).filter(r=>(!text||normalize([r.code,r.clientName,r.branchName,r.monitoring,r.type].join(' ')).includes(text))&&(series==='all'||String(r.series||r.code?.slice(0,2))===series)&&(status==='all'||(status==='OT PROGRAMADA'?r.status==='PROGRAMADA':status==='OT REGISTRADA'?r.status==='REGISTRADA':r.status==='EN_LABORATORIO'))).sort((a,b)=>direction*String(field==='client'?a.clientName:field==='date'?a.workDate:a.code||'').localeCompare(String(field==='client'?b.clientName:field==='date'?b.workDate:b.code||''),'es',{numeric:true}));
}
function renderGlobalOTPage(){
 if(!otGlobal.active||state.view!=='ots'||!$('#rows'))return;const p=pagingState('ots'),all=filteredOTHistory(),total=all.length;
 p.index=Math.max(0,Math.min(p.index,Math.max(0,Math.ceil(total/p.size)-1)));state.rows.ots=all.slice(p.index*p.size,(p.index+1)*p.size);
 paintRows('ots');$('#prev').disabled=p.index===0;$('#next').disabled=(p.index+1)*p.size>=total;
 $('#page-status').textContent=`${total.toLocaleString('es-EC')} coincidencias en todo el histórico · Página ${p.index+1} de ${Math.max(1,Math.ceil(total/p.size))}`;
 $('#ot-filter-scope').textContent='Resultados de la consulta · '+total+' coincidencias';
}
async function runGlobalOTFilter(force=false){
 if(state.view!=='ots'||!$('#ot-filter-text'))return;
 const token=++otGlobal.token,p=pagingState('ots');p.index=0;
 if(!otHasGlobalFilters()){otGlobal.active=false;p.index=0;p.cursors=[null];$('#ot-filter-scope').textContent='Consulta paginada en servidor · serie y estado';attachPage('ots');return}
 otGlobal.active=true;stopWatch();
 const term=$('#ot-filter-text').value.trim().toUpperCase();
 const exact=/^(RG|RR)\d{6}$/.test(term);
 // Los códigos completos usan el índice simple "code" y no consumen una exploración de 5000 OT.
 // No reutilizamos el resultado exacto para filtros parciales posteriores.
 if(exact){
  $('#page-status').textContent='Consultando código exacto…';
  try{
   const result=await findOTByExactCode(term);
   if(token!==otGlobal.token||state.view!=='ots'||!otGlobal.active)return;
   otGlobal.cache=result.rows;otGlobal.loadedAt=0;renderGlobalOTPage();
  }catch(e){if(token===otGlobal.token){$('#page-status').textContent='Error en consulta exacta';toast(e.message,true)}}
  return;
 }
 // V1.0.1.01: términos simples de tres o más caracteres usan EXCLUSIVAMENTE
 // el índice auxiliar. No descargar 5000 OT cuando falte un índice o falle.
 // Mostrar el problema explícitamente en lugar de presentar un resultado incompleto.
 if(term.length>=3 && /^[A-Z0-9]+$/.test(term)){
  $('#page-status').textContent='Consultando índice auxiliar…';
  try{
   const indexed=await searchOTIndexOperational(term);
   if(token!==otGlobal.token||state.view!=='ots'||!otGlobal.active)return;
   if(indexed.unsupported||indexed.limited||indexed.stale){
    otGlobal.cache=[];renderGlobalOTPage();
    const reason=indexed.limited?'Demasiadas coincidencias (límite del índice).':indexed.stale?'Se detectaron índices desactualizados.':'La consulta no es compatible con el índice.';
    $('#page-status').textContent=reason+' Refine la búsqueda o solicite reconstruir los índices.';
    $('#ot-filter-scope').textContent='Resultados no concluyentes · sin escaneo masivo';
    return;
   }
   otGlobal.cache=indexed.rows;renderGlobalOTPage();
   $('#ot-filter-scope').textContent=`Índice auxiliar · ${indexed.rows.length} coincidencias · ${indexed.reads} lecturas aproximadas`;
  }catch(e){
   if(token!==otGlobal.token||state.view!=='ots'||!otGlobal.active)return;
   otGlobal.cache=[];renderGlobalOTPage();
   $('#page-status').textContent='No fue posible consultar el índice. No se ejecutó una descarga masiva.';
   $('#ot-filter-scope').textContent='Error de búsqueda indexada';
   console.error('Búsqueda indexada no disponible:',e);
  }
  return;
 }
 // No se ejecutan exploraciones de 5.000 OT en consultas cortas ni al refrescar.
 // Se solicita una consulta más específica; el listado normal sigue paginado.
 otGlobal.cache=[];renderGlobalOTPage();
 $('#page-status').textContent='Escriba al menos 3 caracteres alfanuméricos, sin espacios, o un código completo.';
 $('#ot-filter-scope').textContent='Búsqueda acotada · sin descarga masiva';

}

function paintRows(view){
 const target=$('#rows');if(!target)return;
 let rows=state.rows[view]||[];if(view==='ots')rows=rows.filter(r=>['REGISTRADA','PROGRAMADA'].includes(r.status));if(view==='laboratory'){const stages=['EN_LABORATORIO','INFORME_PENDIENTE','POR_AUTORIZAR','AUTORIZADO'];rows=rows.filter(r=>r.status===(state.labStage||'EN_LABORATORIO'));const term=String($('#lab-search')?.value||'').toLowerCase();const series=$('#lab-series')?.value||'all';rows=sortLaboratoryRows(rows.filter(r=>(series==='all'||(r.series||r.code?.slice(0,2))===series)&&[r.code,r.clientName,r.branchName,r.monitoring].join(' ').toLowerCase().includes(term)));}
 if(view==='ots'){
  const all=rows;
  const normalized=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  const text=normalized($('#ot-filter-text')?.value||'');const series=$('#ot-filter-series')?.value||'all';const status=$('#ot-filter-status')?.value||'all';
  const getStatus=r=>r.status==='EN_LABORATORIO'?'OT RECIBIDA':r.status==='PROGRAMADA'?'OT PROGRAMADA':'OT REGISTRADA';
  rows=all.filter(r=>(!text||normalized([r.code,r.clientName,r.branchName,r.monitoring,r.type].join(' ')).includes(text))&&(series==='all'||String(r.series||r.code?.slice(0,2))===series)&&(status==='all'||getStatus(r)===status));
  const field=$('#ot-filter-sort')?.value||'code',direction=$('#ot-filter-direction')?.value==='asc'?1:-1;
  rows=[...rows].sort((a,b)=>direction*String(field==='client'?a.clientName:field==='date'?a.workDate:a.code||'').localeCompare(String(field==='client'?b.clientName:field==='date'?b.workDate:b.code||''),'es',{numeric:true}));
  for(const [id,value] of [['ot-visible-total',all.length],['ot-visible-rr',all.filter(r=>(r.series||r.code?.slice(0,2))==='RR').length],['ot-visible-rg',all.filter(r=>(r.series||r.code?.slice(0,2))==='RG').length],['ot-visible-programmed',all.filter(r=>r.status==='PROGRAMADA').length]]){const el=$('#'+id);if(el)el.textContent=value}
 }
 if(view==='laboratory'){
 const pageRows=state.rows.laboratory||[];
 const stageKey=state.labStage||'EN_LABORATORIO';
 const chosenSeries=$('#lab-series')?.value||'all';
 const stageRows=pageRows.filter(r=>r.status===stageKey&&(chosenSeries==='all'||String(r.series||r.code?.slice(0,2)).toUpperCase()===chosenSeries));
 const metrics=[['En esta etapa',stageRows.length],['Serie RR',stageRows.filter(r=>(r.series||r.code?.slice(0,2))==='RR').length],['Serie RG',stageRows.filter(r=>(r.series||r.code?.slice(0,2))==='RG').length],['Puntos',stageRows.reduce((sum,r)=>sum+(Number(r.points)||0),0)]];
 const overview=$('#lab-overview');if(overview)overview.innerHTML=metrics.map(([label,value])=>`<div class="lab-overview-card"><strong>${value}</strong><span>${label}</span></div>`).join('')+'<p class="lab-overview-note">Indicadores de la página cargada · no representan el total histórico</p>';
 // Indicador exclusivamente visual: utiliza la fecha límite existente, sin escribir en Firestore.
 const reportDeadlineStatus=(deadline)=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(deadline||'')))return {label:'Sin plazo definido',kind:'unknown',detail:'Sin fecha límite registrada'};
  const today=localToday();const start=new Date(today+'T12:00:00Z');const end=new Date(deadline+'T12:00:00Z');
  if(!Number.isFinite(end.getTime()))return {label:'Sin plazo definido',kind:'unknown',detail:'Fecha no válida'};
  const days=Math.round((end-start)/86400000);
  if(days===0)return {label:'Vence hoy',kind:'today',detail:'Fecha límite hoy'};
  if(days<0)return {label:'Vencido',kind:'overdue',detail:`${Math.abs(days)} día(s) calendario de atraso`};
  let business=0;for(let i=1;i<=days;i++){const d=new Date(start.getTime()+i*86400000);if(d.getUTCDay()!==0&&d.getUTCDay()!==6)business++}
  return business<=2?{label:'Próximo a vencer',kind:'soon',detail:`${business} día(s) hábil(es) restante(s)`}:{label:'En plazo',kind:'ok',detail:`${business} día(s) hábil(es) restante(s)`};
 };
 const isLab=state.labStage==='EN_LABORATORIO',isReport=state.labStage==='INFORME_PENDIENTE',isAuth=state.labStage==='POR_AUTORIZAR',isPortal=state.labStage==='AUTORIZADO';
 const bar=$('#lab-batch-bar');if(bar)bar.hidden=!isLab;
 const portalTools=$('#portal-stage-tools');if(portalTools)portalTools.hidden=!isPortal;const portalCount=$('#portal-selected-count');if(portalCount)portalCount.textContent=state.selectedPortalOTs.size+' seleccionadas';if(isPortal){const items=(state.rows.laboratory||[]);const eligible=items.filter(r=>r.status==='AUTORIZADO');$('#portal-metrics').innerHTML=[['AUTORIZADOS EN PÁGINA',eligible.length],['PUNTOS PENDIENTES',eligible.reduce((a,r)=>a+(Number(r.points)||0),0)],['SERIE RR',eligible.filter(r=>r.series==='RR').length],['SERIE RG',eligible.filter(r=>r.series==='RG').length]].map(([label,n])=>`<div class="report-metric"><strong>${n}</strong><small>${label}</small></div>`).join('')+'<small class="muted">Indicadores de la página consultada</small>'}const tools=$('#report-stage-tools');if(tools)tools.hidden=!isReport;const authTools=$('#auth-stage-tools');if(authTools)authTools.hidden=!isAuth;const authCount=$('#auth-selected-count');if(authCount)authCount.textContent=state.selectedAuthOTs.size+' seleccionadas';
 const ct=$('#lab-selected-count');if(ct)ct.textContent=state.selectedLabOTs.size+' seleccionadas';
 const rptCt=$('#report-selected-count');if(rptCt)rptCt.textContent=state.selectedReportOTs.size+' seleccionadas';
 if(isReport){const pending=(state.rows.laboratory||[]).filter(r=>r.status==='INFORME_PENDIENTE');const statuses=pending.map(r=>reportDeadlineStatus(r.laboratory?.deadline));
 const overdue=statuses.filter(x=>x.kind==='overdue').length,soon=statuses.filter(x=>x.kind==='soon'||x.kind==='today').length,unknown=statuses.filter(x=>x.kind==='unknown').length;
 $('#report-metrics').innerHTML=[['INFORMES EN PÁGINA',pending.length],['VENCIDOS',overdue],['PRÓXIMOS / HOY',soon],['SIN PLAZO',unknown]].map(([label,value])=>`<div class="report-metric"><strong>${value}</strong><small>${label}</small></div>`).join('')+'<small class="muted">Indicadores únicamente de la página cargada · no son totales históricos</small>';
 }

 if(isAuth){
  const today=localToday();
  const elapsed=date=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||'')))return null;const d=new Date(date+'T12:00:00'),t=new Date(today+'T12:00:00');return Number.isFinite(d.getTime())?Math.max(0,Math.floor((t-d)/86400000)):null};
  const all=rows.map(r=>({state:r.authorization?.state||'',days:elapsed(r.deliveryRealAt||r.report?.deliveryRealAt)}));
  const el=$('#auth-metrics');if(el)el.innerHTML=[['INFORMES EN PÁGINA',all.length],['SIN DECISIÓN',all.filter(x=>!x.state).length],['RETENIDOS · 2/3',all.filter(x=>['2','3'].includes(x.state)).length],['ATENCIÓN · ≥4 DÍAS',all.filter(x=>x.days!==null&&x.days>=4).length],['SIN FECHA REAL',all.filter(x=>x.days===null).length]].map(([label,value])=>`<div class="report-metric"><strong>${value}</strong><small>${label}</small></div>`).join('')+'<small class="muted">Indicadores de la página consultada, no del total histórico. Antigüedad desde la entrega real; umbrales internos orientativos.</small>';
}
 if(isPortal){const head=document.querySelector('#content .table thead');if(head)head.innerHTML='<tr>'+['Sel.','Código / Estado','Cliente / Sucursal','Monitoreo','Analista','Entrega real','Estado autorización','F. autorización','F. envío portal','Acciones'].map(x=>`<th>${x}</th>`).join('')+'</tr>';target.innerHTML=rows.length?rows.map(r=>`<tr><td><input type="checkbox" data-portal-select="${escape(r.id)}" ${state.selectedPortalOTs.has(r.id)?'checked':''} aria-label="Seleccionar ${escape(r.code)}"></td><td><b>${escape(r.code)}</b><small class="ot-cell-secondary">Autorizado · pendiente portal</small></td><td><b>${escape(r.clientName)}</b><small class="ot-cell-secondary">${escape(r.branchName)}</small></td><td>${escape(r.monitoring)}<small class="ot-cell-secondary">${escape(r.points)} punto(s)</small></td><td>${escape(r.laboratory?.analyst||'—')}</td><td>${escape(r.deliveryRealAt||'—')}</td><td><span class="tag">${escape(r.authorization?.state==='4'?'4 · PROYECTO FT':'1 · INFORMES LISTOS')}</span></td><td>${escape(r.authorizationAt||'—')}</td><td><input class="portal-row-date" type="date" data-portal-date="${escape(r.id)}" value="${localToday()}"></td><td><button class="btn" data-portal-save="${escape(r.id)}">Enviar al portal</button>${['ADMINISTRADOR','OPERACIONES'].includes(role())?` <button class="btn alt" data-portal-return="${escape(r.id)}">↩ Regresar a autorización</button>`:''}</td></tr>`).join(''):'<tr><td colspan="10" class="empty">No hay informes autorizados pendientes de publicación en esta página.</td></tr>';target.querySelectorAll('[data-portal-select]').forEach(b=>b.onchange=()=>{const r=(state.rows.laboratory||[]).find(x=>x.id===b.dataset.portalSelect);if(b.checked&&r){if(state.selectedPortalOTs.size>=20){b.checked=false;toast('Máximo 20 OT por operación.',true);return}state.selectedPortalOTs.set(r.id,r.code)}else state.selectedPortalOTs.delete(b.dataset.portalSelect);$('#portal-selected-count').textContent=state.selectedPortalOTs.size+' seleccionadas'});target.querySelectorAll('[data-portal-return]').forEach(b=>b.onclick=()=>returnPortalAuthorization(b.dataset.portalReturn));target.querySelectorAll('[data-portal-save]').forEach(b=>b.onclick=async()=>{const r=(state.rows.laboratory||[]).find(x=>x.id===b.dataset.portalSave),date=target.querySelector(`[data-portal-date="${b.dataset.portalSave}"]`)?.value;if(!r)return; if(!date)return toast('Seleccione la fecha de envío al portal.',true);if(!confirm(`¿Confirmar envío al portal de ${r.code} con fecha ${date}?`))return;b.disabled=true;try{await publishPortalOT(r.id,r.version,date,state.user);state.selectedPortalOTs.delete(r.id);toast(`${r.code}: informe enviado al portal. Visible en Supervisión.`)}catch(e){toast(e.message,true);b.disabled=false}});return}const head=document.querySelector('#content .table thead');if(head)head.innerHTML='<tr>'+['Código / Estado','Cliente / Sucursal','Monitoreo','Tipo','Puntos',(isReport?'Fecha límite de entrega':'Fecha inicio'),...(isReport?['Estado del plazo']:[]),...(isAuth?['Entrega real','Antigüedad']:[]),'Acción'].map(x=>`<th>${x}</th>`).join('')+'</tr>';
 target.innerHTML=rows.length?rows.map(r=>`<tr><td>${isLab?`<input type="checkbox" data-lab-select="${escape(r.id)}" ${state.selectedLabOTs.has(r.id)?'checked':''}>`:isReport?`<input type="checkbox" data-report-select="${escape(r.id)}" ${state.selectedReportOTs.has(r.id)?'checked':''}>`:isAuth?`<input type="checkbox" data-auth-select="${escape(r.id)}" ${state.selectedAuthOTs.has(r.id)?'checked':''} aria-label="Seleccionar ${escape(r.code)}">`:''} <b>${escape(r.code)}</b><small class="ot-cell-secondary">${escape(isLab?'Pendiente de ingreso oficial':isReport?'Informe pendiente':isAuth?(r.authorization?.state?('Estado '+r.authorization.state):'Por autorizar'):r.status)}</small></td><td><b>${escape(r.clientName)}</b><small class="ot-cell-secondary">${escape(r.branchName)}</small></td><td>${escape(r.monitoring)}</td><td>${escape(r.type)}</td><td>${escape(r.points)}</td><td>${escape(isReport?(r.laboratory?.deadline||'Sin plazo'):(r.workDate||'Pendiente'))}${isLab?`<small class="ot-cell-secondary">Recepción prevista: ${escape(r.laboratory?.proposedReceivedAt||'Sin fecha')}</small>`:''}</td>${isReport?`<td><span class="deadline-badge deadline-${reportDeadlineStatus(r.laboratory?.deadline).kind}">${escape(reportDeadlineStatus(r.laboratory?.deadline).label)}</span><small class="ot-cell-secondary">${escape(reportDeadlineStatus(r.laboratory?.deadline).detail)}</small></td>`:''}${isAuth?(()=>{const date=r.deliveryRealAt||r.report?.deliveryRealAt||'';const valid=/^\d{4}-\d{2}-\d{2}$/.test(date);const days=valid?Math.max(0,Math.floor((new Date(localToday()+'T12:00:00')-new Date(date+'T12:00:00'))/86400000)):null;const tone=days===null?'unknown':days>=4?'overdue':days>=2?'soon':'ok';return `<td>${escape(date||'Sin registrar')}</td><td><span class="deadline-badge deadline-${tone}">${days===null?'Sin fecha':days+' día(s)'}</span></td>`})():''}<td>${isLab?`<button class="btn alt" data-edit-reception="${escape(r.id)}">Editar fecha</button> <button class="btn" data-receive-ot="${escape(r.id)}">Confirmar ingreso</button> <button class="btn ghost" data-return-ot="${escape(r.id)}">↩ Devolver a registro</button>`:isReport?`<button class="btn" data-report-deliver="${escape(r.id)}">Registrar entrega</button>`:isAuth?`<button class="btn" data-auth-edit="${escape(r.id)}">Autorizar / retener</button>${['ADMINISTRADOR','OPERACIONES'].includes(role())&&!r.authorization?.state?` <button class="btn alt" data-auth-return="${escape(r.id)}" title="Rectificación con motivo y auditoría">↩ Regresar a informes pendientes</button>`:''}`:'<span class="tag">En seguimiento</span>'}</td></tr>`).join(''):'<tr><td colspan="${isReport?8:isAuth?9:7}" class="empty">No hay OT de esta etapa en la página visible.</td></tr>';
 target.querySelectorAll('[data-receive-ot]').forEach(b=>b.onclick=()=>laboratoryForm(b.dataset.receiveOt));
 target.querySelectorAll('[data-return-ot]').forEach(b=>b.onclick=()=>returnOTDialog([b.dataset.returnOt]));
 target.querySelectorAll('[data-edit-reception]').forEach(b=>b.onclick=()=>editPendingReception(b.dataset.editReception));
 target.querySelectorAll('[data-report-deliver]').forEach(b=>b.onclick=()=>reportDeliveryForm(b.dataset.reportDeliver));
 target.querySelectorAll('[data-auth-return]').forEach(b=>b.onclick=()=>returnAuthorizationToPending(b.dataset.authReturn));
 target.querySelectorAll('[data-auth-edit]').forEach(b=>b.onclick=()=>authorizationForm(b.dataset.authEdit));target.querySelectorAll('[data-auth-select]').forEach(b=>b.onchange=()=>{const ot=(state.rows.laboratory||[]).find(x=>x.id===b.dataset.authSelect);if(b.checked&&ot){if(state.selectedAuthOTs.size>=20){b.checked=false;toast('Máximo 20 OT por operación.',true);return}state.selectedAuthOTs.set(ot.id,ot.code)}else state.selectedAuthOTs.delete(b.dataset.authSelect);$('#auth-selected-count').textContent=state.selectedAuthOTs.size+' seleccionadas'});
 target.querySelectorAll('[data-lab-select]').forEach(b=>b.onchange=()=>{const ot=(state.rows.laboratory||[]).find(x=>x.id===b.dataset.labSelect);if(b.checked&&ot)state.selectedLabOTs.set(ot.id,ot.code);else state.selectedLabOTs.delete(b.dataset.labSelect);$('#lab-selected-count').textContent=state.selectedLabOTs.size+' seleccionadas'});
 target.querySelectorAll('[data-report-select]').forEach(b=>b.onchange=()=>{const ot=(state.rows.laboratory||[]).find(x=>x.id===b.dataset.reportSelect);if(b.checked&&ot)state.selectedReportOTs.set(ot.id,ot.code);else state.selectedReportOTs.delete(b.dataset.reportSelect);$('#report-selected-count').textContent=state.selectedReportOTs.size+' seleccionadas'});
 return;
 }
 target.innerHTML=rows.length?rows.map(r=>view==='ots'?`<tr><td><input type="checkbox" data-select-ot="${escape(r.id)}" ${state.selectedOTs.has(r.id)?'checked':''} aria-label="Seleccionar ${escape(r.code)}"></td><td><b>${escape(r.code||'—')}</b><small class="ot-cell-secondary">${escape(r.status==='EN_LABORATORIO'?'OT ingresada':r.status==='PROGRAMADA'?'OT programada':'OT registrada')}</small></td><td><b>${escape(r.clientName||'—')}</b><small class="ot-cell-secondary">${escape(r.branchName||'—')}</small></td><td>${escape(r.monitoring||'—')}</td><td>${escape(r.type||'—')}</td><td>${escape(r.points??'—')}</td><td>${escape(r.workDate||'Pendiente')}</td><td><div class="ot-row-actions"><button class="btn alt" data-edit-ot="${escape(r.id)}">Editar</button><button class="btn" data-send-ot="${escape(r.id)}">Enviar a laboratorio</button>${r.status!=='EN_LABORATORIO'&&isAdmin()?`<button class="btn danger" data-void-ot="${escape(r.id)}">Eliminar</button>`:''}</div></td></tr>`:`<tr><td><b>${escape(r.code||r.otCode||r.id.slice(0,8))}</b></td><td>${escape(r.clientName||r.client||'—')}</td><td>${escape(r.type||r.monitoringType||'—')}</td><td><span class="tag">${escape(r.status)}</span></td><td>${escape(r.sampledAt||'Pendiente')}</td><td><span class="tag">${escape(r.laboratory?.analyst||'OT ingresada')}</span></td></tr>`).join(''):`<tr><td colspan="${view==='ots'?8:6}" class="empty">No hay registros en esta página.</td></tr>`;
 if(view==='ots'){
  const count=$('#ot-selected-count');if(count)count.textContent=state.selectedOTs.size+' seleccionadas';target.querySelectorAll('[data-select-ot]').forEach(b=>b.onchange=()=>{const ot=(state.rows.ots||[]).find(r=>r.id===b.dataset.selectOt);if(b.checked&&ot)state.selectedOTs.set(ot.id,ot.code);else state.selectedOTs.delete(b.dataset.selectOt);const c=$('#ot-selected-count');if(c)c.textContent=state.selectedOTs.size+' seleccionadas'});target.querySelectorAll('[data-send-ot]').forEach(b=>b.onclick=()=>openIndividualSend(b.dataset.sendOt));
  target.querySelectorAll('[data-edit-ot]').forEach(b=>b.onclick=()=>editOT(b.dataset.editOt));
  target.querySelectorAll('[data-void-ot]').forEach(b=>b.onclick=()=>confirmVoidOT(b.dataset.voidOt));
 }
 if(view==='laboratory')target.querySelectorAll('[data-receive-ot]').forEach(b=>b.onclick=()=>laboratoryForm(b.dataset.receiveOt));
}
function returnOTDialog(ids){
 if(!ids.length)return toast('Seleccione al menos una OT pendiente de ingreso.',true);
 if(ids.length>20)return toast('Máximo 20 OT por devolución.',true);
 const names=ids.map(id=>(state.rows.laboratory||[]).find(r=>r.id===id)?.code||state.selectedLabOTs.get(id)||id);
 const host=document.createElement('div');host.className='catalog-overlay ot-edit-overlay';
 host.innerHTML=`<div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true" aria-label="Devolver OT a registro"><div class="catalog-heading"><div><h3>↩ Devolver a Registro de OT</h3><p class="muted">${escape(names.join(', '))}</p></div><button class="btn ghost" type="button" data-close>✕ Cerrar</button></div><p>Solo se devolverán OT pendientes de ingreso oficial. Se conservarán sus códigos y datos; podrá editarlas y reenviarlas.</p><form class="form"><label class="field">Motivo de devolución *<textarea name="reason" required minlength="10" maxlength="500" rows="3" placeholder="Describa el motivo (mínimo 10 caracteres)"></textarea></label><div class="ot-actions"><button class="btn" type="submit">Confirmar devolución${ids.length>1?' ('+ids.length+' OT)':''}</button><button class="btn alt" type="button" data-close>Cancelar</button></div><p class="muted" data-feedback role="status"></p></form></div>`;
 const close=()=>{host.remove();document.removeEventListener('keydown',key)};const key=e=>{if(e.key==='Escape')close()};document.addEventListener('keydown',key);host.onclick=e=>{if(e.target===host||e.target.closest('[data-close]'))close()};document.body.append(host);
 host.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('[type=submit]');b.disabled=true;f.querySelector('[data-feedback]').textContent='Validando y guardando en Firebase…';try{await returnPendingOTs(ids,f.elements.reason.value,state.user);ids.forEach(id=>state.selectedLabOTs.delete(id));close();await afterLaboratoryTransition(ids);toast(ids.length+' OT devuelta(s) a Registro de OT.')}catch(err){f.querySelector('[data-feedback]').textContent=err.message;toast(err.message,true)}finally{b.disabled=false}};
}
async function portalBatchSave(){const ids=[...state.selectedPortalOTs.keys()],date=$('#portal-batch-date').value;if(!ids.length)return toast('Seleccione al menos una OT autorizada.',true);if(!date)return toast('Indique la fecha de envío al portal.',true);if(!confirm(`¿Publicar ${ids.length} OT con fecha ${date}? Esta acción quedará auditada.`))return;const b=$('#portal-batch-save');b.disabled=true;try{await publishPortalBatch(ids,date,state.user);state.selectedPortalOTs.clear();await afterLaboratoryTransition(ids);toast(`${ids.length} informes enviados al portal. Consulte Supervisión de informes.`)}catch(e){toast(e.message,true)}finally{b.disabled=false}}
function sendDialog(title,content,onSubmit){
 const host=document.createElement('div');host.className='catalog-overlay ot-edit-overlay';host.innerHTML=`<div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true"><div class="catalog-heading"><h3>${escape(title)}</h3><button class="btn ghost" type="button" data-close>✕ Cerrar</button></div><form class="form">${content}<div class="ot-actions"><button class="btn" type="submit">Confirmar y enviar a laboratorio</button><button class="btn alt" type="button" data-close>Cancelar</button></div><p class="muted" data-feedback role="status"></p></form></div>`;
 const close=()=>{host.remove();document.removeEventListener('keydown',onKey)};const onKey=e=>{if(e.key==='Escape')close()};document.addEventListener('keydown',onKey);host.onclick=e=>{if(e.target===host||e.target.closest('[data-close]'))close()};document.body.append(host);
 host.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button[type=submit]');b.disabled=true;try{await onSubmit(f);close()}catch(err){f.querySelector('[data-feedback]').textContent=err.message;b.disabled=false}};
}
// Una escritura confirmada invalida los resultados históricos y actualiza la vista actual.
// No realiza un escaneo global: reutiliza la página consultada o su listener selectivo.
// Refresco inmediato después de escrituras confirmadas en Firestore.
// Se actualizan primero las filas locales para no depender de cambiar de módulo.
async function afterLaboratoryTransition(ids){
 if(state.view!=='laboratory')return;
 const changed=new Set(ids);
 state.rows.laboratory=(state.rows.laboratory||[]).filter(r=>!changed.has(r.id));
 if(labGlobal.active)labGlobal.rows=(labGlobal.rows||[]).filter(r=>!changed.has(r.id));
 if(labGlobal.active)renderLabGlobal();else paintRows('laboratory');
 // Los listeners de páginas no cubren los resultados de búsquedas globales.
 // Reconsultar únicamente la etapa activa para evitar datos obsoletos.
 try{
  if(labGlobal.active)await runLabGlobal();
  else attachPage('laboratory');
  await refreshLaboratoryStageCounts(true);
  // El total de OT del menú no cambia al trasladar entre etapas.
  paintMenuCounts();
 }catch(err){toast('Operación guardada; no se pudo actualizar la vista: '+err.message,true)}
}
async function afterLaboratorySend(ids){
 const sent=new Set(ids);
 otGlobal.cache=null;otGlobal.loadedAt=0;otGlobal.fullCache=null;otGlobal.fullLoadedAt=0;
 state.selectedOTs.forEach((_,id)=>{if(sent.has(id))state.selectedOTs.delete(id)});
 if(state.view==='ots'){
  if(otGlobal.active){
   // Reflejar la operación inmediatamente sin volver a descargar las 994 OT.
   state.rows.ots=(state.rows.ots||[]).filter(r=>!sent.has(r.id));
   paintRows('ots');
   await runGlobalOTFilter(true);
  }else{
   state.rows.ots=(state.rows.ots||[]).filter(r=>!sent.has(r.id));
   paintRows('ots');
   attachPage('ots');
  }
  await refreshMeasurementCounts(true);
 }
 refreshMenuCounts(true);
}
async function openIndividualSend(id){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Sin permiso para enviar OT.',true);
 let ot;try{ot=await fetchOT(id)}catch(e){return toast(e.message,true)}
 if(!ot||!['REGISTRADA','PROGRAMADA'].includes(ot.status))return toast('Esta OT ya no está pendiente.',true);
 const today=[new Date().getFullYear(),String(new Date().getMonth()+1).padStart(2,'0'),String(new Date().getDate()).padStart(2,'0')].join('-');
 sendDialog('Enviar a laboratorio · '+ot.code,`<p class="muted">${escape(ot.clientName)} / ${escape(ot.branchName)} · ${escape(ot.monitoring)}</p><label class="field">Fecha inicio del trabajo *<input name="workDate" type="date" required value="${escape(ot.workDate||'')}"></label><label class="field">Fecha recepción OT *<input name="receivedAt" type="date" required value="${today}"></label><label class="field">Motivo si cambia la fecha inicial<textarea name="reason" maxlength="500" placeholder="Obligatorio al corregir una fecha ya registrada"></textarea></label>`,async f=>{
 const workDate=f.elements.workDate.value,receivedAt=f.elements.receivedAt.value,reason=f.elements.reason.value.trim();if(receivedAt<workDate)throw Error('La recepción no puede ser anterior al inicio del trabajo.');if(!workDate)throw Error('Complete fecha de inicio de '+ot.code);if(ot.workDate&&ot.workDate!==workDate&&reason.length<10)throw Error('Explique la corrección de la fecha (mínimo 10 caracteres).');
 await sendLaboratoryOT(id,ot.version,{workDate,receivedAt,reason},state.user);await afterLaboratorySend([id]);toast('OT '+ot.code+' enviada y vista actualizada; pendiente de ingreso oficial.');
 });
}
async function openBatchSend(){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Sin permiso para enviar OT.',true);
 const selected=[...state.selectedOTs.entries()];if(!selected.length)return toast('Seleccione al menos una OT.',true);
 const today=[new Date().getFullYear(),String(new Date().getMonth()+1).padStart(2,'0'),String(new Date().getDate()).padStart(2,'0')].join('-');
 sendDialog('Enviar '+selected.length+' OT a laboratorio',`<p class="muted">OT seleccionadas: ${escape(selected.map(x=>x[1]).join(', '))}. Se verificará cada expediente antes de confirmar; ninguna OT será enviada si alguna no tiene fecha de inicio.</p><label class="field">Fecha recepción OT (común) *<input name="receivedAt" type="date" required value="${today}"></label>`,async f=>{
 if(!f.elements.receivedAt.value)throw Error('Seleccione fecha de recepción.');await sendLaboratoryBatch(selected.map(x=>x[0]),f.elements.receivedAt.value,state.user);await afterLaboratorySend(selected.map(x=>x[0]));toast(selected.length+' OT enviadas y vista actualizada; pendientes de ingreso oficial.');
 });
}
async function confirmVoidOT(id){
 if(!isAdmin())return toast('Solo un administrador puede anular OT.',true);
 if(!navigator.onLine)return toast('Se requiere conexión al servidor.',true);
 const ot=await fetchOT(id).catch(e=>{toast(e.message,true);return null});if(!ot)return;
 if(!['REGISTRADA','PROGRAMADA'].includes(ot.status))return toast('Solo se pueden anular OT que aún no ingresan a laboratorio.',true);
 const host=document.createElement('div');host.className='catalog-overlay ot-edit-overlay';
 host.innerHTML=`<div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true" aria-label="Anulación de OT"><div class="catalog-heading"><div><h3>Anular OT ${escape(ot.code)}</h3><p class="muted">La OT dejará de aparecer en la bandeja. Su código permanecerá reservado para siempre; la siguiente numeración no retrocederá.</p></div><button type="button" class="btn ghost" data-close>✕ Cerrar</button></div><form id="void-ot-form"><label class="field">Confirmación administrativa: escriba CALIDAD<input name="confirmation" autocomplete="off" required></label><label class="field">Motivo de anulación (obligatorio)<textarea name="reason" required minlength="10" maxlength="500" placeholder="Indique por qué se anula esta OT"></textarea></label><p class="muted">CALIDAD es una frase de confirmación, no una contraseña segura. Firebase verifica el rol ADMINISTRADOR.</p><div class="ot-actions"><button class="btn danger">Confirmar anulación</button><button type="button" class="btn alt" data-close>Cancelar</button></div></form></div>`;
 const close=()=>{host.remove();document.removeEventListener('keydown',onKey)};const onKey=e=>{if(e.key==='Escape')close()};document.addEventListener('keydown',onKey);host.onclick=e=>{if(e.target===host||e.target.closest('[data-close]'))close()};document.body.append(host);
 host.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget;if(f.elements.confirmation.value.trim()!=='OPERACIONES')return toast('Escriba exactamente CALIDAD.',true);const b=f.querySelector('button');b.disabled=true;try{await voidOT(id,Number(ot.version)||1,f.elements.reason.value,state.user);close();toast('OT '+ot.code+' anulada con trazabilidad. Código reservado permanentemente.')}catch(err){toast(err.message,true);b.disabled=false}};
}
let laboratoryCountLastAt=0,laboratoryCountBusy=false;
let laboratoryCountPromise=null,laboratoryCountQueued=false;
const LAB_COUNTS_TTL_MS=60_000; // Evita cuatro agregaciones por cada snapshot o cambio de pestaña.
let laboratoryCountValues=null;
try{laboratoryCountValues=JSON.parse(localStorage.getItem('psi-gases-stage-counts-v69')||'null')||JSON.parse(sessionStorage.getItem('psi-gases-stage-counts-v66')||'null')}catch{}
// El título usa exactamente el mismo conteo confirmado que la pestaña; nunca lee
// el texto del botón (que incluye su contador) ni solicita otra consulta.
function paintLaboratoryStageHeading(){
 const heading=document.querySelector('#lab-stage-title');
 if(!heading||state.view!=='laboratory')return;
 const stage=state.labStage||'EN_LABORATORIO';
 const names={EN_LABORATORIO:'Laboratorio · pendiente de ingreso',INFORME_PENDIENTE:'Informes pendientes',POR_AUTORIZAR:'Informes por autorizar',AUTORIZADO:'Autorizados / Portal'};
 const total=laboratoryCountValues?.[stage];
 heading.textContent=(names[stage]||stage)+(Number.isFinite(total)?' · '+total.toLocaleString('es-EC')+' informes':'');
}
function paintLaboratoryCounts(){paintLaboratoryStageHeading();if(!laboratoryCountValues)return;for(const [status,value] of Object.entries(laboratoryCountValues)){const el=document.querySelector(`[data-lab-count="${status}"]`);if(el&&Number.isFinite(value)){el.textContent=value.toLocaleString('es-EC');el.title='Último total confirmado; puede actualizarse al sincronizar';}}}
async function refreshLaboratoryStageCounts(force=false){
 paintLaboratoryCounts();
 if(state.view!=='laboratory'||!navigator.onLine)return;
 // Reutilizar una única petición en vuelo: sin colas recursivas ni consultas duplicadas.
 if(laboratoryCountPromise){if(force)laboratoryCountQueued=true;return laboratoryCountPromise;}
 if(!force&&laboratoryCountValues&&Date.now()-laboratoryCountLastAt<LAB_COUNTS_TTL_MS)return;
 const stages=['EN_LABORATORIO','INFORME_PENDIENTE','POR_AUTORIZAR','AUTORIZADO'];
 laboratoryCountBusy=true;
 laboratoryCountPromise=(async()=>{
  try{
   const counts=await Promise.all(stages.map(status=>countOTStage(status)));
   laboratoryCountValues=Object.fromEntries(stages.map((status,i)=>[status,counts[i]]));
   laboratoryCountLastAt=Date.now();
   try{sessionStorage.setItem('psi-gases-stage-counts-v66',JSON.stringify(laboratoryCountValues));localStorage.setItem('psi-gases-stage-counts-v69',JSON.stringify(laboratoryCountValues))}catch{}
   if(state.view!=='laboratory')return;
   paintLaboratoryCounts();
   const total=laboratoryCountValues[state.labStage];
   const note=document.querySelector('#lab-overview .lab-overview-note');
   if(note)note.textContent=`${total} OT en esta etapa en Firestore · indicadores RR/RG y puntos de la página visible`;
  }catch(e){console.warn('No se pudieron actualizar conteos de laboratorio',e)}
  finally{laboratoryCountBusy=false;laboratoryCountPromise=null;if(laboratoryCountQueued){laboratoryCountQueued=false;queueMicrotask(()=>refreshLaboratoryStageCounts(true))}}
 })();
 return laboratoryCountPromise;
}

function attachPage(view){
 stopWatch();const p=pagingState(view),generation=++state.watchGeneration;
 if(view==='laboratory'&&labGlobal.active){renderLabGlobal();return}
 const coll=tableConfigs[view][2];const stageFilter=view==='laboratory'?{field:'status',value:state.labStage||'EN_LABORATORIO'}:null;const indexedDate=view==='laboratory'&&labIndexedSort();const mode=indexedDate?$('#lab-sort').value:'';const sortField=indexedDate?(mode.startsWith('reception')?'laboratory.proposedReceivedAt':'workDate'):null;const sortDirection=indexedDate?(mode.endsWith('Asc')?'asc':'desc'):'asc';const series=view==='ots'?($('#ot-filter-series')?.value||'all'):(indexedDate?$('#lab-series').value:'all');const otStatus=view==='ots'?($('#ot-filter-status')?.value||'all'):'all';const otFilter=view==='ots'?(otStatus==='OT PROGRAMADA'?{field:'status',value:'PROGRAMADA'}:otStatus==='OT REGISTRADA'?{field:'status',value:'REGISTRADA'}:{field:'status',value:['REGISTRADA','PROGRAMADA']}):stageFilter;state.watchView=view;
 const st=$('#page-status');if(st)st.textContent='Conectando página '+(p.index+1)+'…';
 const prev=$('#prev'),next=$('#next');if(prev)prev.disabled=true;if(next)next.disabled=true;
 state.watchStop=watchPage(coll,{cursor:p.cursors[p.index]||null,size:p.size,filter:otFilter,sortField,sortDirection,series},({rows,cursor,more,fromCache,pending})=>{
  if(generation!==state.watchGeneration||state.view!==view)return;
  state.rows[view]=rows;p.lastCursor=cursor;p.hasMore=more;
  paintRows(view);
  displayCatalogNames(rows).then(displayRows=>{if(generation!==state.watchGeneration||state.view!==view)return;state.rows[view]=displayRows;paintRows(view)}).catch(console.warn);
  if(view==='ots'&&!fromCache)refreshMeasurementCounts();// Los snapshots de página NO disparan agregaciones: se consulta solo al entrar, guardar o actualizar manualmente.
  const label=!navigator.onLine?'Sin conexión · datos no confirmados':fromCache?'Caché · esperando servidor':pending?'Cambios locales pendientes':'Sincronizado con servidor';state.serverVerified=!fromCache&&!pending&&navigator.onLine;
  syncLabel(label);
  const status=$('#page-status');if(status)status.textContent=`Página ${p.index+1} · ${rows.length} registros · ${label}${indexedDate?' · fecha indexada (OT sin fecha excluidas)':''}`;
  if($('#prev'))$('#prev').disabled=p.index===0;
  if($('#next'))$('#next').disabled=!more||!cursor||fromCache;
 },e=>{if(generation!==state.watchGeneration)return;syncLabel('Error de sincronización');state.rows[view]=[];p.lastCursor=null;p.hasMore=false;paintRows(view);if($('#prev'))$('#prev').disabled=true;if($('#next'))$('#next').disabled=true;stopWatch();const status=$('#page-status');if(status)status.textContent='Error de consulta · '+e.message;toast(e.message,true);});
}
function otForm(){
 if(!isAdmin()&&!['OPERACIONES'].includes(role()))return toast('Su rol no puede registrar OT.',true);
 const year=new Date().getFullYear();
 $('#modal').innerHTML=`<div class="panel ot-register" style="margin-top:18px"><div class="ot-register-head"><div><div class="eyebrow">PSI · MEDICIONES AMBIENTALES</div><h3>Registro de medición ambiental</h3><p class="muted">Registro inicial: sin fecha de inicio, OT REGISTRADA; con fecha, OT PROGRAMADA. La recepción se registra en laboratorio.</p></div><span class="tag">PASO 1 · REGISTRO</span></div>
 <div class="ot-help"><b>Secuencias independientes:</b> RR y RG utilizan correlativos separados por año. El código se compone de serie + año (2 dígitos) + correlativo (4 dígitos). En 2026 el correlativo se asigna automáticamente al guardar. Desde 2027 se ingresa manualmente. Firestore impide duplicados.</div>
 <form id="new-ot" class="ot-grid">
 <label class="field">Monitoreo *<div class="catalog-input"><input name="monitoring" required maxlength="160" autocomplete="off" placeholder="Escriba para buscar un monitoreo…"><button type="button" class="btn alt" id="add-monitoring-inline" title="Nuevo monitoreo">＋</button></div><div id="monitoring-suggestions" class="smart-suggestions" role="listbox" hidden></div><small class="muted">Seleccione un monitoreo del catálogo. ＋ agrega uno nuevo.</small></label>
 <label class="field">Tipo de medición *<input name="type" required readonly placeholder="Se completa desde el catálogo"></label>
 <label class="field">N.º de puntos *<select name="points" required>${Array.from({length:100},(_,i)=>`<option value="${i+1}">${i+1}</option>`).join('')}</select></label>
 <label class="field span-2">Cliente *<div class="catalog-input"><input name="clientName" required maxlength="160" autocomplete="off" placeholder="Escriba para buscar un cliente…" aria-controls="client-suggestions" aria-expanded="false"><button type="button" class="btn alt" id="open-client-catalog" title="Agregar cliente">＋</button></div><div id="client-suggestions" class="smart-suggestions" role="listbox" hidden></div><small class="muted">Escriba el inicio del nombre y seleccione una coincidencia. ＋ agrega un cliente.</small></label>
 <label class="field">Sucursal / lugar *<div class="catalog-input"><input name="branchName" id="ot-branch" required maxlength="160" autocomplete="off" placeholder="Seleccione primero un cliente"><button type="button" class="btn alt" id="add-branch-inline" title="Agregar sucursal" disabled>＋</button></div><div id="branch-suggestions" class="smart-suggestions" role="listbox" hidden></div><small class="muted">Puede seleccionar o registrar una sucursal nueva aquí mismo.</small></label>
 <label class="field">Fecha inicio del trabajo<input name="workDate" type="date"></label>
 <label class="field">Recepción OT · laboratorio<input name="sampledAt" type="date" readonly value="" placeholder="Pendiente"><small class="muted">Se completa únicamente al confirmar el ingreso de laboratorio.</small></label>
 <label class="field">Identificación *<select name="series" required disabled><option value="">Seleccione monitoreo</option><option value="RR">RR</option><option value="RG">RG</option></select></label>
 <label class="field">Año de numeración *<input name="sequenceYear" type="number" min="2026" max="2099" value="${year}" required></label>
 <label class="field">Número correlativo <input name="sequence" type="number" min="1" max="9999" placeholder="Automático en 2026"></label>
 <label class="field">Código asignado<input id="ot-code-preview" name="code" readonly required placeholder="Complete serie, año y correlativo"></label>
 <label class="field">Estado de programación<input name="followUpDisplay" readonly value="OT REGISTRADA"><small class="muted">Se actualiza según la fecha de inicio.</small></label>
 <label class="field">Responsable de registro<div class="catalog-input"><select name="registeredBy"><option value="">Seleccione responsable</option></select><button type="button" class="btn alt" id="add-registration-responsible" title="Agregar responsable">＋</button></div><small class="muted" id="responsible-status">Cargando responsables…</small></label>
 <label class="field span-all">Observaciones<textarea name="observations" maxlength="1500" rows="3" placeholder="Información adicional de la OT"></textarea></label>
 <div class="ot-help span-all">La fecha de recepción de laboratorio se registrará en el siguiente módulo. Clientes y sucursales deben estar confirmados en Firebase antes de guardar la OT.</div>
 <div class="ot-actions span-all"><button class="btn">Guardar OT</button><button type="button" class="btn ghost" id="cancel">Ver mediciones registradas</button></div></form></div>`;
 const f=$('#new-ot');setupClientCatalog(f);setupMonitoringPicker(f);$('#cancel').onclick=()=>window.showRegisteredMeasurements?.();
 let previewSerial=0;
 const updateCode=async()=>{
  const year=Number(f.elements.sequenceYear.value),series=f.elements.series.value,automatic=year===2026;
  f.elements.sequence.disabled=automatic;f.elements.sequence.required=!automatic;f.elements.sequence.type=automatic?'text':'number';
  if(automatic){
   const token=++previewSerial;
   f.elements.sequence.value='';f.elements.sequence.placeholder=series?'Consultando siguiente número…':'Seleccione monitoreo';
   f.elements.code.value=series?'Consultando Firebase…':'Seleccione monitoreo';
   if(!series)return;
   try{
    const n=await Promise.race([nextOTSequence(series,year),new Promise((_,reject)=>setTimeout(()=>reject(new Error('La consulta tardó demasiado. Revise la conexión y los permisos de Firestore.')),8000))]);
    if(token!==previewSerial||!f.isConnected)return;
    f.elements.sequence.value=String(n).padStart(4,'0');f.elements.code.value=`${series}26${String(n).padStart(4,'0')}`;
    f.elements.code.title='Vista previa provisional. Firebase confirma el correlativo al guardar.';
   }catch(err){if(token!==previewSerial||!f.isConnected)return;f.elements.sequence.value='';f.elements.sequence.placeholder='Consulta no disponible';f.elements.code.value='Error al consultar correlativo';toast('No se pudo consultar el siguiente correlativo: '+err.message,true)}
  }else{
   ++previewSerial;const n=Number(f.elements.sequence.value);
   f.elements.sequence.placeholder='Ingrese correlativo';
   f.elements.code.value=year>=2027&&year<=2099&&Number.isInteger(n)&&n>=1&&n<=9999&&series?`${series}${String(year).slice(-2)}${String(n).padStart(4,'0')}`:'';
  }
 };
 ['series','sequenceYear'].forEach(k=>f.elements[k].addEventListener('change',updateCode));
 f.elements.sequence.addEventListener('input',()=>{if(Number(f.elements.sequenceYear.value)!==2026)updateCode()});
 const responsibleSelect=f.elements.registeredBy;
 const refreshResponsibles=async(selectName='')=>{
  const status=f.querySelector('#responsible-status');
  try{const names=await listRegistrationResponsibles();if(!f.isConnected)return;
   responsibleSelect.innerHTML='<option value="">Seleccione responsable</option>'+names.map(n=>`<option value="${escape(n)}">${escape(n)}</option>`).join('');
   if(selectName)responsibleSelect.value=selectName;
   status.textContent='Catálogo compartido · Firebase';
  }catch(err){status.textContent='No se pudo consultar el catálogo: '+err.message}
 };
 f.querySelector('#add-registration-responsible').onclick=async()=>{
  const name=prompt('Nombre completo del nuevo responsable de registro:');if(name===null)return;
  const button=f.querySelector('#add-registration-responsible');button.disabled=true;
  try{const saved=await addRegistrationResponsible(name,state.user);await refreshResponsibles(saved);toast('Responsable agregado al catálogo.');}
  catch(err){toast(err.message,true)}finally{button.disabled=false}
 };
 refreshResponsibles();updateCode();
 f.elements.workDate.addEventListener('change',()=>{f.elements.followUpDisplay.value=f.elements.workDate.value?'OT PROGRAMADA':'OT REGISTRADA'});
 f.onsubmit=async e=>{e.preventDefault();const b=f.querySelector('button');b.disabled=true;try{if(!navigator.onLine)throw new Error('Sin conexión. No se registró la OT.');const data=Object.fromEntries(new FormData(f));data.points=Number(data.points);data.sequence=Number(data.sequence||0);data.sequenceYear=Number(data.sequenceYear);if(data.sequenceYear!==2026&&!/^R[RG]\d{6}$/.test(data.code))throw new Error('Complete la numeración de la OT.');data.followUp=data.workDate?'OT_PROGRAMADA':'OT_POR_PROGRAMAR';delete data.followUpDisplay;if(!selectedMonitoring||normalizeClient(selectedMonitoring.name)!==normalizeClient(data.monitoring)||selectedMonitoring.active===false)throw new Error('Seleccione un monitoreo activo del catálogo.');data.monitoringId=selectedMonitoring.id;data.type=selectedMonitoring.type;data.series=selectedMonitoring.series;if(!selectedCatalogClient||normalizeClient(selectedCatalogClient.name)!==normalizeClient(data.clientName))throw new Error('Seleccione un cliente del catálogo.');if(!selectedCatalogClient.branches?.some(x=>x.active!==false&&x.id===selectedBranchId&&x.name===data.branchName))throw new Error('Seleccione una sucursal válida del cliente.');data.clientId=selectedCatalogClient.id;data.branchId=selectedBranchId;const saved=await createOT(data,state.user,f.dataset.requestId ||= crypto.randomUUID());emitEvent('REGISTER',saved.code,saved.id).catch(console.warn);toast('OT '+saved.code+' registrada. Puede ingresar la siguiente sin cambiar de pantalla.');applyConfirmedNewOT();
   // Se conserva la pestaña Registro. Se crea un formulario limpio y un nuevo idempotency key.
   // El correlativo se consulta nuevamente para evitar reutilizar la vista previa anterior.
   otForm(); }catch(err){toast(err.message+' Si no se confirmó el resultado, reintente desde este mismo formulario.',true)}finally{b.disabled=false}};
}

// V1.0.0.18: catálogo de monitoreos central y selección segura por ID.
let selectedMonitoring=null;
function setMonitoring(form,item){
 selectedMonitoring=item;
 form.elements.monitoring.value=item.name;
 form.elements.type.value=item.type;
 form.elements.series.value=item.series;
 form.querySelector('#monitoring-suggestions').hidden=true;
 form.elements.series.dispatchEvent(new Event('change'));
}
function setupMonitoringPicker(form){
 selectedMonitoring=null;
 const input=form.elements.monitoring,results=form.querySelector('#monitoring-suggestions');let serial=0,timer;
 const lookup=async()=>{
  const token=++serial,key=input.value.trim();results.hidden=false;results.innerHTML='<div class="smart-empty">Buscando monitoreos…</div>';
  try{const items=await searchMonitorings(key,30);if(token!==serial||!form.isConnected)return;
   results.innerHTML='';const active=items.filter(x=>x.active!==false);
   if(!active.length)results.innerHTML='<div class="smart-empty">No hay coincidencias activas.</div>';
   active.forEach(item=>{const b=document.createElement('button');b.type='button';b.className='smart-option';b.textContent=`${item.name} · ${item.type} · ${item.series}`;b.onclick=()=>setMonitoring(form,item);results.append(b)});
  }catch(e){if(token===serial)results.innerHTML='<div class="smart-empty">No se pudo consultar: '+escape(e.message)+'</div>'}
 };
 input.addEventListener('input',()=>{selectedMonitoring=null;form.elements.type.value='';form.elements.series.value='';form.elements.series.dispatchEvent(new Event('change'));clearTimeout(timer);timer=setTimeout(lookup,230)});
 input.addEventListener('focus',()=>{if(!selectedMonitoring)lookup()});
 input.addEventListener('keydown',e=>{if(e.key==='Escape')results.hidden=true;if(e.key==='Enter'&&!results.hidden){const first=results.querySelector('button');if(first){e.preventDefault();first.click()}}});
 document.addEventListener('pointerdown',e=>{if(!form.isConnected)return;if(!results.contains(e.target)&&e.target!==input)results.hidden=true});
 form.querySelector('#add-monitoring-inline').onclick=()=>openMonitoringEditor(null,item=>setMonitoring(form,item));
}
async function openMonitoringEditor(existing=null,onSaved=null){
 const host=document.createElement('div');host.className='catalog-overlay';
 host.innerHTML=`<div class="catalog-dialog" role="dialog" aria-modal="true" aria-label="Editar monitoreo"><div class="catalog-heading"><div><h3>${existing?'Editar':'Nuevo'} monitoreo</h3><p class="muted">El tipo y la identificación se asignarán automáticamente en cada OT.</p></div><button type="button" class="btn ghost" data-close>✕ Cerrar</button></div><form id="monitoring-editor"><label class="field">Nombre del monitoreo *<input name="name" required maxlength="160" value="${escape(existing?.name||'')}" ${existing?'readonly':''}></label><label class="field">Tipo de medición *<select name="type" required><option value="LABORAL" ${existing?.type==='LABORAL'?'selected':''}>Laboral</option><option value="AMBIENTAL" ${existing?.type==='AMBIENTAL'?'selected':''}>Ambiental</option></select></label><label class="field">Identificación *<select name="series" required><option value="RR" ${existing?.series==='RR'?'selected':''}>RR</option><option value="RG" ${existing?.series==='RG'?'selected':''}>RG</option></select></label><label class="field">Acceso confidencial a Facturación<select name="billingAccess"><option value="false">No autorizado</option><option value="true">Autorizado</option></select></label><label class="field">Estado<select name="active"><option value="true">ACTIVO</option><option value="false" ${existing?.active===false?'selected':''}>INACTIVO</option></select></label><div class="ot-actions"><button class="btn" type="submit">Guardar monitoreo</button><button type="button" class="btn alt" data-close>Cancelar</button></div><p class="muted" id="monitoring-editor-status"></p></form></div>`;
 document.body.append(host);host.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();host.remove()},{once:true}));host.addEventListener('click',e=>{if(e.target===host){e.stopPropagation();host.remove()}});
 const form=host.querySelector('form');form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;try{const item=await saveMonitoring({id:existing?.id,name:form.elements.name.value,type:form.elements.type.value,series:form.elements.series.value,active:form.elements.active.value==='true'},state.user);host.remove();toast('Monitoreo guardado en Firebase.');if(onSaved)onSaved(item);if(state.view==='monitorings')monitoringsView()}catch(err){form.querySelector('#monitoring-editor-status').textContent='Error: '+err.message;button.disabled=false}};
}
async function monitoringsView(){
 hero('Catálogo de monitoreos','Catálogo compartido para el registro de OT. Tipo de medición e identificación automáticos.');
 $('#content').insertAdjacentHTML('beforeend',`<div class="section-heading"><div><h2>Monitoreos configurados</h2><p>Consulte por nombre, edite el tipo o la identificación y desactive sin borrar el histórico.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn alt" id="monitoring-export">⇩ Exportar catálogo Firebase CSV</button><button class="btn alt" id="monitoring-import-open">⇧ Importar CSV</button><button class="btn" id="monitoring-new">＋ Nuevo monitoreo</button></div></div><div id="monitoring-import-host"></div><div class="panel"><div class="toolbar"><input id="monitoring-filter" class="search" placeholder="Buscar monitoreo por nombre…" autocomplete="off"><span class="muted" id="monitoring-count">Consultando…</span></div><div id="monitoring-list" class="catalog-list"></div><div class="catalog-footer"><button class="btn alt" id="monitoring-more">Cargar más</button></div></div>`);
 $('#monitoring-new').onclick=()=>openMonitoringEditor();$('#monitoring-import-open').onclick=()=>showMonitoringImporter();$('#monitoring-export').onclick=async()=>{
 const btn=$('#monitoring-export');btn.disabled=true;btn.textContent='Consultando catálogo completo…';
 try{
  const rows=await exportAllMonitorings();
  const values=[['MONITOREO','TIPO DE MEDICIÓN','IDENTIFICACIÓN','ESTADO','ID FIREBASE','CLAVE NORMALIZADA']];
  for(const r of rows)values.push([r.name||'',r.type||'',r.series||'',r.active===false?'INACTIVO':'ACTIVO',r.id||'',r.nameKey||'']);
  const csv='\uFEFF'+values.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='CATALOGO_MONITOREOS_FIREBASE_GASES_2027.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
  alert(`Exportación finalizada: ${rows.length} monitoreos (incluye activos e inactivos). No se modificó Firebase.`);
 }catch(err){toast('Error al exportar monitoreos: '+err.message,true)}finally{btn.disabled=false;btn.textContent='⇩ Exportar catálogo Firebase CSV'}
};let serial=0,timer,shown=[];
 const load=async(more=false)=>{const token=++serial;const q=$('#monitoring-filter').value.trim();$('#monitoring-count').textContent='Consultando Firebase…';try{const requested=more?Math.min(shown.length+30,250):30;const rows=await searchMonitorings(q,requested);if(token!==serial||state.view!=='monitorings')return;shown=rows;$('#monitoring-count').textContent=`${rows.length} mostrados`;$('#monitoring-more').hidden=rows.length<requested||requested>=250;$('#monitoring-list').innerHTML=rows.length?rows.map((r,i)=>`<div class="catalog-row"><div><b>${escape(r.name)}</b><small>${escape(r.type)} · ${escape(r.series)} · ${r.active===false?'INACTIVO':'ACTIVO'}</small></div><div class="catalog-row-actions"><button class="btn alt" data-monitor-edit="${i}">Editar</button><button class="btn alt" data-monitor-toggle="${i}">${r.active===false?'Activar':'Desactivar'}</button></div></div>`).join(''):'<div class="smart-empty">Sin monitoreos registrados. Puede crear el primero.</div>';
 $('#monitoring-list').querySelectorAll('[data-monitor-edit]').forEach(b=>b.onclick=()=>openMonitoringEditor(shown[Number(b.dataset.monitorEdit)]));$('#monitoring-list').querySelectorAll('[data-monitor-toggle]').forEach(b=>b.onclick=async()=>{const r=shown[Number(b.dataset.monitorToggle)];if(!confirm(`¿${r.active===false?'Activar':'Desactivar'} ${r.name}?`))return;try{await saveMonitoring({...r,active:r.active===false},state.user);monitoringsView()}catch(e){toast(e.message,true)}});
 }catch(e){if(token===serial)$('#monitoring-count').textContent='Error: '+e.message}};
 $('#monitoring-filter').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>load(false),250)};
 $('#monitoring-more').onclick=()=>{const n=shown.length;load(true)};load();
}

// Importador controlado del catálogo de monitoreos: no altera registros existentes.
function prepareMonitoringCSV(text){
 const rows=parseCatalogCSV(text);const expected=['MONITOREO','TIPO DE MEDICIÓN','IDENTIFICACIÓN','ESTADO'];
 if(rows.length<2||expected.some((v,i)=>normalizeImportName(rows[0][i])!==normalizeImportName(v)))throw new Error('Encabezados incorrectos. Use MONITOREO, TIPO DE MEDICIÓN, IDENTIFICACIÓN, ESTADO.');
 const items=[],issues=[],seen=new Map();
 for(let i=1;i<rows.length;i++){
  const row=rows[i];if(!row.some(v=>String(v||'').trim()))continue;
  if(row.length!==4){issues.push(`Fila ${i+1}: deben existir exactamente 4 columnas`);continue}
  const [name,rawType,rawSeries,rawStatus]=row.map(v=>String(v||'').trim());
  const type=normalizeImportName(rawType).toUpperCase(),series=rawSeries.toUpperCase(),status=rawStatus.toUpperCase(),key=normalizeImportName(name);
  if(!name||name.length>160)issues.push(`Fila ${i+1}: nombre vacío o superior a 160 caracteres`);
  if(!['LABORAL','AMBIENTAL'].includes(type))issues.push(`Fila ${i+1}: tipo inválido (${rawType})`);
  if(!['RR','RG'].includes(series))issues.push(`Fila ${i+1}: identificación inválida (${rawSeries})`);
  if(!['ACTIVO','INACTIVO'].includes(status))issues.push(`Fila ${i+1}: estado inválido (${rawStatus})`);
  if(seen.has(key))issues.push(`Fila ${i+1}: monitoreo duplicado con fila ${seen.get(key)} (${name})`);else seen.set(key,i+1);
  items.push({name,type,series,active:status==='ACTIVO',row:i+1,key});
 }
 if(!items.length)issues.push('No hay monitoreos para importar');
 return {items,issues};
}
function downloadMonitoringLog(rows){
 const content=[['FILA','MONITOREO','RESULTADO','DETALLE'],...rows].map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
 const blob=new Blob(['\uFEFF'+content],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='REPORTE_IMPORTACION_MONITOREOS_PSI.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function showMonitoringImporter(){
 const host=$('#monitoring-import-host');if(!host)return;
 if(host.innerHTML){host.innerHTML='';return}
 host.innerHTML=`<div class="panel"><h3>Importación histórica de monitoreos · CSV UTF-8</h3><p class="muted">Archivo de cuatro columnas: MONITOREO, TIPO DE MEDICIÓN, IDENTIFICACIÓN, ESTADO. Los existentes se omiten sin modificarlos. Solo administradores pueden importar.</p><label class="field">Seleccionar CSV<input type="file" id="monitoring-csv-file" accept=".csv,text/csv"></label><div class="notice" id="monitoring-csv-preview">Seleccione un archivo para validar sin escribir en Firebase.</div><div id="monitoring-csv-actions" hidden><label style="display:flex;gap:8px;align-items:center;margin:12px 0"><input id="monitoring-csv-confirm" type="checkbox" style="width:auto"> Confirmo que revisé los datos y autorizo crear solo los monitoreos nuevos.</label><button class="btn" id="monitoring-csv-run" disabled>Importar monitoreos nuevos</button> <button class="btn alt" id="monitoring-csv-report" disabled>Descargar reporte</button><p id="monitoring-csv-progress" class="muted" role="status"></p></div></div>`;
 let prepared=null,report=[];const fileInput=$('#monitoring-csv-file'),run=$('#monitoring-csv-run'),confirmBox=$('#monitoring-csv-confirm');
 $('#monitoring-csv-report').onclick=()=>downloadMonitoringLog(report);
 fileInput.onchange=async()=>{prepared=null;report=[];$('#monitoring-csv-actions').hidden=true;const file=fileInput.files[0];if(!file)return;try{
  if(file.size>2*1024*1024)throw new Error('Archivo demasiado grande (máximo 2 MB).');
  prepared=prepareMonitoringCSV(await file.text());const p=prepared;
  $('#monitoring-csv-preview').innerHTML=`<b>Vista previa, sin escrituras:</b> ${p.items.length} monitoreos; ${p.items.filter(x=>x.type==='LABORAL').length} laborales; ${p.items.filter(x=>x.type==='AMBIENTAL').length} ambientales; ${p.items.filter(x=>x.series==='RR').length} RR; ${p.items.filter(x=>x.series==='RG').length} RG.<br><b>Observaciones: ${p.issues.length}</b><div style="max-height:160px;overflow:auto">${p.issues.slice(0,80).map(x=>'<div>• '+escape(x)+'</div>').join('')||'Sin errores estructurales.'}</div><p class="muted">Ejemplos: ${escape(p.items.slice(0,5).map(x=>x.name).join(' · '))}</p>`;
  $('#monitoring-csv-actions').hidden=false;confirmBox.checked=false;run.disabled=true;
 }catch(e){$('#monitoring-csv-preview').textContent='Error de archivo: '+e.message}};
 confirmBox.onchange=()=>run.disabled=!confirmBox.checked||!prepared||prepared.issues.length>0||!isAdmin();
 run.onclick=async()=>{if(!isAdmin()||!prepared||prepared.issues.length||!confirmBox.checked)return;
  if(!window.confirm(`¿Importar hasta ${prepared.items.length} monitoreos nuevos? Los existentes no se modificarán.`))return;
  run.disabled=true;fileInput.disabled=true;$('#monitoring-csv-report').disabled=true;report=[];let created=0,skipped=0,failed=0;
  for(let i=0;i<prepared.items.length;i++){
   const item=prepared.items[i];$('#monitoring-csv-progress').textContent=`${i+1}/${prepared.items.length} · creados ${created} · existentes ${skipped} · errores ${failed}`;
   try{
    const matches=await searchMonitorings(item.name,10);
    if(matches.some(x=>normalizeImportName(x.name)===item.key)){skipped++;report.push([item.row,item.name,'EXISTENTE','Sin cambios']);continue}
    await saveMonitoring(item,state.user);created++;report.push([item.row,item.name,'CREADO',`${item.type} · ${item.series}`]);
   }catch(err){
    if(String(err.message||'').includes('ya existe')){skipped++;report.push([item.row,item.name,'EXISTENTE','Detectado durante transacción']);continue}
    failed++;report.push([item.row,item.name,'ERROR',err.message]);
    if(!navigator.onLine||['permission-denied','unavailable','unauthenticated'].includes(err.code)){report.push(['','','DETENIDO','Compruebe permisos o conexión y vuelva a ejecutar']);break}
   }
  }
  $('#monitoring-csv-progress').textContent=`Terminado: ${created} creados, ${skipped} existentes, ${failed} errores. Descargue el reporte.`;
  $('#monitoring-csv-report').disabled=false;fileInput.disabled=false;confirmBox.checked=false;
  toast(`Monitoreos: ${created} creados, ${skipped} omitidos, ${failed} errores.`,failed>0);
 };
}

// Catálogo integrado: cliente obligatorio, RUC opcional y una o más sucursales.
let selectedCatalogClient=null,selectedBranchId='';
const normalizeClient=s=>String(s||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ');
function pickCatalogClient(form,client){
 selectedCatalogClient=client;selectedBranchId='';
 form.elements.clientName.value=client.name;
 form.elements.branchName.value='';
 form.elements.branchName.placeholder='Buscar o escribir sucursal…';
 const plus=form.querySelector('#add-branch-inline');if(plus)plus.disabled=false;
 const suggestions=form.querySelector('#client-suggestions');if(suggestions)suggestions.hidden=true;
}
function setupClientCatalog(form){
 selectedCatalogClient=null;selectedBranchId='';
 const input=form.elements.clientName,branch=form.elements.branchName;
 const results=form.querySelector('#client-suggestions'),branchResults=form.querySelector('#branch-suggestions');
 const plus=form.querySelector('#add-branch-inline');
 let serial=0,timer;
 function clearBranch(){selectedBranchId='';branch.value='';branchResults.hidden=true;plus.disabled=!selectedCatalogClient;}
 function showBranches(){
  branchResults.innerHTML='';if(!selectedCatalogClient){branchResults.hidden=true;return;}
  const key=normalizeClient(branch.value);
  const choices=(selectedCatalogClient.branches||[]).filter(b=>b.active!==false&&normalizeClient(b.name).includes(key)).slice(0,20);
  choices.forEach(b=>{const btn=document.createElement('button');btn.type='button';btn.className='smart-option';btn.textContent=b.name;btn.onclick=()=>{selectedBranchId=b.id;branch.value=b.name;branchResults.hidden=true;};branchResults.append(btn)});
  if(branch.value.trim()&&!choices.some(b=>normalizeClient(b.name)===normalizeClient(branch.value))){
   const btn=document.createElement('button');btn.type='button';btn.className='smart-option smart-add';btn.textContent='＋ Agregar «'+branch.value.trim()+'» a '+selectedCatalogClient.name;btn.onclick=()=>saveNewBranch();branchResults.append(btn);
  }
  branchResults.hidden=!branchResults.children.length;
 }
 async function saveNewBranch(){
  if(!selectedCatalogClient)return toast('Seleccione primero un cliente.',true);
  const name=branch.value.trim();if(!name)return toast('Escriba la sucursal.',true);
  plus.disabled=true;try{
   const saved=await addBranch(selectedCatalogClient.id,name,state.user);
   pickCatalogClient(form,saved);const added=saved.branches.find(b=>normalizeClient(b.name)===normalizeClient(name));
   branch.value=added.name;selectedBranchId=added.id;branchResults.hidden=true;
   toast('Sucursal guardada y sincronizada con Firebase.');
  }catch(e){toast(e.message,true);showBranches()}finally{plus.disabled=false}
 }
 input.addEventListener('input',()=>{
  selectedCatalogClient=null;clearBranch();plus.disabled=true;clearTimeout(timer);const current=++serial;
  const prefix=input.value.trim();results.innerHTML='';results.hidden=true;
  if(!prefix)return;
  timer=setTimeout(async()=>{try{
   const matches=await searchClients(prefix);if(current!==serial)return;
   matches.forEach(c=>{const btn=document.createElement('button');btn.type='button';btn.className='smart-option';btn.textContent=c.name+(c.taxId?' · '+c.taxId:'');btn.onclick=()=>{pickCatalogClient(form,c);clearBranch();input.setAttribute('aria-expanded','false')};results.append(btn)});
   if(!matches.length){const p=document.createElement('div');p.className='smart-empty';p.textContent='No hay coincidencias. Utilice ＋ para crear el cliente.';results.append(p)}
   results.hidden=false;input.setAttribute('aria-expanded','true');
  }catch(e){if(current===serial){results.textContent='No se pudo buscar: '+e.message;results.hidden=false}}},320);
 });
 input.addEventListener('focus',()=>{if(results.children.length)results.hidden=false});
 branch.addEventListener('input',()=>{selectedBranchId='';showBranches()});
 branch.addEventListener('focus',showBranches);
 plus.onclick=saveNewBranch;
 form.querySelector('#open-client-catalog').onclick=()=>openClientCatalog(form,true);
 document.addEventListener('click',e=>{if(!form.isConnected)return;if(!results.contains(e.target)&&e.target!==input)results.hidden=true;if(!branchResults.contains(e.target)&&e.target!==branch)branchResults.hidden=true});
}
async function openClientCatalog(form=null,newOnly=false){
 const host=document.createElement('div');host.className='catalog-overlay';
 host.innerHTML=`<div class="catalog-dialog" role="dialog" aria-modal="true" aria-label="Clientes y sucursales">
 <div class="catalog-heading"><div><h3>Clientes y sucursales</h3><p class="muted">Razón social, RUC opcional y sucursales vinculadas. Seleccione o administre un cliente.</p></div><button type="button" class="btn ghost" data-close>✕ Cerrar</button></div>
 <div class="catalog-tools"><button class="btn" id="catalog-new">+ Nuevo cliente</button><span class="muted">10 clientes por página · Firestore bajo demanda</span></div>
 <div id="catalog-editor" hidden></div><div id="catalog-feedback" class="notice">${form?'Seleccione un cliente para utilizarlo en la OT.':'Administre aquí los mismos clientes y sucursales que utiliza el registro de mediciones.'}</div>
 <div id="catalog-rows" class="catalog-list"></div><div class="catalog-footer"><button class="btn alt" id="catalog-prev" disabled>← Anterior</button><span id="catalog-page">Página 1</span><button class="btn alt" id="catalog-next">Siguiente →</button></div></div>`;
 document.body.append(host);const close=()=>host.remove();host.querySelector('[data-close]').addEventListener('click',e=>{e.preventDefault();e.stopPropagation();close()},{once:true});host.onclick=e=>{if(e.target===host){e.stopPropagation();close()}};
 let stack=[null],idx=0,rows=[],nextCursor=null,hasMore=false;
 const feedback=host.querySelector('#catalog-feedback');
 const editor=host.querySelector('#catalog-editor');
 function openEditor(client=null){
  const isEdit=!!client;const branches=(client?.branches?.length?client.branches:[{name:'',active:true}]);
  editor.hidden=false;
  editor.innerHTML=`<form id="client-editor-form" class="client-editor"><h3>${isEdit?'Editar cliente':'Nuevo cliente'}</h3><div class="client-editor-grid">
  <label class="field">Nombre / razón social *<input name="name" maxlength="160" required  value="${escape(client?.name||'')}"></label>
  <label class="field">RUC (opcional)<input name="taxId" maxlength="20" value="${escape(client?.taxId||'')}"></label></div>
  <h4>Sucursales / lugares *</h4><div id="client-branch-list"></div>
  <button type="button" class="btn alt" id="add-client-branch">+ Agregar sucursal</button>
  <div class="ot-actions"><button class="btn" type="submit">Guardar cliente</button><button class="btn ghost" type="button" id="cancel-client-editor">Cancelar</button></div></form>`;
  const list=editor.querySelector('#client-branch-list');
  function addRow(b={name:'',active:true,id:''}){
   const row=document.createElement('div');row.className='client-branch-row';row.dataset.id=b.id||'';
   row.innerHTML=`<label class="field">Sucursal / lugar<input class="branch-name" required maxlength="160" value="${escape(b.name)}" placeholder="Nombre de sucursal"></label><label class="field">Estado<select class="branch-active"><option value="true" ${b.active!==false?'selected':''}>Activa</option><option value="false" ${b.active===false?'selected':''}>Inactiva</option></select></label><button class="btn ghost" type="button">Quitar</button>`;
   row.querySelector('button').onclick=()=>{if(list.children.length<=1){feedback.textContent='Debe mantener al menos una sucursal.';return}row.remove()};list.append(row);
  }
  branches.forEach(addRow);editor.querySelector('#add-client-branch').onclick=()=>addRow();
  editor.querySelector('#cancel-client-editor').onclick=()=>{editor.hidden=true};
  editor.querySelector('form').onsubmit=async e=>{
   e.preventDefault();const f=e.target,btn=f.querySelector('[type="submit"]');btn.disabled=true;
   const payload={name:f.elements.name.value,taxId:f.elements.taxId.value,active:isEdit?client.active!==false:true,branches:[...list.children].map(row=>({id:row.dataset.id||undefined,name:row.querySelector('.branch-name').value,active:row.querySelector('.branch-active').value==='true'}))};
   try{let saved;if(isEdit){await updateClient(client.id,payload,state.user);saved={...client,...payload}}else saved=await addClient(f.elements.name.value,state.user,payload);
    if(form)pickCatalogClient(form,saved);editor.hidden=true;feedback.textContent='Cliente y sucursales guardados correctamente.';toast('Catálogo actualizado en Firebase.');await load();
   }catch(err){feedback.textContent='No se guardó: '+err.message}finally{btn.disabled=false}
  };
 }
 async function load(){const area=host.querySelector('#catalog-rows');area.textContent='Consultando clientes…';try{
  const result=await page('clients',stack[idx],null,10);rows=result.rows;nextCursor=result.cursor;hasMore=result.more;
  area.innerHTML=rows.length?rows.map((r,i)=>`<div class="catalog-row"><div><b>${escape(r.name)}</b><small>RUC: ${escape(r.taxId||'No registrado')} · ${(r.branches||[]).length} sucursal(es) · ${r.active===false?'INACTIVO':'ACTIVO'}</small><small>${escape((r.branches||[]).map(x=>x.name).join(' · ')||'Sin sucursales: completar catálogo')}</small></div><div class="catalog-row-actions"><button class="btn alt" data-edit="${i}">Editar</button><button class="btn alt" data-pick="${i}" ${!form||r.active===false||!(r.branches||[]).some(x=>x.active!==false)?'disabled':''} ${!form?'hidden':''}>Seleccionar</button></div></div>`).join(''):'<p class="muted">No hay clientes en esta página.</p>';
  area.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditor(rows[Number(b.dataset.edit)]));
  area.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>{if(form){pickCatalogClient(form,rows[Number(b.dataset.pick)]);close()}});
  host.querySelector('#catalog-prev').disabled=idx===0;host.querySelector('#catalog-next').disabled=!hasMore;host.querySelector('#catalog-page').textContent=`Página ${idx+1}`;
 }catch(err){area.textContent='Error: '+err.message}}
 host.querySelector('#catalog-new').onclick=()=>openEditor();
 host.querySelector('#catalog-prev').onclick=()=>{if(idx){idx--;load()}};
 host.querySelector('#catalog-next').onclick=()=>{if(hasMore&&nextCursor){stack[idx+1]=nextCursor;idx++;load()}};
 if(newOnly){openEditor();host.querySelector('#catalog-rows').hidden=true;host.querySelector('.catalog-footer').hidden=true;host.querySelector('#catalog-new').hidden=true;}else await load();
}
async function editOT(id){
 if(!isAdmin()&&!['OPERACIONES'].includes(role()))return toast('Sin permiso de edición.',true);
 if(!navigator.onLine)return toast('Sin conexión: edición bloqueada.',true);
 const host=document.createElement('div');host.className='catalog-overlay ot-edit-overlay';host.setAttribute('role','presentation');
 const close=()=>{host.remove();document.removeEventListener('keydown',escapeHandler)};
 const escapeHandler=e=>{if(e.key==='Escape')close()};
 document.addEventListener('keydown',escapeHandler);host.addEventListener('click',e=>{if(e.target===host)close()});
 host.innerHTML='<div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true" aria-label="Editar OT"><p class="muted">Consultando versión actual de la OT…</p></div>';document.body.append(host);
 try{
  const ot=await fetchOT(id);if(!ot)throw new Error('La OT ya no existe.');if(!host.isConnected)return;
  const originalSeries=ot.series||String(ot.code||'').slice(0,2);
  if(!['RR','RG'].includes(originalSeries))throw new Error('Identificación histórica inválida.');
  const received=ot.status==='EN_LABORATORIO';
  host.querySelector('.ot-edit-dialog').innerHTML=`<div class="catalog-heading"><div><div class="eyebrow">PSI · EDICIÓN CONTROLADA</div><h3>Editar OT ${escape(ot.code)}</h3><p class="muted">Identificación ${escape(originalSeries)} fija · Versión ${Number(ot.version)||1} · ${received?'OT recibida: fecha de inicio protegida':'Cambios auditables en Firebase'}</p></div><button type="button" class="btn ghost" data-close>✕ Cerrar</button></div>
  <div class="notice">Solo se muestran monitoreos ${escape(originalSeries)}. El código y la identificación no se pueden modificar.</div>
  <form id="edit-ot" class="ot-edit-grid">
   <label class="field">Código de OT<input value="${escape(ot.code)}" readonly></label>
   <label class="field">Identificación<input value="${escape(originalSeries)}" readonly></label>
   <label class="field ot-edit-picker">Monitoreo *<input name="monitoring" autocomplete="off" maxlength="160" required value="${escape(ot.monitoring||'')}" placeholder="Buscar monitoreo ${escape(originalSeries)}"><div class="smart-suggestions" data-suggestions="monitoring" hidden></div></label>
   <label class="field">Tipo de medición<input name="type" readonly value="${escape(ot.type||'')}"></label>
   <label class="field ot-edit-picker">Cliente *<input name="clientName" autocomplete="off" required maxlength="160" value="${escape(ot.clientName||'')}" placeholder="Buscar cliente"><div class="smart-suggestions" data-suggestions="client" hidden></div></label>
   <label class="field ot-edit-picker">Sucursal / lugar *<div class="catalog-input"><input name="branchName" autocomplete="off" maxlength="160" required value="${escape(ot.branchName||'')}" placeholder="Seleccione sucursal"><button type="button" class="btn alt" id="edit-add-branch" title="Agregar sucursal">＋</button></div><div class="smart-suggestions" data-suggestions="branch" hidden></div></label>
   <label class="field">N.º de puntos *<select name="points">${Array.from({length:100},(_,i)=>`<option value="${i+1}" ${Number(ot.points)===i+1?'selected':''}>${i+1}</option>`).join('')}</select></label>
   <label class="field">Fecha inicio del trabajo<input name="workDate" type="date" value="${escape(ot.workDate||'')}" ${received?'readonly':''}></label>
   <label class="field">Responsable de registro<div class="catalog-input"><select name="registeredBy"><option value="">Seleccione responsable</option></select><button type="button" class="btn alt" id="edit-add-responsible" title="Agregar responsable">＋</button></div></label>
   <label class="field">Recepción OT · laboratorio<input value="${escape(ot.sampledAt||ot.laboratory?.proposedReceivedAt||'Pendiente')}" readonly></label>
   <label class="field span-all">Observaciones<textarea name="observations" maxlength="1500" rows="3">${escape(ot.observations||'')}</textarea></label>
   <div class="ot-edit-actions span-all"><button class="btn" type="submit">Guardar cambios</button><button type="button" class="btn ghost" data-close>Cancelar</button><span id="edit-feedback" class="muted" role="status"></span></div>
  </form>`;
  host.querySelectorAll('[data-close]').forEach(x=>x.onclick=close);
  const f=host.querySelector('form');const norm=normalizeClient;
  let monitoring={id:ot.monitoringId||'',name:ot.monitoring||'',type:ot.type||'',series:originalSeries};
  let client={id:ot.clientId||'',name:ot.clientName||'',branches:[]};let branchId=ot.branchId||'';
  const dropdown=(key)=>f.querySelector(`[data-suggestions="${key}"]`);
  function options(key,items,onPick){const box=dropdown(key);box.innerHTML='';items.forEach(item=>{const btn=document.createElement('button');btn.type='button';btn.className='smart-option';btn.textContent=item.label;btn.onclick=()=>{onPick(item.value);box.hidden=true};box.append(btn)});if(!items.length)box.innerHTML='<div class="smart-empty">Sin coincidencias</div>';box.hidden=false}
  function hideOptions(e){if(!host.isConnected)return;for(const key of ['monitoring','client','branch']){const box=dropdown(key);const field=box.closest('.ot-edit-picker');if(!field.contains(e.target))box.hidden=true}}
  host.addEventListener('click',hideOptions);
  function branches(){const key=norm(f.elements.branchName.value);const rows=(client.branches||[]).filter(x=>x.active!==false&&norm(x.name).includes(key)).slice(0,40);options('branch',rows.map(x=>({label:x.name,value:x})),x=>{branchId=x.id;f.elements.branchName.value=x.name})}
  let mToken=0,cToken=0;
  async function findMonitoring(){const token=++mToken;try{const rows=await searchMonitorings(f.elements.monitoring.value.trim(),100);if(token!==mToken||!host.isConnected)return;options('monitoring',rows.filter(x=>x.active!==false&&x.series===originalSeries).map(x=>({label:`${x.name} · ${x.type} · ${x.series}`,value:x})),x=>{monitoring=x;f.elements.monitoring.value=x.name;f.elements.type.value=x.type})}catch(e){dropdown('monitoring').textContent=e.message;dropdown('monitoring').hidden=false}}
  async function findClient(){const token=++cToken;const key=f.elements.clientName.value.trim();if(!key){dropdown('client').hidden=true;return}try{const rows=await searchClients(key,10);if(token!==cToken||!host.isConnected)return;options('client',rows.map(x=>({label:x.name,value:x})),x=>{client=x;branchId='';f.elements.clientName.value=x.name;f.elements.branchName.value='';dropdown('branch').hidden=true})}catch(e){dropdown('client').textContent=e.message;dropdown('client').hidden=false}}
  let mTimer,cTimer;
  f.elements.monitoring.addEventListener('input',()=>{monitoring=null;f.elements.type.value='';clearTimeout(mTimer);mTimer=setTimeout(findMonitoring,240)});
  f.elements.monitoring.addEventListener('focus',findMonitoring);
  f.elements.clientName.addEventListener('input',()=>{client=null;branchId='';f.elements.branchName.value='';clearTimeout(cTimer);cTimer=setTimeout(findClient,280)});
  f.elements.clientName.addEventListener('focus',()=>{if(f.elements.clientName.value) findClient()});
  f.elements.branchName.addEventListener('input',()=>{branchId='';branches()});f.elements.branchName.addEventListener('focus',branches);
  f.querySelector('#edit-add-branch').onclick=async()=>{if(!client?.id)return toast('Seleccione primero un cliente.',true);const name=f.elements.branchName.value.trim();if(!name)return toast('Escriba el nombre de la nueva sucursal.',true);try{const saved=await addBranch(client.id,name,state.user);client=saved;const item=saved.branches.find(x=>norm(x.name)===norm(name));branchId=item.id;f.elements.branchName.value=item.name;dropdown('branch').hidden=true;toast('Sucursal guardada en Firebase.')}catch(e){toast(e.message,true)}};
  async function loadResponsibles(){try{const names=await listRegistrationResponsibles();const current=f.elements.registeredBy.value||ot.registeredBy||'';f.elements.registeredBy.innerHTML='<option value="">Seleccione responsable</option>'+[...new Set([...names,...(current?[current]:[])])].map(n=>`<option value="${escape(n)}" ${n===current?'selected':''}>${escape(n)}</option>`).join('')}catch(e){f.querySelector('#edit-feedback').textContent='No se pudo consultar responsables: '+e.message}}
  f.querySelector('#edit-add-responsible').onclick=async()=>{const name=prompt('Nombre del nuevo responsable:');if(!name?.trim())return;try{const saved=await addRegistrationResponsible(name,state.user);await loadResponsibles();f.elements.registeredBy.value=saved;toast('Responsable agregado.')}catch(e){toast(e.message,true)}};
  await loadResponsibles();
  // Consultar cliente original solo cuando sea necesario para validar la sucursal existente.
  if(client.id){try{const rows=await searchClients(client.name,10);const found=rows.find(x=>x.id===client.id);if(found)client=found}catch{}}
  f.onsubmit=async e=>{e.preventDefault();const btn=f.querySelector('[type="submit"]'),feedback=f.querySelector('#edit-feedback');try{
   if(!monitoring||monitoring.series!==originalSeries||norm(monitoring.name)!==norm(f.elements.monitoring.value))throw Error('Seleccione un monitoreo del catálogo '+originalSeries+'.');
   if(!client?.id||norm(client.name)!==norm(f.elements.clientName.value))throw Error('Seleccione un cliente del catálogo.');
   if(!branchId||!(client.branches||[]).some(x=>x.id===branchId&&x.active!==false&&norm(x.name)===norm(f.elements.branchName.value)))throw Error('Seleccione una sucursal válida.');
   const patch={monitoring:monitoring.name,monitoringId:monitoring.id,type:monitoring.type,clientName:client.name,clientId:client.id,branchName:client.branches.find(x=>x.id===branchId).name,branchId,points:Number(f.elements.points.value),workDate:f.elements.workDate.value,registeredBy:f.elements.registeredBy.value,observations:f.elements.observations.value};
   const reason=prompt('Motivo de la edición controlada (10 a 500 caracteres):');if(reason===null)return;
   btn.disabled=true;feedback.textContent='Guardando cambios con auditoría…';
   await saveOTControlled(id,ot.version,patch,reason,state.user);close();toast('OT '+ot.code+' actualizada y auditada.');if(state.view==='ots')document.querySelector('#refresh')?.click();
  }catch(err){feedback.textContent=err.message;toast(err.message,true)}finally{btn.disabled=false}};
 }catch(err){close();toast('No se pudo abrir la OT: '+err.message,true)}
}
function businessDeadline(date,days){const d=new Date(date+'T12:00:00');if(Number.isNaN(d.getTime()))return '';let count=0;while(count<days){d.setDate(d.getDate()+1);if(d.getDay()!==0&&d.getDay()!==6)count++}return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
const localToday=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
function labDialog(title,description,batch=false){
 const host=$('#modal');if(!host)return null;
 host.innerHTML=`<div class="catalog-overlay" id="lab-overlay"><div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true" aria-label="${escape(title)}"><div class="catalog-heading"><div><h3>${escape(title)}</h3><p class="muted">${escape(description)}</p></div><button class="btn ghost" type="button" data-close>✕</button></div><form id="lab-form" class="form"><div class="ot-edit-grid"><label class="field">Fecha de recepción *<input name="receivedAt" type="date" required value="${localToday()}"></label><label class="field">Responsable de recepción *<select name="analyst" required><option value="JOSE VASQUEZ">JOSE VASQUEZ</option></select></label><label class="field">Tipo de servicio<select name="service" ${batch?'disabled':''}><option value="INTERNO">INTERNO</option>${batch?'':'<option value="SUBCONTRATADO">SUBCONTRATADO</option>'}</select></label><label class="field">Fecha posible de salida<input name="deadline" readonly aria-label="Fecha posible de salida"></label></div><p class="muted">Plazo: INTERNO 8 días laborables · SUBCONTRATADO 15 días laborables. Se excluyen sábados y domingos; no se descuentan feriados.</p><label class="field">Observaciones<textarea name="notes" maxlength="1000" rows="2" placeholder="Opcional"></textarea></label><div class="ot-actions"><button class="btn" type="submit">${batch?'Confirmar ingreso de todas':'Confirmar ingreso'}</button><button class="btn alt" type="button" data-close>Cancelar</button></div><p class="muted" id="lab-feedback" role="status"></p></form></div></div>`;
 const close=()=>host.innerHTML='';host.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);$('#lab-overlay').onclick=e=>{if(e.target.id==='lab-overlay')close()};
 const form=$('#lab-form');const refresh=()=>{form.elements.deadline.value=businessDeadline(form.elements.receivedAt.value,form.elements.service.value==='INTERNO'?8:15)};form.elements.receivedAt.onchange=refresh;form.elements.service.onchange=refresh;refresh();return {form,close};
}
async function laboratoryForm(id){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Su rol no permite recibir OT.',true);
 if(!navigator.onLine)return toast('Sin conexión: ingreso bloqueado.',true);
 try{const ot=await fetchOT(id);if(!ot||ot.status!=='EN_LABORATORIO'||!ot.workDate)throw Error('OT no disponible o sin fecha de inicio.');
 const dialog=labDialog('Ingreso individual · '+ot.code,ot.clientName+' · '+ot.branchName);if(!dialog)return;
 dialog.form.elements.receivedAt.min=ot.workDate;dialog.form.insertAdjacentHTML('afterbegin',`<p class="muted">Fecha mínima de recepción: <strong>${escape(ot.workDate)}</strong> (inicio del trabajo).</p>`);
 dialog.form.onsubmit=async e=>{e.preventDefault();const f=dialog.form,b=f.querySelector('[type=submit]');b.disabled=true;$('#lab-feedback').textContent='Confirmando con servidor…';try{await receiveLaboratory(id,ot.version,{analyst:f.elements.analyst.value,receivedAt:f.elements.receivedAt.value,service:f.elements.service.value,notes:f.elements.notes.value},state.user);emitEvent('RECEPTION',ot.code,id).catch(console.warn);dialog.close();state.selectedLabOTs.delete(id);await afterLaboratoryTransition([id]);toast('Ingreso confirmado. OT trasladada a Informes pendientes.')}catch(err){$('#lab-feedback').textContent=err.message;toast(err.message,true)}finally{b.disabled=false}};
 }catch(err){toast(err.message,true)}
}
async function laboratoryBatchForm(){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Sin permisos de recepción.',true);
 if(!navigator.onLine)return toast('Sin conexión.',true);
 const selected=[...state.selectedLabOTs.entries()];if(!selected.length)return toast('Seleccione al menos una OT.',true);if(selected.length>20)return toast('Máximo 20 OT por envío simultáneo.',true);
 const dialog=labDialog('Ingreso múltiple · '+selected.length+' OT','Servicio INTERNO para todas. Se validarán todas las OT antes de confirmar: '+selected.map(x=>x[1]).join(', '),true);if(!dialog)return;
 dialog.form.insertAdjacentHTML('afterbegin','<p class="muted">La recepción debe ser igual o posterior a la fecha de inicio de cada OT. El servidor validará todo el lote antes de guardar.</p>');
 dialog.form.onsubmit=async e=>{e.preventDefault();const f=dialog.form,b=f.querySelector('[type=submit]');b.disabled=true;$('#lab-feedback').textContent='Validando y confirmando simultáneamente…';try{await receiveLaboratoryBatch(selected.map(x=>x[0]),{analyst:f.elements.analyst.value,receivedAt:f.elements.receivedAt.value,notes:f.elements.notes.value},state.user);selected.forEach(([id,code])=>emitEvent('RECEPTION',code,id).catch(console.warn));state.selectedLabOTs.clear();dialog.close();await afterLaboratoryTransition(selected.map(x=>x[0]));toast('Ingreso simultáneo confirmado: '+selected.length+' OT trasladadas a Informes pendientes.')}catch(err){$('#lab-feedback').textContent=err.message;toast(err.message,true)}finally{b.disabled=false}};
}
function reportDeliveryDialog(title,description){
 const host=$('#modal');if(!host)return null;
 host.innerHTML=`<div class="catalog-overlay" id="report-overlay"><div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true"><div class="catalog-heading"><div><h3>${escape(title)}</h3><p class="muted">${escape(description)}</p></div><button class="btn ghost" data-close>✕ Cerrar</button></div><form id="report-delivery-form" class="form"><label class="field">Fecha real de entrega *<input name="deliveryRealAt" type="date" value="${localToday()}" required></label><p class="muted">La fecha es modificable. Al confirmar, las OT pasarán a Informes por autorizar y conservarán su historial.</p><div class="ot-actions"><button class="btn" type="submit">Confirmar entrega real</button><button class="btn alt" type="button" data-close>Cancelar</button></div><p id="report-feedback" class="muted" role="status"></p></form></div></div>`;
 const close=()=>host.innerHTML='';host.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);$('#report-overlay').onclick=e=>{if(e.target.id==='report-overlay')close()};return {form:$('#report-delivery-form'),close};
}
async function editPendingReception(id){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Sin permiso para rectificar la recepción.',true);
 try{
  const ot=await fetchOT(id);if(!ot||ot.status!=='EN_LABORATORIO')throw Error('Esta OT ya no está pendiente de ingreso.');
  const overlay=document.createElement('div');overlay.className='catalog-overlay ot-edit-overlay';
  overlay.innerHTML=`<div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true"><div class="catalog-heading"><h3>Fecha de recepción · ${escape(ot.code)}</h3><button class="btn ghost" type="button" data-close>✕</button></div><p class="muted">Inicio del trabajo: <b>${escape(ot.workDate||'Pendiente')}</b>. Solo se rectifica la recepción prevista; no se confirma el ingreso.</p><form class="form"><label class="field">Recepción prevista *<input type="date" name="date" required min="${escape(ot.workDate||'')}" value="${escape(ot.laboratory?.proposedReceivedAt||'')}"></label><label class="field">Motivo de rectificación *<textarea name="reason" minlength="10" maxlength="500" required></textarea></label><div class="ot-actions"><button class="btn" type="submit">Guardar fecha</button><button class="btn alt" type="button" data-close>Cancelar</button></div><p class="muted" id="reception-feedback"></p></form></div>`;
  document.body.append(overlay);const close=()=>overlay.remove();overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);overlay.onclick=e=>{if(e.target===overlay)close()};
  const form=overlay.querySelector('form');form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;try{await correctPendingReceptionDate(id,ot.version,form.elements.date.value,form.elements.reason.value,state.user);close();toast('Recepción prevista rectificada: '+ot.code);if(state.view==='laboratory')document.querySelector('#refresh')?.click()}catch(err){form.querySelector('#reception-feedback').textContent=err.message;toast(err.message,true)}finally{button.disabled=false}};
 }catch(err){toast(err.message,true)}
}
async function returnPortalAuthorization(id){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Solo Administración o Calidad puede rectificar autorizaciones.',true);
 try{
  const ot=await fetchOT(id);
  if(!ot||ot.status!=='AUTORIZADO'||!['1','4'].includes(String(ot.authorization?.state)))throw Error('La OT ya no está autorizada pendiente de portal. Actualice la página.');
  if(ot.portalPublishedAt||ot.portal?.publishedAt)throw Error('No se permite devolver un informe publicado.');
  const host=document.createElement('div');host.className='catalog-overlay ot-edit-overlay';
  host.innerHTML=`<div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true"><div class="catalog-heading"><div><h3>↩ Rectificar autorización · ${escape(ot.code)}</h3><p>${escape(ot.clientName||'')} · Estado anterior ${escape(ot.authorization.state)} · Fecha ${escape(ot.authorizationAt||'—')}</p></div><button class="btn ghost" type="button" data-close>✕</button></div><p>La OT regresará a <b>Informes por autorizar</b>. Se retirarán la decisión y la fecha de autorización vigentes; ambas quedarán registradas en auditoría. Se conservará la entrega real.</p><form class="form"><label class="field">Motivo obligatorio (10 a 500 caracteres)<textarea name="reason" minlength="10" maxlength="500" rows="3" required placeholder="Explique el error que requiere rectificación"></textarea></label><div class="ot-actions"><button class="btn" type="submit">Confirmar rectificación</button><button class="btn alt" type="button" data-close>Cancelar</button></div><p class="muted" data-feedback role="status"></p></form></div>`;
  document.body.append(host);const close=()=>host.remove();host.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);host.onclick=e=>{if(e.target===host)close()};
  const form=host.querySelector('form');form.onsubmit=async e=>{e.preventDefault();const reason=form.elements.reason.value.trim();if(reason.length<10||reason.length>500)return toast('Motivo entre 10 y 500 caracteres.',true);if(!confirm(`¿Devolver ${ot.code} a Informes por autorizar?\nSe anulará la autorización vigente, conservando su historial.`))return;const btn=form.querySelector('[type=submit]');btn.disabled=true;try{await returnAuthorizedToAuthorization(id,reason,state.user);state.selectedPortalOTs.delete(id);close();await afterLaboratoryTransition([id]);toast(ot.code+' regresó a Informes por autorizar. Autorización anterior auditada.')}catch(err){form.querySelector('[data-feedback]').textContent=err.message;toast(err.message,true)}finally{btn.disabled=false}};
 }catch(err){toast(err.message,true)}
}
async function returnAuthorizationToPending(id){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Solo Administración o Calidad puede rectificar la etapa.',true);
 try{
  const ot=await fetchOT(id);
  if(!ot||ot.status!=='POR_AUTORIZAR')throw Error('El informe cambió de etapa. Actualice la vista.');
  if(ot.authorization?.state)throw Error('El informe tiene una decisión de autorización y no puede devolverse mediante esta opción.');
  const reason=prompt(`RECTIFICACIÓN DE ETAPA · ${ot.code}\n\nRegresar de Informes por autorizar a Informes pendientes.\nSe conservará una auditoría con el motivo y la fecha de entrega anterior.\n\nIndique el motivo (10 a 500 caracteres):`);
  if(reason===null)return;
  if(reason.trim().length<10||reason.trim().length>500)throw Error('El motivo debe tener entre 10 y 500 caracteres.');
  if(!confirm(`¿Confirma regresar ${ot.code} a Informes pendientes?\n\nEsta operación queda registrada en auditoría.`))return;
  await returnReportToPending(id,reason,state.user);
  state.selectedAuthOTs.delete(id);
  await afterLaboratoryTransition([id]);
  toast(ot.code+' regresó a Informes pendientes con trazabilidad.');
 }catch(err){toast(err.message,true)}
}
async function reportDeliveryForm(id){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Sin permiso para registrar entregas.',true);
 try{const ot=await fetchOT(id);if(!ot||ot.status!=='INFORME_PENDIENTE')throw Error('Informe ya no disponible.');
 const dialog=reportDeliveryDialog('Entrega real · '+ot.code,ot.clientName+' · '+ot.branchName);if(!dialog)return;
 dialog.form.onsubmit=async e=>{e.preventDefault();const b=dialog.form.querySelector('[type=submit]');b.disabled=true;$('#report-feedback').textContent='Confirmando entrega…';try{await deliverReport(id,ot.version,dialog.form.elements.deliveryRealAt.value,state.user);state.selectedReportOTs.delete(id);dialog.close();await afterLaboratoryTransition([id]);toast('Informe '+ot.code+' enviado a Informes por autorizar.')}catch(err){$('#report-feedback').textContent=err.message;toast(err.message,true)}finally{b.disabled=false}};
 }catch(err){toast(err.message,true)}
}
async function reportDeliveryBatchForm(){
 if(!['ADMINISTRADOR','OPERACIONES'].includes(role()))return toast('Sin permiso para registrar entregas.',true);
 const selected=[...state.selectedReportOTs.entries()];if(!selected.length)return toast('Seleccione informes pendientes.',true);if(selected.length>20)return toast('Máximo 20 informes por confirmación.',true);
 const dialog=reportDeliveryDialog('Entrega múltiple · '+selected.length+' informes','Se verificará cada OT y se aplicará una única fecha a todas: '+selected.map(x=>x[1]).join(', '));if(!dialog)return;
 dialog.form.onsubmit=async e=>{e.preventDefault();const b=dialog.form.querySelector('[type=submit]');b.disabled=true;$('#report-feedback').textContent='Validando todas las OT…';try{await deliverReportsBatch(selected.map(x=>x[0]),dialog.form.elements.deliveryRealAt.value,state.user);state.selectedReportOTs.clear();dialog.close();await afterLaboratoryTransition(selected.map(x=>x[0]));toast(selected.length+' informes trasladados a Informes por autorizar.')}catch(err){$('#report-feedback').textContent=err.message;toast(err.message,true)}finally{b.disabled=false}};
}
const HISTORIC_CLIENTS_222=["1001TALLERES S.A.", "ACERIA XINLONG S.A.", "ACTIVIDADES DE PRONOSTICOS DEPORTIVOS JUEGOS ON LINE SPORTBET S.A.", "ADITEC ECUATORIANA CIA. LTDA.", "AGRICOMINSA AGRICOLA COMERCIAL INDUSTRIAL S.A.", "AGRIPAC S.A.", "AGRITOP S.A.", "AGUAS DE SAMBORONDON AMAGUA C.E.M.", "AIFA S.A.", "AJECUADOR S.A.", "ALFAFRESH S.A.", "ALIMENTOS EL SABOR ALIMENSABOR C. LTDA.", "ALMACENES DE PRATI S.A.", "ALVAREZ PENARRIETA CARMEN TERESA", "ARCHITEKTON S.A.", "AUTOSHARECORP S.A.", "AYLUARDO CEDEÑO GIOVANNI OLIVERIO", "BEBIDAS ARCACONTINENTAL ECUADOR ARCADOR C.L.", "BIMBO ECUADOR S.A.", "BIOSUPER S.A.S", "BORGAS S.A.", "BORSEA S.A.", "BRUMESA S.A.", "CABANI S.A.", "CALIZAS HUAYCO S.A.", "CAMARONERA LA COMARCA DCMC S.A", "CAMARONERA SAN JOSE CAMAJOSE S.A.", "CAMATAURA S.A.S.", "CARGILL AQUANUTRITION ECUADOR CIA.LTDA.", "CARGOPORT CÍA. LTDA.", "CEDRAX S.A.", "CHAMPION TECHNOLOGIES DEL ECUADOR CIA. LTDA.", "CHIVERIA S.A.", "CIMENTACIONES GENERALES Y OBRAS PORTUARIAS CIPORT S.A.", "CODANA S.A.", "COFIMAR S.A.", "COLGATE PALMOLIVE DEL ECUADOR S.A.I.C.", "COMERCIAL AGRO FARM CIA. LTDA.", "COMPAÑIA DE TRANSPORTE DE CARGA PESADA TRANSVICME S.A.", "COMPAÑIA GENERAL DE COMERCIO Y MANDATO S.A.", "COMPAÑÍA ANÓNIMA MORETRAN", "COMPAÑÍA AZUCARERA VALDEZ S.A.", "COMPUJASA S.A.", "CONSORCIO BALBANERA CUMANDA", "CONSORCIO PEP LA RIOJA", "CONSTRUCCIONES CIVILES Y METALICAS CONSTRUME S.A.", "CONSTRUCCIONES Y ARQUITECTURA RABE S.A.", "CONSTRUCTORA PROHORIZON S.A.", "CORPORACION AGRICOLA SAN JUAN C.A. CASJUCA", "CORPORACION FAVORITA C.A.", "CORPORACION SICORPMATTRESS S.A.", "CORPORACIÓN EL ROSADO S.A.", "CRISTAL DEL MAR S.A. CRISTALMAR", "DEPCONSA S.A.", "DISTRIBUIDORA CESAR BORJA DISTRIBORJA S.A.", "DISTRIBUIDORA Y COMERCIAL AUTOMOTRIZ S.A. DICOMTRIZ", "DROCARAS INDUSTRIA Y REPRESENTACIONES S.A.", "ECOELECTRIC S.A.", "ECUACOTTON S.A.", "ECUAMUNDOCORP S.A.", "EDIPLARQCOMPANY S.A.", "EMPACADORA GRUPO GRANMAR S.A. EMPAGRAN", "EMPREACUA S.A.", "EMPROMAR S.A.", "EQUIPOS Y TRANSPORTES S.A. EQUITRANSA", "ESTACION DE SERVICIO EL LAUREL S.A. ESDELAUREL", "ETIFLEX ETIQUETAS FLEXOGRAFICAS S.A.", "ETINAR S.A.", "EXPOPLAST S.A.", "EXPOSYNERGY S.A.S.", "FABRICA DE CONOS CAMPEON S.A.", "FADESA-MANTA S.A.", "FERTILIZANTES DEL PACIFICO FERPACIFIC S.A.", "FERTISA, FERTILIZANTES, TERMINALES I SERVICIOS S.A.", "FIBRAS NACIONALES FIBRANAC S.A", "FIDEICOMISO TITULARIZACIÓN OMNI HOSPITAL", "FILARET S.A.", "FILIBON S.A.", "FITO SANITARIO FITOSAN S.A.", "FORTIDEX S.A.", "FREIRE MONTJOY NILA GRACIA", "FRESKBANA S.A.", "FRITEGA S.A.", "FRUTERA DON MARCOS FRUDONMAR S.A.", "FRUTRADE S.A.S", "GAIBOR ARCOS GINGER ERCILIA", "GAVILANEZ YEPEZ GINA NARCISA", "GEOSUBTERRA MINERÍA RESPONSABLE S.A.S.", "GISIS S.A.", "GLOBALECUADOR CIA. LTDA.", "GRAFICAS IMPACTO GRAFIMPAC S.A.", "GRAFICAS JALON ENAJA S.A.", "GRUPOAQUA S.A.", "GRUVALCORP S.A.", "H.O.V. HOTELERA QUITO S.A.", "HAID (ECUADOR) FEED CIA. LTDA.", "HARAUTE S.A.", "HOTELES Y SERVICIOS ALMENDRAL S.A.", "IASA S.A.", "IDENOVA S.A.", "IMPORTADORA BOHORQUEZ C. LTDA.", "INDEUREC S.A.", "INDUAUTO S.A.", "INDUSTRIA CARTONERA ECUATORIANA S.A.", "INDUSTRIAL PESQUERA SANTA PRISCILA S.A.", "INDUSTRIAS DAJAHU S.A.S.", "INDUSTRIAS PLASTICAS JOSA CIA.LTDA.", "INDUSTRIAS REUNIDAS CIA. LTDA. INDUNIDAS LABORATORIOS INDUNIDAS", "INDUSTRIAS UNIDAS CIA LTDA.", "INDUSUR INDUSTRIAL DEL SUR S.A.", "INDUWAGEN S.A.", "INMOBILIARIA MOTKE S.A", "INTERCIA S.A.", "INVERYAN ECUADOR S.A.", "IPAC S.A.", "Industrias Alimenticias Ecuatorianas Inalecsa S.A.S.", "JESUS DEL GRAN PODER, J.D.G.P. S.A.", "JOKASA S.A.", "JORIGOM S.A.S.", "JUAN CARLOS ERAZO CASTRO", "KARTEXA S.A.", "KEMCEPSA S.A", "LABMAC S.A.", "LAMIFORMI C.LTDA", "LAMINADOS INDUSTRIAL LA CHILENITA LAMINCHILE S.A.", "LASERINK S.A.", "LIBRE", "LIRIS S.A.", "LOGISTICA BANANERA S.A LOGBAN", "LUBRICANTES INTERNACIONALES S.A. LUBRISA", "LUBRIVAL S.A.", "LUIS ENRIQUE COELLO ESPINOZA", "MACHALA YACHT CLUB", "MACIAS SOLA FRANKLIN JIOVANY", "MACTERRA S.A", "MAGNUM-ICC ECUADOR S.A.S.", "MARAMAR S.A.", "MARCO ANTONIO CASTILLO LEON S.A.S.", "MARES TROPICALES MARTROPIC S.A.", "METROCAR S.A.", "MEXICHEM ECUADOR S.A.", "MIA ECUADOR MIAECU S.A.S.", "MOLINOS CHAMPION MOCHASA S.A.S", "MOTOINDUSTRIA S.A.", "MOTORES Y TRACTORES MOTRAC S.A.", "MOTORGAS S.A.", "MULTIQUIP S.A", "MURZI TORRES SERVICIOS INDUSTRIALES ESH-EXPO S.A.", "NEGOCIOS INDUSTRIALES REAL N.I.R.S.A. S.A.", "NEW YORKER S.A.", "NILBRI S.A", "NIRSA S.A.", "NPD GLOBAL SUPPLIERS S.A.", "NUCOPSA S.A.", "ODISEABREWING S.A.", "OFFSET ABAD C.A", "PACIFICCAM S.A.", "PAN BAGUETTE S.A.", "PANAKRUZ S.A.", "PAPELESA C. LTDA.", "PICA PLASTICOS INDUSTRIALES C.A.", "PICO RAMIREZ CELINA ESTHER", "PIGALLE S.A.S.", "PINTURAS UNIDAS S.A.", "PLASCA S.A.", "PLAZA TIA UNO S.A. SOLIDASA", "POLIGRAFICA C.A.", "POLYLON S.A.", "PORCONECU PORCIONES CONTROLADAS ECUATORIANAS S.A.", "PROCESADORA DE PLASTICOS PROCEPLAS S.A.", "PROCESADORA POSORJA PROPOSORJA S.A.", "PRODUCTOS DE BALSA PRODUBAL S.A.", "PROMARISCO S.A.", "PROMO AIRESUR CENTER S.A.S.", "PROMOHARBOR S.A.S", "PROMORANCHO S.A.S.", "PROMOSUBA S.A.S.", "PROMOTORA BATAN ESTE PROBAESTE S.A.S.", "PRONAUPLIO S.A.", "PROYECTOS Y CONSTRUCCIONES-PROCON S.A.", "PSI Productos y Servicios Industriales C. Ltda.", "PUNTO VERDE S.A. PUNVERSA", "QUIMICAMP DEL ECUADOR S.A.", "RECICLAJES Y PROCESOS ECOLOGICOS S.A. RECOLOGICO", "REYBOSQUES C.L.", "REYLACTEOS C.L.", "ROMAN TOMALA ROMELL ENRIQUE", "SACOS DURAN REYSAC S.A.", "SAMIYAMEALS S.A.", "SAVERCORP S.A.", "SEMVRA-VECONSA S.A.", "SERDIDYV S.A. SERVICIOS DE DIALISIS, DISTRIBUCIÓN Y VENTA", "SERUVI S.A.", "SERVICIOS INTERNACIONALES TURISTICOS SITUR S.A.", "SIKA ECUATORIANA S.A.", "SOCIEDAD AGRÍCOLA E INDUSTRIAL SAN CARLOS S.A.", "SOCIEDAD DE ESTUDIANTES DE LA BIBLIA TESTIGOS DE JEHOVA", "SOCIEDAD NACIONAL DE GALAPAGOS C.A.", "SOFTYS ECUADOR S.A.", "SWISSGAS DEL ECUADOR S.A.S.", "SZK DEL ECUADOR S.A.", "TAB - KONTROLL S.A.", "TALUM S.A.", "TECNICENTROHUGO S.A.", "TECNOAMBIENTE, TECNOLOGIA AMBIENTAL S.A.", "TECNOFORMAS S.A.", "TECNOLOGIAYSERVICIOSTECSERV S.A.", "TECNOQUALITY S.A.", "TELCONET S.A.", "TERMOEK TERMOENCOGIBLES Y EMPAQUES S.A.", "THE TESALIA SPRINGS COMPANY S.A.", "TRADING COMPANY ROVEC S.A.", "TRANSPORTES RONALJAVHU S.A.", "TRAVERSO & PEREZ CONSTRUCCIONES", "TURISMO AMONRA S.A", "UNILEVER ANDINA ECUADOR S.A.", "UNIVERSAL SWEET INDUSTRIES S.A.", "VEPAGAS S.A.", "VERIS S.A.", "VOESTALPINE HIGH PERFORMANCE METALS DEL ECUADOR S.", "YAGLODVIAL S.A.", "YANQAY INGENIERA AMBIENTAL S.A.S"];
function clientsCatalogView(){
 stopWatch();
 hero('Clientes y sucursales','Depuración del catálogo central compartido con mediciones ambientales.');
 $('#content').insertAdjacentHTML('beforeend',`<div class="section-heading"><div><h2>Catálogo de clientes · Firebase</h2><p>Revise razones sociales y sucursales antes de importar el histórico. Edición con validación y trazabilidad.</p></div><button class="btn" id="clients-add">+ Nuevo cliente</button></div>
 <div class="panel"><div class="client-list-tools"><input id="clients-search" placeholder="Buscar cliente por nombre en todo Firebase…" aria-label="Buscar clientes"><select id="clients-status" aria-label="Filtrar estado"><option value="all">Todos los estados</option><option value="active">Activos</option><option value="inactive">Inactivos</option></select><select id="clients-size" aria-label="Registros por página"><option value="10">10 por página</option><option value="25">25 por página</option><option value="50">50 por página</option></select><button class="btn alt" id="clients-refresh">↻ Actualizar</button><button class="btn alt" id="clients-compare">⇄ Comparar con 222 y descargar CSV</button><button class="btn alt" id="branches-export">⇩ Exportar todas las sucursales CSV</button></div>
 <p class="muted" id="clients-info">Consultando catálogo…</p><div class="client-table-scroll"><table class="client-table"><thead><tr><th>RAZÓN SOCIAL</th><th>RUC</th><th>SUCURSALES</th><th>ESTADO DEL CLIENTE</th><th>ACCIÓN</th></tr></thead><tbody id="clients-body"></tbody></table></div><div class="catalog-footer"><button class="btn alt" id="clients-prev">← Anterior</button><span id="clients-page">Página 1</span><button class="btn alt" id="clients-next">Siguiente →</button></div><p class="muted client-hint">Orden alfabético por razón social. La búsqueda por inicio del nombre consulta Firebase, no solo la página visible. La comparación lee el catálogo por lotes únicamente al pulsar el botón.</p></div>`);
 const root=$('#content'),body=root.querySelector('#clients-body');let stack=[null],index=0,rows=[],cursor=null,more=false,token=0,searchTimer;
 const apply=()=>{const q=root.querySelector('#clients-search').value.trim().toLocaleLowerCase(),status=root.querySelector('#clients-status').value;
  const filtered=rows.filter(r=>(status==='all'||(status==='active'?r.active!==false:r.active===false))&&(!q||[r.name,r.taxId].some(x=>String(x||'').toLocaleLowerCase().includes(q))));
  body.innerHTML=filtered.map(r=>`<tr><td><strong>${escape(r.name||'Sin nombre')}</strong></td><td>${escape(r.taxId||'—')}</td><td><span class="client-branch-count">${(r.branches||[]).filter(x=>x.active!==false).length} activas / ${(r.branches||[]).length} total</span> <small>${escape((r.branches||[]).map(x=>x.name+(x.active===false?' (inactiva)':'')).join(' · ')||'Sin sucursales')}</small></td><td><span class="tag">${r.active===false?'INACTIVO':'ACTIVO'}</span></td><td><button class="btn alt client-edit" data-id="${escape(r.id)}">✏️ Editar</button> <button class="btn ghost client-toggle" data-toggle-id="${escape(r.id)}">${r.active===false?'↩ Reactivar':'🗑 Desactivar'}</button></td></tr>`).join('')||'<tr><td colspan="5" class="muted">Sin coincidencias en los resultados consultados.</td></tr>';
  body.querySelectorAll('[data-id]').forEach(btn=>btn.onclick=()=>editClientFromTable(rows.find(x=>x.id===btn.dataset.id)));
  body.querySelectorAll('[data-toggle-id]').forEach(btn=>btn.onclick=async()=>{const c=rows.find(x=>x.id===btn.dataset.toggleId);if(!c)return;const enable=c.active===false;const question=enable?`¿Reactivar el cliente «${c.name}»?`:`¿Desactivar el cliente «${c.name}»? Se conservarán sus sucursales y referencias históricas. No se eliminará de Firebase.`;if(!confirm(question))return;btn.disabled=true;try{await updateClient(c.id,{active:enable},state.user);toast(enable?'Cliente reactivado.':'Cliente desactivado sin borrar historial.');await load()}catch(e){toast(e.message,true);btn.disabled=false}});
  root.querySelector('#clients-info').textContent=`${filtered.length} visibles · ${rows.length} consultados en Firebase · página ${index+1}`;
 };
 async function load(){const t=++token;body.innerHTML='<tr><td colspan="5">Consultando Firebase…</td></tr>';try{const term=root.querySelector('#clients-search').value.trim();const result=await clientCatalogPage({cursor:stack[index],size:Number(root.querySelector('#clients-size').value),prefix:term});if(t!==token)return;rows=result.rows;cursor=result.cursor;more=result.more;apply();root.querySelector('#clients-prev').disabled=index===0;root.querySelector('#clients-next').disabled=!more;root.querySelector('#clients-page').textContent=`Página ${index+1}`;}catch(e){if(t===token){body.innerHTML=`<tr><td colspan="5">${escape(e.message)}</td></tr>`;root.querySelector('#clients-info').textContent='No se pudo consultar el catálogo.';}}}
 const reset=()=>{index=0;stack=[null];load()};
 root.querySelector('#branches-export').onclick=async()=>{
  const btn=root.querySelector('#branches-export');btn.disabled=true;btn.textContent='Consultando sucursales en Firebase…';
  try{
   const all=[];let after=null,morePages=true;
   while(morePages){const batch=await clientCatalogPage({cursor:after,size:50});all.push(...batch.rows);after=batch.cursor;morePages=batch.more;if(all.length>10000)throw new Error('Se superó el límite de seguridad de 10.000 clientes.');}
   const data=[['CLIENTE','RUC','ESTADO CLIENTE','SUCURSAL','ESTADO SUCURSAL','ID CLIENTE','ID SUCURSAL']];
   for(const c of all){if(!(c.branches||[]).length)data.push([c.name||'',c.taxId||'',c.active===false?'INACTIVO':'ACTIVO','','SIN SUCURSALES',c.id||'','']);
    else for(const b of c.branches)data.push([c.name||'',c.taxId||'',c.active===false?'INACTIVO':'ACTIVO',b.name||'',b.active===false?'INACTIVA':'ACTIVA',c.id||'',b.id||'']);}
   data.splice(1,data.length-1,...data.slice(1).sort((a,b)=>a[0].localeCompare(b[0],'es',{sensitivity:'base'})||a[3].localeCompare(b[3],'es',{sensitivity:'base'})));
   const csv='\uFEFF'+data.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
   const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='SUCURSALES_FIREBASE_ERP_GASES_2027.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
   const branches=all.reduce((n,c)=>n+(c.branches||[]).length,0);
   alert(`Exportación completa: ${all.length} clientes y ${branches} sucursales. Se incluyeron sucursales activas e inactivas y sus identificadores. No se modificó Firebase.`);
  }catch(e){toast('No se pudo exportar sucursales: '+e.message,true)}finally{btn.disabled=false;btn.textContent='⇩ Exportar todas las sucursales CSV'}
 };
 root.querySelector('#clients-compare').onclick=async()=>{const btn=root.querySelector('#clients-compare');btn.disabled=true;btn.textContent='Consultando catálogo por lotes…';try{
  const all=[];let after=null,morePages=true;while(morePages){const batch=await clientCatalogPage({cursor:after,size:50});all.push(...batch.rows);after=batch.cursor;morePages=batch.more;if(all.length>10000)throw new Error('Catálogo demasiado grande para comparación en navegador.');}
  const normalize=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase().replace(/\s+/g,' ');
  const actual=new Map();all.forEach(c=>{const k=normalize(c.name);if(!actual.has(k))actual.set(k,[]);actual.get(k).push(c)});
  const historic=new Map(HISTORIC_CLIENTS_222.map(c=>[normalize(c),c]));
  const data=[['ESTADO','RAZÓN SOCIAL HISTÓRICO','RAZÓN SOCIAL FIREBASE','RUC','ESTADO FIREBASE','SUCURSALES','ID FIREBASE']];
  for(const [key,name] of historic){const matches=actual.get(key)||[];if(!matches.length)data.push(['FALTA EN FIREBASE',name,'','','','','']);else matches.forEach(c=>data.push(['COINCIDE',name,c.name,c.taxId||'',c.active===false?'INACTIVO':'ACTIVO',(c.branches||[]).map(b=>b.name).join(' | '),c.id]));}
  for(const [key,items] of actual){if(!historic.has(key))items.forEach(c=>data.push(['SOLO EN FIREBASE','',c.name,c.taxId||'',c.active===false?'INACTIVO':'ACTIVO',(c.branches||[]).map(b=>b.name).join(' | '),c.id]));if(items.length>1)items.forEach(c=>data.push(['POSIBLE DUPLICADO FIREBASE','',c.name,c.taxId||'','','',c.id]));}
  const missing=data.filter(x=>x[0]==='FALTA EN FIREBASE').length;
  const csv='\uFEFF'+data.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='COMPARACION_222_CLIENTES_VS_FIREBASE.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
  alert(`Comparación terminada. Histórico: ${historic.size}. Firebase: ${all.length} documentos. Faltantes por nombre exacto normalizado: ${missing}. Se descargó el reporte CSV para abrir en Excel. Los nombres con variantes de escritura requieren revisión.`);
 }catch(e){toast('No se completó la comparación: '+e.message,true)}finally{btn.disabled=false;btn.textContent='⇄ Comparar con 222 y descargar CSV'}};

 async function editClientFromTable(client){if(!client)return;await openClientEditorDirect(client,load)}
 root.querySelector('#clients-add').onclick=()=>openClientEditorDirect(null,load);
 root.querySelector('#clients-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(reset,350)};root.querySelector('#clients-status').onchange=apply;
 root.querySelector('#clients-size').onchange=reset;
 root.querySelector('#clients-refresh').onclick=reset;root.querySelector('#clients-prev').onclick=()=>{if(index){index--;load()}};root.querySelector('#clients-next').onclick=()=>{if(more&&cursor){stack[index+1]=cursor;index++;load()}};
 load();
}
async function openClientEditorDirect(client,onSaved){
 const overlay=document.createElement('div');overlay.className='catalog-overlay';overlay.innerHTML=`<div class="catalog-dialog client-direct-dialog" role="dialog" aria-modal="true" aria-label="Editar cliente"><div class="catalog-heading"><div><h3>${client?'Editar cliente':'Nuevo cliente'}</h3><p class="muted">Los cambios se guardan en el catálogo compartido de Firebase.</p></div><button class="btn ghost" type="button" data-close>✕ Cerrar</button></div><form id="client-direct-form" class="client-editor"><div class="client-editor-grid"><label class="field">Razón social *<input name="name" required maxlength="160" value="${escape(client?.name||'')}"></label><label class="field">RUC (opcional)<input name="taxId" maxlength="20" value="${escape(client?.taxId||'')}"></label></div><label class="field" style="max-width:260px;margin-top:12px">Estado del cliente<select name="active"><option value="true" ${client?.active===false?'':'selected'}>Activo</option><option value="false" ${client?.active===false?'selected':''}>Inactivo</option></select></label><h4>Sucursales / lugares</h4><p class="muted">El estado de cada sucursal es independiente del estado del cliente. Las sucursales inactivas se conservan para trazabilidad.</p><div id="direct-branches"></div><button type="button" class="btn alt" id="direct-add-branch">+ Agregar sucursal</button><p class="muted" id="direct-feedback" role="status"></p><div class="ot-actions"><button type="button" class="btn ghost" data-close>Cancelar</button><button type="submit" class="btn">Guardar cambios</button></div></form></div>`;
 document.body.append(overlay);const close=()=>{overlay.remove();document.removeEventListener('keydown',esc)},esc=e=>{if(e.key==='Escape')close()};document.addEventListener('keydown',esc);overlay.querySelectorAll('[data-close]').forEach(b=>b.onclick=close);overlay.onclick=e=>{if(e.target===overlay)close()};
 const list=overlay.querySelector('#direct-branches');function row(b={}){const el=document.createElement('div');el.className='client-branch-row';el.dataset.id=b.id||'';el.innerHTML=`<label class="field">Sucursal / lugar<input class="branch-name" maxlength="160" required value="${escape(b.name||'')}"></label><label class="field">Estado<select class="branch-active"><option value="true" ${b.active!==false?'selected':''}>Activa</option><option value="false" ${b.active===false?'selected':''}>Inactiva</option></select></label><button type="button" class="btn ghost branch-remove">${b.id?'🗑 Desactivar':'✕ Quitar'}</button>`;el.querySelector('button').onclick=()=>{if(b.id){const active=el.querySelector('.branch-active');if(active.value==='true'){if(!confirm('¿Desactivar esta sucursal? Se conservará en Firebase para mantener referencias históricas.'))return;active.value='false';el.querySelector('button').textContent='↩ Reactivar'}else{active.value='true';el.querySelector('button').textContent='🗑 Desactivar'}}else if(list.children.length>1)el.remove();else overlay.querySelector('#direct-feedback').textContent='Debe conservar al menos una sucursal.'};list.append(el)}
 (client?.branches?.length?client.branches:[{name:'',active:true}]).forEach(row);overlay.querySelector('#direct-add-branch').onclick=()=>row();
 overlay.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target,btn=f.querySelector('[type=submit]');btn.disabled=true;const payload={name:f.elements.name.value,taxId:f.elements.taxId.value,active:f.elements.active.value==='true',branches:[...list.children].map(r=>({id:r.dataset.id||undefined,name:r.querySelector('.branch-name').value,active:r.querySelector('.branch-active').value==='true'}))};try{if(client)await updateClient(client.id,payload,state.user);else await addClient(payload.name,state.user,payload);close();toast('Cliente y sucursales actualizados en Firebase.');await onSaved()}catch(err){overlay.querySelector('#direct-feedback').textContent='No se guardó: '+err.message}finally{btn.disabled=false}};
}
function clientForm(){if(!isAdmin()&&!['OPERACIONES'].includes(role()))return toast('Sin permiso para registrar clientes',true);$('#modal').innerHTML=`<div class="panel" style="margin-top:18px"><h3>Nuevo cliente</h3><form id="new-client" class="form"><label class="field">Nombre o razón social<input name="name" required maxlength="160"></label><div><button class="btn">Guardar cliente</button></div></form></div>`;$('#new-client').onsubmit=async e=>{e.preventDefault();const f=e.target;try{if(!navigator.onLine)throw new Error('Sin conexión. No se registró el cliente.');await addClient(f.name.value,state.user);toast('Cliente registrado');$('#modal').innerHTML=''}catch(err){toast(err.message,true)}}}
async function users(){
 if(!isAdmin())return;
 hero('Usuarios y permisos','Administración de perfiles por UID de Firebase Authentication. Solo ADMINISTRADOR.');
 $('#content').insertAdjacentHTML('beforeend',`<div class="panel" style="padding:22px"><h2>Registrar perfil de usuario</h2><p class="muted">Primero cree la cuenta en Firebase Authentication. Después copie su UID y registre aquí el perfil. Esta pantalla no crea cuentas de Authentication.</p><form id="user-profile-form" class="form" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px"><label class="field">UID de Firebase<input name="uid" required minlength="20" maxlength="128" autocomplete="off" placeholder="UID de Authentication"></label><label class="field">Nombre completo<input name="name" required maxlength="120"></label><label class="field">Correo electrónico<input name="email" type="email" required maxlength="200"></label><label class="field">Rol<select name="role"><option value="OPERACIONES">OPERACIONES</option><option value="ADMINISTRADOR">ADMINISTRADOR</option></select></label><label class="field">Acceso confidencial a Facturación<select name="billingAccess"><option value="false">No autorizado</option><option value="true">Autorizado</option></select></label><label class="field">Estado<select name="active"><option value="true">ACTIVO</option><option value="false">INACTIVO</option></select></label><div style="align-self:end"><button class="btn" type="submit">Guardar perfil</button></div></form><p id="user-save-status" class="muted" role="status"></p><div class="notice">OPERACIONES: módulos operativos y catálogos. Facturación requiere autorización individual del administrador. ADMINISTRADOR: además usuarios, importación y diagnóstico. Los permisos se validan en Firestore.</div><h3>Perfiles registrados</h3><div id="user-profile-list" class="catalog-list">Consultando…</div></div>`);
 const form=$('#user-profile-form'),status=$('#user-save-status'),list=$('#user-profile-list');
 async function load(){try{const rows=await listUserProfiles();list.innerHTML=rows.map(x=>`<div class="catalog-row"><div><b>${escape(x.name||'Sin nombre')}</b><small>${escape(x.email||'')} · ${escape(x.uid)} · ${escape(x.role)} · ${x.active?'ACTIVO':'INACTIVO'} · Facturación: ${x.role==='ADMINISTRADOR'||x.permissions?.billingAccess===true?'AUTORIZADA':'RESTRINGIDA'}</small></div><div class="catalog-row-actions"><button class="btn alt" data-user-edit="${escape(x.uid)}">Editar</button></div></div>`).join('')||'<p class="muted">Sin perfiles.</p>';list.querySelectorAll('[data-user-edit]').forEach(b=>b.onclick=()=>{const row=rows.find(x=>x.uid===b.dataset.userEdit);if(!row)return;for(const key of ['uid','name','email','role'])form.elements[key].value=row[key]||'';form.elements.active.value=String(row.active===true);form.elements.billingAccess.value=String(row.permissions?.billingAccess===true||row.role==='ADMINISTRADOR');form.elements.uid.readOnly=true;status.textContent='Editando perfil existente: '+row.name;});}catch(e){list.textContent='Error al consultar perfiles: '+e.message}}
 form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('[type=submit]');b.disabled=true;status.textContent='Guardando…';try{const v=Object.fromEntries(new FormData(form));await saveUserProfile({uid:v.uid.trim(),name:v.name.trim(),email:v.email.trim(),role:v.role,active:v.active==='true',permissions:{billingAccess:v.role==='ADMINISTRADOR'||v.billingAccess==='true'}},state.user.uid);status.textContent='Perfil guardado correctamente.';form.reset();form.elements.uid.readOnly=false;await load()}catch(err){status.textContent='No se pudo guardar: '+err.message}finally{b.disabled=false}};
 await load();
}
function diagnostics(){
 hero('Diagnóstico de sincronización','Verificación puntual del servidor, sin sondeos permanentes ni descargas masivas.');
 $('#content').insertAdjacentHTML('beforeend',`<div class="panel"><h3>Conexión real con Firestore</h3><p class="muted">El navegador puede indicar conexión a internet aunque Firestore no responda. Esta prueba realiza una lectura directa del perfil en el servidor; consume lecturas.</p><p id="diag-status" class="notice">Sin verificar.</p><button id="diag-test" class="btn">Verificar conexión ahora</button><hr><h3>Seguridad multiusuario</h3><p class="muted">Las OT se protegen con versión transaccional y código único. Cada intento de registro tiene un identificador estable para recuperar el resultado después de un error de red. Las altas de OT y clientes actualizan el resumen dentro de la misma transacción. La inicialización requiere reglas V1.0.0.8 publicadas y la conciliación se ejecuta manualmente.</p><div class="notice warn">Antes de inicializar, publique las reglas firestore.rules de esta versión. La inicialización escribe un único resumen; no modifica OT ni clientes.</div><button id="init-counters" class="btn alt">Inicializar contadores (administrador)</button> <button id="check-counters" class="btn alt">Verificar consistencia</button><p id="counter-diagnostic" class="notice">Sin comprobar.</p></div>`);
 $('#init-counters').disabled=!isAdmin();
 $('#init-counters').onclick=async()=>{if(!isAdmin())return;if(!confirm('¿Confirma que publicó las reglas V1.0.0.8 y desea inicializar el resumen una sola vez?'))return;const b=$('#init-counters');b.disabled=true;try{const r=await initializeCounters();$('#counter-diagnostic').textContent=`Resumen inicializado: ${r.ots} OT y ${r.clients} clientes.`}catch(e){$('#counter-diagnostic').textContent='No inicializado: '+e.message}finally{b.disabled=false}};
 $('#check-counters').onclick=async()=>{const b=$('#check-counters');b.disabled=true;try{const r=await checkCounterConsistency();$('#counter-diagnostic').textContent=`Servidor: ${r.actual.ots} OT, ${r.actual.clients} clientes. Resumen: ${JSON.stringify(r.summary)}. ${r.consistent?'COINCIDEN':'DIFERENCIA DETECTADA: no corregir automáticamente.'}`}catch(e){$('#counter-diagnostic').textContent='Error: '+e.message}finally{b.disabled=false}};
 $('#diag-test').onclick=async()=>{const b=$('#diag-test');b.disabled=true;$('#diag-status').textContent='Consultando servidor…';try{const r=await verifyServer(state.user.uid);$('#diag-status').textContent=`Servidor confirmado · ${r.latencyMs} ms · ${new Date().toLocaleTimeString()}`;syncLabel('Servidor verificado')}catch(e){$('#diag-status').textContent=`No confirmado: ${e.code||e.message}`;syncLabel('Servidor no verificado')}finally{b.disabled=false}};
}
function parseCatalogCSV(text){
 text=String(text).replace(/^\uFEFF/,'');const result=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){row.push(cell);cell=''}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))result.push(row);row=[];cell=''}else cell+=c}
 if(quoted)throw new Error('CSV con comillas sin cerrar');if(cell||row.length){row.push(cell);result.push(row)}return result;
}
function normalizeImportName(v){return String(v||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ')}
function prepareCatalogCSV(text){
 const matrix=parseCatalogCSV(text);const expected=['ID CLIENTE','RAZÓN SOCIAL','RUC','SUCURSAL','ESTADO'];
 if(matrix.length<2||expected.some((x,i)=>normalizeImportName(matrix[0][i])!==normalizeImportName(x)))throw new Error('Encabezados incorrectos. Se requieren ID CLIENTE, RAZÓN SOCIAL, RUC, SUCURSAL, ESTADO. Exporte la hoja como CSV UTF-8.');
 const groups=new Map(),issues=[];let sourceRows=0;
 for(let i=1;i<matrix.length;i++){
  const r=matrix[i];if(!r.some(x=>String(x||'').trim()))continue;sourceRows++;
  const [id,name,ruc,branch,status]=Array.from({length:5},(_,j)=>String(r[j]||'').trim());
  if(!id||!name){issues.push(`Fila ${i+1}: falta ID o razón social`);continue}
  if(name.length>160){issues.push(`Fila ${i+1}: razón social excede 160 caracteres`);continue}
  if(ruc&& !/^\d{13}$/.test(ruc)){issues.push(`Fila ${i+1}: RUC debe tener 13 dígitos`)}
  if(!['ACTIVO','INACTIVO'].includes(status.toUpperCase()))issues.push(`Fila ${i+1}: estado inválido`);
  if(branch.length>160)issues.push(`Fila ${i+1}: sucursal excede 160 caracteres`);
  let group=groups.get(id);
  if(!group){group={id,name,taxId:ruc,active:status.toUpperCase()==='ACTIVO',branches:[],branchKeys:new Set(),sourceRows:[]};groups.set(id,group)}
  if(normalizeImportName(group.name)!==normalizeImportName(name))issues.push(`Fila ${i+1}: ID ${id} tiene distintas razones sociales`);
  if(group.taxId&&ruc&&group.taxId!==ruc)issues.push(`Fila ${i+1}: RUC contradictorio en ${id}`);
  if(!group.taxId&&ruc)group.taxId=ruc;
  if(group.active!==(status.toUpperCase()==='ACTIVO'))issues.push(`Fila ${i+1}: estados contradictorios en ${id}`);
  if(branch){const key=normalizeImportName(branch);if(group.branchKeys.has(key))issues.push(`Fila ${i+1}: sucursal duplicada en ${id}: ${branch}`);else{group.branchKeys.add(key);group.branches.push({name:branch,active:true})}}
  group.sourceRows.push(i+1);
 }
 const items=[...groups.values()];for(const x of items)if(!x.branches.length)issues.push(`${x.id}: no tiene sucursal (complete el Excel antes de importar)`);
 const names=new Map(),rucs=new Map();for(const x of items){const n=normalizeImportName(x.name);if(names.has(n))issues.push(`Razón social duplicada entre ${names.get(n)} y ${x.id}`);else names.set(n,x.id);if(x.taxId){if(rucs.has(x.taxId))issues.push(`RUC repetido entre ${rucs.get(x.taxId)} y ${x.id}`);else rucs.set(x.taxId,x.id)}}
 return {items,issues,sourceRows,branches:items.reduce((a,x)=>a+x.branches.length,0)};
}
function migration(){
 hero('Importación histórica','Importe clientes y sucursales del catálogo anterior con revisión previa, sin modificar las OT.');
 $('#content').insertAdjacentHTML('beforeend',`<div class="panel"><h3>Importador seguro de clientes y sucursales · CSV UTF-8</h3><p class="muted">Abra CLIENTE GASES.xlsx en Excel y seleccione Archivo → Guardar como → CSV UTF-8 (delimitado por comas). También puede usar el CSV incluido en este paquete. La importación requiere contadores inicializados y permisos de edición.</p><label class="field">Archivo CSV (5 columnas)<input id="catalog-file" type="file" accept=".csv,text/csv"></label><div id="catalog-preview" class="notice">Seleccione un archivo. No se escribirá nada hasta que confirme.</div><div id="catalog-actions" style="display:none"><label style="display:flex;gap:9px;align-items:center;margin:12px 0"><input id="catalog-confirm" type="checkbox" style="width:auto"> Confirmo que revisé la vista previa y autorizo crear solo los clientes que no existan.</label><button class="btn" id="catalog-run" disabled>Importar clientes nuevos</button><button class="btn alt" id="catalog-download-log" disabled>Descargar reporte CSV</button><p id="catalog-progress" class="muted" role="status"></p></div></div><div class="panel"><h3>Protecciones</h3><p class="muted">Verifica cada nombre contra Firestore antes de crear. Si ya existe, lo omite sin reemplazar ni modificar sus sucursales. Cada alta usa transacción y actualiza el contador central. Si encuentra errores en el CSV, bloquea la importación. Un fallo de red detiene el proceso y permite repetirlo sin duplicar los clientes creados.</p></div>`);
 let prepared=null,report=[];
 const logButton=$('#catalog-download-log');
 logButton.onclick=()=>{const data=[['ID CLIENTE','RAZÓN SOCIAL','RESULTADO','DETALLE'],...report].map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');const blob=new Blob(['\uFEFF'+data],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='REPORTE_IMPORTACION_CLIENTES_GASES.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
 $('#catalog-file').onchange=async e=>{prepared=null;report=[];$('#catalog-actions').style.display='none';const file=e.target.files[0];if(!file)return;try{if(file.size>5*1024*1024)throw new Error('CSV demasiado grande (máximo 5 MB).');prepared=prepareCatalogCSV(await file.text());const p=prepared;$('#catalog-preview').innerHTML=`<b>Vista previa (sin escrituras):</b> ${p.sourceRows} filas, ${p.items.length} clientes, ${p.branches} sucursales.<br>RUC completos: ${p.items.filter(x=>x.taxId).length}.<br><b>Observaciones: ${p.issues.length}</b><div style="max-height:190px;overflow:auto;margin-top:8px">${p.issues.slice(0,100).map(x=>'<div>• '+escape(x)+'</div>').join('')||'Sin errores estructurales.'}</div><p class="muted">Primeros clientes: ${escape(p.items.slice(0,5).map(x=>x.name).join(' · '))}</p>`;$('#catalog-actions').style.display='block';$('#catalog-confirm').checked=false;$('#catalog-run').disabled=true;if(p.issues.length)$('#catalog-preview').insertAdjacentHTML('beforeend','<p><b>Importación bloqueada:</b> corrija las observaciones y vuelva a seleccionar el CSV.</p>')}catch(err){$('#catalog-preview').textContent='Error de archivo: '+err.message}};
 $('#catalog-confirm').onchange=e=>$('#catalog-run').disabled=!e.target.checked||!prepared||!!prepared.issues.length||!isAdmin();
 $('#catalog-run').onclick=async()=>{if(!isAdmin()||!prepared||prepared.issues.length||!$('#catalog-confirm').checked)return;if(!confirm(`¿Crear hasta ${prepared.items.length} clientes nuevos en Firebase? Los existentes se omitirán sin cambios.`))return;const btn=$('#catalog-run');btn.disabled=true;$('#catalog-file').disabled=true;logButton.disabled=true;report=[];let created=0,skipped=0,failed=0;
  for(const [i,item] of prepared.items.entries()){
   $('#catalog-progress').textContent=`Procesando ${i+1}/${prepared.items.length} · creados ${created}, existentes ${skipped}, errores ${failed}`;
   try{const found=await lookupCatalogName(item.name);if(found.exists){skipped++;report.push([item.id,item.name,'EXISTENTE','No modificado'])}else{await importCatalogClient(item,state.user);created++;report.push([item.id,item.name,'CREADO',`${item.branches.length} sucursales`])}}
   catch(err){failed++;report.push([item.id,item.name,'ERROR',err.message]);if(!navigator.onLine||['permission-denied','unavailable'].includes(err.code)){report.push(['','', 'DETENIDO','Revise conexión/permisos; vuelva a importar, los creados se omitirán']);break}}
  }
  $('#catalog-progress').textContent=`Finalizado: ${created} creados, ${skipped} existentes, ${failed} errores. Descargue el reporte.`;logButton.disabled=false;$('#catalog-file').disabled=false;$('#catalog-confirm').checked=false;toast(`Importación: ${created} creados, ${skipped} omitidos, ${failed} errores.`,failed>0);
 };
}

let authCheckSequence=0;let accessProfileStop=null;
function stopAccessProfile(){if(accessProfileStop){accessProfileStop();accessProfileStop=null}}
function watchAccessProfile(uid){stopAccessProfile();accessProfileStop=onSnapshot(doc(db,'users',uid),{includeMetadataChanges:true},snap=>{if(!snap.exists()||snap.data().active!==true){stopWatch();stopCounters();stopMenuCounts();state.profile=null;stopAccessProfile();clearExportCache().finally(()=>signOut(auth));return}if(snap.metadata.fromCache)return;const oldBilling=canBilling();state.profile=snap.data();if(oldBilling!==canBilling()){state.billingDrafts.clear();state.selectedBillingOTs.clear();clearExportCache();if(state.view==='billing'&&!canBilling())state.view='dashboard';shell()}},err=>console.warn('No se pudo escuchar cambio de permisos',err.code||err.message))}

async function verifySession(user){stopAccessProfile();stopWatch();stopCounters();stopMenuCounts();
 const check=++authCheckSequence;
 state.user=user;
 if(!user){stopNotifications();state.profile=null;login();return}
 $('#app').innerHTML='<div class="login-card" style="min-height:100vh"><div class="login-box"><h2>Verificando acceso…</h2><p style="color:#087f5b;font-weight:bold">${APP_VERSION}</p><p class="muted">Consultando el perfil autorizado en Firebase.</p></div></div>';
 try{
  // El perfil de acceso se valida contra el servidor; no conceder acceso desde caché obsoleta.
  const p=await profile(user.uid);
  console.info('[ERP GASES V1.0.0.2] Perfil consultado en servidor', {project:'nuevo-erp-gases',uid:user.uid,exists:!!p,active:p?.active,role:p?.role});
  if(check!==authCheckSequence)return;
  if(!p||p.active!==true){
   const reason=!p?'No existe el documento de perfil para este UID.':'El perfil existe, pero active no es true (booleano).';
   $('#app').innerHTML=`<div class="login-card" style="min-height:100vh"><div class="login-box"><h2>Acceso pendiente</h2><p style="color:#087f5b;font-weight:bold">${APP_VERSION}</p><p class="muted">${escape(reason)}</p><p class="muted">Correo: ${escape(user.email)}<br>UID: <b style="word-break:break-all">${escape(user.uid)}</b><br>Proyecto: nuevo-erp-gases<br>Ruta: users/${escape(user.uid)}</p><div class="notice warn">Verifique que el documento esté en este proyecto y tenga active=true de tipo boolean.</div><button id="retry-profile" class="btn">Volver a verificar</button> <button id="exit" class="btn alt">Cerrar sesión</button></div></div>`;
   $('#retry-profile').onclick=()=>verifySession(auth.currentUser);
   $('#exit').onclick=()=>clearExportCache().finally(()=>signOut(auth));return;
  }
  state.profile=p;shell();startNotifications();watchAccessProfile(user.uid);queueMicrotask(()=>retryPendingOTIndexes().catch(console.warn));if(p.role==='ADMINISTRADOR')installIndexButton();
 }catch(e){
  if(check!==authCheckSequence)return;
  console.error('[ERP GASES V1.0.0.2] Error verificando perfil',e);
  $('#app').innerHTML=`<div class="login-card" style="min-height:100vh"><div class="login-box"><h2>No se pudo verificar su perfil</h2><p style="color:#087f5b;font-weight:bold">${APP_VERSION}</p><p>${escape(e.code||'Error')}: ${escape(e.message)}</p><p class="muted">Proyecto: nuevo-erp-gases · Ruta: users/${escape(user.uid)}</p><div class="notice warn">Compruebe conexión, reglas publicadas y proyecto. No se habilita acceso sin validación.</div><button id="retry-profile" class="btn">Reintentar verificación</button> <button id="exit" class="btn alt">Cerrar sesión</button></div></div>`;
  $('#retry-profile').onclick=()=>verifySession(auth.currentUser);
  $('#exit').onclick=()=>clearExportCache().finally(()=>signOut(auth));
 }
}
// Aviso de actualización: consulta un archivo estático, sin lecturas ni escrituras de Firestore.
// La versión del servidor se publica junto con cada despliegue de GitHub/Netlify.
let latestAvailableVersion=null;
function versionParts(v){return String(v||'').replace(/^v/i,'').split('.').map(n=>Number(n)||0)}
function newerVersion(remote,local){const a=versionParts(remote),b=versionParts(local);for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)!==(b[i]||0))return(a[i]||0)>(b[i]||0)}return false}
async function checkForUpdates(){
 if(!navigator.onLine)return;
 try{
  const res=await fetch('/version.json?ts='+Date.now(),{cache:'no-store'});
  if(!res.ok)return;
  const remote=await res.json();
  latestAvailableVersion=newerVersion(remote.version,APP_VERSION)?remote.version:null;
  const button=document.getElementById('update-alert');
  if(button){button.classList.toggle('hide',!latestAvailableVersion);if(latestAvailableVersion)button.textContent='⬆ Nueva versión '+latestAvailableVersion+' · Actualizar'}
 }catch(e){console.debug('Actualización no disponible',e)}
}
window.addEventListener('focus',checkForUpdates);
window.addEventListener('online',checkForUpdates);
setInterval(()=>{if(!document.hidden)checkForUpdates()},10*60*1000);
onAuthStateChanged(auth,verifySession);
if('serviceWorker'in navigator&&import.meta.env.PROD)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));

const authorizationOptions=`<option value="">Seleccione 1, 2, 3 o 4</option><option value="1">1 · INFORMES LISTOS</option><option value="2">2 · INFORMES RETENIDOS</option><option value="3">3 · TRABAJO SIN OC / FACTURACIÓN Y COMERCIAL EN SEGUIMIENTO</option><option value="4">4 · PROYECTO FT</option>`;
function authorizationForm(id){
 const ot=(state.rows.laboratory||[]).find(x=>x.id===id);if(!ot)return toast('Actualice la vista para abrir la OT.',true);
 const host=document.createElement('div');host.className='catalog-overlay ot-edit-overlay';host.innerHTML=`<div class="catalog-dialog ot-edit-dialog" role="dialog" aria-modal="true"><div class="catalog-heading"><div><h3>Autorización · ${escape(ot.code)}</h3><p>${escape(ot.clientName)} · Entrega real ${escape(ot.deliveryRealAt||'—')}</p></div><button class="btn ghost" data-close>✕</button></div><form class="form" id="auth-form"><label class="field">Estado del informe *<select name="state" required>${authorizationOptions}</select></label><label class="field">Fecha de autorización <input name="date" type="date" value="${localToday()}"></label><p class="muted">1 y 4 autorizan y trasladan a Portal. 2 y 3 retienen el informe en esta bandeja, sin fecha de autorización.</p><div class="ot-actions"><button class="btn" type="submit">Guardar estado</button><button class="btn alt" type="button" data-close>Cancelar</button></div><p id="auth-feedback" role="status"></p></form></div>`;
 const close=()=>host.remove();host.onclick=e=>{if(e.target===host||e.target.closest('[data-close]'))close()};document.body.append(host);const form=host.querySelector('form');form.elements.state.value=String(ot.authorization?.state||'');const toggle=()=>{const retained=['2','3'].includes(form.elements.state.value);form.elements.date.disabled=retained;form.elements.date.required=!retained};form.elements.state.onchange=toggle;toggle();
 form.onsubmit=async e=>{e.preventDefault();const btn=form.querySelector('[type=submit]');btn.disabled=true;try{await authorizeReport(id,ot.version,form.elements.state.value,form.elements.date.value,state.user);if(['1','4'].includes(form.elements.state.value))emitEvent('AUTHORIZATION',ot.code,id).catch(console.warn);state.selectedAuthOTs.delete(id);close();await afterLaboratoryTransition([id]);toast('Estado de '+ot.code+' guardado correctamente.')}catch(err){host.querySelector('#auth-feedback').textContent=err.message;toast(err.message,true)}finally{btn.disabled=false}};
}
async function authorizationBatchSave(){const ids=[...state.selectedAuthOTs.keys()],status=$('#auth-batch-state').value,date=$('#auth-batch-date').value;if(!ids.length)return toast('Seleccione al menos una OT.',true);if(ids.length>20)return toast('Máximo 20 OT por operación.',true);if(!status)return toast('Seleccione el estado 1, 2, 3 o 4.',true);const btn=$('#auth-batch-save');btn.disabled=true;try{await authorizeReportsBatch(ids,status,date,state.user);if(['1','4'].includes(status))for(const [id,code] of state.selectedAuthOTs)emitEvent('AUTHORIZATION',code,id).catch(console.warn);state.selectedAuthOTs.clear();await afterLaboratoryTransition(ids);toast(ids.length+' OT actualizadas correctamente.')}catch(err){toast(err.message,true)}finally{btn.disabled=false}}

// V1.0.0.94 diagnostic: run in browser DevTools after signing in.
window.probarIndiceOT = async (texto, opciones={}) => {
 const result=await testOTSearchIndex(texto,opciones);
 console.table(result.rows.map(r=>({codigo:r.code,cliente:r.clientName,sucursal:r.branchName,monitoreo:r.monitoring,estado:r.status})));
 console.info('Índice experimental:',{coincidencias:result.rows.length,lecturasAproximadas:result.reads,tiempoMs:result.elapsedMs,limitado:result.limited,unsupported:result.unsupported});
 return result;
};

function installIndexButton(){
 if(document.getElementById('index-migration-launcher'))return;
 const button=document.createElement('button');button.id='index-migration-launcher';button.className='btn';
 button.textContent='⚡ Generar índice de búsqueda';
 button.style.cssText='position:fixed;bottom:22px;right:22px;z-index:9998;box-shadow:0 4px 15px #0004';
 document.body.append(button);
 button.onclick=()=>{
  if(document.getElementById('index-migration-panel'))return;
  const overlay=document.createElement('div');overlay.id='index-migration-panel';overlay.className='catalog-overlay';
  overlay.innerHTML=`<div class="catalog-dialog" role="dialog" aria-modal="true" style="max-width:620px"><h3>Generar índice de búsqueda de OT</h3><p>Procesa las OT históricas en lotes de 10 y escribe únicamente en <code>otSearchIndex</code>. No modifica <code>ots</code> ni contadores.</p><p class="notice warn">Requiere haber publicado las reglas administrativas de V1.0.0.95. Haga respaldo antes de ejecutar. Durante la carga evite editar OT. La búsqueda operativa sigue usando el método anterior.</p><label style="display:flex;gap:8px;align-items:center"><input id="idx-consent" type="checkbox" style="width:auto"> Confirmo el respaldo y autorizo la creación de índices auxiliares.</label><div style="display:flex;gap:10px;margin-top:16px"><button class="btn" id="idx-start" disabled>Iniciar carga</button><button class="btn alt" id="idx-close">Cerrar</button></div><p id="idx-progress" role="status">Pendiente</p></div>`;
  document.body.append(overlay);
  const start=overlay.querySelector('#idx-start'),close=overlay.querySelector('#idx-close'),consent=overlay.querySelector('#idx-consent'),progress=overlay.querySelector('#idx-progress');
  consent.onchange=()=>start.disabled=!consent.checked;
  close.onclick=()=>overlay.remove();
  start.onclick=async()=>{
   if(!consent.checked||!confirm('¿Iniciar la creación de índices auxiliares para las OT históricas?'))return;
   start.disabled=true;close.disabled=true;
   try{
    const result=await buildSearchIndex({onProgress:({scanned,written})=>progress.textContent=`Procesadas ${scanned} OT · índices escritos ${written}`});
    progress.textContent=`Carga terminada: ${result.written} índices creados/actualizados. Pruebe en consola: await probarIndiceOT('LAB')`;
   }catch(err){progress.textContent='Error: '+err.message;console.error(err)}
   finally{close.disabled=false;}
  };
 };
}
