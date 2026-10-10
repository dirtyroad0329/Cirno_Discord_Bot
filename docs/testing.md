# webGui 驗證紀錄

日期：2026-10-10。Bot 基準為 `0680603a46e49e1be27cc50b05b6976a340fe9ad`；相容性驗證使用未修改的 `music_server` 基準 `42958ed99367be07cebc4c3e05c45c10f1e05289`。測試使用暫存資料庫、合成音檔與測試帳號，沒有讀取正式 Bot 金鑰、登入正式 Discord 或修改正式音樂資料。

## 已執行結果

| 驗證 | 結果 | 範圍 |
| --- | --- | --- |
| Bot 型別、架構、建置、單元／回歸測試 | 121 通過、0 失敗 | 原有 96 項，加上 25 項播放器控制、載入期限、取消及生命週期測試 |
| 實際移除 `web/` 的隔離 Bot checkout | 121 通過、0 失敗 | Node 22.12.0；獨立安裝、型別、架構、測試與 production-only logger 檢查 |
| 網站單元測試 | 54 通過、0 失敗／取消／跳過 | Node 22.12.0；認證 14、前端狀態 13、設定 3、啟停／監督 8、API／SSE 16 |
| 網站真實服務整合 | 20 通過、0 失敗／取消／跳過 | Node 22.12.0；既有 Server Fastify／Prisma／SQLite、網站認證及 HTTP、實際 Nginx |
| 正式建置瀏覽器流程 | 7 通過、0 失敗／取消／跳過 | Node 22.12.0、Linux Chromium 151；包含 1 個父測試與 6 個流程子測試 |
| Bot 與既有 Server 清單契約 | 通過 | 實際 HTTP／SQLite、混合收藏 CRUD、歸屬隔離、獨立客戶端競爭及保存 |
| 原有 Server 全套測試 | 42 通過、0 失敗 | Node 24；既有型別、架構與建置檢查通過，Server tracked files 沒有變更 |
| 網站正式依賴安裝與編譯後認證 | 通過 | npm 12 正式依賴安裝、Node 22.12.0；網頁註冊、直接登入、4 字元改密碼及實際舊 v2 資料庫升級 |

Bot 完整回歸也在 Node 24.19.0 通過。網站服務端型別、Vue 型別及兩端正式建置通過。以下測試數包含 Node test runner 計入的父／子測試，不能視為真實 Discord 語音驗收數。

網站 Nginx 範例在 Nginx 1.30 容器中，以暫存自簽憑證及 `http` 外框通過 `nginx -t`；systemd 範例以替換測試主機路徑的副本通過語法檢查。這些是範例設定驗證，沒有安裝到正式主機。

## 重要行為與資料驗證

- 公開網頁註冊僅接受 Discord ID，不接受密碼或額外欄位；數字型別、格式錯誤、跨來源、重複及並行註冊都有測試。成功註冊不自動登入、不傳回密碼，重複註冊不重設既有密碼或工作階段；註冊限流使用獨立且有上限的計數器。
- 登入直接取得完整 session，沒有首次改密碼步驟。自願修改的新密碼接受至少 4 個 ASCII 英文字母或數字，純英文、純數字與相同密碼均可；未達長度、符號、空白、中文與換行會被拒絕。既有含符號或空白的密碼仍可登入及用於目前密碼驗證。
- 自願改密碼後撤銷全部舊 session 並要求重新登入。Cookie、Origin、CSRF、到期、閒置、停用／啟用及重設都受測試。
- 密碼雜湊與 SQLite 使用真實實作。兩個獨立 DB 連線及 CLI／登入競爭驗證版本檢查，避免改密碼或停用期間用舊密碼產生有效 session。
- Web 認證重啟後仍可保存；migration 保留原資料，WAL 一致性備份可還原，備份檔權限為 `0600`。新增 v3 migration 只取消首次改密碼旗標並升級受限 session，保留原有到期時間、撤銷紀錄、密碼雜湊、憑證版本與停用狀態。正式依賴安裝另以實際舊 v2 資料庫驗證升級及舊密碼登入，並驗證編譯後網頁註冊、直接登入、改密碼及重複註冊保存。
- 網站、原有 Bot 清單客戶端與兩個獨立 Server 實例使用同一暫存曲庫，競爭寫入只允許一方成功，另一方得到 `409`；不留下部分排序。原有本地／不同遠端曲庫收藏及重複收藏保持保存，未修改任何歌曲紀錄。
- 音訊經既有 Server Nginx 傳送，核對實際內容及 SHA-256，驗證 GET／HEAD、`206`、suffix range、If-Range、`304`、`416`、拒絕多段 Range、逾時、限量、登出、客戶端斷線及網站關閉清理。Server 直接 Fastify 埠不當作音檔入口。
- Web 命令及 Bot 核心測試覆蓋登入 session 撤銷、語音移動、權限、session／generation／queue revision 過期、下載取消、STOP／SKIP 優先取消、重複命令與重新取得當前快照。
- SSE 驗證即時 session／語音重查、過期與慢客戶端關閉，以及取消訂閱。前端驗證過期搜尋／HTTP 結果不覆蓋較新狀態、清單衝突需重讀與重新確認刪除。

