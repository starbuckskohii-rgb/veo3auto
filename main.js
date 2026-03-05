const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: path.join(__dirname, 'public/favicon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false
        },
        autoHideMenuBar: true
    });

    // Load localhost
    // We assume server starts quickly.
    setTimeout(() => {
        mainWindow.loadURL('http://localhost:3001');
    }, 1000);

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

function startServer() {
    try {
        console.log('Starting internal server...');

        // Config paths for production (writeable paths)
        const userDataPath = app.getPath('userData');
        process.env.USER_DATA_PATH = userDataPath;
        process.env.PUPPETEER_CACHE_DIR = path.join(userDataPath, 'puppeteer_cache');

        // Create dirs if not exist
        const fs = require('fs');
        if (!fs.existsSync(process.env.PUPPETEER_CACHE_DIR)) {
            fs.mkdirSync(process.env.PUPPETEER_CACHE_DIR, { recursive: true });
        }

        console.log('User Data Path:', process.env.USER_DATA_PATH);

        // Require server.js to run it in the Main Process
        require('./server.js');
    } catch (e) {
        console.error('Failed to start server:', e);
    }
}

app.on('ready', () => {
    startServer();
    createWindow();
});

app.on('window-all-closed', function () {
    try {
        const fs = require('fs');
        const path = require('path');
        const rootDir = process.cwd();
        // The outputDir is typically defined in automation.js or by the user, 
        // but default is usually a subfolder or we scan the root/Output directories.
        // Let's implement a robust recursive search for 'temp_' folders and let the main process clean them.

        const deleteTempFolders = (dir) => {
            if (!fs.existsSync(dir)) return;
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) {
                    if (item.startsWith('temp_')) {
                        console.log(`Cleaning up leftover temp folder: ${fullPath}`);
                        try {
                            fs.rmSync(fullPath, { recursive: true, force: true });
                        } catch (e) {
                            console.error(`Failed to delete ${fullPath}: ${e.message}`);
                        }
                    } else if (item !== 'node_modules' && item !== '.git') {
                        deleteTempFolders(fullPath);
                    }
                }
            }
        };

        // Scan root directory and common output directories
        deleteTempFolders(rootDir);

    } catch (e) {
        console.error("Error during temp cleanup on exit:", e);
    }

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow();
    }
});
