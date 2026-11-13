import { initLibrary, showLibrary, hideLibrary } from './library.js';
import { openEditor } from './editor.js';
import { toast } from './ui.js';

let opening = false;

async function openNote(id) {
  if (opening) return;
  opening = true;
  try {
    await openEditor(id, () => showLibrary());
    hideLibrary();
  } catch (e) {
    console.error(e);
    toast('無法開啟筆記本：' + e.message);
  } finally {
    opening = false;
  }
}

initLibrary(openNote);
showLibrary();

// 避免 Safari 的整頁縮放手勢與長按選單干擾書寫
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea, [contenteditable]')) e.preventDefault();
});

// 要求瀏覽器不要自動清除本機資料
navigator.storage?.persist?.().catch(() => {});

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && !local) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
