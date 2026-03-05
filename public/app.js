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
    // Hide Completed jobs from tracking list
    jobs = list.filter(j => j.STATUS !== 'Completed');
    renderTable();
});

socket.on('job-update', (updatedJob) => {
    if (updatedJob.STATUS === 'Completed') {
        // Remove from tracking if completed
        jobs = jobs.filter(j => j.JOB_ID !== updatedJob.JOB_ID);
    } else {
        const index = jobs.findIndex(j => j.JOB_ID === updatedJob.JOB_ID);
        if (index !== -1) {
            jobs[index] = updatedJob;
        } else {
            jobs.push(updatedJob);
        }
    }
    renderTable();
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

// Removal of workerCountSlider logic as we use Profiles now
// Keeping workerStates map for legacy compatibility if needed
let workerStates = {}; // Map of id -> state ('init', 'online', 'offline')


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

// Worker Count Logic
const workerCountSlider = document.getElementById('workerCount');
const workerCountInput = document.getElementById('workerCountInput');
const workerGrid = document.getElementById('workerGrid');

function updateWorkerCount(val) {
    let count = parseInt(val);
    if (isNaN(count) || count < 1) count = 1;
    if (count > 20) count = 20;

    workerCountSlider.value = count;
    workerCountInput.value = count;
    renderWorkerGrid(count);
}

function renderWorkerGrid(count) {
    if (!workerGrid) return;
    workerGrid.innerHTML = '';
    for (let i = 1; i <= count; i++) {
        if (!workerStates[i]) workerStates[i] = 'init';

        const btn = document.createElement('button');
        btn.id = `worker-btn-${i}`;
        btn.className = 'worker-btn';
        updateWorkerButtonUI(btn, i, workerStates[i]);

        btn.addEventListener('click', () => handleWorkerClick(i));
        workerGrid.appendChild(btn);
    }
}

if (workerCountSlider) workerCountSlider.addEventListener('input', (e) => {
    updateWorkerCount(e.target.value);
    renderMappingList();
});
if (workerCountInput) workerCountInput.addEventListener('change', (e) => {
    updateWorkerCount(e.target.value);
    renderMappingList();
});

updateWorkerCount(1); // Set initial wait

let isAutomationRunning = false;
let globalAccounts = [];
let currentMapping = {};

// --- Tabs Logic ---
const tabVideo = document.getElementById('tabVideo');
const tabImage = document.getElementById('tabImage');
const contentVideo = document.getElementById('contentVideo');
const contentImage = document.getElementById('contentImage');

tabVideo.addEventListener('click', () => {
    tabVideo.classList.add('active');
    tabImage.classList.remove('active');
    tabVideo.style.background = 'white';
    tabVideo.style.color = '#3b82f6';
    tabVideo.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
    tabImage.style.background = 'transparent';
    tabImage.style.color = 'var(--text-secondary)';
    tabImage.style.boxShadow = 'none';

    contentVideo.style.display = 'block';
    contentImage.style.display = 'none';
});

tabImage.addEventListener('click', () => {
    tabImage.classList.add('active');
    tabVideo.classList.remove('active');
    tabImage.style.background = 'white';
    tabImage.style.color = '#10b981';
    tabImage.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
    tabVideo.style.background = 'transparent';
    tabVideo.style.color = 'var(--text-secondary)';
    tabVideo.style.boxShadow = 'none';

    contentImage.style.display = 'block';
    contentVideo.style.display = 'none';
});

// --- Profile Modal Logic ---
const btnManageProfiles = document.getElementById('btnManageProfiles');

const profileModal = document.getElementById('profileModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const modalProfileList = document.getElementById('modalProfileList');
const mappingList = document.getElementById('mappingList');
const btnSaveNewProfile = document.getElementById('btnSaveNewProfile');

async function loadProfiles() {
    try {
        const resAcc = await fetch('/api/accounts');
        globalAccounts = await resAcc.json();

        const resMap = await fetch('/api/accounts/mapping');
        currentMapping = await resMap.json();

        if (modalProfileList) modalProfileList.innerHTML = '';

        if (globalAccounts.length === 0) {
            if (modalProfileList) modalProfileList.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">Chưa có Account nào. Vui lòng thêm mới.</div>';
        } else {
            globalAccounts.forEach(acc => {
                if (modalProfileList) {
                    const assignedThreads = Object.keys(currentMapping).filter(k => currentMapping[k] === acc.id);
                    const assignedText = assignedThreads.length > 0 ? `Luồng ${assignedThreads.join(', ')}` : `<span style="color:#aaa">Chưa gán</span>`;

                    let statusClass = 'badge-unassigned';
                    let statusText = 'Chưa đăng nhập';
                    if (acc.hasProfile) {
                        statusClass = 'badge-ok';
                        statusText = 'Logged (OK)';
                    }
                    if (acc.status === 'Expired') { statusClass = 'badge-expired'; statusText = 'Expired'; }
                    if (acc.status === 'Error') { statusClass = 'badge-error'; statusText = 'Error'; }

                    const is2FA = acc.twoFactorSecret ? '🔒 Có' : '❌ Không';

                    let displayName = acc.email || acc.profileName || '';
                    if (displayName.length > 25) {
                        const parts = displayName.split('@');
                        if (parts.length === 2 && parts[0].length > 8) {
                            // xxx...xxx@domain.com
                            const name = parts[0];
                            displayName = name.substring(0, 4) + '...' + name.substring(name.length - 4) + '@' + parts[1];
                        } else if (displayName.length > 30) {
                            displayName = displayName.substring(0, 12) + '...' + displayName.substring(displayName.length - 8);
                        }
                    }

                    const item = document.createElement('div');
                    item.className = 'accordion-item';

                    const header = document.createElement('div');
                    header.className = 'accordion-header';
                    header.innerHTML = `
                        <div class="accordion-title" title="${acc.email || acc.profileName}">
                            ${displayName}
                        </div>
                        <div style="display: flex; gap: 8px; align-items: center; flex-shrink: 0;">
                            <span class="status-badge ${statusClass}">${statusText}</span>
                            <span style="font-size: 0.7rem; color: var(--text-secondary); transition: transform 0.3s;" class="accordion-arrow">▼</span>
                        </div>
                    `;

                    header.onclick = () => {
                        const isActive = item.classList.contains('active');
                        // Close all others
                        document.querySelectorAll('.accordion-item').forEach(el => {
                            el.classList.remove('active');
                            const arrow = el.querySelector('.accordion-arrow');
                            if (arrow) arrow.style.transform = 'rotate(0deg)';
                        });
                        if (!isActive) {
                            item.classList.add('active');
                            const arrow = item.querySelector('.accordion-arrow');
                            if (arrow) arrow.style.transform = 'rotate(180deg)';
                        }
                    };

                    const body = document.createElement('div');
                    body.className = 'accordion-body';

                    const details = document.createElement('div');
                    details.className = 'accordion-details';
                    details.innerHTML = `
                        <div style="margin-bottom: 4px; word-break: break-all; color: var(--text-primary); font-size: 0.9rem;"><strong>Email:</strong> ${acc.email || acc.profileName}</div>
                        <div><strong>2FA:</strong> ${is2FA}</div>
                        <div><strong>Gán cho:</strong> ${assignedText}</div>
                    `;

                    const actions = document.createElement('div');
                    actions.className = 'accordion-actions';

                    if (!acc.hasProfile) {
                        const createBtn = document.createElement('button');
                        createBtn.className = 'action-btn';
                        createBtn.title = 'Tạo Profile Browser & Đăng nhập';
                        createBtn.innerHTML = '🌐 Mở';
                        createBtn.style.color = 'var(--accent-color)';
                        createBtn.style.fontSize = '0.8rem';
                        createBtn.onclick = async (e) => {
                            e.stopPropagation();
                            createBtn.textContent = 'Đang đăng nhập (Tối đa 3 phút)...';
                            createBtn.disabled = true;
                            createBtn.style.cursor = 'wait';

                            try {
                                const response = await fetch('/api/accounts/create-profile', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: acc.id })
                                });
                                const result = await response.json();
                                if (!result.success && !result.error) {
                                    alert('Lỗi đăng nhập: ' + (result.message || 'Không rõ nguyên nhân. Vui lòng thử lại.'));
                                } else if (result.error) {
                                    alert('Lỗi từ Server: ' + result.error);
                                }
                            } catch (err) {
                                alert('Lỗi kết nối với máy chủ khi đăng nhập.');
                            } finally {
                                setTimeout(loadProfiles, 1500);
                            }
                        };
                        actions.appendChild(createBtn);
                    } else {
                        const resetBtn = document.createElement('button');
                        resetBtn.className = 'action-btn';
                        resetBtn.title = 'Xoá Session / Dữ liệu Profile (Reset)';
                        resetBtn.innerHTML = '🧹 Xóa Data';
                        resetBtn.style.color = 'var(--warning-color)';
                        resetBtn.style.fontSize = '0.8rem';
                        resetBtn.onclick = async (e) => {
                            e.stopPropagation();
                            if (confirm(`Bạn có chắc muốn xóa sạch dữ liệu (Logout) của ${acc.profileName}?`)) {
                                await fetch('/api/reset-profile', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: acc.id })
                                });
                                loadProfiles();
                            }
                        };
                        actions.appendChild(resetBtn);
                    }

                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'action-btn';
                    deleteBtn.title = 'Xoá hoàn toàn Account này khỏi hệ thống';
                    deleteBtn.innerHTML = '🗑️ Xóa';
                    deleteBtn.style.color = 'var(--danger-color)';
                    deleteBtn.style.fontSize = '0.8rem';
                    deleteBtn.onclick = async (e) => {
                        e.stopPropagation();
                        if (confirm(`Xóa Account ${acc.profileName}?`)) {
                            const res = await fetch(`/api/accounts/${acc.id}`, { method: 'DELETE' });
                            if (res.ok) {
                                loadProfiles();
                            } else {
                                const err = await res.json();
                                alert('Error: ' + err.error);
                            }
                        }
                    };
                    actions.appendChild(deleteBtn);

                    body.appendChild(details);
                    body.appendChild(actions);
                    item.appendChild(header);
                    item.appendChild(body);
                    modalProfileList.appendChild(item);
                }
            });
        }

        renderMappingList();
    } catch (e) {
        console.error('Failed to load profiles');
    }
}

