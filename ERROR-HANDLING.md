# ERROR HANDLING — Veo3 Worker Pipeline

> **Cập nhật**: 2026-05-18  
> **Phạm vi**: `worker.js` + `orchestrator.js` (D:\veo3auto\) — Puppeteer model

---

## Tổng quan phân quyền xử lý lỗi

| Layer | Trách nhiệm |
|---|---|
| **Worker** | Phát hiện lỗi qua DOM/HTTP response, tự reload trang nếu cần, throw error code rõ ràng |
| **Orchestrator** | Nhận error code, quyết định retry / trigger recovery / escalate lên Master |

---

## Danh sách lỗi và cách xử lý

### 1. `UNUSUAL_ACTIVITY_BAN` (HTTP 403)

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `responseHandler` bắt HTTP 403 từ Google Veo3 API |
| **Nguyên nhân** | Google phát hiện hành vi bất thường (bot fingerprint, quá nhiều request, session bị gắn flag) |
| **Phát hiện hiện tại** | ⚠️ `responseHandler` trong `worker.js` chỉ đang bắt `429`, **chưa bắt `403`** |
| **Hướng xử lý Puppeteer** | 1. Bổ sung `response.status() === 403` vào `responseHandler` (song song với 429) <br> 2. Khi phát hiện: Worker reload trang → throw error riêng biệt <br> 3. Orchestrator nhận → gọi `worker.close()` → automation.js tự `launch()` lại trên job tiếp theo (fresh browser + fresh profile) <br> 4. **Không tính retry penalty** — đây là lỗi môi trường, không phải lỗi logic |
| **Khác với CloakBrowser** | CloakBrowser dùng `performBrowserRestart` (xoay fingerprint + tiêm cookie). Puppeteer không có fingerprint rotation — chỉ có thể close/relaunch browser với profile sạch hơn |

---

### 2. `MEDIA_GENERATION_FAILED`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — nhiều điểm throw trong `_internalProcessJob()` |
| **Nguyên nhân con** | `inline_error_text` (DOM lỗi visible), 3-button error card, `postGenErrorCheck` failed, prompt box không clear được, không tìm thấy media/download menu sau generation |
| **Nơi xử lý** | **Worker tự reload** trang trước khi throw → Orchestrator log + retry |
| **Hành động** | Worker: `page.reload({ waitUntil: 'networkidle2' })` + reset `settingsApplied = false` → throw. <br> Orchestrator: tăng `consecutiveErrorCount`, chờ 5s, retry job. |
| **Giới hạn** | Sau `maxLocalRetries = 3` lần → Job đẩy về Master Queue |
| **3 consecutive** | `consecutiveErrorCount >= 3` → Orchestrator gọi `recoverSession()` (logout + re-login) |

---

### 3. `SESSION_DROPPED`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `checkAndRecoverSession()` phát hiện nút "Sign in with Google" xuất hiện giữa chừng |
| **Nguyên nhân** | Google Identity session hết hạn khi đang render |
| **Nơi xử lý** | Worker reload, Orchestrator retry |
| **Hành động** | Worker: auto-click "Sign in with Google" (4s wait) → nếu vẫn bị → `page.reload({ waitUntil: 'networkidle2' })` → throw `SESSION_DROPPED`. <br> Orchestrator: log + retry (không tăng `consecutiveErrorCount`). |

---

### 4. `QUEUE_CANCELLED`

| Mục | Nội dung |
|---|---|
| **Trigger UI** | Trang hiển thị text lỗi: "đã xảy ra lỗi", "không thành công", "rất tiếc", "vi phạm" |
| **Nguồn** | `worker.js` — `errorCheck` DOM scan trong vòng lặp render wait |
| **Nguyên nhân** | Google Flow tự hủy job (quá tải server hoặc rate limit nhẹ) |
| **Nơi xử lý** | **Worker phát hiện** → merge vào `MEDIA_GENERATION_FAILED` → Orchestrator retry |
| **Hành động** | `hasError = true` → break vòng lặp → `page.reload({ waitUntil: 'networkidle2' })` → throw `MEDIA_GENERATION_FAILED`. <br> Orchestrator: retry bình thường. |

