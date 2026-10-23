# 設計文件：機制導向的 LLM Wiki，與 Heptabase 串接

- 狀態：待審閱
- 日期：2026-10-23
- 分支：`design/heptabase-wiki`
- 範圍：本 fork（`llm_wiki` 桌面 app）加上一組 Claude Code skill 與一個本機小工具

---

## 0. 摘要

這份設計把 LLM Wiki 改成「先累積觀念，之後再融合」的工具。

它做四件事：

1. 收錄時，除了概念頁，也抽出跨領域的「機制頁」。機制頁只寫結構，不寫產業。
2. 每次收錄、融合、切分都留下一個 git commit。任何一次都可以整批退回。
3. 跟 Heptabase 雙向串接。Heptabase 的卡片可以進 wiki。wiki 的機制頁、假說頁可以回到 Heptabase。
4. 用 Heptabase 的工作白板當選單，讓 AI 把一個領域的機制套到另一個領域，寫成「假說頁」。

使用者、JTBD、使用場景與預估使用方式見 1.4 到 1.6。

設計分兩層：

- **編譯層**在 app 裡：收錄、機制抽取、去重、git、健檢、目錄。
- **搬運與融合層**是 Claude Code skill：Heptabase 同步、融合、切分領域、退回。

---

## 1. 背景與目標

### 1.1 使用情境

- 使用者的閱讀很廣，大多是日常閱讀。閱讀時通常沒有預先設定的研究問題。
- 使用者在 Heptabase 做多主題融合。同一張卡片會同時放在「知識」白板和「工作」白板上，再跟 AI 討論兩者的交集。
- 領域很多，而且不限於商業。例如理論物理、超導電路、量子電腦硬體、AI 模型架構、晶片硬體、非同步電路、教育研究、財報分析。
- 使用者常常把子領域切開，或把兩個子領域合併。
- 閱讀資料有兩個入口：一部分先存進 Heptabase，一部分直接用網頁剪藏或 PDF。兩種都很多。

### 1.2 目標

| # | 目標 | 怎樣算達成 |
|---|---|---|
| G1 | 知識會累積 | 新來源進來時，相關的概念頁與機制頁會被更新，不只是新增一頁 |
| G2 | 不同領域不混在一起 | 每個概念頁只屬於一個領域。只有機制頁跨領域 |
| G3 | 可以退回 | 任何一次收錄、融合、切分，都能用一個指令整批退回 |
| G4 | 不離開 Heptabase 就能讀到成品 | 機制頁、假說頁、多來源概念頁會出現在 Heptabase 的 `#wiki` tag 裡 |
| G5 | 融合有固定品質 | 假說頁有角色對照、類比強度、要驗證的事、怎樣算推翻 |
| G6 | 新的 AI session 讀得懂 | 新 session 只讀入口檔，就知道該讀什麼、每個詞是什麼意思 |
| G7 | 支援多個 wiki | 閱讀 wiki 與工作 wiki 各自獨立，各有自己的設定與對照表 |

### 1.3 非目標

- 不做完全無介面的版本。收錄流程在 app 的前端程式裡執行，搬出來的成本太高。
- 不在 app 內建 Heptabase 登入。登入交給 Heptabase 官方 plugin。
- 不 fork Heptabase 官方 plugin repo。它只有安裝設定，工具在 Heptabase 的伺服器上。
- 不做整個 wiki 兩兩互相比對的健檢。跨領域只透過機制層比對。
- 不讓 AI 刪除 Heptabase 卡片。MCP 目前也不支援。

### 1.4 JTBD（Jobs To Be Done）

格式：「當〔情境〕，我想要〔動機〕，好讓我〔結果〕。」

#### 主要工作

> 當我廣泛閱讀、但不知道哪些內容日後有用時，我想要讀過的東西自動變成可以重複使用的觀念，好讓我在遇到新問題時，能把不同領域的觀念組合起來，產生新的點子。

#### 功能性工作

| # | 工作 | 對應的功能 |
|---|---|---|
| J1 累積 | 當我讀完一篇文章（不論在 Heptabase 還是網頁），我想要不用自己整理就能讓它進到知識庫，好讓閱讀的成本只付一次 | 兩個收錄入口、來源去重、概念頁更新 |
| J2 抽象 | 當一個觀念只在一個領域出現，我想要把它的結構抽出來，好讓我在其他領域也認得出它 | 機制頁、透鏡 |
| J3 融合 | 當我在工作白板上把兩個主題放在一起，我想要 AI 逐一檢查哪些部分套得上、哪些套不上，好讓我快速判斷這個點子值不值得深入 | `wiki-fuse` 指定模式、假說頁 |
| J4 發現 | 當我讀到一個新機制，我想要有人提醒我它可能適合哪些領域，好讓我不錯過沒想到的組合 | `wiki-fuse` 發散模式、`fusion-candidate` |
| J5 驗證 | 當我有一個假說，我想要知道要找什麼證據、怎樣算錯，好讓我不會愛上一個錯的點子 | 「要驗證的事」「怎樣算推翻」、深度研究、`--update` |
| J6 整理 | 當領域越來越多、越來越雜，我想要隨時重新切分而不怕弄亂，好讓分類跟著我的理解演進 | `domains.yaml`、`wiki-recut` |
| J7 留在原工具 | 當我在 Heptabase 思考時，我想要不切換工具就讀到整理好的知識，好讓思考不被打斷 | `wiki-sync`、`#wiki` tag |

#### 情緒性工作

| # | 工作 | 對應的功能 |
|---|---|---|
| E1 放心交給 AI | 當 AI 一次改了很多頁面，我想要看得到改了什麼、能一鍵退回，好讓我敢放手讓 AI 做 | git commit、`wiki-undo` |
| E2 不怕忘記 | 當我讀過的東西越來越多，我想要確定它們都還在、找得到，好讓我不用擔心白讀 | 分領域目錄、`#wiki` 看板 |
| E3 不用記指令 | 當我想做某件事，我想要看一眼就知道有哪些功能，好讓我不必記住 skill 名稱 | Skill 面板、`/wiki` 總選單 |

#### 不是這個 repo 的工作

- 寫給別人看的報告或簡報。
- 團隊共同編輯。
- 取代 Heptabase 做空間思考。

### 1.5 使用場景

範例都是通用的。使用者自己的範例放在 private wiki。

