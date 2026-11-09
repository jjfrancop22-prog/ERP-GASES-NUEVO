import fs from 'node:fs';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../src/data.js',import.meta.url),'utf8');
const adapter=fs.readFileSync(new URL('../src/ot-search-transaction-core.mjs',import.meta.url),'utf8');
const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
const flag=fs.readFileSync(new URL('../src/ot-search-transaction.js',import.meta.url),'utf8');
assert.match(flag,/VITE_OT_SEARCH_MIRROR\s*===\s*'true'/);
assert.match(rules,/match \/otSearchIndex\/\{id\}/);
assert.match(rules,/allow create, update, delete: if false/);
assert.match(adapter,/lectura previa obligatoria/);
const create=source.match(/export async function createOT\([\s\S]*?(?=\/\/ Vista previa)/)?.[0];
assert.ok(create,'No se encontró createOT');
assert.match(create,/t\.set\(otRef,/);
assert.doesNotMatch(create,/t\.get\(otRef\)/);
const writeMatches=[...source.matchAll(/\bt\.(set|update|delete)\(\s*(otRef|refs\[i\]|ref|r)\s*,/g)];
const report={version:'1.0.0.89',mode:'static-audit',flagDefault:'off',rulesIndexWrites:'denied',otWriteCandidates:writeMatches.length,blockers:[
 'createOT usa t.set(otRef) sin lectura previa: el adaptador experimental rechazaría el alta si se habilita.',
 'Las reglas actuales bloquean escrituras a otSearchIndex: activar el espejo causaría permission-denied.',
 'El espejo exige revisión de todos los flujos y de la correspondencia de datos antes de activarse.'
],recommendation:'NO activar VITE_OT_SEARCH_MIRROR ni desplegar cambios de reglas en producción.'};
fs.writeFileSync(new URL('../AUDITORIA_INTEGRACION_V1.0.0.89.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
