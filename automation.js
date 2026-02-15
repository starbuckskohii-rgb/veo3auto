const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const AutomationWorker = require('./worker');

class AutomationService {
    constructor(io, inputFolder, workerCount = 1) {
        this.io = io;
        this.inputFolder = inputFolder;
        this.outputDir = path.join(inputFolder, 'Output');
        this.workerCount = workerCount;
        this.workers = [];
        this.isRunning = false;

        // Queue State
        this.files = [];
        this.globalQueue = []; // Array of { fileIndex, jobIndex, jobData }
        this.isProcessing = false;
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
            this.workers.push(new AutomationWorker(i, this.io));
        }

        // Scan & Build Queue
        this.scanFiles();

        if (this.globalQueue.length === 0) {
            this.log('No pending jobs found.');
            this.isRunning = false;
            return;
        }

        this.log(`Global Queue: ${this.globalQueue.length} jobs pending.`);
        this.processQueue();
    }

    async stop() {
        this.isRunning = false;
        this.log('Stopping...');
        for (const worker of this.workers) {
            await worker.close();
        }
    }

    scanFiles() {
        this.files = fs.readdirSync(this.inputFolder).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
        this.globalQueue = [];

        this.files.forEach((file, fIndex) => {
            const filePath = path.join(this.inputFolder, file);
            const workbook = xlsx.readFile(filePath);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

            rawData.forEach((row, rIndex) => {
                const status = (row['STATUS'] || '').toLowerCase();
                const retryCount = parseInt(row['RETRY_COUNT'] || '0') || 0;

                if (status !== 'completed' && status !== 'failed' && status !== 'skipped' && retryCount < 3) {
                    this.globalQueue.push({
                        fileIndex: fIndex,
                        fileName: file,
                        filePath: filePath,
                        rowIndex: rIndex,
                        sheetName: sheetName,
                        jobData: {
                            JOB_ID: row['JOB_ID'] || `JOB_${fIndex}_${rIndex}`,
                            PROMPT: row['PROMPT'] || row['prompt'] || '',
                            STATUS: row['STATUS'] || '',
                            VIDEO_NAME: row['VIDEO_NAME'] || row['name'] || `video_${Date.now()}_${rIndex}`,
                            TYPE_VIDEO: row['TYPE_VIDEO'] || '',
                            RETRY_COUNT: retryCount
                        }
                    });
                }
            });

            // Initial UI Update for this file?
            // Converting globalQueue to a flat list for UI might be heavy if huge.
            // Let's just emit stats.
        });

        // Emit total count or initial list
        this.io.emit('job-list', this.globalQueue.map(q => q.jobData));
    }

    async processQueue() {
        while (this.isRunning && this.globalQueue.length > 0) {
            // Find idle worker
            const idleWorker = this.workers.find(w => !w.isBusy);

            if (idleWorker) {
                // Get next job
                const queueItem = this.globalQueue.shift();
                if (!queueItem) break;

                // Dispatch (Non-blocking)
                this.dispatchJob(idleWorker, queueItem);

                // Small delay to prevent race condition in checking workers
                await this.sleep(500);
            } else {
                // All busy, wait
                await this.sleep(2000);
            }
        }

        if (this.globalQueue.length === 0 && this.workers.every(w => !w.isBusy)) {
            this.log('All jobs completed.');
            this.isRunning = false;
        } else if (this.isRunning) {
            // Queue empty but workers busy, loop will check again
            setTimeout(() => this.processQueue(), 1000);
        }
    }

    async dispatchJob(worker, queueItem) {
        const { fileName, filePath, rowIndex, sheetName, jobData } = queueItem;

        // 1. Lock / Mark Processing in Excel IMMEDIATELY
        this.updateExcelStatus(filePath, sheetName, rowIndex, 'Processing');
        this.io.emit('job-update', { ...jobData, STATUS: 'Processing' }); // UI Update

        this.log(`Dispatching Job ${jobData.JOB_ID} to Worker ${worker.id}`);

        // Create Subfolder (Thread safe? fs.mkdirSync is usually fine)
        const fileNameNoExt = path.parse(fileName).name;
        const jobOutputDir = path.join(this.outputDir, fileNameNoExt);
        if (!fs.existsSync(jobOutputDir)) fs.mkdirSync(jobOutputDir, { recursive: true });

        try {
            await worker.processJob(jobData, jobOutputDir);

            // Success
            this.updateExcelStatus(filePath, sheetName, rowIndex, 'Completed');
            this.io.emit('job-update', { ...jobData, STATUS: 'Completed' });

        } catch (e) {
            // Fail logic
            const newRetry = (jobData.RETRY_COUNT || 0) + 1;
            const newStatus = newRetry >= 3 ? 'Failed' : 'Pending Retry';

            this.updateExcelStatus(filePath, sheetName, rowIndex, newStatus, newRetry);
            this.io.emit('job-update', { ...jobData, STATUS: newStatus, RETRY_COUNT: newRetry });

            if (newStatus === 'Pending Retry') {
                // Re-add to queue? Or scans handle it?
                // Better to re-add to queue if we want robust retry NOW.
                // But current logic puts it at end of queue
                this.globalQueue.push({
                    ...queueItem,
                    jobData: { ...jobData, RETRY_COUNT: newRetry }
                });
            }
        }
    }

    updateExcelStatus(filePath, sheetName, rowIndex, status, retryCount = null) {
        // Critical: Lock file? accessing same file from multiple workers might be issue if using async.
        // But we are in Master process (single thread Node.js), so sequential writes are safe 
        // PROVIDED we read-modify-write synchronously.
        try {
            const workbook = xlsx.readFile(filePath);
            const worksheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

            if (data[rowIndex]) {
                data[rowIndex]['STATUS'] = status;
                if (retryCount !== null) data[rowIndex]['RETRY_COUNT'] = retryCount;

                const newWs = xlsx.utils.json_to_sheet(data);
                const newWb = xlsx.utils.book_new();
                xlsx.utils.book_append_sheet(newWb, newWs, sheetName);
                xlsx.writeFile(newWb, filePath);
            }
        } catch (e) {
            this.log(`Error updating Excel: ${e.message}`);
        }
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Manual Profile Opener
    async openProfile(id) {
        this.log(`Opening Profile ${id} for manual login...`);
        const worker = new AutomationWorker(id, this.io);
        await worker.launch();
        return worker;
    }
}

module.exports = AutomationService;
