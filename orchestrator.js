const EventEmitter = require('events');

class JobOrchestrator extends EventEmitter {
    constructor(worker) {
        super();
        this.worker = worker;
        this.localRetryCount = 0;
        this.maxLocalRetries = 3;

    }

    async runMediaJob(jobData, jobOutputDir) {
        this.localRetryCount = 0;

        while (this.localRetryCount < this.maxLocalRetries) {
            if (this.worker.isOffline || (this.worker.automationService && !this.worker.automationService.isRunning)) {
                this.worker.log('[Orchestrator] Service has been stopped or worker is offline. Aborting job.');
                return;
            }

            try {
                this.worker.log(`[Orchestrator] Starting Media Generation Job ${jobData.JOB_ID}...`);

                // Gọi tới lõi xử lý Media
                await this.worker._internalProcessJob(jobData, jobOutputDir);

                // Clear errors on success
                this.localRetryCount = 0;
                this.worker.consecutiveErrorCount = 0;
                this.worker.log(`[Orchestrator] Job ${jobData.JOB_ID} completed successfully.`);
                return; // Thoát orchestrator

            } catch (e) {
                this.localRetryCount++;
                // MỘT VÀI LỖI TRÌNH DUYỆT NGHIÊM TRỌNG HẬU QUẢ PHẢI THOÁT NGAY LẬP TỨC CHO MASTER RESTART
                if (e.message.includes('Target closed') || e.message.includes('disconnected') || e.message.includes('detached Frame')) {
                    this.worker.log('[Orchestrator] Fatal browser disconnection. Escaping orchestration.');
                    throw e;
                }

                // FIX 2: UNUSUAL_ACTIVITY_BAN — close browser, xóa cookies nhiễm, relaunch với profile clone sạch
                // Không tính vào localRetryCount (không penalty) vì đây là lỗi môi trường, không phải lỗi logic
                if (e.message.includes('UNUSUAL_ACTIVITY_BAN')) {
                    this.worker.log('[Orchestrator] UNUSUAL_ACTIVITY_BAN (HTTP 403). Closing browser...');
                    try {
                        await this.worker.close();
                    } catch (closeErr) {
                        this.worker.log(`[Orchestrator] close() error (non-fatal): ${closeErr.message}`);
                    }
                    this.worker.browser = null;
                    this.worker.page = null;

                    // Xóa cookies nhiễm khỏi profile hiện tại, profile gốc và Cold Snapshot
                    // → lần launch() tiếp theo sẽ tạo shadow clone từ profile sạch (không có cookie cũ)
                    this.worker.log('[Orchestrator] Purging tainted cookies from profile + snapshot...');
                    try {
                        await this.worker.clearGoogleFlowCookies();
                    } catch (purgeErr) {
                        this.worker.log(`[Orchestrator] Cookie purge error (non-fatal): ${purgeErr.message}`);
                    }

                    // Hoàn lại 1 retry slot để không bị penalize
                    this.localRetryCount = Math.max(0, this.localRetryCount - 1);
                    this.worker.log('[Orchestrator] Profile cleaned. Next iteration will clone fresh profile via launch().');
                    await this.worker.sleep(5000);
                    continue;
                }


                // CHỈ LOGOUT NẾU ĐÂY LÀ LỖI TẠO MEDIA (3 Nút hoặc ZodError)
                if (e.message.includes('MEDIA_GENERATION_FAILED')) {

                    this.worker.consecutiveErrorCount++; // Biến đếm lỗi liên tiếp toàn cực
                    this.worker.log(`[Orchestrator] Media Error (Local Retry ${this.localRetryCount}/${this.maxLocalRetries}): ${e.message}`);

                    // Luồng phục hồi Max Retry Reached - Event
                    if (this.worker.consecutiveErrorCount >= 3) {
                        this.worker.log(`[Orchestrator] 3 consecutive Media errors triggered! Emitting recovery protocol.`);
                        await this.recoverSession();
                        this.worker.consecutiveErrorCount = 0; // Reset đếm sau khi recover
                    }
                } else {
                    this.worker.log(`[Orchestrator] General Error (Local Retry ${this.localRetryCount}/${this.maxLocalRetries}): ${e.message}`);
                    // Không tăng consecutiveErrorCount đối với các lỗi vụn vặt
                }

                // Nếu vẫn đạt max local retries, thông báo ném ngoại lệ lên cục diện Master (Automation.js)
                if (this.localRetryCount >= this.maxLocalRetries) {
                    this.worker.log(`[Orchestrator] Job permanently failed locally after ${this.localRetryCount} retries. Falling back to Master Queue.`);
                    throw e;
                }

                // Trễ nhẹ trước vòng lặp retry tiếp theo
                this.worker.log('[Orchestrator] Wait 5 seconds before retrying the same job locally...');
                await this.worker.sleep(5000);
            }
        }
    }

    async recoverSession() {
        if (this.worker.automationService && !this.worker.automationService.isRunning) return;
        this.worker.log('[Error Hub] Recovery Triggered: Logging out of current session...');
        try {
            if (this.worker.page) {
                const page = this.worker.page;
                await page.goto('https://accounts.google.com/Logout', { waitUntil: 'networkidle2', timeout: 30000 });
                await this.worker.sleep(4000);
            }
            if (this.worker.automationService && !this.worker.automationService.isRunning) return;
            this.worker.log('[Error Hub] Successfully signed out. Starting auto-login flow to recover session...');
            await this.worker.handleLoginWait();
        } catch (e) {
            this.worker.log(`[Error Hub] Recovery failed during logout/login cycle: ${e.message}`);
        }
    }
}

module.exports = JobOrchestrator;
