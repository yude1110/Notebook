// 編輯器：頁面排版、縮放、書寫輸入、各種工具、選取、文字、復原。
// 捲動交給瀏覽器原生處理（最順），雙指縮放自行以 transform 處理，放開後再重新排版。
import { $, h, uid, clamp, dpr, pickFile, releaseCanvas } from './util.js';
import { ic } from './icons.js';
import { db } from './db.js';
import { toast, popover, menu, confirmBox, promptBox } from './ui.js';
import {
  PAPERS, LINE_H, TEXT_PAD, images, ensureImages, renderPage, drawPen, drawHl, drawStroke,
  drawImageItem, strokeBBox, isDarkPage,
} from './render.js';
import { renderPdf, closePdfs } from './pdfio.js';
import { newPage, rasterize, refreshThumb, exportPdf, exportPng, backupNote } from './exporter.js';
import { templatePicker, palette, COLORS, HL_COLORS } from './widgets.js';

const PAD = 12;            // 頁面間距（頁面單位），需與 CSS 的 calc(var(--s) * 12px) 一致
const ZMIN = 0.5, ZMAX = 6;
const MAX_BASE = 3.6e6;    // 每頁底層畫布的像素上限（iPad 記憶體有限）
const MAX_DETAIL = 6e6;    // 放大時「高解析補畫層」的像素上限
const LS_KEY = 'inkpad.tools';

const TOOLS = [
  ['pen', 'pen', '筆'], ['hl', 'hl', '螢光筆'], ['eraser', 'eraser', '橡皮擦'],
  ['shape', 'shape', '圖形'], ['lasso', 'lasso', '套索'], ['text', 'text', '文字'],
];
const PEN_TYPES = [['ball', '原子筆'], ['fountain', '鋼筆'], ['brush', '毛筆']];
const SHAPES = [['line', '直線'], ['arrow', '箭頭'], ['rect', '矩形'], ['ellipse', '橢圓'], ['triangle', '三角形']];
const SIZE_RANGE = { pen: [0.3, 6, 0.1], hl: [4, 40, 1], eraser: [4, 60, 1], text: [8, 72, 1] };

const DEFAULTS = {
  tool: 'pen',
  fingerDraw: false,
  pen: { pen: 'ball', colors: ['#1c1c1e', '#e5484d', '#3478f6'], ci: 0, sizes: [0.9, 1.6, 2.8], si: 1 },
  hl: { colors: ['#ffe04a', '#8ee88a', '#ff9ecd'], ci: 0, sizes: [8, 14, 22], si: 1 },
  eraser: { mode: 'stroke', sizes: [8, 16, 30], si: 1 },
  shape: { kind: 'line' },
  text: { sizes: [12, 16, 24], si: 1 },
};

let E = null; // 目前開啟中的編輯器狀態

function loadSettings() {
  const set = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY)) || {};
    for (const k of Object.keys(set)) {
      if (saved[k] == null) continue;
      if (typeof set[k] === 'object') Object.assign(set[k], saved[k]);
      else set[k] = saved[k];
    }
  } catch { /* 使用預設值 */ }
  return set;
}

function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(E.set));
  } catch { /* 無法儲存偏好不影響使用 */ }
}

/* ================= 開啟 / 關閉 ================= */

export async function openEditor(noteId, onClose) {
  const note = await db.get('notes', noteId);
  if (!note) throw new Error('筆記本不存在');
  const byId = new Map((await db.pagesOf(noteId)).map((p) => [p.id, p]));
  let pages = note.pageIds.map((id) => byId.get(id)).filter(Boolean);
  for (const p of pages) {
    p.items ||= [];
    p.strokes ||= [];
  }
  note.blobIds ||= [];
  if (!pages.length) {
    const p = newPage(note.id, note.paper);
    pages = [p];
    note.pageIds = [p.id];
    await db.put('pages', p);
    await db.put('notes', note);
  }

  E = {
    note, onClose, set: loadSettings(),
    list: [], zoom: 1, fit: 1, S: 1,
    undo: [], redo: [], dirty: new Set(), inval: new Set(),
    ac: new AbortController(),
    active: null, pinch: null, zooming: false, sel: null, editing: null, clip: null,
    detail: null, detailPending: null, tap: null, penT: -1e9,
  };

  const el = $('#editor');
  el.innerHTML = '';
  el.hidden = false;
  el.dataset.tool = E.set.tool;
  E.pagesEl = h('div', { class: 'pages' });
  E.vp = h('div', { class: 'vp' }, E.pagesEl);
  E.live = h('canvas', { class: 'live' });
  E.lctx = E.live.getContext('2d');
  E.cursor = h('div', { class: 'cursor' });
  E.ind = h('div', { class: 'pageind' });
  E.selbar = buildSelBar();
  E.stage = h('div', { class: 'stage' }, E.vp, E.live, E.cursor, E.ind, E.selbar);
  el.append(buildBar(), E.stage);

  E.list = pages.map(makePm);
  E.pagesEl.append(...E.list.map((pm) => pm.el));
  computeFit();
  applyScale();
  E.io = new IntersectionObserver(onIntersect, { root: E.vp, rootMargin: '30% 0px' });
  E.list.forEach((pm) => E.io.observe(pm.el));

  const sig = { signal: E.ac.signal };
  const act = { signal: E.ac.signal, passive: false };
  E.vp.addEventListener('pointerdown', onPointerDown, sig);
  E.vp.addEventListener('pointermove', onPointerMove, sig);
  E.vp.addEventListener('pointerup', onPointerUp, sig);
  E.vp.addEventListener('pointercancel', onPointerCancel, sig);
  E.vp.addEventListener('touchstart', onTouchStart, act);
  E.vp.addEventListener('touchmove', onTouchMove, act);
  E.vp.addEventListener('touchend', onTouchEnd, sig);
  E.vp.addEventListener('touchcancel', onTouchCancel, sig);
  E.vp.addEventListener('wheel', onWheel, act);
  E.vp.addEventListener('scroll', onScroll, { signal: E.ac.signal, passive: true });
  window.addEventListener('resize', onResize, sig);
  window.addEventListener('keydown', onKey, sig);
  document.addEventListener('visibilitychange', () => document.hidden && flush(), sig);
  window.addEventListener('pagehide', flush, sig);

  const start = E.list[clamp(note.lastPage || 0, 0, E.list.length - 1)];
  if (start !== E.list[0]) E.vp.scrollTop = start.el.offsetTop - PAD * E.S;
  updateBar();
  updateUndo();
  updateInd();
}

async function closeEditor() {
  if (!E || E.closing) return;
  E.closing = true;
  finishEdit();
  commitSelection();
  cancelActive();
  const { note, onClose } = E;
  note.lastPage = E.list.indexOf(currentPm());
  await flush();
  await refreshThumb(note, E.list[0].page);
  await db.put('notes', note);
  E.ac.abort();
  E.io.disconnect();
  clearTimeout(E.saveT);
  clearTimeout(E.detailT);
  clearTimeout(E.refreshT);
  dropDetail();
  for (const pm of E.list) if (pm.base) kill(pm.base);
  releaseCanvas(E.live);
  closePdfs();
  E = null;
  const el = $('#editor');
  el.hidden = true;
  el.innerHTML = '';
  onClose?.();
}

/* ================= 儲存 ================= */

function markDirty(page) {
  E.dirty.add(page);
  clearTimeout(E.saveT);
  E.saveT = setTimeout(flush, 700);
}

async function flush() {
  if (!E || !E.dirty.size) return;
  const pages = [...E.dirty];
  E.dirty.clear();
  E.note.updatedAt = Date.now();
  try {
    await db.putMany('pages', pages);
    await db.put('notes', E.note);
  } catch (e) {
    console.error(e);
    pages.forEach((p) => E?.dirty.add(p));
    toast('儲存失敗，請確認裝置儲存空間');
  }
}

function saveNote() {
  E.note.pageIds = E.list.map((pm) => pm.page.id);
  E.note.updatedAt = Date.now();
  return db.put('notes', E.note);
}

// 所有筆跡 / 物件的變更都經過這裡，才能復原。strokes、items 陣列視為不可變。
function commit(page, strokes, items) {
  const op = { page };
  if (strokes && strokes !== page.strokes) {
    op.sBefore = page.strokes;
    op.sAfter = page.strokes = strokes;
  }
  if (items && items !== page.items) {
    op.iBefore = page.items;
    op.iAfter = page.items = items;
  }
  if (!op.sAfter && !op.iAfter) return;
  E.undo.push(op);
  if (E.undo.length > 300) E.undo.shift();
  E.redo.length = 0;
  markDirty(page);
  updateUndo();
}

function stepHistory(from, to, back) {
  finishEdit();
  commitSelection();
  const op = from.pop();
  if (!op) return;
  if (op.sAfter) op.page.strokes = back ? op.sBefore : op.sAfter;
  if (op.iAfter) op.page.items = back ? op.iBefore : op.iAfter;
  to.push(op);
  const pm = E.list.find((x) => x.page === op.page);
  if (pm) {
    if (pm.mounted) {
      invalidate(pm);
      if (op.iAfter) {
        syncTexts(pm);
        ensureImages(pm.page)?.then(() => E && invalidate(pm));
      }
    }
    if (!isVisible(pm)) scrollToPage(pm);
  }
  markDirty(op.page);
  updateUndo();
}

