/** Static inventory of OT writes. Advisory only; not a proof of complete coverage. */
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(resolve(root,'src/data.js'),'utf8');
const lines=source.split('\n');
const operations=[];
for(let i=0;i<lines.length;i++){
 const line=lines[i];
 const matches=[...line.matchAll(/\b(?:t|transaction)\.(set|update|delete)\s*\(/g)];
 for(const match of matches){
  const before=lines.slice(Math.max(0,i-9),i+1).join(' ');
  const context=lines.slice(Math.max(0,i-2),Math.min(lines.length,i+3)).join(' ');
  operations.push({line:i+1,method:match[1],context:context.slice(0,420),likelyOT:/\b(?:otRef|refs\[i\]|ref|doc\(db,\s*['"]ots['"])/.test(context),inTransaction:/runTransaction\s*\(/.test(before)});
 }
}
const output={version:'1.0.0.91',generatedAt:new Date().toISOString(),warning:'Heuristic source inventory only. Manual review required for each write and any other modules.',total:operations.length,likelyOT:operations.filter(x=>x.likelyOT).length,operations};
writeFileSync(resolve(root,'AUDITORIA_ESCRITURAS_V1.0.0.91.json'),JSON.stringify(output,null,2)+'\n');
console.log(`Auditoría: ${output.total} escrituras candidatas, ${output.likelyOT} con referencias potenciales a OT.`);
