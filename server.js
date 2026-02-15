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

// Use PowerShell for native dialogs
function pickFile(filter = "Excel Files (*.xlsx)|*.xlsx") {
    try {
        const cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = '${filter}'; $f.ShowDialog() | Out-Null; $f.FileName"`;
        const output = execSync(cmd).toString().trim();
        return output && fs.existsSync(output) ? output : null;
    } catch (e) {
        console.error("File pick error:", e);
        return null;
    }
}

function pickFolder() {
    try {
        const cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; $f.SelectedPath"`;
        const output = execSync(cmd).toString().trim();
        return output && fs.existsSync(output) ? output : null;
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

let automationInstance = null;

app.post('/api/start', async (req, res) => {
    const { inputDir, workerCount = 1 } = req.body;
    if (!inputDir) return res.status(400).json({ error: "Missing input path" });

    if (automationInstance && automationInstance.isRunning) {
        return res.status(400).json({ error: "Already running" });
    }

    // Initialize Master Automation
    automationInstance = new AutomationService(io, inputDir, parseInt(workerCount));
    automationInstance.start();

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
    // Open browser automatically
    const open = require('open'); // Need to require open if installed, or just exec 'start'
    try {
        execSync(`start http://localhost:${PORT}`);
    } catch (e) { }
});
