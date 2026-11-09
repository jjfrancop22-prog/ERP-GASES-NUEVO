/** OT search mirror: opt-in only on localhost AND Firestore emulator.
 * Never enable on production until security rules and backfill are verified.
 */
import {doc} from 'firebase/firestore';
import {indexPayload} from '../tools/search-index-core.mjs';
import {createOTMirror} from './ot-search-transaction-core.mjs';
const localHost = typeof location !== 'undefined' && ['localhost','127.0.0.1'].includes(location.hostname);
export const OT_SEARCH_MIRROR_ENABLED = import.meta.env.VITE_OT_SEARCH_MIRROR === 'true' &&
  import.meta.env.VITE_FIRESTORE_EMULATOR === 'true' && localHost;
export function mirrorTransaction(transaction, db) {
 return createOTMirror(transaction, id => doc(db, 'otSearchIndex', id), indexPayload);
}
