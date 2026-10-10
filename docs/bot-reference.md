# Bot 操作參考

日常安裝與啟動見[專案 README](../README.md)。本文件保留完整指令、播放規則、環境變數與功能說明。

[音樂播放器](#音樂播放器本地與遠端) · [個人清單](#個人播放清單) · [進場音效](#偵測語音頻道福音傳播) · [遠端曲庫](#遠端音樂曲庫) · [複製文](#複製文管理) · [AI 問答](#nvidia-nim--gpt-oss-20b--聯網搜尋)

Cirno Discord Bot 是一個 Discord 機器人，提供偵測語音頻道福音傳播(爛音樂)、預設使用遠端曲庫的音樂播放器、音樂資料庫串聯、複製文管理，以及 線上語言模型串聯功能。


## 安裝與啟動

使用 Node.js 22.12 以上版本

```bash
npm ci
npm run build
npm start
```

開發時執行 `npm run dev`；執行自動化測試使用 `npm test`。

### 可選音樂網站

獨立的 `web/` 提供搜尋、個人清單、瀏覽器音訊及 Discord 語音播放器控制。網站與 Bot 共用同一程序及播放器，新增設定全部放在 `web/.env`；原本的 `npm start` 仍只啟動 Bot，不需要網站套件或資料夾。安裝、登入帳號管理、合併啟動、停用及備份方式見 [網站說明](../web/README.md)。

`.env` 至少需有 `TOKEN`（Discord Bot token）與 `CLIENT_ID`（應用程式 ID）
```dotenv
TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_application_id
TESTER_ID=your_discord_user_id
NVIDIA_API_KEY=your_nvidia_api_key
TAVILY_API_KEY=your_tavily_api_key
```


## 音樂播放器（本地與遠端）

音樂與個人清單共用 `REMOTE_MUSIC_API_URL`、`REMOTE_MUSIC_API_TOKEN`。加入一般語音頻道後使用 `/music play song:歌曲`，省略 `source` 時使用遠端曲庫。本地音檔放在 Bot 主機的 `assets/songs/`，使用時明確指定 `source:local`。

| 指令 | 用途 |
| --- | --- |
| `/music play song:歌曲 source:remote/local next:true` | 預設遠端，自動完成選歌；沒有播放時開始，有播放時加入佇列；`next:true` 排在待播首位 |
| `/music library query:關鍵字` | 預設搜尋／分頁瀏覽遠端曲庫，關鍵字可省略 |
| `/music queue` | 查看待播清單及點歌者 |
| `/music panel` | 取得面板連結；面板被刪除時，由同語音頻道成員重建 |
| `/music pause`、`/music resume` | 暫停／繼續，重複執行不會反向切換 |
| `/music skip`、`/music previous` | 下一首／上一首（本次工作階段保留最近 20 首紀錄） |
| `/music restart` | 目前歌曲從頭播放 |
| `/music seek seconds:90` | 跳到 1 分 30 秒，暫停時跳轉仍保持暫停 |
| `/music volume percent:50` | 指定 0–100% 音量 |
| `/music repeat mode:off/one/all` | 關閉／單曲／佇列循環 |
| `/music shuffle` | 打亂待播歌曲 |
| `/music remove position:2` | 移除第 2 首待播歌曲 |
| `/music move from:3 to:1` | 將第 3 首待播歌曲移到下一首 |
| `/music clear` | 清空待播佇列，保留目前歌曲與循環模式 |
| `/music stop` | 停止、清空佇列並離開 |
| `/music reload` | 重新讀取並顯示遠端曲庫；`source:local` 重新掃描本地，無需加入語音頻道 |

公開面板提供暫停／繼續、上一首、下一首、從頭播放、循環（關閉／單曲／佇列）、打亂待播、選歌、佇列、音量及結束播放。曲庫與完整佇列只對操作的人顯示；曲庫每頁最多 25 首，佇列每頁 10 首。選單有效 15 分鐘，`!reload` 後請重新開啟個人選單；共用播放工作階段繼續運作。

- 同一語音頻道的成員可共同控制。另一頻道已有手動播放時，Bot 不會被點歌移動。
- 音量預設 70%，每次調整 10%，範圍 0–100%；不影響進場音樂音量。
- 單曲循環：自然播完會從頭重播；「下一首」仍會跳到下一首，沒有待播歌曲則結束。「從頭播放」可用於任何循環模式。
- 佇列循環：自然播完或按「下一首」都依序前進，最後一首回到清單開頭；只有一首時從頭重播。
- 循環關閉：播放或跳過最後一首後結束；「結束播放」在任何循環模式下都會停止並離開。
- 打亂只排列待播歌曲，最多可排入 100 首；支援重複點歌。批次加入會先檢查容量，超過上限時整批拒絕。上一首會將目前歌曲放回待播首位；若需要額外位置但佇列已滿，會提示先移除歌曲。
- 播放進度約每 15 秒更新，可用 `/music seek` 指定秒數；時間須小於總長。總長未知時仍可播放，但只能從頭播放。遠端串流跳轉會重新讀取並解碼到指定位置，因此比本地檔案慢，受原有載入逾時限制；慢速網路可改用 `REMOTE_MUSIC_MODE=download`。
- 播完立即離開；頻道沒有真人持續 60 秒，或暫停達 10 分鐘，也會自動結束。
- Bot 重啟不續播；舊面板會提示失效，使用 `/music play` 重新開始。
- 檔案損壞／移除會略過該曲目；連續三首失敗則結束。播放提示會顯示於面板。
- 每次音訊初始載入最多 60 秒，逾時會真正中止下載／探測，避免持續滴流永久阻塞播放器操作；已開始的串流播放不受此初始載入期限截斷，停止及跳曲仍可立即取消載入。

手動工作階段期間（包含暫停與連線中），該伺服器的進場音樂觸發會暫時略過；結束後恢復監聽新的進場事件，不補播。不同伺服器互相獨立，手動點歌不改變進場曲序。

曲庫僅掃描目錄第一層，支援 `.webm`、`.opus`、`.ogg`、`.m4a`、`.mp3`、`.wav`。讀取標題、演出者與時長；缺少標籤時使用檔名。新增、移除或修改本地音檔後，等檔案複製完成再執行 `/music reload source:local`。更新後重新開啟曲庫選單或輸入點歌搜尋，即可看到最新歌曲。播放器首次使用本地來源或解析既有本地收藏時才掃描，運行中不監聽目錄，也不定期補查；多人同時執行 reload 會共用同一次進行中的掃描。拒絕指向曲庫外的符號連結，不接受使用者輸入任意檔案路徑。

Bot 在語音頻道需要「查看頻道」「連線」「說話」；面板所在文字頻道需要「查看頻道」「傳送訊息」「嵌入連結」，討論串則需傳送討論串訊息權限。初版支援一般語音頻道，不支援 Stage 頻道或私訊播放。


## 個人播放清單

每位 Discord 使用者可擁有 **20 份清單，每份 100 首**，以 Discord 使用者 ID 歸屬，在此 Bot 的所有伺服器共用。每份都可混合本地與遠端歌曲，也可收藏重複歌曲。建立、瀏覽、編輯及刪除只對自己開放，不需要加入語音頻道；播放時仍需加入目前播放器所在的一般語音頻道，並遵守共用佇列的控制規則。

| 指令 | 用途 |
| --- | --- |
| `/playlist create name:通勤` | 建立新清單 |
| `/playlist list` | 查看自己的所有清單 |
| `/playlist show playlist:通勤` | 每頁 10 首，按鈕翻頁 |
| `/playlist rename playlist:通勤 name:下班` | 改名，自己的清單名稱不能重複 |
| `/playlist delete playlist:下班` | 顯示確認／取消按鈕；確認後刪除收藏，不刪音檔 |
| `/playlist add playlist:通勤 source:remote/local song:歌曲` | 預設從遠端歌曲自動完成選單加入；本地請先選 `source:local` |
| `/playlist add-current playlist:通勤` | 收藏目前播放的歌曲 |
| `/playlist remove playlist:通勤 entry:歌曲` | 從自動完成選擇要移除的項目，重複歌曲可分別處理 |
| `/playlist move playlist:通勤 entry:歌曲 position:1` | 調整清單中的順序 |
| `/playlist save name:今晚的歌` | 將目前歌曲＋待播佇列另存成新清單（合計不能超過 100 首） |
| `/playlist play playlist:通勤 shuffle:true next:true` | 整份加入播放；隨機排序與插隊為選用，不修改原清單 |

清單指令的回覆僅本人可見，選單／刪除確認 15 分鐘後失效；可在自動完成搜尋自己的清單及項目。刪除確認後若清單已被其他操作更新，必須重新確認。播放清單仍是個人資料，但實際播放及佇列會顯示在伺服器共用面板。

播放前會重新查詢曲庫，無法取得的歌曲會略過並回報數量，不會自動刪除收藏。全部無法取得時不會開始播放。遠端項目會記住所屬 API 網址，避免切換曲庫後誤播同 ID 的其他歌曲；更換遠端網址或移動本地曲庫根目錄後，需重新加入受影響的收藏。

### 後端資料庫保存播放清單

播放清單一律保存於 `music_server` 的 SQLite 資料庫；Bot 只負責 Discord 互動與播放，不直接保存清單。在 Bot `.env` 必須設定以下兩個變數，本地與遠端歌曲收藏都透過同一個 Server 的清單 API 管理：

```dotenv
REMOTE_MUSIC_API_URL=https://your-music-server.example/
REMOTE_MUSIC_API_TOKEN=your_music_server_api_token
```

歌曲與清單共用 `REMOTE_MUSIC_API_URL` 和 `REMOTE_MUSIC_API_TOKEN`，Token 對應 Server 的 **`API_TOKEN`**（至少 32 字元）。已設定遠端曲庫的 Bot 不需再設定清單專用網址或金鑰。舊的 `PLAYLIST_API_URL`、`PLAYLIST_API_TOKEN` 及 Server 的 `PLAYLIST_BOT_TOKEN` 已停用，可從環境設定移除。Server 需同步更新、執行 `npm run db:generate`、`npm run db:migrate` 並重新啟動，或以 Docker 重新建置啟動並自動遷移；既有歌曲與清單會保留。

Bot 只會以 Discord interaction 的使用者 ID 呼叫清單 API；Server 驗證 API 金鑰後限制清單擁有者。更新帶有版本，遇到其他操作造成衝突會提示重新讀取；寫入不會自動重試。缺少 API 設定、設定不完整或服務無法連線時，清單操作會明確失敗並提示管理者設定；不會讀寫 Bot 的 JSON 或建立本地清單。HTTP 只適用於可信任本機／私人網路，跨主機請使用 HTTPS。

清單保存於 Server 的 SQLite；請備份並持久掛載 Server 的 DB 目錄。本地音檔仍在 Bot 主機，Server 只保存收藏參照，不會將本地音檔上傳。換 Bot 主機或移動本地曲庫後，可能需要重新加入本地收藏。

這次包含播放器核心變更，請執行 `npm run build` 並重新啟動 Bot，啟動時會註冊新增的 `/playlist` 及更新後的 `/music`。全球指令更新可能需要等候 Discord 同步；`!reload` 只更新指令模組，不能替代本次重新啟動。

`npm test` 包含後端設定必填及禁止本地清單儲存、個人清單指令互動、佇列與播放器控制，以及真實 FFmpeg 的本地／遠端串流／下載跳轉測試。測試使用暫存資料與本機模擬曲庫，不會登入 Discord 或修改正式曲庫。新增遠端清單用戶端測試涵蓋專用驗證、版本傳送、錯誤不重試、資料隔離。

若同時有 `music_server` checkout，先建置 Server 的 `api/` 與 Bot，再於 Bot 根目錄執行 `node scripts/test-playlist-server.mjs ../music_server/api`。它會建立暫存 SQLite、啟動真實 HTTP Server，驗證兩邊的混合清單 CRUD、停用曲目及資料庫保存，結束後清除暫存資料。

## 偵測語音頻道福音傳播

在 `.env` 的 `VOICE_CHANNEL_IDS` 設定要監聽的語音頻道 ID，以逗號分隔。未設定時不監聽任何頻道。真人成員進入其中任一頻道時，Bot 會加入並從頭播放進場音效；播放期間若又有人進入，Bot 會先離開、重新加入，再從頭播放。音檔播完後 Bot 會自動離開並繼續監聽。

歌曲請放在 `assets/songs/`。程式會依檔名排序並逐首循環播放。支援 `.webm`、`.opus`、`.ogg`、`.m4a`、`.mp3`、`.wav`。

可選設定：
```dotenv
VOICE_CHANNEL_IDS=your_channel_id,your_channel2_id,...
VOICE_AUDIO_DIRECTORY=assets/songs
```

## 遠端音樂曲庫

Bot 可連接獨立的 `music_server` 曲庫 API。在 Bot 的 `.env` 設定：

```dotenv
REMOTE_MUSIC_API_URL=https://your-music-server.example/
REMOTE_MUSIC_API_TOKEN=your_music_server_api_token
REMOTE_MUSIC_MODE=stream
REMOTE_MUSIC_BUFFER_SECONDS=3
```

網址必須指向能傳送音檔的 Nginx 入口；本機 Docker Compose 預設為 `http://127.0.0.1/`，直接連 Fastify 埠只會收到 `X-Accel-Redirect` 標頭。Token 使用 `music_server` 根目錄 `.env` 的 `API_TOKEN`，歌曲與個人清單共用此金鑰；上傳管理使用另外的 `ADMIN_TOKEN`。Bot 搬到另一台主機時，須將網址改成可連通的 HTTPS 或私有 VPN 入口；`127.0.0.1` 只指向 Bot 自己所在的主機。

`/music play`、`/music library`、`/music reload`、`/playlist add` 及歌曲自動完成在省略 `source` 時都使用遠端曲庫。面板的「選歌」按鈕也固定預設開啟遠端曲庫，即使目前播放的是本地歌曲。明確指定 `source:local` 才會使用本地曲庫；本地與遠端歌曲仍可加入同一佇列及清單，既有收藏依原來源播放。遠端服務未設定或無法使用時會回報錯誤，不會自動切換成本地曲庫。進場音樂維持原本的本地音檔設定。

`REMOTE_MUSIC_MODE=stream`（預設）會邊接收邊播放。M4A（MP4 容器）可能需要回頭讀取檔案，因此即使選擇串流模式，也會自動下載並驗證整首音檔後播放；其他格式不將整首歌存到 Bot 主機。串流模式預設先緩衝約 3 秒解碼後的音訊再開始播放，可用 `REMOTE_MUSIC_BUFFER_SECONDS` 設為 0–10 秒；設大會增加開始播放的等待時間與每條串流的記憶體用量，對持續低於播放速度的網路無法補救。`download` 會先下載並驗證整首音檔，再從暫存檔播放，結束後刪除。下載及 M4A 自動下載使用的暫存目錄預設為 `data/remote-music-cache/`，可用 `REMOTE_MUSIC_CACHE_DIRECTORY` 修改，需預留音檔大小的磁碟空間。下載若連續 15 秒未收到資料，會取消並清理暫存；持續有進度的下載不受 15 秒總時長限制。`/music reload` 預設重新讀取並顯示遠端曲庫；`/music reload source:local` 才會重掃本地。遠端歌曲在 `music_server` 匯入或停用後由 API 即時反映。


## 複製文管理

複製文儲存在 Bot 主機的 `data/copyessay.json`。使用下列斜線指令查詢或管理。

新增及刪除後，資料會直接寫入 `data/copyessay.json`。

| 指令 | 用途 |
| --- | --- |
| `/copyessay random` | 隨機顯示一則複製文；`silent:true` 可設為僅自己可見 |
| `/copyessay search query:關鍵字` | 搜尋相關複製文，私下顯示最多 10 筆結果及其 ID、相關度 |
| `/copyessay id id:編號` | 依 ID 顯示複製文；`silent:true` 可設為僅自己可見 |
| `/copymanager add` | 開啟表單，輸入標題與內容以新增複製文 |
| `/copymanager delete id:編號` | 刪除指定 ID 的複製文 |
| `/copymanager list` | 私下列出所有複製文 |


## NVIDIA NIM / GPT-OSS 20B + 聯網搜尋

在 `.env` 設定以下環境變數：

```dotenv
NVIDIA_API_KEY=your_nvidia_api_key
TAVILY_API_KEY=your_tavily_api_key
```

啟動 bot 後，在 Discord 訊息中提及 bot 並附上問題，即會透過 NVIDIA NIM 的 GPT-OSS 20B 產生串流回覆。遇到最新資訊、時效性內容或明確要求搜尋時，模型若知道官方來源就直接讀取該 HTTPS 網頁或 API；不知道來源時才呼叫 Tavily 搜尋，答案會附上來源連結。

`TAVILY_API_KEY` 未設定時，一般問答仍可使用，但聯網搜尋會回報未設定，不會假裝已搜尋。可在 [Tavily](https://app.tavily.com/) 申請免費 API key。

可選設定：

```dotenv
# 預設：openai/gpt-oss-20b
NVIDIA_NIM_MODEL=openai/gpt-oss-20b

# 預設：1024
NVIDIA_NIM_MAX_TOKENS=1024

# 串流請求逾時毫秒數，預設：180000
NVIDIA_NIM_TIMEOUT_MS=180000

# 搜尋逾時毫秒數，預設：20000
WEB_SEARCH_TIMEOUT_MS=20000

# 直接讀取官方網頁/API 的整體逾時（含 DNS／redirect／body）與大小限制
DIRECT_FETCH_TIMEOUT_MS=15000
DIRECT_FETCH_MAX_BYTES=1000000

# 搜尋模式：auto、always、off；預設：auto
WEB_SEARCH_MODE=auto

# Tavily 搜尋速度／品質：ultra-fast、fast、basic、advanced；預設：fast
TAVILY_SEARCH_DEPTH=fast

# 每次搜尋結果數，預設：5，最大：10
TAVILY_MAX_RESULTS=5

# 一次回答最多搜尋輪數，預設：2，最大：5
NVIDIA_NIM_MAX_TOOL_ROUNDS=2

# Kimi K3 推理強度：low、high、max；預設：low（最快）
NVIDIA_NIM_REASONING_EFFORT=low

# 自訂 system prompt
NVIDIA_NIM_SYSTEM_PROMPT=You are a helpful Discord assistant.

# 若使用自行部署的 NIM，可覆寫 API URL
NVIDIA_NIM_URL=https://integrate.api.nvidia.com/v1/chat/completions
```


## 程式架構

停止 Bot 會取消進行中的 AI 模型／工具請求並停止後續回覆；語音初次連線期間也可透過已授權的停止操作立即取消。遠端清單解析會共用相同歌曲的 metadata 查詢並保留重複項目與原順序，每次解析以約 125 ms 間隔啟動新的歌曲查詢；唯讀歌曲 API 遇到 429 最多額外重試兩次，仍受原請求總逾時限制。

`npm run check:production` 在暫存目錄驗證僅安裝 production dependencies 時仍能載入 logger；此檢查略過 FFmpeg 安裝腳本，不代表完整 Discord 啟動測試。網頁擷取的真實 TLS 回歸測試需要 OpenSSL。

模組責任、依賴方向、資源所有權與驗證方式見 [架構說明](architecture.md)。

## 日誌分級

使用者輸入無效、面板過期及操作條件不符記為 INFO；設定、權限或 Discord 互動異常記為 WARN；內部錯誤、後端通訊失敗及串流／解碼失敗記為 ERROR。ERROR 保留原始錯誤堆疊。完整規則、檔案輸出與 `LOG_LEVEL` 設定見 [日誌說明](../src/shared/logging/README.md)。
