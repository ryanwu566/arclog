# 資料與隱私

這個 repo 是**公開**的。這份文件說明哪些東西可以放進來、哪些絕對不行，實拍影片要怎麼保管，
以及訓練用到的公開資料集的出處和授權。

## 1. 什麼可以提交，什麼不行

| 可以提交 | 不可以提交 |
|---|---|
| 程式、文件 | 任何實拍影片（不論長短、有沒有拍到臉） |
| 匯出的 ONNX 模型（`models/`） | 從影片抽出來的畫面、截圖、疊圖檢查的拼圖 |
| 合成的測試素材（`tests/fixtures/`，由程式畫出來，沒有真人） | 含有人像的任何檔案 |
| 共用測試向量（`tests/vectors/`，只有數字） | 標註包（`.arclog.json`：裡面有影片檔名，檔名常常含人名或日期） |
| | PyTorch 權重（`.pt`）、訓練輸出（`runs/`）、下載的資料集（`datasets/`） |
| | 金鑰、密碼（例如 Roboflow API key） |

另外，repo 裡**不內建**任何真人的姓名、照片或數據，不放球隊隊徽，也不放其他產品的商標。
示範模式的畫面、測試用的姓名都是虛構或程式畫出來的。

### 怎麼防止誤傳

1. `.gitignore` 已經擋掉 `data/`、`runs/`、`datasets/`、所有影片副檔名、`.pt`、`.env` 和金鑰檔。
2. 提交前執行檢查（它會看暫存區裡有沒有影片、不該出現的圖片、權重、寫死的金鑰）：

   ```powershell
   python tools/check_staged.py
   ```

   想檢查整個 repo 目前追蹤的檔案：

   ```powershell
   python tools/check_staged.py --all
   ```

3. 唯一的例外是 `tests/fixtures/video/` 裡的 8 支測試影片：每支不到 20 KB，畫面只有黑白條碼（用來驗證逐幀定位），沒有任何實拍內容。
   檢查腳本會擋掉這個資料夾以外的影片，以及這個資料夾裡超過 400 KB 的檔案。

如果真的不小心把影片 push 上去了：光是再刪一次 commit 是不夠的，檔案還在 Git 歷史裡。
請立刻把 repo 設成私人，再用 `git filter-repo` 之類的工具把檔案從歷史中移除，並通知被拍到的人。

## 2. 實拍影片放哪裡

放在 **repo 以外**的資料夾，例如：

```
D:\arclog_data\
├─ videos\            原始影片，和在網站上標記後匯出的標註包（檔名相同）
│   ├─ 1108_A.mov
│   ├─ 1108_A.arclog.json
│   └─ …
├─ dataset\           build_dataset.py 抽出來的訓練畫面（含人像）
└─ stage_b_best.pt    階段 B 的權重（之後階段 C 會用到）
```

`training/build_dataset.py`、`training/evaluate.py`、`tools/analyze.py` 都可以直接讀寫 repo 以外的路徑。
repo 裡的 `data/` 也已經被 `.gitignore` 擋掉，但放在 repo 外面最不容易出錯。

檔名建議用日期加代號（`1108_A`），不要用姓名：檔名會被寫進標註包和 CSV。

### 用 Google Colab 訓練時

階段 C（用自己的影片微調）需要把影片和標註包放到**你自己的** Google Drive，Colab 才讀得到。
這代表影片會離開你的電腦、存在 Google 的伺服器上。徵求同意時要把這件事講清楚；
訓練完不再需要時，從 Drive 刪除（包含垃圾桶）。不要用共用雲端硬碟或公開連結。

## 3. 拍攝和使用前要取得同意

拍攝對象是球員，影片裡會有他們的臉和身體動作。開始之前請取得**被拍到的每一位球員**和**教練**的同意，
而且要讓他們知道下面這些事（建議留下書面或訊息紀錄）：

- **用途**：課堂專題；用來計算入框角度、產生練習報告；用來訓練「找出籃球」的偵測模型。
- **會保存什麼**：原始影片、從影片抽出的畫面、每一球的標記資料。
- **放在哪裡、誰看得到**：組員的電腦；訓練時會放到組員自己的 Google Drive。不會公開、不會放上社群平台。
- **什麼會公開**：程式，以及訓練出來的模型檔。模型檔是一堆數字，裡面沒有影片或影像，
  但它是從這些影片學出來的；發表時不會附上任何實拍畫面。
- **報告和簡報**：如果想在課堂報告中播放片段或放截圖，要另外問，並說明會給哪些人看。
- **可以反悔**：任何時候都可以要求刪除自己的影片和抽出的畫面，不需要理由。
  （已經用這些影片訓練並公開的模型無法「收回」，這一點要事先說明。）
- **保存多久**：建議說一個期限，例如學期結束後一個月內刪除原始影片。

球員未滿 18 歲時，還需要法定代理人同意。學校或球隊如果有自己的規定，以他們的規定為準。

