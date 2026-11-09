/** Audita sin escribir: todos los puntos de mutación OT deben ser integrados antes de activar búsqueda. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const src=readFileSync(resolve(root,'src/data.js'),'utf8');
const lines=src.split('\n');
const mutations=[];
let fn='(sin función)';
for(let i=0;i<lines.length;i++){
 const declaration=lines[i].match(/^export (?:async )?function\s+(\w+)/);
 if(declaration)fn=declaration[1];
 if(/\bt\.(?:set|update|delete)\(/.test(lines[i]) && /\b(?:otRef|refs\[i\]|ref|r)\b/.test(lines[i]))mutations.push({line:i+1,function:fn,excerpt:lines[i].trim().slice(0,180)});
}
console.log(JSON.stringify({status:'PREINTEGRACION',writesDetected:mutations.length,mutations,warning:'El índice auxiliar NO está integrado a todas las escrituras. No activar búsquedas indexadas exclusivas ni ejecutar migración productiva.'},null,2));
