# ArcLog 練投紀錄員：實作計畫

## 目前進度（2026-11-14 暫停，尚未完成）

**一句話**：階段 0 到 3（核心計算、網站、階段 A 模型）已完成並驗證；階段 4（訓練流程）的程式都寫好、單元測試通過；
階段 5（合成資料從訓練到部署）只做到一半；階段 6（最後的整套實測、文件定稿、開 PR）還沒做。**PR 還沒開。**

進度都在 `feat/arclog-mvp` 分支上，已推到遠端。最後一個程式提交是 `c9bc2fe`。

### 已完成，而且驗證通過

| 項目 | 怎麼驗證的 | 是在哪個狀態下驗證的 |
|---|---|---|
| 核心純函式（JS 和 Python），共用測試向量 | `npm test` 50 項、`python -m pytest` 73 項，全部通過。已知角度的合成軌跡（含雜訊）誤差 < 1 度；JS 和 Python 結果一致到 1e-6 | 目前的提交 `c9bc2fe` |
| 逐幀定位（WebCodecs 和 `<video>` 兩個引擎 × 8 支條碼測試影片） | 瀏覽器實測 16 項通過 | `53d9579`（之後沒有改這部分，但也沒有重跑） |
| 網站：示範模式半自動 → 報告、CSV 匯出再匯入、標註包、報告圖片、歷次紀錄、儲存失敗、手機版面 | 瀏覽器實測 10 項通過（10 球角度誤差平均 0.28 度、最大 0.53 度） | `53d9579`，之後有改動，**要重跑**（見下一節） |
| 自動偵測：WebGPU 和 WASM 兩條路徑、取消、模型載入失敗時退回半自動 | 瀏覽器實測 10 項通過（示範影片 10 球全找到） | `53d9579`，之後有改動，**要重跑** |
| 真的 MP4 影片：瀏覽器載入（WebCodecs）→ 校正 → 逐球標記 → 匯出標註包 → `build_dataset.py` 用時間戳對齊 → `check_overlay.py` | `tests/e2e/video.e2e.mjs` 第 1 項通過：標註和真值的球心平均差 0.46 像素（最大 0.92），負樣本確實沒有球 | 目前的提交 |
| 重新整理後載入同一個檔案可以接續標記 | `tests/e2e/video.e2e.mjs` 第 2 項通過 | 目前的提交 |
| 訓練工具接得起來（不含訓練本身）：`make_synth` → `build_dataset`（以影片為單位切分）→ `check_overlay` → `evaluate`（階段 A）→ `analyze` 的錯誤處理 | `tests/py/test_pipeline.py` 6 項通過 | 目前的提交 |
| 時間戳對齊、以影片為單位切分、評估指標、「待實測」表格 | `tests/py/test_dataset.py` 21 項通過 | 目前的提交 |
| 鏡頭擺位模擬；水平基準「修正透視」在鏡頭擺正時沒有偏差；規格裡的公式（偏 10 度 +0.4 度、偏 20 度 +1.8 度）成立 | `tests/js/camera.test.mjs` 9 項通過 | 目前的提交 |
| 階段 B 的兩個公開資料集：授權、類別、影像數、版本、切分、前處理 | 2026-11-13 直接在 Roboflow 的資料集頁面上核對（記在 `docs/DATA.md`） | — |
| 暫存區沒有影片、人像、權重、金鑰 | `python tools/check_staged.py` | 每次提交前 |

### 寫好了，但還沒驗證（或只驗證到一半）

1. **瀏覽器實測沒有在目前的狀態下完整重跑。** 上一次整套執行是在 `53d9579`：36 項裡 35 項通過；
   剩下 1 項（「模型清單讀不到」）是測試在頁面還沒載入完就按按鈕造成的失敗，改了測試之後單獨重跑 3 次都通過，
   但沒有再整套跑一次。之後又改了這些會影響瀏覽器實測的地方：
   階段 A 模型的信心門檻 0.10 → 0.05、每幀最多保留的偵測數 8 → 12、實拍影片預設的水平基準改成「修正透視」
   （示範模式仍用「籃框連線」）、自動偵測顯示的運算方式文字、測試用的 Python 改成優先用 `.venv`、
   `auto.e2e.mjs` 裡一句比對模型說明文字的斷言。