| # | 場景 | 使用者做什麼 | 系統做什麼 | 對應工作 |
|---|---|---|---|---|
| S1 日常閱讀（Heptabase） | 通勤時讀到一篇商業文章 | 存成 Heptabase 卡片，加上 `#ingest` | 下次 `wiki-sync` 時存快照、收錄、抽出機制。新的機制卡出現在 `#wiki` | J1、J2、J7 |
| S2 日常閱讀（網頁） | 在網頁上讀到一篇硬體論文 | 用網頁剪藏存下來 | app 在背景收錄。既有的機制頁「事件驅動計算」多一個實例。送出一筆 `fusion-candidate` | J1、J2、J4 |
| S3 新題目 | 想研究「某個產業的加盟授權模式，能不能用在另一個產業」 | 開一張工作白板，拉進知識卡與工作卡，建「來源」「目標」兩個區塊，按「融合」 | 寫一頁假說，回寫一張假說卡片到白板上 | J3 |
| S4 驗證假說 | 想知道假說裡最關鍵的一項主張是否成立 | 在假說的「要驗證的事」觸發深度研究，核准結果 | 寫查詢頁，連到假說頁。`--update` 後更新假說狀態 | J5 |
| S5 理工跨領域 | 讀了一篇模型架構論文與一篇非同步電路論文 | 把兩邊的卡片放到同一張白板，按「融合」 | 判斷是類比還是堆疊，判斷類比強度是 `structural` 還是 `mathematical` | J3、J5 |
| S6 週末整理 | app 提醒「已累積 10 次收錄」 | 按「健檢」，處理審核佇列 | 列出矛盾、重複、太大的領域。建議拆分 | J6、E2 |
| S7 重新切分 | 某個領域變得太雜 | 執行 `/wiki-recut`，確認 AI 的分配計畫，在 Heptabase 新增選項 | 一次改好所有頁面與複本卡片的領域，做一次 commit | J6 |
| S8 AI 改錯了 | 發現某次收錄把兩個概念混在一起 | 執行 `/wiki-undo`，選那次收錄 | 反轉那次 commit。下次同步時更新複本卡片 | E1 |
| S9 回頭找觀念 | 記得讀過某個機制，但想不起細節 | 在 Heptabase 的 `#wiki` 看板依領域篩選，或在 Claude Code 問 | 顯示機制卡，或用 wiki 搜尋回答並附上出處 | E2 |

### 1.6 預估使用方式

#### 使用者「會」怎麼用（預測）

依照使用者目前的習慣：重度使用 Heptabase，用 Claude Code 叫 AI 做事。

| 頻率 | 動作 |
|---|---|
| 每天 | 在 Heptabase 存卡片並加 `#ingest`。用網頁剪藏存文章。app 在背景自動收錄 |
| 每天或每隔幾天 | 執行一次 `wiki-sync` |
| 每週 1 到 3 次 | 在工作白板做融合 |
| 每週約 1 次 | 處理審核佇列：新領域、新機制、融合候選 |
| 每累積 10 次收錄 | 語意健檢 |
| 偶爾 | 切分領域、退回 |
| 很少 | 打開 app 介面。只為了處理審核、看進度、改設定 |

預測的摩擦點與設計上的回應：

| 摩擦點 | 回應 |
|---|---|
| 忘記執行 `wiki-sync` | Skill 面板與 `/wiki` 選單。之後可以考慮排程 |
| 審核佇列堆太多，使用者開始略過 | 每種審核項目要少而精。`fusion-candidate` 每次最多 3 組，略過的不再提 |
| 新領域要手動加下拉選項 | skill 提醒。可以改成文字欄位換取全自動 |
| app 沒開，收錄沒有發生 | 開機自動啟動。skill 開始前檢查 |
| 融合候選品質不好，使用者不再看 | 記錄採用率（見下表）。採用率太低時，調整候選的排序方式 |

用來判斷這次更新是否成功的訊號：

| 訊號 | 怎麼量 | 預期 |
|---|---|---|
| 融合真的有在用 | 每週 `fuse:` commit 數 | 每週至少 1 次 |
| 融合候選有價值 | `fusion-candidate` 被選用的比例 | 至少 20% |
| AI 改錯的頻率 | `wiki-undo` 次數 ÷ 收錄次數 | 低於 5% |
| 審核佇列沒有失控 | 待審核項目的數量 | 長期低於 30 筆 |
| 機制真的跨領域 | 有 2 個以上領域實例的機制頁比例 | 逐月上升 |

#### 使用者「可以」怎麼用（能力範圍）

下列用法本設計支援，但不是預期的主要用法：

| 用法 | 說明 |
|---|---|
| 只用 app，不用 Heptabase | Heptabase 接口是選用的。機制層、git、健檢都可以單獨使用 |
| 用 app 介面提問 | app 既有的對話與知識圖譜功能保留 |
| 在 Claude Code 直接問 wiki | 透過 llm_wiki MCP 搜尋 wiki，回答附上出處 |
| 用 Obsidian 瀏覽 | wiki 是純 markdown，Obsidian 可以直接打開 |
| 用 Codex 代替 Claude Code | 規則檔有 `AGENTS.md`。skill 的 Codex 打包是之後的工作 |
| 多個工作 wiki | 每個專案一個 wiki，各自有設定與對照表，共用閱讀 wiki 的機制庫 |
| 多台電腦同步 | 把 wiki 推到 private GitHub repo |
| 自訂透鏡 | 為新領域（例如音樂理論）新增一份透鏡 |
| 查看任一頁面的變化歷史 | 用 git 工具 |
| 換用其他 AI 模型做收錄 | app 既有的多供應商設定 |
| 其他人使用這個模板 | 模板是公開的。不用 Heptabase 也能使用機制層 |

---

## 2. 設計原則

### 2.1 唯一真實來源（SSOT）

每種資料只有一個家。

| 資料 | 唯一的家 | 其他地方的角色 |
|---|---|---|
| 外部文章原文 | wiki repo 的 `raw/sources/` | Heptabase 的原文卡片是閱讀副本 |
| 使用者的想法 | Heptabase 卡片 | `raw/sources/heptabase/` 是快照 |
| 概念頁、機制頁、假說頁 | wiki repo 的 `wiki/` | Heptabase `#wiki` 卡片是複本，唯讀 |
| 機制 | 閱讀 wiki 的 `wiki/mechanisms/` | 工作 wiki 只引用 |
| 領域清單 | 各 wiki 的 `domains.yaml` | Heptabase `#wiki` 的 `domain` 選項是顯示 |
| 白板上的排列 | Heptabase | AI 只讀，不擁有 |
| 頁面與卡片的對應 | 各 wiki 的 `heptabase-map.json` | 無 |