---

### 5. Fatal Browser Errors

| Mục | Nội dung |
|---|---|
| **Nguồn** | Puppeteer internal |
| **Các lỗi** | `Target closed`, `disconnected`, `detached Frame` |
| **Nơi xử lý** | **Orchestrator — escalate ngay** |
| **Hành động** | Orchestrator: `throw e` ngay, không retry. <br> `automation.js` (Master) bắt → đánh dấu worker offline → gọi `worker.launch()` lại. |

---

### 6. `IMAGE_VIOLATION_OR_ERROR`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `uploadImages()` phát hiện alert/snackbar lỗi chính sách trong DOM |
| **Trigger UI** | `[role="alert"]` hiển thị: "vi phạm", "chính sách", "could not upload", "policy", "error" |
| **Nơi xử lý** | Orchestrator retry bình thường |
| **Hành động** | Worker throw `IMAGE_VIOLATION_OR_ERROR: <message>`. <br> Orchestrator: log + retry. |

---

### 7. `IMAGE_UPLOAD_FAILED`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `uploadImages()` không mở được FileChooser sau khi click nút (+) |
| **Nguyên nhân** | Google đổi DOM/cấu trúc nút upload, hoặc menu dropdown chưa mở kịp |
| **Hành động** | Worker log `⚠️ Không mở được File Chooser`. Tiếp tục pipeline (ảnh bị bỏ qua). <br> Nếu cần enforce: cần thêm `throw` tại đây và xử lý ở Orchestrator. |

---

### 8. Lỗi Browser Launch

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `launch()` — `connect()` từ `puppeteer-real-browser` thất bại |
| **Nguyên nhân** | Browser executable không tìm thấy (Brave/Edge chưa cài), port debug bị chiếm, profile bị lock |
| **Hành động** | Worker throw từ `launch()`. <br> Nếu là Shadow Profile → cleanup profile folder. <br> Master: worker offline, cần can thiệp thủ công hoặc restart service. |

---

### 9. `SUBMISSION_FAILED`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — kết thúc `maxWaitSeconds` mà `this.hasSeenGenerating` vẫn `false` |
| **Nguyên nhân** | Submit chưa được Google tiếp nhận: UI kẹt, nút Submit không hoạt động, mạng trễ |
| **Hành động** | Worker: `page.reload({ waitUntil: 'networkidle2' })` + reset `settingsApplied = false` → throw `SUBMISSION_FAILED`. <br> Orchestrator: retry bình thường. |

---

### 10. `PROMPT_JAM`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — Pre-flight check: nút X ("Xoá câu lệnh") vẫn còn trên DOM sau khi đã click clear |
| **Nguyên nhân** | UI bị kẹt, prompt cũ không được clear — nguy cơ submit prompt trùng |
| **Hành động** | Worker: `page.reload({ waitUntil: 'networkidle2' })` + reset `settingsApplied = false` + `viewModeApplied = false` → throw `PROMPT_JAM`. <br> Orchestrator: retry (worker sẽ re-setup toàn bộ từ đầu). |

---

### 11. `ZodError / 429_Error`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `consoleHandler` (ZodError xuất hiện trong console log) + `responseHandler` (HTTP 429) |
| **Nguyên nhân** | Rate limit của Google (429) hoặc lỗi schema dữ liệu từ API Veo3 (ZodError) |
| **Nơi xử lý** | **Merge vào `MEDIA_GENERATION_FAILED`** |
| **Hành động** | `hasZodOr429Error = true` → vòng lặp render break → Worker reload + throw `MEDIA_GENERATION_FAILED`. <br> Orchestrator: retry bình thường sau 5s. |
| **Mở rộng** | Nên thêm `response.status() === 403` vào `responseHandler` để bắt cả `UNUSUAL_ACTIVITY_BAN`. |

