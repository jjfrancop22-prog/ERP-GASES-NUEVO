/** Read-only inventory grouped by exported operations. Heuristic, NOT a coverage proof. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(resolve(root,'src/data.js'),'utf8');
const entries=[...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)];
const flows=[];
for(let i=0;i<entries.length;i++){
 const m=entries[i],end=entries[i+1]?.index??source.length,body=source.slice(m.index,end);
 const writes=[...body.matchAll(/\bt\.(set|update|delete)\s*\(/g)].map(x=>x[1]);
 if(!writes.length)continue;
 const otRefs=/doc\(db,\s*['"]ots['"]|doc\(collection\(db,\s*['"]ots['"]/.test(body);
 const risks=[];
 if(otRefs && /\bt\.set\s*\([^,]+,[^)]*\{\s*[^}]*\}/s.test(body))risks.push('Revisar set y estructura completa de OT');
 if(otRefs && /\bt\.update\s*\(/.test(body))risks.push('Verificar lectura previa y parches FieldValue');
 if(otRefs && /\.forEach\s*\(/.test(body))risks.push('Verificar transacción múltiple: todas las lecturas antes de escribir');
 flows.push({function:m[1],line:source.slice(0,m.index).split('\n').length,otReference:otRefs,writeCount:writes.length,methods:[...new Set(writes)],review:risks});
}
const result={version:'1.0.0.92',warning:'Auditoría heurística de código fuente; NO certifica cobertura, seguridad de reglas ni funcionamiento en Firebase.',totalFlows:flows.length,otCandidateFlows:flows.filter(f=>f.otReference).length,flows};
writeFileSync(resolve(root,'AUDITORIA_FLUJOS_V1.0.0.92.json'),JSON.stringify(result,null,2)+'\n');
console.log(`Flujos con escrituras: ${result.totalFlows}; candidatos OT: ${result.otCandidateFlows}`);
