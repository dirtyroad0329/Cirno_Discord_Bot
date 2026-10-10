# 網站參考文件

安裝與啟動請先看[網站 README](../README.md)。本文件提供帳號維護、完整設定、備份、故障處理及開發細節。

## 正式依賴安裝

完成 Bot 與網站建置後，可改用正式依賴啟動：

```bash
npm ci --omit=dev
npm --prefix web ci --omit=dev
npm --prefix web start
```

建置與測試需要 dev dependencies；不要在尚未建置時省略它們。

## 網頁註冊、登入與密碼

在登入頁按「建立帳號」，只輸入 17–20 位數字的 Discord ID 即可註冊，不要求密碼、OAuth 或 Discord 驗證。註冊成功後返回登入頁並保留帳號，不會自動登入。預設密碼只由服務端設定，網站頁面、提示及註冊回應不會顯示它。

登入後直接使用曲庫、清單及播放器，不要求第一次登入改密碼。已存在的帳號不需重新註冊；重複註冊不會重設其密碼、停用狀態或資料。

可在設定頁自願修改密碼：新密碼僅限 ASCII 英文字母或數字，至少 4 個字元，不要求兩種類別同時出現；最多 1024 個字元。修改仍要求目前密碼及確認新密碼，成功後撤銷所有網站 session，再用新密碼登入。既有包含空白、符號或 Unicode 的舊密碼仍可登入及作為目前密碼，不被新密碼規則拒絕。

一般 session 最長 7 天、閒置 24 小時過期。Cookie 使用 `HttpOnly`、`SameSite=Lax`，HTTPS 啟用 `Secure`。註冊與登入檢查同源，其他寫入同時檢查 Origin 與 CSRF token；註冊有帳號、來源與全域限流。正式網站必須設定 HTTPS；HTTP 僅允許 localhost／loopback 開發。

帳號建立使用網頁，管理 CLI 保留重設、停用、啟用及備份等維護功能。CLI 僅載入網站設定與認證 DB，不啟動 Bot、不驗證 Discord 帳號，也不要求 music_server 可連線：

```bash
npm --prefix web run auth -- reset 123456789012345678
npm --prefix web run auth -- disable 123456789012345678
npm --prefix web run auth -- enable 123456789012345678
```

`reset` 只在管理者終端印出新的隨機密碼；使用者可直接登入，不強制改密碼。請私下交付，勿貼進公開日誌或版本控制。改密碼、重設、停用及重新啟用都會撤銷該帳號全部 session。停用網站帳號不刪除 music_server 的歌曲或播放清單。

認證 migration v3 取消舊帳號的首次改密碼旗標，將舊受限 session 升級為一般權限，保留原密碼雜湊、帳號狀態、credential version、session 到期與撤銷狀態；已撤銷或停用的 session 不會恢復。

## 使用與播放規則

- 搜尋及全庫瀏覽使用既有 API 分頁；不另外保存音樂資料副本。
- 建立、改名、刪除、收藏及排序只作用於登入帳號自己的播放清單。每人最多 20 份清單，每份最多 100 個收藏；刪除收藏不刪除歌曲。
- 清單版本衝突會提示重新讀取，再由使用者確認操作，不自動覆寫 Discord 或另一個網頁的修改。
- 「在瀏覽器播放」由使用者點擊啟動。實際可播放格式取決於瀏覽器；遇到不支援的容器／codec 會顯示錯誤，可改用 Discord 模式。網站不提供自動轉碼，也不宣稱所有 Safari 格式均可播放。
- 「Discord 語音」使用登入 ID 在 Bot 可見伺服器的即時語音狀態。先加入一般語音頻道；不支援 Stage 或私訊。Bot 需要查看頻道、連線、說話權限。
- 同一頻道成員可以控制共用佇列；另一頻道已有手動播放器時，網站不會把 Bot 搶走。暫停、跳曲、進度、音量、循環與佇列操作會和 Discord 共用狀態。
- 網站播放不要求文字面板存在；可稍後在 Discord 使用 `/music panel` 建立面板。登出或關閉網站不會主動停止語音播放，Bot 原有停止與空頻道規則仍生效。
- 上傳入口只導向 music_server 已有管理頁，預設為曲庫網址下的 `/admin`；管理頁使用它原有的驗證。網站不轉送或公開 `ADMIN_TOKEN`，不提供歌曲修改／刪除／上傳代理。

