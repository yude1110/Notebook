// PDF 讀取（pdf.js）與輸出（自製的精簡 PDF 寫出器：每頁一張 JPEG）
import { db } from './db.js';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
let libP;

function getLib() {
  return (libP ??= import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
    return lib;
  }));
}

const docs = new Map(); // blobId → Promise<PDFDocumentProxy>

export function openPdf(blobId) {
  let p = docs.get(blobId);
  if (!p) {
    p = (async () => {
      const [lib, rec] = await Promise.all([getLib(), db.get('blobs', blobId)]);
      if (!rec) throw new Error('找不到 PDF 檔案');
      return lib.getDocument({
        data: new Uint8Array(rec.buf.slice(0)),
        cMapUrl: BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: BASE + 'standard_fonts/',
      }).promise;
    })();
    p.catch(() => docs.delete(blobId));
    docs.set(blobId, p);
  }
  return p;
}

export function closePdfs() {
  for (const p of docs.values()) p.then((d) => d.destroy()).catch(() => {});
  docs.clear();
}

// 一次只算一頁，避免 iPad 記憶體尖峰；front = true 的工作插隊（畫面上正在看的頁面）
const queue = [];
let running = false;

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      job.resolve(await job.run());
    } catch (e) {
      job.reject(e);
    }
  }
  running = false;
}

// 把 PDF 某頁的 (ox, oy) 起、canvas 大小範圍，以 scale 倍率畫進 canvas。回傳 false 表示已被取消。
export function renderPdf(blobId, pageNo, canvas, scale, ox = 0, oy = 0, stale = null, front = true) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      if (stale?.()) return false;
      const doc = await openPdf(blobId);
      const pg = await doc.getPage(pageNo);
      if (stale?.()) return false;
      const viewport = pg.getViewport({ scale, offsetX: -ox * scale, offsetY: -oy * scale });
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return true;
    };
    const job = { run, resolve, reject };
    if (front) queue.unshift(job);
    else queue.push(job);
    pump();
  });
}

export async function pdfPageSizes(blobId) {
  const doc = await openPdf(blobId);
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const v = (await doc.getPage(i)).getViewport({ scale: 1 });
    out.push({ w: Math.round(v.width * 100) / 100, h: Math.round(v.height * 100) / 100 });
  }
  return out;
}

// items: [{ w, h（pt）, pw, ph（像素）, blob（JPEG）}]
export function buildPdf(items) {
  const parts = [];
  const offsets = [];
  let off = 0;
  const push = (x) => {
    parts.push(x);
    off += typeof x === 'string' ? x.length : x.size;
  };
  const begin = (n) => (offsets[n] = off);
  push('%PDF-1.4\n');
  const n = items.length;
  const kids = items.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  begin(1);
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  push(`2 0 obj\n<< /Type /Pages /Count ${n} /Kids [${kids}] >>\nendobj\n`);
  items.forEach((it, i) => {
    const pageN = 3 + i * 3, contN = pageN + 1, imgN = pageN + 2;
    const w = it.w.toFixed(2), hh = it.h.toFixed(2);
    begin(pageN);
    push(`${pageN} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${hh}] /Resources << /XObject << /Im0 ${imgN} 0 R >> >> /Contents ${contN} 0 R >>\nendobj\n`);
    const content = `q ${w} 0 0 ${hh} 0 0 cm /Im0 Do Q`;
    begin(contN);
    push(`${contN} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(imgN);
    push(`${imgN} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${it.pw} /Height ${it.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${it.blob.size} >>\nstream\n`);
    push(it.blob);
    push('\nendstream\nendobj\n');
  });
  const total = 2 + n * 3;
  const xref = off;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(table);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