function renderMappingList() {
    if (!mappingList) return;
    mappingList.innerHTML = '';
    const maxWorkers = 20; // Always show 20 slots for pre-configuration

    for (let i = 1; i <= maxWorkers; i++) {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '10px 12px';
        row.style.background = 'rgba(0,0,0,0.02)';
        row.style.borderRadius = '10px';
        row.style.border = '1px solid var(--glass-border)';

        let mappedAccountId = currentMapping[i];
        let statusIndicator = '<span class="status-badge badge-unassigned" style="margin-right:8px; display:inline-block; width:12px; height:12px; border-radius:50%; padding:0; overflow:hidden; color:transparent; background-color:currentColor;" title="Chưa gán"></span>';

        if (mappedAccountId) {
            let acc = globalAccounts.find(x => x.id === mappedAccountId);
            if (acc) {
                if (acc.status === 'Error') statusIndicator = '<span class="status-badge badge-error" style="margin-right:8px; display:inline-block; padding:2px 6px;" title="Error">Lỗi</span>';
                else if (acc.status === 'Expired') statusIndicator = '<span class="status-badge badge-expired" style="margin-right:8px; display:inline-block; padding:2px 6px;" title="Expired">Expired</span>';
                else if (acc.hasProfile) statusIndicator = '<span class="status-badge badge-ok" style="margin-right:8px; display:inline-block; padding:2px 6px;" title="OK">OK</span>';
                else statusIndicator = '<span class="status-badge badge-unassigned" style="margin-right:8px; display:inline-block; padding:2px 6px;" title="Pending">Chờ</span>';
            }
        }

        const labelDiv = document.createElement('div');
        labelDiv.style.flex = 1;
        labelDiv.style.display = 'flex';
        labelDiv.style.alignItems = 'center';
        labelDiv.innerHTML = `${statusIndicator} <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-primary);">Luồng ${i}</span>`;

        const select = document.createElement('select');
        select.style.flex = 2;
        select.style.padding = '8px';
        select.style.borderRadius = '8px';
        select.style.border = '1px solid var(--glass-border)';
        select.style.outline = 'none';

        const defaultOpt = document.createElement('option');
        defaultOpt.value = "";
        defaultOpt.textContent = "-- Chưa gán Account --";
        select.appendChild(defaultOpt);

        globalAccounts.forEach(acc => {
            const opt = document.createElement('option');
            opt.value = acc.id;
            opt.textContent = `${acc.profileName} ${acc.hasProfile ? '' : '(Trống)'}`;
            select.appendChild(opt);
        });

        // Set value if already mapped
        if (currentMapping[i]) {
            select.value = currentMapping[i];
        }

        select.addEventListener('change', async (e) => {
            currentMapping[i] = e.target.value;
            if (!currentMapping[i]) delete currentMapping[i];

            // Auto save mapping
            await fetch('/api/accounts/mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentMapping)
            });
            // Re-render to update status indicator immediately
            renderMappingList();
        });

        row.appendChild(labelDiv);
        row.appendChild(select);
        mappingList.appendChild(row);
    }
}

