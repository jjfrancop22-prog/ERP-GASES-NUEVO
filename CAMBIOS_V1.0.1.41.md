# V1.0.1.41 — Corrección Facturación RR/RG

- Versión visible actualizada en pantalla, package.json y public/version.json.
- Búsqueda de índice filtrada por serie **en Firestore**, antes del límite de resultados.
- Límite de candidatos por búsqueda de facturación ampliado a 1500, sin cargar OT al entrar.
- Índice compuesto nuevo: otSearchIndex: series ASC + grams ARRAY_CONTAINS.

## Para publicar
1. Desplegar esta carpeta completa en GitHub/Netlify (no el ZIP anterior).
2. Crear el índice compuesto incluido en firestore.indexes.json en Firebase (mediante CLI: firebase deploy --only firestore:indexes, con proyecto correcto). Esperar estado **Enabled**.
3. Verificar que en la esquina del ERP figure V1.0.1.41 y probar RR con 450.
4. Si falta algún resultado, reconstruir el índice auxiliar con la función administrativa existente; la búsqueda depende de su cobertura.

No se modifican las OT, reglas de acceso ni registros de facturación. No se ha probado contra el Firebase de producción.
