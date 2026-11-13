// 筆記本層級的操作：建立、匯入 PDF、匯出 PDF / 圖片、備份與還原、縮圖
import { db } from './db.js';
import { h, uid } from './util.js';
import { busy, sheet, toast } from './ui.js';
import { A4, renderPage, ensureImages } from './render.js';
import { renderPdf, pdfPageSizes, buildPdf, closePdfs } from './pdfio.js';

export function newPage(noteId, o = {}) {
  return {
    id: uid(), noteId,
    w: o.w ?? A4.w, h: o.h ?? A4.h,
    template: o.template ?? 'lined', color: o.color ?? 'white',
    pdf: o.pdf ?? null, strokes: [], items: [],
  };
}

// 把整頁（含 PDF 底圖、筆跡、圖片、文字）畫成點陣圖
export async function rasterize(page, scale, canvas = document.createElement('canvas'), front = false) {
  canvas.width = Math.max(1, Math.round(page.w * scale));
  canvas.height = Math.max(1, Math.round(page.h * scale));
  const ctx = canvas.getContext('2d');
  let pdfDrawn = false;
  if (page.pdf) {
    try {
      pdfDrawn = await renderPdf(page.pdf.blobId, page.pdf.page, canvas, scale, 0, 0, null, front);
    } catch { /* 底圖失敗仍輸出筆跡 */ }
  }
  await ensureImages(page);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  renderPage(ctx, page, { noBg: pdfDrawn, texts: true });
  return canvas;
}

export async function refreshThumb(note, firstPage) {
  if (!firstPage) return;
  try {
    const c = await rasterize(firstPage, 360 / firstPage.w);
    note.thumb = c.toDataURL('image/jpeg', 0.82);
    c.width = c.height = 0;
  } catch { /* 縮圖失敗不影響使用 */ }
}

export async function createNote({ title, cover, template, color, landscape }) {
  const note = {
    id: uid(), title, cover, fav: false, createdAt: Date.now(), updatedAt: Date.now(),
    pageIds: [], blobIds: [], lastPage: 0, thumb: null,
    paper: { template, color, landscape: !!landscape },
  };
  const page = newPage(note.id, {
    template, color,
    w: landscape ? A4.h : A4.w, h: landscape ? A4.w : A4.h,
  });
  note.pageIds.push(page.id);
  await refreshThumb(note, page);
  await db.put('pages', page);
  await db.put('notes', note);
  return note;
}

export async function importPdf(file) {
  const b = busy('匯入 PDF…');
  try {
    const buf = await file.arrayBuffer();
    const blobId = uid();
    await db.put('blobs', { id: blobId, type: 'application/pdf', buf });
    let sizes;
    try {
      sizes = await pdfPageSizes(blobId);
    } catch (e) {
      await db.del('blobs', blobId);
      throw e;
    }
    const note = {
      id: uid(), title: file.name.replace(/\.pdf$/i, '') || 'PDF', cover: '#e5484d', fav: false,
      createdAt: Date.now(), updatedAt: Date.now(), pageIds: [], blobIds: [blobId], lastPage: 0, thumb: null,
      paper: { template: 'blank', color: 'white', landscape: false },
    };
    const pages = sizes.map((s, i) => newPage(note.id, { w: s.w, h: s.h, template: 'blank', pdf: { blobId, page: i + 1 } }));
    note.pageIds = pages.map((p) => p.id);
    await refreshThumb(note, pages[0]);
    await db.putMany('pages', pages);
    await db.put('notes', note);
    return note;
  } finally {
    closePdfs();
    b.close();
  }
}

export async function duplicateNote(id) {
  const src = await db.get('notes', id);
  const pages = await db.pagesOf(id);
  const blobMap = new Map();
  for (const bid of src.blobIds || []) {
    const rec = await db.get('blobs', bid);
    if (!rec) continue;
    const nid = uid();
    blobMap.set(bid, nid);
    await db.put('blobs', { ...rec, id: nid });
  }
  const note = { ...src, id: uid(), title: src.title + ' 副本', createdAt: Date.now(), updatedAt: Date.now(), blobIds: [...blobMap.values()] };
  const pageMap = new Map();
  const copies = pages.map((p) => {
    const np = remapPage(p, note.id, blobMap);
    pageMap.set(p.id, np.id);
    return np;
  });
  note.pageIds = src.pageIds.map((pid) => pageMap.get(pid)).filter(Boolean);
  await db.putMany('pages', copies);
  await db.put('notes', note);
  return note;
}

function remapPage(p, noteId, blobMap) {
  return {
    ...p, id: uid(), noteId,
    pdf: p.pdf ? { ...p.pdf, blobId: blobMap.get(p.pdf.blobId) ?? p.pdf.blobId } : null,
    items: p.items.map((it) => (it.type === 'img' ? { ...it, blobId: blobMap.get(it.blobId) ?? it.blobId } : it)),
  };
}

