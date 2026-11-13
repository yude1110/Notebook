# 墨記 — 個人手寫筆記 PWA（iPad / Apple Pencil）

純前端、無需建置的手寫筆記 App。所有筆記都存在裝置本機（IndexedDB），不會上傳到任何伺服器。

## 功能

- **書寫**：原子筆 / 鋼筆 / 毛筆（支援 Apple Pencil 壓感）、螢光筆、3 組常用顏色與粗細
- **橡皮擦**：擦除整筆 / 精準擦除、清除整頁
- **圖形**：直線、箭頭、矩形、橢圓、三角形；用筆畫完「停住不放」會自動修成直線 / 圓 / 矩形
- **套索**：圈選後可移動、縮放、拷貝、剪下、再製、改色、刪除、貼上
- **文字方塊、插入圖片**
- **頁面**：橫線 / 方格 / 點陣 / 康乃爾 / 空白 × 白 / 米黃 / 深色；新增、複製、排序、刪除、頁面總覽
- **PDF**：匯入 PDF 並在上面註記；匯出 PDF、單頁匯出 PNG
- **書庫**：搜尋、最愛、封面顏色、重新命名、製作副本
- **備份 / 還原**：單一 `.inkpad.json` 檔
- **復原 / 重做**、自動儲存、離線可用、淺色 / 深色模式

## 操作方式

| 動作 | 手勢 |
| --- | --- |
| 書寫 | Apple Pencil（手指不會畫到） |
| 捲動 | 單指滑動 |
| 縮放 | 雙指捏合；手指點兩下在「符合寬度 / 放大」間切換 |
| 工具選項 | 再點一次已選取的工具（筆種、圖形種類、橡皮擦模式） |
| 換顏色 / 粗細 | 再點一次已選取的色票或粗細 |
| 沒有 Pencil | 右上「⋯」→ 開啟「手指繪圖」（改為雙指捲動） |

接鍵盤時：`⌘Z` 復原、`⇧⌘Z` 重做、`Delete` 刪除選取。

## 部署到 iPad

PWA 必須透過 **HTTPS** 開啟才能離線使用與加到主畫面。以下擇一：

### 方式 A：GitHub Pages（免費，推薦）

1. 到 GitHub 建立一個新的 repository（例如 `notes`）。公開 repo 可免費使用 Pages。
2. 在這個資料夾執行：
   ```bash
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<你的帳號>/notes.git
   git push -u origin main
   ```
3. 到 repo 的 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main` / `(root)`，按 Save。
4. 約 1 分鐘後網址為 `https://<你的帳號>.github.io/notes/`。

### 方式 B：Cloudflare Pages / Netlify（不需 git）

- Netlify：登入後到 <https://app.netlify.com/drop>，把整個資料夾拖進去即可取得 HTTPS 網址。
- Cloudflare Pages：Workers & Pages → Create → Pages → Upload assets，上傳整個資料夾。

### 安裝到 iPad

1. 在 iPad 用 **Safari** 開啟上面的網址。
2. 點 **分享** 按鈕 → **加入主畫面** → 加入。
3. 從主畫面的「墨記」圖示開啟（全螢幕、可離線）。
4. 建議到 **設定 → Apple Pencil** 關閉「隨手寫」，避免影響書寫。

> 一定要從主畫面圖示開啟：主畫面版本與 Safari 分頁的資料是分開存放的，
> 而且 Safari 分頁中超過 7 天未使用的網站資料可能被系統清除，主畫面 App 不受此限制。

### 更新版本

修改檔案後重新上傳 / `git push`，並把 `sw.js` 裡的 `CACHE = 'inkpad-v1'` 版號加一。
iPad 上重新開啟 App 兩次即會換成新版（第一次在背景下載，第二次生效）。

## 本機預覽

```bash
npx serve .        # 或 python -m http.server 8000
```

## 備份提醒

筆記只存在這台 iPad 上。**刪除主畫面圖示或清除網站資料會一併刪掉所有筆記**，
重要筆記請定期用「⋯ → 備份筆記本」存到「檔案」或 iCloud Drive。

## 與 GoodNotes 的差異（網頁技術的限制）

- 沒有手寫辨識 / 手寫搜尋、錄音、資料夾、iCloud 同步
- 匯出的 PDF 是影像（不可選取文字）
- 無法使用 Apple Pencil 的「點兩下切換工具」與懸浮預覽
- 書寫延遲略高於原生 PencilKit App

## 結構

```
index.html  manifest.webmanifest  sw.js
css/style.css
js/   main · library · editor · render · exporter · pdfio · db · ui · widgets · icons · util
vendor/pdfjs/   PDF.js 4.10（讀取 PDF 用）
icons/
```
