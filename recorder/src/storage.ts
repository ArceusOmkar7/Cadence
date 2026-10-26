// IndexedDB storage: raw packets are written while recording, so a crash or a closed tab loses at most a second.
import type { SessionRec, StoredPacket } from './types';

const DB = 'glove-recorder';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('packets', { keyPath: ['sid', 'idx'] });
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve((r ? r.result : undefined) as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const putSession = (s: SessionRec) => run('sessions', 'readwrite', (st) => st.put(s));
export const getSession = (id: string) => run<SessionRec | undefined>('sessions', 'readonly', (st) => st.get(id));
export const listSessions = () => run<SessionRec[]>('sessions', 'readonly', (st) => st.getAll());

export async function deleteSession(id: string): Promise<void> {
  await run('sessions', 'readwrite', (st) => st.delete(id));
  await run('packets', 'readwrite', (st) => st.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
}

export function addPackets(sid: string, first: number, rows: StoredPacket[]): Promise<void> {
  if (!rows.length) return Promise.resolve();
  return run<void>('packets', 'readwrite', (st) => { rows.forEach((r, i) => st.put({ sid, idx: first + i, rxMs: r.rxMs, buf: r.buf })); });
}

export async function readPackets(sid: string, first = 0, last = Number.MAX_SAFE_INTEGER): Promise<StoredPacket[]> {
  const rows = await run<{ idx: number; rxMs: number; buf: ArrayBuffer }[]>('packets', 'readonly', (st) => st.getAll(IDBKeyRange.bound([sid, first], [sid, last])));
  return rows.map((r) => ({ rxMs: r.rxMs, buf: r.buf }));
}

export const getSetting = <T>(key: string) => run<{ key: string; value: T } | undefined>('settings', 'readonly', (st) => st.get(key)).then((r) => r?.value);
export const putSetting = (key: string, value: unknown) => run('settings', 'readwrite', (st) => st.put({ key, value }));

/** Ask the browser not to evict recorded data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
