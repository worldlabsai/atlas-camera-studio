import type { GetToken } from "./client";
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("marble-camera-drafts", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("items");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
export async function readStored<T>(
  getToken: GetToken,
  kind: string,
): Promise<Record<string, T>> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const req = db
        .transaction("items")
        .objectStore("items")
        .get(`${getToken.storageScope ?? "local"}:${kind}`);
      req.onsuccess = () => resolve(req.result ?? {});
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
export async function changeStored<T>(
  getToken: GetToken,
  kind: string,
  change: (items: Record<string, T>) => void,
) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("items", "readwrite"),
        store = tx.objectStore("items"),
        key = `${getToken.storageScope ?? "local"}:${kind}`;
      const req = store.get(key);
      req.onsuccess = () => {
        try {
          const items = req.result ?? {};
          change(items);
          store.put(items, key);
        } catch (e) {
          tx.abort();
          reject(e);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new Error("Could not save draft in this browser"));
    });
  } finally {
    db.close();
  }
}