2. **`tests/e2e/video.e2e.mjs` 第 3 項**（網站的自動偵測和 `tools/analyze.py` 結果一致、`analyze.py` 的 CSV 可以匯入網站）：
   跑過一次失敗，原因是測試步驟寫錯（按「全部接受」之後會回到標記頁，要再按「看報告」）。測試已經改了，**還沒重跑**。
   所以「指令工具和網站結果一致」這件事目前**沒有驗證**。
   （`analyze.py` 本身在一支 792 幀的合成影片上完整跑過一次，CSV 和檢查影片都有輸出；那次用的是舊的門檻 0.10，10 球找到 8 球。）
3. **合成資料從訓練到部署（階段 5）只做到一半**：
   - 做完的：6 支合成影片 → `build_dataset.py`（4／1／1 支，2,184 張有球、654 張負樣本）→ `check_overlay.py`（和真值平均差 1.71 像素）。
   - 沒做完的：`train.py` 在 CPU 上跑完第 1 輪、第 2 輪跑到約六成時中止（每輪約 21 分鐘）。
     所以 `train.py` 訓練結束之後的那一段程式、`export_onnx.py` 匯出單一類別模型、`evaluate.py` 比較兩個模型並寫進
     `docs/EVAL.md`、網站載入新模型（`tests/e2e/pipeline.e2e.mjs`）**都還沒跑過**。
4. **Colab notebook**（`training/arclog_train.ipynb`）：只做了靜態檢查（格式、每格程式前有中文說明、沒有金鑰）。
   **還沒有實際執行過**，本機的 `python tests/run_notebook.py` 也還沒跑。Colab 上從來沒跑過；階段 B 下載資料的那一格沒有金鑰無法測試。
5. **`training/prepare_public.py`**：只有兩個小函式有單元測試，沒有用真的 Roboflow 下載資料跑過。
6. **軌跡邏輯的壓力測試**（`node tests/js/track-stress.mjs 200`）：`docs/EVAL.md` 4.1 引用的數字是在 `54ca160` 量的。
   之後軌跡邏輯沒有改，但沒有重跑。
7. **文件是初稿**：`README.md`、`docs/SHOOTING_GUIDE.md`、`docs/DATA.md`、`docs/EVAL.md`、`docs/NEXT_STEPS.md`、`models/MODEL_CARD.md`
   都寫了，內容已經對照過目前的實際狀況（沒做完的地方有寫明），但還沒有最後通讀一次；`NEXT_STEPS.md` 提到的 PR 還不存在；
   這份文件第 4 節各階段的勾選框還沒更新。
8. **iPhone／Safari**：開發環境是 Windows，沒有實機，無法驗證。這一項最後會寫在 PR 說明裡請你實測。

### 還沒做

- 把上面第 1 到 6 項跑完、修到通過。
- `docs/EVAL.md` 第 2 節的合成資料結果表（由 `evaluate.py --write-doc` 產生）。
- 更新這份文件第 4 節的勾選框；文件最後通讀。
- 最後一次檢查暫存區、提交、推上遠端、**開 PR 到 `main`**（說明裡列出：已驗證的項目和方式、沒有驗證或只用合成資料驗證的項目、自動偵測可能失效的條件、需要你接手的步驟）。

### 和原本規格不同、需要你知道的地方

- **水平基準改了**（細節在 2.5）。模擬發現「直接用籃框兩點連線當水平」即使鏡頭擺得完全正也會高估 0.3 到 2.6 度，
  所以實拍影片的預設改成「籃框連線並修正透視」。
- **拍攝位置的建議比「罰球線正側面」多了兩點**（`docs/SHOOTING_GUIDE.md`）：腳架放在出手點和籃框的**中間**，
  而且手機**不要往上仰、不要轉向籃框**。站在罰球線側面再把鏡頭轉向場中，模擬中會高估 0.6 到 3 度。
  規格裡的公式和兩個數字照樣寫進去了，並用模擬驗證過（相機很遠時成立；實際距離還多一項透視效應）。
- 這些數字全部來自幾何模擬，不是實拍量測。

### 明天從這裡接著做（照順序）

指令在 PowerShell 裡一行一個。先進專案資料夾並啟用虛擬環境：

```powershell
cd C:\Projects\arclog
```

```powershell
.\.venv\Scripts\Activate.ps1
```

1. **確認起點是好的**（兩個都應該全部通過，共約 3 分鐘）：

   ```powershell
   npm test
   ```

   ```powershell
   python -m pytest
   ```