/* ---------- 匯出 ---------- */

const safeName = (s) => (s || '筆記').replace(/[\\/:*?"<>|]/g, '_');
const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

export async function exportPdf(note, pages) {
  const b = busy('匯出 PDF…');
  try {
    const items = [];
    const cv = document.createElement('canvas');
    for (let i = 0; i < pages.length; i++) {
      b.set(`匯出 PDF… ${i + 1} / ${pages.length}`);
      const p = pages[i];
      const scale = Math.min(2.4, Math.sqrt(6e6 / (p.w * p.h)));
      await rasterize(p, scale, cv);
      items.push({ w: p.w, h: p.h, pw: cv.width, ph: cv.height, blob: await toBlob(cv, 'image/jpeg', 0.9) });
    }
    cv.width = cv.height = 0;
    b.close();
    offerFile(buildPdf(items), safeName(note.title) + '.pdf');
  } catch (e) {
    b.close();
    toast('匯出失敗：' + e.message);
  }
}

export async function exportPng(note, page, index) {
  const b = busy('產生圖片…');
  try {
    const cv = await rasterize(page, Math.min(3, Math.sqrt(8e6 / (page.w * page.h))));
    const blob = await toBlob(cv, 'image/png');
    cv.width = cv.height = 0;
    b.close();
    offerFile(blob, `${safeName(note.title)}-${index + 1}.png`);
  } catch (e) {
    b.close();
    toast('匯出失敗：' + e.message);
  }
}

// iOS 上分享面板需要在使用者點擊的當下呼叫，所以先顯示一個確認視窗
export function offerFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  const canShare = !!navigator.canShare?.({ files: [file] });
  const download = () => {
    const url = URL.createObjectURL(blob);
    h('a', { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    s.close();
  };
  const share = async () => {
    try {
      await navigator.share({ files: [file] });
      s.close();
    } catch (e) {
      if (e.name !== 'AbortError') download();
    }
  };
  const mb = (blob.size / 1048576).toFixed(1);
  const s = sheet('檔案已準備好', h('div', { class: 'modal-msg' }, `${name}（${mb} MB）`), [
    h('button', { class: 'btn', onclick: () => s.close() }, '取消'),
    canShare
      ? h('button', { class: 'btn primary', onclick: share }, '分享 / 儲存到檔案')
      : h('button', { class: 'btn primary', onclick: download }, '下載'),
  ]);
}

/* ---------- 備份 / 還原 ---------- */

function b64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

export async function backupNote(id) {
  const b = busy('建立備份…');
  try {
    const note = await db.get('notes', id);
    const pages = await db.pagesOf(id);
    const blobs = [];
    for (const bid of note.blobIds || []) {
      const rec = await db.get('blobs', bid);
      if (rec) blobs.push({ id: rec.id, type: rec.type, data: b64(rec.buf) });
    }
    const data = {
      app: 'inkpad', version: 1, note,
      pages: pages.map((p) => ({
        ...p,
        strokes: p.strokes.map((s) => ({ ...s, pts: b64(s.pts.buffer.slice(s.pts.byteOffset, s.pts.byteOffset + s.pts.byteLength)) })),
      })),
      blobs,
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    b.close();
    offerFile(blob, safeName(note.title) + '.inkpad.json');
  } catch (e) {
    b.close();
    toast('備份失敗：' + e.message);
  }
}

export async function restoreBackup(file) {
  const b = busy('還原備份…');
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'inkpad' || !data.note || !Array.isArray(data.pages)) throw new Error('不是墨記的備份檔');
    const blobMap = new Map();
    for (const rec of data.blobs || []) {
      const nid = uid();
      blobMap.set(rec.id, nid);
      await db.put('blobs', { id: nid, type: rec.type, buf: unb64(rec.data) });
    }
    const note = { ...data.note, id: uid(), updatedAt: Date.now(), blobIds: [...blobMap.values()] };
    const pageMap = new Map();
    const pages = data.pages.map((p) => {
      const np = remapPage({
        ...p,
        items: p.items || [],
        strokes: (p.strokes || []).map((s) => ({ ...s, pts: new Float32Array(unb64(s.pts)) })),
      }, note.id, blobMap);
      pageMap.set(p.id, np.id);
      return np;
    });
    note.pageIds = (data.note.pageIds || []).map((pid) => pageMap.get(pid)).filter(Boolean);
    if (!note.pageIds.length) throw new Error('備份檔沒有頁面');
    await db.putMany('pages', pages);
    await db.put('notes', note);
    return note;
  } finally {
    b.close();
  }
}