## 設定與路徑

| 設定 | 用途 |
| --- | --- |
| `WEB_ENABLED` | `true` 啟用網站；`false` 保留合併入口的 Bot、略過網站啟動 |
| `WEB_HOST`／`WEB_PORT` | 網站 listener，預設 `127.0.0.1:3100` |
| `WEB_PUBLIC_URL` | 瀏覽器實際使用的網址，決定同源驗證及 HTTPS cookie；正式環境例如 `https://music.example.com` |
| `WEB_AUTH_DB_PATH` | 網站認證 DB；相對路徑以 `web/` 為基準，不隨 shell cwd 改變 |
| `WEB_MUSIC_API_URL`／`WEB_MUSIC_API_TOKEN` | 留空繼承 Bot 的 `REMOTE_MUSIC_API_URL`／`REMOTE_MUSIC_API_TOKEN`；網址覆寫必須仍是同一曲庫身份 |
| `WEB_UPLOAD_URL` | 可選的既有後端上傳頁公開網址；留空使用曲庫 `/admin` |
| `WEB_API_TIMEOUT_MS` | 歌曲／清單上游請求期限，預設 8000 ms |
| `WEB_MEDIA_IDLE_TIMEOUT_MS` | 音訊代理閒置期限，預設 30000 ms |
| `WEB_MEDIA_MAX_CONNECTIONS`／`WEB_MEDIA_MAX_PER_USER` | 音訊代理總量／每帳號上限，預設 16／3 |
| `WEB_SSE_MAX_CONNECTIONS`／`WEB_SSE_MAX_PER_USER` | 即時同步總量／每帳號上限，預設 64／3 |
| `WEB_SSE_RECHECK_MS` | session 與語音授權重查週期，預設 2000 ms |
| `WEB_COMMAND_MAX_PENDING_PER_GUILD` | 每伺服器網站操作等待上限，預設 8 |
| `WEB_COMMAND_TIMEOUT_MS` | 網站控制請求期限，預設 30000 ms；不以提前釋放播放器佇列來偽造取消成功 |
| `WEB_SUPERVISOR_STALL_MS` | 監督入口的心跳停滯期限，預設 20000 ms |
| `WEB_SUPERVISOR_STARTUP_GRACE_MS` | 尚未取得第一個心跳的啟動寬限，預設 60000 ms |
| `WEB_SUPERVISOR_RESTART_DELAY_MS` | 整體程序重啟前等待，預設 2000 ms |
| `WEB_SUPERVISOR_KILL_GRACE_MS` | 停止舊子程序的寬限，預設 5000 ms；超時後強制終止才重啟 |
| `WEB_SUPERVISOR_MAX_RESTARTS_PER_HOUR` | 每小時整體程序重啟上限，預設 5；耗盡以狀態 78 結束監督入口 |

完整預設見 [`web/.env.example`](../.env.example)。部署環境的 `WEB_*` 可覆寫檔案值，但網站載入器不把整份 `web/.env` 指派給 Bot 的 `process.env`。不要使用 `VITE_*` 保存金鑰。Bot 原有 `.env` 保留於根目錄，music_server 的 `.env` 不需修改。

曲庫網址需指向可傳送音檔的 **Nginx 入口**；直接指向 music_server 的 Fastify 3000 埠只能取得 `X-Accel-Redirect`，不會有可播放的檔案內容。代理保留 GET／HEAD／Range 語意，服務金鑰由後端加入，不傳給瀏覽器。不同曲庫的既有收藏仍保留；瀏覽器僅播放目前曲庫，Discord 依原有規則解析可讀本地／目前遠端收藏。

## 備份、升級與還原

網站帳密／session 預設放在 `web/data/auth.sqlite`；正式環境建議設定 `WEB_AUTH_DB_PATH=/var/lib/cirno-web/auth.sqlite` 並給 Bot 服務使用者寫入權限。不要放在 `dist/`、靜態目錄或每次部署會清空的路徑。`web/data`、SQLite 的 `-wal`／`-shm`、備份及 `.env` 都屬執行期資料，不應加入 Git。

使用 CLI 做運行中的 SQLite 一致性備份，備份檔權限為 `0600`，目的檔案不得已存在：

```bash
npm --prefix web run auth -- backup /var/backups/cirno-web/auth-20261010.sqlite
```

