// 書庫畫面：筆記本列表、搜尋、新增 / 匯入
import { $, h, pickFile, fmtDate } from './util.js';
import { ic } from './icons.js';
import { db } from './db.js';
import { menu, sheet, promptBox, confirmBox, toast } from './ui.js';
import { templatePicker } from './widgets.js';
import { PAPERS } from './render.js';
import { createNote, importPdf, duplicateNote, backupNote, restoreBackup, exportPdf } from './exporter.js';

const COVERS = ['#3478f6', '#5e5ce6', '#bf5af2', '#e5484d', '#ff9500', '#30a46c', '#00a2c7', '#48484a'];
const state = { q: '', fav: false, open: null };
let root, grid;

export function initLibrary(openNote) {
  state.open = openNote;
  root = $('#library');
  const search = h('input', { class: 'search', type: 'search', placeholder: '搜尋筆記本', oninput: (e) => { state.q = e.target.value.trim().toLowerCase(); refresh(); } });
  const seg = h('div', { class: 'seg' },
    h('button', { class: 'on', onclick: (e) => setFav(false, e.currentTarget) }, '全部'),
    h('button', { onclick: (e) => setFav(true, e.currentTarget) }, '最愛'));
  const setFav = (v, btn) => {
    state.fav = v;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    refresh();
  };
  grid = h('div', { class: 'lib-grid' });
  root.append(
    h('header', { class: 'lib-head' },
      h('h1', null, '筆記本'),
      h('div', { class: 'lib-tools' },
        h('label', { class: 'search-wrap' }, h('span', { html: ic('search', 17) }), search),
        h('button', { class: 'btn primary add', onclick: (e) => addMenu(e.currentTarget) }, h('span', { html: ic('plus', 18) }), '新增'))),
    seg,
    grid);
}

export async function showLibrary() {
  root.hidden = false;
  await refresh();
}

export function hideLibrary() {
  root.hidden = true;
}

async function refresh() {
  let notes = await db.all('notes');
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.fav) notes = notes.filter((n) => n.fav);
  if (state.q) notes = notes.filter((n) => n.title.toLowerCase().includes(state.q));
  const cards = notes.map(card);
  if (!state.q && !state.fav) {
    cards.unshift(h('button', { class: 'card new', onclick: () => newNoteSheet() },
      h('div', { class: 'cover new-cover', html: ic('plus', 34) }),
      h('div', { class: 'card-title' }, '新增筆記本'),
      h('div', { class: 'card-sub' }, ' ')));
  }
  grid.replaceChildren(...cards);
  if (!cards.length) grid.append(h('div', { class: 'empty' }, state.q ? '找不到符合的筆記本' : '還沒有加星號的筆記本'));
}

function card(note) {
  const paper = PAPERS[note.paper?.color] || PAPERS.white;
  const cover = h('div', { class: 'cover' + (note.paper?.landscape ? ' land' : ''), style: { '--spine': note.cover, background: paper.bg } },
    note.thumb ? h('img', { src: note.thumb, alt: '', draggable: 'false' }) : null,
    note.fav ? h('span', { class: 'fav', html: ic('star', 15) }) : null);
  const more = h('button', { class: 'card-more', html: ic('more', 18), onclick: (e) => { e.stopPropagation(); noteMenu(note, e.currentTarget); } });
  const el = h('div', { class: 'card', role: 'button', tabindex: 0, onclick: () => state.open(note.id) },
    cover,
    h('div', { class: 'card-row' }, h('div', { class: 'card-title' }, note.title), more),
    h('div', { class: 'card-sub' }, `${fmtDate(note.updatedAt)} · ${note.pageIds.length} 頁`));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    noteMenu(note, more);
  });
  return el;
}

function noteMenu(note, anchor) {
  menu(anchor, [
    { label: '重新命名', onClick: async () => {
      const t = await promptBox('重新命名', note.title);
      if (!t) return;
      note.title = t;
      await db.put('notes', note);
      refresh();
    } },
    { label: note.fav ? '取消最愛' : '加入最愛', icon: 'star', onClick: async () => {
      note.fav = !note.fav;
      await db.put('notes', note);
      refresh();
    } },
    { label: '製作副本', icon: 'copy', onClick: async () => {
      await duplicateNote(note.id);
      refresh();
    } },
    '-',
    { label: '匯出 PDF', icon: 'share', onClick: async () => {
      const pages = await db.pagesOf(note.id);
      const byId = new Map(pages.map((p) => [p.id, p]));
      exportPdf(note, note.pageIds.map((id) => byId.get(id)).filter(Boolean));
    } },
    { label: '備份筆記本', icon: 'doc', onClick: () => backupNote(note.id) },
    '-',
    { label: '刪除', icon: 'trash', danger: true, onClick: async () => {
      if (!(await confirmBox(`確定要刪除「${note.title}」嗎？此動作無法復原。`, '刪除', true))) return;
      await db.deleteNote(note.id);
      refresh();
    } },
  ]);
}

function addMenu(anchor) {
  menu(anchor, [
    { label: '新增筆記本', icon: 'plus', onClick: () => newNoteSheet() },
    { label: '匯入 PDF', icon: 'doc', onClick: async () => {
      const f = await pickFile('application/pdf,.pdf');
      if (!f) return;
      try {
        const note = await importPdf(f);
        state.open(note.id);
      } catch (e) {
        toast('無法匯入：' + e.message);
      }
    } },
    { label: '還原備份檔', icon: 'share', onClick: async () => {
      const f = await pickFile('.json,application/json');
      if (!f) return;
      try {
        await restoreBackup(f);
        toast('已還原');
        refresh();
      } catch (e) {
        toast('無法還原：' + e.message);
      }
    } },
  ]);
}

function newNoteSheet() {
  const v = { cover: COVERS[0], template: 'lined', color: 'white', landscape: false };
  const title = h('input', { class: 'field', type: 'text', placeholder: '未命名筆記本', maxlength: 80 });
  const covers = h('div', { class: 'cover-row' });
  const drawCovers = () => covers.replaceChildren(...COVERS.map((c) =>
    h('button', { class: 'pal-c' + (v.cover === c ? ' on' : ''), style: { '--c': c }, onclick: () => { v.cover = c; drawCovers(); } })));
  drawCovers();
  const orient = h('div', { class: 'seg small' });
  const drawOrient = () => orient.replaceChildren(
    h('button', { class: v.landscape ? '' : 'on', onclick: () => { v.landscape = false; drawOrient(); } }, '直向'),
    h('button', { class: v.landscape ? 'on' : '', onclick: () => { v.landscape = true; drawOrient(); } }, '橫向'));
  drawOrient();
  const create = async () => {
    s.close();
    const note = await createNote({ title: title.value.trim() || '未命名筆記本', ...v });
    state.open(note.id);
  };
  const s = sheet('新增筆記本', h('div', { class: 'form' },
    title,
    h('div', { class: 'form-label' }, '封面顏色'), covers,
    h('div', { class: 'form-label' }, '方向'), orient,
    h('div', { class: 'form-label' }, '紙張'),
    templatePicker(v, (nv) => Object.assign(v, nv))), [
    h('button', { class: 'btn', onclick: () => s.close() }, '取消'),
    h('button', { class: 'btn primary', onclick: create }, '建立'),
  ], { class: 'wide' });
  title.addEventListener('keydown', (e) => e.key === 'Enter' && create());
}