### 2.2 只有一套收錄流程

所有來源都先變成 `raw/sources/` 裡的檔案，再交給 app 原本的收錄流程。skill 不直接寫 wiki 頁面。唯一的例外是融合產生的假說頁。

### 2.3 兩層分工

- **編譯層（app）**：需要穩定、可重複的工作。
- **搬運與融合層（skill）**：需要判斷、需要跟使用者確認、需要 Heptabase MCP 的工作。

### 2.4 人核准

下列動作一律由使用者核准。核准的方式是審核佇列，或在對話中確認：

- 新增領域
- 從工作 wiki 抽出的新機制寫進閱讀 wiki
- 深度研究的結果寫進 wiki
- 切分領域的計畫（在對話中確認）
- 使用者修改過的 `#wiki` 複本卡片

### 2.5 對新的 AI session 友善

- 給 AI 讀的規則檔用 ASD-STE100 風格的英文寫（下稱「STE 英文」）。
- 每個術語只在 `docs/glossary.md` 定義一次。其他檔案只引用。
- `CLAUDE.md` 與 `AGENTS.md` 只列出閱讀順序。
- 每種頁面類型有一份規則檔。頁面的 `type:` 直接對應到規則檔的路徑。

### 2.6 少改上游檔案

本 fork 要能繼續合併上游（nashsu/llm_wiki）的更新。

- 新功能放在新檔案。
- 修改上游檔案時，只改最小的接點。例如在 `buildAnalysisPrompt` 裡加一段，不重寫整個函式。

### 2.7 模板不放個人資料

本 repo 是公開模板。使用者的資料放在另外的 private repo。

- 模板裡沒有任何 Heptabase 白板 ID、卡片 ID、卡片標題。
- 範例只用公開或自己編的內容。

---

## 3. 詞彙表

下列定義是 `docs/glossary.md` 的初稿。實作時改寫成 STE 英文。

| 詞 | 定義 |
|---|---|
| wiki | 一個資料夾。裡面有 `raw/`、`wiki/` 與設定檔。一個 wiki 是 app 裡的一個「專案」 |
| 閱讀 wiki | 存放日常閱讀與興趣的 wiki。機制庫在這裡 |
| 工作 wiki | 存放工作資料的 wiki。它引用閱讀 wiki 的機制庫 |
| 來源 | `raw/sources/` 裡的一個檔案 |
| 原文 | 外部作者寫的來源。它是證據 |
| 想法 | 使用者自己寫的來源。它是觀點 |
| 領域 | `domains.yaml` 裡的一條路徑，例如 `hardware/async-circuits`。對索引、健檢與 Heptabase 來說，假說頁的領域是 `to_domain` |
| 透鏡 | 一份檔案。它說明機制的每個欄位在某個領域裡是什麼意思，以及這個領域的證據標準 |
| 機制 | 一種跨領域重複出現的結構。它只寫組成、流動、約束與取捨、為什麼有效、失效條件 |
| 實例 | 某個領域裡符合某個機制的具體東西 |
| 融合 | 把一個機制套到另一個領域，寫成假說頁 |
| 假說頁 | 融合的成品。它說明哪些部分套得上，哪些部分套不上，要驗證什麼 |
| 關係 | 兩個領域之間的關係。有兩種：類比、堆疊 |
| 類比 | 從一個領域借用機制到另一個領域 |
| 堆疊 | 一個領域是另一個領域的底層（base layer）。另一個領域是上層（upper layer） |
| 類比強度 | 三級：`surface`（字面相似）、`structural`（結構對應）、`mathematical`（數學同構）。堆疊時：`surface` 只知道有一般的依賴，`structural` 是上層每個組成都對應到底層的具名組件，`mathematical` 是底層的方程式或取捨曲線決定上層的行為 |
| 複本卡片 | AI 從 wiki 頁面建立的 Heptabase 卡片。它在 `#wiki` tag 裡 |
| 卡片對照表 | `heptabase-map.json`。它記錄頁面與卡片的對應，以及同步狀態 |
| 審核佇列 | app 既有的 review 功能 |

---

## 4. 整體架構

### 4.1 三種 repo

| repo | 公開或私人 | 內容 |
|---|---|---|
| 本 fork（模板） | 公開 | app 程式碼、Claude Code plugin `plugins/llm-wiki/`（skill）、`wiki-tool` 工具（Heptabase 部分是 `hepta` 指令群）、透鏡範本、wiki 模板、範例 wiki |
| 閱讀 wiki | 私人 | 原始資料、wiki、規則檔、Heptabase 設定、卡片對照表、機制庫 |
| 工作 wiki | 私人 | 同上，但沒有機制庫。設定裡指向閱讀 wiki 的機制庫 |

### 4.2 資料流

```
網頁剪藏 / PDF ──────┐
Heptabase 卡片 ──────┴→ raw/sources/（卡片是快照，卡片修改後會更新）
                         → 收錄（含領域判斷、機制抽取、來源去重）
                         → wiki/ → git commit
                                     │
        有整合價值的頁面（機制、假說、比較、2 個以上來源的概念）
                                     ↓
              Heptabase 複本卡片（#wiki，唯讀，連回原始卡片）
              每頁最多一張卡片，由卡片對照表管理

工作白板 → wiki-fuse → wiki/hypotheses/ → git commit
                                        → 一張假說卡片，放到工作白板上
```

### 4.3 執行環境

- app 平常縮在系統匣。app 已有 `tauri-plugin-autostart`，可以設成開機自動啟動。
- 使用者日常在 Heptabase 思考，在 Claude Code 叫 AI 做事。
- Claude Code 需要安裝兩個 plugin：Heptabase 官方 plugin，以及本 fork 的 plugin。
- 每個 skill 開始時，先用 `llm_wiki_status` 檢查 app 是否在執行。app 沒有執行時，skill 告訴使用者，並停止需要 app 的步驟。

---

## 5. wiki 資料模型

### 5.1 wiki 資料夾