網站本身不會上傳任何東西：影片只在使用者的手機或電腦上處理，報告和歷次紀錄存在那台裝置的瀏覽器裡。
但使用者匯出的 CSV、報告圖片、標註包裡可能有他填的姓名和影片檔名，傳給別人之前要自己留意。

## 4. 公開資料集（階段 B 用）

階段 B 用 Roboflow Universe 上的公開資料集訓練。下面兩個資料集的資訊是 **2026-11-13 直接在資料集頁面上核對**的
（未登入狀態；沒有金鑰所以還沒有實際下載）。

| | 資料集一 | 資料集二 |
|---|---|---|
| 名稱 | Basketball Detection v6 | shot |
| 作者（頁面顯示） | Hooper | XINGHANs Workspace |
| 網址 | https://universe.roboflow.com/hooper-ibdsr/basketball-detection-v6 | https://universe.roboflow.com/xinghans-workspace/shot-wi85e |
| 授權 | CC BY 4.0 | CC BY 4.0 |
| 類別 | ball、holder、hoop、scorer | ball、player、bucket |
| 影像數 | 48,110 | 11,105 |
| 使用的版本 | v1（2026-06-11 產生） | v3（2026-08-26 產生） |
| 切分 | 全部在訓練組（沒有驗證組和測試組） | 訓練 8,506／驗證 1,285／測試 1,314 |
| 前處理 | 無 | Auto-Orient；**壓成 640×640**（Stretch） |
| 擴增 | 無 | 無 |
| 畫面類型（看頁面上的縮圖） | 室內和室外球場，固定機位的廣角畫面，多人打球；縮圖是 16:9 | 室內球場，固定機位的廣角畫面，單人投籃；縮圖是正方形，人物明顯被橫向壓窄 |

我們只用其中的 **ball** 類別，其他類別（球員、籃框等）的標註在 `training/prepare_public.py` 裡全部丟掉。

### 為什麼選這兩個

- **資料集二**的畫面最接近我們的用法：固定機位、單人投籃、球在畫面上很小。
- **資料集一**量大、場地多（室內外都有），可以讓模型不要只認得單一場地。它是多人比賽畫面，和我們的拍法差比較多。

### 已知的問題（訓練前要知道）

1. **是否有足夠的「飛行中的球」**：從頁面縮圖只能確認場景類型，看不清楚球。兩個資料集都有 ball 類別，
   但飛行中的球佔多少、標得準不準，要下載後看 `prepare_public.py` 產生的 `preview_check.jpg` 才知道。
2. **資料集二的影像被壓成正方形**，球會變成直的橢圓。`prepare_public.py` 可以用 `--aspect 16:9` 還原
   （Colab notebook 已經這樣設定）。原始比例是不是 16:9 是從縮圖推測的，**下載後請看預覽圖裡的球是不是圓的**；
   不是的話把 notebook 裡這個資料集的 `aspect` 改成 `"keep"` 或正確的比例。
3. **資料集一沒有驗證組**。`prepare_public.py` 會從訓練組切 15% 出來，並盡量讓檔名看起來來自同一支影片的影像留在同一組。
   但公開資料集沒有「哪張圖來自哪支影片」的資訊，這只是依檔名猜的。資料集二的畫面是連續影格，
   它自己的驗證組和訓練組很可能來自同一支影片。
   所以**公開資料集的驗證分數只用來在訓練時挑模型，不能當成準確度**；模型好不好要看我們自己的測試影片（`docs/EVAL.md`）。
4. **授權標示的可信度**：CC BY 4.0 是上傳者在 Roboflow 上選的授權。我們無法確認上傳者是否擁有原始影片的權利。
   如果日後有人主張權利，應停止使用該資料集並重新訓練。
5. **類別編號**以下載後 `data.yaml` 裡的 `names` 為準；`prepare_public.py` 會依名稱找出 ball，找不到會停下來。

### 標示出處（CC BY 4.0 的要求）

使用這些資料集訓練的模型，發表或散布時請附上：

> Hooper. *Basketball Detection v6 Dataset*. Roboflow Universe, 2026. https://universe.roboflow.com/hooper-ibdsr/basketball-detection-v6 （CC BY 4.0；只使用 ball 類別）
>
> XINGHANs Workspace. *shot Dataset*. Roboflow Universe, 2026. https://universe.roboflow.com/xinghans-workspace/shot-wi85e （CC BY 4.0；只使用 ball 類別，影像還原成 16:9）

授權全文：https://creativecommons.org/licenses/by/4.0/

資料集本身**不放進 repo**（`datasets/` 已被 `.gitignore` 擋掉），每次訓練時由 notebook 重新下載。
下載需要 Roboflow 的 API 金鑰：金鑰只在 notebook 的輸入欄位輸入，不可以寫進任何檔案（申請方式見 `docs/NEXT_STEPS.md`）。