const undo = () => stepHistory(E.undo, E.redo, true);
const redo = () => stepHistory(E.redo, E.undo, false);

function updateUndo() {
  E.undoBtn.disabled = !E.undo.length;
  E.redoBtn.disabled = !E.redo.length;
}

/* ================= 版面與畫布 ================= */

function makePm(page) {
  const texts = h('div', { class: 'texts' });
  const el = h('div', { class: 'page', style: { '--w': page.w, '--h': page.h, background: paperBg(page) } }, texts);
  const pm = { page, el, texts, base: null, mounted: false };
  el._pm = pm;
  return pm;
}

const paperBg = (page) => (page.pdf ? '#fff' : (PAPERS[page.color] || PAPERS.white).bg);

function computeFit() {
  const maxW = Math.max(...E.list.map((pm) => pm.page.w));
  E.fit = Math.min(E.vp.clientWidth / (maxW + PAD * 2), 1400 / maxW);
}

function applyScale() {
  E.S = +(E.fit * E.zoom).toFixed(4);
  E.pagesEl.style.setProperty('--s', E.S);
}

function baseScale(page) {
  return Math.min(E.S * dpr(), Math.sqrt(MAX_BASE / (page.w * page.h)));
}

// surface：一塊畫布，對應頁面上 (ox, oy) 起、w × h 的範圍
function makeSurface(scale, ox, oy, w, hgt) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(hgt * scale));
  return {
    canvas, ctx: canvas.getContext('2d', { alpha: false }),
    sx: canvas.width / w, sy: canvas.height / hgt, ox, oy, w, h: hgt, bg: null, dead: false,
  };
}

function kill(surf) {
  surf.dead = true;
  releaseCanvas(surf.canvas);
  releaseCanvas(surf.bg);
  surf.bg = null;
}

function setUnits(surf) {
  surf.ctx.setTransform(surf.sx, 0, 0, surf.sy, -surf.ox * surf.sx, -surf.oy * surf.sy);
}

function redraw(pm, surf) {
  if (!surf || surf.dead) return;
  setUnits(surf);
  const partial = surf.w < pm.page.w || surf.h < pm.page.h;
  renderPage(surf.ctx, pm.page, {
    bg: surf.bg && { canvas: surf.bg, x: surf.ox, y: surf.oy, w: surf.w, h: surf.h },
    skip: E.sel && E.sel.pm === pm ? E.sel.ids : null,
    view: partial ? [surf.ox, surf.oy, surf.ox + surf.w, surf.oy + surf.h] : null,
  });
}

async function fillPdfBg(surf, page) {
  const cv = document.createElement('canvas');
  cv.width = surf.canvas.width;
  cv.height = surf.canvas.height;
  let ok = false;
  try {
    ok = await renderPdf(page.pdf.blobId, page.pdf.page, cv, surf.sx, surf.ox, surf.oy, () => surf.dead);
  } catch (e) {
    console.warn('PDF 頁面繪製失敗', e);
  }
  if (!ok || surf.dead) {
    releaseCanvas(cv);
    return false;
  }
  surf.bg = cv;
  return true;
}

function onIntersect(entries) {
  if (!E) return;
  for (const en of entries) {
    const pm = en.target._pm;
    if (!pm) continue;
    if (en.isIntersecting) mount(pm);
    else unmount(pm);
  }
}

function mount(pm) {
  if (pm.mounted) return;
  pm.mounted = true;
  const page = pm.page;
  const surf = makeSurface(baseScale(page), 0, 0, page.w, page.h);
  surf.canvas.className = 'base';
  pm.base = surf;
  pm.el.prepend(surf.canvas);
  redraw(pm, surf);
  syncTexts(pm);
  if (page.pdf) fillPdfBg(surf, page).then((ok) => ok && E && pm.base === surf && redraw(pm, surf));
  ensureImages(page)?.then(() => E && invalidate(pm));
  scheduleDetail();
}

function unmount(pm) {
  if (!pm.mounted) return;
  if (E.active?.pm === pm) return; // 書寫中不卸載
  if (E.sel?.pm === pm) commitSelection();
  if (E.editing?.pm === pm) finishEdit();
  if (E.detail?.pm === pm) dropDetail();
  pm.mounted = false;
  pm.base.canvas.remove();
  kill(pm.base);
  pm.base = null;
  pm.texts.replaceChildren();
}

function invalidate(pm) {
  E.inval.add(pm);
  if (E.raf) return;
  E.raf = requestAnimationFrame(() => {
    if (!E) return;
    E.raf = 0;
    for (const p of E.inval) {
      if (!p.mounted) continue;
      redraw(p, p.base);
      if (E.detail?.pm === p) redraw(p, E.detail);
    }
    E.inval.clear();
  });
}

// 直接在現有畫布上補畫（新增筆畫時不必整頁重畫）
function paintOn(pm, fn) {
  if (!pm.mounted) return;
  for (const surf of [pm.base, E.detail?.pm === pm ? E.detail : null]) {
    if (!surf || surf.dead) continue;
    setUnits(surf);
    fn(surf.ctx);
  }
}

/* ---------- 高解析補畫層：放大後只把「看得到的區域」用螢幕解析度重畫 ---------- */

function scheduleDetail(delay = 140) {
  clearTimeout(E.detailT);
  E.detailT = setTimeout(updateDetail, delay);
}

function dropDetail() {
  if (E.detailPending) E.detailPending.dead = true;
  E.detailPending = null;
  if (!E.detail) return;
  E.detail.canvas.remove();
  kill(E.detail);
  E.detail = null;
}

async function updateDetail() {
  if (!E) return;
  if (E.pinch || E.zooming || E.active) return scheduleDetail(220);
  const vr = E.vp.getBoundingClientRect();
  let best = null, bestA = 0, br = null;
  for (const pm of E.list) {
    if (!pm.mounted) continue;
    const r = pm.el.getBoundingClientRect();
    const w = Math.min(r.right, vr.right) - Math.max(r.left, vr.left);
    const hh = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
    if (w > 0 && hh > 0 && w * hh > bestA) {
      bestA = w * hh;
      best = pm;
      br = r;
    }
  }
  const want = E.S * dpr();
  if (!best || want <= best.base.sx * 1.08) return dropDetail();
  const S = E.S, page = best.page;
  const vx0 = Math.max(0, (vr.left - br.left) / S), vy0 = Math.max(0, (vr.top - br.top) / S);
  const vx1 = Math.min(page.w, (vr.right - br.left) / S), vy1 = Math.min(page.h, (vr.bottom - br.top) / S);
  const d = E.detail;
  if (d && d.pm === best && d.S === S && d.ox <= vx0 + 0.5 && d.oy <= vy0 + 0.5 && d.ox + d.w >= vx1 - 0.5 && d.oy + d.h >= vy1 - 0.5) return;

  let mx = (vx1 - vx0) * 0.25, my = (vy1 - vy0) * 0.25, sc = want;
  const area = () => (Math.min(page.w, vx1 + mx) - Math.max(0, vx0 - mx)) * (Math.min(page.h, vy1 + my) - Math.max(0, vy0 - my)) * sc * sc;
  if (area() > MAX_DETAIL) mx = my = 0;
  if (area() > MAX_DETAIL) sc *= Math.sqrt(MAX_DETAIL / area());
  if (sc <= best.base.sx * 1.08) return dropDetail();
  const x0 = Math.max(0, vx0 - mx), y0 = Math.max(0, vy0 - my);
  const pw = Math.ceil((Math.min(page.w, vx1 + mx) - x0) * sc), ph = Math.ceil((Math.min(page.h, vy1 + my) - y0) * sc);
  const surf = makeSurface(sc, x0, y0, pw / sc, ph / sc);
  surf.pm = best;
  surf.S = S;
  if (E.detailPending) E.detailPending.dead = true;
  E.detailPending = surf;
  if (page.pdf) await fillPdfBg(surf, page);
  if (!E || surf.dead || !best.mounted || E.detailPending !== surf) return kill(surf);
  E.detailPending = null;
  redraw(best, surf);
  surf.canvas.className = 'detail';
  Object.assign(surf.canvas.style, {
    left: (x0 / page.w) * 100 + '%', top: (y0 / page.h) * 100 + '%',
    width: (surf.w / page.w) * 100 + '%', height: (surf.h / page.h) * 100 + '%',
  });
  const old = E.detail;
  E.detail = surf;
  best.el.insertBefore(surf.canvas, best.texts);
  if (old) {
    old.canvas.remove();
    kill(old);
  }
}

// 縮放或視窗大小改變後，視需要以新解析度重建底層畫布
function scheduleRefresh() {
  clearTimeout(E.refreshT);
  E.refreshT = setTimeout(async () => {
    if (!E) return;
    for (const pm of E.list) if (pm.mounted) rebuildBase(pm);
    if (E.sel) drawSel();
    updateDetail();
  }, 160);
}

