const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const AutomationWorker = require('./worker');

class AutomationService {
    constructor(io, inputFolder, workerCount, accountManager, proxyManager, mapping = {}, browserType = 'edge', settings = {}) {
        this.io = io;
        this.inputFolder = inputFolder;
        this.outputDir = path.join(inputFolder, 'Output');
        this.accountManager = accountManager;
        this.proxyManager = proxyManager;
        this.mapping = mapping;
        this.workerCount = workerCount;
        this.browserType = browserType;
        this.settings = settings;
        this.accountCookieCache = {}; // Cache cookies per accountId to inject into temp profiles
        this.workers = [];
        this.isRunning = false;
        this.isPaused = false; // Add global pause state

        // Queue State
        this.files = [];
        this.activeFile = null;
        this.localQueue = [];
        this.inProgressJobs = new Set();
        this.lastScanTime = 0;
        this.scanInterval = 3 * 60 * 1000; // 3 minutes
        this.isProcessing = false;

        // Excel File I/O Queue setup for concurrent workers (20 threaded)
        this.excelUpdateQueue = [];
        this.isUpdatingExcel = false;

        // Long Sleep Mechanics
        this.sessionStartTime = Date.now();
        this.longSleepCount = 0;
        this.isLongSleeping = false;
        // First long sleep is scheduled 1 hour after start
        this.nextLongSleepTime = this.sessionStartTime + 60 * 60 * 1000;

        // Global Lock for Submit Button (Rate Limiting)
        this.lastSubmitTime = 0;
        this.lastLaunchTime = 0;
        this.firstSubmitOccurred = false;
    }

    log(message) {
        console.log(`[Master] ${message}`);
        this.io.emit('log', message);
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isPaused = false;
        this.log(`Starting Master Service with ${this.workerCount} workers...`);

        // Get Live Proxies
        let liveProxies = [];
        if (this.proxyManager && this.proxyManager.getProxies().length > 0) {
            this.log(`Tự động kiểm tra (${this.proxyManager.getProxies().length}) Proxy hiện có trước khi cấp phát (Ping Check)...`);
            await this.proxyManager.checkProxies(this.io);
            liveProxies = this.proxyManager.getLiveProxies();
            if (liveProxies.length > 0) {
                this.log(`Dùng ${liveProxies.length} proxy sống để phân bổ cho các luồng.`);
            } else {
                this.log(`⚠️ Không có proxy sống nào. Tất cả đều chết, sẽ chạy trực tiếp bằng IP gốc.`);
            }
        }

        // Initialize Workers from mapped accounts
        this.workers = [];
        for (let i = 1; i <= this.workerCount; i++) {
            const accountId = this.mapping[i];
            let account = null;
            if (accountId && this.accountManager && this.accountManager.getAccountById) {
                account = this.accountManager.getAccountById(accountId);
            }
            if (!account) {
                this.log(`⚠️ Luồng ${i} không được gán Account (Mapping ID: ${accountId})`);
            }

            // Assign proxy round-robin if available
            let assignedProxy = null;
            if (liveProxies.length > 0) {
                assignedProxy = liveProxies[(i - 1) % liveProxies.length];
                this.log(`Luồng ${i} được cấp proxy: ${assignedProxy.ip}:${assignedProxy.port}`);
            }

            this.workers.push(new AutomationWorker(i, account, this, this.io, this.browserType, assignedProxy));
        }

        this.sessionStartTime = Date.now();
        this.longSleepCount = 0;
        this.isLongSleeping = false;
        this.nextLongSleepTime = this.sessionStartTime + 60 * 60 * 1000;

        this.log('Waiting for jobs to process...');
        this.processQueue();
    }

    async stop() {
        this.isRunning = false;
        this.isPaused = false;
        this.log('Stopping...');
        for (const worker of this.workers) {
            await worker.close();
        }
    }

