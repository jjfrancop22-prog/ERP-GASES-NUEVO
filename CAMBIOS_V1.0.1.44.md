# V1.0.1.44 — Recuperación de búsqueda por correlativo

- La búsqueda `483` consulta códigos completos como `RG260483` y `RR260483` directamente en Firestore, sin escanear todas las OT.
- Recuperación por correlativo de 3 o 4 cifras, en series RG, RR o ambas, y años históricos configurados.
- Combina los resultados verificados con el índice auxiliar sin duplicados.
- Si el índice está desactualizado, conserva y muestra las coincidencias verificadas y advierte que el resultado puede ser parcial.
- La misma recuperación se aplica a consumidores de `searchOTIndexOperational`, incluidos laboratorio, facturación y supervisión.
- No se modifican las reglas, los documentos OT ni los índices de Firestore.

**Validación:** comprobación sintáctica de JavaScript realizada. No se ha podido ejecutar la compilación Vite ni probar Firestore en vivo en este entorno. Comprobar en producción RG 483, RR 483 y RR+RG 483, además de búsqueda por cliente.