```
<wiki>/
  CLAUDE.md                 只列閱讀順序（STE 英文）
  AGENTS.md                 同上，給 Codex
  purpose.md                這個 wiki 為什麼存在（app 既有）
  schema.md                 規則檔入口（app 既有，改寫成 STE 英文）
  domains.yaml              領域清單
  heptabase.yaml            Heptabase 設定
  heptabase-map.json        卡片對照表（工具產生）
  .claude/settings.json     背景執行 skill 時允許的工具
  schema/
    page-types/<type>.md    每種頁面類型一份規則檔
    writing-rules.md        中文寫作規則
  lenses/<lens>.md          透鏡
  docs/glossary.md          詞彙表
  raw/sources/
    heptabase/<卡片ID>.md   Heptabase 卡片快照
  wiki/
    index.md                總目錄：領域樹與頁數（程式產生）
    indexes/<領域>.md       各領域目錄（程式產生）
    overview.md
    log.md
    sources/ entities/ concepts/ comparisons/ queries/
    mechanisms/             只有閱讀 wiki 有
    hypotheses/
```

`schema.md`、`purpose.md` 放在專案根目錄。app 的 `ingest.ts` 目前從 `${project}/schema.md` 與 `${project}/purpose.md` 讀取。

### 5.2 頁面不照領域分資料夾

- 資料夾只照頁面類型分。
- 領域寫在頁面開頭的 `domain:` 欄位。
- 目錄頁照領域樹分層，由程式產生。
- 理由：使用者常切分、合併領域。照領域分資料夾時，每次切分都要搬檔案、修連結、改對照表。

### 5.3 `domains.yaml`

它是領域的正式清單。AI 收錄時只能從這份清單選領域。

```yaml
version: 1
domains:
  hardware/async-circuits:
    lens: hardware
    description: 沒有全域時鐘的數位電路
    whiteboards: []          # 選填。只當提示用
  ai/architecture:
    lens: ai
    description: 模型架構與訓練、推論方式
    whiteboards: []
```

規則：

- 領域名稱用小寫英文與 `/`、`-`。
- 一個領域只有一個名稱。
- 清單裡沒有適合的領域時，AI 送出 `new-domain` 審核項目。使用者核准後，app 把它寫進清單。
- `whiteboards:` 只當提示。它用來產生第一版清單，以及推測卡片的預設領域。

理由：每次收錄是一次獨立的 AI 呼叫。沒有正式清單時，AI 會為同一個領域取不同的名稱，例如 `business/hotel` 與 `business/hospitality`。

### 5.4 頁面開頭欄位

在既有欄位（`type`、`title`、`tags`、`related`、`sources`、`created`、`updated`）之外新增：

| 欄位 | 用在 | 必填 | 說明 |
|---|---|---|---|
| `domain` | 概念、實體、來源、比較、查詢 | 是 | 一條領域路徑 |
| `also` | 同上 | 否 | 也相關的領域 |
| `lenses` | 機制 | 是 | 這個機制目前用到的透鏡 |
| `instances` | 機制 | 是 | 實例頁面的 slug |
| `mechanism` | 假說 | 是 | 機制頁的引用。跨 wiki 時寫成 `reading:<slug>` |
| `from_domain`、`to_domain` | 假說 | 是 | 來源領域與目標領域。堆疊時，來源是底層，目標是上層（R17）。索引、健檢與 Heptabase 以 `to_domain` 為假說頁的領域（R19） |
| `relation` | 假說 | 是 | `analogy` 或 `stack` |
| `strength` | 假說 | 是 | `surface`、`structural`、`mathematical` |
| `status` | 假說 | 是 | `draft`、`testing`、`supported`、`refuted` |
| `heptabase_whiteboard` | 假說 | 否 | 來自哪張工作白板 |
| `source_kind` | 來源 | 是 | `article`（原文）或 `note`（想法） |

`wiki-page-types.ts` 新增 `mechanism` 與 `hypothesis` 兩種類型，以及 `mechanisms/`、`hypotheses/` 兩個資料夾。

### 5.5 防止不同領域混在同一頁

- 概念頁與實體頁只屬於一個領域。
- 兩個領域有同名概念時，拆成兩頁。只有新的同名頁加上後綴 `--<最後一段領域>`，既有檔名不改。例如 `attention` 已在 `ai`，新頁在 `cognition`，檔名是 `attention--cognition`。兩頁的開頭互相註明（R11）。
- 後綴檔名已存在時，改用完整領域路徑，把領域裡的每個 `/` 換成 `--`。例如 `ai/architecture` 的 `attention` 寫成 `attention--ai--architecture`。
- 收錄一次寫整個檔案，不能改名。幫舊頁補上後綴，屬於 `wiki-recut`（R11）。
- 只有機制頁可以跨領域。機制頁不寫產業或領域的細節。實例只用連結。
- 既有的收錄規則已要求「說法要留在它描述的主體上」。本設計把這條規則延伸到領域。

### 5.6 機制頁

機制頁的骨架對所有領域都一樣。每一欄的意思由透鏡決定。

```markdown
---
type: mechanism
title: 事件驅動計算
lenses: [hardware, ai]
instances: [async-handshake, spiking-neural-network]
sources: [...]
---
# 事件驅動計算

一句話：沒有全域時鐘，有變化才計算。

## 組成
## 流動
## 約束與取捨
## 為什麼有效
## 失效條件
## 已知實例
- [[spiking-neural-network]]（ai/architecture）：叫「脈衝」
- [[async-handshake]]（hardware/async-circuits）：叫「request/ack」
```

規則檔 `schema/page-types/mechanism.md` 說明每一欄要寫什麼、不要寫什麼、長度，並附一個完整範例與檢查清單。

### 5.7 透鏡

透鏡用 STE 英文寫。每份透鏡包含：

1. 用途：什麼情況下使用這份透鏡。
2. 欄位：組成、流動、約束與取捨、為什麼有效，在這個領域分別指什麼。每一欄附「寫什麼」與「不要寫什麼」。
3. 證據標準：這個領域的證據由強到弱怎麼排。
4. 一個完整範例。

模板附四份透鏡：`business`、`physics`、`hardware`、`ai`。使用者可以自己新增。

### 5.8 假說頁

```markdown
---
type: hypothesis
title: ...
mechanism: reading:<slug>
from_domain: ...
to_domain: ...
relation: analogy
strength: structural
status: draft
heptabase_whiteboard: <白板 ID>
---
# ...

## 一句話假說
## 角色對照表
| 機制的部分 | 目標領域的對應 | 套得上嗎 | 原因 |
## 套不上的部分與影響
## 要驗證的事
| 主張 | 需要什麼證據 | 怎樣算推翻 |
## 建議搜尋關鍵字
## 相關頁面
```

規則：

