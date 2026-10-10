# 網站部署

本目錄提供可調整的部署範例；安裝與環境準備見[網站 README](../README.md)。

## 範例檔案

| 檔案 | 用途 |
| --- | --- |
| [`nginx.conf.example`](nginx.conf.example) | HTTPS 反向代理，保留 Cookie、Origin、SSE 與音訊 Range |
| [`cirno-web.service.example`](cirno-web.service.example) | systemd 服務與可選程序監督 |

## 部署順序

1. 建置 Bot 與網站，設定根目錄 `.env` 及 `web/.env`。
2. 保存認證資料庫，確認服務使用者具備所需讀寫權限。
3. 依主機路徑、網址及埠調整範例，先停止原 Bot 再啟動合併服務。
4. 驗證登入、清單、語音控制及網站／Discord 同步；health 回應不代表完整播放流程已就緒。

監督程序可重啟卡住或退出的合併程序；Bot 與網站仍共用事件迴圈，每次重啟會中斷語音。

## 詳細文件

- [環境準備、安裝指令與程序監督](../docs/deployment.md)
- [更新、停用與還原](../docs/deployment.md#更新停用與還原)
- [完整設定與認證資料備份](../docs/reference.md)
