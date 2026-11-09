V1.0.1.32 - Notificaciones y consulta puntual

1. Copia de seguridad antes de publicar.
2. Publicar firestore.rules en el proyecto nuevo-erp-gases, sin modificar índices actuales.
   firebase deploy --only firestore:rules --project nuevo-erp-gases
   NOTA: este proyecto incluye firestore.rules pero no firebase.json; crear firebase.json con {"firestore":{"rules":"firestore.rules","indexes":"firestore.indexes.json"}} antes de desplegar.
3. Instalar dependencias con npm install; comprobar npm run build.
4. Probar registro, recepción y autorización (estados 1/4) en entorno controlado.
5. La interfaz solo presenta avisos de las últimas 48 horas y un máximo de 20. Para eliminación física automática, habilitar política TTL en Firestore sobre el campo expiresAt de otNotifications. TTL no es instantáneo.
6. Los avisos son auxiliares y se escriben después del guardado principal: fallos de red pueden impedir un aviso sin afectar la OT. Para garantía transaccional exacta se requiere integrar los avisos en las transacciones de OT.
7. La trazabilidad muestra los hitos que estén disponibles en el documento de OT; no reconstruye un historial de auditoría exhaustivo.
8. La consulta por número utiliza los códigos RR/RG de 6 dígitos; no ejecuta escaneo de todas las OT.