async function rebuildBase(pm) {
  const page = pm.page, old = pm.base, bs = baseScale(page);
  if (Math.abs(bs - old.sx) / bs < 0.1) return;
  const surf = makeSurface(bs, 0, 0, page.w, page.h);
  surf.canvas.className = 'base';
  if (page.pdf) await fillPdfBg(surf, page);
  if (!E || !pm.mounted || pm.base !== old) return kill(surf);
  pm.base = surf;
  redraw(pm, surf);
  old.canvas.replaceWith(surf.canvas);
  kill(old);
}

/* ================= 捲動、頁碼、縮放 ================= */

function currentPm() {
  const vr = E.vp.getBoundingClientRect();
  const cy = vr.top + vr.height / 2;
  let best = null, bd = Infinity;
  for (const pm of E.list) {
    if (!pm.mounted) continue;
    const r = pm.el.getBoundingClientRect();
    const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
    if (d < bd) {
      bd = d;
      best = pm;
    }
  }
  if (best) return best;
  // 尚未有頁面掛載時（剛開啟），用排版位置判斷
  const mid = E.vp.scrollTop + vr.height / 2;
  return E.list.find((pm) => pm.el.offsetTop + pm.el.offsetHeight >= mid) || E.list[E.list.length - 1];
}

function isVisible(pm) {
  const vr = E.vp.getBoundingClientRect(), r = pm.el.getBoundingClientRect();
  return r.bottom > vr.top + 40 && r.top < vr.bottom - 40;
}

function scrollToPage(pm, smooth = false) {
  E.vp.scrollTo({ top: pm.el.offsetTop - PAD * E.S, behavior: smooth ? 'smooth' : 'auto' });
}

function updateInd() {
  const i = E.list.indexOf(currentPm());
  E.ind.textContent = `${i + 1} / ${E.list.length}`;
  E.ind.classList.add('show');
  clearTimeout(E.indT);
  E.indT = setTimeout(() => E?.ind.classList.remove('show'), 1600);
}

function onScroll() {
  scheduleDetail();
  if (E.scrollRaf) return;
  E.scrollRaf = requestAnimationFrame(() => {
    if (!E) return;
    E.scrollRaf = 0;
    updateInd();
  });
}

function onResize() {
  const pm = currentPm();
  const vr = E.vp.getBoundingClientRect(), r = pm.el.getBoundingClientRect();
  const frac = (vr.top - r.top) / r.height;
  computeFit();
  applyScale();
  const r2 = pm.el.getBoundingClientRect();
  E.vp.scrollTop += r2.top + frac * r2.height - vr.top;
  scheduleRefresh();
}

// a: { cx, cy：縮放前內容座標（相對 .pages 左上角）, k：倍率變化, sx, sy：該點最後應落在的螢幕位置 }
function commitZoom(zoom, a, animate = true) {
  const el = E.pagesEl;
  const r0 = el.getBoundingClientRect();
  el.style.transition = 'none';
  el.style.transform = '';
  E.zoom = zoom;
  applyScale();
  const r = el.getBoundingClientRect();
  E.vp.scrollLeft += r.left + a.cx * a.k - a.sx;
  E.vp.scrollTop += r.top + a.cy * a.k - a.sy;
  const r1 = el.getBoundingClientRect();
  const dx = r0.left - r1.left, dy = r0.top - r1.top, sc = r0.width / r1.width;
  if (animate && (Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(sc - 1) > 0.004)) {
    // 位置被邊界修正時，從放手當下的樣子平滑滑到定位
    el.style.transform = `translate(${dx}px,${dy}px) scale(${sc})`;
    el.getBoundingClientRect();
    el.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
    el.style.transform = '';
  }
  E.zooming = false;
  scheduleRefresh();
  updateInd();
}

function animateZoom(zoom, x, y) {
  const el = E.pagesEl;
  const r = el.getBoundingClientRect();
  const k = zoom / E.zoom, cx = x - r.left, cy = y - r.top;
  E.zooming = true;
  el.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)';
  el.style.transform = `translate(${cx * (1 - k)}px,${cy * (1 - k)}px) scale(${k})`;
  setTimeout(() => E && commitZoom(zoom, { cx, cy, k, sx: x, sy: y }), 250);
}

function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (E.active || E.pinch || E.zooming) return;
  const nz = clamp(E.zoom * Math.exp(-e.deltaY * 0.01), ZMIN, ZMAX);
  const k = nz / E.zoom;
  if (k === 1) return;
  const r = E.pagesEl.getBoundingClientRect();
  commitZoom(nz, { cx: e.clientX - r.left, cy: e.clientY - r.top, k, sx: e.clientX, sy: e.clientY }, false);
}

/* ---------- 觸控：手指捲動 / 雙指縮放；Apple Pencil 一律不捲動 ---------- */

const fingers = (e) => [...e.touches].filter((t) => t.touchType !== 'stylus');

function onTouchStart(e) {
  const t = e.target;
  if (t.closest('.tb.editing, .tb-tools')) return;
  for (const c of e.changedTouches) {
    if (c.touchType === 'stylus') {
      e.preventDefault();
      return;
    }
  }
  const a = E.active;
  if (a && a.ptype === 'pen') return e.preventDefault(); // 書寫中的手掌
  const fs = fingers(e);
  if (fs.length === 2 && !E.zooming) {
    e.preventDefault();
    if (a) {
      if (a.ptype === 'touch' && e.timeStamp - a.t0 < 350 && a.moved < 30) cancelActive();
      else return;
    }
    if (e.timeStamp - E.penT < 500) return; // 剛用筆寫完，多半是手掌
    E.tap = E.t1 = E.dt = null;
    startPinch(fs);
    return;
  }
  if (fs.length > 2) return e.preventDefault();
  if (E.set.fingerDraw || t.closest('.sel')) return e.preventDefault();
  E.t1 = { x: fs[0].clientX, y: fs[0].clientY, t: e.timeStamp };
}

function onTouchMove(e) {
  if (!E.pinch) return;
  if (e.cancelable) e.preventDefault();
  const fs = fingers(e);
  if (fs.length >= 2) movePinch(fs);
}

function onTouchEnd(e) {
  if (E.pinch) {
    if (fingers(e).length < 2) endPinch();
    return;
  }
  // 手指點兩下：在「符合寬度」與放大之間切換
  const t1 = E.t1;
  E.t1 = null;
  const tool = E.set.tool;
  if (!t1 || e.touches.length || E.set.fingerDraw || tool === 'text' || tool === 'lasso' || E.editing) return;
  const c = e.changedTouches[0];
  if (e.timeStamp - t1.t > 260 || Math.hypot(c.clientX - t1.x, c.clientY - t1.y) > 12) {
    E.dt = null;
    return;
  }
  const d = E.dt;
  if (d && e.timeStamp - d.t < 320 && Math.hypot(c.clientX - d.x, c.clientY - d.y) < 44) {
    E.dt = null;
    if (!E.zooming) animateZoom(E.zoom > 1.05 ? 1 : 2.2, c.clientX, c.clientY);
  } else E.dt = { x: c.clientX, y: c.clientY, t: e.timeStamp };
}

function onTouchCancel() {
  E.t1 = E.dt = null;
  if (!E.pinch) return;
  // 系統判定為手掌而取消：還原，不套用縮放
  E.pinch = null;
  E.pagesEl.style.transform = '';
}

const mid = (fs) => ({ x: (fs[0].clientX + fs[1].clientX) / 2, y: (fs[0].clientY + fs[1].clientY) / 2 });
const gap = (fs) => Math.hypot(fs[0].clientX - fs[1].clientX, fs[0].clientY - fs[1].clientY) || 1;

function startPinch(fs) {
  const el = E.pagesEl;
  el.style.transition = 'none';
  el.style.transform = '';
  const r = el.getBoundingClientRect(), m = mid(fs);
  E.pinch = { d0: gap(fs), k: 1, r, cx: m.x - r.left, cy: m.y - r.top, m };
}

function movePinch(fs) {
  const p = E.pinch, m = mid(fs);
  const k = clamp(E.zoom * (gap(fs) / p.d0), ZMIN, ZMAX) / E.zoom;
  p.k = k;
  p.m = m;
  E.pagesEl.style.transform = `translate(${m.x - p.r.left - p.cx * k}px,${m.y - p.r.top - p.cy * k}px) scale(${k})`;
}

function endPinch() {
  const p = E.pinch;
  E.pinch = null;
  commitZoom(E.zoom * p.k, { cx: p.cx, cy: p.cy, k: p.k, sx: p.m.x, sy: p.m.y });
}

function lockScroll(on) {
  clearTimeout(E.lockT);
  if (on) E.vp.classList.add('lock');
  else E.lockT = setTimeout(() => E?.vp.classList.remove('lock'), 220);
}

/* ================= 指標輸入（筆 / 滑鼠 / 手指繪圖） ================= */