2. **重跑瀏覽器實測，修到通過**（約 10 分鐘；`pipeline.e2e.mjs` 在模型還沒訓練出來時會自動跳過）。
   先單獨跑昨天沒跑完的那一支，再跑整套：

   ```powershell
   node --test --test-concurrency=1 --test-reporter=spec tests/e2e/video.e2e.mjs
   ```

   ```powershell
   npm run test:e2e
   ```

3. **把合成資料的訓練到部署跑完**。`data/synth`（6 支合成影片）和 `data/dataset_synth` 還留在這台電腦上（不進版控）；
   如果不見了，照 `docs/EVAL.md` 第 2 節的前三個指令重新產生。訓練在這台電腦的 CPU 上約 65 分鐘（3 輪）：

   ```powershell
   python training/train.py --stage synthetic --data data/dataset_synth/data.yaml --epochs 3 --workers 4
   ```

   ```powershell
   python training/export_onnx.py --weights runs/arclog/synthetic/weights/best.pt --id arclog-ball-synth --stage synthetic --out-dir data/models_synth
   ```

   ```powershell
   python training/evaluate.py --dataset data/dataset_synth --truth data/synth --section synthetic --models arclog-ball-a-coco,data/models_synth/arclog-ball-synth.onnx --write-doc
   ```

   ```powershell
   node --test --test-concurrency=1 --test-reporter=spec tests/e2e/pipeline.e2e.mjs
   ```

4. **在本機把 notebook 從頭到尾執行一次**（synthetic 模式，約 10 分鐘。它會覆蓋 `runs/arclog/synthetic`，所以排在第 3 步之後）：

   ```powershell
   python tests/run_notebook.py
   ```

5. **重跑軌跡邏輯的壓力測試**，確認 `docs/EVAL.md` 4.1 的數字：

   ```powershell
   node tests/js/track-stress.mjs 200
   ```

6. **文件定稿**：`docs/EVAL.md` 第 2 節（第 3 步會自動寫入表格，再把前後文字改成「已完成」）、`README.md` 裡「只做到一半」那一句、
   `docs/NEXT_STEPS.md` 最上面的提醒、`models/MODEL_CARD.md`、這份文件第 4 節的勾選框，然後刪掉這一整節「目前進度」。

7. **收尾**：`python tools/check_staged.py` → 提交 → 推上遠端 → 開 PR 到 `main`。

只存在這台電腦上、沒有進版控的東西（換電腦或清掉 `data/` 的話要重新產生）：`data/synth`、`data/dataset_synth`、
`runs/arclog/synthetic`（中止時留下的第 1 輪權重，不能當結果用）、`data/scratch/make_nb.py`（產生 notebook 的小工具；
沒有它的話直接編輯 `.ipynb` 即可）。

---

> 以下是動工前寫好的計畫，之後照著做。每個階段結束時測試要全部通過才提交。
> 最後的實際結果（哪些驗證過、哪些沒有）寫在 PR 說明和 `docs/EVAL.md`，不會回頭把這裡改成「都完成了」。

## 1. 要做什麼

政大雄鷹籃球隊的球員把手機用腳架固定在罰球線正側面錄練投，工具算出每一球的**入框角度**和**進球與否**，產出練習報告。對標是 Noah Basketball 的 45 度參考線。單支手機側拍只量得準入框角度，所以不做深度和左右偏差。

這次要同時做好兩件事：

1. 沒有實拍影片也能展示（示範模式），拿去說服球員提供素材。
2. 拿到影片後，同一個工具就是標註工具，標出來的資料能訓練出更準的偵測模型。

## 2. 動工前查證的結果與設計決定

以下每一項都是查官方文件或在這台機器上實際跑過才定的，不是憑記憶。

### 2.1 偵測模型：YOLO26n，預設輸出＋外部 NMS，輸入 640×384

