// 繪製：紙張範本、筆跡、圖片、文字。所有座標皆為「頁面單位」（pt，A4 = 595 × 842）。
import { db } from './db.js';

export const FONT = '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Segoe UI", sans-serif';
export const TEXT_PAD = 4;
export const LINE_H = 1.35;

export const PAPERS = {
  white: { name: '白色', bg: '#ffffff', line: '#c9d2de', strong: '#9fb0c6', dark: false },
  cream: { name: '米黃', bg: '#fbf4de', line: '#dccfa6', strong: '#c2b07a', dark: false },
  dark: { name: '深色', bg: '#1f2023', line: '#3e4148', strong: '#5a5e68', dark: true },
};

export const TEMPLATES = [
  ['blank', '空白'], ['lined', '橫線'], ['grid', '方格'], ['dots', '點陣'], ['cornell', '康乃爾'],
];

export const A4 = { w: 595, h: 842 };

export function drawTemplate(ctx, page) {
  const { w, h } = page;
  const P = PAPERS[page.color] || PAPERS.white;
  ctx.fillStyle = P.bg;
  ctx.fillRect(0, 0, w, h);
  const t = page.template;
  if (!t || t === 'blank') return;
  ctx.strokeStyle = ctx.fillStyle = P.line;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  if (t === 'lined' || t === 'cornell') {
    for (let y = 72; y < h - 20; y += 24) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    if (t === 'cornell') {
      ctx.strokeStyle = P.strong;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const sy = h - 130, cx = Math.round(w * 0.27);
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, sy);
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
      ctx.stroke();
    }
  } else if (t === 'grid') {
    const g = 20, ox = (w % g) / 2, oy = (h % g) / 2;
    for (let x = ox; x <= w; x += g) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = oy; y <= h; y += g) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  } else if (t === 'dots') {
    const g = 20, ox = (w % g) / 2 + g / 2, oy = (h % g) / 2 + g / 2;
    ctx.fillStyle = P.strong;
    for (let y = oy; y < h; y += g) {
      for (let x = ox; x < w; x += g) {
        ctx.moveTo(x + 0.9, y);
        ctx.arc(x, y, 0.9, 0, 6.2832);
      }
    }
    ctx.fill();
  }
}

/* ---------- 筆跡 ---------- */

// p 為 0~1 的壓力值，0.5 時寬度等於設定粗細
export function strokeWidth(s, p) {
  const k = s.pen === 'fountain' ? 0.7 : s.pen === 'brush' ? 0.95 : 0.18;
  return s.size * Math.max(0.12, 1 + k * (2 * p - 1));
}

// 以中點二次曲線平滑，逐段變寬。from：從第幾段開始畫（即時書寫時只補畫新段）
export function drawPen(ctx, s, from = 0) {
  const a = s.pts, n = a.length / 3;
  if (!n) return;
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(a[0], a[1], strokeWidth(s, a[2]) / 2, 0, 6.2832);
    ctx.fill();
    return;
  }
  let bw = -1;
  for (let j = Math.max(0, from); j < n; j++) {
    const i = j * 3;
    const w = strokeWidth(s, a[i + 2]);
    if (bw < 0 || Math.abs(w - bw) > bw * 0.04) {
      if (bw >= 0) ctx.stroke();
      ctx.beginPath();
      if (j === 0) ctx.moveTo(a[0], a[1]);
      else ctx.moveTo((a[i - 3] + a[i]) / 2, (a[i - 2] + a[i + 1]) / 2);
      ctx.lineWidth = bw = w;
    }
    if (j === 0) ctx.lineTo((a[0] + a[3]) / 2, (a[1] + a[4]) / 2);
    else if (j === n - 1) ctx.lineTo(a[i], a[i + 1]);
    else ctx.quadraticCurveTo(a[i], a[i + 1], (a[i] + a[i + 3]) / 2, (a[i + 1] + a[i + 4]) / 2);
  }
  ctx.stroke();
}

