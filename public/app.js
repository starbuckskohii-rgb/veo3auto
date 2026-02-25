const socket = io();

// DOM Elements
const btnPickInput = document.getElementById('btnPickInput');
const btnPickFolder = document.getElementById('btnPickFolder');
const inputPath = document.getElementById('inputPath');
// const inputOutput = document.getElementById('outputDir'); // Removed
const btnStart = document.getElementById('btnStart');
const startIcon = document.getElementById('startIcon');
const startText = document.getElementById('startText');
const logsContent = document.getElementById('logsContent');
const jobTableBody = document.getElementById('jobTableBody');
const statTotal = document.getElementById('statTotal');
const statCompleted = document.getElementById('statCompleted');
const statPending = document.getElementById('statPending');
const appVersionLabel = document.getElementById('appVersion');

// Fetch Version on Load
async function fetchAppVersion() {
    try {
        const res = await fetch('/api/version');
        const data = await res.json();
        if (data.version && appVersionLabel) {
            appVersionLabel.textContent = `v${data.version}`;
        }
    } catch (e) {
        console.warn('Could not fetch app version');
    }
}
fetchAppVersion();

// State
let jobs = [];

// Socket Events
socket.on('log', (msg) => {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = `> ${msg}`;
    logsContent.appendChild(div);
    logsContent.scrollTop = logsContent.scrollHeight;
});

socket.on('job-list', (list) => {
    jobs = list;
    renderTable();
    updateStats();
});

socket.on('job-update', (updatedJob) => {
    const index = jobs.findIndex(j => j.JOB_ID === updatedJob.JOB_ID); // Use a unique ID logic if possible, or fallback to job_id
    if (index !== -1) {
        jobs[index] = updatedJob;
        renderTable();
        updateStats();

        // Update active job status in sidebar (removed as per instruction, but keeping the original JOB_ID logic for now)
        // if (updatedJob.STATUS === 'Processing') {
        //     document.getElementById('activeJob').textContent = `${updatedJob.JOB_ID}: Processing...`;
        // }
    } else {
        // New job? or job list refresh?
        // For now, if not found, maybe re-fetch list? 
        // Or just ignore if it's a structural change
    }
});

// New Event: Current File
socket.on('current-file', (fileName) => {
    const activeJobDiv = document.getElementById('activeJob');
    activeJobDiv.innerHTML = `File: <strong>${fileName}</strong>`;
});

// Actions
btnPickInput.addEventListener('click', async () => {
    console.log('Pick Input clicked');
    try {
        const res = await fetch('/api/pick-folder');
        const data = await res.json();
        console.log('Picked:', data);
        if (data.path) inputPath.value = data.path;
    } catch (e) {
        console.error('Pick folder error:', e);
        alert('Failed to open folder picker');
    }
});

// Worker Slider & Input Sync
const workerCountSlider = document.getElementById('workerCount');
const workerCountInput = document.getElementById('workerCountInput');
const workerGrid = document.getElementById('workerGrid');

let workerStates = {}; // Map of id -> state ('init', 'online', 'offline')

function updateWorkerCount(val) {
    let count = parseInt(val);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 20) count = 20;

    workerCountSlider.value = count;
    workerCountInput.value = count;

    if (count > 4) {
        workerCountInput.style.color = '#ff9800';
    } else {
        workerCountInput.style.color = 'var(--text-primary)';
    }
    renderWorkerGrid(count);
}

workerCountSlider.addEventListener('input', (e) => updateWorkerCount(e.target.value));
workerCountInput.addEventListener('change', (e) => updateWorkerCount(e.target.value));

function renderWorkerGrid(count) {
    workerGrid.innerHTML = '';

    // Maintain state if reducing count
    const newStates = {};
    for (let i = 1; i <= count; i++) {
        newStates[i] = workerStates[i] || 'init';
    }
    workerStates = newStates;

    for (let i = 1; i <= count; i++) {
        const btn = document.createElement('button');
        btn.className = 'worker-btn';
        btn.id = `worker-btn-${i}`;

        updateWorkerButtonUI(btn, i, workerStates[i]);

        btn.addEventListener('click', () => handleWorkerClick(i));
        workerGrid.appendChild(btn);
    }
}

let isResetMode = false;

function updateWorkerButtonUI(btn, id, state) {
    btn.classList.remove('status-online', 'status-offline', 'status-reset-mode');
    if (isResetMode) {
        btn.classList.add('status-reset-mode');
        btn.innerHTML = `<span style="font-size:1.2rem;">🗑️</span> Luồng ${id}`;
        btn.title = "Warning: Click to DELETE this profile forever!";
        return;
    }

    if (state === 'online') {
        btn.classList.add('status-online');
        btn.textContent = `Luồng ${id}`;
    } else if (state === 'offline') {
        btn.classList.add('status-offline');
        btn.textContent = `Luồng ${id} (Revive)`;
        btn.title = "Browser closed. Click to restart worker.";
    } else {
        // init
        btn.textContent = `Luồng ${id}`;
        btn.title = "Click to manually open profile";
    }
}

