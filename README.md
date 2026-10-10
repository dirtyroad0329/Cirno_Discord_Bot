# Cirno Discord Bot

Discord 音樂機器人，提供本地／遠端播放、個人清單、進場音效、複製文管理與 AI 問答，可搭配網頁播放器使用。

## 功能

- **音樂播放**：搜尋曲庫、共用佇列、進度、音量、循環及隨機播放。
- **個人清單**：每人 20 份、每份 100 首，支援本地與遠端歌曲。
- **語音進場音效**：監聽指定頻道，依序播放本地音檔。
- **複製文與 AI**：搜尋／管理複製文，NVIDIA NIM 問答與 Tavily 聯網搜尋。
- **可選網站**：搜尋、編輯清單、瀏覽器播放與 Discord 語音控制。

## 環境需求

- Node.js **22.12.0 以上**與 npm。
- Discord Bot Token、應用程式 ID 及所需頻道權限。
- 遠端曲庫與個人清單需要可用的 `music_server`；本地音檔放在 `assets/songs/`。

## 安裝與啟動

### 1. 取得與建置

`webGui` 分支包含可選網站：

```bash
git clone --branch webGui https://github.com/dirtyroad0329/Cirno_Discord_Bot.git
cd Cirno_Discord_Bot
npm ci
npm run build
```

### 2. 設定環境

在專案根目錄建立 `.env`：

```dotenv
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
REMOTE_MUSIC_API_URL=https://your-music-server.example/
REMOTE_MUSIC_API_TOKEN=your_music_server_api_token
```

曲庫網址使用可傳送音檔的 Nginx 入口，Token 對應 Server 的 `API_TOKEN`。其他功能設定見[操作參考](docs/bot-reference.md)，網站設定放在 `web/.env`。

### 3. 啟動 Bot

```bash
npm start
```

需要網站時，依[網站 README](web/README.md)安裝及建置，再用 `npm --prefix web start` 一起啟動 Bot 與網站。同一 Bot 請只執行一個程序。

## 常用操作

先加入一般語音頻道，Bot 需有查看頻道、連線與說話權限。

| 指令 | 用途 |
| --- | --- |
| `/music play song:歌曲` | 播放遠端歌曲；本地加上 `source:local` |
| `/music library` | 搜尋／瀏覽曲庫 |
| `/music queue`、`/music panel` | 查看佇列與共用面板 |
| `/music pause`、`/music resume`、`/music skip`、`/music stop` | 暫停、繼續、跳曲與停止 |
| `/playlist create`、`/playlist list`、`/playlist play` | 建立、查看與播放個人清單 |
| `/copyessay`、`/copymanager` | 查詢與管理複製文 |
| 提及 Bot 並附上問題 | AI 問答，需設定模型 API 金鑰 |

完整參數、權限、播放規則及環境變數見[操作參考](docs/bot-reference.md)。

## 開發與文件

開發使用 `npm run dev`，測試使用 `npm test`。

- [完整操作與設定](docs/bot-reference.md)
- [網站安裝與使用](web/README.md)
- [本地音檔目錄](assets/songs/README.md)
- [日誌分級與輸出](src/shared/logging/README.md)
- [模組架構](docs/architecture.md)
- [測試方式與驗證紀錄](docs/testing.md)