- 每個主張都要引用 wiki 頁面。
- 引用不到頁面的主張，只能寫在「要驗證的事」。
- 「怎樣算推翻」不能空白。
- 堆疊（`relation: stack`）時，`from_domain` 是底層（base layer），`to_domain` 是上層（upper layer）（R17）。
- `status` 的條件（R18）：
  - `draft`：已寫成，尚未測試。
  - `draft` 變 `testing`：「要驗證的事」至少有一列連到含證據的查詢頁。
  - `supported`：每一列都由目標領域透鏡證據標準的前兩級證據解決，而且至少有一列。零列的頁面維持 `testing`。
  - `refuted`：前兩級證據推翻其中一列。
- 對索引、健檢與 Heptabase 來說，假說頁的領域是 `to_domain`（R19）。機制頁沒有單一領域，不套用這條。

### 5.9 目錄拆開

- `wiki/index.md` 只列領域樹與每個領域的頁數。
- `wiki/indexes/<領域>.md` 列這個領域的頁面。
- 機制有自己的目錄 `wiki/indexes/_mechanisms.md`。
- 假說頁列在 `to_domain` 的領域目錄（R19）。
- 收錄時，提示詞只放「相關領域的目錄」加「機制目錄」。理由：`boundWikiIndexForPrompt` 有 32,000 字的上限。
- 修改點：`ingest.ts` 的 `updateWikiIndexDeterministically`。新邏輯放在新檔案 `src/lib/domain-index.ts`。

### 5.10 語言

- 規則檔、透鏡、詞彙表、skill：STE 英文。
- wiki 頁面：使用者的語言（目前是繁體中文）。遵守 `schema/writing-rules.md`：一詞一義、短句、主動語態、一句只講一件事、先講結論。
- ASD-STE100 原文不放進任何 repo。版權屬於 ASD，轉載需要書面授權。`schema/writing-rules.md` 只放我們自己寫的摘要，註明出處與版本。使用者可以把向 ASD 取得的原文放在本機，路徑寫在設定裡，並加進 `.gitignore`。

---

## 6. 收錄

### 6.1 入口 1：直接放檔案

app 既有的網頁剪藏、PDF、資料夾匯入，維持不變。

### 6.2 入口 2：Heptabase

由 `wiki-sync` 的「往上」方向處理（見 7.5）。

- 只收錄有 `#ingest` tag 的卡片。
- 來源型白板可以設成「整張白板自動收錄」。預設關閉。
- 每張卡片存成 `raw/sources/heptabase/<卡片ID>.md`。開頭記錄：卡片 ID、標題、所在白板、最後修改時間、網址、`source_kind`。
- `source_kind` 的判斷順序：
  1. 網頁卡片或 PDF 卡片：`article`。
  2. 在來源型白板上：`article`。
  3. 其他：`note`。
- `note` 的內容收錄時要寫明「這是使用者的看法」，不能寫成事實。
- PDF 卡片：下載原檔放進 `raw/sources/`，交給 app 既有的 PDF 解析。

### 6.3 來源去重

app 既有的去重只比對同一個檔名的內容。它抓不到「同一篇文章從兩個入口各進來一次」。新增來源指紋：

1. 先比對網址。比對前去掉追蹤參數與結尾斜線。
2. 網址比不到時，比對清理過的內文。用 shingle 相似度，門檻預設 0.85。
3. 判定重複時：不收錄第二次。在既有的來源頁記下另一個入口。
4. 新版本比較完整時，送出 `duplicate-source` 審核項目。

新檔案：`src/lib/source-fingerprint.ts`。指紋存在 `.llm-wiki/source-fingerprints.json`。

### 6.4 收錄提示詞的修改

修改 `src/lib/ingest.ts`：

| 函式 | 修改 |
|---|---|
| `buildAnalysisPrompt` | 新增「Domain」段：從 `domains.yaml` 選領域，或提議新領域。新增「Mechanisms」段：照通用骨架抽取，欄位意思依透鏡解讀，並檢查機制目錄裡是否已有同樣的機制 |
| `buildGenerationPrompt` | 新增機制頁的規則。閱讀 wiki：寫機制頁，或在既有機制頁的「已知實例」補一筆。工作 wiki：不寫機制頁，改送 `new-mechanism` 審核項目 |
| `buildChunkAnalysisSystemPrompt` | 長文件分段分析時，同樣加入領域與機制 |
| 目錄放入提示詞的方式 | 改成相關領域的目錄加機制目錄 |

提示詞的新段落放在新檔案 `src/lib/mechanism-prompts.ts`。`ingest.ts` 只呼叫它。

### 6.5 每次收錄一個 git commit

- 收錄成功時，做一次 commit。訊息：`ingest: <標題> (<N> pages)`。內文列出改了哪些頁面。
- 收錄失敗時，不做 commit。把改到一半的檔案還原成上一次 commit 的狀態。
- wiki 資料夾還不是 git repo 時，第一次收錄前先問使用者要不要初始化。
- 接點：app 既有的 `IngestCommitCoordinator` 依序處理每次收錄的寫入。git commit 接在一次寫入完成之後。
- git 操作放在 Rust 新指令 `src-tauri/src/commands/git_history.rs`，用系統的 `git` 執行檔。
- 融合、切分領域、健檢的自動修正，也各做一次 commit，訊息前綴分別是 `fuse:`、`recut:`、`lint:`。

### 6.6 審核項目新增類型

| 類型 | 來自 | 選項 |
|---|---|---|
| `new-domain` | 收錄 | 核准、改用既有領域、略過 |
| `new-mechanism` | 工作 wiki 的收錄、融合 | 寫進閱讀 wiki、略過 |
| `duplicate-source` | 來源去重 | 換成新版本、略過 |
| `mirror-edited` | `wiki-sync` | 當作意見收錄、捨棄修改 |
| `fusion-candidate` | 收錄產生新機制時 | 開始融合、略過 |
| `research-result` | 深度研究 | 寫進 wiki、略過 |

既有的審核項目只允許 `Create Page` 與 `Skip` 兩個選項。新類型需要擴充 `review-store` 的選項定義。

---

## 7. Heptabase 接口

### 7.1 已查證的 Heptabase MCP 能力（2026-10-23）