async function handleWorkerClick(id) {
    const browserType = document.getElementById('browserSelect').value;
    const state = workerStates[id];

    if (isResetMode) {
        if (confirm(`Bạn có chắc chắn muốn XÓA DỮ LIỆU đăng nhập của Luồng ${id} không?`)) {
            try {
                const res = await fetch('/api/reset-profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: [id] })
                });
                const data = await res.json();
                if (res.ok) {
                    alert(`Đã xóa thành công Profile ${id}.`);
                } else {
                    alert('Lỗi: ' + data.error);
                }
            } catch (e) {
                alert('Lỗi hệ thống khi xóa.');
            }
        }
        return;
    }

    if (state === 'offline') {
        // Active automation, worker crashed -> Restart
        try {
            await fetch('/api/restart-worker', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, browserType })
            });
            // We assume it turns online, but rely on socket for source of truth
            workerStates[id] = 'init';
            updateWorkerButtonUI(document.getElementById(`worker-btn-${id}`), id, 'init');
        } catch (e) { console.error('Restart API fail', e); }
    } else {
        // Default manual login open profile
        await fetch('/api/open-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, browserType })
        });
    }
}

// Socket: Worker Status
socket.on('worker-status', (data) => {
    // data: { id: 1, status: 'online' | 'offline' }
    if (workerStates[data.id] !== undefined) {
        workerStates[data.id] = data.status;
        const btn = document.getElementById(`worker-btn-${data.id}`);
        if (btn) {
            updateWorkerButtonUI(btn, data.id, data.status);
        }
    }
});

// Init Grid
updateWorkerCount(1);

let isAutomationRunning = false;

btnStart.addEventListener('click', async () => {
    if (isAutomationRunning) {
        await fetch('/api/stop', { method: 'POST' });

        btnStart.className = 'primary-btn';
        btnStart.style.boxShadow = '0 6px 20px -4px rgba(37,99,235,0.4)';
        if (startIcon) startIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
        if (startText) startText.textContent = 'Start Automation';

        const btnClear = document.getElementById('btnClearRetries');
        if (btnClear) btnClear.disabled = false;

        const activeJobEl = document.getElementById('activeJob');
        if (activeJobEl) activeJobEl.textContent = 'Stopped';

        for (let i = 1; i <= workerCountSlider.value; i++) {
            workerStates[i] = 'init';
            const btn = document.getElementById(`worker-btn-${i}`);
            if (btn) updateWorkerButtonUI(btn, i, 'init');
        }

        isAutomationRunning = false;
        return;
    }

    const inputDir = inputPath.value;
    const count = workerCountSlider.value;
    const browserType = document.getElementById('browserSelect').value;

    const videoSettings = {
        ratio: document.getElementById('videoRatio').value,
        count: parseInt(document.getElementById('videoCount').value),
        model: document.getElementById('videoModel').value
    };

    const imgSettings = {
        ratio: document.getElementById('imgRatio').value,
        count: parseInt(document.getElementById('imgCount').value),
        model: document.getElementById('imgModel').value
    };

    if (!inputDir) {
        alert('Please select input folder.');
        return;
    }

    for (let i = 1; i <= count; i++) {
        workerStates[i] = 'online';
        const btn = document.getElementById(`worker-btn-${i}`);
        if (btn) updateWorkerButtonUI(btn, i, 'online');
    }

    const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputDir, workerCount: count, browserType, videoSettings, imgSettings })
    });

    if (res.ok) {
        btnStart.className = 'danger-btn';
        btnStart.style.boxShadow = '0 6px 20px -4px rgba(220, 38, 38, 0.4)';
        if (startIcon) startIcon.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>';
        if (startText) startText.textContent = 'Stop';

        const btnClear = document.getElementById('btnClearRetries');
        if (btnClear) btnClear.disabled = true;
        isAutomationRunning = true;
    } else {
        const err = await res.json();
        alert('Error: ' + err.error);
    }
});

const btnToggleReset = document.getElementById('btnToggleReset');
if (btnToggleReset) {
    btnToggleReset.addEventListener('click', () => {
        isResetMode = !isResetMode;
        if (isResetMode) {
            btnToggleReset.style.background = 'rgba(220, 38, 38, 0.8)'; // var(--danger-color) with opacity
            btnToggleReset.style.color = 'white';
            btnToggleReset.textContent = 'Trở Lại Mở Profile';
        } else {
            btnToggleReset.style.background = 'rgba(220, 38, 38, 0.1)';
            btnToggleReset.style.color = 'var(--danger-color)';
            btnToggleReset.textContent = '🗑️ Xoá Data';
        }

        // Refresh all buttons
        for (let i = 1; i <= workerCountSlider.value; i++) {
            const btn = document.getElementById(`worker-btn-${i}`);
            if (btn) updateWorkerButtonUI(btn, i, workerStates[i]);
        }
    });
}