- Ultralytics 文件（2026-11 查）：最新已發布的是 **YOLO26**（2026 年 1 月），YOLO27 尚未釋出權重。套件版本 `ultralytics 8.4.211`。
- YOLO26 有兩個輸出頭。**預設**是 one-to-many，輸出 `[1, 4+類別數, N]`、需要 NMS；`nms=False` 才是免 NMS 的 `[1, 300, 6]`。（舊版 8.4.x 的預設相反，`end2end` 參數也已改名為 `nms`，所以一定要查。）已在本機匯出兩種確認形狀。
- 匯出參數（文件確認）：`format="onnx"`、`imgsz=(高, 寬)`、`simplify=True`（預設）、`opset` 預設 18、`dynamic=False`、`quantize` 取代舊的 `half`/`int8`。
- 選擇：
  - **Nano 尺寸**（2.4M 參數，ONNX 約 9.9 MB）。YOLO26n 拿掉 DFL、CPU 推論比 YOLO11n 快，訓練時的 STAL 對小物體比較有利，適合手機瀏覽器，所以不另選別的架構。
  - **預設輸出頭＋自己做 NMS**：圖裡只有 Conv、Sigmoid、Concat 這類基本運算，WebGPU 和 WASM 都穩；`nms=False` 會多出 TopK、GatherElements、Mod，在 WebGPU 上比較可能退回 CPU。單一類別的 NMS 在 JS 和 Python 各十幾行，兩邊可以寫成一樣。解碼程式兩種輸出都支援。
  - **輸入 640×384（寬×高）**：拍攝指南規定橫向 16:9，長方形輸入比 640×640 省約 40% 運算量，球在模型眼中的大小不變。直向影片仍可用，只是有效解析度較低，介面會提醒。
- 階段 A 直接用 COCO 預訓練權重的 `sports ball`（類別 32），不重新訓練。

### 2.2 瀏覽器推論：onnxruntime-web 1.31.1，檔案放進 `web/vendor/`

- WebGPU 版用 `ort.webgpu.min.mjs` ＋ `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`（28.7 MB）。
- WASM 版用 `ort.wasm.min.mjs` ＋ `ort-wasm-simd-threaded.{mjs,wasm}`（14.8 MB）。
- 在 Web Worker 裡先試 WebGPU；沒有 `navigator.gpu`、拿不到 adapter、建立 session 失敗或第一次推論失敗，就換一個新的 Worker 用 WASM。WASM 也失敗就回報錯誤、退回半自動，不卡住。
- 多執行緒 WASM 需要 `crossOriginIsolated`，所以 `web/vercel.json` 和本機伺服器都送 COOP/COEP 標頭；沒有標頭時自動變單執行緒。
- 網址加 `?backend=wasm` 可以強制走 WASM，用來驗證退回路徑。

### 2.3 逐幀定位：解封裝＋WebCodecs 為主，`<video>`＋rVFC 為退路

查證重點（來源列在 `README.md` 的參考資料）：

- 規格和 web.dev 都明說 `<video>` **不保證逐幀準確的 seek**；`seeked` 事件只代表「解到可以播」，不代表畫面已經畫出來。WebKit 有一個 2016 年至今未關的問題（bug 153588）：seek 後 `drawImage` 可能畫到上一幀，影片帶旋轉資訊時特別容易發生。
- `requestVideoFrameCallback`（Chrome 83、Safari 15.4、Firefox 132）在暫停時 seek 後會觸發一次，但要先註冊再 seek；seek 落在同一幀時不會觸發。`mediaTime` 是該幀的 PTS。Safari 在暫停 seek 下的行為沒有官方保證，網路上的回報互相矛盾。
- 沒有任何 Web API 能直接拿到幀率或每幀時間戳，一定要自己解封裝。
- WebCodecs `VideoDecoder`：Chrome 94、Safari 16.4、Firefox 130（桌面）。HEVC：Chrome 107 起（需硬體支援）、Safari 17.4 起。WebCodecs 不含解封裝，也不會自動套用旋轉。
- iPhone 特別要注意：**在 iPhone Safari 從「照片」選影片，網頁拿到的不是原檔**，系統會轉成 H.264 的相容版本，慢動作會被「烤」成 30fps 的檔案。iPhone 相機開了「自動 FPS」時，60fps 影片會在 60/30/24 之間切換（可變幀率）。

決定：

1. **主要引擎**：用 Mediabunny 1.65.2（MPL-2.0，單一 ESM 檔，放進 `web/vendor/`）解封裝，取得每一幀的時間戳、旋轉、編碼；用 WebCodecs 解碼指定的那一幀。幀的身分由容器決定，沒有 seek 的模糊空間，可變幀率也正確。自動偵測時可以循序解碼，不用一幀一幀 seek。
2. **退路引擎**：WebCodecs 不能用或解不了這個編碼時，用 `<video>`：時間戳仍來自解封裝（解不了就估計固定幀率），seek 到「該幀時間區間的中點」，先註冊 rVFC 再設 `currentTime`，用 `mediaTime` 核對是不是要的那一幀，並設逾時。
3. 兩個引擎和示範模式的合成畫面實作同一個介面，後面的校正、標記、偵測都不用管來源。
4. **入框角度只用位置（拋物線是 y 對 x 的關係），不用時間**，所以慢動作、可變幀率、時間戳誤差都不影響角度。時間只用在「標註內插」和「把偵測點依序串起來」。
5. 標註包記錄影片指紋（檔名、大小、解析度、幀數、長度、編碼）。`build_dataset.py` 會核對，避免「在手機上標的是轉檔版、在筆電上抽幀用的是原檔」造成錯位。