| 動作 | 能做嗎 | 備註 |
|---|---|---|
| 讀白板結構 | 能 | 回傳區塊與卡片的標題、ID。沒有座標 |
| 讀心智圖裡的卡片 | 能 | 白板結構只列出心智圖本身。要另外讀心智圖才拿得到卡片 |
| 讀卡片內容 | 能 | 長內容要分頁讀 |
| 查一張卡片在哪些白板上 | 能 | `list_cards` 加 `include: whiteboards` |
| 建立卡片 | 能 | 第一行 H1 是標題 |
| 修改卡片內容 | 能 | 只能用「找出原文再替換」的方式 |
| 把卡片放上白板 | 能 | 每執行一次就多放一張。重試會重複 |
| 把卡片加進 tag | 能 | |
| 把卡片移出 tag | 不能 | |
| 建立 tag、白板、區塊 | 不能 | |
| 修改卡片欄位 | 能 | 下拉選單只能選既有的選項 |
| 新增下拉選項 | 不能 | |
| 刪除卡片 | 不能 | |
| 卡片之間的連線 | 未查證 | 測試白板上沒有連線 |

卡片連結的格式是 `[標題](heptabase://card/<uuid>)`。

### 7.2 三個部分

| 部分 | 位置 | 負責 |
|---|---|---|
| `wiki-sync` skill | 本 fork 的 Claude Code plugin | 呼叫 Heptabase MCP，執行計畫 |
| `wiki-tool` 工具 | `tools/wiki-tool/`（Node + TypeScript） | 產生同步計畫、格式轉換、連結轉換、更新對照表。Heptabase 部分是 `hepta` 指令群 |
| 設定與對照表 | 各 wiki 的 `heptabase.yaml`、`heptabase-map.json` | 設定，以及同步狀態 |

流程是「規劃、執行、記錄」：

1. `wiki-tool hepta plan` 產生計畫檔。
2. skill 照計畫呼叫 MCP。
3. 每完成一個動作，skill 馬上執行 `wiki-tool hepta record`。

理由：中途失敗時，重跑會從斷掉的地方繼續。「放上白板」重試會重複，所以一定要先記錄再重試。

### 7.3 `heptabase.yaml`

```yaml
version: 1
wiki_id: reading              # reading、work、或其他
mechanism_library: null       # 工作 wiki 填閱讀 wiki 的路徑
roots:                        # 這些白板底下的卡片屬於這個 wiki
  - <whiteboard-id>
whiteboards:                  # 白板類型。沒列的白板視為 topic
  <whiteboard-id>: { kind: source, auto_ingest: false }
  <whiteboard-id>: { kind: archive }
tags:
  ingest: <tag-id>            # 使用者加在卡片上
  mirror: <tag-id>            # 複本卡片
properties:                   # #wiki 的欄位 ID
  domain: <property-id>
  page_type: <property-id>
  wiki: <property-id>
  status: <property-id>
  wiki_page: <property-id>
  last_synced: <property-id>
  hypothesis_status: <property-id>
  strength: <property-id>
```

白板類型：`topic`（主題）、`source`（來源）、`project`（專案）、`archive`（封存，不參與同步）。

`wiki-tool hepta init` 讀取使用者的 tag 與欄位，產生這份檔案的初稿。

### 7.4 往下：wiki → Heptabase

1. 挑出要同步的頁面：機制、假說、比較，以及 `sources` 有 2 個以上的概念。
2. 用內容雜湊比對上次同步。只處理有變動的頁面。
3. 新頁面：
   1. 建立卡片。
   2. 加進 `#wiki`。
   3. 填欄位：`domain`、`page type`、`wiki`、`status`、`wiki page`、`last synced`。假說的 `domain` 填 `to_domain`（R19）。假說另外填 `hypothesis status`、`strength`。
   4. 記錄。
   5. 互相連結的新頁面分兩輪：先全部建立，再補連結。
4. 有變動的頁面：
   1. 讀卡片。
   2. 卡片在上次同步後被使用者修改過：不覆蓋。把修改存成 `raw/sources/heptabase/feedback-<卡片ID>-<時間>.md`，送出 `mirror-edited` 審核項目。
   3. 沒被修改過：替換內容，更新 `last synced`。
5. 頁面被合併或刪除：標題加「🗄 已停用」，`status` 設為 `retired`，內容換成一行「請看 → 新卡片」。健檢會列出這些卡片，請使用者手動刪除。
6. 複本卡片的底部：列出來自哪些 Heptabase 卡片，加一行「由 wiki 產生，請勿直接編輯」。
7. 複本卡片不放到任何白板上。使用者在 `#wiki` 的表格或看板瀏覽。
8. 下拉選項不存在時（例如新領域），skill 停下這張卡片，請使用者在 Heptabase 新增選項。

連結轉換：

- `[[slug]]` 指向已同步的頁面：轉成 Heptabase 卡片連結。
- 指向沒有同步的頁面：轉成純文字標題，後面加「（僅在 wiki）」。

### 7.5 往上：Heptabase → wiki

1. 找出有 `#ingest` 的卡片，以及開啟自動收錄的來源型白板上的卡片。只看上次同步後有修改的卡片。
2. 判斷卡片屬於哪個 wiki：看它在哪個根白板底下。兩邊都有或都沒有時，問使用者。
3. 讀完整內容。展開心智圖。轉成 markdown。存成快照。
4. PDF 卡片：下載原檔。
5. 記錄卡片的最後修改時間。
6. 之後交給 app 收錄。

`#ingest` 的意思是「這張卡片在 wiki 裡」。AI 不能把卡片移出 tag，所以這個 tag 會一直留著。卡片之後有修改，同步時會更新快照並重新收錄。

### 7.6 `heptabase-map.json`

```json
{
  "version": 1,
  "pages": {
    "wiki/mechanisms/event-driven.md": {
      "card_id": "<uuid>",
      "content_hash": "<sha256>",
      "last_synced_at": "<ISO 時間>",
      "card_updated_at": "<ISO 時間>",
      "placements": ["<whiteboard-id>"],
      "status": "active"
    }
  },
  "sources": {
    "<card-id>": {
      "raw_path": "raw/sources/heptabase/<card-id>.md",
      "card_updated_at": "<ISO 時間>",
      "ingest_commit": "<git sha>"
    }
  },
  "whiteboards_cache": {
    "updated_at": "<ISO 時間>",
    "items": [{ "id": "<uuid>", "title": "...", "parent": "<uuid>" }]
  }
}
```

`whiteboards_cache` 給 Skill 面板的白板選單使用。每次同步時更新。

### 7.7 安全規則

- AI 只修改對照表裡有的卡片。使用者的卡片一律只讀。
- AI 可以把使用者的卡片加進 `#ingest`，但只在使用者要求時。
- MCP 回傳 `clientTaskFailed` 時，照工具說明改用伺服器模式重試一次。
- 往下同步不需要 app 執行。往上同步只寫檔案。收錄要等 app 執行。

---

## 8. 融合

### 8.1 指定模式