---

### 12. Image Upload Timeout (Warning — Không throw)

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `uploadImages()` — chờ thumbnail xuất hiện 40s không thấy |
| **Nguyên nhân** | File ảnh lớn hoặc mạng chậm, UI chưa render kịp thumbnail |
| **Hành động** | Log warning: `"⚠️ Hết timeout 40s tải ảnh định kèm."` → **tiếp tục pipeline** (ảnh có thể đã upload thành công). |

---

### 13. Navigation Crash / Browser Stuck

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — vòng lặp navigate `labs.google` 3 lần đều thất bại |
| **Nguyên nhân** | Browser bị kẹt tại `about:blank`, URL sai, Chrome process crash |
| **Hành động** | Worker: `close()` → `this.browser = null` → `this.page = null` → throw. <br> Orchestrator: throw tiếp lên Master → `automation.js` gọi `worker.launch()` lại (fresh start). |

---

### 14. Manual Login Timeout

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `waitForManualLogin()` — `waitForFunction` timeout sau 180s (3 phút) |
| **Nguyên nhân** | Auto-login thất bại và không có người can thiệp thủ công trong 3 phút |
| **Hành động** | Worker throw `'Manual login timeout or browser closed by Stop Auto.'`. <br> Master: worker bị đánh offline, cần can thiệp thủ công. |

---

### 15. `Text area not found / Login Required`

| Mục | Nội dung |
|---|---|
| **Nguồn** | `worker.js` — `_internalProcessJob()` — `waitForFunction` tìm `[data-slate-editor="true"]` thất bại |
| **Nguyên nhân** | Session hết hạn → Google redirect về login trước khi bắt job |
| **Hành động** | Worker: gọi `handleLoginWait()` để restore session. <br> Nếu sau `handleLoginWait()` URL vẫn không chứa `labs.google` → throw `'Timeout or failure during session restore.'` → Orchestrator retry. |

---

## Sơ đồ luồng xử lý lỗi tổng quan

```
_internalProcessJob (worker.js — Puppeteer model)
│
├── [Launch] Nếu chưa có browser → launch() + handleLoginWait()
│   ├── Auto-login: email → password → 2FA (OTPAuth)
│   ├── Captcha hiện → waitForManualLogin() (3 phút)
│   └── Timeout → throw 'Manual login timeout'
│
├── [Navigate] Navigate đến labs.google (3 lần thử)
│   ├── Redirect accounts.google.com → handleLoginWait() → restore
│   └── Vẫn thất bại → close() → throw (Navigation Crash)
│
├── [Session Check] checkAndRecoverSession()
│   └── "Sign in with Google" hiện → auto-click → 4s wait
│
├── [UI Setup] applyViewMode + clickCreateMenu + settings
│
├── [PROMPT_JAM Check] Clear prompt → kiểm tra nút X còn không
│   └── X vẫn còn → reload → throw PROMPT_JAM
│
├── [Upload] uploadImages() / uploadI2VFrames()
│   ├── Policy error alert → throw IMAGE_VIOLATION_OR_ERROR
│   ├── FileChooser không mở → log warning, tiếp tục
│   └── Timeout 40s → ⚠️ warning, tiếp tục
│
├── [Submit] clickDynamicNode(submitBtn) → fallback DOM scan → Enter key
│
├── [Render Wait] Vòng lặp tối đa maxWaitSeconds (90-100s), tick 2s
│   ├── HTTP 403 response → UNUSUAL_ACTIVITY_BAN (⚠️ chưa implement)
│   ├── HTTP 429 / ZodError → hasZodOr429Error = true
│   ├── inline_error_text (DOM) → hasError = true → break
│   ├── 3-button error card → reload → throw MEDIA_GENERATION_FAILED
│   ├── checkAndRecoverSession() → modal login mid-render
│   │   └── reload → throw SESSION_DROPPED
│   ├── humanScroll() ngẫu nhiên (anti-bot — 40% mỗi tick)
│   ├── hasSeenGenerating = true (thấy %)
│   └── % biến mất → postGenErrorCheck
│       ├── error dialog / 3-button card → hasError = true
│       └── OK → break → tiến hành download
│
├── [Post-render]
│   ├── hasError = true → reload → throw MEDIA_GENERATION_FAILED
│   └── hasSeenGenerating = false → reload → throw SUBMISSION_FAILED
│
├── [Clear Prompt] Xoá prompt box trước khi download
│   └── Thất bại → throw MEDIA_GENERATION_FAILED
│
└── [Download] handleDownload()
    ├── Không tìm thấy media (video/img > 40000px²) → throw MEDIA_GENERATION_FAILED
    ├── Không tìm thấy "Tải xuống" trong context menu → throw MEDIA_GENERATION_FAILED
    └── Thành công ✅

─────────────────────────────────────────────────────
ORCHESTRATOR (orchestrator.js) — runMediaJob()
─────────────────────────────────────────────────────

├── maxLocalRetries = 3
├── Fatal: Target closed / disconnected / detached Frame
│   └── throw ngay → automation.js gọi worker.launch() lại
├── MEDIA_GENERATION_FAILED → tăng consecutiveErrorCount, retry
│   └── consecutiveErrorCount >= 3 → recoverSession() → reset count
└── Lỗi khác → log + retry (không tăng consecutiveErrorCount)
```

