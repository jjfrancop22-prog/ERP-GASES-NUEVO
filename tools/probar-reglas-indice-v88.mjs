import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
const m=rules.match(/match \/otSearchIndex\/\{id\} \{([\s\S]*?)\n  \}/);
assert.ok(m,'Falta bloque otSearchIndex');
assert.match(m[1],/allow get, list: if active\(\);/);
assert.match(m[1],/allow create, update, delete: if false;/);
assert.ok(rules.includes('match /ots/{id}'));
console.log('OK: reglas del índice presentes (verificación estática, NO emulador).');