function onPointerDown(e) {
  if (E.pinch || E.zooming || E.active) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const t = e.target;
  if (t.closest('.tb.editing, .tb-tools, .sel')) return;
  if (E.editing) return finishEdit(); // 點別處：結束文字編輯
  const pageEl = t.closest('.page');
  const pm = pageEl?._pm;
  if (e.pointerType === 'touch' && !E.set.fingerDraw) {
    // 手指只負責捲動；單純點一下則交給 handleTap
    E.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, pm, target: t };
    return;
  }
  if (e.pointerType === 'pen') E.penT = e.timeStamp;
  if (!pm || !pm.mounted) return commitSelection();
  e.preventDefault();
  try {
    E.vp.setPointerCapture(e.pointerId);
  } catch { /* 部分瀏覽器對已結束的指標會丟例外 */ }
  const tool = E.set.tool;
  const a = E.active = {
    id: e.pointerId, ptype: e.pointerType, pm, target: t,
    r: pageEl.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, t0: e.timeStamp, moved: 0,
    hadSel: !!E.sel,
  };
  if (E.sel) commitSelection();
  lockScroll(true);
  if (tool === 'pen' || tool === 'hl') startInk(a, e);
  else if (tool === 'shape') startShape(a, e);
  else if (tool === 'eraser') startErase(a, e);
  else if (tool === 'lasso') startLasso(a, e);
  else a.kind = 'tap';
}

function onPointerMove(e) {
  const a = E.active;
  if (!a || e.pointerId !== a.id) return;
  a.moved = Math.max(a.moved, Math.hypot(e.clientX - a.sx, e.clientY - a.sy));
  const co = e.getCoalescedEvents?.();
  const list = co && co.length ? co : [e];
  if (a.kind === 'ink') moveInk(a, list, e);
  else if (a.kind === 'shape') moveShape(a, e);
  else if (a.kind === 'erase') moveErase(a, list);
  else if (a.kind === 'lasso') moveLasso(a, list);
}

function onPointerUp(e) {
  const tap = E.tap;
  if (tap && tap.id === e.pointerId) {
    E.tap = null;
    if (e.timeStamp - tap.t < 400 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10) {
      handleTap(tap.pm, tap.target, e.clientX, e.clientY, !!E.sel);
    }
    return;
  }
  const a = E.active;
  if (!a || e.pointerId !== a.id) return;
  E.active = null;
  if (a.ptype === 'pen') E.penT = e.timeStamp;
  lockScroll(false);
  if (a.kind === 'ink') endInk(a, e);
  else if (a.kind === 'shape') endShape(a);
  else if (a.kind === 'erase') endErase(a);
  else if (a.kind === 'lasso') endLasso(a, e);
  else if (a.kind === 'tap' && a.moved < 10) handleTap(a.pm, a.target, e.clientX, e.clientY, a.hadSel);
  scheduleDetail();
}

function onPointerCancel(e) {
  if (E.tap?.id === e.pointerId) E.tap = null;
  if (E.active?.id === e.pointerId) cancelActive();
}

function cancelActive() {
  const a = E.active;
  if (!a) return;
  E.active = null;
  clearTimeout(a.hold);
  if (a.live) liveEnd();
  if (a.kind === 'erase') endErase(a);
  lockScroll(false);
}

/* ---------- 即時書寫層：蓋在畫面最上層的螢幕大小畫布，只畫「正在寫的這一筆」 ---------- */

function liveBegin(a) {
  const c = E.live, x = E.lctx, d = dpr();
  const vr = E.vp.getBoundingClientRect();
  const W = Math.round(vr.width * d), H = Math.round(vr.height * d);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, W, H);
  x.save();
  const ox = (a.r.left - vr.left) * d, oy = (a.r.top - vr.top) * d;
  x.beginPath();
  x.rect(ox, oy, a.r.width * d, a.r.height * d);
  x.clip();
  x.setTransform(E.S * d, 0, 0, E.S * d, ox, oy);
  a.live = true;
}

function liveClear() {
  const x = E.lctx;
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, E.live.width, E.live.height);
  x.restore();
}

function liveEnd() {
  liveClear();
  E.lctx.restore();
}

const unitX = (a, e) => (e.clientX - a.r.left) / E.S;
const unitY = (a, e) => (e.clientY - a.r.top) / E.S;

/* ---------- 筆 / 螢光筆 ---------- */

const penPressure = (p) => Math.pow(clamp(p, 0, 1), 0.6);

function startInk(a, e) {
  const hl = E.set.tool === 'hl';
  const cfg = hl ? E.set.hl : E.set.pen;
  a.kind = 'ink';
  a.st = { id: uid(), tool: hl ? 'hl' : 'pen', pen: E.set.pen.pen, color: cfg.colors[cfg.ci], size: cfg.sizes[cfg.si], pts: [] };
  a.dark = isDarkPage(a.pm.page);
  a.p = a.ptype === 'pen' && e.pressure > 0 ? penPressure(e.pressure) : 0.5;
  a.len = 0;
  a.anchor = { x: e.clientX, y: e.clientY };
  liveBegin(a);
  inkPoint(a, e);
  drawLive(a, 0);
  armHold(a);
}

function inkPoint(a, e) {
  const S = E.S, pts = a.st.pts, n = pts.length;
  let x = unitX(a, e), y = unitY(a, e);
  if (n) {
    const lx = pts[n - 3], ly = pts[n - 2];
    const d = Math.hypot(x - lx, y - ly) * S;
    if (d < 0.7) return false;
    let target;
    if (a.ptype === 'pen' && e.pressure > 0) target = penPressure(e.pressure);
    else {
      // 沒有壓力感應時，以速度模擬：寫得快就細一點
      const v = d / Math.max(1, e.timeStamp - a.lt);
      target = clamp(0.8 - v * 0.2, 0.25, 0.8);
      x = lx + (x - lx) * 0.8;
      y = ly + (y - ly) * 0.8;
    }
    a.p += (target - a.p) * (a.ptype === 'pen' ? 0.5 : 0.18);
    a.len += d;
  }
  a.lt = e.timeStamp;
  pts.push(x, y, a.p);
  return true;
}

function drawLive(a, from) {
  if (a.st.tool === 'hl') {
    liveClear();
    drawHl(E.lctx, a.st, a.dark);
  } else if (from < 0) {
    liveClear();
    drawPen(E.lctx, a.st);
  } else drawPen(E.lctx, a.st, from);
}

function moveInk(a, list, e) {
  if (a.snap) {
    if (a.snap.kind === 'line') {
      a.st.pts = snappedLine(a.snap.x0, a.snap.y0, unitX(a, e), unitY(a, e));
      drawLive(a, -1);
    }
    return;
  }
  const n0 = a.st.pts.length / 3;
  let added = false;
  for (const ev of list) added = inkPoint(a, ev) || added;
  if (!added) return;
  drawLive(a, Math.max(0, n0 - 1));
  if (Math.hypot(e.clientX - a.anchor.x, e.clientY - a.anchor.y) > 5) {
    a.anchor = { x: e.clientX, y: e.clientY };
    armHold(a);
  }
}

function endInk(a, e) {
  clearTimeout(a.hold);
  if (!a.snap) inkPoint(a, e);
  const st = a.st;
  const s = { id: st.id, tool: st.tool, pen: st.pen, color: st.color, size: st.size, pts: new Float32Array(st.pts) };
  s.bb = strokeBBox(s);
  liveEnd();
  addStroke(a.pm, s);
}

function addStroke(pm, s) {
  commit(pm.page, pm.page.strokes.concat([s]));
  const dark = isDarkPage(pm.page);
  paintOn(pm, (ctx) => drawStroke(ctx, s, dark));
}

// 寫完停住不放 → 自動修成直線 / 橢圓 / 矩形
function armHold(a) {
  clearTimeout(a.hold);
  a.hold = setTimeout(() => {
    if (!E || E.active !== a || a.snap || a.len < 40) return;
    const sh = recognize(a.st.pts);
    if (!sh) return;
    a.snap = sh;
    a.st.pts = sh.pts;
    drawLive(a, -1);
  }, 520);
}

function linePts(o, x0, y0, x1, y1) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
  for (let i = o.length ? 1 : 0; i <= n; i++) {
    const t = i / n;
    o.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.5);
  }
  return o;
}

function polyPts(v, closed) {
  const o = [];
  for (let i = 0; i < v.length - 1; i++) linePts(o, v[i][0], v[i][1], v[i + 1][0], v[i + 1][1]);
  if (closed) linePts(o, v[v.length - 1][0], v[v.length - 1][1], v[0][0], v[0][1]);
  return o;
}

function ellipsePts(cx, cy, rx, ry) {
  const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / 3));
  const o = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    o.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t), 0.5);
  }
  return o;
}

// 接近水平 / 垂直時吸附
function snappedLine(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  if (dy < dx * 0.06) y1 = y0;
  else if (dx < dy * 0.06) x1 = x0;
  return linePts([], x0, y0, x1, y1);
}

