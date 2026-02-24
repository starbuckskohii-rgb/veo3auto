const socket = io();

// DOM Elements
const btnPickInput = document.getElementById('btnPickInput');
const btnPickFolder = document.getElementById('btnPickFolder');
const inputPath = document.getElementById('inputPath');
// const inputOutput = document.getElementById('outputDir'); // Removed
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const logsContent = document.getElementById('logsContent');
const jobTableBody = document.getElementById('jobTableBody');
const statTotal = document.getElementById('statTotal');
const statCompleted = document.getElementById('statCompleted');
const statPending = document.getElementById('statPending');

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

// Worker Slider
const workerCount = document.getElementById('workerCount');
const workerCountVal = document.getElementById('workerCountVal');
workerCount.addEventListener('input', () => {
    workerCountVal.textContent = workerCount.value;
    if (parseInt(workerCount.value) > 2) {
        workerCountVal.style.color = '#ff9800'; // Warning color for high load
    } else {
        workerCountVal.style.color = 'white';
    }
});

// Open Profile
window.openProfile = async (id) => {
    await fetch('/api/open-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
};

btnStart.addEventListener('click', async () => {
    const inputDir = inputPath.value;
    const count = workerCount.value;

    if (!inputDir) {
        alert('Please select input folder.');
        return;
    }

    const res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputDir, workerCount: count })
    });

    if (res.ok) {
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');
        document.getElementById('btnClearRetries').disabled = true;
    } else {
        const err = await res.json();
        alert('Error: ' + err.error);
    }
});

btnStop.addEventListener('click', async () => {
    await fetch('/api/stop', { method: 'POST' });
    btnStop.classList.add('hidden');
    btnStart.classList.remove('hidden');
    document.getElementById('btnClearRetries').disabled = false;
    document.getElementById('activeJob').textContent = 'Stopped';
});

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
