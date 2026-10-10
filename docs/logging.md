# 日誌完整規則

快速導覽見[日誌 README](../src/shared/logging/README.md)。以下保留分級例外、API／Discord 錯誤處理、去敏與輸出設定。

Winston 支援 `error`、`warn`、`info`、`http`、`verbose`、`debug`、`silly`。Bot 的操作日誌採用以下分級：

| 層級 | 判斷原則 | 範例 |
| --- | --- | --- |
| INFO | 正常操作，或使用者輸入／狀態不符合操作條件 | 無效清單 ID、未加入語音、空佇列、清單更新衝突、面板過期、歌曲已移除 |
| WARN | 需要管理者處理的設定、權限或互動異常 | API 設定未填／網址無效、Bot 權限不足、未設定進場音檔、Discord 回覆逾時或重複回覆 |
| ERROR | 內部錯誤、服務或音訊處理失敗 | 未分類的例外、連線失敗／逾時、HTTP 401／403／5xx、API 路由不存在、後端資料格式錯誤、解碼或串流中斷 |

ERROR 不限於程式崩潰；單次後端通訊失敗也應保留，方便追查。歌曲或清單記錄不存在的 HTTP 404 是 INFO；服務根路由不存在的 HTTP 404 是 ERROR。清單操作的 HTTP 400、409、413 是 INFO，通知使用者修正輸入或重新讀取後操作。

## 操作例外

預期的使用者操作拒絕使用 `UserActionError`；設定或權限不足使用 `ConfigurationError`。不要用訊息文字猜測等級，也不要把所有捕捉到的例外降級。

```ts
import { UserActionError, ConfigurationError } from './operationErrors.js';
import { logOperationError } from './logOperationError.js';

throw new UserActionError('此面板已失效，請重新開啟。');
throw new ConfigurationError('請設定 REMOTE_MUSIC_API_URL。');

// 在捕捉例外的邊界記錄：INFO / WARN 只記訊息，ERROR 保留原始堆疊。
logOperationError(error);
```

Discord 互動邊界使用 `shared/discord/interactionErrors.ts` 的 `logInteractionError`。它額外處理尚未填寫的選項（INFO）、已刪除的訊息 10008（INFO）、權限不足 50001／50013（WARN），以及互動失效 10062／重複回覆 40060（WARN）。這些已知 Discord 錯誤只記錄診斷訊息，不輸出含互動 Token 的錯誤物件或網址。

共同 logger 也會處理未知錯誤碼與 HTTP 錯誤：遮蔽 webhook／interaction URL 的 token、Bearer、URL 憑證與敏感查詢參數，以及 authorization、cookie、token、secret、password、API key 和 requestBody 欄位；巢狀 cause 採相同規則。診斷仍保留 code、status、方法與去敏後的原始 stack。循環 metadata 不會讓日誌序列化失敗。不要依賴遮蔽機制主動記錄秘密。

項目自動完成在尚未選擇清單時直接回傳空建議，不產生例外。清單解析會保留不可用的歌曲參照，但仍依上述分級記錄失敗原因，不會隱藏伺服器通訊錯誤。

## 輸出與設定

- `logs/error.log`：僅 ERROR，每檔 5 MB，最多 5 檔。
- `logs/combined.log`：預設 INFO、WARN、ERROR；可用 `LOG_LEVEL` 調整，每檔 5 MB，最多 5 檔。
- Console：未設定 `LOG_LEVEL` 時接受 DEBUG 及以上；設定後使用指定門檻。

Winston 等級門檻會包含更高嚴重性的日誌，例如 `LOG_LEVEL=warn` 會顯示 WARN 與 ERROR。直接呼叫 `logger.error(error)` 或 `logger.error('背景說明', error)` 會保留錯誤發生位置的堆疊；INFO／WARN 的操作拒絕不列印堆疊。
