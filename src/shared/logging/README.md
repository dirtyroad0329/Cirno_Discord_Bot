# 日誌

Bot 使用 Winston，操作日誌依以下規則分級：

| 層級 | 用途 |
| --- | --- |
| INFO | 正常操作、輸入無效或狀態不符合操作條件 |
| WARN | 設定、權限或 Discord 互動異常，需管理者處理 |
| ERROR | 內部錯誤、後端通訊或音訊處理失敗，保留去敏後的堆疊 |

## 輸出與設定

- `logs/error.log`：僅 ERROR。
- `logs/combined.log`：預設 INFO、WARN、ERROR。
- 兩種檔案每檔 5 MB，最多各 5 檔。
- Console 預設 DEBUG 及以上；`LOG_LEVEL` 可調整檔案與 Console 門檻。

## 開發入口

操作拒絕使用 [`UserActionError`](operationErrors.ts)，設定／權限不足使用同檔的 `ConfigurationError`，由 [`logOperationError`](logOperationError.ts)統一記錄；Discord 互動使用 [`logInteractionError`](../discord/interactionErrors.ts)。

不要以訊息文字猜測等級或主動記錄秘密。完整範例、HTTP／Discord 錯誤分級與去敏規則見[日誌完整規則](../../../docs/logging.md)。