function shapePts(kind, x0, y0, x1, y1, size) {
  if (kind === 'rect') return polyPts([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true);
  if (kind === 'triangle') return polyPts([[(x0 + x1) / 2, y0], [x1, y1], [x0, y1]], true);
  if (kind === 'ellipse') return ellipsePts((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2);
  if (kind === 'arrow') {
    const d = Math.hypot(x1 - x0, y1 - y0), ang = Math.atan2(y1 - y0, x1 - x0);
    const L = Math.min(d * 0.4, 9 + size * 3);
    const hx = (s) => [x1 - L * Math.cos(ang + s * 0.5), y1 - L * Math.sin(ang + s * 0.5)];
    return polyPts([[x0, y0], [x1, y1], hx(1), [x1, y1], hx(-1)], false);
  }
  return snappedLine(x0, y0, x1, y1);
}

function recognize(pts) {
  const n = pts.length / 3;
  if (n < 4) return null;
  const x0 = pts[0], y0 = pts[1], x1 = pts[n * 3 - 3], y1 = pts[n * 3 - 2];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, len = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    if (i) len += Math.hypot(x - pts[i * 3 - 3], y - pts[i * 3 - 2]);
  }
  const chord = Math.hypot(x1 - x0, y1 - y0);
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (chord > diag * 0.7 && len < chord * 1.25) {
    let dev = 0;
    for (let i = 0; i < n; i++) {
      dev = Math.max(dev, Math.abs((pts[i * 3] - x0) * (y1 - y0) - (pts[i * 3 + 1] - y0) * (x1 - x0)) / chord);
    }
    return dev < chord * 0.09 ? { kind: 'line', x0, y0, pts: snappedLine(x0, y0, x1, y1) } : null;
  }
  if (chord > diag * 0.3 || n < 8) return null;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  let rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
  if (rx < 4 || ry < 4) return null;
  let eErr = 0, rErr = 0;
  for (let i = 0; i < n; i++) {
    const dx = Math.abs(pts[i * 3] - cx), dy = Math.abs(pts[i * 3 + 1] - cy);
    eErr += Math.abs(Math.hypot(dx / rx, dy / ry) - 1);
    rErr += Math.min(rx - dx, ry - dy) / Math.min(rx, ry);
  }
  eErr /= n;
  rErr /= n;
  if (Math.abs(rx - ry) < Math.max(rx, ry) * 0.14) rx = ry = (rx + ry) / 2; // 接近正圓 / 正方形
  if (eErr <= rErr && eErr < 0.16) return { kind: 'ellipse', pts: ellipsePts(cx, cy, rx, ry) };
  if (rErr < 0.13) return { kind: 'rect', pts: polyPts([[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]], true) };
  return null;
}

/* ---------- 圖形工具 ---------- */

function startShape(a, e) {
  const cfg = E.set.pen;
  a.kind = 'shape';
  a.x0 = unitX(a, e);
  a.y0 = unitY(a, e);
  a.st = { id: uid(), tool: 'pen', pen: 'ball', color: cfg.colors[cfg.ci], size: cfg.sizes[cfg.si], pts: [] };
  liveBegin(a);
}

function moveShape(a, e) {
  a.st.pts = shapePts(E.set.shape.kind, a.x0, a.y0, unitX(a, e), unitY(a, e), a.st.size);
  liveClear();
  drawPen(E.lctx, a.st);
}

function endShape(a) {
  liveEnd();
  if (a.moved < 5 || !a.st.pts.length) return;
  const s = { ...a.st, pts: new Float32Array(a.st.pts) };
  s.bb = strokeBBox(s);
  addStroke(a.pm, s);
}

/* ---------- 橡皮擦 ---------- */

function startErase(a, e) {
  a.kind = 'erase';
  a.before = a.pm.page.strokes;
  a.R = E.set.eraser.sizes[E.set.eraser.si] / 2;
  a.last = null;
  const d = a.R * 2 * E.S;
  Object.assign(E.cursor.style, { width: d + 'px', height: d + 'px', display: 'block' });
  moveErase(a, [e]);
}

function moveErase(a, list) {
  const sr = E.stage.getBoundingClientRect();
  for (const e of list) {
    const x = unitX(a, e), y = unitY(a, e);
    if (a.last) {
      const d = Math.hypot(x - a.last.x, y - a.last.y);
      const steps = Math.max(1, Math.ceil(d / (a.R * 0.6)));
      for (let i = 1; i <= steps; i++) eraseAt(a, a.last.x + ((x - a.last.x) * i) / steps, a.last.y + ((y - a.last.y) * i) / steps);
    } else eraseAt(a, x, y);
    a.last = { x, y };
    E.cursor.style.transform = `translate(${e.clientX - sr.left}px,${e.clientY - sr.top}px) translate(-50%,-50%)`;
  }
}

function eraseAt(a, x, y) {
  const page = a.pm.page, arr = page.strokes, R = a.R;
  const precise = E.set.eraser.mode === 'precise';
  let out = null;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i], b = s.bb;
    if (x < b[0] - R || x > b[2] + R || y < b[1] - R || y > b[3] + R) {
      out?.push(s);
      continue;
    }
    const parts = precise ? splitStroke(s, x, y, R) : hitStroke(s, x, y, R) ? [] : null;
    if (!parts) {
      out?.push(s);
      continue;
    }
    out ??= arr.slice(0, i);
    out.push(...parts);
  }
  if (out) {
    page.strokes = out;
    invalidate(a.pm);
  }
}

function endErase(a) {
  E.cursor.style.display = 'none';
  const page = a.pm.page, after = page.strokes;
  if (after === a.before) return;
  page.strokes = a.before;
  commit(page, after);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

function hitStroke(s, x, y, R) {
  const a = s.pts, n = a.length / 3, T = R + s.size / 2;
  if (n === 1) return Math.hypot(a[0] - x, a[1] - y) < T;
  for (let i = 3; i < a.length; i += 3) {
    if (segDist(x, y, a[i - 3], a[i - 2], a[i], a[i + 1]) < T) return true;
  }
  return false;
}

// 精準擦除：把被擦到的點拿掉，剩下的連續段落各自成為新筆畫。沒擦到則回傳 null。
function splitStroke(s, x, y, R) {
  const a = s.pts, T = R + s.size / 2;
  const runs = [];
  let cur = [], changed = false;
  for (let i = 0; i < a.length; i += 3) {
    const px = a[i], py = a[i + 1];
    if (Math.hypot(px - x, py - y) < T) {
      changed = true;
      if (cur.length) runs.push(cur);
      cur = [];
      continue;
    }
    if (cur.length && segDist(x, y, a[i - 3], a[i - 2], px, py) < T) {
      changed = true;
      runs.push(cur);
      cur = [];
    }
    cur.push(px, py, a[i + 2]);
  }
  if (!changed) return null;
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 6).map((r) => {
    const o = { ...s, id: uid(), pts: new Float32Array(r) };
    o.bb = strokeBBox(o);
    return o;
  });
}

/* ---------- 套索與選取 ---------- */

function startLasso(a, e) {
  a.kind = 'lasso';
  a.poly = [unitX(a, e), unitY(a, e)];
  liveBegin(a);
}

function moveLasso(a, list) {
  for (const e of list) a.poly.push(unitX(a, e), unitY(a, e));
  const x = E.lctx, p = a.poly, S = E.S;
  liveClear();
  x.beginPath();
  x.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]);
  x.fillStyle = 'rgba(52,120,246,.07)';
  x.fill();
  x.strokeStyle = '#3478f6';
  x.lineWidth = 1.6 / S;
  x.setLineDash([6 / S, 5 / S]);
  x.stroke();
  x.setLineDash([]);
}

function endLasso(a, e) {
  liveEnd();
  if (a.moved < 6) return handleTap(a.pm, a.target, e.clientX, e.clientY, a.hadSel);
  const poly = a.poly, page = a.pm.page;
  const strokes = page.strokes.filter((s) => {
    const p = s.pts, n = p.length / 3, step = Math.max(1, Math.floor(n / 40));
    let inside = 0, total = 0;
    for (let i = 0; i < n; i += step) {
      total++;
      if (inPoly(poly, p[i * 3], p[i * 3 + 1])) inside++;
    }
    return inside / total >= 0.5;
  });
  const items = page.items.filter((it) => it.type === 'img' && inPoly(poly, it.x + it.w / 2, it.y + it.h / 2));
  makeSelection(a.pm, strokes, items);
}

