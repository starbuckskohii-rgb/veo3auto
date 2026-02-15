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
            contextIsolation: true
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
        // Require server.js to run it in the Main Process
        // This avoids needing 'node.exe' installed on the user system.
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
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow();
    }
});
