const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, 'build_temp');
const DIST_DIR = path.join(__dirname, 'dist_secure');

console.log("=== BẮT ĐẦU ĐÓNG GÓI BẢO MẬT (ANTI-CRACK) ===");

// 1. Dọn dẹp
if (fs.existsSync(BUILD_DIR)) fs.rmSync(BUILD_DIR, { recursive: true, force: true });
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
fs.mkdirSync(BUILD_DIR);

// 2. Các file lõi cần mã hóa
const coreJsFiles = [
    'server.js', 'worker.js', 'automation.js',
    'auth.js', 'accountManager.js', 'proxyManager.js',
    'ui_recorder.js', 'encryption.js'
];

console.log("\n[1/3] Đang sao chép và mã hóa (Obfuscating) mã nguồn...");
for (const file of coreJsFiles) {
    if (fs.existsSync(file)) {
        // Obfuscate
        const outPath = path.join(BUILD_DIR, file);
        try {
            console.log(`  > Bắt đầu mã hóa: ${file}`);
            execSync(`npx javascript-obfuscator ${file} --output ${outPath} --compact true --disable-console-output true`, { stdio: 'pipe' });
            console.log(`  ✓ Mã hóa xong: ${file}`);
        } catch (e) {
            console.error(`  X Lỗi mã hóa ${file}:`, e.stderr ? e.stderr.toString() : e.message);
        }
    }
}

// 3. Xử lý các thư mục public và config
console.log("\n[2/3] Mở tự động trình duyệt trong Server (Do loại bỏ Electron)...");
let serverCode = fs.readFileSync(path.join(BUILD_DIR, 'server.js'), 'utf8');
// Chèn lệnh tự mở trình duyệt bằng open module thay vì chờ Electron nếu chạy bản PKG
const autoOpenSnippet = `
const open = require('open');
setTimeout(() => { open('http://localhost:3001'); }, 2000);
`;
fs.appendFileSync(path.join(BUILD_DIR, 'server.js'), autoOpenSnippet);

// Sao chép assets
fs.cpSync(path.join(__dirname, 'public'), path.join(BUILD_DIR, 'public'), { recursive: true });

// Sao chép package.json và chỉnh lại entry point
const pkgData = JSON.parse(fs.readFileSync('package.json'));
pkgData.main = 'server.js';
pkgData.bin = 'server.js';
fs.writeFileSync(path.join(BUILD_DIR, 'package.json'), JSON.stringify(pkgData, null, 2));

// 4. Đóng gói PKG
console.log("\n[3/3] Đang đóng gói thành 1 tệp .exe duy nhất bằng PKG...");
try {
    // Chạy pkg trên thư mục build_temp
    execSync(`npx pkg ${BUILD_DIR}/package.json --target node18-win-x64 --output ${DIST_DIR}/veo3auto-secure.exe`, { stdio: 'inherit' });
    console.log(`\n🎉 HOÀN TẤT! File thực thi bảo mật đã được tạo tại: ${DIST_DIR}/veo3auto-secure.exe`);
} catch (e) {
    console.error("Lỗi đóng gói PKG:", e.message);
}

// Cleanup
fs.rmSync(BUILD_DIR, { recursive: true, force: true });