// Initial Load
loadProfiles();

if (btnManageProfiles) btnManageProfiles.addEventListener('click', () => profileModal.style.display = 'flex');
if (btnCloseModal) btnCloseModal.addEventListener('click', () => profileModal.style.display = 'none');

if (btnSaveNewProfile) {
    btnSaveNewProfile.addEventListener('click', async () => {
        const email = document.getElementById('newProfileEmail').value;
        const password = document.getElementById('newProfilePassword').value;
        const twoFactorSecret = document.getElementById('newProfile2FA').value;
        const loginRadio = document.querySelector('input[name="newProfileLoginType"]:checked');
        const loginType = loginRadio ? loginRadio.value : 'manual';

        if (!email) return alert('Vui lòng nhập Email Google');

        await fetch('/api/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profileName: email, email, password, twoFactorSecret, loginType })
        });

        // reset form
        document.getElementById('newProfileEmail').value = '';
        document.getElementById('newProfilePassword').value = '';
        document.getElementById('newProfile2FA').value = '';

        loadProfiles();
    });
}

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

        const count = parseInt(workerCountInput.value) || 1;
        for (let i = 1; i <= count; i++) {
            workerStates[i] = 'init';
            const btn = document.getElementById(`worker - btn - ${i}`);
            if (btn) updateWorkerButtonUI(btn, i, 'init');
        }

        isAutomationRunning = false;
        return;
    }

    const inputDir = inputPath.value;
    const browserType = document.getElementById('browserSelect').value;

    const videoSettings = {
        ratio: document.getElementById('videoRatio').value,
        count: parseInt(document.getElementById('videoCount').value),
        model: document.getElementById('videoModel').value,
        resolution: document.getElementById('videoResolution') ? document.getElementById('videoResolution').value : '720p'
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

    // Check Brave Installation before attempting to start
    if (browserType === 'brave') {
        try {
            const checkRes = await fetch('/api/check-browser', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ browserType })
            });
            const checkData = await checkRes.json();
            if (!checkData.exists) {
                if (confirm('Trình duyệt Brave chưa được cài đặt trên máy. Bạn có muốn công cụ tự động tải và cài đặt Brave ngay bây giờ không? (Sẽ mất khoảng thời gian để tải)')) {
                    btnStart.disabled = true;
                    if (startText) startText.textContent = 'Đang tự cài Brave... Vui lòng đợi';
                    const installRes = await fetch('/api/install-browser', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ browserType })
                    });
                    btnStart.disabled = false;
                    if (startText) startText.textContent = 'Start Automation';
                    if (!installRes.ok) {
                        alert('Cài đặt thất bại. Bạn có thể cần chạy ứng dụng với quyền Administrator, hoặc tự tải Brave từ trang chủ.');
                        return;
                    }
                    alert('Cài đặt Brave thành công! Hệ thống sẽ bắt đầu chạy.');
                } else {
                    return; // User canceled the launch
                }
            }
        } catch (e) { console.error('Browser check error:', e); }
    }

    const count = parseInt(workerCountInput.value) || 1;

    // Check mapping validity
    for (let i = 1; i <= count; i++) {
        if (!currentMapping[i]) {
            alert(`Luồng ${i} chưa được gán Account.Vui lòng vào Cài đặt Mapping để gán Account trước khi chạy.`);
            return;
        }
    }

    for (let i = 1; i <= count; i++) {
        workerStates[i] = 'online';
        const btn = document.getElementById(`worker - btn - ${i}`);
        if (btn) updateWorkerButtonUI(btn, i, 'online');
    }

    const useProxyToggle = document.getElementById('useProxyToggle');
    const useProxy = useProxyToggle ? useProxyToggle.checked : true;

    const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            inputDir,
            workerCount: count,
            browserType,
            videoSettings,
            imgSettings,
            useProxy
            // activeAccountIds is no longer sent, server reads mapping directly
        })
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
        const count = parseInt(workerCountInput ? workerCountInput.value : 1) || 1;
        for (let i = 1; i <= count; i++) {
            const btn = document.getElementById(`worker - btn - ${i}`);
            if (btn) updateWorkerButtonUI(btn, i, workerStates[i] || 'init');
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
        btn.textContent = `Downloading...${Math.round(progress.percent)} % `;
    }
});

