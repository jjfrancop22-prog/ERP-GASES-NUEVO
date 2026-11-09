# V1.0.1.30 · Acceso confidencial a Facturación

1. **Antes de publicar la web**, sustituya las reglas del proyecto Firebase `nuevo-erp-gases` por el archivo `firestore.rules` de este paquete y pulse **Publicar**. Sin este paso, los permisos no estarán protegidos en el servidor.
2. Publique este código en GitHub/Netlify (sin `node_modules` ni `dist`).
3. Ingrese con ADMINISTRADOR → Usuarios y permisos → Editar perfil de Michelle → Acceso confidencial a Facturación: **Autorizado** → Guardar perfil.
4. Verifique que todos los demás perfiles OPERACIONES tengan Facturación: **No autorizado**. Los nuevos perfiles se crean sin acceso de forma predeterminada.
5. Pruebe con una cuenta OPERACIONES sin permiso: no debe ver Facturación ni poder leer `otBilling` en Firestore. Pruebe también Michelle y ADMINISTRADOR.

El administrador siempre tiene acceso. Los demás usuarios OPERACIONES mantienen los módulos técnicos y catálogos. El cambio de permisos se escucha en tiempo real; no requiere una contraseña adicional.

**Importante:** El módulo Supervisión conserva la columna de estado de facturación, pero para usuarios sin autorización se muestra «Restringido». Si existen campos económicos duplicados dentro de otros documentos (`ots` u otras colecciones) se requerirá separarlos para una confidencialidad completa; estas reglas protegen específicamente `otBilling` y `otBillingAudit`.

No se han modificado los registros almacenados en Firebase. No se han ejecutado pruebas de despliegue ni pruebas contra el servidor real.
