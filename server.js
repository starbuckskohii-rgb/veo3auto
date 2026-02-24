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
    const { inputDir, workerCount = 1 } = req.body;
    if (!inputDir) return res.status(400).json({ error: "Missing input path" });

    if (automationInstance && automationInstance.isRunning) {
        return res.status(400).json({ error: "Already running" });
    }

    // Initialize Master Automation
    automationInstance = new AutomationService(io, inputDir, parseInt(workerCount));
    try {
        automationInstance.start();
    } catch (e) {
        console.error("Failed to start automation:", e);
        io.emit('log', `Error starting: ${e.message}`);
    }

    res.json({ status: "started" });
});

app.post('/api/open-profile', async (req, res) => {
    const { id } = req.body;
    // Temp instance just to open profile
    const srv = new AutomationService(io, './', 1);
    // We don't track this instance for automation, just fire and forget (or keep ref to close?)
    // For manual login, user will close it manually usually.
    // Or we keep it in a separate list? 
    // Let's just launch it.
    await srv.openProfile(id);
    res.json({ status: 'opened' });
});

app.post('/api/stop', async (req, res) => {
    if (automationInstance) {
        await automationInstance.stop();
        automationInstance = null;
    }
    res.json({ status: "stopped" });
});

// --- Socket Connection ---
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('log', 'Connected to server.');
});

const PORT = 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
    // Browser opened by Electron Main Process
});
