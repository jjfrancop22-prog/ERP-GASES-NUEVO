# ERP PSI Gases NextGen 2027 · V1.0.1.05

## Publicación en GitHub y Netlify
1. Subir el contenido de esta carpeta `app` como raíz del repositorio.
2. En Netlify, conectar el repositorio. Build: `npm run build`; Publish: `dist`.
3. No modificar `public/version.json` sin publicar una nueva versión real.
4. Ejecutar `npm install` y `npm run dev` para desarrollo local.

## Acceso
Firebase Authentication usa persistencia **por sesión del navegador**. Al cerrar todas las pestañas de la sesión y abrir una nueva sesión del navegador, se vuelve a solicitar contraseña. El cierre explícito con «Salir» termina la sesión inmediatamente. La opción de restaurar sesiones del navegador puede variar según el navegador.

## Actualizaciones
La versión se muestra en el encabezado y el lateral. Cada 10 minutos, y al regresar a la pestaña, el navegador consulta `version.json` sin usar Firestore. Si detecta una versión superior, muestra «Nueva versión» y ofrece recargar con confirmación.

## Seguridad
No se modificaron las reglas de Firestore ni los procesos de registro de OT. El archivo de configuración Firebase incluye identificadores públicos del cliente; los permisos reales deben permanecer protegidos con Authentication y Firestore Rules.