const btnClearRetries = document.getElementById('btnClearRetries');
if (btnClearRetries) {
    btnClearRetries.addEventListener('click', async () => {
        const inputDir = inputPath.value;
        if (!inputDir) {
            alert('Please select input folder first.');
            return;
        }

        btnClearRetries.disabled = true;
        btnClearRetries.textContent = 'Clearing...';

        try {
            const res = await fetch('/api/clear-retries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ inputDir })
            });
            const data = await res.json();

            if (res.ok) {
                alert(`Successfully cleared retries for ${data.modifiedFiles} file(s).`);
            } else {
                alert('Error: ' + data.error);
            }
        } catch (e) {
            alert('Failed to connect to server.');
        } finally {
            btnClearRetries.disabled = false;
            btnClearRetries.textContent = '🧹 Clear Excel Retries';
        }
    });
}

const btnCheckUpdate = document.getElementById('btnCheckUpdate');
if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', async () => {
        btnCheckUpdate.disabled = true;
        btnCheckUpdate.textContent = 'Checking...';
        try {
            const res = await fetch('/api/check-update');
            const data = await res.json();
            if (data.status === 'success') {
                if (confirm('Update available: ' + data.info.version + '.\nDo you want to download it now?')) {
                    btnCheckUpdate.textContent = 'Downloading...';
                    await fetch('/api/download-update', { method: 'POST' });
                } else {
                    btnCheckUpdate.disabled = false;
                    btnCheckUpdate.textContent = '🔄 Check for Updates';
                }
            } else if (data.status === 'no-update') {
                alert('You are already on the latest version.');
                btnCheckUpdate.disabled = false;
                btnCheckUpdate.textContent = '🔄 Check for Updates';
            } else {
                alert('Error checking update: ' + data.error);
                btnCheckUpdate.disabled = false;
                btnCheckUpdate.textContent = '🔄 Check for Updates';
            }
        } catch (e) {
            alert('Failed to connect to server.');
            btnCheckUpdate.disabled = false;
            btnCheckUpdate.textContent = '🔄 Check for Updates';
        }
    });
}

socket.on('update-status', (info) => {
    if (info.status === 'downloaded' && btnCheckUpdate) {
        btnCheckUpdate.textContent = 'Install Update';
        btnCheckUpdate.disabled = false;

        // Remove old listeners and add install request
        const newBtn = btnCheckUpdate.cloneNode(true);
        btnCheckUpdate.parentNode.replaceChild(newBtn, btnCheckUpdate);
        newBtn.onclick = async () => {
            newBtn.textContent = 'Installing...';
            newBtn.disabled = true;
            await fetch('/api/install-update', { method: 'POST' });
        };
    } else if (info.status === 'error' && btnCheckUpdate) {
        btnCheckUpdate.textContent = 'Update Error';
        setTimeout(() => {
            btnCheckUpdate.disabled = false;
            btnCheckUpdate.textContent = '🔄 Check for Updates';
        }, 3000);
    }
});

socket.on('update-progress', (progress) => {
    const btn = document.getElementById('btnCheckUpdate');
    if (btn) {
        btn.textContent = `Downloading... ${Math.round(progress.percent)}%`;
    }
});

document.getElementById('btnClearLogs').addEventListener('click', () => {
    logsContent.innerHTML = '';
});

// Render
function renderTable() {
    jobTableBody.innerHTML = '';
    jobs.forEach(job => {
        const tr = document.createElement('tr');

        // Status Color
        let statusColor = 'white';
        if (job.STATUS === 'Completed') statusColor = 'var(--success-color)';
        if (job.STATUS === 'Processing') statusColor = 'var(--accent-color)';
        if (job.STATUS === 'Failed') statusColor = 'var(--danger-color)';

        tr.innerHTML = `
            <td>${job.JOB_ID}</td>
            <td style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${job.PROMPT}</td>
            <td>${job.TYPE_VIDEO || '-'}</td>
            <td style="color: ${statusColor}; font-weight: bold;">${job.STATUS}</td>
            <td>${job.VIDEO_NAME}</td>
        `;
        jobTableBody.appendChild(tr);
    });
}

function updateStats() {
    statTotal.textContent = jobs.length;
    statCompleted.textContent = jobs.filter(j => j.STATUS === 'Completed').length;
    statPending.textContent = jobs.filter(j => j.STATUS !== 'Completed').length;
}
