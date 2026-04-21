(function () {
    const steps = [
        // Các nút chung + Menu Tạo (Gộp cả Model và Tỉ lệ)
        { key: "trigger_create_menu", label: "MỞ BẢNG TÙY CHỈNH (Nhấn vào nút góc dưới màn hình để mở bảng to như ảnh gốc)" },
        { key: "T2V", label: "Trong bảng, click chọn nút: Video (Tạo Video)" },
        { key: "I2V", label: "Trong bảng, click chọn nút: Frames (Hoặc Video)" },
        { key: "IN2V", label: "Trong bảng, click chọn nút: Ingredients (Thành phần)" },

        // Cấu hình VIDEO
        { key: "ratio_ngang", label: "Đưa chuột vào nút tỉ lệ: Ngang" },
        { key: "ratio_doc", label: "Đưa chuột vào nút tỉ lệ: Dọc" },

        { key: "count_1", label: "Đưa chuột vào Đầu ra/Số lượng: x1" },
        { key: "count_2", label: "Đưa chuột vào Đầu ra/Số lượng: x2" },
        { key: "count_3", label: "Đưa chuột vào Đầu ra/Số lượng: x3" },
        { key: "count_4", label: "Đưa chuột vào Đầu ra/Số lượng: x4" },

        { key: "model_trigger_video", label: "Đưa chuột vào ô Hộp thoại Mô Hình (VD: Veo 3.1 Fast, đang hiện trên màn hình)" },
        { key: "model_veo_fast_low", label: "Mở danh sách Mô hình ra, đưa chuột vào: Veo 3.1 - Fast [Lower Priority]" },
        { key: "model_veo_fast", label: "Đưa chuột vào Mô Hình: Veo 3.1 - Fast" },

        // Cấu hình IMAGE (phải click chuyển tab)
        { key: "IMG", label: "BÂY GIỜ HÃY CLICK CHUYỂN SANG TAB ẢNH (Image) BÊN TRONG BẢNG NÀY. Xong ấn phím Space." },

        // Đo đạc lại tỉ lệ riêng cho Image (Vì Image có thêm vị trí khác Video)
        { key: "ratio_img_16_9", label: "Đưa chuột vào nút tỉ lệ ảnh: Ngang (16:9)" },
        { key: "ratio_img_9_16", label: "Đưa chuột vào nút tỉ lệ ảnh: Dọc (9:16)" },
        { key: "ratio_img_1_1", label: "Đưa chuột vào nút tỉ lệ ảnh: Vuông (1:1)" },
        { key: "ratio_img_4_3", label: "Đưa chuột vào nút tỉ lệ ảnh: Ngang (4:3)" },
        { key: "ratio_img_3_4", label: "Đưa chuột vào nút tỉ lệ ảnh: Dọc (3:4)" },

        { key: "count_img_1", label: "Đưa chuột vào Đầu ra/Số lượng ảnh: x1" },
        { key: "count_img_2", label: "Đưa chuột vào Đầu ra/Số lượng ảnh: x2" },
        { key: "count_img_3", label: "Đưa chuột vào Đầu ra/Số lượng ảnh: x3" },
        { key: "count_img_4", label: "Đưa chuột vào Đầu ra/Số lượng ảnh: x4" },

        { key: "model_trigger_image", label: "Đưa chuột vào ô Hộp thoại Mô Hình (Bên tab Ảnh)" },
        { key: "model_nano", label: "Mở danh sách Mô hình ra, đưa chuột vào: Nano Banana Pro" },
        { key: "model_nano2", label: "Mở danh sách Mô hình ra, đưa chuột vào: nano banana 2" },

        // Mũi tên Gửi
        { key: "submit_btn", label: "Đóng bảng chọn lại. Đưa chuột vào NÚT MŨI TÊN (TẠO/GENERATE) ở góc dưới khung nhập." },

        // Cài đặt View Mode (Bảng hiển thị)
        { key: "trigger_view_mode", label: "Đưa chuột vào nút mở Bảng VIEW MODE (Cài đặt hiển thị) trên góc phải màn hình bên ngoài." },
        { key: "view_batch", label: "Mở bảng View Mode. Đưa chuột vào ô: Batch (Theo lô)" },
        { key: "view_grid_S", label: "Đưa chuột vào Kích thước lưới: S" },

        { key: "view_sound_off", label: "Đưa chuột vào: Âm thanh khi di chuột -> Đang tắt" },
        { key: "view_info_on", label: "Đưa chuột vào: Hiện thông tin chi tiết -> Đang bật" },
        { key: "view_clear_off", label: "Đưa chuột vào: Xoá câu lệnh sau khi gửi -> Đang tắt" }
    ];

    let currentStep = 0;
    const recordedCoords = {};
    let currentX = 0;
    let currentY = 0;

    function showOverlay(message) {
        let overlay = document.getElementById('ui-recorder-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'ui-recorder-overlay';
            Object.assign(overlay.style, {
                position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.85)', color: 'white', padding: '15px 30px',
                borderRadius: '8px', zIndex: '999999', fontSize: '18px', fontWeight: 'bold',
                pointerEvents: 'none', border: '2px solid #00bbff', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                textAlign: 'center', lineHeight: '1.5'
            });
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = `<span style="color: #00bbff; font-size: 22px;">BƯỚC ${currentStep + 1}/${steps.length}</span><br/><br/>
            VUI LÒNG ĐƯA CHUỘT VÀO:<br/>
            <span style="color: #ffcc00; font-size: 24px;">${message}</span><br/><br/>
            <span style="color: #00ff00;">(Bạn có thể thả tự do chuột đi click chuyển chế độ tab thoải mái)</span><br/>
            <span style="color: #ff4444; font-size: 20px;">SAU KHI CHỈ CHUỘT VÀO ĐÚNG NÚT, NHẤN MỘT PHÍM SPACE ĐỂ TIẾP TỤC!</span>`;
    }

    function removeOverlay() {
        const overlay = document.getElementById('ui-recorder-overlay');
        if (overlay) overlay.remove();
    }

    function printFinalResult() {
        console.clear();
        console.log("%c🎉 ĐÃ GHI XONG TỌA ĐỘ BẢN MỚI! 🎉", "color: #00ff00; font-size: 24px; font-weight: bold;");
        console.log("%cHãy COPY toàn bộ đoạn kết quả dưới đây và dán vào cửa sổ chat cho tôi:", "color: #ffcc00; font-size: 16px; margin-bottom: 10px;");

        const output = `==== KẾT QUẢ TỌA ĐỘ V3 ====
{
    modes: {
        'T2V': { x: ${recordedCoords.T2V.x}, y: ${recordedCoords.T2V.y} },
        'IN2V': { x: ${recordedCoords.I2V.x}, y: ${recordedCoords.I2V.y} },
        'I2V': { x: ${recordedCoords.IN2V.x}, y: ${recordedCoords.IN2V.y} },
        'IMG': { x: ${recordedCoords.IMG.x}, y: ${recordedCoords.IMG.y} },
        trigger_create_menu: { x: ${recordedCoords.trigger_create_menu.x}, y: ${recordedCoords.trigger_create_menu.y} }
    },
    ratioVideo: {
        'Ngang': { x: ${recordedCoords.ratio_ngang.x}, y: ${recordedCoords.ratio_ngang.y} },
        'Dọc': { x: ${recordedCoords.ratio_doc.x}, y: ${recordedCoords.ratio_doc.y} }
    },
    ratioImage: {
        '16:9': { x: ${recordedCoords.ratio_img_16_9.x}, y: ${recordedCoords.ratio_img_16_9.y} },
        '9:16': { x: ${recordedCoords.ratio_img_9_16.x}, y: ${recordedCoords.ratio_img_9_16.y} },
        '1:1': { x: ${recordedCoords.ratio_img_1_1.x}, y: ${recordedCoords.ratio_img_1_1.y} },
        '4:3': { x: ${recordedCoords.ratio_img_4_3.x}, y: ${recordedCoords.ratio_img_4_3.y} },
        '3:4': { x: ${recordedCoords.ratio_img_3_4.x}, y: ${recordedCoords.ratio_img_3_4.y} }
    },
    countVideo: {
        '1': { x: ${recordedCoords.count_1.x}, y: ${recordedCoords.count_1.y} },
        '2': { x: ${recordedCoords.count_2.x}, y: ${recordedCoords.count_2.y} },
        '3': { x: ${recordedCoords.count_3.x}, y: ${recordedCoords.count_3.y} },
        '4': { x: ${recordedCoords.count_4.x}, y: ${recordedCoords.count_4.y} }
    },
    countImage: {
        '1': { x: ${recordedCoords.count_img_1.x}, y: ${recordedCoords.count_img_1.y} },
        '2': { x: ${recordedCoords.count_img_2.x}, y: ${recordedCoords.count_img_2.y} },
        '3': { x: ${recordedCoords.count_img_3.x}, y: ${recordedCoords.count_img_3.y} },
        '4': { x: ${recordedCoords.count_img_4.x}, y: ${recordedCoords.count_img_4.y} }
    },
    model: {
        trigger_video: { x: ${recordedCoords.model_trigger_video.x}, y: ${recordedCoords.model_trigger_video.y} },
        trigger_image: { x: ${recordedCoords.model_trigger_image.x}, y: ${recordedCoords.model_trigger_image.y} },
        'Veo 3.1 - Fast [Lower Priority]': { x: ${recordedCoords.model_veo_fast_low.x}, y: ${recordedCoords.model_veo_fast_low.y} },
        'Veo 3.1 - Fast': { x: ${recordedCoords.model_veo_fast.x}, y: ${recordedCoords.model_veo_fast.y} },
        'Nano Banana Pro': { x: ${recordedCoords.model_nano.x}, y: ${recordedCoords.model_nano.y} },
        'nano banana 2': { x: ${recordedCoords.model_nano2.x}, y: ${recordedCoords.model_nano2.y} }
    },
    submitBtn: { x: ${recordedCoords.submit_btn.x}, y: ${recordedCoords.submit_btn.y} },
    viewMode: {
        trigger: { x: ${recordedCoords.trigger_view_mode.x}, y: ${recordedCoords.trigger_view_mode.y} },
        batch: { x: ${recordedCoords.view_batch.x}, y: ${recordedCoords.view_batch.y} },
        size_S: { x: ${recordedCoords.view_grid_S.x}, y: ${recordedCoords.view_grid_S.y} },
        sound_off: { x: ${recordedCoords.view_sound_off.x}, y: ${recordedCoords.view_sound_off.y} },
        info_on: { x: ${recordedCoords.view_info_on.x}, y: ${recordedCoords.view_info_on.y} },
        clear_off: { x: ${recordedCoords.view_clear_off.x}, y: ${recordedCoords.view_clear_off.y} }
    }
}
===========================`;

        console.log(output);
        removeOverlay();
    }

    const mouseHandler = function (e) {
        currentX = e.clientX;
        currentY = e.clientY;
    };

    const keyHandler = function (e) {
        if (e.code === 'Space') {
            e.preventDefault();

            const step = steps[currentStep];
            recordedCoords[step.key] = { x: currentX, y: currentY };

            console.log(`✅ BƯỚC ${currentStep + 1} (${step.label}): X=${currentX}, Y=${currentY}`);

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

    console.clear();
    console.log("%c🚀 BẮT ĐẦU GHI HÌNH TỌA ĐỘ V3.2 (GHI BẰNG PHÍM SPACE) 🚀", "color: #00bbff; font-size: 20px; font-weight: bold;");
    showOverlay(steps[currentStep].label);

    document.addEventListener('mousemove', mouseHandler, true);
    document.addEventListener('keydown', keyHandler, true);
})();
