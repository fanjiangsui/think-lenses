# 思考鏡頭 APP:資料結構(v0.1)

## 核心原則

**兩層分離,單向流動。**

| | A 層:公共內容包 | B 層:個人層 |
|---|---|---|
| 給誰 | 所有人 | 只有你 |
| 內容 | 哲學家卡片、卡住類型、對撞配對 | 你的問題、結論、回顧、AI 輔助產生的草稿與註記 |
| 可變性 | 唯讀,依版本號更新 | 可隨時變動 |
| 儲存 | 隨 APP 附帶的 JSON | 只存本機,預設不上傳 |
| AI | 不需要,離線可用 | 可選,呼叫外部 LLM 前要明確提示會送出什麼 |

資料流向:**A → B 可以(讀取、覆蓋),B → A 不自動**。B 層試用過、你覺得站得住,再手動整理進 A 層的下一版。這樣公共內容不會被個人偏好或 AI 的錯誤污染。

## A 層:`philosophers.json`

見同目錄檔案。重點欄位:

- `stuck_types[]`:入口分類。
- `lenses[]`:鏡頭卡。必填欄位:`core_claim`、`questions`、`thought_experiment`、`micro_action`、**`blind_spots`**、**`not_suitable_when`**、`reading`。
- `collision_pairs[]`:立場互相衝突的配對,用於「對撞」功能。
- `meta.version`:語意化版本。內容變更才升版,並附變更紀錄。

## B 層(只在本機)

### `sessions.json`:每一次思考紀錄

```json
{
  "id": "2026-10-12-001",
  "created_at": "2026-10-12T21:30:00+08:00",
  "problem": "一句話描述卡住的事",
  "stuck_type": "decision",
  "lenses_used": ["kant", "mill"],
  "pack_version": "0.1.0",
  "answers": [
    { "lens": "kant", "question_index": 0, "my_answer": "…" }
  ],
  "conclusion": {
    "judgment": "我的一句話判斷",
    "next_step": "下一步",
    "confidence": 3
  },
  "review_at": "2027-01-12",
  "review_result": null
}
```

- `pack_version` 要記:之後 A 層卡片改了,仍知道當時用的是哪一版。
- `review_result` 在回顧時才填,例如「當時的判斷:仍成立/部分成立/不成立,原因……」。

### `overlay.json`:個人覆蓋與 AI 草稿

```json
{
  "patches": [
    {
      "lens": "confucius",
      "op": "add_question",
      "value": "這個角色期待是誰定的?我同意嗎?",
      "origin": "me",
      "status": "accepted",
      "created_at": "2026-10-12"
    },
    {
      "lens": "epictetus",
      "op": "add_note",
      "value": "…",
      "origin": "ai",
      "model": "(記錄當時使用的模型)",
      "status": "draft",
      "created_at": "2026-10-12"
    }
  ]
}
```

- `origin`:`me` 或 `ai`,**永遠標示來源**,日後回頭看不會把 AI 的建議當成自己的結論,也方便如實記錄協作過程。
- `status`:`draft` → `accepted` / `rejected`。AI 產出預設只能是 `draft`,必須你按下接受才生效。
- 有效卡片 = A 層卡片 + `accepted` 的 patches。A 層檔案本身不被修改。

### `ai_config.json`(可選)

- 是否啟用 AI、使用的服務、是否每次送出前預覽內容。
- AI 的系統規則寫死三條(使用者不可關掉):
  1. 只提問、不下結論。
  2. 標明這是「詮釋」,不是原話。
  3. 不輸出未經核對的引文;不確定時要說不確定。

## 與時俱進的機制

1. 在 B 層用 AI 產生新提問、新的對撞角度、新的現代情境例子,存成 `draft`。
2. 你實際用過,覺得有幫助 → 改 `accepted`。
3. 累積一段時間後,挑出穩定的項目,人工審過、核對出處,再放進 A 層下一版。
4. A 層升版時,舊 `sessions` 保留原版本號,不改寫歷史。

## 技術落地時的提醒

- **內容與程式分離**:JSON 放在獨立資料夾,日後別人可以只貢獻內容、不碰程式。
- **A 層授權**:公開前先決定內容授權方式(例如 CC BY-SA),原典部分選用公版或自己重新詮釋,避免引用受版權保護的譯文。
- **隱私**:`sessions.json` 內容很私人,建議本機加密或至少不進雲端備份,除非你主動選擇。
- **心理安全提示**:APP 內放一則簡短提示——若長期低落、失眠或有傷害自己的念頭,這個工具不能取代專業協助。
- **還沒決定的事**(等你定):用什麼技術棧、是否離線優先、介面是行動 app 還是桌面。

