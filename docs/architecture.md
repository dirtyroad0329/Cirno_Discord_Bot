# Bot 模組架構

以 `dev` 的行為與跨庫契約為基礎，依 pragmatic-modular-architecture skill 拆分。這次允許重新規劃目錄，因此把混合職責的 `lib/` 改成按功能組織；小型 ping/pong 指令保留直接實作。

```text
src/
  index.ts                         啟動入口
  app/                             Client 組裝、指令載入、事件路由與重載
  commands/<feature>/index.ts       Slash command 定義與公開互動入口
  features/
    music/
      api.ts                       清單功能使用的公開操作
      model/                       歌曲、佇列、面板資料與輸出介面
      application/                 本地／遠端曲庫查找
      library/                     檔案掃描與遠端歌曲 API
      audio/                       FFmpeg、串流及下載的資源生命週期
      playback/                    Session、載入來源、播放操作、權限與協調
      presentation/                Embed、按鈕、個人選單與 Discord 回覆
    playlists/                     清單 HTTP、資料驗證與收藏解析
      presentation/                指令、autocomplete、加入歌曲、播放及畫面
    assistant/                     NIM HTTP、SSE 解析、工具及回覆流程
      integrations/                已有的公共 HTTPS 資料擷取
      presentation/                mention 入口與序列化訊息編輯
    voice/                         Guild 語音所有權及進場音效
    copyessay/                     JSON 儲存、資料型別及搜尋規則
  shared/
    async/                         每個 guild 的工作序列
    discord/                       指令契約及 Discord 訊息長度處理
    logging/                       Logger 與使用說明
```

## 依賴與所有權

`app` 負責組裝與註冊；功能模組不得反向引用 `app` 或 `commands`。指令不得引用其他指令。`shared` 不知道任何具體功能。清單與音樂之間使用 `music/api.ts`，不讓收藏功能直接依賴播放器內部檔案。音樂 feature 內部直接引用實作，避免透過自己的 public API 造成循環。

`MusicPlayer` 管每個 guild 的 session、權限、面板有效性、序列化操作及語音連線。`PlaybackEngine` 管歌曲切換、暫停、seek、音量與播放事件；`source.ts` 決定本地／串流／下載來源。`MusicSession` 擁有佇列、generation、音訊、播放器與 timers，透過 `SessionPanel` 介面使用畫面，不建立 Discord UI。停止或租約被替換時清除 timers、取消載入、停止 audio/player 並釋放連線。

停止／跳歌的取消仍先於 guild 工作排隊，以免等待下載完成才能停止。generation guard 拒絕舊播放事件，queue revision guard 拒絕過期的排序操作。`startBot` 回傳 stop 並在 SIGTERM／SIGINT 清理 listeners 與語音工作階段。

`MusicPlayer.shutdown()` 先封閉新增操作並遞增生命週期，再取消載入、釋放 session 與 listeners。公開的點歌、控制、佇列編輯及面板操作在呼叫時與排隊執行前都檢查生命週期；`initialize()` 重新開放操作，也不會讓停止前的排隊任務復活。停止可重複呼叫，已執行中的載入由 session 的 abort／active guard 結束，不開始剩餘歌曲。

個人選單有獨立 registry，最多 1,000 份、有效 15 分鐘。`!reload` 只掃描真正的 `commands/*/index`，所有模組成功載入後才替換指令集合；成功重載會更新音樂／清單的指令處理入口、清除個人音樂選單，保留播放 session。被入口靜態引用的底層模組仍需重新啟動才能更新；重構部署必須完整 build 並重啟。

AI 的 HTTP 設定與請求、SSE 分片／工具參數合併、工具執行、回合協調與 Discord 更新分開。讀取完成、解析錯誤與消費者錯誤都會釋放 stream reader；最終回覆等待已排隊的編輯，避免舊預覽蓋掉答案。

## 資料與行為

HTTP 路徑、Discord 指令定義、專用金鑰及公開 JSON 欄位沿用 dev。Bot 的個人清單仍只存 Server，連線或 409 失敗不重試覆蓋，也不切換到本地儲存。