socket.on('install-progress', (percent) => {
    if (startText && startText.textContent.includes('cài Brave')) {
        startText.textContent = `Đang tự cài Brave... ${percent}%`;
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

// Modal Tab Switching Logic
window.switchModalTab = function (tabId) {
    const tabAccount = document.getElementById('modalTabAccount');
    const tabMapping = document.getElementById('modalTabMapping');
    const contentAccount = document.getElementById('modalContentAccount');
    const contentMapping = document.getElementById('modalContentMapping');

    if (tabId === 'account') {
        tabAccount.classList.add('active');
        tabAccount.style.color = 'var(--text-primary)';
        tabAccount.style.borderBottomColor = 'var(--text-primary)';

        tabMapping.classList.remove('active');
        tabMapping.style.color = 'var(--text-secondary)';
        tabMapping.style.borderBottomColor = 'transparent';

        contentAccount.style.display = 'flex';
        contentMapping.style.display = 'none';
    } else {
        tabMapping.classList.add('active');
        tabMapping.style.color = 'var(--text-primary)';
        tabMapping.style.borderBottomColor = 'var(--text-primary)';

        tabAccount.classList.remove('active');
        tabAccount.style.color = 'var(--text-secondary)';
        tabAccount.style.borderBottomColor = 'transparent';

        contentMapping.style.display = 'block';
        contentAccount.style.display = 'none';
    }
}

// --- Proxy Management Logic ---
// --- Proxy Management Logic ---
let isProxyAdmin = false;
const btnManageProxies = document.getElementById('btnManageProxies');
const proxyModal = document.getElementById('proxyModal');
const btnCloseProxyModal = document.getElementById('btnCloseProxyModal');
const btnCloseProxyModalTop = document.getElementById('btnCloseProxyModalTop');
const proxyInputList = document.getElementById('proxyInputList');
const btnAddProxies = document.getElementById('btnAddProxies');
const btnCheckProxies = document.getElementById('btnCheckProxies');
const btnDeleteDeadProxies = document.getElementById('btnDeleteDeadProxies');
const proxyListContainer = document.getElementById('proxyListContainer');
const proxyLiveCount = document.getElementById('proxyLiveCount');
const proxyDeadCount = document.getElementById('proxyDeadCount');
const proxyUntestedCount = document.getElementById('proxyUntestedCount');
const btnProxyUnlock = document.getElementById('btnProxyUnlock');

async function loadProxies() {
    try {
        const res = await fetch(`/api/proxies?admin=${isProxyAdmin}`);
        const proxies = await res.json();
        renderProxyList(proxies);
    } catch (e) {
        console.error('Failed to load proxies', e);
    }
}

function renderProxyList(proxies) {
    if (!proxyListContainer) return;
    proxyListContainer.innerHTML = '';

    let live = 0, dead = 0, untested = 0;

    proxies.forEach(p => {
        if (p.status === 'live') live++;
        else if (p.status === 'dead') dead++;
        else untested++;

        let statusBadge = '<span class="status-badge" style="background: #f1f5f9; color: #475569; padding: 4px 8px; border-radius: 12px; font-size: 0.75rem;">Untested</span>';
        if (p.status === 'live') statusBadge = `<span class="status-badge badge-ok" style="padding: 4px 8px; border-radius: 12px; font-size: 0.75rem;">Live (${p.ping}ms)</span>`;
        if (p.status === 'dead') statusBadge = '<span class="status-badge badge-error" style="padding: 4px 8px; border-radius: 12px; font-size: 0.75rem;">Dead</span>';

        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.alignItems = 'center';
        div.style.padding = '8px 12px';
        div.style.background = 'rgba(0,0,0,0.02)';
        div.style.borderRadius = '8px';
        div.style.border = '1px solid var(--glass-border)';

        div.innerHTML = `
            <div>
                <div style="font-family: monospace; font-size: 0.9rem; color: var(--text-primary);">
                    ${p.ip}:${p.port} ${p.isSystem ? '<span title="Proxy Hệ thống Bất Tử" style="color:var(--accent-color);font-size:0.8rem;">🔒</span>' : ''}
                </div>
                <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px;">${p.username ? '👤 Có User/Pass' : '🌐 Không User/Pass'}</div>
            </div>
            <div style="display: flex; gap: 12px; align-items: center;">
                ${statusBadge}
                <button class="icon-btn delete-proxy-btn" data-id="${p.id}" style="color: var(--danger-color); background: transparent; border: none; cursor: pointer; padding: 4px;" title="Xóa Proxy">🗑️</button>
            </div>
        `;
        proxyListContainer.appendChild(div);
    });

    if (proxyLiveCount) proxyLiveCount.textContent = `Sống: ${live}`;
    if (proxyDeadCount) proxyDeadCount.textContent = `Chết: ${dead}`;
    if (proxyUntestedCount) proxyUntestedCount.textContent = `Chưa test: ${untested}`;

    // Attach delete listeners
    document.querySelectorAll('.delete-proxy-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            if (confirm('Bạn muốn xóa Proxy này?')) {
                await fetch(`/api/proxies/${id}?admin=${isProxyAdmin}`, { method: 'DELETE' });
                loadProxies();
            }
        });
    });
}