    async scanAllFiles() {
        this.lastScanTime = Date.now();
        this.localQueue = [];

        try {
            const files = fs.readdirSync(this.inputFolder).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));

            for (const fileName of files) {
                const filePath = path.join(this.inputFolder, fileName);
                let workbook = null;
                for (let i = 0; i < 3; i++) {
                    try {
                        workbook = xlsx.readFile(filePath);
                        break;
                    } catch (e) {
                        await this.sleep(300);
                    }
                }
                if (!workbook) {
                    this.log(`⚠️ Lỗi: Không thể đọc file ${fileName} dù đã thử 3 lần (có thể do tiến trình khác đang khóa). Bỏ qua file này.`);
                    continue;
                }

                try {
                    const sheetName = workbook.SheetNames[0];
                    const worksheet = workbook.Sheets[sheetName];
                    const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

                    rawData.forEach((row, rIndex) => {
                        const status = (row['STATUS'] || '').toLowerCase();
                        const retryCount = parseInt(row['RETRY_COUNT'] || '0') || 0;

                        // Include 'processing' but skip if it is ALREADY running. Ensures crashed jobs get recovered!
                        if (status !== 'completed' && status !== 'failed' && status !== 'skipped' && retryCount < 3) {
                            const typeVideo = (row['TYPE_VIDEO'] || '').toUpperCase();
                            const img1 = row['IMAGE_PATH'] || '';
                            const img2 = row['IMAGE_PATH_2'] || '';
                            const img3 = row['IMAGE_PATH_3'] || '';
                            const hasImages = img1 !== '' || img2 !== '' || img3 !== '';

                            let computedType = '';
                            if (!row['TYPE_VIDEO'] || typeVideo === '') computedType = 'T2V';
                            else if (typeVideo === 'IMG') computedType = 'IMG';
                            else if (typeVideo === 'IN2V' && !hasImages) computedType = 'T2V';
                            else if (typeVideo === 'IN2V' && hasImages) computedType = 'IN2V';
                            else if (typeVideo === 'I2V' && !hasImages) computedType = 'T2V';
                            else if (typeVideo === 'I2V' && hasImages) computedType = 'I2V';
                            else computedType = 'T2V';

                            const jobID = row['JOB_ID'] || `JOB_${fileName}_${rIndex}`;

                            if (!this.inProgressJobs.has(jobID) && !this.localQueue.some(q => q.jobData.JOB_ID === jobID)) {
                                this.localQueue.push({
                                    fileName: fileName,
                                    filePath: filePath,
                                    rowIndex: rIndex,
                                    sheetName: sheetName,
                                    jobData: {
                                        JOB_ID: jobID,
                                        PROMPT: row['PROMPT'] || row['prompt'] || '',
                                        STATUS: row['STATUS'] || '',
                                        VIDEO_NAME: row['VIDEO_NAME'] || row['name'] || `video_${Date.now()}_${rIndex}`,
                                        TYPE_VIDEO: computedType,
                                        ORIGINAL_TYPE_VIDEO: typeVideo,
                                        IMAGE_PATH: img1,
                                        IMAGE_PATH_2: img2,
                                        IMAGE_PATH_3: img3,
                                        settings: this.settings,
                                        RETRY_COUNT: retryCount
                                    }
                                });
                            }
                        }
                    });
                } catch (err) {
                    this.log(`Lỗi khi quét file ${fileName}: ${err.message}`);
                }
            }
            if (this.localQueue.length > 0) {
                this.io.emit('job-list', this.localQueue.map(q => q.jobData));
            }
        } catch (e) {
            this.log(`Lỗi quét thư mục chung: ${e.message}`);
        }
    }
    hasPendingJobs(fileName) {
        try {
            const filePath = path.join(this.inputFolder, fileName);
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

            for (const row of rawData) {
                const status = (row['STATUS'] || '').toLowerCase();
                const retryCount = parseInt(row['RETRY_COUNT'] || '0') || 0;

                if (status !== 'completed' && status !== 'failed' && status !== 'skipped' && retryCount < 3) {
                    return true;
                }
            }
        } catch (e) {
            this.log(`Error checking status of file ${fileName}: ${e.message}`);
        }
        return false;
    }

    async processQueue() {
        while (this.isRunning) {
            const now = Date.now();

            if (now - this.lastScanTime > this.scanInterval) {
                this.log(`3 phút đã trôi qua. Đang quét lại toàn bộ thư mục xem có cập nhật không...`);
                await this.scanAllFiles();
            }

            // Check if it's time for a Long Sleep
            if (now > this.nextLongSleepTime) {
                this.isLongSleeping = true;
                this.log(`⚠️ Tới giờ nghỉ định kỳ (Long Sleep). Đang chờ các luồng hiện tại hoàn thành việc lưu video...`);

                // Wait until all in-progress jobs finish
                while (this.inProgressJobs.size > 0) {
                    if (!this.isRunning) break;
                    await this.sleep(2000);
                }

                if (this.isRunning) {
                    this.longSleepCount++;
                    // Sleep duration: 5 mins, 10 mins, 15 mins...
                    const sleepMins = this.longSleepCount * 5;
                    this.log(`💤 [LONG SLEEP] Hệ thống bắt đầu nghỉ ${sleepMins} phút để giảm thiểu rủi ro bị block IP...`);

                    for (let i = 0; i < sleepMins * 60; i++) {
                        if (!this.isRunning) break;
                        await this.sleep(1000);
                    }

                    this.log(`✅ [LONG SLEEP] Hoàn thành thời gian nghỉ. Tiếp tục công việc!`);
                }

                this.isLongSleeping = false;
                this.nextLongSleepTime = Date.now() + 60 * 60 * 1000; // Reset next break to 1 hour from NOW
            }

            if (this.isLongSleeping) {
                await this.sleep(2000);
                continue;
            }

            if (this.localQueue.length > 0) {
                // Find idle worker that is NOT offline
                const idleWorker = this.workers.find(w => !w.isBusy && !w.isOffline);

                if (idleWorker) {
                    idleWorker.isBusy = true; // Fix race condition: mark busy synchronously before any async tasks

                    // Get next job
                    const queueItem = this.localQueue.shift();
                    if (!queueItem) continue;

                    this.inProgressJobs.add(queueItem.jobData.JOB_ID);

                    // Dispatch (Non-blocking)
                    this.dispatchJob(idleWorker, queueItem);

                    // Small delay to prevent race condition in checking workers
                    await this.sleep(500);
                } else {
                    // All busy or offline, wait
                    await this.sleep(2000);
                }
            } else {
                // Queue is empty. 
                // If jobs are still running, just wait.
                if (this.inProgressJobs.size > 0) {
                    await this.sleep(2000);
                } else {
                    // All queues empty and no jobs running. Scan for new files.
                    try {
                        await this.scanAllFiles();
                        if (this.localQueue.length === 0) {
                            // Still empty after scan, wait heavily
                            if (this.workers.every(w => !w.isBusy)) {
                                this.log('Tất cả file đã hoàn tất. Đợi 3 phút trước khi quét lại toàn bộ thư mục...');
                                for (let i = 0; i < 180; i++) {
                                    if (!this.isRunning) break;
                                    await this.sleep(1000);
                                }
                            } else {
                                await this.sleep(2000);
                            }
                        } else {
                            this.log(`Đã nạp ${this.localQueue.length} jobs mới từ các file.`);
                        }
                    } catch (e) {
                        this.log(`Lỗi quét thư mục: ${e.message}`);
                        await this.sleep(5000);
                    }
                }
            }
        }
    }

    async dispatchJob(worker, queueItem) {
        const { fileName, filePath, rowIndex, sheetName, jobData } = queueItem;

        // 1. Lock / Mark Processing in Excel IMMEDIATELY via async Queue
        await this.queueExcelUpdate(filePath, sheetName, rowIndex, 'Processing');
        this.io.emit('job-update', { ...jobData, STATUS: 'Processing' }); // UI Update

        this.log(`Dispatching Job ${jobData.JOB_ID} to Worker ${worker.id}`);

        // Create Subfolder (Thread safe? fs.mkdirSync is usually fine)
        const fileNameNoExt = path.parse(fileName).name;
        const jobOutputDir = path.join(this.outputDir, fileNameNoExt);
        if (!fs.existsSync(jobOutputDir)) fs.mkdirSync(jobOutputDir, { recursive: true });

        try {
            await worker.processJob(jobData, jobOutputDir);

            // Success
            await this.queueExcelUpdate(filePath, sheetName, rowIndex, 'Completed');
            this.io.emit('job-update', { ...jobData, STATUS: 'Completed' });

        } catch (e) {
            // Fail logic
            const newRetry = (jobData.RETRY_COUNT || 0) + 1;
            const newStatus = newRetry >= 3 ? 'Failed' : 'Pending Retry';

            await this.queueExcelUpdate(filePath, sheetName, rowIndex, newStatus, newRetry);
            this.io.emit('job-update', { ...jobData, STATUS: newStatus, RETRY_COUNT: newRetry });

            if (newStatus === 'Pending Retry') {
                this.localQueue.push({
                    ...queueItem,
                    jobData: { ...jobData, RETRY_COUNT: newRetry }
                });
            }
        } finally {
            this.inProgressJobs.delete(jobData.JOB_ID);

            // Random delay between 5s to 30s after every job finishing BEFORE accepting next job
            if (this.isRunning && worker) {
                const randomDelay = Math.floor(Math.random() * (30000 - 5000 + 1)) + 5000;
                this.log(`[Worker ${worker.id}] Job hoàn tất (STATUS: ${jobData.STATUS || 'Completed/Failed'}). Nghỉ ngắn ngẫu nhiên ${Math.round(randomDelay / 1000)}s trước khi nhận Job mới...`);
                await this.sleep(randomDelay);
                worker.isBusy = false;
            }
        }
    }

    // Queue all excel I/O to avoid EBUSY data races when 20+ threads finish roughly at the same time
    async queueExcelUpdate(filePath, sheetName, rowIndex, status, retryCount = null) {
        return new Promise((resolve) => {
            this.excelUpdateQueue.push({ filePath, sheetName, rowIndex, status, retryCount, resolve });
            this.processExcelQueue();
        });
    }

    async requestSubmitLock(workerId) {
        // Enforce a strict but randomized delay between ANY worker clicking the Submit button
        // to prevent API flooding and mimic human behavior to bypass anti-bot systems.
        // Formula: Distribute N clicks evenly across an approximate 90s video generation window, plus randomness.
        const N = this.workerCount > 0 ? this.workerCount : 1;

        // Base gap between each thread's submit action
        const baseWaitMs = Math.floor(90000 / N);

        // Add ±30% randomness to seem human
        const jitter = Math.floor((Math.random() * 0.6 - 0.3) * baseWaitMs);

        // Ensure delay is at least 3 seconds (3000ms) to avoid spamming
        const lockWaitMs = Math.max(3000, baseWaitMs + jitter);

        if (!this.firstSubmitOccurred) {
            this.firstSubmitOccurred = true;
            this.lastSubmitTime = Date.now();
            this.log(`[Submit Lock] Luồng ${workerId} là luồng đầu tiên. Được cấp quyền nhấn Create Video lập tức (Bỏ qua thời gian đợi).`);
            return;
        }

        // Atomic assignment to prevent race conditions during async calculation
        const now = Date.now();
        if (this.lastSubmitTime < now) {
            this.lastSubmitTime = now;
        }

        // Allocate the time slot for this worker
        const assignedTime = this.lastSubmitTime + lockWaitMs;
        this.lastSubmitTime = assignedTime; // Reserve it right now synchronously

        const delayToWait = assignedTime - Date.now();

        if (delayToWait > 0) {
            this.log(`[Submit Lock] Luồng ${workerId} vào hàng đợi nhấn Create Video (Đợi ${Math.round(delayToWait / 1000)}s - Giãn cách động).`);

            // Just sleep asynchronously, leaving the Event Loop free for other workers
            await this.sleep(delayToWait);
        } else {
            this.log(`[Submit Lock] Luồng ${workerId} được cấp quyền nhấn Create Video lập tức.`);
        }
    }

    async requestLaunchLock(workerId) {
        // Enforce a strict randomized delay (3000ms base) between ANY worker launching a browser
        const lockWaitMs = 3000 + Math.floor(Math.random() * 2000); // 3s - 5s

        const now = Date.now();
        if (this.lastLaunchTime < now) {
            this.lastLaunchTime = now;
        }

        const assignedTime = this.lastLaunchTime + lockWaitMs;
        this.lastLaunchTime = assignedTime;

        const delayToWait = assignedTime - Date.now();

        if (delayToWait > 0) {
            await this.sleep(delayToWait);
        }

        this.log(`[Launch Lock] Luồng ${workerId} được phép khởi động trình duyệt.`);
    }

    async processExcelQueue() {
        if (this.isUpdatingExcel) return;
        this.isUpdatingExcel = true;

        while (this.excelUpdateQueue.length > 0) {
            const task = this.excelUpdateQueue.shift();
            let success = false;
            let attempts = 0;

            while (!success && attempts < 5) {
                try {
                    const workbook = xlsx.readFile(task.filePath);
                    const worksheet = workbook.Sheets[task.sheetName];
                    const data = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

                    if (data[task.rowIndex]) {
                        data[task.rowIndex]['STATUS'] = task.status;
                        if (task.retryCount !== null) data[task.rowIndex]['RETRY_COUNT'] = task.retryCount;

                        const newWs = xlsx.utils.json_to_sheet(data);
                        const newWb = xlsx.utils.book_new();
                        xlsx.utils.book_append_sheet(newWb, newWs, task.sheetName);
                        xlsx.writeFile(newWb, task.filePath);
                    }
                    success = true;
                } catch (e) {
                    attempts++;
                    this.log(`[Excel] Lỗi khóa file ${path.basename(task.filePath)} (thử lại ${attempts}/5)...`);
                    await this.sleep(300);
                }
            }
            if (task.resolve) task.resolve();
        }

        this.isUpdatingExcel = false;
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Manual Profile Opener
    async openProfile(accountId) {
        this.log(`Opening Profile for account ${accountId} using ${this.browserType}...`);
        let account = null;
        if (this.accountManager && this.accountManager.getAccountById) {
            account = this.accountManager.getAccountById(accountId);
        }
        if (!account) throw new Error("Account not found");

        const worker = new AutomationWorker('TEMP', account, this, this.io, this.browserType);
        await worker.launch();
        return worker;
    }

    // Restart Offline Worker
    async restartWorker(id, browserType) {
        let worker = this.workers.find(w => w.id === id);
        if (worker) {
            this.log(`Restarting Worker ${id}...`);
            try { await worker.close(); } catch (e) { }

            // Re-assign browser type in case it changed in settings
            worker.browserType = browserType;
            worker.isOffline = false;
            worker.isBusy = false;
            this.io.emit('worker-status', { id: worker.id, status: 'init' });

            await worker.launch();
            // Launch might fail or trigger disconnect again, but if it succeeds:
            if (!worker.isOffline) {
                this.io.emit('worker-status', { id: worker.id, status: 'online' });
                this.log(`Worker ${id} restarted successfully.`);
            }
        } else {
            this.log(`Attempted to restart unknown Worker ${id}`);
        }
    }
}

module.exports = AutomationService;
