# ERP GASES NEXTGEN 2027 · V1.0.0

Proyecto **nuevo e independiente**, preparado para Firebase Spark. No modifica el ERP anterior ni su proyecto `psi-kardex1`.

## Iniciar

```bash
npm install
npm run dev
```

Para compilar: `npm run build`. Publicar `dist/` en Netlify con HTTPS para instalar como PWA.

## Configurar administrador (obligatorio)

1. En el proyecto Firebase `nuevo-erp-gases`, habilitar Authentication → Correo/contraseña y crear el usuario administrador.
2. Copiar el UID real desde Authentication → Usuarios.
3. En `firestore.rules`, reemplazar **REEMPLAZAR_UID_ADMIN** por ese UID (sin cambiar las comillas).
4. Publicar las reglas en Firestore Database → Reglas.
5. Crear manualmente en Firestore el documento `users/<UID_REAL>` con estos campos: `name` (string) = `Administrador principal`, `email` (string) = correo real, `role` (string) = `ADMINISTRADOR`, `active` (boolean) = `true`. Alternativamente, tras publicar las reglas, la creación del perfil inicial está autorizada para ese UID, pero la aplicación V1.0.0 no ejecuta automáticamente esa escritura.
6. Iniciar sesión desde el ERP.

**Seguridad:** Nunca use `allow read, write: if true` en producción. El archivo de reglas es un punto de partida para esta versión, no una matriz completa de permisos operativos. No inserte claves privadas ni Admin SDK en el navegador.

## Alcance real de V1.0.0

- Interfaz moderna, responsive, PWA, inicio de sesión Firebase Authentication y control de perfil activo.
- Firestore: consulta bajo demanda de páginas de 25, contador agregado solo al solicitarlo, caché persistente SDK IndexedDB, registro básico de OT con código único y registro de clientes.
- Esqueleto de bandejas Laboratorio, Informes, Autorización y Facturación; **no implementa todavía sus flujos técnicos heredados**.
- Validación **local y solo lectura** de JSON de respaldo. **No migra registros** en esta versión.
- Protección de versiones para actualizaciones mediante transacción (función de datos disponible, UI de edición pendiente).
- No se hacen escuchas permanentes ni cargas masivas automáticas.

## Migración del ERP anterior

No conecte este proyecto a `psi-kardex1` ni importe datos sin antes revisar el esquema real y los UUID, códigos RR/RG, relaciones, informes, estados, auditoría y facturación. Se necesita un respaldo JSON verificado del ERP anterior. Las 996 OT históricas NO se copian automáticamente.

## Spark y consumo

La paginación reduce lecturas por apertura, pero cada documento obtenido consume lecturas según las reglas de facturación de Firestore; la caché no garantiza cero lecturas. Consultas agregadas y comprobaciones de reglas también pueden tener costos de lectura. Monitoree Firestore → Uso. No se usa Cloud Functions ni Blaze.


## V1.0.0.1 — corrección de verificación de perfil
- La validación del perfil usa `getDocFromServer` para evitar falsos «Acceso pendiente» por caché Firestore antigua.
- La pantalla diferencia perfil inexistente, perfil inactivo y error de lectura.
- Incluye botón de reintento y diagnóstico de ruta/proyecto.
- No modifica las reglas de seguridad, usuarios ni datos existentes.
- Si continúa el error, confirme que las reglas están **publicadas** y el UID de Authentication coincide con el ID de `users/{uid}`.


Consulte CAMBIOS_V1.0.0.6.md para límites y pruebas pendientes.