CLI 備份使用 SQLite `VACUUM INTO`，能包含 WAL 中已提交的內容；**不要只複製運行中的 `auth.sqlite` 主檔**。備份也包含尚有效的 session，應與密碼資料一樣保管。根目錄 Bot `.env`、`web/.env` 與 music_server 原有資料各自備份，不把這份認證備份當成音樂庫備份。

認證 migration 僅修改網站 DB：保留既有 migration 紀錄，升級前建立 `.migration-*.sqlite` 備份，升級在交易中完成。先用**舊版本 CLI** 備份再更新建置，避免更新後 CLI 先行套用 migration。新版遇到未知較新 schema 會拒絕網站啟動，不清空資料或降級成免登入。

還原時先停止合併程序及所有使用此 DB 的 CLI；保存目前 DB 作為回復點，再以服務使用者把備份還原到 `WEB_AUTH_DB_PATH`。確認沒有任何 DB 連線後移除該目標原來的 `-wal`／`-shm`，恢復擁有者與 `0600` 權限，再啟動。還原舊備份會回復當時帳密及 session；依需要用 CLI 重設／停用撤銷它們。歌曲與清單不受此認證還原影響。

## 停用、移除與故障處理

停用採停止／重啟切換，不提供運行中的熱卸載。停止合併程序後，在根目錄執行 `npm start` 即回到原 Bot-only 模式；也可設 `WEB_ENABLED=false` 後重啟合併入口。重啟會結束目前語音工作階段，Bot 不自動續播。

移除前保存 `web/.env` 與認證 DB，停用網站反向代理／服務管理器，切回 Bot-only 的啟動指令後再移除 `web/`。根目錄 Bot 的安裝、建置、測試與啟動不要求網站套件、設定、DB 或建置產物；`src/` 的中立播放器能力可以保留，不需逐項回滾。要恢復時還原網站程式、設定及認證 DB，再建置並切回合併入口即可。

前端失敗、已捕捉的網站請求／DB／上游錯誤會限制在網站範圍；同程序仍共用事件迴圈、記憶體與原生資源。死循環、記憶體耗盡或程序致命崩潰仍可中斷 Bot。HTTP `/web/api/health` 只表示網站路由能回應，不代表 Discord Gateway、語音或曲庫已通過完整操作驗證；勿以網站單獨失敗反覆重啟健康 Bot。

可選父程序監督入口用 IPC 心跳偵測合併子程序停滯／退出：

```bash
npm --prefix web run start:supervised
```

監督程序只負責健康與重啟，不再登入一個 Bot；實際 Bot＋網站仍在同一子程序。子程序每秒傳送 IPC 心跳，已處理的網站失敗不停止程序心跳，因此不會因此重啟 Bot。程序整體卡住／退出時，先停止舊程序及其音訊子程序，再延遲重啟，會中斷語音；超出每小時次數上限以狀態 78 停止，交由管理者診斷。正式服務範例見 [`deploy/`](../deploy/README.md)。

## 前端開發與驗證

先依上面的順序安裝／建置，開發時只啟動一個合併 Bot。在 `web/.env` 設定 `WEB_PUBLIC_URL=http://127.0.0.1:5173`，網站 API 仍使用 `WEB_PORT=3100`；另一個終端執行：

```bash
npm --prefix web run dev
```

瀏覽 `http://127.0.0.1:5173/web/`。Vite 只把 `/web/api` 與 `/web/upload` 請求代理到 `127.0.0.1:3100`，頁面、資產及 HMR 由 Vite 提供；保留瀏覽器 Origin。若更換開發埠，需一併更新公開網址及代理設定。開發後切回原 `WEB_PUBLIC_URL` 再部署。

```bash
npm run typecheck
npm run check:architecture
npm test
npm --prefix web run typecheck
npm --prefix web run build
npm --prefix web run test:unit
npm --prefix web run test:integration
npm --prefix web run test:browser
```

整合測試會使用暫存 SQLite 與測試音檔，不登入正式 Discord 或修改正式曲庫。真實 music_server HTTP 測試需要它的 `api/` 先安裝、產生 Prisma Client 並建置，路徑設定及本次已執行的證據見[測試紀錄](../../docs/testing.md)。瀏覽器測試需要 Playwright 瀏覽器；實際真人 Discord 語音及 Safari codec 相容性仍需部署後驗收，不把替身測試等同這些確認。