---

## `recoverSession()` — Khôi phục phiên (Orchestrator)

Trigger: `consecutiveErrorCount >= 3` (3 lần `MEDIA_GENERATION_FAILED` liên tiếp).

```
1. Navigate: https://accounts.google.com/Logout
2. Chờ 4 giây
3. Gọi worker.handleLoginWait()
   → Kiểm tra login state
   → Auto-login nếu có email / password / 2FA secret
   → Fallback: waitForManualLogin() (3 phút timeout)
4. Reset consecutiveErrorCount = 0
5. Tiếp tục retry job bình thường
```

> **Lưu ý (Puppeteer vs CloakBrowser)**: Puppeteer không có fingerprint rotation. Nếu Google block session theo IP hoặc fingerprint, `recoverSession()` (chỉ logout + re-login) có thể không đủ. Cần cân nhắc `close()` + `launch()` để lấy profile sạch hơn khi gặp `UNUSUAL_ACTIVITY_BAN` lặp lại.

---

## Shadow Profile — Clone phòng ngừa (Nhiều worker cùng account)

```
1. Anchor worker (đầu tiên dùng account): chụp Cold Snapshot profile gốc
2. Shadow workers (cùng account ID): clone từ Cold Snapshot (tránh lock)
   → Path: user_data/<account>_shadow_<workerId>_<timestamp>/
3. Sau khi worker.close(): xóa shadow folder
   → Retry 8 lần, delay tăng dần (3s → 6s → 9s...) nếu file bị lock
4. Shadow GC khi launch(): quét và xóa toàn bộ folder _shadow_ cũ còn sót
```

---

## Khuyến nghị bổ sung vào `worker.js`

| # | Vấn đề | Fix đề xuất |
|---|--------|-------------|
| 1 | `responseHandler` chưa bắt HTTP 403 | Thêm `response.status() === 403` → set flag `hasUnusualActivity = true` |
| 2 | `UNUSUAL_ACTIVITY_BAN` chưa có handler riêng trong Orchestrator | Tách khỏi `MEDIA_GENERATION_FAILED`, xử lý bằng `close()` + `launch()` thay vì chỉ retry |
| 3 | `IMAGE_UPLOAD_FAILED` (FileChooser không mở) chỉ log, không throw | Cân nhắc throw nếu ảnh là bắt buộc cho job đó |
