# Corrección de índices para producción mensual RR/RG

Se añadieron dos índices compuestos a `firestore.indexes.json` para las consultas agregadas COUNT + SUM(points):
- ots: series ASC, workDate ASC, points ASC
- ots: series ASC, createdAt ASC, points ASC

## Importante
Subir el ZIP a GitHub **no publica automáticamente los índices** salvo que exista un despliegue configurado de Firebase. Desde la carpeta del proyecto, con Firebase CLI autenticado y proyecto correcto seleccionado, ejecutar:

`firebase deploy --only firestore:indexes --project nuevo-erp-gases`

Esperar hasta que ambos índices estén **Habilitados**. Después recargar el ERP y consultar el mes. No borrar índices existentes.

Si persiste `failed-precondition`, revisar el enlace exacto de creación de índice del error de consola: Firestore puede solicitar una configuración adicional. La agregación COUNT/SUM no descarga todos los documentos, pero sí puede generar lecturas de entradas de índice facturables.

Esta actualización no modifica reglas de seguridad, permisos, facturación ni registros.
