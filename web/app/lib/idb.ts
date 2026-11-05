// 브라우저 저장소(IndexedDB) 키-값. 작업 복구 사본, 최근 파일 핸들, 구조 전환 전 원본에 쓴다.
// 원본은 항상 파일이다. 여기 것은 지워져도 잃는 것이 없게 쓴다(사본·편의).
const DB = 'arp';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const idb = {
  get: async <T>(key: string): Promise<T | undefined> => { try { return await tx('readonly', s => s.get(key)) as T | undefined; } catch { return undefined; } },
  set: async (key: string, value: unknown): Promise<void> => { try { await tx('readwrite', s => s.put(value, key)); } catch { /* 저장소를 못 써도 앱은 돈다 */ } },
  del: async (key: string): Promise<void> => { try { await tx('readwrite', s => s.delete(key)); } catch { /* 무시 */ } },
};

/** projectKey = 프로젝트 이름|만든 시각. 그 프로젝트를 저장했을 때만 사본을 지운다 */
export interface Recovery { name: string; at: number; bytes: ArrayBuffer; projectName: string; projectKey?: string }
export interface RecentFile { name: string; at: number; handle: FileSystemFileHandle }

/** 최근 파일: 같은 파일이면 앞으로, 최대 6개 */
export async function rememberRecent(handle: FileSystemFileHandle, name: string): Promise<void> {
  const list = (await idb.get<RecentFile[]>('recent')) ?? [];
  const kept: RecentFile[] = [];
  for (const r of list) {
    try { if (await r.handle.isSameEntry(handle)) continue; } catch { /* 지워진 파일 */ }
    kept.push(r);
  }
  await idb.set('recent', [{ name, at: Date.now(), handle }, ...kept].slice(0, 6));
}

/** 파일 핸들을 다시 쓸 권한(브라우저가 사용자에게 한 번 묻는다) */
export async function ensurePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const h = handle as FileSystemFileHandle & {
    queryPermission?: (o: unknown) => Promise<PermissionState>;
    requestPermission?: (o: unknown) => Promise<PermissionState>;
  };
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}
