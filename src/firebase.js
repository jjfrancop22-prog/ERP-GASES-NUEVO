import {initializeApp} from 'firebase/app';
import {initializeAuth,browserSessionPersistence} from 'firebase/auth';
import {initializeFirestore,persistentLocalCache,persistentMultipleTabManager,connectFirestoreEmulator} from 'firebase/firestore';
export const firebaseConfig={apiKey:'AIzaSyBUMllFRScJ8I1ufFdbEeJqjwt4n_hPTKw',authDomain:'nuevo-erp-gases.firebaseapp.com',projectId:'nuevo-erp-gases',storageBucket:'nuevo-erp-gases.firebasestorage.app',messagingSenderId:'333550045723',appId:'1:333550045723:web:651de35b906f94b2bf46be'};
export const app=initializeApp(firebaseConfig);
// La sesión solo persiste durante la sesión del navegador; al cerrar y volver a abrir se solicita contraseña.
export const auth=initializeAuth(app,{persistence:browserSessionPersistence});
export const db=initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})});

// Explicit local-only test mode: never route a deployed ERP to the emulator.
if(import.meta.env.VITE_FIRESTORE_EMULATOR === 'true' && typeof location !== 'undefined' && ['localhost','127.0.0.1'].includes(location.hostname)){
 connectFirestoreEmulator(db,'127.0.0.1',8080);
}
