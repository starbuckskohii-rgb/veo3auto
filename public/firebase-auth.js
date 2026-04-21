import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

const loginOverlay = document.getElementById('loginOverlay');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const btnLoginAction = document.getElementById('btnLoginAction');
const loginError = document.getElementById('loginError');
const loginStatus = document.getElementById('loginStatus');

window.firebaseToken = null;

// Kiểm tra xem Server có đang bật chế độ DEV_MODE (bỏ qua Auth) không
fetch('/api/auth-status').then(r => r.json()).then(status => {
    if (status.disabled) {
        console.log("🛠️ [DEV MODE] Đã tắt màn hình xác thực bảo mật Firebase.");
        if (loginOverlay) loginOverlay.style.display = 'none';
        return; // Dừng lại ở đây, tool chạy bình thường không cần Auth
    }

    // --- NẾU LÀ BẢN PRODUCTION THƯỜNG ---
    const firebaseConfig = {
        apiKey: "AIzaSyB-C8_Z82Awr0bMZ6UtteJOWDrIKC8hpe8",
        authDomain: "yt-report-engine.firebaseapp.com",
        projectId: "yt-report-engine",
        storageBucket: "yt-report-engine.firebasestorage.app",
        messagingSenderId: "1071543313017",
        appId: "1:1071543313017:web:b250a82ff70ad1ebbdaaa8",
        measurementId: "G-SCXJ8C3QKW"
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);

    // Override fetch to include Authorization Header
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        let [resource, config] = args;
        if (typeof resource === 'string' && resource.startsWith('/api/') && window.firebaseToken) {
            config = config || {};
            config.headers = {
                ...config.headers,
                'Authorization': `Bearer ${window.firebaseToken}`
            };
            args = [resource, config];
        }
        const response = await originalFetch(...args);

        // If API returns 401 or 403, it means Token/HWID/Sub is invalid
        if (response.status === 401 || response.status === 403) {
            let msg = "Lỗi phiên đăng nhập.";
            try {
                const data = await response.clone().json();
                msg = data.error || msg;
            } catch (e) { }

            if (loginOverlay) loginOverlay.style.display = 'flex';
            if (loginError) {
                loginError.style.display = 'block';
                loginError.textContent = msg;
            }
            window.firebaseToken = null;
        }

        return response;
    };

    // Check Auth State
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                if (loginStatus) {
                    loginStatus.style.display = 'block';
                    loginStatus.textContent = 'Đang xác thực bảo mật phần cứng...';
                }
                // Get token and trigger a dummy API to verify Auth, HWID & Sub on backend
                window.firebaseToken = await user.getIdToken(true);

                // Ping backend to check access (with 15s timeout)
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const res = await fetch('/api/version', {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (res.ok) {
                    // Access granted
                    if (loginOverlay) loginOverlay.style.display = 'none';
                    if (loginStatus) loginStatus.style.display = 'none';
                } else {
                    // Handle non-ok responses that might not be 401/403
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || `Server error: ${res.status}`);
                }
            } catch (error) {
                console.error("Auth validation failed", error);
                
                let errorMsg = error.message;
                if (error.name === 'AbortError') {
                    errorMsg = "Lỗi: Không kết nối được tới Server (Timeout). Vui lòng kiểm tra lại mạng hoặc Proxy/Firewall.";
                }

                if (loginStatus) {
                    loginStatus.style.display = 'none';
                }
                if (loginError) {
                    loginError.style.display = 'block';
                    loginError.textContent = errorMsg;
                }
                window.firebaseToken = null;
            }
        } else {
            // Not logged in
            if (loginOverlay) loginOverlay.style.display = 'flex';
            if (loginStatus) loginStatus.style.display = 'none';
            window.firebaseToken = null;
        }
    });

    // Login UI Action
    if (btnLoginAction) {
        btnLoginAction.addEventListener('click', async () => {
            const email = loginEmail.value.trim();
            const pass = loginPassword.value;

            if (!email || !pass) {
                loginError.style.display = 'block';
                loginError.textContent = 'Vui lòng nhập Email và Password';
                return;
            }

            loginError.style.display = 'none';
            btnLoginAction.disabled = true;
            btnLoginAction.textContent = 'Đang xử lý...';

            try {
                await signInWithEmailAndPassword(auth, email, pass);
                // onAuthStateChanged will handle the rest
            } catch (error) {
                loginError.style.display = 'block';
                switch (error.code) {
                    case 'auth/invalid-credential':
                        loginError.textContent = 'Tài khoản hoặc mật khẩu không chính xác.';
                        break;
                    case 'auth/too-many-requests':
                        loginError.textContent = 'Quá nhiều lần thử. Vui lòng đợi chút.';
                        break;
                    default:
                        loginError.textContent = 'Lỗi: ' + error.message;
                }
            } finally {
                btnLoginAction.disabled = false;
                btnLoginAction.textContent = 'Đăng Nhập';
            }
        });
    }

    // Thêm Logout Button vào sidebar (dynamic)
    const sidebarActions = document.querySelector('.actions');
    if (sidebarActions) {
        const btnLogout = document.createElement('button');
        btnLogout.className = 'secondary-btn';
        btnLogout.style = 'margin-top: 8px; width: 100%; border: 1px solid var(--danger-color); color: var(--danger-color); background: rgba(220,38,38,0.05);';
        btnLogout.innerHTML = '🚪 Đăng Xuất';
        btnLogout.onclick = () => {
            if (confirm("Xác nhận đăng xuất thiết bị này?")) {
                signOut(auth);
            }
        }
        sidebarActions.appendChild(btnLogout);
    }

}).catch(e => console.error("Could not fetch auth status", e));
