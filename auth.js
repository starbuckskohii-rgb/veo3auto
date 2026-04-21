const admin = require('firebase-admin');
const { machineIdSync } = require('node-machine-id');
const fs = require('fs');
const path = require('path');

// Đường dẫn trỏ tới file serviceAccountKey.json
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');

// Khởi tạo Firebase Admin SDK
let isFirebaseInitialized = false;

function initFirebase() {
    if (isFirebaseInitialized) return;

    if (!fs.existsSync(serviceAccountPath)) {
        console.error(`[Firebase] Không tìm thấy file ${serviceAccountPath}. Vui lòng ném file này vào thư mục gốc của dự án.`);
        return false;
    }

    try {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        isFirebaseInitialized = true;
        console.log("[Firebase] Admin SDK Initialized Successfully.");
        return true;
    } catch (e) {
        console.error("[Firebase] Initialization error:", e);
        return false;
    }
}

// Middleware để kiểm tra và xác thực mọi request API quan trọng
const requireAuth = async (req, res, next) => {
    if (!isFirebaseInitialized) {
        if (!initFirebase()) {
            return res.status(500).json({ error: "Hệ thống chưa cấu hình Firebase Service Account." });
        }
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized: Missing Token" });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        // 1. Verify Token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;
        const email = decodedToken.email;
        console.log(`[Firebase] Checking access for: ${email} (${uid})...`);

        // 2. Fetch User Data from Firestore
        const db = admin.firestore();
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            console.log(`[Firebase] User ${email} not found in Firestore. Creating...`);
            // Nếu user chưa tồn tại trong Firestore, tạo mới (Với expirationDate mặc định là quá khứ)
            await userRef.set({
                email: email,
                hwid: "",
                expirationDate: admin.firestore.Timestamp.fromDate(new Date(0)),
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[Firebase] User ${email} created in Firestore with default expired license.`);
            return res.status(403).json({ error: "Tài khoản chưa được kích hoạt bản quyền." });
        }

        const userData = userDoc.data();
        console.log("[Firebase] User data fetched.");

        // 3. Kiểm tra Hạn Sử Dụng (Expiration Date)
        const now = new Date();
        if (!userData.expirationDate) {
            console.warn(`[Firebase] User ${email} missing expirationDate.`);
            return res.status(403).json({ error: "Chưa có cấu hình ngày hết hạn." });
        }

        let expDate;
        if (typeof userData.expirationDate === 'string') {
            expDate = new Date(userData.expirationDate);
        } else if (userData.expirationDate && typeof userData.expirationDate.toDate === 'function') {
            expDate = userData.expirationDate.toDate();
        } else {
            console.warn(`[Firebase] Cannot parse expirationDate type for ${email}`);
            return res.status(403).json({ error: "Lỗi định dạng cấu hình ngày hết hạn." });
        }

        if (now > expDate) {
            console.log(`[Firebase] User ${email} expired at ${expDate}`);
            return res.status(403).json({ error: "Tài khoản đã hết hạn bản quyền. Vui lòng gia hạn." });
        }

        // 4. Kiểm tra mã phần cứng (HWID Lock)
        const currentHwid = machineIdSync();
        
        // Làm sạch HWID từ DB (Xử lý trường hợp người dùng nhập nhầm dấu nháy kép "" vào Firestore UI)
        let dbHwid = userData.hwid || "";
        if (typeof dbHwid === 'string') {
            dbHwid = dbHwid.replace(/['"]/g, '').trim();
        }

        if (!dbHwid) {
            // Khóa HWID lần đầu tiên
            console.log(`[Firebase] First login for ${email}. Locking HWID: ${currentHwid}`);
            await userRef.update({ hwid: currentHwid });
        } else if (dbHwid !== currentHwid) {
            console.warn(`[Firebase] HWID Mismatch for ${email}. DB: ${dbHwid}, Client: ${currentHwid}`);
            return res.status(403).json({ error: "Tài khoản này đang được sử dụng ở một máy tính khác. Không thể chia sẻ Tool." });
        }

        console.log(`[Firebase] Authentication Successful for ${email}`);
        // Passed all checks
        req.user = { uid, email };
        next();
    } catch (error) {
        console.error("[Firebase] Auth Validation Error:", error.message);
        return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn." });
    }
};

module.exports = {
    initFirebase,
    requireAuth
};