## 實際瀏覽器驗證

使用 Vite 正式輸出、真實網站認證、Server SQLite／HTTP 及 Nginx。只有 Discord Gateway／語音端口使用替身。Playwright 操作原生 `HTMLAudioElement`，沒有替換解碼或播放行為。

完成網頁 Discord ID 註冊、登入直接進入播放器、自願設定 4 字元密碼與重新登入，確認註冊頁沒有密碼欄位，網頁及正式客戶端資產沒有預設密碼字串或提示。另完成 33 首曲庫分頁、搜尋、上傳導向、清單建立／改名／重複收藏／排序／移除／衝突刪除、Discord 命令與外部 SSE 同步、載入期間 STOP、原生音訊暫停／繼續／seek／佇列／切換目標，以及登出資源清理。

| 合成 FFmpeg 樣本 | Chromium 原生解碼 |
| --- | --- |
| MP3 | 通過 |
| M4A／AAC | 通過 |
| Ogg／Opus | 通過 |
| WebM／Opus | 通過 |
| WAV／PCM | 通過 |
| FLAC | 通過 |

每個樣本核對解碼後時長約 12 秒、播放時間實際前進且沒有 media error；損壞音訊必須顯示錯誤。桌面 `1440×1000` 與手機 `390×844` 沒有橫向溢出，頁面沒有未捕捉例外或正式資產載入失敗。預期的未登入 `401` 與版本衝突 `409` 不計為資產失敗。

測試輸出截圖與 JSON 預設存放於忽略版本控制的 `web/test-results/browser/`，可用 `BROWSER_REVIEW_DIR` 更換位置。

## 故障、啟停與可移除性

網站啟動失敗保留已啟動的 Bot；網站清理失敗仍停止 Bot，清理可重複呼叫。取消 Bot 啟動、延遲網站啟動期間停止，以及正常停止時先關閉網站再停止 Bot，均有測試。

監督測試使用真正的子程序注入事件迴圈卡死與未捕捉致命例外，確認停止舊程序後才重啟、重啟預算耗盡退出；已捕捉的網站失敗持續心跳而不重啟健康 Bot。這不等於網站與 Bot 的記憶體／事件迴圈隔離，同程序致命錯誤仍會中斷語音。

隔離 Bot checkout 在檔案系統中沒有 `web/`，只用根目錄 package 與來源完成 Node 22.12.0 的安裝、型別／架構檢查、121 項測試及正式依賴 logger 檢查；不引用網站套件或建置產物。沒有正式 Discord 金鑰，因此沒有把離線啟動／生命週期替身當成實際 Gateway 登入。

## 重跑方式

先將兩庫放在相鄰資料夾；不需設定正式 `.env`。在 `music_server/api/` 建立測試所需建置：

```bash
npm ci
npm run db:generate
npm run build
npm run typecheck
npm run check:architecture
npm test
```

在 Bot 根目錄：

```bash
npm ci
npm run typecheck
npm run check:architecture
npm test
npm run check:production
node scripts/test-playlist-server.mjs ../music_server/api
npm --prefix web ci
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run test:unit
npm --prefix web run test:integration
npm --prefix web run test:browser
```

`MUSIC_SERVER_API_ROOT` 可指定其他 Server `api/` 絕對路徑。整合及瀏覽器串流測試需要可使用 `/var/run/docker.sock` 的本機 Docker daemon，能啟動 `nginx:1.30-alpine`，並讓容器連到主機暫存測試埠。測試掛載既有 Server Nginx 設定，不修改正式設定或資料；會清理暫存容器與資料庫。

瀏覽器測試需要 `ffmpeg`，預設使用 `/usr/bin/chromium`；可設定 `BROWSER_PATH` 為已安裝的 Chromium 執行檔，或先 `cd web && npx playwright install chromium` 再指定其執行檔路徑。未符合環境條件時測試會失敗並提示，不把缺少真實環境默默當成通過。

## 尚需部署後驗收

沒有執行真實 Discord Gateway／語音加入、權限、發聲、Discord 指令與網站交互實測。部署後應用測試帳號與一般語音頻道驗證這條核心路徑，並确认不要同時啟動第二個 Bot 程序。

沒有測試 Firefox、Edge、Safari／iOS、實際 HTTPS 網域、正式反向代理及目標主機 systemd 運行。六個合成樣本不保證所有容器／codec 組合可播，網站沒有 FFmpeg 相容轉碼。部署、HTTPS 與回退步驟見 [`web/deploy/README.md`](../web/deploy/README.md)。