**驗證方式**：用 ffmpeg 產生「每一幀畫著自己幀號條碼」的測試影片（固定幀率、可變幀率、有 B 幀、帶旋轉、.mov、HEVC），在 Chrome 裡逐幀前進、後退、隨機跳，讀回條碼核對。Safari 沒有實機可測，列為待使用者實測。

### 2.4 入框角度：拋物線＋空氣阻力修正

規格寫的是「最小平方法擬合拋物線」。動工前用數值模擬檢查了這個假設（籃球的阻力係數約 0.5）：

| 做法 | 罰球距離的系統誤差 | 雜訊（1080p、點 6 點、每點誤差 2 像素） |
|---|---|---|
| 拋物線擬合整段軌跡 | **低估約 1.1 度**（三分線距離約 1.7 度） | 約 ±0.2 度 |
| 拋物線只擬合下降段 | 低估約 0.35 度 | 約 ±0.5 度（變吵 2.5 倍） |
| 拋物線＋固定阻力係數修正 | 0（阻力係數差 20% 時 ±0.2 度；有後旋升力時 +0.1～+0.4 度） | 約 ±0.2 度 |

和 45 度參考線比較時，1 度的系統誤差不能忽略，所以採用第三種：先做最小平方拋物線，再用同樣三個參數（過框位置、入框斜率、曲率）加上固定的阻力常數做修正（`y'' = −2κ·exp(2k·s)`，k=0 時就是拋物線）。設定裡可以關掉修正。疊圖畫的是修正後的曲線。

示範模式的合成軌跡也用含阻力的拋體物理產生，真實角度由模擬直接得到。合成資料和估計器用同一個物理模型，所以**示範模式的誤差只反映點擊和偵測的雜訊，不代表實拍準確度**，文件和畫面都會寫明。

### 2.5 其他決定

- **水平基準**（實作過程中修正過）：一開始的決定是「以籃框兩點連線為水平」，好處是手機沒放平也不影響。
  後來用針孔相機模擬（`tools/camera_study.mjs`）發現這個做法有系統性偏差：籃框是水平的圓，從側面偏下方看是橢圓；
  只要籃框不在畫面正中央，橢圓最左、最右兩點離鏡頭的距離就不一樣，連線在畫面上會斜 2 到 6 度，
  即使鏡頭擺得完全正，入框角度也會高估 0.3 到 2.6 度（距離越近越嚴重）。
  現在實拍影片的預設是「**籃框連線並修正透視**」：由籃框在畫面上的位置和鏡頭焦距（假設手機 1 倍鏡頭，畫面寬的 0.8 倍）
  算出透視造成的傾斜並扣掉，剩下的才是手機沒放平的歪斜。模擬中鏡頭擺正時誤差在 0.1 度以內，手機歪 5 度也只差 0.1 度；
  焦距假設差 12% 時誤差在 0.3 度以內。另外保留兩個選項：「籃框連線，不修正」（合成示範畫面沒有透視，用這個）和「畫面水平」。
  校正畫面會顯示扣掉透視後還歪幾度，超過 3 度會提醒（代表手機沒放平、鏡頭有仰角，或兩點沒點準）。
  修不掉的是鏡頭仰角和偏離正側面，這兩項的影響寫在 `docs/SHOOTING_GUIDE.md` 和 `docs/EVAL.md`。
