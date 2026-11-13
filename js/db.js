// IndexedDB 封裝。stores：notes（筆記本）、pages（頁面與筆跡）、blobs（PDF / 圖片原始資料）
const NAME = 'inkpad';
const VERSION = 1;
let dbp;

function open() {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('pages', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      d.createObjectStore('blobs', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

async function batch(name, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(name, 'readwrite');
    fn(t.objectStore(name));
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const db = {
  async get(s, id) { return req((await store(s)).get(id)); },
  async all(s) { return req((await store(s)).getAll()); },
  async put(s, v) { return req((await store(s, 'readwrite')).put(v)); },
  async del(s, id) { return req((await store(s, 'readwrite')).delete(id)); },
  putMany(s, arr) { return batch(s, (st) => arr.forEach((v) => st.put(v))); },
  delMany(s, ids) { return batch(s, (st) => ids.forEach((id) => st.delete(id))); },
  async pagesOf(noteId) { return req((await store('pages')).index('noteId').getAll(noteId)); },

  async deleteNote(id) {
    const note = await this.get('notes', id);
    const pages = await this.pagesOf(id);
    await this.delMany('pages', pages.map((p) => p.id));
    await this.delMany('blobs', note?.blobIds || []);
    await this.del('notes', id);
  },
};
