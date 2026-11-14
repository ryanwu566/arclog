# 第三方檔案

網站不使用 CDN，所有第三方程式都放在這裡一起提交。檔案內容和上游發布的完全相同（`.gitattributes` 設成不轉換換行）。

資料夾名稱帶版本號，所以 `web/vercel.json` 可以讓瀏覽器長期快取這些檔案；換版本時是換一個新資料夾，不會有新舊檔案混用的問題。

## onnxruntime-web 1.31.1（MIT）

來源：npm `onnxruntime-web@1.31.1` 的 `dist/`。授權見 `ort-1.31.1/LICENSE`。

| 檔案 | 用途 | SHA-256 |
|---|---|---|
| `ort-1.31.1/ort.webgpu.min.mjs` | WebGPU 版進入點 | `329cd956772397a1aedd668e911195d39afefb182f6fc14aafa4f08ac8d8f379` |
| `ort-1.31.1/ort-wasm-simd-threaded.asyncify.mjs` | WebGPU 版載入器 | `59cf781530e1a16df2a291d78798e3ec1152467edaec402d6f9599d85047c302` |
| `ort-1.31.1/ort-wasm-simd-threaded.asyncify.wasm` | WebGPU 版執行檔（28.7 MB） | `ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec` |
| `ort-1.31.1/ort.wasm.min.mjs` | 純 WASM（CPU）版進入點 | `c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234` |
| `ort-1.31.1/ort-wasm-simd-threaded.mjs` | 純 WASM 版載入器 | `30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3` |
| `ort-1.31.1/ort-wasm-simd-threaded.wasm` | 純 WASM 版執行檔（14.8 MB） | `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d` |

只有使用者按下「自動偵測」時才會下載；裝置支援 WebGPU 就抓 WebGPU 版，否則抓純 WASM 版。

## Mediabunny 1.65.2（MPL-2.0）

來源：npm `mediabunny@1.65.2` 的 `dist/bundles/mediabunny.min.mjs`。授權見 `mediabunny-1.65.2/LICENSE`。

| 檔案 | 用途 | SHA-256 |
|---|---|---|
| `mediabunny-1.65.2/mediabunny.min.mjs` | 解封裝 MP4／MOV／WebM，取得每一幀的時間戳，並透過 WebCodecs 解碼 | `08149edcc8cf980da65d94a0a54a8fc0fa85a65f89b66f55c906f33618363919` |

## 更新方式

```powershell
npm pack onnxruntime-web@<版本>
npm pack mediabunny@<版本>
```

解開後把上表的檔案放進新的版本資料夾（例如 `ort-1.32.0/`），刪掉舊資料夾，把 `web/js/` 裡引用舊路徑的地方改掉（搜尋 `vendor/ort-` 和 `vendor/mediabunny-`），更新這份表格的版本與雜湊，再跑一次 `npm run test:e2e` 確認兩條推論路徑和逐幀測試都還通過。