## v1 實作與原設計的差異(PWA v1)

v1 沒有做 AI(B 層的 `overlay.json`、`ai_config.json` 留待 v2)，只實作 `sessions`。為了讓手機與 Mac 能合併，做了以下調整：

| 項目 | 設計 | v1 實作 |
|---|---|---|
| `updated_at` | 無 | 每則紀錄必有。合併時比較此欄，較新者留下 |
| `deleted_at` | 無 | 刪除不是真刪，而是「墓碑」：清空內容，只留 `id`、`created_at`、`updated_at`、`deleted_at`，讓刪除能傳到另一台裝置 |
| `answers[].kind` | 只有題目回答 | 新增 `kind`：`question`(附 `question_index`)、`experiment`(思想實驗)、`action`(小行動) |
| `review_result` | 文字 | 物件：`{ verdict: holds/partly/not, note, at }` |
| 儲存 | 未定 | 瀏覽器 `localStorage`：`tl.sessions.v1`、`tl.meta.v1` |
| 備份檔 | 未定 | `{ app: "think-lenses", export_version: 1, exported_at, pack_version, sessions: [...] }` |

合併規則：以 `id` 對應；本機沒有就新增；有就比較 `updated_at`，匯入者較新才覆蓋；其餘略過。

## v2：輕量模式的資料變更(全部為新增欄位，舊紀錄與備份仍可匯入)

### 內容包 `philosophers.json`(v0.3.0)

| 欄位 | 位置 | 說明 |
|---|---|---|
| `angle` | 每面鏡頭 | 白話角度名，輕量模式用它取代哲學家名字 |
| `micro_action_small` | 每面鏡頭 | 更小的小行動(「太大了，換小一點」) |
| `quick_ok` | 每面鏡頭 | 是否可進輕量模式。自己寫了「低落或自責時不宜」的鏡頭必須為 `false`(內容檢查會強制) |
| `quick_questions` | `quick_ok` 的鏡頭 | 輕量模式可用的題目索引(較溫和的問題) |
| `entries[]` | 頂層 | 白話入口：`id`、`label`、`type`(可為 null＝說不清楚)、`primary`、`lenses`(依序的候選池)、`note`(第一張卡的溫和提醒，可省略) |

### 紀錄(sessions)

| 欄位 | 說明 |
|---|---|
| `mode` | `quick` 或 `deep`(舊紀錄沒有此欄，視為 deep) |
| `entry` | 輕量入口 id |
| `reactions[]` | 每張卡按了什麼：`{ lens, kind, question_index, reaction: next / switch / act }`。個人層 AI 之後可據此得知哪些角度對你有感 |
| `action` | `{ lens, text, size: normal / small, status: pending / done / not_yet / not_fit, at, checked_at }` |
| `answers[]` | 輕量模式的筆記同樣記在這裡(`kind: question`) |

回訪規則：`action.status` 為 `pending`，且建立日期早於今天，下次打開首頁時詢問一次。

## v2.1：資料保護

### 加密備份檔格式

```json
{
  "app": "think-lenses",
  "export_version": 1,
  "encrypted": true,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64>" },
  "cipher": { "name": "AES-GCM", "iv": "<base64>" },
  "ciphertext": "<base64>"
}
```

- 明文是原本的備份 JSON(`{ app, export_version, exported_at, pack_version, sessions }`)，整包加密，因此看不到筆數與時間。
- 金鑰由使用者輸入的密語經 PBKDF2 推導；密語不儲存。AES-GCM 的附加驗證資料固定為 `think-lenses|backup|v1`。
- 匯入時，`kdf.iterations` 必須在 100,000 到 2,000,000 之間，否則視為格式錯誤(避免惡意檔拖垮裝置)。

### 本機設定

| 鍵 | 內容 |
|---|---|
| `tl.lock.v1` | App 鎖：`{ salt, iterations, hash, timeout, fails, until }`。只存 PIN 的加鹽雜湊。App 鎖是遮罩，不是加密 |
| `tl.meta.v1` | 新增 `enc`(是否預設加密備份)、`cover`(是否背景遮蔽) |

### 刪除

刪除以墓碑表示：`{ id, created_at, updated_at, deleted_at }`，內容立即清空。復原會寫回完整內容，並把 `updated_at` 設為比墓碑更新的時間，才能蓋過已同步到另一台的刪除。
