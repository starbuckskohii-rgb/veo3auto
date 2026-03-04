const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const AutomationWorker = require('./worker');

class AutomationService {
    constructor(io, inputFolder, workerCount = 1, browserType = 'edge', settings = {}) {
        this.io = io;
        this.inputFolder = inputFolder;
        this.outputDir = path.join(inputFolder, 'Output');
        this.workerCount = workerCount;
        this.browserType = browserType;
        this.settings = settings;
        this.workers = [];
        this.isRunning = false;

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
    }

    log(message) {
        console.log(`[Master] ${message}`);
        this.io.emit('log', message);
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.log(`Starting Master Service with ${this.workerCount} workers...`);

        // Initialize Workers
        this.workers = [];
        for (let i = 1; i <= this.workerCount; i++) {
            this.workers.push(new AutomationWorker(i, this.io, this.browserType));
        }

        this.log('Waiting for jobs to process...');
        this.processQueue();
    }

    async stop() {
        this.isRunning = false;
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

                            if (!this.inProgressJobs.has(jobID)) {
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

            if (this.localQueue.length > 0) {
                // Find idle worker that is NOT offline
                const idleWorker = this.workers.find(w => !w.isBusy && !w.isOffline);

                if (idleWorker) {
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

            // Ensure worker is marked not busy even on crash
            worker.isBusy = false;

            if (newStatus === 'Pending Retry') {
                this.localQueue.push({
                    ...queueItem,
                    jobData: { ...jobData, RETRY_COUNT: newRetry }
                });
            }
        } finally {
            this.inProgressJobs.delete(jobData.JOB_ID);
        }
    }

    // Queue all excel I/O to avoid EBUSY data races when 20+ threads finish roughly at the same time
    async queueExcelUpdate(filePath, sheetName, rowIndex, status, retryCount = null) {
        return new Promise((resolve) => {
            this.excelUpdateQueue.push({ filePath, sheetName, rowIndex, status, retryCount, resolve });
            this.processExcelQueue();
        });
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
    async openProfile(id) {
        this.log(`Opening Profile ${id} for manual login using ${this.browserType}...`);
        const worker = new AutomationWorker(id, this.io, this.browserType);
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