觸發：Skill 面板的按鈕，或 `/wiki-fuse <白板>`。

1. 讀白板。展開心智圖。
   - 有名稱開頭為「來源」與「目標」的區塊時，照區塊配對。
   - 沒有時，AI 推測配對，先跟使用者確認。
2. 找出卡片對應的 wiki 頁面。
   - 複本卡片：查對照表的 `pages`。
   - 使用者的卡片：查對照表的 `sources`，再找它產生的頁面。
   - 沒收錄的卡片：問使用者要不要先收錄。
3. 找出來源那一側的機制。找不到時，抽出一個候選機制，送出 `new-mechanism` 審核項目。
4. 判斷關係：類比或堆疊。堆疊時，來源領域是底層（base layer），目標領域是上層（upper layer）（R17）。
5. 逐一套用：機制的每個組成、流動、約束，在目標領域找對應。參考機制頁的「失效條件」。
6. 判斷類比強度。`strength` 依目標領域透鏡的「強度規則」（Strength rules）決定。它衡量的是對應的種類。證據只決定角色對照表的「套得上嗎」欄與 `status`，不決定 `strength`（R16）。
7. 寫假說頁到目標 wiki 的 `wiki/hypotheses/`。git commit：`fuse: <標題>`。
8. 建立假說卡片，加進 `#wiki`，放到這張工作白板上，記錄進對照表。

驗收：假說頁的品質要接近使用者手工整理的融合分析。使用者會在自己的 private wiki 指定一個手工範例當對照。

### 8.2 發散模式

- 收錄產生新機制時，自動送出一筆 `fusion-candidate` 審核項目。裡面最多 3 組候選。
- 使用者也可以手動執行 `/wiki-fuse --explore`。一次最多 5 組。
- 排序依據：
  1. 透鏡對得上，而且還沒有這個機制實例的領域。
  2. 使用者最近有修改的工作白板。
- 使用者選一組，就進入指定模式。
- 被略過的候選記在 `.llm-wiki/fusion-dismissed.json`，之後不再提出。

### 8.3 深度研究

查證結果：app 目前把研究結果直接寫成 `wiki/queries/` 的頁面，不走收錄。原作者刻意這樣做，避免重複的摘要頁與不斷衍生的審核項目。

本設計保留「不走收錄」，但加上核准：

1. 假說頁「要驗證的事」的每一項，都可以觸發深度研究。
2. 研究結果先寫到 `.llm-wiki/research-staging/`，送出 `research-result` 審核項目。
3. 使用者核准後，才寫進 `wiki/queries/`，並連到假說頁。
4. `/wiki-fuse --update <假說>` 讀新的查詢頁，重新評估，依 5.8 的條件更新 `status`（R18）。

### 8.4 跨 wiki 規則

- 融合可以同時讀閱讀 wiki 的機制與工作 wiki 的頁面。
- 假說頁只寫進目標 wiki。
- 工作 wiki 的假說不連回閱讀 wiki 的機制頁。理由：避免工作內容進到閱讀 wiki。
- 閱讀 wiki 自己內部的融合，機制頁可以列出相關假說。

---

## 9. 健檢與切分領域

### 9.1 健檢四層

| 層 | 用 AI 嗎 | 範圍 | 檢查 |
|---|---|---|---|
| 1 結構 | 否 | 整個 wiki | 既有項目，加上：`domain` 缺漏或不在清單、概念頁的來源跨領域、機制沒有實例、已停用的複本卡片、對照表指向不存在的頁面、假說停在 `draft` 太久、領域太大或太小 |
| 2 領域內語意 | 是 | 一次一個領域，讀完整頁面 | 矛盾、被新來源取代的說法、重複頁面（沿用 `dedup.ts`） |
| 3 機制層 | 是 | 機制頁全文加實例摘要 | 機制混進領域細節、兩個機制其實相同、實例套不上、缺少失效條件 |
| 4 跨領域 | 不做 | — | 只透過第 3 層 |

- 第 1 層的門檻預設值：假說停在 `draft` 超過 30 天、領域超過 200 頁、領域少於 3 頁。門檻寫在 `schema.md`，使用者可以調整。
- 第 1 層：每次收錄後自動執行。計算領域頁數時，假說頁算在 `to_domain`（R19）。
- 第 2、3 層：使用者按按鈕或執行 `/wiki-lint`。距離上次語意健檢累積 10 次收錄時，提醒使用者。
- 平常只檢查上次健檢後有變動的領域，用 git 紀錄判斷。也可以手動要求全部檢查。
- 一個領域的內容一次放不下時，依頁面類型分批。
- 自動修正只限結構問題，例如重新產生目錄。語意問題一律送進審核佇列。
- 既有的語意健檢（`runSemanticLint`）只讀每頁前 500 字。新的第 2 層取代它。新邏輯放在 `src/lib/lint-domain.ts`、`src/lib/lint-mechanism.ts`。

### 9.2 切分領域（`wiki-recut`）

四種操作：改名、拆分、合併、移動。流程是「AI 規劃、使用者確認、執行、一次 commit」。

| 操作 | wiki | Heptabase |
|---|---|---|
| 改名 | 改 `domains.yaml`、頁面的 `domain` 與 `also`、重新產生目錄 | 使用者改選項名稱。卡片自動跟著改 |
| 拆分 | AI 提議每頁的新領域與理由。判斷不了的問使用者。一頁混了兩個新領域時，改寫成兩頁，先送審核 | 使用者新增選項。AI 修改卡片欄位 |
| 合併 | 兩邊同名的頁面列為合併候選，送審核 | AI 修改卡片欄位 |
| 移動 | 同改名 | 同改名 |

- 退回：`/wiki-undo` 反轉那次 commit。Heptabase 欄位不在 git 裡。退回後的下一次同步，會把 wiki 的值寫回卡片。

---

## 10. Skill 與 Skill 面板

### 10.1 Skill 清單

全部放在本 fork 的 Claude Code plugin `plugins/llm-wiki/` 裡。結構參考 Heptabase 官方 plugin。全部用 STE 英文寫。

| Skill | 用途 | 面板執行方式 |
|---|---|---|
| `wiki` | 總選單。列出全部 skill 與一句說明 | — |
| `wiki-sync` | Heptabase 雙向同步 | 背景 |
| `wiki-fuse` | 融合（指定、發散、更新） | 開啟對話 |
| `wiki-lint` | 第 2、3 層健檢 | 背景 |
| `wiki-recut` | 切分領域 | 開啟對話 |
| `wiki-undo` | 退回指定的 commit | 開啟對話 |

