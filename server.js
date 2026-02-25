const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const AutomationService = require('./automation'); // We will create this next

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cors());

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
    const { inputDir, workerCount = 1, browserType = 'edge', videoSettings, imgSettings } = req.body;
    if (!inputDir) return res.status(400).json({ error: "Missing input path" });

    if (automationInstance && automationInstance.isRunning) {
        return res.status(400).json({ error: "Already running" });
    }

    // Initialize Master Automation
    automationInstance = new AutomationService(io, inputDir, parseInt(workerCount), browserType, { videoSettings, imgSettings });
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

app.post('/api/open-profile', async (req, res) => {
    const { id, browserType = 'edge' } = req.body;
    // Temp instance just to open profile manually when automation is offline
    const srv = new AutomationService(io, './', 1, browserType);
    await srv.openProfile(id);
    res.json({ status: 'opened' });
});

app.post('/api/reset-profile', async (req, res) => {
    const { ids } = req.body; // Expecting an array of profile IDs [1, 2, ...]

    // Safety check
    if (automationInstance && automationInstance.isRunning) {
        return res.status(400).json({ error: "Vui lòng dừng Automation trước khi Reset Profile." });
    }

    try {
        const baseDir = process.env.USER_DATA_PATH || path.resolve('./user_data');
        let deletedCount = 0;

        for (const id of ids) {
            const profilePath = path.join(baseDir, `profile_${id}`);
            if (fs.existsSync(profilePath)) {
                fs.rmSync(profilePath, { recursive: true, force: true });
                deletedCount++;
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
