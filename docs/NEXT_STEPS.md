# 接下來需要你做的事

這些事需要你的帳號、你的手機，或需要先取得別人同意，所以沒辦法替你做。照順序來，每一步都寫了在哪裡按什麼。
哪些已經驗證過、哪些還沒有，寫在 PR 說明和 `docs/EVAL.md`。

指令都是 Windows PowerShell 用的，**一行一個指令**（PowerShell 5.1 不支援 `&&`）。

| 順序 | 要做的事 | 大約要多久 | 做完會得到 |
|---|---|---|---|
| 1 | 看 PR、合併 | 10 分鐘 | `main` 上有完整的程式 |
| 2 | 在電腦上預覽網站 | 5 分鐘 | 確認示範模式會動 |
| 3 | 部署到 Vercel | 10 分鐘 | 一個可以傳給球員的網址 |
| 4 | 用手機實測（含網站內錄影） | 30 分鐘 | 知道 iPhone／Android 上有沒有問題、要等多久 |
| 5 | 取得同意、拍第一批影片 | 一次練習 | 實拍影片 |
| 6 | 標記、匯出標註包 | 每 10 球約 5 分鐘 | 報告，以及訓練用的標註 |
| 7 | 申請 Roboflow 金鑰、在 Colab 訓練階段 B 或 **B3（三類別，自動模式要用）** | 申請 5 分鐘＋訓練 1 到 3 小時 | 階段 B／B3 的模型 |
| 8 | 把模型放回專案 | 10 分鐘 | 網站上多一個模型可選 |
| 9 | 用自己的影片訓練階段 C、評估 | 視影片量 | 階段 C 的模型，和 `docs/EVAL.md` 裡的實測數字 |

---

## 0. 電腦上需要的工具

已經裝過的可以跳過。在 PowerShell 裡一行一行執行：

```powershell
winget install Python.Python.3.12
```

```powershell
winget install OpenJS.NodeJS.LTS
```

```powershell
winget install Git.Git
```

裝完**關掉 PowerShell 再重開**，然後進到專案資料夾，建立 Python 的虛擬環境並安裝套件：

```powershell
cd C:\Projects\arclog
```

```powershell
python -m venv .venv
```

```powershell
.\.venv\Scripts\Activate.ps1
```

（如果這一行出現「因為這個系統上已停用指令碼執行」的錯誤，先執行下面這一行，再重試上一行。）

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

```powershell
python -m pip install -r requirements.txt
```

只有要在自己電腦上跑測試或訓練時，才需要下面這幾個：

```powershell
python -m pip install -r requirements-dev.txt
```

```powershell
python -m pip install -r training/requirements.txt
```

```powershell
npm install
```

瀏覽器實測（`npm run test:e2e`）另外需要電腦上裝有 Google Chrome。

## 1. 看 PR、合併

1. 打開 https://github.com/ryanwu566/arclog/pulls ，點進「ArcLog 練投紀錄員」這個 PR。
2. PR 說明裡列了哪些驗證過、哪些沒有。看完沒問題的話，按最下面綠色的 **Merge pull request** → **Confirm merge**。

合併之前想先試，可以直接用目前的分支做第 2 步。

## 2. 在電腦上預覽網站

```powershell
python tools/serve.py
```

用 Chrome 打開 http://127.0.0.1:8000 。按「**示範模式（不用影片）**」，照畫面的提示點籃框（或按「幫我點（示範）」）、標幾球，看報告出不出得來。
再回到標記頁試一次「自動偵測」。要結束時回到 PowerShell 按 `Ctrl + C`。

請用 `tools/serve.py`，不要直接點兩下打開 `index.html`：瀏覽器不允許從檔案路徑載入程式模組和模型。

## 3. 部署到 Vercel

1. 打開 https://vercel.com ，用 GitHub 帳號登入。
2. 右上角 **Add New…** → **Project**。
3. 在 **Import Git Repository** 找到 `ryanwu566/arclog`，按 **Import**。
   （第一次會要求授權 Vercel 讀取你的 GitHub repo，選只授權這一個 repo 就好。）
4. 設定頁上：
   - **Framework Preset**：選 **Other**
   - **Root Directory**：按 **Edit**，選 **`web`**（這一步最重要，選錯網站會打不開）
   - **Build Command**、**Output Directory**、**Install Command**：都留空（網站沒有 build 步驟）
5. 按 **Deploy**。大約一分鐘後會給你一個 `https://….vercel.app` 的網址。