### 10.2 Skill 面板

- app 側邊欄新增「Skills」。
- 按鈕資訊放在 `plugins/llm-wiki/panel.yaml`：中文按鈕名稱、執行方式、需要的輸入。skill 本身的說明只寫在 `SKILL.md`。
- **背景**：app 用既有的 `claude_cli.rs` 執行 `claude -p`。進度顯示在活動面板。
- **開啟對話**：app 開一個終端機視窗，執行互動式 Claude Code，並帶好指令。理由：背景模式不能停下來問使用者問題。
- 白板選單：讀對照表的 `whiteboards_cache`。app 本身連不到 Heptabase。
- 權限：wiki 模板附 `.claude/settings.json`，只允許 Heptabase MCP 工具、llm_wiki MCP 工具、`wiki-tool`。

### 10.3 app 介面的其他修改

- wiki 頁面編輯器改成唯讀。理由：手動修改會繞過收錄流程。
- 新增「建立機制 wiki」專案模板（`templates.ts`），內含第 5 章的資料夾與檔案。

---

## 11. 測試

### 11.1 自動測試（vitest，`npm run test:mocks`）

| 對象 | 測試內容 |
|---|---|
| 收錄提示詞 | 新段落存在。既有規則沒有被改壞 |
| 領域目錄 | 用範例 wiki 產生總目錄與各領域目錄 |
| 來源指紋 | 同一篇文章的兩種格式判定重複。不同文章不誤判 |
| git 紀錄 | 收錄成功、收錄失敗還原、退回。在暫存 repo 裡執行 |
| 結構健檢 | 每個新項目各有一個會被抓到的案例 |
| `wiki-tool hepta` | markdown 與 Hepta Markdown 互轉、連結轉換、同步計畫、偵測使用者修改、中斷後繼續 |
| Heptabase 回應 | 用真實回應格式做測試資料。去掉白板名稱、卡片標題與 ID |

CI 目前只檢查建置（`vite build`、`cargo build`）。本設計不改 CI。測試在本機執行。

### 11.2 範例 wiki

`examples/sample-wiki/`：只用公開或自己編的內容。至少兩個領域，共享一個機制。

### 11.3 完整情境測試

1. 收錄兩篇不同領域、但有共同機制的範例文章。
2. 產生一個機制頁，有 2 個實例。
3. 同步到 Heptabase 的測試 tag。
4. 在測試白板做一次融合，產生假說卡片。
5. 退回，確認 wiki 恢復原狀。

### 11.4 Heptabase 實測

- 使用者準備一張測試白板與一個測試 tag `#wiki-test`。測試 tag 的欄位與正式 `#wiki` 相同。
- 測試只碰這張白板、這個 tag，以及使用者指定的卡片。
- 測試用的 wiki 不進公開 repo。
- AI 不能刪除卡片。測試結束後，使用者手動刪除測試卡片。

### 11.5 只能在使用者電腦上確認

- Skill 面板的外觀與操作。
- 開啟終端機視窗。
- 開機自動啟動。

---

## 12. 子專案與順序

每個子專案各自有實作計畫，依序執行。

| # | 子專案 | 主要產出 | 依賴 |
|---|---|---|---|
| 0 | 模板骨架 | plugin 骨架 `plugins/llm-wiki/`、`docs/glossary.md`、`schema/`、`domains.yaml` 與 `heptabase.yaml` 的格式與驗證、`CLAUDE.md` 入口、範例 wiki、專案模板 | 無 |
| 1 | git 紀錄 | 每次收錄一個 commit、失敗還原、`wiki-undo` | 0 |
| 2 | 機制層收錄 | 領域判斷、機制抽取、頁面類型、分領域目錄、來源指紋、新審核類型、深度研究暫存 | 0、1 |
| 3 | Heptabase 接口 | `wiki-tool` 工具（`hepta` 指令群）、`wiki-sync` skill | 2 |
| 4 | 融合 | `wiki-fuse` skill（指定、發散、更新） | 2、3 |
| 5 | 健檢與切分 | 第 1–3 層健檢、`wiki-lint`、`wiki-recut` | 2 |
| 6 | Skill 面板 | 面板、`panel.yaml`、`wiki` 總選單、編輯器唯讀 | 3、4、5 |

---

## 13. 開工前要查證的事

| 項目 | 狀態 | 影響 |
|---|---|---|
| 開機自動啟動 | 已查證：有 `tauri-plugin-autostart` | 只需要在設定裡開啟 |
| 審核項目能否從外部處理 | 部分查證：HTTP API 有 `reviews/resolve` 與 `PATCH reviews/<id>` | 子專案 6 決定要不要讓 Claude Code 直接處理審核 |
| 深度研究的寫入方式 | 已查證：直接寫 `wiki/queries/` | 8.3 已調整 |
| `claude -p` 能否使用 MCP 工具 | 部分查證：預設不隔離本機設定 | 子專案 6 要實測權限 |
| 跨平台開啟終端機 | 未查證 | 子專案 6 |
| 「替換整段內容」在卡片上是否可行 | 未查證 | 子專案 3。不可行時改成逐段替換 |
| 卡片連線的資料格式 | 未查證 | 目前設計不依賴連線 |
| 資料夾監看在 app 重開時是否補收錄 | 未查證 | 子專案 3。不補時，skill 改呼叫 `llm_wiki_rescan_sources` |
| `wiki/schema.md` 的用途（`ingest.ts` 第 3663 行） | 未查證 | 子專案 0 |

---

## 14. 風險與取捨

| 風險 | 處理 |
|---|---|
| AI 寫、AI 讀、AI 查，錯誤會自我強化 | git 紀錄、審核佇列、類比強度、「怎樣算推翻」、機制入庫要核准。風險只能降低，不能消除 |
| 兩個 AI 寫 wiki（app 收錄、Claude Code 融合） | 兩邊共用同一份規則檔與頁面類型規則 |
| app 沒開時收錄不會發生 | 開機自動啟動。skill 開始前檢查 |
| 功能變多，跟上游合併變難 | 新功能放新檔案。上游檔案只改最小接點 |
| Heptabase MCP 的權限可能改變 | 7.1 記錄查證日期。設計把 MCP 呼叫集中在 skill，格式轉換集中在 `wiki-tool hepta` |
| 複本卡片累積成孤兒 | 停用標記，健檢列出，使用者手動刪除 |
| 新領域要手動加下拉選項 | skill 會提醒。使用者也可以把 `domain` 改成文字欄位，換取全自動 |
