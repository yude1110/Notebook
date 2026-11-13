const P = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  pen: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1zM14.5 6.5l3 3"/>',
  hl: '<path d="M8.5 13.5L16 5l4 3.5-7.5 8.5M8.5 13.5l4 3.5M8.5 13.5L7 17l2.5 2 3-2M3 21h18"/>',
  eraser: '<path d="M4.5 15.5l8.6-9.6a2 2 0 012.9-.1l3.9 3.9a2 2 0 010 2.8L13 19.5H8.5l-4-4zM9 10l6 6M8 20h12"/>',
  shape: '<path d="M3 3h10v10H3zM21 16a5 5 0 11-10 0 5 5 0 0110 0z"/>',
  lasso: '<ellipse cx="12" cy="10" rx="8.5" ry="6" stroke-dasharray="3 2.6"/><path d="M7.5 15.5c-1.2 1.8-.6 4 1.8 5"/>',
  text: '<path d="M5 7V4.5h14V7M12 4.5v15M9 19.5h6"/>',
  image: '<path d="M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4"/><circle cx="8.5" cy="9" r="1.2"/>',
  undo: '<path d="M8 5L3 10l5 5M3 10h11a5 5 0 010 10h-4"/>',
  redo: '<path d="M16 5l5 5-5 5M21 10H10a5 5 0 000 10h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  addpage: '<path d="M6 3h8l4 4v14H6zM12 10v6M9 13h6"/>',
  more: '<circle cx="5" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  copy: '<path d="M8 8h11v12H8zM5 16V4h10"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  search: '<path d="M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20"/>',
  doc: '<path d="M6 3h8l4 4v14H6zM14 3v4h4"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 12v8h14v-8"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  hand: '<path d="M9 11V5a1.5 1.5 0 013 0v5M12 10V4a1.5 1.5 0 013 0v6M15 10V6a1.5 1.5 0 013 0v8a7 7 0 01-7 7h-.5a6 6 0 01-5-2.6L4 15a1.6 1.6 0 012.6-1.8L9 15v-4"/>',
};

export function ic(name, size = 22) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