播放清單時才解析歌曲可用性，各來源獨立處理。純遠端或空清單不掃描本地目錄；混合清單共用一次本地載入，遠端查詢可同時進行。本地掃描失敗會記錄錯誤，將本地項目列為暫時不可用，不使用失敗掃描前的快取，也不阻止遠端項目解析。可播放項目維持原順序及重複收藏，不可用項目仍保留於 Server。

這次修正的行為：清單 rename/add/remove/move 會提交**指令實際讀到的 revision**，不在寫入前另讀最新 revision。Store 的選用 expectedRevision 支援既有獨立呼叫者；Discord 指令一律提供已讀版本。刪除確認按鈕繼續帶確認時的版本。

複製文維持根目錄 `data/copyessay.json`、既有 ID 與 JSON 格式。單一程序內寫入排隊，透過同目錄暫存檔及 rename 原子替換；不宣稱支援多個 Bot 程序同時寫同一 JSON。日誌維持根目錄 `logs/`。建置先清除 dist，避免搬檔後殘留舊入口。

## 驗證與新增功能

```bash
npm ci
npm run build
npm run typecheck
npm run check:architecture
npm test
# Server 也完成正常 Prisma generation/build 後：
node scripts/test-playlist-server.mjs ../music_server/api
```

架構檢查驗證靜態 runtime imports 無循環，並限制 feature/shared/command 的依賴方向；不把 type-only imports 當 runtime cycle。動態 import 與外部套件不在靜態檢查範圍。

新增指令先放定義與入口到 `commands/<feature>/index.ts`；複雜互動、狀態、外部 API 與規則放到對應 feature。僅在真實共用或獨立副作用邊界需要時新增模組，不為每個 CRUD 建一層 interface/service。改播放或非同步流程時，補測取消、過期事件、失敗恢復與資源釋放；改跨庫清單時同步檢查 Server 版本契約。

## 可選的音樂網站

網站全部放在頂層 `web/`，使用自己的 package、環境設定、建置與測試。Vue 頁面只使用 `web/contracts` 與網站 HTTP API；網站 Fastify 負責認證、同源／CSRF、可信清單 owner、上游 HTTP、音訊代理與 SSE。帳密／session 的 SQLite、migration、備份及 CLI 均由網站擁有，歌曲／清單只使用既有 `music_server` API。

`web/server/entry.ts` 是可選的組裝入口：先載入根目錄原有 Bot 設定，再啟動唯一 `startBot` 與網站。網站透過建置後的 `features/music/api` 控制共用播放器，透過 `features/playlists/api` 解析收藏；沒有直接操作 Bot session 內部欄位。Bot 的 `src/` 不引用 `web/`，根目錄 `npm start` 沿用原入口。先建置 Bot 的公開型別與能力，再建置網站。

`MusicController` 驗證 Gateway／shard、使用者目前的一般語音頻道及共用 session；在 guild 排隊操作執行前重查語音、期限、session／generation／queue revision。網站傳入取消 signal，Bot 保有實際播放器佇列與生命週期；停止／跳曲仍先取消載入。無文字面板的網站播放共用原有 `MusicPlayer`，不建立第二份語音 session。狀態觀察者的拋錯、rejection 或無回應不阻擋 Bot。

網站組裝入口擁有 Bot 與認證 DB；Fastify `close` 只清理網站的請求、串流與訂閱。正常合併停止先關閉網站及認證 DB，再停止 Bot；啟動中的 Bot 使用獨立取消 signal，避免網站清理前提早拆掉已就緒的 Bot。網站已捕捉的啟動／請求失敗保留 Bot。同程序的致命崩潰、事件迴圈卡住與記憶體耗盡仍會影響 Bot；可選父程序只監督心跳，不再登入另一個 Bot。

移除網站時改回根目錄啟動指令並移除 `web/` 即可，Bot 中立能力可保留。實際隔離建置、故障注入及相容性結果見[測試紀錄](testing.md)，網站安裝／持久資料／部署／回退見 [`web/README.md`](../web/README.md)，核准設計見[計劃書](計劃書.md)。