之後每次 push 到 `main`，Vercel 會自動重新部署。

**自訂網域之後再綁**：到 Vercel 專案的 **Settings → Domains** 新增網域，照它顯示的 DNS 設定去網域商那邊設就好。
repo 裡不需要、也不要加 `CNAME` 檔（那是 GitHub Pages 用的）。

部署完請確認一件事：打開網址 → 示範模式 → 校正 → 自動偵測，確定模型載得起來。
偵測時畫面會顯示運算方式：「WebGPU」或「WASM（幾個執行緒）」。`web/vercel.json` 設定了讓多執行緒可以用的標頭；
如果在電腦的 Chrome 上勾了「不使用 WebGPU」之後顯示的是「WASM（單執行緒）」，代表標頭沒有生效，請回報。

## 4. 用手機實測（這一步我沒辦法做）

開發環境是 Windows 電腦上的 Chrome，**iPhone 的 Safari 和 Android 手機都沒有實機測過**。
請用球員實際會用的手機打開 Vercel 的網址，照下面的清單試一次，把結果記下來：

| 測試項目 | 怎麼試 | 預期 |
|---|---|---|
| 看示範（自動） | 首頁按「看示範」；再到「示範的設定」選斜 45 度、正後方各試一次 | 直接出報告；斜 45 度標「誤差較大」、正後方只有出手數和命中率 |
| 示範錄影 | 「示範的設定」→「示範錄影（不開相機）」，錄 20 秒按停止 | 預檢四項打勾、可以開始錄、停止後出報告 |
| **開始練投（真的相機）** | 首頁按「開始練投」，允許相機，對著籃框架好（橫拿） | 預覽看得到畫面、引導框疊在畫面上；籃框那一項會要你點兩下籃框（目前的模型不會找籃框）；鏡頭角度那一項寫「錄完之後估計」 |
| 錄影中鎖螢幕、切 App | 錄影中按電源鍵、或切到別的 App 幾秒再回來 | 回來後有提醒「剛剛離開了這個頁面」；報告寫有中斷的時段 |
| 停止後要等多久 | 錄 1 分鐘左右按停止 | 記下錄影時右上角顯示的「即時偵測每秒幾幀」、停止後等了幾秒才出報告 |
| 分析失敗時影片還在 | 錄完、在「分析中」時直接關掉分頁，再打開網址 | 首頁出現「有一段錄影還沒分析完」，可以重新分析或下載 |
| 手動校正的示意圖 | 「進階」→「手動標記示範」 | 示意圖看得懂；故意把兩點點成上下排列、點在地板上，會出現提醒 |
| 標題列和工具列 | 在 iPhone 直拿、橫拿各看一次 | 「ArcLog」不換行、檔名不是一長串亂碼；放大縮小按鈕和時間軸沒有被 Safari 的網址列、工具列蓋住 |
| 示範模式（手動） | 「進階」→「手動標記示範」，校正、標 3 球、看報告 | 流程走得完，版面沒有跑掉 |
| 上傳手機拍的影片 | 首頁按「上傳練投影片」，選一支手機錄的影片 | 先請你點兩下籃框，接著自動偵測、出報告 |
| 手動標記手機拍的影片 | 「進階」→「手動標記一支影片」 | 看得到畫面，可以一幀一幀前進後退 |
| 逐幀是否準確 | 按「下一幀」十次、再按「上一幀」十次 | 回到同一個畫面，沒有跳幀或卡住 |
| 兩指放大、放大鏡 | 在畫面上兩指放大，點球心 | 放大鏡出現，點得準 |
| 自動偵測 | 校正後按「自動偵測」→「開始偵測」 | 有進度條；記下它顯示的運算方式（WebGPU，或 WASM 幾個執行緒）和處理速度 |
| 匯出 | 匯出 CSV、報告圖片 | 檔案存得下來（iPhone 會跳出分享選單） |
| 重新整理 | 標到一半重新整理頁面，再選同一支影片 | 詢問要不要接續上次的進度 |

iPhone 特別要注意的幾點：

- **網站內錄影只能在 HTTPS 網址用**（Vercel 的網址就是）。Safari 拒絕過相機權限之後，要到「設定 → Safari → 相機」改回來，再重新整理頁面。
- 錄影時頁面要一直在前景：鎖定螢幕或切到別的 App，iPhone 會暫停相機，那段時間的球不會記到。網站會試著讓螢幕不要自動關（Wake Lock），
  但這在 iPhone 上沒有實測過。