if (btnManageProxies) {
    btnManageProxies.addEventListener('click', () => {
        proxyModal.style.display = 'flex';
        loadProxies();
    });
}

if (btnProxyUnlock) {
    btnProxyUnlock.addEventListener('click', () => {
        // Toggle off if already admin
        if (isProxyAdmin) {
            isProxyAdmin = false;
            btnProxyUnlock.style.opacity = '0.3';
            loadProxies();
            return;
        }

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-color);padding:24px;border-radius:12px;width:320px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.2);border:1px solid var(--glass-border);';
        box.innerHTML = `
            <div style="font-size:2rem;margin-bottom:8px;">🔒</div>
            <h3 style="margin:0 0 8px 0;color:var(--text-primary);font-weight:600;">System Admin</h3>
            <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:20px;">Xác thực để thao tác với System Proxies.</p>
            <input type="password" id="tempPwdInput" style="width:100%;padding:12px;margin-bottom:20px;border:1px solid var(--glass-border);border-radius:8px;outline:none;background:#fafafa;text-align:center;font-weight:bold;letter-spacing:2px;box-sizing:border-box;" placeholder="••••••••">
            <div style="display:flex;gap:12px;">
                <button id="tempPwdCancel" style="flex:1;padding:12px;border:none;border-radius:8px;background:rgba(0,0,0,0.05);cursor:pointer;font-weight:600;color:var(--text-secondary);transition:all 0.2s;">Hủy</button>
                <button id="tempPwdSubmit" style="flex:1;padding:12px;border:none;border-radius:8px;background:#2563eb;color:white;cursor:pointer;font-weight:600;box-shadow:0 4px 12px rgba(37,99,235,0.3);transition:all 0.2s;">Xác nhận</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const input = document.getElementById('tempPwdInput');
        input.focus();

        const closeOverlay = () => document.body.removeChild(overlay);

        document.getElementById('tempPwdCancel').onclick = closeOverlay;
        document.getElementById('tempPwdSubmit').onclick = () => {
            if (input.value === 'trongVfast@') {
                closeOverlay();
                isProxyAdmin = true;
                btnProxyUnlock.style.opacity = '1';
                loadProxies();
            } else {
                alert('❌ Mật khẩu không chính xác!');
                input.value = '';
                input.focus();
            }
        };

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') document.getElementById('tempPwdSubmit').click();
        });
    });
}

const closeProxyModal = () => proxyModal.style.display = 'none';
if (btnCloseProxyModal) btnCloseProxyModal.addEventListener('click', closeProxyModal);

const useProxyToggle = document.getElementById('useProxyToggle');
if (useProxyToggle) {
    useProxyToggle.addEventListener('change', (e) => {
        const isEnabled = e.target.checked;
        const statusText = isEnabled ? 'BẬT' : 'TẮT';
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.style.color = isEnabled ? 'var(--success-color)' : 'var(--warning-color)';
        div.style.fontWeight = '500';
        div.textContent = `> Hệ thống đã ${statusText} sử dụng Proxy.`;
        if (logsContent) {
            logsContent.appendChild(div);
            logsContent.scrollTop = logsContent.scrollHeight;
        }
    });
}

if (btnAddProxies) btnAddProxies.addEventListener('click', async () => {
    const rawText = proxyInputList.value;
    if (!rawText.trim()) return alert('Vui lòng nhập Proxy');

    try {
        const res = await fetch('/api/proxies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawText, isSystem: isProxyAdmin })
        });
        const data = await res.json();
        if (data.success) {
            alert(`Đã thêm ${data.added} proxy mới.`);
            proxyInputList.value = '';
            loadProxies();
        }
    } catch (e) {
        alert('Lỗi khi thêm proxy');
    }
});

if (btnCheckProxies) btnCheckProxies.addEventListener('click', async () => {
    btnCheckProxies.disabled = true;
    btnCheckProxies.textContent = 'Đang kiểm tra... (Vui lòng đợi)';
    try {
        const res = await fetch('/api/proxies/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin: isProxyAdmin })
        });
        const data = await res.json();
        if (data.success) {
            renderProxyList(data.proxies);
        }
    } catch (e) {
        alert('Lỗi kiểm tra proxy');
    } finally {
        btnCheckProxies.disabled = false;
        btnCheckProxies.innerHTML = '⚡ Kiểm tra tất cả (Ping)';
    }
});

if (btnDeleteDeadProxies) btnDeleteDeadProxies.addEventListener('click', async () => {
    if (confirm('Xóa TẤT CẢ proxy chết?')) {
        await fetch(`/api/proxies/dead?admin=${isProxyAdmin}`, { method: 'DELETE' });
        loadProxies();
    }
});