如果之後換用或加入其他資料集，請在這一節補上同樣的表格，並更新 `models/MODEL_CARD.md`。

## 4b. 三類別模型（球、籃框、籃板）用的資料集

2026-11-14 為了自動模式（`docs/PLAN_AUTO.md`）重新查證。**Roboflow Universe 的資料集頁面這次擋掉自動讀取（HTTP 403）**，
所以下面的資訊來自搜尋結果、Roboflow 官方部落格和第三方頁面，**授權和類別都還沒有在資料集頁面上直接核對**。
在核對之前不要假設它們是對的；`training/prepare_public.py` 會在下載後自己核對（見下面「程式怎麼核對」）。

| | 資料集三（優先評估） | 籃板候選（擇一，未核對） |
|---|---|---|
| 名稱 | basketball shooting robot | detectionWithBackBoard；eventDetection |
| 作者 | The University of Arizona | basket-ball-netyu；aibasket |
| 網址 | https://universe.roboflow.com/the-university-of-arizona-th1yv/basketball-shooting-robot | https://universe.roboflow.com/basket-ball-netyu/detectionwithbackboard 、https://universe.roboflow.com/aibasket-fdtdk/eventdetection-vjkva |
| 影像數 | 約 9.8k（Roboflow 部落格）；第三方頁面寫 9,612 張、17,258 個框 | 未知 |
| 類別 | ball、rim；另有人和投籃動作的標籤（Roboflow 部落格）。**看起來沒有籃板** | 名稱或搜尋摘要裡有 backboard；eventDetection 的摘要另有 ball、player、backline、centerline（多半是轉播畫面） |
| 授權 | 第三方頁面寫 CC BY 4.0；**未在資料集頁面核對** | eventDetection 的搜尋摘要寫 CC BY 4.0；detectionWithBackBoard 未知 |
| 籃框框的畫法 | 未知（只框鐵圈，或連球網一起框）。下載後看預覽圖決定 `rimBox` | 未知 |

搜尋來源：Roboflow 部落格〈How to Build a Local AI Basketball Shot Evaluator〉（https://roboflow.com/blog/how-to-build-an-ai-basketball-shot-evaluator ）、
GitHub `rish-mishra/ArcVision` 的 model-v1 發布頁（第三方，引用了這個資料集的授權和數量）。

### 程式怎麼核對

`training/prepare_public.py --classes ball,rim,backboard` 在轉換前會：

1. 讀匯出檔裡的 `README.roboflow.txt`，找 `License:` 那一行。不是 CC BY 4.0、CC0 或 Public Domain 就停下來（可以加 `--allow-license` 自己負責）。
   讀到的授權寫進輸出資料夾的 `sources.json`，訓練出來的模型卡要照抄。
2. 讀 `data.yaml` 的 `names`，用別名表找類別：ball（ball、basketball、sports ball）、rim（rim、hoop、basket、basketball-hoop）、
   backboard（backboard、board）。找不到 ball 就停；資料集沒有某個類別時，記在 `sources.json` 的 `missing`，
   之後由 `training/pseudo_label.py` 補標（補標的框另外記一份清單，不和人工標註混在一起）。
3. 輸出固定三個類別：0 ball、1 rim、2 backboard。

### 為什麼要補標

Arizona 的資料集有球和籃框、沒有籃板。直接和有籃板的資料集合在一起訓練，模型會在 Arizona 的影像裡看到沒有標的籃板，
學到「籃板是背景」。所以先用有籃板的資料訓練一個模型，再用它把 Arizona 影像裡的籃板補上（只留高信心的框），再合起來訓練。
補標的品質一樣要看 `preview_check.jpg`。

### 標示出處

核對授權之後，在這裡補上正式的出處文字（和上面兩個資料集同樣的格式）。**還沒核對之前，訓練出來的模型不要公開散布。**

## 5. 模型和預訓練權重

| 項目 | 來源 | 授權 |
|---|---|---|
| YOLO26n 架構與預訓練權重 | Ultralytics（`yolo26n.pt`，在 COCO 資料集上訓練） | AGPL-3.0 |
| COCO 資料集（階段 A 的模型直接使用它的 sports ball 類別） | cocodataset.org | 標註為 CC BY 4.0；影像來自 Flickr，各有各的授權 |
| `models/` 裡匯出的 ONNX | 由上述權重匯出或接著訓練 | AGPL-3.0 |

因為使用了 Ultralytics 的模型，整個專案以 **AGPL-3.0** 釋出（`LICENSE`）。

## 6. 合成資料

示範模式的畫面、`training/make_synth.py` 產生的影片，都是程式用幾何圖形畫出來的（投籃的人是一個剪影），沒有任何真人。
合成影片只用來確認流程會動；用它訓練出來的模型**不代表在真實影片上的準確度**，也不會放進 `models/`。
合成影片檔案比較大，同樣不提交（放在 `data/`），需要時用程式重新產生。