- 從相簿選影片時，系統交給網頁的是轉檔過的版本。看報告沒問題，但**要拿來訓練的影片請在電腦上標記**（原因在 `docs/SHOOTING_GUIDE.md`）。
- 影片很長（超過幾分鐘）時，手機可能因為記憶體不足讓網頁重新載入。遇到的話請記下影片長度和解析度。
- 「高效率」（HEVC）格式的影片如果打不開，到「設定 → 相機 → 格式」改成「最相容」再錄。

有任何一項不如預期，請把**手機型號、系統版本、瀏覽器、哪一步、畫面上的訊息**記下來開一個 issue。

## 5. 取得同意，拍第一批影片

1. 先看 `docs/DATA.md` 第 3 節，向球員和教練說明用途並取得同意。
2. 照 `docs/SHOOTING_GUIDE.md` 架設手機。最後面有一張拍攝前檢查表。
3. 第一次建議拍 3 到 4 支短片，每支 10 到 20 球，換不同的球員、不同的時段或場地。
   這樣之後才有辦法把影片分成訓練、驗證、測試三組（至少要 3 支影片才有獨立的測試組）。
4. 把原始檔傳到電腦，放在 **repo 以外**的資料夾，例如 `D:\arclog_data\videos\`。檔名用日期加代號，不要用人名。

## 6. 標記、匯出標註包

在**電腦**上用 Chrome 打開網站（本機的 `python tools/serve.py` 或 Vercel 的網址都可以）：

1. 首頁「選擇練投影片」，選 `D:\arclog_data\videos\` 裡的一支影片。
2. **校正**：把畫面放大，點籃框的前緣（靠近投籃者的那一端）和後緣（靠近籃板的那一端）。
   水平基準維持預設的「籃框連線，並修正透視」。如果出現「扣掉透視之後還歪了…度」的提醒，代表手機沒擺正，這支影片的角度會有偏差。
   不是用 1 倍主鏡頭拍的影片，改選「垂直參考線」，再點籃板側邊的上下兩端（怎麼選見 `docs/SHOOTING_GUIDE.md` 的「水平基準」一節）。
3. **標記**：每一球在飛行途中點 4 到 6 個球心（出手後、上升、最高點附近、下降、接近籃框），確認疊上去的弧線貼著球走，
   再確認進球與否，按「儲存這球」。
4. 想讓這支影片可以當訓練資料：把**每一球都標完**；另外展開標記頁下方的「訓練資料用：標記『畫面上沒有球』的片段」，
   用「從這一幀開始」「到這一幀結束」標幾段畫面上完全看不到籃球的片段（給模型當反例）。
5. 按「**匯出標註包（JSON）**」（標記頁下方和報告頁都有）。把下載的 `.arclog.json` 放到影片旁邊，**主檔名要和影片一樣**：

   ```
   D:\arclog_data\videos\1108_A.mov
   D:\arclog_data\videos\1108_A.arclog.json
   ```

也可以先讓自動偵測跑一遍，再逐球接受或修正，會比全部手點快。但要當成訓練資料或測試的標準答案時，
預設只採用手動標記的球（自動偵測接受的球不算），避免拿模型的輸出去訓練或評估模型自己。

### 長影片：用電腦的指令工具

十分鐘以上的影片在瀏覽器裡跑自動偵測比較慢，可以改用指令工具。
在網站上載入同一支影片並完成校正後，報告頁最下面的「影片很長？用筆電的指令工具分析」會顯示整行指令，
按「複製指令」，貼到 PowerShell，把路徑改成影片的實際位置：

```powershell
python tools/analyze.py "D:\arclog_data\videos\1108_A.mov" --hoop 1403.5,412.0,1538.2,410.6 --level persp
```

校正時選的是「垂直參考線」的話，複製下來的指令會是 `--level vertical`，後面多一段 `--vertical x1,y1,x2,y2`（參考線兩端的座標），照貼就好。

它會在影片旁邊產生 `1108_A.arclog.csv`（可以用網站首頁的「匯入 CSV」看報告）和 `1108_A.arclog.mp4`（疊了軌跡的檢查影片）。
進球判定只是建議，請看檢查影片確認，要改就直接改 CSV 第三欄的「是／否」。

## 7. 申請 Roboflow 金鑰，在 Colab 訓練階段 B

自動模式（不用點籃框、自動判斷鏡頭角度）需要會找**球、籃框、籃板**的三類別模型：notebook 第一格的 `STAGE` 填 `"B3"`。
它會下載 `PUBLIC_DATASETS_3` 的資料集（Arizona 的 Basketball Shooting Robot，和一個有籃板標註的候選資料集），
**下載後由程式核對授權**（讀資料集附的 `README.roboflow.txt`；不是 CC BY 4.0、CC0、Public Domain 會停下來），
缺籃板的影像用模型補標。請一定要打開它產生的兩張預覽圖（`preview_check.jpg`、`preview_pseudo_check.jpg`）看：

- 框有沒有套在對的東西上；補標的籃板（虛線）有沒有補錯。
- 籃框的框是只框鐵圈，還是連球網一起框：連球網的話，把第一格的 `RIM_BOX` 改成 `"rim+net"` 再匯出。
- 下載時印出的授權和版本，記到 `docs/DATA.md` 4b 的表格裡，並補上「標示出處」的文字。

第二個（有籃板的）資料集**我沒有辦法核對內容**（Roboflow 的頁面擋掉了自動讀取），不合用的話請在 Roboflow Universe 搜尋 `backboard` 換一個。
訓練好之後照第 8 節放回專案，網站會自動用它找籃框和籃板（manifest 裡有 `classes`）。

### 7.1 申請金鑰（免費）

1. 打開 https://app.roboflow.com ，用 Google 或 GitHub 帳號註冊並登入。第一次會要你建立一個 workspace，名稱隨意，方案選免費的 Public。
2. 左下角的齒輪 **Settings** → 左邊選單的 **API Keys**（或直接打開 https://app.roboflow.com/settings/api ）。
3. 複製 **Private API Key**。

這把金鑰等同你的帳號密碼：**不要貼到任何檔案、訊息或 commit 裡**。它只會用在下一步 Colab 的輸入欄位。
如果不小心外流，回到同一頁按 **Revoke** 重新產生。

### 7.2 在 Colab 執行 notebook

1. 打開（PR 合併之後）：
   https://colab.research.google.com/github/ryanwu566/arclog/blob/main/training/arclog_train.ipynb
   還沒合併的話，把網址裡的 `main` 換成 `feat/arclog-mvp`，並把 notebook 第 1 格的 `BRANCH` 也改成 `"feat/arclog-mvp"`。
2. 選單 **執行階段 → 變更執行階段類型**，硬體加速器選 **T4 GPU**，按儲存。
3. 第 1 格的 `STAGE` 維持 `"B"`。
4. 選單 **執行階段 → 全部執行**。出現「這個筆記本不是由 Google 撰寫」的提醒時按「仍要執行」。
5. 跑到「6-B」那一格時會出現一個輸入欄位，貼上剛才的金鑰，按 Enter。
6. 下載資料集後會顯示一張預覽圖。**看一下綠色的框有沒有套在球上、球是不是圓的。**
   如果第二個資料集的球是扁的或瘦長的，把第 1 格 `PUBLIC_DATASETS` 裡那一筆的 `"aspect"` 改成 `"keep"`，從頭再跑一次。
7. 等訓練跑完（大約 1 到 2 小時；Colab 免費版閒置太久會斷線，請讓那個分頁保持開著）。
8. 最後一格會自動下載 `arclog_result_stage_b.zip`。

如果中途失敗，把那一格印出來的訊息複製下來。最可能卡住的地方是資料集下載（金鑰貼錯、資料集被作者下架、格式名稱改了），
因為沒有金鑰，這一格在開發時沒有辦法實際測試。

## 8. 把模型放回專案

1. 把 `arclog_result_stage_b.zip` 解壓縮。裡面有 `models\`、`docs\`、`weights\` 三個資料夾。
2. 把 `models\arclog-ball-b-public.onnx` 和 `models\manifest.json` 複製到專案的 `models\` 資料夾（覆蓋 `manifest.json`）。
3. 把 `weights\stage_b_best.pt` 留在 repo 以外，例如 `D:\arclog_data\stage_b_best.pt`（階段 C 會用到；`.pt` 檔不放進 repo）。
4. 同步到網站用的資料夾，並確認兩邊一致：

   ```powershell
   python tools/sync_models.py
   ```

5. 在本機試：`python tools/serve.py` → 示範模式或自己的影片 → 自動偵測 → 模型選「階段 B」。
   只是想先試而不想動專案的話，自動偵測頁的「進階」裡有「載入自己訓練的 ONNX 模型」，直接選下載的 `.onnx` 就可以。
6. 更新 `models/MODEL_CARD.md`（那份文件最後有寫要補什麼）。
7. 提交。先檢查暫存區沒有不該放的東西：

   ```powershell
   git add models web/models docs
   ```

   ```powershell
   python tools/check_staged.py
   ```

   ```powershell
   git commit -m "階段 B 模型"
   ```

   ```powershell
   git push
   ```

新模型只是多一個選項，網站預設用的還是階段 A。要改預設，等第 9 步的評估結果出來再決定。

## 9. 用自己的影片訓練階段 C、評估

需要：至少 3 支（建議 6 支以上）標完的影片。影片越多、場地和光線越多樣越好。

### 9.1 先在電腦上評估階段 A 和 B（不用訓練）

```powershell
python training/build_dataset.py --pairs D:\arclog_data\videos --out D:\arclog_data\dataset
```

```powershell
python training/check_overlay.py --dataset D:\arclog_data\dataset
```

打開 `D:\arclog_data\dataset\overlay_check.jpg`：**綠色的框應該剛好套住球**。如果框都落在球的前面或後面，
代表影片和標註對不上（最常見的原因是標註時用的不是這個檔案），先不要往下做。
`overlay_negatives.jpg` 裡則不應該看得到籃球。

```powershell
python training/evaluate.py --dataset D:\arclog_data\dataset --write-doc
```

這會用測試組的影片比較目前所有的模型，並把結果寫進 `docs/EVAL.md`。這是這個專案**第一次有實拍的數字**。

### 9.2 在 Colab 訓練階段 C

1. 把 `D:\arclog_data\videos\`（影片和標註包）整個資料夾，以及 `D:\arclog_data\stage_b_best.pt`，
   上傳到你自己的 Google Drive，放成：

   ```
   我的雲端硬碟/arclog_data/videos/…
   我的雲端硬碟/arclog_data/stage_b_best.pt
   ```

   影片會因此存到 Google 的伺服器上，這件事要包含在球員同意的範圍裡（`docs/DATA.md`）。
2. 打開同一份 notebook，第 1 格的 `STAGE` 改成 `"C"`，**全部執行**。它會要求授權讀取你的 Google Drive。
3. 跑完會下載 `arclog_result_stage_c.zip`，裡面的 `docs/EVAL.md` 已經包含三個階段在測試影片上的比較。
4. 照第 8 步把模型和 `docs/EVAL.md` 放回專案、更新模型卡、提交。

### 9.3 決定網站預設用哪個模型

看 `docs/EVAL.md` 的表。如果階段 C（或 B）在漏掉的球、角度誤差上明顯比階段 A 好，
把 `models/manifest.json` 最上面的 `"default"` 改成那個模型的代號，然後：

```powershell
python tools/sync_models.py
```

再提交、push。

---

## 自動模式還沒驗證、需要你提供的

- **實拍影片**：用網站錄一段（或上傳），各種擺法（側面、斜 45 度、背後）都錄一點，記下報告和你自己數的命中數。
  自動分球漏了、多了、進球判定錯了，都是調整門檻需要的資料。影片一樣不要放進 repo。
- **三類別模型在實拍上的偵測率**：訓練好之後用 `training/evaluate.py` 評估（目前只評估球；籃框、籃板的偵測指標還沒有寫）。

## 之後可以考慮的改進

這些不在這次的範圍內，列出來供參考：

- **修正鏡頭仰角**：目前仰角造成的偏差無法由程式修正（仰 5 度約低估 0.2 到 0.6 度）。
  這次評估過「多點一條鉛直的參考線來估仰角」：只有一條線（籃板側邊或立柱）時分不出仰角和點擊誤差、焦距誤差，
  所以只做成「垂直參考線」水平基準，沒有修正仰角（理由和數字在 `docs/EVAL.md` 4.2）。
  要做的話，需要畫面左右兩側各有一條離得很遠的鉛直線（例如投籃者那一側也有門框或柱子），
  再把整條處理流程從「旋轉＋縮放」改成投影轉換，並用實拍影片驗證。
- **獨立驗證角度的準確度**：目前只能比較「自動」和「人工標記」。要知道量到的角度離真實值多遠，
  需要另一種量測方式，例如同時用第二台攝影機從另一個角度拍。
- **鏡頭變形校正**：畫面邊緣的變形目前沒有處理。