function inPoly(p, x, y) {
  let c = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if ((p[i + 1] > y) !== (p[j + 1] > y) && x < ((p[j] - p[i]) * (y - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c;
  }
  return c;
}

function makeSelection(pm, strokes, items) {
  if (!strokes.length && !items.length) return;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (x0, y0, x1, y1) => {
    bb[0] = Math.min(bb[0], x0);
    bb[1] = Math.min(bb[1], y0);
    bb[2] = Math.max(bb[2], x1);
    bb[3] = Math.max(bb[3], y1);
  };
  strokes.forEach((s) => grow(...s.bb));
  items.forEach((it) => grow(it.x, it.y, it.x + it.w, it.y + it.h));
  bb[0] -= 5;
  bb[1] -= 5;
  bb[2] += 5;
  bb[3] += 5;
  const page = pm.page;
  const canvas = h('canvas');
  const el = h('div', {
    class: 'sel',
    style: {
      left: (bb[0] / page.w) * 100 + '%', top: (bb[1] / page.h) * 100 + '%',
      width: ((bb[2] - bb[0]) / page.w) * 100 + '%', height: ((bb[3] - bb[1]) / page.h) * 100 + '%',
    },
  }, canvas, h('div', { class: 'sel-h' }));
  el.addEventListener('pointerdown', selPointerDown);
  E.sel = { pm, strokes, items, ids: new Set([...strokes, ...items].map((o) => o.id)), bb, tx: 0, ty: 0, sc: 1, el, canvas };
  drawSel();
  pm.el.append(el);
  invalidate(pm);
  E.selbar.classList.add('show');
}

function drawSel() {
  const s = E.sel, bb = s.bb;
  const bw = bb[2] - bb[0], bh = bb[3] - bb[1];
  const sc = Math.min(E.S * dpr() * Math.min(s.sc, 2), Math.sqrt(3e6 / (bw * bh)));
  s.canvas.width = Math.max(1, Math.round(bw * sc));
  s.canvas.height = Math.max(1, Math.round(bh * sc));
  const ctx = s.canvas.getContext('2d');
  ctx.setTransform(sc, 0, 0, sc, -bb[0] * sc, -bb[1] * sc);
  const dark = isDarkPage(s.pm.page);
  s.items.forEach((it) => drawImageItem(ctx, it));
  s.strokes.forEach((st) => drawStroke(ctx, st, dark));
}

function placeSel() {
  const s = E.sel;
  const bw = s.bb[2] - s.bb[0], bh = s.bb[3] - s.bb[1];
  s.el.style.transform = `translate(${(s.tx / bw) * 100}%,${(s.ty / bh) * 100}%) scale(${s.sc})`;
}

function selPointerDown(e) {
  const s = E.sel;
  if (!s || E.pinch) return;
  e.stopPropagation();
  e.preventDefault();
  const el = s.el, id = e.pointerId, S = E.S;
  el.setPointerCapture(id);
  const scaling = e.target.classList.contains('sel-h');
  const r = s.pm.el.getBoundingClientRect();
  const st = { x: e.clientX, y: e.clientY, tx: s.tx, ty: s.ty, sc: s.sc };
  const ox = r.left + (s.bb[0] + s.tx) * S, oy = r.top + (s.bb[1] + s.ty) * S;
  const d0 = Math.hypot(e.clientX - ox, e.clientY - oy) || 1;
  const minSc = 10 / Math.max(s.bb[2] - s.bb[0], s.bb[3] - s.bb[1]);
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    if (scaling) s.sc = clamp((st.sc * Math.hypot(ev.clientX - ox, ev.clientY - oy)) / d0, minSc, 12);
    else {
      s.tx = st.tx + (ev.clientX - st.x) / S;
      s.ty = st.ty + (ev.clientY - st.y) / S;
    }
    placeSel();
  };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function xfStroke(s, sel) {
  const { bb, tx, ty, sc } = sel;
  if (!tx && !ty && sc === 1) return s;
  const p = new Float32Array(s.pts.length);
  for (let i = 0; i < p.length; i += 3) {
    p[i] = bb[0] + (s.pts[i] - bb[0]) * sc + tx;
    p[i + 1] = bb[1] + (s.pts[i + 1] - bb[1]) * sc + ty;
    p[i + 2] = s.pts[i + 2];
  }
  const o = { ...s, id: uid(), pts: p, size: s.size * sc };
  o.bb = strokeBBox(o);
  return o;
}

function xfItem(it, sel) {
  const { bb, tx, ty, sc } = sel;
  if (!tx && !ty && sc === 1) return it;
  return { ...it, id: uid(), x: bb[0] + (it.x - bb[0]) * sc + tx, y: bb[1] + (it.y - bb[1]) * sc + ty, w: it.w * sc, h: it.h * sc };
}

function dropSel() {
  const s = E.sel;
  if (!s) return;
  E.sel = null;
  s.el.remove();
  releaseCanvas(s.canvas);
  E.selbar.classList.remove('show');
  invalidate(s.pm);
}

// 把選取範圍的移動 / 縮放（以及額外的 fn 修改）寫回頁面
function applySel(fnS, keep) {
  const s = E.sel;
  if (!s) return;
  const pm = s.pm, p = pm.page, ns = [], ni = [];
  let changed = false;
  const strokes = p.strokes.map((x) => {
    if (!s.ids.has(x.id)) return x;
    let y = xfStroke(x, s);
    if (fnS) y = fnS(y);
    if (y !== x) changed = true;
    ns.push(y);
    return y;
  });
  const items = p.items.map((x) => {
    if (!s.ids.has(x.id)) return x;
    const y = xfItem(x, s);
    if (y !== x) changed = true;
    ni.push(y);
    return y;
  });
  dropSel();
  if (changed) commit(p, strokes, items);
  if (keep) makeSelection(pm, ns, ni);
}

function commitSelection() {
  if (E?.sel) applySel(null, false);
}

function deleteSel() {
  const s = E.sel;
  if (!s) return;
  const p = s.pm.page;
  dropSel();
  commit(p, p.strokes.filter((x) => !s.ids.has(x.id)), p.items.filter((x) => !s.ids.has(x.id)));
}

function copySel() {
  const s = E.sel;
  if (!s) return;
  E.clip = { strokes: s.strokes.map((x) => xfStroke(x, s)), items: s.items.map((x) => xfItem(x, s)) };
  toast('已拷貝');
}

const shift = { bb: [0, 0, 0, 0], sc: 1 };
const moved = (o, dx, dy, fn) => {
  const r = fn(o, { ...shift, tx: dx, ty: dy });
  return r === o ? { ...o, id: uid() } : r;
};

function insertObjects(pm, strokes, items) {
  const p = pm.page;
  commit(p, strokes.length ? p.strokes.concat(strokes) : null, items.length ? p.items.concat(items) : null);
  makeSelection(pm, strokes, items);
}

function dupSel() {
  if (!E.sel) return;
  applySel(null, true);
  const s = E.sel, pm = s.pm;
  const strokes = s.strokes.map((x) => moved(x, 14, 14, xfStroke));
  const items = s.items.map((x) => moved(x, 14, 14, xfItem));
  dropSel();
  insertObjects(pm, strokes, items);
}

function pasteAt(pm, x, y) {
  const c = E.clip;
  if (!c) return;
  commitSelection();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of [...c.strokes.map((s) => s.bb), ...c.items.map((i) => [i.x, i.y, i.x + i.w, i.y + i.h])]) {
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  const page = pm.page;
  const dx = clamp(x - (x0 + x1) / 2, -x0, Math.max(-x0, page.w - x1));
  const dy = clamp(y - (y0 + y1) / 2, -y0, Math.max(-y0, page.h - y1));
  insertObjects(pm, c.strokes.map((s) => moved(s, dx, dy, xfStroke)), c.items.map((i) => moved(i, dx, dy, xfItem)));
}

function colorSel(anchor) {
  if (!E.sel) return;
  const close = popover(anchor, palette(COLORS, '', (c) => {
    close();
    applySel((s) => ({ ...s, id: uid(), color: c }), true);
  }));
}

function buildSelBar() {
  const b = (label, fn, cls = '') => h('button', { class: 'sb ' + cls, onclick: fn }, label);
  return h('div', { class: 'selbar' },
    b('拷貝', copySel),
    b('剪下', () => {
      copySel();
      deleteSel();
    }),
    b('再製', dupSel),
    b('顏色', (e) => colorSel(e.currentTarget)),
    b('刪除', deleteSel, 'danger'),
    b('完成', commitSelection, 'primary'));
}

// 點一下（不拖曳）時的行為
function handleTap(pm, target, cx, cy, hadSel) {
  const tool = E.set.tool;
  if (tool === 'text') {
    if (!pm || !pm.mounted) return;
    const tb = target?.closest?.('.tb');
    const it = tb?.dataset.id && pm.page.items.find((i) => i.id === tb.dataset.id);
    if (it) return startEdit(pm, it);
    const r = pm.el.getBoundingClientRect();
    const fs = E.set.text.sizes[E.set.text.si];
    startEdit(pm, null, (cx - r.left) / E.S - TEXT_PAD, (cy - r.top) / E.S - TEXT_PAD - (fs * LINE_H) / 2);
    return;
  }
  if (E.sel) return commitSelection();
  if (tool !== 'lasso' || hadSel || !pm || !pm.mounted) return;
  const r = pm.el.getBoundingClientRect();
  const x = (cx - r.left) / E.S, y = (cy - r.top) / E.S;
  const it = [...pm.page.items].reverse().find((i) => i.type === 'img' && x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h);
  if (it) return makeSelection(pm, [], [it]);
  if (E.clip) menu({ left: cx, top: cy, width: 0, height: 0 }, [{ label: '貼上', onClick: () => E && pasteAt(pm, x, y) }]);
}

/* ---------- 文字方塊（以 DOM 呈現，放大也清晰；匯出時才畫進畫布） ---------- */

function styleTb(tb, it, page) {
  tb.style.left = (it.x / page.w) * 100 + '%';
  tb.style.top = (it.y / page.h) * 100 + '%';
  tb.style.maxWidth = ((page.w - it.x) / page.w) * 100 + '%';
  tb.style.color = it.color;
  tb.style.setProperty('--fs', it.fs);
}

function syncTexts(pm) {
  if (!pm.mounted) return;
  const ed = E.editing?.pm === pm ? E.editing : null;
  const nodes = pm.page.items.filter((it) => it.type === 'text' && it.id !== ed?.id).map((it) => {
    const tb = h('div', { class: 'tb' });
    tb.dataset.id = it.id;
    tb.textContent = it.text;
    styleTb(tb, it, pm.page);
    return tb;
  });
  pm.texts.replaceChildren(...nodes, ...(ed ? [ed.tb, ed.tools] : []));
}

function startEdit(pm, it, x, y) {
  finishEdit();
  const page = pm.page, set = E.set;
  const ed = it
    ? { pm, id: it.id, x: it.x, y: it.y, color: it.color, fs: it.fs }
    : { pm, id: null, x: clamp(x, 0, page.w - 60), y: clamp(y, 0, page.h - 20), color: set.pen.colors[set.pen.ci], fs: set.text.sizes[set.text.si] };
  let tb = it && pm.texts.querySelector(`.tb[data-id="${it.id}"]`);
  if (!tb) pm.texts.append((tb = h('div', { class: 'tb' })));
  tb.classList.add('editing');
  tb.setAttribute('contenteditable', 'plaintext-only');
  if (tb.contentEditable !== 'plaintext-only') tb.setAttribute('contenteditable', 'true');
  tb.setAttribute('spellcheck', 'false');
  ed.tb = tb;
  const grip = h('button', { class: 'tb-btn', title: '移動', html: ic('move', 16) });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const st = { x: e.clientX, y: e.clientY, ex: ed.x, ey: ed.y };
    const move = (ev) => {
      ed.x = clamp(st.ex + (ev.clientX - st.x) / E.S, 0, page.w - 30);
      ed.y = clamp(st.ey + (ev.clientY - st.y) / E.S, 0, page.h - 15);
      placeEdit();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  const del = h('button', { class: 'tb-btn danger', title: '刪除', html: ic('trash', 16) });
  del.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tb.textContent = '';
    finishEdit();
  });
  ed.tools = h('div', { class: 'tb-tools' }, grip, del);
  pm.texts.append(ed.tools);
  E.editing = ed;
  placeEdit();
  tb.focus();
  const sel = getSelection();
  sel.selectAllChildren(tb);
  sel.collapseToEnd();
}

function placeEdit() {
  const ed = E.editing;
  styleTb(ed.tb, ed, ed.pm.page);
  ed.tools.style.left = ed.tb.style.left;
  ed.tools.style.top = ed.tb.style.top;
}

function finishEdit() {
  const ed = E?.editing;
  if (!ed) return;
  E.editing = null;
  const text = ed.tb.innerText.replace(/ /g, ' ').replace(/\s+$/, '');
  const p = ed.pm.page, before = p.items;
  let after = null;
  if (ed.id) {
    const old = before.find((i) => i.id === ed.id);
    if (!text) after = before.filter((i) => i.id !== ed.id);
    else if (old && (old.text !== text || old.x !== ed.x || old.y !== ed.y || old.color !== ed.color || old.fs !== ed.fs)) {
      after = before.map((i) => (i === old ? { ...old, text, x: ed.x, y: ed.y, color: ed.color, fs: ed.fs } : i));
    }
  } else if (text) {
    after = before.concat([{ id: uid(), type: 'text', x: ed.x, y: ed.y, text, color: ed.color, fs: ed.fs }]);
  }
  if (after) commit(p, null, after);
  ed.tb.blur();
  syncTexts(ed.pm);
}

/* ---------- 圖片 ---------- */

async function insertImage() {
  const file = await pickFile('image/*');
  if (!file || !E) return;
  try {
    const src = await createImageBitmap(file);
    const k = Math.min(1, 2200 / Math.max(src.width, src.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(src.width * k);
    cv.height = Math.round(src.height * k);
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    src.close?.();
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((res) => cv.toBlob(res, type, 0.9));
    const id = uid();
    await db.put('blobs', { id, type, buf: await blob.arrayBuffer() });
    if (!E) return;
    E.note.blobIds.push(id);
    await db.put('notes', E.note);
    images.set(id, cv);
    const pm = currentPm(), page = pm.page;
    const w = Math.min(page.w * 0.6, cv.width / 2), hgt = (w * cv.height) / cv.width;
    const vr = E.vp.getBoundingClientRect(), r = pm.el.getBoundingClientRect();
    const cx = clamp((vr.left + vr.width / 2 - r.left) / E.S, w / 2, page.w - w / 2);
    const cy = clamp((vr.top + vr.height / 2 - r.top) / E.S, hgt / 2, Math.max(hgt / 2, page.h - hgt / 2));
    setTool('lasso');
    insertObjects(pm, [], [{ id: uid(), type: 'img', blobId: id, x: cx - w / 2, y: cy - hgt / 2, w, h: hgt }]);
    toast('可拖曳移動、拉右下角縮放');
  } catch (e) {
    console.error(e);
    toast('無法插入這張圖片');
  }
}

/* ================= 工具列 ================= */

function buildBar() {
  const b = (icon, title, onclick) => h('button', { class: 'ib', title, 'aria-label': title, html: ic(icon), onclick });
  E.toolBtns = {};
  const tools = TOOLS.map(([id, icon, name]) =>
    (E.toolBtns[id] = b(icon, name, (e) => (E.set.tool === id ? toolOptions(id, e.currentTarget) : setTool(id)))));
  E.ctxEl = h('div', { class: 'ctx' });
  E.undoBtn = b('undo', '復原', undo);
  E.redoBtn = b('redo', '重做', redo);
  return h('div', { class: 'bar' },
    h('div', { class: 'bar-side' }, b('back', '返回書庫', closeEditor), b('grid', '頁面總覽', openOverview)),
    h('div', { class: 'bar-mid' },
      h('div', { class: 'tools' }, tools, b('image', '插入圖片', insertImage)),
      h('div', { class: 'bar-sep' }),
      E.ctxEl),
    h('div', { class: 'bar-side' },
      E.undoBtn, E.redoBtn,
      b('addpage', '新增頁面', (e) => addPageMenu(e.currentTarget)),
      b('more', '更多', (e) => moreMenu(e.currentTarget))));
}

function setTool(id) {
  finishEdit();
  commitSelection();
  E.set.tool = id;
  $('#editor').dataset.tool = id;
  saveSettings();
  updateBar();
}

function updateBar() {
  for (const [id, btn] of Object.entries(E.toolBtns)) btn.classList.toggle('on', id === E.set.tool);
  drawCtx();
}

function settingsChanged() {
  saveSettings();
  drawCtx();
  const ed = E.editing;
  if (ed && E.set.tool === 'text') {
    ed.color = E.set.pen.colors[E.set.pen.ci];
    ed.fs = E.set.text.sizes[E.set.text.si];
    placeEdit();
  }
}

// 工具列中段：依目前工具顯示 3 個常用顏色與 3 個常用粗細。再點一次已選取的可以修改。
function drawCtx() {
  const box = E.ctxEl, set = E.set, tool = set.tool;
  box.replaceChildren();
  const colorCfg = tool === 'hl' ? set.hl : ['pen', 'shape', 'text'].includes(tool) ? set.pen : null;
  const sizeKey = tool === 'shape' ? 'pen' : tool;
  const sizeCfg = SIZE_RANGE[sizeKey] ? set[sizeKey] : null;
  if (colorCfg) {
    colorCfg.colors.forEach((c, i) => box.append(h('button', {
      class: 'sw' + (i === colorCfg.ci ? ' on' : ''), style: { '--c': c }, 'aria-label': '顏色',
      onclick: (e) => {
        if (i !== colorCfg.ci) {
          colorCfg.ci = i;
          return settingsChanged();
        }
        const close = popover(e.currentTarget, palette(tool === 'hl' ? HL_COLORS : COLORS, c, (nc) => {
          colorCfg.colors[i] = nc;
          close();
          settingsChanged();
        }));
      },
    })));
  }
  if (colorCfg && sizeCfg) box.append(h('div', { class: 'bar-sep' }));
  if (sizeCfg) {
    sizeCfg.sizes.forEach((z, i) => {
      const inner = sizeKey === 'text'
        ? h('span', { class: 'sz-a', style: { fontSize: clamp(9 + z * 0.4, 11, 21) + 'px' } }, 'A')
        : h('span', {
          class: 'sz-dot' + (sizeKey === 'eraser' ? ' ring' : ''),
          style: { width: dotPx(sizeKey, z) + 'px', height: dotPx(sizeKey, z) + 'px' },
        });
      box.append(h('button', {
        class: 'sz' + (i === sizeCfg.si ? ' on' : ''), 'aria-label': '粗細',
        onclick: (e) => {
          if (i !== sizeCfg.si) {
            sizeCfg.si = i;
            return settingsChanged();
          }
          sizePopover(e.currentTarget, sizeKey, sizeCfg, i);
        },
      }, inner));
    });
  }
}

const dotPx = (key, z) => (key === 'pen' ? clamp(3 + z * 3.2, 4, 20) : clamp(z * 0.6, 6, 22));

function sizePopover(anchor, key, cfg, i) {
  const [min, max, step] = SIZE_RANGE[key];
  const label = h('div', { class: 'range-val' });
  const show = () => (label.textContent = (key === 'pen' ? cfg.sizes[i].toFixed(1) : cfg.sizes[i]) + (key === 'text' ? ' pt' : ' pt'));
  const input = h('input', { type: 'range', class: 'range', min, max, step, value: cfg.sizes[i] });
  input.addEventListener('input', () => {
    cfg.sizes[i] = +input.value;
    show();
  });
  show();
  popover(anchor, h('div', { class: 'range-box' }, h('div', { class: 'range-title' }, key === 'text' ? '字級' : '粗細'), input, label), { onClose: settingsChanged });
}

function toolOptions(id, anchor) {
  const set = E.set;
  const pick = (list, cur, fn) => list.map(([key, label]) => ({ label, checked: cur === key, onClick: () => { fn(key); saveSettings(); } }));
  if (id === 'pen') menu(anchor, pick(PEN_TYPES, set.pen.pen, (k) => (set.pen.pen = k)));
  else if (id === 'shape') menu(anchor, pick(SHAPES, set.shape.kind, (k) => (set.shape.kind = k)));
  else if (id === 'eraser') {
    menu(anchor, [
      ...pick([['stroke', '擦除整筆'], ['precise', '精準擦除']], set.eraser.mode, (k) => (set.eraser.mode = k)),
      '-',
      { label: '清除本頁筆跡', icon: 'trash', danger: true, onClick: clearPage },
    ]);
  } else if (id === 'hl') toast('畫完停住不放，可自動拉成直線');
  else if (id === 'lasso') toast('圈選筆跡，或點一下圖片');
  else if (id === 'text') toast('點頁面任一處開始輸入');
}

function moreMenu(anchor) {
  const pm = currentPm();
  const index = E.list.indexOf(pm);
  menu(anchor, [
    { label: '重新命名筆記本', onClick: async () => {
      const t = await promptBox('重新命名', E.note.title);
      if (!t || !E) return;
      E.note.title = t;
      db.put('notes', E.note);
    } },
    { label: '匯出 PDF', icon: 'share', onClick: async () => {
      finishEdit();
      commitSelection();
      await flush();
      exportPdf(E.note, E.list.map((x) => x.page));
    } },
    { label: '將本頁匯出為圖片', icon: 'image', onClick: () => {
      finishEdit();
      commitSelection();
      exportPng(E.note, pm.page, index);
    } },
    { label: '備份筆記本', icon: 'doc', onClick: async () => {
      finishEdit();
      commitSelection();
      await flush();
      backupNote(E.note.id);
    } },
    '-',
    pm.page.pdf ? null : { label: '更換本頁紙張', onClick: () => paperPopover(anchor, pm) },
    { label: '手指繪圖', icon: 'hand', checked: E.set.fingerDraw, onClick: () => {
      E.set.fingerDraw = !E.set.fingerDraw;
      saveSettings();
      toast(E.set.fingerDraw ? '手指繪圖已開啟（雙指捲動與縮放）' : '手指繪圖已關閉（手指捲動，筆書寫）');
    } },
    '-',
    { label: '清除本頁筆跡', onClick: clearPage },
    { label: '刪除本頁', icon: 'trash', danger: true, onClick: () => deletePage(pm) },
  ]);
}

/* ================= 頁面管理 ================= */

async function insertPage(index, page) {
  const pm = makePm(page);
  E.list.splice(index, 0, pm);
  E.pagesEl.insertBefore(pm.el, E.pagesEl.children[index] || null);
  E.io.observe(pm.el);
  await db.put('pages', page);
  await saveNote();
  return pm;
}

function addPageMenu(anchor) {
  const cur = currentPm();
  const paper = { template: E.note.paper?.template || 'lined', color: E.note.paper?.color || 'white' };
  let close;
  const picker = templatePicker(paper, async (v, what) => {
    Object.assign(paper, v);
    if (what !== 'template') return; // 選顏色只是切換預覽，點範本才新增
    close();
    E.note.paper = { ...E.note.paper, ...paper };
    const page = newPage(E.note.id, { w: cur.page.w, h: cur.page.h, ...paper });
    const pm = await insertPage(E.list.indexOf(cur) + 1, page);
    requestAnimationFrame(() => E && scrollToPage(pm, true));
  });
  close = popover(anchor, h('div', { class: 'pop-pad' }, h('div', { class: 'pop-title' }, '在本頁之後新增'), picker));
}

function paperPopover(anchor, pm) {
  const page = pm.page;
  popover(anchor, h('div', { class: 'pop-pad' }, h('div', { class: 'pop-title' }, '本頁紙張'),
    templatePicker({ template: page.template, color: page.color }, (v) => {
      page.template = v.template;
      page.color = v.color;
      pm.el.style.background = paperBg(page);
      invalidate(pm);
      markDirty(page);
    })));
}

function clearPage() {
  finishEdit();
  commitSelection();
  const pm = currentPm(), p = pm.page;
  if (!p.strokes.length && !p.items.length) return;
  commit(p, [], []);
  invalidate(pm);
  syncTexts(pm);
}

async function deletePage(pm) {
  if (!(await confirmBox('確定要刪除這一頁嗎？此動作無法復原。', '刪除', true)) || !E) return false;
  const i = E.list.indexOf(pm);
  if (i < 0) return false;
  finishEdit();
  commitSelection();
  if (E.list.length === 1) await insertPage(1, newPage(E.note.id, { w: pm.page.w, h: pm.page.h, ...E.note.paper }));
  unmount(pm);
  E.io.unobserve(pm.el);
  pm.el.remove();
  E.list.splice(E.list.indexOf(pm), 1);
  E.undo = E.undo.filter((o) => o.page !== pm.page);
  E.redo = E.redo.filter((o) => o.page !== pm.page);
  E.dirty.delete(pm.page);
  await db.del('pages', pm.page.id);
  await saveNote();
  computeFit();
  applyScale();
  updateUndo();
  updateInd();
  return true;
}

async function duplicatePage(pm) {
  const p = pm.page;
  const copy = { ...p, id: uid(), strokes: p.strokes.slice(), items: p.items.map((it) => ({ ...it, id: uid() })) };
  return insertPage(E.list.indexOf(pm) + 1, copy);
}

async function movePage(pm, dir) {
  const i = E.list.indexOf(pm), j = i + dir;
  if (j < 0 || j >= E.list.length) return;
  E.list.splice(i, 1);
  E.list.splice(j, 0, pm);
  E.pagesEl.append(...E.list.map((x) => x.el));
  await saveNote();
}

function openOverview() {
  finishEdit();
  commitSelection();
  const grid = h('div', { class: 'ov-grid' });
  const wrap = h('div', { class: 'ov' },
    h('div', { class: 'ov-head' },
      h('div', { class: 'ov-title' }, E.note.title),
      h('button', { class: 'btn primary', onclick: () => close() }, '完成')),
    grid);
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      const c = en.target;
      rasterize(c._page, 300 / c._page.w, c).catch(() => {});
    }
  }, { root: wrap, rootMargin: '200px' });
  const close = (target) => {
    io.disconnect();
    wrap.querySelectorAll('canvas').forEach(releaseCanvas);
    wrap.remove();
    if (target && E) scrollToPage(target);
    if (E) updateInd();
  };
  const fill = () => {
    io.disconnect();
    const cur = currentPm();
    grid.replaceChildren(...E.list.map((pm, i) => {
      const c = h('canvas', { width: 30, height: Math.round((30 * pm.page.h) / pm.page.w), style: { background: paperBg(pm.page) } });
      c._page = pm.page;
      io.observe(c);
      const more = h('button', { class: 'ov-more', html: ic('more', 18), onclick: (e) => {
        e.stopPropagation();
        menu(e.currentTarget, [
          { label: '複製頁面', icon: 'copy', onClick: async () => { await duplicatePage(pm); fill(); } },
          i > 0 ? { label: '往前移', onClick: async () => { await movePage(pm, -1); fill(); } } : null,
          i < E.list.length - 1 ? { label: '往後移', onClick: async () => { await movePage(pm, 1); fill(); } } : null,
          '-',
          { label: '刪除頁面', icon: 'trash', danger: true, onClick: async () => { if (await deletePage(pm)) fill(); } },
        ]);
      } });
      return h('div', { class: 'ov-cell' + (pm === cur ? ' cur' : ''), onclick: () => close(pm) },
        h('div', { class: 'ov-thumb' }, c),
        h('div', { class: 'ov-row' }, h('span', null, String(i + 1)), more));
    }));
  };
  fill();
  $('#editor').append(wrap);
  wrap.querySelector('.cur')?.scrollIntoView({ block: 'center' });
}

/* ================= 鍵盤 ================= */

function onKey(e) {
  if ($('.modal-back, .pop-back, .ov')) return;
  if (e.target.closest?.('input, textarea, [contenteditable]')) {
    if (e.key === 'Escape') finishEdit();
    return;
  }
  const mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && E.sel) {
    e.preventDefault();
    deleteSel();
  } else if (e.key === 'Escape') commitSelection();
}
