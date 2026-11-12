// IndexedDB(端末内だけに保存。外部へは送らない)
(function (root) {
  'use strict';
  const NAME = 'bodylog', VERSION = 1;
  const STORES = ['records', 'days', 'meals', 'health', 'progress', 'images', 'thumbs', 'settings'];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(NAME, VERSION);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        const r = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true }); r.createIndex('date', 'date');
        db.createObjectStore('days', { keyPath: 'date' });
        const m = db.createObjectStore('meals', { keyPath: 'id', autoIncrement: true }); m.createIndex('date', 'date');
        db.createObjectStore('health', { keyPath: 'id', autoIncrement: true });
        const p = db.createObjectStore('progress', { keyPath: 'id', autoIncrement: true }); p.createIndex('date', 'date');
        db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('thumbs', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'key' });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
      rq.onblocked = () => reject(new Error('blocked'));
    });
    return dbp;
  }
  const req = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

  const api = {
    open,
    all: (s) => open().then((db) => req(db.transaction(s).objectStore(s).getAll())),
    get: (s, k) => open().then((db) => req(db.transaction(s).objectStore(s).get(k))),
    put: (s, v) => open().then((db) => { const tx = db.transaction(s, 'readwrite'); const rq = tx.objectStore(s).put(v); return new Promise((res, rej) => { tx.oncomplete = () => res(rq.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }),
    del: (s, k) => open().then((db) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).delete(k); return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }),
    putMany: (s, list) => open().then((db) => { const tx = db.transaction(s, 'readwrite'); const st = tx.objectStore(s); const keys = []; list.forEach((v) => { const rq = st.put(v); rq.onsuccess = () => keys.push(rq.result); }); return new Promise((res, rej) => { tx.oncomplete = () => res(keys); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }),
    clearAll: () => open().then((db) => { const tx = db.transaction(STORES, 'readwrite'); STORES.forEach((s) => tx.objectStore(s).clear()); return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }),
    addImage: (full, thumb) => open().then((db) => { const tx = db.transaction(['images', 'thumbs'], 'readwrite'); const rq = tx.objectStore('images').add({ blob: full }); let id; rq.onsuccess = () => { id = rq.result; tx.objectStore('thumbs').put({ id, blob: thumb }); }; return new Promise((res, rej) => { tx.oncomplete = () => res(id); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }),
    delImage: (id) => open().then((db) => { const tx = db.transaction(['images', 'thumbs'], 'readwrite'); tx.objectStore('images').delete(id); tx.objectStore('thumbs').delete(id); return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }),
    image: (id) => api.get('images', id).then((x) => x && x.blob),
    thumb: (id) => api.get('thumbs', id).then((x) => x && x.blob),
  };
  root.BL = root.BL || {}; root.BL.db = api;
})(window);
