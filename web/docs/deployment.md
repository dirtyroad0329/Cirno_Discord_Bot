# 網站部署操作指南

範例檔案見[部署 README](../deploy/README.md)。以下保留環境準備、安裝、監督、更新及還原步驟。

這些檔案是需要調整後安裝的範例，本專案不會自動修改主機服務、Nginx 或 music_server 部署。

使用 Node.js 22.12.0 以上，確認服務中的 `/usr/bin/node` 是相同版本。先按[網站安裝說明](../README.md)建置 Bot 及網站，再以 production dependencies 安裝；將庫根目錄設為 `/opt/cirno/Cirno_Discord_Bot` 或依實際位置修改 service 檔。服務使用者 `cirno` 需存在，並可讀根目錄 `.env`、`web/.env`、本地音檔及建置產物，可寫原 Bot 日誌／資料／快取與網站認證 DB。

`web/.env` 的正式設定示例：

```dotenv
WEB_ENABLED=true
WEB_HOST=127.0.0.1
WEB_PORT=3100
WEB_PUBLIC_URL=https://music.example.com
WEB_AUTH_DB_PATH=/var/lib/cirno-web/auth.sqlite
```

先建立只有服務使用者可存取的認證資料目錄，並將 `.env`／DB 權限設為 `0600`。如果採用 `/var/lib/cirno-web`，應由 `cirno` 擁有且目錄權限為 `0700`。不要把持久資料掛在 `web/dist`；不要把 Nginx 的靜態 root 指向整個 `web/`。

## Nginx

[`nginx.conf.example`](../deploy/nginx.conf.example)保留 `/web/` 路徑、關閉 SSE／音訊代理緩衝與快取，並保留 Cookie、Origin 及 Range 等原請求標頭。修改網域、TLS 憑證與後端埠後才安裝；服務只綁 loopback，由 Nginx 提供 HTTPS。HTTP `/web/api/health` 是網站回應檢查，不應獨自觸發 Bot 重啟。

在主機已有 Nginx 與憑證的情況下，可調整並執行：

```bash
sudo install -m 0644 web/deploy/nginx.conf.example /etc/nginx/sites-available/cirno-web
sudo ln -s /etc/nginx/sites-available/cirno-web /etc/nginx/sites-enabled/cirno-web
sudo nginx -t
sudo systemctl reload nginx
```

若已有相同檔案或連結，先檢查內容並更新，勿重複建立。這份設定只代理 Cirno 網站；music_server 的 Nginx、曲庫、API_TOKEN／ADMIN_TOKEN 與資料保存保持原樣。上傳連結使用它原有的管理頁，沒有網站代存管理金鑰。

## systemd 與程序監督

[`cirno-web.service.example`](../deploy/cirno-web.service.example)啟動可選 IPC 監督入口。先停止既有 Bot service／PM2／手動程序，確認同一 Bot 不再有其他執行個體，再安裝範例：

```bash
sudo install -m 0644 web/deploy/cirno-web.service.example /etc/systemd/system/cirno-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now cirno-web
sudo systemctl status cirno-web
sudo journalctl -u cirno-web -n 50 --no-pager
```

監督父程序不登入 Discord。Bot 與網站在一個子程序中運行；網站可處理的請求／啟動失敗仍維持程序心跳，不因此重啟 Bot。整個子程序卡住、退出或失去心跳才由監督程序重啟；每次重啟都會中斷原語音。心跳及重啟參數皆在 `web/.env`，詳見[設定表](reference.md#設定與路徑)。

監督入口預設每小時最多重啟 5 次，耗盡後退出狀態 78。service 的 `RestartPreventExitStatus=78` 保留這個停止結果，不讓 systemd 立刻重新啟動並重置預算；修正原因後由管理者重新啟動。systemd 本身也設定 5 分鐘最多啟動 3 次，避免監督程序的其他失敗形成重啟風暴。

服務的 `UMask=0077` 保護執行期檔案。可依主機實際可用 RAM 設定 `MemoryMax`，它限制服務中父程序與子程序總量；達到限制可能終止整個服務，不是網站的獨立記憶體隔離。未加上會阻止原 Bot 資料／日誌寫入的檔案系統限制，額外 systemd hardening 需依現有 Bot 路徑調整。

不使用 systemd 時可直接執行 `npm --prefix web run start:supervised`；不要再另外以 PM2／Docker 啟動相同 Bot。若主機已有服務管理方案，可選普通 `web/dist/server/entry.js` 入口並自行提供外部事件迴圈存活檢查，避免用會阻塞自身的程序內 health endpoint 偵測死循環。

## 更新、停用與還原

更新前用當前版本的帳號 CLI 保存認證備份及兩份 `.env`，再停止服務。按根目錄 Bot → 網站的順序安裝／建置並保留持久 DB，重新啟動後檢查 `/web/`、登入、清單讀取、同頻道語音控制與網站／Discord 雙向同步。

停用網站時先停止 `cirno-web`，改用原 Bot-only 入口；不要同時開啟新舊服務。若繼續使用合併入口，可設 `WEB_ENABLED=false` 再啟動。移除網站反向代理與 `web/` 前保存設定及 DB。停止／切換都會結束當前語音播放。

還原認證 DB 時停止所有持有該 DB 的程序／CLI，保留當前資料作回復點，以服務使用者恢復備份並確認擁有者及 `0600` 權限；沒有連線時才移除目標舊 `-wal`／`-shm`。不要把使用中的 DB 檔案直接覆寫。完整備份與 migration 說明見[網站參考文件](reference.md#備份升級與還原)。

這些範例未以真實 Discord token 登入或在使用者主機部署；部署後仍需真人一般語音頻道、TLS／反向代理、實際歌曲格式及服務重啟驗收。Safari codec 相容性也需在實際瀏覽器確認。