export function drawHl(ctx, s, dark) {
  const a = s.pts, n = a.length / 3;
  if (!n) return;
  ctx.save();
  ctx.globalAlpha = dark ? 0.45 : 0.5;
  ctx.globalCompositeOperation = dark ? 'screen' : 'multiply';
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath();
  if (n === 1) {
    ctx.arc(a[0], a[1], s.size / 2, 0, 6.2832);
    ctx.fill();
  } else {
    ctx.moveTo(a[0], a[1]);
    for (let j = 1; j < n - 1; j++) {
      const i = j * 3;
      ctx.quadraticCurveTo(a[i], a[i + 1], (a[i] + a[i + 3]) / 2, (a[i + 1] + a[i + 4]) / 2);
    }
    ctx.lineTo(a[n * 3 - 3], a[n * 3 - 2]);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawStroke(ctx, s, dark) {
  if (s.tool === 'hl') drawHl(ctx, s, dark);
  else drawPen(ctx, s);
}

export function strokeBBox(s) {
  const a = s.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] < x0) x0 = a[i];
    if (a[i] > x1) x1 = a[i];
    if (a[i + 1] < y0) y0 = a[i + 1];
    if (a[i + 1] > y1) y1 = a[i + 1];
  }
  const pad = s.tool === 'hl' ? s.size / 2 : s.size;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/* ---------- 圖片 ---------- */

export const images = new Map(); // blobId → 可繪製的圖片
const pending = new Map();

export function loadImage(id) {
  if (images.has(id)) return Promise.resolve(images.get(id));
  let p = pending.get(id);
  if (!p) {
    p = (async () => {
      const rec = await db.get('blobs', id);
      if (!rec) return null;
      const blob = new Blob([rec.buf], { type: rec.type });
      let im;
      try {
        im = await createImageBitmap(blob);
      } catch {
        im = await new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = URL.createObjectURL(blob);
        });
      }
      images.set(id, im);
      return im;
    })().finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

// 回傳 null 表示全部已載入
export function ensureImages(page) {
  const ids = page.items.filter((i) => i.type === 'img' && !images.has(i.blobId)).map((i) => i.blobId);
  return ids.length ? Promise.all(ids.map((id) => loadImage(id).catch(() => null))) : null;
}

export function drawImageItem(ctx, it) {
  const im = images.get(it.blobId);
  if (im) ctx.drawImage(im, it.x, it.y, it.w, it.h);
  else {
    ctx.fillStyle = 'rgba(128,128,128,.15)';
    ctx.fillRect(it.x, it.y, it.w, it.h);
  }
}

/* ---------- 文字 ---------- */

const TOKEN = /[⺀-鿿豈-﫿＀-￯]|[^\s⺀-鿿豈-﫿＀-￯]+|\s/g;

export function drawText(ctx, it, page) {
  ctx.font = `${it.fs}px ${FONT}`;
  ctx.fillStyle = it.color;
  ctx.textBaseline = 'alphabetic';
  const maxW = Math.max(20, page.w - it.x - TEXT_PAD * 2);
  const lh = it.fs * LINE_H;
  let y = it.y + TEXT_PAD + (lh - it.fs) / 2 + it.fs * 0.86;
  for (const para of it.text.split('\n')) {
    let line = '';
    for (const tok of para.match(TOKEN) || []) {
      if (line && ctx.measureText(line + tok).width > maxW) {
        ctx.fillText(line, it.x + TEXT_PAD, y);
        y += lh;
        line = tok.trim() ? tok : '';
      } else line += tok;
    }
    ctx.fillText(line, it.x + TEXT_PAD, y);
    y += lh;
  }
}

/* ---------- 整頁 ---------- */

// ctx 的 transform 需已設定為「頁面單位 → 畫布像素」
// o.bg: { canvas, x, y, w, h } PDF 底圖；o.view: [x0,y0,x1,y1] 只畫範圍內筆跡；o.skip: Set 略過的 id
export function renderPage(ctx, page, o = {}) {
  const P = PAPERS[page.color] || PAPERS.white;
  const dark = !page.pdf && P.dark;
  if (!o.noBg) {
    if (page.pdf) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, page.w, page.h);
      if (o.bg) ctx.drawImage(o.bg.canvas, o.bg.x, o.bg.y, o.bg.w, o.bg.h);
    } else drawTemplate(ctx, page);
  }
  const v = o.view, skip = o.skip;
  for (const it of page.items) {
    if (it.type === 'img' && !(skip && skip.has(it.id))) drawImageItem(ctx, it);
  }
  for (const s of page.strokes) {
    if (skip && skip.has(s.id)) continue;
    const b = s.bb;
    if (v && (b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3])) continue;
    drawStroke(ctx, s, dark);
  }
  if (o.texts) {
    for (const it of page.items) if (it.type === 'text') drawText(ctx, it, page);
  }
}

export const isDarkPage = (page) => !page.pdf && !!(PAPERS[page.color] || PAPERS.white).dark;
