const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const AccountManager = require('./accountManager');
const ProxyManager = require('./proxyManager');
const AutomationService = require('./automation'); // We will create this next

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

const userDataPath = process.env.USER_DATA_PATH || process.cwd();
const accountManager = new AccountManager(userDataPath);
const proxyManager = new ProxyManager(userDataPath);
const mappingPath = path.join(userDataPath, 'thread_mapping.json');

function getThreadMapping() {
    try {
        if (fs.existsSync(mappingPath)) {
            return JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        }
    } catch (e) { console.error("Error reading mapping:", e); }
    return {};
}

function saveThreadMapping(mapping) {
    fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf8');
}

const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false; // We want to control the download
autoUpdater.autoInstallOnAppQuit = true;

// --- Utilities ---

const { dialog, BrowserWindow } = require('electron');

function pickFile(filterName = "Excel Files", filterExt = ["xlsx"]) {
    try {
        const win = BrowserWindow.getFocusedWindow();
        const result = dialog.showOpenDialogSync(win, {
            properties: ['openFile'],
            filters: [{ name: filterName, extensions: filterExt }]
        });
        return result && result.length > 0 ? result[0] : null;
    } catch (e) {
        console.error("File pick error:", e);
        return null;
    }
}

function pickFolder() {
    try {
        const win = BrowserWindow.getFocusedWindow();
        const result = dialog.showOpenDialogSync(win, {
            properties: ['openDirectory']
        });
        return result && result.length > 0 ? result[0] : null;
    } catch (e) {
        console.error("Folder pick error:", e);
        return null;
    }
}

// --- API ---

app.get('/api/pick-excel', (req, res) => {
    const path = pickFile();
    res.json({ path });
});

app.get('/api/pick-folder', (req, res) => {
    const path = pickFolder();
    res.json({ path });
});

app.get('/api/version', (req, res) => {
    try {
        const pkg = require('./package.json');
        res.json({ version: pkg.version });
    } catch {
        res.json({ version: 'Unknown' });
    }
});

// --- Browser Install API ---
app.post('/api/check-browser', (req, res) => {
    const { browserType } = req.body;
    let exists = true;
    if (browserType === 'brave') {
        const fs = require('fs');
        const path = require('path');
        const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
        const bravePaths = [
            'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
            path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        ];
        exists = bravePaths.some(p => fs.existsSync(p));
    }
    res.json({ exists });
});

app.post('/api/install-browser', (req, res) => {
    const { browserType } = req.body;
    if (browserType === 'brave') {
        const { spawn } = require('child_process');
        io.emit('log', `[System] Bắt đầu gọi lệnh tải Brave Browser (winget)...`);

        const child = spawn('winget', ['install', '-e', '--id', 'Brave.Brave', '--accept-package-agreements', '--accept-source-agreements'], { shell: true });

        let lastPercent = -1;

        child.stdout.on('data', (data) => {
            const output = data.toString();
            // Winget uses a lot of carriage returns \r for its progress bars.
            // Let's try to extract the % directly.
            const match = output.match(/(\d{1,3})\s*%/);
            if (match) {
                const percent = parseInt(match[1]);
                if (percent !== lastPercent) {
                    io.emit('install-progress', percent);
                    lastPercent = percent;
                }
            } else {
                // If not a progress bar, clean the line and log it to UI
                const lines = output.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !l.includes('██') && !l.includes('¦¦'));
                for (let line of lines) {
                    io.emit('log', `[Brave-Installer] ${line}`);
                }
            }
        });

        child.stderr.on('data', (data) => {
            const lines = data.toString().split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !l.includes('██'));
            for (let line of lines) {
                io.emit('log', `[Brave-Installer Warning/Error] ${line}`);
            }
        });

        child.on('close', (code) => {
            // 2316632107 means "No newer package versions are available from the configured sources." -> Already installed!
            if (code === 0 || code === 2316632107) {
                io.emit('log', `[System] Tải và Cài đặt Brave hoàn tất!`);
                io.emit('install-progress', 100);
                res.json({ success: true });
            } else {
                io.emit('log', `[System] Instalation failed with exit code ${code}`);
                res.status(500).json({ error: "Failed to install Brave browser" });
            }
        });
    } else {
        res.json({ success: true });
    }
});

// --- Accounts API ---
app.get('/api/accounts', (req, res) => {
    res.json(accountManager.getAccounts());
});

app.post('/api/accounts', (req, res) => {
    const newTarget = accountManager.addAccount(req.body);
    res.json(newTarget);
});

app.put('/api/accounts/:id', (req, res) => {
    const updated = accountManager.updateAccount(req.params.id, req.body);
    if (updated) res.json(updated);
    else res.status(404).json({ error: 'Account not found' });
});