- **進球建議**：依過框位置和入框角度的幾何關係分成「空心區／可能碰框／偏短／偏長」。自動偵測時再看過框之後球有沒有出現在球網位置或彈起來。側拍看不到左右偏差，所以永遠只是建議，使用者一鍵改正。
- **Python 共用程式庫 `arclog/`**：`tools/` 和 `training/` 都要用同一套幾何、擬合、軌跡邏輯，放在最上層的 `arclog/` 套件，和 `web/js/core/` 一一對應。這是規格的六個目錄以外多出來的一個。
- **`models/` 和 `web/models/`**：規格要求模型放在 `models/`，但 Vercel 根目錄是 `web/`，網站讀不到上一層。所以 `models/` 是正本，`tools/sync_models.py` 複製到 `web/models/`，測試會檢查兩邊一致。Git 對相同內容只存一份，不會讓 repo 變大。
- **開發用的 npm 套件**：網站本身不需要 npm 也沒有 build 步驟。`package.json` 只有開發用的兩個套件：Playwright（瀏覽器實測）和 `@napi-rs/canvas`（讓 Node 用和網站同一份繪圖程式產生合成影片）。
- **這台機器沒有 NVIDIA GPU**（Intel Iris Xe），本機只跑得動合成資料的幾個 epoch；正式訓練走 Colab。
- **角度記到小數一位**，CSV 匯出再匯入不會有捨入差。

## 3. 架構

```
web/         靜態網站（Vercel 根目錄）
  js/core/     純函式：幾何、擬合、進球判定、軌跡、統計、內插、CSV、標註包、YOLO 解碼、合成物理
  js/demo/     合成畫面的繪圖（瀏覽器和 Node 共用）
  js/media/    三種影格來源：WebCodecs、<video>、合成
  js/detect/   Web Worker 推論
  js/ui/       畫面
  models/      網站實際載入的模型（由 models/ 同步）
  vendor/      onnxruntime-web、Mediabunny
arclog/      Python 共用程式庫（和 web/js/core 對應）
tools/       analyze.py、本機伺服器、同步與檢查腳本
training/    合成資料、build_dataset、疊圖檢查、訓練、評估、匯出、Colab notebook
models/      ONNX 模型正本、manifest、MODEL_CARD.md
tests/       vectors/（JS 和 Python 共用）、js/、py/、e2e/、fixtures/
docs/        PLAN、拍攝指南、資料與隱私、評估結果、下一步
```

## 4. 階段與驗收條件

### 階段 0：查證與基礎建設
- 產出：本文件、`LICENSE`（AGPL-3.0）、`.gitignore`、vendor 檔案、Python 與 Node 環境。
- 驗收：
  - [ ] Ultralytics 模型名稱與匯出參數已對照官方文件，並在本機實際匯出確認輸出形狀
  - [ ] 逐幀定位的做法有查證依據
  - [ ] `.gitignore` 擋住 `data/`、訓練輸出、影片與權重檔

### 階段 1：核心純函式與共用測試向量
- 產出：`web/js/core/*.js`、`arclog/*.py`、`tests/vectors/*.json`、`tests/js`、`tests/py`。
- 驗收：
  - [ ] 已知角度的合成軌跡（含雜訊、含離群點），入框角度誤差 < 1 度
  - [ ] 進球判定、統計、標註內插、CSV、YOLO 解碼的測試通過
  - [ ] JS 和 Python 讀同一份測試向量，數值差 < 1e-6
  - [ ] `node --test` 和 `pytest` 全部通過

### 階段 2：網站（半自動流程）
- 產出：載入影片、校正、半自動標記（逐幀、時間軸、雙指縮放、放大鏡、復原）、報告、CSV 匯出匯入、報告圖片、歷次紀錄與備份、示範模式、標註包匯出。
- 驗收：
  - [ ] 條碼測試影片在 Chrome 逐幀前進、後退、隨機跳都落在正確的幀（兩個引擎都測）
  - [ ] 示範模式：校正 → 每球點 4–6 點 → 報告，角度誤差 < 1 度，報告顯示真實角度與誤差
  - [ ] CSV 匯出再匯入，報告數字相同
  - [ ] 標註包通過格式檢查，內插點和合成真值的差在 2 像素內
  - [ ] 手機尺寸（360×740、390×844）版面沒有水平溢出
  - [ ] 本機儲存被擋住時頁面不壞

### 階段 3：階段 A 模型與自動偵測
- 產出：`models/` 的 COCO 預訓練 ONNX、Worker 推論、軌跡串接、確認卡。
- 驗收：
  - [ ] 自己寫的解碼和 Ultralytics 官方推論在同一張圖上結果一致
  - [ ] 網站在 WebGPU 和 WASM 兩條路徑都能跑完示範影片，有進度條、可取消
  - [ ] 模型載入失敗時退回半自動，不卡住
  - [ ] 每球一張確認卡，可接受、修正、刪除

