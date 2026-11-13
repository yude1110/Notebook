import { $, h, clamp } from './util.js';
import { ic } from './icons.js';

const layer = () => $('#overlays');

let toastT;
export function toast(msg) {
  let el = $('.toast');
  if (!el) layer().append((el = h('div', { class: 'toast' })));
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 1900);
}

// anchor：元素，或 { left, top, width, height } 螢幕座標
export function popover(anchor, content, opt = {}) {
  const pop = h('div', { class: 'pop ' + (opt.class || '') }, content);
  const back = h('div', { class: 'pop-back' }, pop);
  layer().append(back);
  const ar = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const bottom = ar.top + ar.height;
  const x = clamp(ar.left + ar.width / 2 - pw / 2, 8, Math.max(8, innerWidth - pw - 8));
  let y = bottom + 8;
  if (y + ph > innerHeight - 8) y = Math.max(8, ar.top - ph - 8);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  pop.style.transformOrigin = `${ar.left + ar.width / 2 - x}px ${y > ar.top ? 0 : ph}px`;
  requestAnimationFrame(() => pop.classList.add('show'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    opt.onClose?.();
  };
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) {
      e.preventDefault();
      close();
    }
  });
  return close;
}

// items: [{ label, icon, danger, checked, onClick }] 或 '-' 分隔線
export function menu(anchor, items) {
  let close;
  const list = h('div', { class: 'menu' }, items.map((it) => {
    if (it === '-') return h('div', { class: 'menu-sep' });
    if (!it) return null;
    return h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : ''),
      onclick: () => {
        close();
        it.onClick?.();
      },
    },
      h('span', { class: 'menu-label' }, it.label),
      it.checked ? h('span', { class: 'menu-ic', html: ic('check', 18) }) : it.icon ? h('span', { class: 'menu-ic', html: ic(it.icon, 18) }) : null);
  }));
  close = popover(anchor, list);
  return close;
}

export function sheet(title, body, actions = [], opt = {}) {
  const box = h('div', { class: 'modal ' + (opt.class || '') },
    title && h('div', { class: 'modal-title' }, title),
    body,
    actions.length ? h('div', { class: 'modal-actions' }, actions) : null);
  const back = h('div', { class: 'modal-back' }, box);
  layer().append(back);
  requestAnimationFrame(() => back.classList.add('show'));
  const close = () => {
    back.classList.remove('show');
    setTimeout(() => back.remove(), 200);
    opt.onClose?.();
  };
  if (!opt.sticky) back.addEventListener('pointerdown', (e) => e.target === back && close());
  return { close, el: box };
}

export function promptBox(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const input = h('input', { class: 'field', type: 'text', value, placeholder, maxlength: 80 });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      s.close();
      resolve(v);
    };
    const s = sheet(title, input, [
      h('button', { class: 'btn', onclick: () => finish(null) }, '取消'),
      h('button', { class: 'btn primary', onclick: () => finish(input.value.trim() || null) }, '確定'),
    ], { onClose: () => finish(null) });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && finish(input.value.trim() || null));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 60);
  });
}

export function confirmBox(message, okLabel = '確定', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      s.close();
      resolve(v);
    };
    const s = sheet(null, h('div', { class: 'modal-msg' }, message), [
      h('button', { class: 'btn', onclick: () => finish(false) }, '取消'),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, okLabel),
    ], { onClose: () => finish(false) });
  });
}

export function busy(text) {
  const label = h('div', { class: 'busy-text' }, text);
  const back = h('div', { class: 'modal-back show busy' }, h('div', { class: 'busy-box' }, h('div', { class: 'spinner' }), label));
  layer().append(back);
  return {
    set: (t) => (label.textContent = t),
    close: () => back.remove(),
  };
}
