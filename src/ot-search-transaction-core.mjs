/** Experimental atomic OT/index mirror. Disabled in production by feature flag.
 * Firestore transactions require ALL reads before the first write.
 * A new OT can be set without a prior read; updates require a prior read.
 */
export function createOTMirror(transaction, makeIndexRef, makePayload) {
 const reads = new Map();
 const written = new Set();
 const isOT = ref => ref?.parent?.id === 'ots';
 return new Proxy(transaction, {get(target, property) {
  if (property === 'get') return async ref => {
   const snap = await target.get(ref);
   if (isOT(ref)) reads.set(ref.path, snap.exists() ? snap.data() : null);
   return snap;
  };
  if (property === 'delete') return ref => {
   if (isOT(ref)) throw Error('Eliminación OT no soportada por espejo; operación bloqueada.');
   return target.delete(ref);
  };
  if (property === 'set' || property === 'update') return (ref, payload, options) => {
   if (!isOT(ref)) return target[property](ref, payload, options);
   if (written.has(ref.path)) throw Error('Espejo OT: múltiples escrituras a la misma OT en una transacción no soportadas.');
   if (property === 'set' && options?.merge) throw Error('Espejo OT: set merge no compatible.');
   const hasRead = reads.has(ref.path);
   const previous = reads.get(ref.path);
   if (property === 'update' && (!hasRead || previous === null)) throw Error('Espejo OT: actualización requiere lectura previa de OT existente.');
   // Full set is supported without reading: used by createOT with a new auto-ID.
   const next = property === 'update' ? applyPatch(previous, payload) : payload;
   const index = makePayload(ref.id, next);
   // Build payload before either write to avoid partial staged mutations on errors.
   const indexRef = makeIndexRef(ref.id);
   target[property](ref, payload, options);
   target.set(indexRef, index);
   written.add(ref.path);
   return transaction;
  };
  const value = Reflect.get(target, property, target);
  return typeof value === 'function' ? value.bind(target) : value;
 }});
}
function applyPatch(previous, patch) {
 const result = {...previous};
 for (const [key, value] of Object.entries(patch)) {
  if (!key.includes('.')) {result[key] = value; continue;}
  const segments = key.split('.'); let cursor = result;
  for (const segment of segments.slice(0,-1)) cursor = cursor[segment] = {...(cursor[segment] || {})};
  cursor[segments.at(-1)] = value;
 }
 return result;
}