app.delete('/api/accounts/:id', (req, res) => {
    try {
        const deleted = accountManager.deleteAccount(req.params.id, getThreadMapping());
        if (deleted) res.json({ success: true });
        else res.status(404).json({ error: 'Account not found' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Mapping API
app.get('/api/accounts/mapping', (req, res) => {
    res.json(getThreadMapping());
});

app.post('/api/accounts/mapping', (req, res) => {
    saveThreadMapping(req.body);
    res.json({ success: true });
});

// --- Proxy API ---
app.get('/api/proxies', (req, res) => {
    const isAdmin = req.query.admin === 'true';
    res.json(proxyManager.getProxies(isAdmin));
});

app.post('/api/proxies', (req, res) => {
    const { rawText, isSystem } = req.body;
    const added = proxyManager.addProxiesRaw(rawText, isSystem === true);
    res.json({ success: true, added });
});

app.post('/api/proxies/check', async (req, res) => {
    // Check all proxies asynchronously, emitting logs via socket
    try {
        const results = await proxyManager.checkProxies(io);
        const isAdmin = req.body.admin === true;
        res.json({ success: true, proxies: isAdmin ? results : results.filter(p => !p.isSystem) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/proxies/dead', (req, res) => {
    const isAdmin = req.query.admin === 'true';
    const deleted = proxyManager.deleteAllDead(isAdmin);
    res.json({ success: deleted });
});

app.delete('/api/proxies/:id', (req, res) => {
    const isAdmin = req.query.admin === 'true';
    const deleted = proxyManager.deleteProxy(req.params.id, isAdmin);
    res.json({ success: deleted });
});

// Create Profile API
app.post('/api/accounts/create-profile', async (req, res) => {
    const { id } = req.body;
    const account = accountManager.getAccountById(id);
    if (!account) return res.status(404).json({ error: "Account not found" });

    // Hỗ trợ tự động tạo profile cho cả 3 trình duyệt để lưu Cache sẵn dùng khi chạy clone
    try {
        const browsersToSetup = ['brave', 'chrome', 'edge'];
        let successCount = 0;
        let lastError = null;
        let createdMessages = [];

        for (const bType of browsersToSetup) {
            try {
                // Kiểm tra xem trình duyệt có tồn tại trên máy không
                if (bType === 'brave') {
                    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
                    const bravePaths = [
                        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                        path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
                    ];
                    if (!bravePaths.some(p => fs.existsSync(p))) {
                        continue; // Bỏ qua nếu không cài Brave
                    }
                }

                console.log(`[Profile Builder] Đang thiết lập cấu hình login cho: ${bType}`);
                const srv = new AutomationService(io, './', 1, accountManager, proxyManager, {}, bType, {});
                const worker = await srv.openProfile(id);

                // Chờ 2 giây để người dùng (nếu có nhìn) thấy báo thành công trước khi đóng
                await new Promise(r => setTimeout(r, 2000));
                await worker.close();

                successCount++;
                createdMessages.push(bType);
            } catch (err) {
                console.error(`[Profile Builder] Lỗi khi tạo profile bằng ${bType}:`, err.message);
                lastError = err.message;
            }
        }

        // Kiểm tra xem trạng thái profile đã được update thành công chưa (bởi auto-login hoặc manual)
        const updatedAcc = accountManager.getAccountById(id);
        if (updatedAcc && updatedAcc.hasProfile && successCount > 0) {
            res.json({ success: true, message: `Profile tạo thành công cho các trình duyệt: ${createdMessages.join(', ')}` });
        } else if (successCount > 0) {
            res.json({ success: true, message: `Profile đã mở qua: ${createdMessages.join(', ')}. Nhưng hệ thống có thể chưa nhận được cờ Login Success, vui lòng kiểm tra lại.` });
        } else {
            res.json({ success: false, message: `Thất bại khi tạo Profile. Lỗi cuối: ${lastError}` });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.post('/api/clear-retries', (req, res) => {
    const { inputDir } = req.body;
    if (!inputDir) return res.status(400).json({ error: "Missing input path" });
    if (automationInstance && automationInstance.isRunning) {
        return res.status(400).json({ error: "Cannot clear while automation is running." });
    }

    try {
        const xlsx = require('xlsx');
        const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
        let modifiedCount = 0;

        for (const file of files) {
            const filePath = path.join(inputDir, file);
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

            let updated = false;
            for (let i = 0; i < data.length; i++) {
                if (data[i]['RETRY_COUNT']) {
                    data[i]['RETRY_COUNT'] = ''; // Clear it
                    updated = true;
                }
            }

            if (updated) {
                const newWs = xlsx.utils.json_to_sheet(data);
                const newWb = xlsx.utils.book_new();
                xlsx.utils.book_append_sheet(newWb, newWs, sheetName);
                xlsx.writeFile(newWb, filePath);
                modifiedCount++;
            }
        }
        res.json({ status: "success", modifiedFiles: modifiedCount });
    } catch (e) {
        console.error("Clear retries error:", e);
        res.status(500).json({ error: e.message });
    }
});

let automationInstance = null;

app.post('/api/start', async (req, res) => {
    const { inputDir, workerCount = 1, activeAccountIds = [], browserType = 'edge', videoSettings, imgSettings, useProxy = true } = req.body;
    if (!inputDir) return res.status(400).json({ error: "Missing input path" });

    if (automationInstance && automationInstance.isRunning) {
        return res.status(400).json({ error: "Already running" });
    }

    // Load mapping from disk
    const mapping = getThreadMapping();

    // Initialize Master Automation
    automationInstance = new AutomationService(io, inputDir, parseInt(workerCount) || 1, accountManager, useProxy ? proxyManager : null, mapping, browserType, { videoSettings, imgSettings });
    try {
        automationInstance.start();
    } catch (e) {
        console.error("Failed to start automation:", e);
        io.emit('log', `Error starting: ${e.message}`);
    }

    res.json({ status: "started" });
});

app.post('/api/restart-worker', async (req, res) => {
    const { id, browserType = 'edge' } = req.body;
    if (automationInstance && automationInstance.isRunning) {
        await automationInstance.restartWorker(id, browserType);
        res.json({ status: 'restarted' });
    } else {
        res.status(400).json({ error: "Automation is not running." });
    }
});

app.post('/api/pause', async (req, res) => {
    if (automationInstance) {
        automationInstance.isPaused = true;
        io.emit('log', 'Automation Paused (Workers will sleep)');
        res.json({ status: 'paused' });
    } else {
        res.status(400).json({ error: 'Not running' });
    }
});

app.post('/api/resume', async (req, res) => {
    if (automationInstance) {
        automationInstance.isPaused = false;
        io.emit('log', 'Automation Resumed');
        res.json({ status: 'resumed' });
    } else {
        res.status(400).json({ error: 'Not running' });
    }
});


app.post('/api/open-profile', async (req, res) => {
    const { id, browserType = 'edge' } = req.body;
    // id here is the workerId from UI grid. Get account from mapping.
    const mapping = getThreadMapping();
    const accountId = mapping[id];

    if (!accountId) {
        return res.status(400).json({ error: `Chưa gán account cho Luồng ${id}` });
    }

    try {
        const srv = new AutomationService(io, './', 1, accountManager, proxyManager, mapping, browserType, {});
        await srv.openProfile(accountId);
        res.json({ status: 'opened' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/reset-profile', async (req, res) => {
    const { ids, id } = req.body; // Expecting an array of account IDs or a single id
    const targetIds = ids || (id ? [id] : []);

    // Safety check
    if (automationInstance && automationInstance.isRunning) {
        return res.status(400).json({ error: "Vui lòng dừng Automation trước khi Reset Profile." });
    }

    try {
        const baseDir = process.env.USER_DATA_PATH || path.resolve('./user_data');
        let deletedCount = 0;

        for (const targetId of targetIds) {
            // Look up account to get the real profilePath (e.g. profile_email_com)
            const account = accountManager.getAccountById(targetId);
            const profileRelPath = account && account.profilePath
                ? account.profilePath
                : `profile_${targetId}`; // fallback for legacy

            const profilePath = path.join(baseDir, profileRelPath);
            if (fs.existsSync(profilePath)) {
                try {
                    fs.rmSync(profilePath, { recursive: true, force: true });
                    deletedCount++;
                    console.log(`Deleted profile folder: ${profilePath}`);
                } catch (e) { console.error(`Error deleting ${profilePath}:`, e); }
            } else {
                console.log(`Profile folder not found (may already be deleted): ${profilePath}`);
            }

            // Mark account as no longer having a profile
            if (account) {
                accountManager.updateAccount(targetId, { hasProfile: false, status: 'Pending' });
            }
        }
        res.json({ status: 'success', deletedCount });
    } catch (e) {
        console.error("Reset profile error:", e);
        res.status(500).json({ error: e.message });
    }
});


app.post('/api/stop', async (req, res) => {
    if (automationInstance) {
        await automationInstance.stop();

        // Clean up any temp_ folders in the output directory after stopping
        try {
            const path = require('path');
            const fs = require('fs');
            const outputDir = automationInstance.outputDir;
            if (fs.existsSync(outputDir)) {
                // Read all folders inside Output
                const projects = fs.readdirSync(outputDir);
                for (const project of projects) {
                    const projectPath = path.join(outputDir, project);
                    if (fs.statSync(projectPath).isDirectory()) {
                        const items = fs.readdirSync(projectPath);
                        for (const item of items) {
                            if (item.startsWith('temp_')) {
                                const tempPath = path.join(projectPath, item);
                                try {
                                    fs.rmSync(tempPath, { recursive: true, force: true });
                                } catch (e) {
                                    console.error(`Failed to delete leftover temp folder: ${tempPath}`, e);
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Error cleaning up temp_ directories on stop:", err);
        }

        automationInstance = null;
    }
    res.json({ status: "stopped" });
});

app.get('/api/check-update', async (req, res) => {
    try {
        const updateCheckResult = await autoUpdater.checkForUpdates();
        if (updateCheckResult && updateCheckResult.updateInfo) {
            res.json({ status: "success", info: updateCheckResult.updateInfo });
        } else {
            res.json({ status: "no-update" });
        }
    } catch (e) {
        console.error("Update check error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/download-update', async (req, res) => {
    try {
        // We trigger the download. 
        // We will notify the client via socket when download is complete.
        autoUpdater.downloadUpdate();
        res.json({ status: "downloading" });
    } catch (e) {
        console.error("Download update error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/install-update', (req, res) => {
    res.json({ status: "installing" });
    setTimeout(() => {
        autoUpdater.quitAndInstall();
    }, 1000);
});

app.get('/api/check-update', async (req, res) => {
    try {
        const updateCheckResult = await autoUpdater.checkForUpdates();
        if (updateCheckResult && updateCheckResult.updateInfo) {
            res.json({ status: "success", info: updateCheckResult.updateInfo });
        } else {
            res.json({ status: "no-update" });
        }
    } catch (e) {
        console.error("Update check error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/download-update', async (req, res) => {
    try {
        // We trigger the download. 
        // We will notify the client via socket when download is complete.
        autoUpdater.downloadUpdate();
        res.json({ status: "downloading" });
    } catch (e) {
        console.error("Download update error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/install-update', (req, res) => {
    res.json({ status: "installing" });
    setTimeout(() => {
        autoUpdater.quitAndInstall();
    }, 1000);
});

// --- Socket Connection ---
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('log', 'Connected to server.');
});

// AutoUpdater events to socket
autoUpdater.on('update-available', (info) => {
    io.emit('log', `Update available: ${info.version}`);
    io.emit('update-status', { status: 'available', version: info.version });
});

autoUpdater.on('update-not-available', (info) => {
    io.emit('log', 'You are on the latest version.');
    io.emit('update-status', { status: 'up-to-date' });
});

autoUpdater.on('error', (err) => {
    io.emit('log', 'Error in auto-updater: ' + err.toString());
    io.emit('update-status', { status: 'error', error: err.toString() });
});

autoUpdater.on('download-progress', (progressObj) => {
    let log_message = `Download speed: ${Math.round(progressObj.bytesPerSecond / 1024)} KB/s`;
    log_message = log_message + ' - Downloaded ' + Math.round(progressObj.percent) + '%';
    io.emit('update-progress', { percent: progressObj.percent });
});

autoUpdater.on('update-downloaded', (info) => {
    io.emit('log', 'Update downloaded! Ready to install.');
    io.emit('update-status', { status: 'downloaded' });
});

// AutoUpdater events to socket
autoUpdater.on('update-available', (info) => {
    io.emit('log', `Update available: ${info.version}`);
    io.emit('update-status', { status: 'available', version: info.version });
});

autoUpdater.on('update-not-available', (info) => {
    io.emit('log', 'You are on the latest version.');
    io.emit('update-status', { status: 'up-to-date' });
});

autoUpdater.on('error', (err) => {
    io.emit('log', 'Error in auto-updater: ' + err.toString());
    io.emit('update-status', { status: 'error', error: err.toString() });
});

autoUpdater.on('download-progress', (progressObj) => {
    let log_message = `Download speed: ${Math.round(progressObj.bytesPerSecond / 1024)} KB/s`;
    log_message = log_message + ' - Downloaded ' + Math.round(progressObj.percent) + '%';
    io.emit('update-progress', { percent: progressObj.percent });
});

autoUpdater.on('update-downloaded', (info) => {
    io.emit('log', 'Update downloaded! Ready to install.');
    io.emit('update-status', { status: 'downloaded' });
});

const PORT = 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
    // Browser opened by Electron Main Process
});
