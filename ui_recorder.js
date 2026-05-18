/**
 * UI Recorder V4.0 — DOM Smart Recorder
 * 
 * Dùng thuật toán phân tích DOM 3 tầng (giống hệt worker.js findNodeByTextExact):
 *   PASS 1: Direct Text Node trên phần tử clickable gần nhất
 *   PASS 2: Google Material Icon (i.google-symbols) 
 *   PASS 3: aria-label / selector fallback
 * 
 * Cách dùng: Paste toàn bộ file này vào Console (F12) của Google Labs.
 *            Trỏ chuột vào từng nút theo hướng dẫn, bấm Space để ghi.
 */
(function () {
    const steps = [
        // ═══════════════════════════════════════
        // BẢNG MENU TẠO (Create Menu)
        // ═══════════════════════════════════════
        { key: "trigger_create_menu", label: "MỞ BẢNG TÙY CHỈNH (Nhấn vào nút góc dưới màn hình để mở bảng to)" },
        
        // --- Tabs chế độ ---
        { key: "T2V", label: "Trong bảng, click chọn tab: Video" },
        { key: "I2V", label: "Trong bảng, click chọn tab: Khung hình / Frames" },
        { key: "IN2V", label: "Trong bảng, click chọn tab: Thành phần / Ingredients" },

        // ═══════════════════════════════════════
        // CẤU HÌNH VIDEO (đang ở tab Video)
        // ═══════════════════════════════════════
        { key: "ratio_ngang", label: "Trỏ vào nút tỉ lệ Video: Ngang (16:9)" },
        { key: "ratio_doc", label: "Trỏ vào nút tỉ lệ Video: Dọc (9:16)" },

        { key: "count_1", label: "Trỏ vào Số lượng video: x1" },
        { key: "count_2", label: "Trỏ vào Số lượng video: x2" },
        { key: "count_3", label: "Trỏ vào Số lượng video: x3" },
        { key: "count_4", label: "Trỏ vào Số lượng video: x4" },

        { key: "model_trigger_video", label: "Trỏ vào ô dropdown Mô Hình video (VD: đang hiện 'Veo 3.1 - Fast')" },
        { key: "model_veo_fast_low", label: "MỞ DROPDOWN mô hình. Trỏ vào: Veo 3.1 - Lite [Lower Priority]" },
        { key: "model_veo_fast", label: "Trỏ vào mô hình: Veo 3.1 - Fast" },

        { key: "duration_4s", label: "Trỏ vào thời lượng Video: 4s" },
        { key: "duration_6s", label: "Trỏ vào thời lượng Video: 6s" },
        { key: "duration_8s", label: "Trỏ vào thời lượng Video: 8s" },

        // ═══════════════════════════════════════
        // CẤU HÌNH IMAGE (phải click chuyển tab trước)
        // ═══════════════════════════════════════
        { key: "IMG", label: "⚠️ BÂY GIỜ CLICK CHUYỂN SANG TAB ẢNH (Hình ảnh / Image). Xong bấm Space." },

        { key: "ratio_img_16_9", label: "Trỏ vào tỉ lệ ảnh: 16:9" },
        { key: "ratio_img_9_16", label: "Trỏ vào tỉ lệ ảnh: 9:16" },
        { key: "ratio_img_1_1", label: "Trỏ vào tỉ lệ ảnh: 1:1" },
        { key: "ratio_img_4_3", label: "Trỏ vào tỉ lệ ảnh: 4:3" },
        { key: "ratio_img_3_4", label: "Trỏ vào tỉ lệ ảnh: 3:4" },

        { key: "count_img_1", label: "Trỏ vào Số lượng ảnh: x1" },
        { key: "count_img_2", label: "Trỏ vào Số lượng ảnh: x2" },
        { key: "count_img_3", label: "Trỏ vào Số lượng ảnh: x3" },
        { key: "count_img_4", label: "Trỏ vào Số lượng ảnh: x4" },

        { key: "model_trigger_image", label: "Trỏ vào ô dropdown Mô Hình ảnh (VD: đang hiện 'Nano Banana 2')" },
        { key: "model_nano", label: "MỞ DROPDOWN mô hình. Trỏ vào: Nano Banana Pro" },
        { key: "model_nano2", label: "Trỏ vào mô hình: nano banana 2 (hoặc Nano Banana 2)" },

        // ═══════════════════════════════════════
        // NÚT GỬI (Submit)
        // ═══════════════════════════════════════
        { key: "submit_btn", label: "ĐÓNG bảng menu. Trỏ vào NÚT MŨI TÊN GỬI (arrow) ở góc dưới phải khung nhập." },

        // ═══════════════════════════════════════
        // VIEW MODE (Cài đặt hiển thị)
        // ═══════════════════════════════════════
        { key: "trigger_view_mode", label: "Trỏ vào nút bánh xe ⚙️ VIEW MODE (góc trên phải màn hình)." },
        { key: "view_batch", label: "Mở bảng View Mode. Trỏ vào: Theo nhóm / Batch" },
        { key: "view_grid_S", label: "Trỏ vào Kích thước lưới: S" },
        { key: "view_sound_off", label: "Trỏ vào toggle: Âm thanh khi di chuột (Sound)" },
        { key: "view_return_silent", label: "Trỏ vào toggle: Return silent videos" },
        { key: "view_info_on", label: "Trỏ vào toggle: Hiện thông tin chi tiết (Show info)" },
        { key: "view_clear_off", label: "Trỏ vào toggle: Xoá câu lệnh sau khi gửi (Clear prompt)" }
    ];

    let currentStep = 0;
    const recordedCoords = {};
    let currentX = 0;
    let currentY = 0;

    // ─── CLICKABLE SELECTOR (đồng bộ với worker.js) ───
    const CLICKABLE = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], li, a, label';

    // ─── Thuật toán phân tích DOM 3 tầng ───
    function analyzeElement(el) {
        if (!el) return { type: 'selector', value: 'ERROR_NOT_FOUND', _debug: 'null element' };

        // Bước 0: Leo lên clickable parent gần nhất nếu đang ở node lá (text, svg, path, div rỗng...)
        const clickable = el.closest(CLICKABLE) || el;

        // ───────────────────────────────────────
        // PASS 1: Direct Text trên clickable element
        // ───────────────────────────────────────
        let directText = '';
        for (let i = 0; i < clickable.childNodes.length; i++) {
            if (clickable.childNodes[i].nodeType === Node.TEXT_NODE) {
                directText += clickable.childNodes[i].textContent;
            }
        }
        directText = directText.trim();

        // Nếu directText ngắn gọn và có ý nghĩa → dùng luôn
        if (directText && directText.length < 60 && !directText.includes('\n')) {
            return {
                type: 'text',
                value: [directText],
                _debug: `PASS1:directText on <${clickable.tagName}> role=${clickable.getAttribute('role')}`
            };
        }

        // ───────────────────────────────────────
        // PASS 2: Google Material Icon text
        // ───────────────────────────────────────
        const icon = clickable.querySelector('i.google-symbols, i[class*="google-symbols"]');
        if (icon) {
            const iconText = (icon.textContent || '').trim();
            if (iconText && iconText.length < 30) {
                return {
                    type: 'text',
                    value: [iconText],
                    _debug: `PASS2:googleIcon "${iconText}" inside <${clickable.tagName}>`
                };
            }
        }
        // Trường hợp el chính là icon
        if (el.tagName === 'I' && (el.classList.contains('google-symbols') || el.className.includes('google-symbols'))) {
            const iconText = (el.textContent || '').trim();
            if (iconText) {
                return {
                    type: 'text',
                    value: [iconText],
                    _debug: `PASS2:directIcon "${iconText}"`
                };
            }
        }

        // ───────────────────────────────────────
        // PASS 3: innerText ngắn (bao gồm cả text con)
        // ───────────────────────────────────────
        const innerText = (clickable.innerText || '').trim();
        if (innerText && innerText.length < 60 && !innerText.includes('\n')) {
            return {
                type: 'text',
                value: [innerText],
                _debug: `PASS3:innerText on <${clickable.tagName}>`
            };
        }

        // ───────────────────────────────────────
        // PASS 4: aria-label (rất ổn định)
        // ───────────────────────────────────────
        const ariaLabel = clickable.getAttribute('aria-label');
        if (ariaLabel) {
            return {
                type: 'selector',
                value: `${clickable.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`,
                _debug: `PASS4:ariaLabel "${ariaLabel}"`
            };
        }

        // ───────────────────────────────────────
        // PASS 5: data-type overlay pattern (nút pill trigger menu)
        // ───────────────────────────────────────
        const hasOverlay = clickable.querySelector('div[data-type="button-overlay"]');
        if (hasOverlay) {
            const hasPopup = clickable.getAttribute('aria-haspopup');
            const hasSpan = clickable.querySelector('span');
            let sel = `${clickable.tagName.toLowerCase()}[aria-haspopup="${hasPopup}"]:has(div[data-type="button-overlay"])`;
            if (!hasSpan) sel += ':not(:has(span))';
            return {
                type: 'selector',
                value: sel,
                _debug: `PASS5:overlayButton haspopup=${hasPopup}`
            };
        }

        // ───────────────────────────────────────
        // PASS 6: Fallback — id hoặc class thô
        // ───────────────────────────────────────
        if (clickable.id && !clickable.id.includes('radix')) {
            return {
                type: 'selector',
                value: `#${clickable.id}`,
                _debug: 'PASS6:stableId'
            };
        }

        return {
            type: 'selector',
            value: clickable.tagName.toLowerCase() + (clickable.className ? '.' + clickable.className.split(' ').slice(0, 3).join('.') : ''),
            _debug: 'PASS6:rawSelector (UNSTABLE!)'
        };
    }

    // ─── UI Overlay ───
    function showOverlay(message) {
        let overlay = document.getElementById('ui-recorder-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'ui-recorder-overlay';
            Object.assign(overlay.style, {
                position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.9)', color: 'white', padding: '15px 30px',
                borderRadius: '10px', zIndex: '999999', fontSize: '16px', fontWeight: 'bold',
                pointerEvents: 'none', border: '2px solid #00bbff', boxShadow: '0 4px 20px rgba(0,187,255,0.3)',
                textAlign: 'center', lineHeight: '1.5', maxWidth: '700px'
            });
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = `<span style="color: #00bbff; font-size: 22px;">BƯỚC ${currentStep + 1}/${steps.length}</span><br/><br/>
            <span style="color: #ffcc00; font-size: 20px;">${message}</span><br/><br/>
            <span style="color: #aaa; font-size: 13px;">Tự do click chuyển tab/mở dropdown. Khi đã trỏ ĐÚNG nút → bấm <span style="color:#00ff00;font-size:16px">SPACE</span></span>`;
    }

    function showHoverPreview(el) {
        let preview = document.getElementById('ui-recorder-preview');
        if (!preview) {
            preview = document.createElement('div');
            preview.id = 'ui-recorder-preview';
            Object.assign(preview.style, {
                position: 'fixed', bottom: '10px', left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,40,80,0.95)', color: '#ccc', padding: '8px 16px',
                borderRadius: '8px', zIndex: '999998', fontSize: '13px', fontFamily: 'monospace',
                pointerEvents: 'none', border: '1px solid #0088cc', maxWidth: '800px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            });
            document.body.appendChild(preview);
        }
        if (!el) { preview.textContent = '...'; return; }
        const data = analyzeElement(el);
        const tag = el.tagName;
        const role = el.getAttribute('role') || '';
        preview.innerHTML = `<span style="color:#0f0">⎯ ${data._debug}</span>  |  <span style="color:#ff0">${data.type}:</span> <span style="color:#fff">${JSON.stringify(data.value)}</span>  |  &lt;${tag}&gt; role=${role}`;
    }

    function removeOverlay() {
        const overlay = document.getElementById('ui-recorder-overlay');
        if (overlay) overlay.remove();
        const preview = document.getElementById('ui-recorder-preview');
        if (preview) preview.remove();
    }

    // ─── Kết quả cuối ───
    function printFinalResult() {
        console.clear();
        console.log("%c🎉 ĐÃ GHI XONG DOM SCAN V4.0! 🎉", "color: #00ff00; font-size: 24px; font-weight: bold;");
        console.log("%cCOPY toàn bộ kết quả dưới đây và dán vào chat:", "color: #ffcc00; font-size: 16px;");

        const s = (val) => {
            if (!val) return 'null';
            // Bỏ _debug ra khỏi output
            const clean = { type: val.type, value: val.value };
            return JSON.stringify(clean);
        };

        const output = `==== KẾT QUẢ DOM SCAN V4.0 ====
Dưới đây là Object cấu trúc thay thế hoàn toàn cho biến coords trong worker.js:

{
    modes: {
        'T2V': ${s(recordedCoords.T2V)},
        'IN2V': ${s(recordedCoords.IN2V)},
        'I2V': ${s(recordedCoords.I2V)},
        'IMG': ${s(recordedCoords.IMG)},
        trigger_create_menu: ${s(recordedCoords.trigger_create_menu)}
    },
    ratioVideo: {
        'Ngang': ${s(recordedCoords.ratio_ngang)},
        'Dọc': ${s(recordedCoords.ratio_doc)}
    },
    ratioImage: {
        '16:9': ${s(recordedCoords.ratio_img_16_9)},
        '9:16': ${s(recordedCoords.ratio_img_9_16)},
        '1:1': ${s(recordedCoords.ratio_img_1_1)},
        '4:3': ${s(recordedCoords.ratio_img_4_3)},
        '3:4': ${s(recordedCoords.ratio_img_3_4)}
    },
    countVideo: {
        '1': ${s(recordedCoords.count_1)},
        '2': ${s(recordedCoords.count_2)},
        '3': ${s(recordedCoords.count_3)},
        '4': ${s(recordedCoords.count_4)}
    },
    countImage: {
        '1': ${s(recordedCoords.count_img_1)},
        '2': ${s(recordedCoords.count_img_2)},
        '3': ${s(recordedCoords.count_img_3)},
        '4': ${s(recordedCoords.count_img_4)}
    },
    durationVideo: {
        '4s': ${s(recordedCoords.duration_4s)},
        '6s': ${s(recordedCoords.duration_6s)},
        '8s': ${s(recordedCoords.duration_8s)}
    },
    model: {
        trigger_video: ${s(recordedCoords.model_trigger_video)},
        trigger_image: ${s(recordedCoords.model_trigger_image)},
        'Veo 3.1 - Lite [Lower Priority]': ${s(recordedCoords.model_veo_fast_low)},
        'Veo 3.1 - Fast': ${s(recordedCoords.model_veo_fast)},
        'Nano Banana Pro': ${s(recordedCoords.model_nano)},
        'nano banana 2': ${s(recordedCoords.model_nano2)}
    },
    submitBtn: ${s(recordedCoords.submit_btn)},
    viewMode: {
        trigger: ${s(recordedCoords.trigger_view_mode)},
        batch: ${s(recordedCoords.view_batch)},
        size_S: ${s(recordedCoords.view_grid_S)},
        sound_off: ${s(recordedCoords.view_sound_off)},
        return_silent: ${s(recordedCoords.view_return_silent)},
        info_on: ${s(recordedCoords.view_info_on)},
        clear_off: ${s(recordedCoords.view_clear_off)}
    }
}
===========================`;

        console.log(output);
        removeOverlay();
    }

    // ─── Event Handlers ───
    const mouseHandler = function (e) {
        currentX = e.clientX;
        currentY = e.clientY;
        // Live preview cập nhật liên tục theo chuột
        const hoveredEl = document.elementFromPoint(currentX, currentY);
        showHoverPreview(hoveredEl);
    };

    const keyHandler = function (e) {
        if (e.code === 'Space') {
            e.preventDefault();
            e.stopPropagation();

            const step = steps[currentStep];
            const hoveredEl = document.elementFromPoint(currentX, currentY);
            const capturedData = analyzeElement(hoveredEl);

            // Lưu lại (bỏ _debug)
            recordedCoords[step.key] = { type: capturedData.type, value: capturedData.value };

            const debugInfo = capturedData._debug || '';
            console.log(
                `%c✅ BƯỚC ${currentStep + 1}%c (${step.label})\n` +
                `%c   → ${capturedData.type}: ${JSON.stringify(capturedData.value)}\n` +
                `%c   ℹ ${debugInfo}`,
                'color:#00ff00;font-weight:bold', 'color:#aaa',
                'color:#ffcc00', 'color:#888'
            );

            currentStep++;

            if (currentStep >= steps.length) {
                document.removeEventListener('mousemove', mouseHandler, true);
                document.removeEventListener('keydown', keyHandler, true);
                printFinalResult();
            } else {
                showOverlay(steps[currentStep].label);
            }
        }
    };

    // ─── Khởi chạy ───
    console.clear();
    console.log("%c🚀 UI RECORDER V4.0 — DOM SMART RECORDER 🚀", "color: #00bbff; font-size: 20px; font-weight: bold;");
    console.log("%cThuật toán: 6-Pass DOM Analysis (đồng bộ worker.js)", "color: #888; font-size: 14px;");
    console.log("%cDi chuột để xem Live Preview ở dưới màn hình. Bấm SPACE để ghi.", "color: #aaa; font-size: 13px;");
    showOverlay(steps[currentStep].label);

    document.addEventListener('mousemove', mouseHandler, true);
    document.addEventListener('keydown', keyHandler, true);
})();