### 階段 4：Python 工具與訓練流程
- 產出：`tools/analyze.py`、`training/` 各腳本、Colab notebook。
- 驗收：
  - [ ] `analyze.py` 對合成影片輸出的 CSV 能被網站匯入，角度和網站自動流程一致
  - [ ] `build_dataset.py` 用時間戳對齊；`check_overlay.py` 輸出拼圖，標註框落在球上
  - [ ] 訓練／驗證／測試以影片為單位切分，同一支影片不跨組（有測試）
  - [ ] notebook 的程式儲存格在本機用合成資料從頭執行到尾

### 階段 5：合成資料端到端
- 驗收：
  - [ ] 合成影片＋標註包 → build_dataset → 訓練幾個 epoch → evaluate → 匯出 ONNX → 網站載入新模型並偵測到球
  - [ ] `docs/EVAL.md` 的實拍欄位寫「待實測」，合成結果另外列表並註明不代表真實準確度

### 階段 6：實測、文件、PR
- 驗收：
  - [ ] 本機靜態伺服器＋真的 Chrome 跑完：示範半自動到報告、自動偵測、CSV 匯出再匯入、標註包匯出、WASM 退回、手機版面
  - [ ] README、拍攝指南、DATA、MODEL_CARD、EVAL、NEXT_STEPS 完成
  - [ ] 提交前檢查暫存區沒有影片、抽出的畫面或金鑰
  - [ ] 推上遠端、開 PR，說明裡如實列出已驗證、未驗證、可能失效的條件

## 5. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 沒有實拍影片，COCO 的 sports ball 對小顆、模糊的飛行球偵測率未知 | 自動偵測在真實影片上可能漏球 | 半自動流程不依賴模型；自動流程失敗時明確退回；文件不寫任何實拍準確率；階段 B/C 的訓練流程先備好 |
| Safari／iPhone 無法在這台 Windows 上實測 | 逐幀或推論在 iPhone 上可能有問題 | 主要引擎用行為確定的 WebCodecs；兩層退路；`NEXT_STEPS.md` 列出實機測試步驟；PR 說明寫明未驗證 |
| iPhone Safari 選片會轉檔 | 手機上標的幀和原檔對不上 | 標註包記錄影片指紋，`build_dataset.py` 核對；拍攝指南建議用筆電標註原檔，或走「檔案」App |
| 合成資料訓練出的模型沒有實用價值 | 被誤認為可用模型 | 檔名、manifest、模型卡、網站選單都標示「僅供流程驗證」 |
| 進球判定在側拍下本質上有盲點（左右偏、涮框） | 命中率可能算錯 | 一律是建議，確認卡可一鍵改正；EVAL 把進球判定正確率列為待實測 |
| 手機沒對正側面、仰角太大、沒放平 | 角度系統誤差（模擬：仰 5 度約 −0.2 到 −0.6 度；偏離正側面 10 度約 −0.7 到 +1.3 度） | 拍攝指南寫明擺法和影響大小（數字來自 `tools/camera_study.mjs`）；水平基準修正籃框的透視傾斜；校正畫面顯示剩餘歪斜並在超過 3 度時提醒。仰角和偏離正側面目前無法由程式修正 |
| WebGPU 在部分手機上算錯或很慢 | 自動偵測結果不可信 | 第一次推論檢查輸出是否合理；可手動強制 WASM |
| 公開 repo 誤傳影片或人像 | 隱私問題 | `.gitignore` 預設擋掉所有影片與 `data/`；`tools/check_staged.py` 在提交前檢查；只有 `tests/fixtures/video/` 的合成小檔例外 |
| vendor 的 WASM 檔很大（共約 44 MB） | 手機第一次載入慢 | 只有按下自動偵測才下載；有 WebGPU 才抓大的那一個；顯示下載進度 |
| Roboflow 資料集沒有金鑰無法下載 | 階段 B 這次跑不了 | notebook 用輸入欄位讀金鑰；流程用合成資料驗證；列入需要使用者接手的步驟 |

## 6. 需要使用者做的事（細節在 `docs/NEXT_STEPS.md`）

1. 申請 Roboflow 免費金鑰，在 Colab 跑階段 B。
2. 到 Vercel 匯入 repo，根目錄設 `web/`。
3. 用 iPhone 和 Android 實機跑一次示範模式與一支實拍影片。
4. 取得球員與教練同意後錄實拍影片，標註、匯出標註包，跑階段 C。
