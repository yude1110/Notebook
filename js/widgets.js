// 共用小元件：紙張樣式選擇器、調色盤
import { h } from './util.js';
import { PAPERS, TEMPLATES, drawTemplate } from './render.js';

export const COLORS = [
  '#1c1c1e', '#636366', '#a1a1a6', '#ffffff', '#e5484d', '#ff9500', '#f5c400', '#30a46c',
  '#00a2c7', '#3478f6', '#5e5ce6', '#bf5af2', '#ff6fae', '#a2845e', '#0b3d91', '#7a1f1f',
];
export const HL_COLORS = ['#ffe04a', '#ffb340', '#8ee88a', '#6fd3ff', '#ff9ecd', '#c9adff', '#ff8a80', '#b4f0e0'];

// value: { template, color }；每次點選都會呼叫 onChange(value)
export function templatePicker(value, onChange) {
  const v = { ...value };
  const root = h('div', { class: 'tpick' });
  const draw = () => {
    root.replaceChildren(
      h('div', { class: 'tpick-colors' }, Object.entries(PAPERS).map(([key, p]) =>
        h('button', {
          class: 'chip' + (v.color === key ? ' on' : ''),
          onclick: () => {
            v.color = key;
            draw();
            onChange({ ...v }, 'color');
          },
        }, h('span', { class: 'chip-dot', style: { background: p.bg } }), p.name))),
      h('div', { class: 'tpick-tiles' }, TEMPLATES.map(([key, name]) => {
        const c = h('canvas', { width: 120, height: 170 });
        const ctx = c.getContext('2d');
        ctx.scale(0.8, 0.8);
        drawTemplate(ctx, { w: 150, h: 212.5, template: key, color: v.color });
        return h('button', {
          class: 'tile' + (v.template === key ? ' on' : ''),
          onclick: () => {
            v.template = key;
            draw();
            onChange({ ...v }, 'template');
          },
        }, c, h('span', null, name));
      })));
  };
  draw();
  return root;
}

export function palette(colors, current, onPick) {
  const custom = h('input', { type: 'color', class: 'pal-custom', value: /^#[0-9a-f]{6}$/i.test(current) ? current : '#000000' });
  custom.addEventListener('change', () => onPick(custom.value));
  return h('div', { class: 'pal' },
    colors.map((c) => h('button', {
      class: 'pal-c' + (c.toLowerCase() === String(current).toLowerCase() ? ' on' : ''),
      style: { '--c': c },
      onclick: () => onPick(c),
    })),
    h('label', { class: 'pal-c pal-more', title: '自訂顏色' }, custom));
}
