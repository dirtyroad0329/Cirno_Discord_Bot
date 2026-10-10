# Cirno 音樂網站

Cirno Discord Bot 的網頁播放器，提供曲庫搜尋、個人播放清單，以及瀏覽器與 Discord 語音播放。

歌曲與清單共用既有 `music_server`；網站帳號與登入資料獨立保存在 `web/` 的 SQLite。

## 功能

- 搜尋歌曲、分頁瀏覽完整曲庫。
- 建立、編輯及播放個人清單。
- 讓 Bot 加入使用者所在的語音頻道，從網站控制播放與佇列。
- 切換至瀏覽器播放，支援進度、循環與隨機播放。
- Discord ID 註冊與登入、帳號設定及密碼修改。

歌曲僅供讀取；上傳入口導向 `music_server` 既有頁面。

## 環境需求

- Node.js **22.12.0 以上**與 npm。
- 已設定的 Discord Bot，以及可用的 `music_server` API 與音檔服務。

## 快速開始

### 1. 取得與建置

網站位於 **`webGui` 分支**。以下指令均在 Bot 專案根目錄執行：

```bash
git clone --branch webGui https://github.com/dirtyroad0329/Cirno_Discord_Bot.git
cd Cirno_Discord_Bot
npm ci
npm run build
npm --prefix web ci
npm --prefix web run build
```

### 2. 設定環境變數

依[Bot 安裝說明](../README.md#安裝與啟動)設定根目錄 `.env`，包含 `TOKEN`、`CLIENT_ID` 及遠端曲庫連線。網站設定放在 `web/.env`：

```bash
[ -f web/.env ] || cp web/.env.example web/.env
```

確認以下設定：

```dotenv
WEB_ENABLED=true
WEB_HOST=127.0.0.1
WEB_PORT=3100
WEB_PUBLIC_URL=http://127.0.0.1:3100
```

`WEB_PUBLIC_URL` 必須與瀏覽器實際使用的網址一致；正式環境使用 HTTPS。其他設定可保留預設值。

### 3. 啟動

```bash
npm --prefix web start
```

本機入口：**http://127.0.0.1:3100/web/**。

此入口會一起啟動 Bot 與網站；同一 Bot 請只執行一個程序。單獨啟動 Bot 使用根目錄 `npm start`。

## 必要設定

| 變數 | 用途 |
| --- | --- |
| `WEB_ENABLED` | 啟用或停用網站 |
| `WEB_HOST`／`WEB_PORT` | 監聽位址與埠 |
| `WEB_PUBLIC_URL` | 瀏覽器使用的網站網址 |
| `WEB_AUTH_DB_PATH` | 認證資料庫，預設 `./data/auth.sqlite`，相對於 `web/` |
| `WEB_MUSIC_API_URL`／`WEB_MUSIC_API_TOKEN` | 留空沿用 Bot 的遠端曲庫設定 |
| `WEB_UPLOAD_URL` | 留空導向曲庫的 `/admin`；可指定既有上傳頁網址 |

完整設定見 [`.env.example`](.env.example)。更新時保留根目錄 `.env`、`web/.env` 與認證資料庫。

## 帳號與播放

- 在登入頁選「建立帳號」，只填 Discord ID；登入後直接進入播放器。
- 可在設定頁修改密碼，新密碼僅限英文或數字，至少 4 位；修改後需重新登入。
- Discord 播放前先加入一般語音頻道，Bot 需有查看頻道、連線與說話權限。
- 網站不連結或驗證 Discord 本人身份；瀏覽器播放格式取決於瀏覽器支援。

## 文件

- [帳號維護、備份與開發](docs/reference.md)
- [部署範例](deploy/README.md)
- [測試方式與驗證紀錄](../docs/testing.md)
- [Bot 架構](../docs/architecture.md)
