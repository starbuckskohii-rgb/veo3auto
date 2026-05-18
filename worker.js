const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { encrypt, decrypt } = require('./encryption');
const OTPAuth = require('otpauth');
const JobOrchestrator = require('./orchestrator');

// Concurrency handling optimized - no global locks required.

class AutomationWorker {
    constructor(id, accountData, automationService, io, browserType = 'edge', assignedProxy = null) {
        this.id = id;
        this.accountData = accountData || {};
        this.automationService = automationService; // Pass master to access stop/pause
        this.io = io;
        this.browserType = browserType;
        this.assignedProxy = assignedProxy;
        this.browser = null;
        this.page = null;
        this.isBusy = false;
        this.isOffline = false;

        this.startTime = Date.now();
        this.lastActionTime = Date.now();
        this.currentStep = 'Idle';
        this.consecutiveErrorCount = 0;
        this.orchestrator = new JobOrchestrator(this);

        const baseDir = process.env.USER_DATA_PATH || path.resolve('./user_data');
        const accountProfileName = this.accountData.profilePath || `profile_${id}`;

        const anchorProfilePath = path.join(baseDir, accountProfileName, `${this.browserType}_data`);
        this.profilePath = path.join(baseDir, accountProfileName, `${this.browserType}_data`);
    }

    log(msg) {
        this.lastActionTime = Date.now();
        this.currentStep = msg.length > 50 ? msg.substring(0, 50) + '...' : msg;
        const message = `[Worker ${this.id}] ${msg}`;
        console.log(message);
        this.io.emit('log', message);
    }

    async launch() {
        if (this.automationService && this.automationService.requestLaunchLock) {
            await this.automationService.requestLaunchLock(this.id);
        }
        this.log(`Launching browser (${this.browserType})...`);

        // Feature: LATE BINDING - Only clone profile when browser actually launches
        this.isShadowProfile = false;
        const baseDir = process.env.USER_DATA_PATH || path.resolve('./user_data');
        const accountProfileName = this.accountData.profilePath || `profile_${this.id}`;

        if (this.accountData && this.accountData.id && this.automationService) {
            // Check all other active workers to see if someone actually LAUNCHED this Account ID
            const activeAnchor = this.automationService.workers.find(w =>
                w.id !== this.id &&
                w.accountData &&
                w.accountData.id === this.accountData.id &&
                !w.isShadowProfile &&
                w.browser !== null // Only consider them an anchor if they ACTUALLY opened a browser!
            );

            if (activeAnchor) {
                this.isShadowProfile = true;
            }
        }

        const anchorProfilePath = path.join(baseDir, accountProfileName, `${this.browserType}_data`);
        
        // --- XÓA RÁC CÁC TÀI KHOẢN SHADOW BỊ KẸT TỪ LẦN CHẠY TRƯỚC ---
        // Quét toàn bộ shadow folder của account này (mọi worker ID), vì chúng đều là rác từ lần chạy trước
        try {
            const profilesDir = fs.readdirSync(baseDir);
            for (const folder of profilesDir) {
                if (folder.startsWith(`${accountProfileName}_shadow_`)) {
                    const oldPath = path.join(baseDir, folder);
                    this.log(`[Shadow GC] Dọn dẹp rác từ lần chạy cũ: ${folder}`);
                    fs.promises.rm(oldPath, { recursive: true, force: true }).catch(() => {});
                }
            }
        } catch (e) {}

        // ── COLD SNAPSHOT: Chụp ảnh profile TRƯỚC khi anchor mở browser ──
        // Shadow workers sẽ clone từ snapshot này thay vì profile đang bị lock
        if (!this.isShadowProfile && this.automationService) {
            const snapshotDir = path.join(baseDir, `${accountProfileName}_snapshot`);
            if (fs.existsSync(anchorProfilePath)) {
                try {
                    // Xóa snapshot cũ nếu có
                    if (fs.existsSync(snapshotDir)) {
                        fs.rmSync(snapshotDir, { recursive: true, force: true });
                    }
                    fs.cpSync(anchorProfilePath, snapshotDir, {
                        recursive: true, force: true, filter: (src) => {
                            // Skip lock files and cache để giảm dung lượng
                            if (src.includes('SingletonLock') || src.includes('SingletonCookie')) return false;
                            if (src.includes('Cache') && !src.includes('Cookies')) return false;
                            if (src.includes('Service Worker')) return false;
                            if (src.includes('GPUCache')) return false;
                            return true;
                        }
                    });
                    this.log(`[Cold Snapshot] Đã chụp profile gốc cho shadow workers.`);
                    // Store snapshot path on service level for shadow workers to find
                    if (!this.automationService._profileSnapshots) this.automationService._profileSnapshots = {};
                    this.automationService._profileSnapshots[this.accountData.id] = snapshotDir;
                } catch (snapErr) {
                    this.log(`[Cold Snapshot] Lỗi tạo snapshot: ${snapErr.message}`);
                }
            }
        }

        const baseProfileName = this.isShadowProfile ? `${accountProfileName}_shadow_${this.id}_${Date.now()}` : accountProfileName;
        this.profilePath = path.join(baseDir, baseProfileName, `${this.browserType}_data`);

        if (!fs.existsSync(this.profilePath)) {
            if (this.isShadowProfile) {
                // Ưu tiên clone từ Cold Snapshot (không bị lock), fallback sang profile gốc
                let cloneSource = anchorProfilePath;
                if (this.automationService._profileSnapshots && this.automationService._profileSnapshots[this.accountData.id]) {
                    const snapshotPath = this.automationService._profileSnapshots[this.accountData.id];
                    if (fs.existsSync(snapshotPath)) {
                        cloneSource = snapshotPath;
                        this.log(`[Shadow Clone] Sử dụng Cold Snapshot (không bị lock).`);
                    }
                }

                if (fs.existsSync(cloneSource)) {
                    this.log(`[Shadow Clone] Đang clone Profile cho luồng ${this.id}...`);
                    try {
                        fs.cpSync(cloneSource, this.profilePath, {
                            recursive: true, force: true, filter: (src) => {
                                if (src.includes('SingletonLock') || src.includes('SingletonCookie')) return false;
                                return true;
                            }
                        });
                        this.log(`[Shadow Clone] Copy thư mục Profile hoàn thành!`);
                    } catch (e) {
                        this.log(`[Shadow Clone] Lỗi sao chép: ${e.message}. Tiếp tục với Folder trống.`);
                        fs.mkdirSync(this.profilePath, { recursive: true });
                    }
                } else {
                    this.log(`[Shadow Clone] Không tìm thấy nguồn clone. Tạo folder trống.`);
                    fs.mkdirSync(this.profilePath, { recursive: true });
                }
            } else {
                fs.mkdirSync(this.profilePath, { recursive: true });
            }
        }

        // Forcefully inject preferences to match user manual settings
        try {
            const setPrefs = (prefs) => {
                if (!prefs.profile) prefs.profile = {};
                prefs.profile.cookie_controls_mode = 1;
                prefs.profile.block_third_party_cookies = true;

                prefs.enable_do_not_track = true;

                if (!prefs.privacy) prefs.privacy = {};
                if (!prefs.privacy.tracking) prefs.privacy.tracking = {};
                prefs.privacy.tracking.tracking_protection_level = 0;

                if (!prefs.enhanced_tracking_prevention) prefs.enhanced_tracking_prevention = {};
                prefs.enhanced_tracking_prevention.enabled = false;

                // ── BRAVE SHIELDS: Tắt hoàn toàn để tránh block Google Fonts/Icons ──
                if (!prefs.brave) prefs.brave = {};
                if (!prefs.brave.p3a) prefs.brave.p3a = {};
                prefs.brave.p3a.notice_acknowledged = true;
                prefs.brave.p3a.enabled = false;

                // Disable Brave Shields globally
                if (!prefs.brave.shields) prefs.brave.shields = {};
                prefs.brave.shields.advanced_view_enabled = false;
                if (!prefs.brave.shields.default) prefs.brave.shields.default = {};

                // Force fingerprinting protection OFF (causes font rendering issues)
                if (!prefs.brave.fingerprinting_v2_enabled !== undefined) {
                    prefs.brave.fingerprinting_v2_enabled = false;
                }
                if (!prefs.brave.de_amp) prefs.brave.de_amp = {};
                prefs.brave.de_amp.enabled = false;

                // Allow Google fonts by setting content settings
                if (!prefs.profile.content_settings) prefs.profile.content_settings = {};
                if (!prefs.profile.content_settings.exceptions) prefs.profile.content_settings.exceptions = {};
                if (!prefs.profile.content_settings.exceptions.braveShields) prefs.profile.content_settings.exceptions.braveShields = {};
                // Disable shields for Google domains
                prefs.profile.content_settings.exceptions.braveShields['[*.]google.com,*'] = { setting: 1 };
                prefs.profile.content_settings.exceptions.braveShields['[*.]googleapis.com,*'] = { setting: 1 };
                prefs.profile.content_settings.exceptions.braveShields['[*.]gstatic.com,*'] = { setting: 1 };
                prefs.profile.content_settings.exceptions.braveShields['[*.]labs.google,*'] = { setting: 1 };

                return prefs;
            };

            const prefsPath = path.join(this.profilePath, 'Default', 'Preferences');
            if (fs.existsSync(prefsPath)) {
                let prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
                fs.writeFileSync(prefsPath, JSON.stringify(setPrefs(prefs)));
            } else {
                fs.mkdirSync(path.join(this.profilePath, 'Default'), { recursive: true });
                fs.writeFileSync(prefsPath, JSON.stringify(setPrefs({})));
            }
        } catch (prefErr) {
            this.log(`Could not write preferences: ${prefErr.message}`);
        }

        try {
            let executablePath = null;

            if (this.browserType === 'brave') {
                const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
                const bravePaths = [
                    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                    path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
                ];
                for (const bp of bravePaths) {
                    if (fs.existsSync(bp)) {
                        executablePath = bp;
                        break;
                    }
                }
            } else if (this.browserType === 'edge') {
                const edgePaths = [
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
                ];
                for (const ep of edgePaths) {
                    if (fs.existsSync(ep)) {
                        executablePath = ep;
                        break;
                    }
                }
            }

            if (!executablePath && this.browserType !== 'brave' && this.browserType !== 'chrome') {
                this.log('Edge not found. Downloading Chrome (First Run)... This may take a minute.');
                const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(process.env.USER_DATA_PATH || '.', 'puppeteer_cache');
                if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                const browserFetcher = puppeteer.createBrowserFetcher({ path: cacheDir });
                const revisionInfo = browserFetcher.revisionInfo(puppeteer.PUPPETEER_REVISIONS.chromium);

                if (!revisionInfo.local) {
                    await browserFetcher.download(puppeteer.PUPPETEER_REVISIONS.chromium, (downloaded, total) => { });
                    this.log('Download complete.');
                }
                executablePath = revisionInfo.executablePath;
            } else if (!executablePath && this.browserType === 'brave') {
                this.log('Brave browser executable not found. Please install it.');
                throw new Error("Brave browser executable not found.");
            } else {
                this.log(`Using Local Browser (${this.browserType}): ${executablePath || 'Default Chrome'}`);
            }

            this.log(`Starting ${this.browserType} with puppeteer-real-browser...`);
            const { connect } = require('puppeteer-real-browser');

            let browserArgs = [
                '--start-maximized',
                '--disable-infobars',
                '--profile-directory=Default',
                '--disable-features=IsolateOrigins,site-per-process,AutomationControlled,TrackingProtection3pcd,TrackingProtection,PrivacySandboxSettings4,msTrackingPrevention,BraveShields,BraveAdBlock,BraveFingerprintingV2',
                '--disable-dev-shm-usage',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-first-run',
                '--font-render-hinting=none',
                '--no-default-browser-check',
                '--disable-session-crashed-bubble',
                '--hide-crash-restore-bubble',
                '--restore-last-session=false',
                '--do-not-track',
                '--new-window',
                '--test-type',
                // Brave GPU/Font rendering fixes
                '--disable-gpu-compositing',
                '--enable-gpu-rasterization',
                '--enable-font-antialiasing',
                '--force-color-profile=srgb',
                `--user-data-dir=${this.profilePath}`
            ];

            if (this.assignedProxy) {
                browserArgs.push(`--proxy-server=http://${this.assignedProxy.ip}:${this.assignedProxy.port}`);
            }

            // Assign a STRICT static debug port per worker to bypass chrome-launcher's getRandomPort() race condition
            // When started concurrently, chrome-launcher assigns the SAME random port to multiple workers, causing Tab grouping!
            let debugPort = 9222 + parseInt(this.id);
            if (isNaN(debugPort)) {
                // For 'TEMP' workers or non-integer IDs, assign a random port far away from the main cluster
                debugPort = 9300 + Math.floor(Math.random() * 100);
            }

            const options = {
                headless: false,
                turnstile: true,
                ignoreAllFlags: true,
                args: browserArgs,
                customConfig: {
                    userDataDir: this.profilePath,
                    port: debugPort
                },
                connectOption: { defaultViewport: null }
            };

            if (executablePath) {
                options.customConfig.chromePath = executablePath;
            }

            const result = await connect(options);
            this.browser = result.browser;

            this.browser.on('disconnected', () => {
                this.isOffline = true;
                this.io.emit('worker-status', { id: this.id, status: 'offline' });
                this.log('Browser disconnected. Worker offline.');
            });

            // Close extra background tabs but maintain exactly one 'about:blank' tab + one 'auto' tab
            // This prevents Chromium rendering crashes when the tab is heavily manipulated by CDP
            const pages = await this.browser.pages();
            if (pages.length > 0) {
                await pages[0].goto('about:blank').catch(() => { });
                for (let i = 1; i < pages.length; i++) {
                    await pages[i].close().catch(() => { });
                }
            }

            // Spawn the main automation tab
            this.page = await this.browser.newPage();
            await this.page.bringToFront();

            if (this.assignedProxy && this.assignedProxy.username) {
                await this.page.authenticate({
                    username: this.assignedProxy.username,
                    password: this.assignedProxy.password
                });
            }
            this.page.on('dialog', async dialog => {
                await dialog.accept();
            });

            this.log('Browser launched successfully');
            await this.handleLoginWait();
        } catch (e) {
            this.log(`Browser launch failed: ${e.message}`);
            // Fallback Cleanup if launch crashes midway!
            if (this.isShadowProfile && this.profilePath) {
                try {
                    if (fs.existsSync(this.profilePath)) {
                        // Use asynchronous rm to not block event loop during fallback cleanup
                        await fs.promises.rm(this.profilePath, { recursive: true, force: true, maxRetries: 5 });
                    }
                } catch (ce) { }
            }
            throw e;
        }
    }

    /**
     * Xóa cookies của labs.google khỏi SQLite profile hiện tại (Cookies file).
     * Gọi sau khi close() và trước khi launch() lại để xóa cookie nhiễm sau UNUSUAL_ACTIVITY_BAN.
     * 
     * Chiến lược:
     * - Shadow worker  → xóa toàn bộ folder clone đang dùng (thức ra close() đã xóa rồi qua Shadow GC)
     * - Anchor worker  → xóa file Cookies trong profile gốc + trong _snapshot
     *                  → buộc worker trở thành shadow worker (isShadowProfile = true) ở lần launch tiếp theo
     *                    bằng cách đặt this.browser = null ngay sau close() — anchor detection check "w.browser !== null"
     */
    async clearGoogleFlowCookies() {
        const path = require('path');
        const baseDir = process.env.USER_DATA_PATH || path.resolve('./user_data');
        const accountProfileName = this.accountData.profilePath || `profile_${this.id}`;
        const anchorProfilePath = path.join(baseDir, accountProfileName, `${this.browserType}_data`);

        // Danh sách các vị trí cần xóa cookies
        const cookieTargets = [];

        // 1. Profile đang dùng (có thể là shadow hoặc anchor)
        if (this.profilePath && fs.existsSync(this.profilePath)) {
            cookieTargets.push(this.profilePath);
        }

        // 2. Profile gốc (anchor path) — luôn xóa để tránh snapshot tiếp theo mang cookie nhiễm
        if (anchorProfilePath !== this.profilePath && fs.existsSync(anchorProfilePath)) {
            cookieTargets.push(anchorProfilePath);
        }

        // 3. Cold Snapshot — xóa để buộc tạo lại từ anchor sạch
        if (this.automationService && this.automationService._profileSnapshots && this.automationService._profileSnapshots[this.accountData.id]) {
            const snapshotPath = this.automationService._profileSnapshots[this.accountData.id];
            if (fs.existsSync(snapshotPath)) {
                cookieTargets.push(snapshotPath);
            }
            // Xóa record snapshot — launch() sẽ tạo lại từ anchor clean
            delete this.automationService._profileSnapshots[this.accountData.id];
        }

        for (const profileDir of cookieTargets) {
            const cookiePath = path.join(profileDir, 'Default', 'Cookies');
            const networkCookiePath = path.join(profileDir, 'Default', 'Network', 'Cookies');
            for (const cp of [cookiePath, networkCookiePath]) {
                if (fs.existsSync(cp)) {
                    try {
                        fs.unlinkSync(cp);
                        this.log(`[CookiePurge] Xóa Cookies tại: ${cp.replace(baseDir, '...')}`);
                    } catch (e) {
                        this.log(`[CookiePurge] Không xóa được ${cp}: ${e.message}`);
                    }
                }
            }
        }
    }


    async checkAndRecoverSession() {
        if (!this.page) return false;
        try {
            let clicked = false;
            for (const frame of this.page.frames()) {
                clicked = await frame.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    const spans = Array.from(document.querySelectorAll('span, div'));
                    const allEls = [...btns, ...spans];

                    for (const el of allEls) {
                        const t = (el.innerText || '').trim().toLowerCase();
                        if (t === 'sign in with google' || t === 'đăng nhập bằng google') {
                            const clickable = el.closest('button, [role="button"]') || el;
                            const r = clickable.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {
                                clickable.click();
                                return true;
                            }
                        }
                    }
                    return false;
                }).catch(() => false);

                if (clicked) {
                    this.log('Detected Google Identity Session drop modal. Auto-clicking "Sign in with Google"...');
                    await this.sleep(4000); // Give it time to process the login click
                    return true;
                }
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    async handleLoginWait() {
        if (!this.page) return;
        try {
            this.log('Navigating to Veo3 for login check...');
            await this.page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.sleep(4000); // Give the app more time to render

            let isLoggedIn = false;
            let currentUrl = await this.page.url();

            const checkLoggedIn = async () => {
                return await this.page.evaluate(() => {
                    const textNodes = Array.from(document.querySelectorAll('div, span, button, a'));
                    const hasNewProject = textNodes.some(el => {
                        if (!el.textContent) return false;
                        const t = el.textContent.trim().toLowerCase();
                        return t.includes('dự án mới') || t.includes('new project') || t.includes('create new project');
                    });
                    return hasNewProject || !!document.querySelector('[data-slate-editor="true"][role="textbox"]');
                });
            };

            isLoggedIn = await checkLoggedIn();

            // If not immediately logged in, check if we are on the Intro Page ("Create with Flow")
            if (!isLoggedIn && !currentUrl.includes('accounts.google.com') && !currentUrl.includes('signin')) {
                let onIntroPage = false;
                try {
                    onIntroPage = await this.page.evaluate(() => {
                        const textNodes = Array.from(document.querySelectorAll('div, span, button, a'));
                        return textNodes.some(el => el.textContent && (el.textContent.trim().toLowerCase() === 'tạo bằng flow' || el.textContent.trim().toLowerCase() === 'create with flow'));
                    });
                } catch (e) { }

                if (onIntroPage) {
                    this.log('Intro page detected. Clicking "Create with Flow"...');
                    const btnCoords = await this.page.evaluate(() => {
                        const all = document.querySelectorAll('div, span, button, a');
                        for (let el of all) {
                            const text = el.textContent ? el.textContent.trim().toLowerCase() : '';
                            if (text === 'tạo bằng flow' || text === 'create with flow') {
                                const r = el.getBoundingClientRect();
                                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }
                        }
                        return null;
                    });

                    if (btnCoords) {
                        await this.humanClick(this.page, btnCoords.x, btnCoords.y);
                        this.log('Waiting to see if redirect to login is needed, or if already logged in...');
                        await this.sleep(4000); // Wait for redirect or editor load

                        // Re-check state after clicking the intro button
                        isLoggedIn = await checkLoggedIn();
                        currentUrl = await this.page.url();
                    }
                }
            }

            if (!isLoggedIn || currentUrl.includes('accounts.google.com') || currentUrl.includes('AccountChooser') || currentUrl.includes('signin')) {

                this.log('Login sequence required.');

                const email = this.accountData.email;
                const pwd = decrypt(this.accountData.password);
                const tfaSecret = decrypt(this.accountData.twoFactorSecret);

                if (this.accountData.loginType === 'auto' && email && pwd) {
                    this.log('Auto-login initiated for ' + email);
                    try {

                        // ----------------------------------------------------
                        // ADDED: Account Chooser Recovery (Signed Out Session)
                        // ----------------------------------------------------
                        this.log('Checking for Account Chooser / Signed Out state...');
                        try {
                            const accountChooserHandled = await this.page.evaluate(async (targetEmail) => {
                                // Google's DOM is highly nested. Search all generic text containers.
                                const allElements = document.querySelectorAll('div, span');

                                for (let el of allElements) {
                                    if (el.textContent && el.textContent.trim().toLowerCase() === targetEmail.trim().toLowerCase()) {
                                        // Sometimes the span itself isn't clickable, but its parent or itself is
                                        el.click();
                                        return true;
                                    }
                                }

                                // If email not found but we are on Account Chooser, try to click "Use another account"
                                for (let el of allElements) {
                                    if (el.textContent) {
                                        const t = el.textContent.trim().toLowerCase();
                                        if (t === 'use another account' || t === 'sử dụng tài khoản khác') {
                                            el.click();
                                            return false; // Proceed to manual email entry
                                        }
                                    }
                                }

                                return false;
                            }, email);

                            if (accountChooserHandled) {
                                this.log(`Found and clicked saved account: ${email}`);
                                await this.sleep(2000);
                            }
                        } catch (e) {
                            // Suppress error and continue to normal email input
                        }
                        // ----------------------------------------------------

                        // Wait for email field
                        this.log('Waiting for Email input...');
                        try {
                            await this.page.waitForSelector('input[type="email"], input[name="identifier"]', { timeout: 15000 });
                            const emailInput = await this.page.$('input[type="email"], input[name="identifier"]');
                            if (emailInput) {
                                this.log('Found Email input. Chờ 4 giây để trang tải hoàn toàn...');
                                await this.sleep(4000); // Wait 4 seconds for page to fully load
                                await emailInput.click();
                                await this.sleep(500);

                                for (const char of email) {
                                    // Puppeteer's native .type() enforces Focus before every character!
                                    await emailInput.type(char, { delay: Math.floor(Math.random() * 30 + 30) });
                                    await this.sleep(Math.floor(Math.random() * 40 + 20));
                                }

                                const emailWaitMs = Math.floor(Math.random() * (4000 - 2000 + 1)) + 2000;
                                this.log(`Chờ ${Math.floor(emailWaitMs / 1000)}s sau khi nhập Email...`);
                                await this.sleep(emailWaitMs);

                                let clickedNext = false;
                                try {
                                    const btnHandles = await this.page.$$('button, div[role="button"]');
                                    for (const btn of btnHandles) {
                                        const isVis = await btn.isIntersectingViewport();
                                        if (isVis) {
                                            const text = await btn.evaluate(el => (el.innerText || '').trim().toLowerCase());
                                            if (text === 'next' || text === 'tiếp theo') {
                                                await btn.click({ delay: 50 });
                                                clickedNext = true;
                                                break;
                                            }
                                        }
                                    }
                                } catch (e) { }

                                if (!clickedNext) {
                                    this.log('Could not click Next button natively, falling back to Enter key...');
                                    await emailInput.focus().catch(() => { });
                                    await emailInput.click().catch(() => { });
                                    await this.page.keyboard.press('Enter');
                                }

                                this.log('Email submitted.');
                            }
                        } catch (err) {
                            this.log('Email input not found, we might already be on the password page or logged in.');
                        }

                        // Wait for password field
                        this.log('Waiting for Password input...');
                        try {
                            await this.page.waitForSelector('input[type="password"], input[name="Passwd"]', { timeout: 15000, visible: true });
                            const pwdInput = await this.page.$('input[type="password"], input[name="Passwd"]');
                            if (pwdInput) {
                                this.log('Found Password input. Chờ 4 giây để trang tải hoàn toàn...');
                                await this.sleep(4000); // 4 seconds human pause after page load
                                await pwdInput.click();
                                await this.sleep(500);

                                for (const char of pwd) {
                                    await pwdInput.type(char, { delay: Math.floor(Math.random() * 30 + 30) });
                                    await this.sleep(Math.floor(Math.random() * 40 + 20));
                                }

                                const pwdWaitMs = Math.floor(Math.random() * (4000 - 2000 + 1)) + 2000;
                                this.log(`Chờ ${Math.floor(pwdWaitMs / 1000)}s sau khi nhập Password...`);
                                await this.sleep(pwdWaitMs);

                                let clickedPwdNext = false;
                                try {
                                    const btnHandles = await this.page.$$('button, div[role="button"]');
                                    for (const btn of btnHandles) {
                                        const isVis = await btn.isIntersectingViewport();
                                        if (isVis) {
                                            const text = await btn.evaluate(el => (el.innerText || '').trim().toLowerCase());
                                            if (text === 'next' || text === 'tiếp theo') {
                                                await btn.click({ delay: 50 });
                                                clickedPwdNext = true;
                                                break;
                                            }
                                        }
                                    }
                                } catch (e) { }

                                if (!clickedPwdNext) {
                                    this.log('Could not natively click Next button, falling back to Enter key...');
                                    await pwdInput.click().catch(() => { });
                                    await this.page.keyboard.press('Enter');
                                }

                                this.log('Password submitted.');
                            }
                        } catch (err) {
                            this.log('Password input not found within 15s.');
                        }

                        this.log('Checking for 2FA or success redirect...');

                        let loginSuccess = false;

                        if (tfaSecret) {
                            this.log('Tài khoản có Secret 2FA. Đang chờ Form 2FA xuất hiện...');
                            try {
                                this.log('Đang quét tìm ô nhập OTP 2FA...');
                                await this.sleep(4000); // Give the 2FA page a moment to fully render

                                // Generate the token upfront so we can log it regardless of UI
                                const totp = new OTPAuth.TOTP({
                                    issuer: 'Google',
                                    label: 'Account',
                                    algorithm: 'SHA1',
                                    digits: 6,
                                    period: 30,
                                    secret: tfaSecret
                                });
                                const token = totp.generate();
                                this.log(`[DEBUG] Mã OTP 6 số vừa tạo từ Secret: ${token}`);

                                // Broadly find any sensible input on the challenge page
                                const tfaInput = await this.page.evaluateHandle(() => {
                                    const fields = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
                                    for (let f of fields) {
                                        if (f.type === 'tel' ||
                                            f.name.toLowerCase().includes('pin') ||
                                            f.id.toLowerCase().includes('pin') ||
                                            (f.getAttribute('autocomplete') && f.getAttribute('autocomplete') === 'one-time-code') ||
                                            f.type === 'text' // fallback to the first active text box if all else fails
                                        ) {
                                            return f;
                                        }
                                    }
                                    return null;
                                });

                                if (tfaInput && await tfaInput.evaluate(node => node !== null)) {
                                    this.log('Đã tìm thấy Form 2FA, đang điền OTP...');
                                    await tfaInput.click();
                                    await this.sleep(800);

                                    // Type like a human, natively focusing for each char
                                    for (const char of token) {
                                        await tfaInput.type(char, { delay: Math.floor(Math.random() * 30 + 50) });
                                        await this.sleep(Math.floor(Math.random() * 50 + 50));
                                    }

                                    const tfaWaitMs = Math.floor(Math.random() * (4000 - 2000 + 1)) + 2000;
                                    this.log(`Chờ ${Math.floor(tfaWaitMs / 1000)}s sau khi điền mã 2FA...`);
                                    await this.sleep(tfaWaitMs);

                                    let clickedTfaNext = false;
                                    try {
                                        const btnHandles = await this.page.$$('button, div[role="button"]');
                                        for (const btn of btnHandles) {
                                            const isVis = await btn.isIntersectingViewport();
                                            if (isVis) {
                                                const text = await btn.evaluate(el => (el.innerText || '').trim().toLowerCase());
                                                if (text === 'next' || text === 'tiếp theo') {
                                                    await btn.click({ delay: 50 });
                                                    clickedTfaNext = true;
                                                    break;
                                                }
                                            }
                                        }
                                    } catch (e) { }

                                    if (!clickedTfaNext) {
                                        this.log('Could not natively click Next button, falling back to Enter key...');
                                        await tfaInput.click().catch(() => { });
                                        await this.page.keyboard.press('Enter');
                                    }

                                    this.log('Đã nhập và gửi Form OTP 2FA.');
                                    this.log(`OTP ${token} đã được submit.`);
                                    await this.sleep(4000); // Wait for Google to process OTP or show error
                                } else {
                                    this.log('Không tìm thấy ô nhập 2FA trên giao diện nào phù hợp. Bỏ qua nhập tự động...');
                                }
                            } catch (e) {
                                this.log(`Lỗi khi cố gắng điền 2FA: ${e.message}`);
                            }
                        } else {
                            // Non-2FA accounts: explicitly wait for labs redirect
                            this.log('Tài khoản không có Secret 2FA. Chờ chuyển hướng thẳng...');
                            await this.sleep(3000);
                            const url = await this.page.url();
                            if (url.includes('labs.google') && !url.includes('accounts.google.com')) {
                                loginSuccess = true;
                            }
                        }

                        // Check for security challenge (manual intervention) as a fallback
                        const isChallenge = await this.page.$('#captchaimg, .g-recaptcha');
                        if (isChallenge) {
                            this.log('❗ Phát hiện Captcha/Challenge. Bạn có 3 phút gỡ Captcha thủ công!');
                        }

                        // Final wait for redirect back to labs
                        this.log('Waiting for Labs to load post-login...');

                        let postLoginLoaded = false;
                        for (let w = 0; w < 60; w++) {
                            try {
                                const isReady = await this.page.evaluate(() => {
                                    if (document.querySelector('[data-slate-editor="true"][role="textbox"]')) return true;
                                    const textNodes = Array.from(document.querySelectorAll('div, span, button'));
                                    return textNodes.some(el => el.textContent && (el.textContent.includes('Tạo bằng Flow') || el.textContent.includes('Create with Flow') || el.textContent.includes('Dự án mới') || el.textContent.includes('New Project')));
                                });

                                if (isReady) {
                                    postLoginLoaded = true;
                                    break;
                                }
                            } catch (e) {
                                // Ignore navigation errors like "Execution context was destroyed" or "frame got detached"
                            }
                            await this.sleep(1000);
                        }

                        if (!postLoginLoaded) {
                            throw new Error("Timeout waiting for post-login screens (Labs / New Project)");
                        }

                        // If we are on the landing page, click New Project or Create with Flow
                        const btnCoords = await this.page.evaluate(() => {
                            const findEl = (xpath) => document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;

                            let newProjBtn = findEl('//div[contains(text(), "Dự án mới")] | //button[contains(., "Dự án mới")] | //div[contains(text(), "New Project")] | //span[contains(text(), "Dự án mới")]');
                            if (newProjBtn) {
                                const r = newProjBtn.getBoundingClientRect();
                                return { state: "new_project", x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }

                            let createFlowBtn = findEl('//div[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "tạo bằng flow")] | //button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "tạo bằng flow")] | //div[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "create with flow")] | //a[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "create with flow")] | //a[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "tạo bằng flow")]');
                            if (createFlowBtn) {
                                const r = createFlowBtn.getBoundingClientRect();
                                return { state: "create_flow", x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }
                            return null;
                        });

                        if (btnCoords) {
                            if (btnCoords.state === "create_flow") {
                                this.log('Landing page: Clicking "Create with Flow"...');
                                await this.humanClick(this.page, btnCoords.x, btnCoords.y);
                                await this.sleep(2000);
                            } else {
                                this.log('Landing page: Clicking "New Project"...');
                                await this.humanClick(this.page, btnCoords.x, btnCoords.y);
                            }
                        }

                        // Now ensure the editor is visible
                        await this.page.waitForFunction('!!document.querySelector(\'[data-slate-editor="true"][role="textbox"]\')', { timeout: 30000, polling: 1000 });

                        this.log('Auto-login successful! Proceeding...');

                        // Inform backend to update account to hasProfile = true if necessary
                        if (this.accountData && this.accountData.id && this.automationService && this.automationService.accountManager) {
                            this.automationService.accountManager.updateAccount(this.accountData.id, { hasProfile: true });
                        }
                    } catch (autoErr) {
                        this.log('Auto-login failed or needed manual intervention: ' + autoErr.message);
                        this.log('Falling back to manual login wait (3 mins)...');
                        await this.waitForManualLogin();
                    }
                } else {
                    this.log('Login screen detected! You have 3 minutes to login manually.');
                    await this.waitForManualLogin();
                }
            } else {
                // If already logged in, simulate human scrolling
                await this.humanScroll(this.page);
            }
        } catch (e) {
            this.log(`Warning during login check: ${e.message}`);
        }
    }

    async waitForManualLogin() {
        try {
            await this.page.waitForFunction(
                '!!document.querySelector(\'[data-slate-editor="true"][role="textbox"]\')',
                { timeout: 180000, polling: 1000 }
            );
            this.log('Login successful! Proceeding...');

            // If logged in successfully, update hasProfile flag
            if (this.accountData && this.accountData.id && this.automationService && this.automationService.accountManager) {
                this.automationService.accountManager.updateAccount(this.accountData.id, { hasProfile: true });
            }
        } catch (timeoutErr) {
            this.log('Login wait timed out or browser was closed.');
            throw new Error('Manual login timeout or browser closed by Stop Auto.');
        }
    }

    getRand(base) {
        return base + Math.floor(Math.random() * 11) - 5;
    }

    async humanClick(page, x, y, options = {}) {
        if (!page) return;
        // Move mouse to randomized starting position nearby to simulate natural curve
        const startX = x + (Math.random() * 100 - 50);
        const startY = y + (Math.random() * 100 - 50);
        await page.mouse.move(startX, startY);

        // Move to target in small steps
        const steps = 4 + Math.floor(Math.random() * 4);
        for (let i = 1; i <= steps; i++) {
            const stepX = startX + (x - startX) * (i / steps);
            const stepY = startY + (y - startY) * (i / steps);
            await page.mouse.move(stepX, stepY);
            await this.sleep(Math.floor(Math.random() * 15) + 5);
        }

        // Random pause before click
        await this.sleep(Math.floor(Math.random() * 30) + 20);

        // Mousedown, random human-hold wait, Mouseup
        const button = options.button || 'left';
        await page.mouse.down({ button });
        await this.sleep(Math.floor(Math.random() * 80) + 20); // 20-100ms human hold
        await page.mouse.up({ button });
    }

    async humanScroll(page) {
        if (!page) return;
        try {
            const scrolls = 1 + Math.floor(Math.random() * 3);
            for (let i = 0; i < scrolls; i++) {
                const distance = (Math.random() * 300) - 150; // scroll up or down
                await page.mouse.wheel({ deltaY: distance });
                await this.sleep(Math.floor(Math.random() * 800) + 200);
            }
        } catch (e) {
            // Ignore scroll errors
        }
    }

    async findNodeByTextExact(page, matchesArr) {
        if (!page) return null;
        try {
            return await page.evaluate((texts) => {
                const lowerTexts = texts.map(t => t.toLowerCase());
                
                // Comprehensive clickable selector including Radix UI roles
                const CLICKABLE = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], li, a, label, span, div.button';
                
                let textMatches = [];
                
                // PASS 1: Direct text nodes on ALL elements (deepest match)
                for (const el of document.querySelectorAll('*')) {
                     if (!el.offsetParent && el.tagName !== 'BODY') continue;
                     
                     let directText = '';
                     for (let i = 0; i < el.childNodes.length; i++) {
                         if (el.childNodes[i].nodeType === Node.TEXT_NODE) {
                             directText += el.childNodes[i].textContent;
                         }
                     }
                     directText = directText.trim().toLowerCase();
                     
                     if (directText && lowerTexts.includes(directText)) {
                         textMatches.push(el);
                     }
                }
                
                // PASS 2: Google Material Icons (i.google-symbols text content)
                if (textMatches.length === 0) {
                    for (const icon of document.querySelectorAll('i.google-symbols, i[class*="google-symbols"]')) {
                        if (!icon.offsetParent) continue;
                        const iconText = (icon.textContent || '').trim().toLowerCase();
                        if (iconText && lowerTexts.includes(iconText)) {
                            textMatches.push(icon);
                        }
                    }
                }
                
                // PASS 3: Full innerText on clickable elements only
                if (textMatches.length === 0) {
                     const all = Array.from(document.querySelectorAll(CLICKABLE));
                     for (const el of all) {
                         if (!el.offsetParent) continue;
                         const t = (el.innerText || '').trim().toLowerCase();
                         if (t && lowerTexts.includes(t)) {
                             textMatches.push(el);
                         }
                     }
                }

                if (textMatches.length > 0) {
                    // Reverse loop: Radix UI portals are appended at end of <body>
                    // So the LAST matching element is most likely inside the active popup
                    for (let i = textMatches.length - 1; i >= 0; i--) {
                        const match = textMatches[i];
                        const clickable = match.closest(CLICKABLE) || match;
                        const r = clickable.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                        }
                    }
                }
                return null;
            }, matchesArr);
        } catch(e) {
            return null;
        }
    }

    async findNodeBySelector(page, selector) {
        if (!page) return null;
        try {
            return await page.evaluate((sel) => {
                const elements = document.querySelectorAll(sel);
                // Reverse loop: prioritize the last rendered component (active open popups)
                for(let i = elements.length - 1; i >= 0; i--) {
                    let el = elements[i];
                    if (el && el.offsetParent) {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                        }
                    }
                }
                return null;
            }, selector);
        } catch(e) {
            return null;
        }
    }

    /**
     * Fix #5: Click model dropdown trigger with verification.
     * Clicks the trigger, checks if Radix dropdown actually opened,
     * retries up to 2 times, then selects the target model.
     */
    async clickModelDropdownWithVerify(page, clickCoord, coords, triggerKey, modelName) {
        const MAX_RETRIES = 2;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            // Count visible menus BEFORE click (to detect NEW dropdown vs existing popup)
            const menuCountBefore = await page.evaluate(() => {
                let count = 0;
                const menus = document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]');
                for (const m of menus) {
                    const r = m.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) count++;
                }
                return count;
            }).catch(() => 0);

            await clickCoord(coords.model, triggerKey);
            await this.sleep(800);

            // Count menus AFTER click — a NEW menu means dropdown opened
            const menuCountAfter = await page.evaluate(() => {
                let count = 0;
                const menus = document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]');
                for (const m of menus) {
                    const r = m.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) count++;
                }
                return count;
            }).catch(() => 0);

            const newMenuOpened = menuCountAfter > menuCountBefore;

            if (newMenuOpened) {
                this.log(`Model dropdown verified open (attempt ${attempt + 1}). Menus: ${menuCountBefore} → ${menuCountAfter}`);
                break;
            } else if (attempt < MAX_RETRIES) {
                this.log(`⚠️ Model dropdown not detected (menus: ${menuCountBefore} → ${menuCountAfter}). Retrying (${attempt + 1}/${MAX_RETRIES})...`);
                await this.humanClick(page, this.getRand(150), this.getRand(400));
                await this.sleep(500);
            } else {
                this.log(`⚠️ Model dropdown failed to open after ${MAX_RETRIES + 1} attempts. Proceeding anyway...`);
            }
        }

        // Select the model item
        await clickCoord(coords.model, modelName);
        await this.sleep(600);
    }

    async uploadImages(page, rawImagePaths) {
        if (!rawImagePaths || !Array.isArray(rawImagePaths)) return;

        // 1. Filter robustly
        const validPaths = [];
        for (const p of rawImagePaths) {
            if (p && typeof p === 'string') {
                // Loại bỏ ký tự ẩn (như Left-to-Right mark \u202A hay xuất hiện khi copy từ Windows Explorer) và dấu nháy kép
                const cleanPath = p.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '').replace(/^["']|["']$/g, '').trim();
                let exists = false;
                try {
                    exists = fs.existsSync(cleanPath);
                } catch (e) { }

                if (cleanPath && exists) {
                    validPaths.push(cleanPath);
                } else if (cleanPath || p.trim()) {
                    this.log(`⚠️ Bỏ qua file ảnh không tồn tại ở đường dẫn: ${cleanPath || p}`);
                }
            }
        }

        // Limit to 3 max
        const pathsToUpload = validPaths.slice(0, 3);

        if (pathsToUpload.length === 0) {
            this.log('Không có ảnh hợp lệ nào. Bỏ qua bước upload.');
            return;
        }

        this.log(`Bắt đầu xử lý tải lên ${pathsToUpload.length} ảnh cho mode IN2V/I2V...`);
        let uploadSuccess = false;

        // Fallback to UI clicks
        this.log('Chuyển sang luồng giả lập click nút (+)...');

        // Tìm nút + đính kèm ảnh bằng cách khoanh vùng ô nhập lệnh (Editor)
        let plusBtnCoords = await page.evaluate(() => {
            const getCenter = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                return null;
            };

            // Ưu tiên 1: Tìm vùng nhập lệnh (Prompt Editor)
            const editor = document.querySelector('.ql-editor, [data-slate-editor="true"], textarea, [contenteditable="true"]');
            if (editor) {
                // Đi ngược lên DOM tree để lấy nguyên block giao diện của Editor
                const container = editor.closest('form, div[role="search"], [class*="chat"], [class*="input"], [class*="bottom"], div[style*="border-radius"]') || editor.parentElement.parentElement.parentElement;

                if (container) {
                    const btns = Array.from(container.querySelectorAll('button, [role="button"]'));

                    // Tìm nút tải lên/đính kèm
                    const explicitBtn = btns.find(b => {
                        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                        return aria.includes('tải lên') || aria.includes('upload') || aria.includes('đính kèm') || aria.includes('attach');
                    });
                    if (explicitBtn) return getCenter(explicitBtn);

                    // Tìm nút có icon +
                    const iconBtn = btns.find(b => {
                        const hasPlusSvg = b.querySelector('svg path[d*="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"]');
                        const hasGoogleIconPlus = Array.from(b.querySelectorAll('i, span, div.google-symbols')).some(el => {
                            const txt = el.textContent.trim();
                            return txt === 'add' || txt === 'attach_file';
                        });
                        return hasPlusSvg || hasGoogleIconPlus;
                    });
                    if (iconBtn) return getCenter(iconBtn);

                    // Trả về nút icon đầu tiên trong thanh công cụ
                    const firstBtn = btns.find(b => getCenter(b) !== null);
                    if (firstBtn) return getCenter(firstBtn);
                }
            }

            // Ưu tiên 2: Fallback tìm kiếm toàn bộ màn hình nếu không thấy Editor
            const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
            const attachBtn = allBtns.find(b => {
                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                const isMatch = aria.includes('tải lên') || aria.includes('upload') || aria.includes('đính kèm') || aria.includes('attach');
                if (!isMatch) return false;

                const r = b.getBoundingClientRect();
                const isOnScreenBottom = r.y > (window.innerHeight - 300); // Ép sát đáy màn hình để tránh lọt nút ở dải History (y = 1010 có thể là dải giữa của màn 4K)
                return isOnScreenBottom;
            });

            if (attachBtn) return getCenter(attachBtn);
            return null;
        });

        if (plusBtnCoords) {
            this.log(`Tìm thấy nút Thêm (+). Đang click tại tọa độ ${plusBtnCoords.x}, ${plusBtnCoords.y}`);
            await this.humanClick(page, plusBtnCoords.x, plusBtnCoords.y);
            await this.sleep(1500);

            // Chỉ dùng FileChooser (Native OS dialog) để ép trình duyệt load đúng luồng đính kèm ảnh của Editor
            // Không tiêm "uploadFile" vào các thẻ DOM mù quáng để tránh bị nhảy ra màn hình to
            const [fileChooser] = await Promise.all([
                page.waitForFileChooser({ timeout: 10000 }).catch(() => null),
                page.evaluate(() => {
                    const items = Array.from(document.querySelectorAll('div[role="menuitem"], li, button, span'));
                    const uploadOpt = items.find(el => {
                        const t = el.innerText.trim().toLowerCase();
                        return t === 'tải hình ảnh lên' || t === 'upload image' || t.includes('tải lên') || t.includes('tải hình ảnh');
                    });
                    if (uploadOpt) {
                        uploadOpt.click();
                        return true;
                    }
                    return false;
                }).catch(() => false)
            ]);

            if (fileChooser) {
                this.log('Gọi được File Chooser native của trình duyệt, đã đúng luồng đính kèm ảnh.');
                await fileChooser.accept(pathsToUpload);
                uploadSuccess = true;
            } else {
                // FIX 3a: Throw thay vì chỉ warning — ảnh là bắt buộc cho IN2V/I2V jobs
                this.log('⚠️ Không mở được File Chooser (Có thể Google Veo đổi chữ trên nút, hoặc menu chưa mở).');
                throw new Error('IMAGE_UPLOAD_FAILED: FileChooser did not open. Cannot upload required image.');
            }
        } else {
            this.log('Không tìm thấy nút (+) để upload ảnh! Bỏ qua ảnh...');
        }

        if (uploadSuccess) {
            this.log(`Đã gửi ${pathsToUpload.length} file vào UI. Bắt đầu chờ tải lên hoàn tất (Tối đa 40s)...`);

            const uploadWaitStart = Date.now();
            let looksDone = false;
            let errorMsg = null;

            while (Date.now() - uploadWaitStart < 40000) {
                const checkRes = await page.evaluate(() => {
                    // 1. Kiểm tra LỖI CHÍNH SÁCH / BẢN QUYỀN (Snackbar, Alert, Dialog)
                    const alerts = Array.from(document.querySelectorAll('[role="alert"], [class*="snackbar"], snack-bar, [role="alertdialog"], .msg, .error'));
                    for (let a of alerts) {
                        const t = (a.innerText || "").toLowerCase();
                        if (a.offsetParent !== null && t.length > 5) { // Visible alert
                            if (t.includes('vi phạm') || t.includes('chính sách') || t.includes('policy') ||
                                t.includes('cấm') || t.includes('không thể tải lên') || t.includes('could not upload') ||
                                t.includes('unsupported') || t.includes('error') || t.includes('lỗi')) {
                                return { status: 'error', message: a.innerText.trim() };
                            }
                        }
                    }

                    // 2. Tìm khu vực upload của khung Editor
                    const editorContainer = document.querySelector('[data-slate-editor="true"][role="textbox"]')?.closest('div[style*="border-radius"]') || document.querySelector('[data-slate-editor="true"][role="textbox"]')?.parentElement?.parentElement || document.body;

                    // 3. Đang Upload %?
                    const texts = Array.from(editorContainer.querySelectorAll('span, div, p'));
                    const hasProgress = texts.some(el => {
                        const t = el.innerText.trim();
                        return t.endsWith('%') && t.length > 1 && t.length <= 4 && !isNaN(parseInt(t));
                    });

                    if (hasProgress) return { status: 'uploading' };

                    // 4. Có Thumbnail chip (Ảnh đúng chỗ) chưa?
                    const mediaEls = Array.from(editorContainer.querySelectorAll('img, canvas'));
                    const validThumbnails = mediaEls.filter(el => {
                        const r = el.getBoundingClientRect();
                        return r.width > 20 && r.height > 20 && el.offsetParent !== null && !el.src.includes('avatar');
                    });

                    if (validThumbnails.length > 0) return { status: 'ready' };

                    return { status: 'waiting' };
                });

                if (checkRes.status === 'error') {
                    errorMsg = checkRes.message;
                    break; // Thoát đợi luôn
                } else if (checkRes.status === 'ready') {
                    looksDone = true;
                    this.log('Quá trình tải lên ảnh (Thumbnail đính kèm) đã thành công!');
                    break;
                } else if (checkRes.status === 'uploading') {
                    // Keep waiting (silently)
                }

                // Nếu bị báo lỗi vi phạm nhưng dưới dạng tooltips / icon chấm đỏ sát bức ảnh... 
                // thì có thể chờ hết 40 giây. Cái đó bắt sau nếu gặp. Hiện tại bắt text alert.
                await this.sleep(1500);
            }

            if (errorMsg) {
                this.log(`⚠️ PHÁT HIỆN LỖI CHÍNH SÁCH / UPLOAD TỪ UI: "${errorMsg}"`);
                // Nếu báo lỗi, bóp nát luồng này bằng Error để Orchestrator nhặt, đánh Failed Job và tiếp tục.
                throw new Error("IMAGE_VIOLATION_OR_ERROR: " + errorMsg);
            }

            if (!looksDone) {
                this.log('⚠️ Hết timeout 40s tải ảnh định kèm. Thumbnail không xuất hiện. Cứ ép luồng chạy tiếp có thể ảnh lỗi nặng...');
            } else {
                this.log('Đang chờ thêm 12 giây để Google xử lý file ảnh trên server trước khi cho phép bấm Submit...');
                await this.sleep(12000); // Buffer for UI to fully settle and Google to register the uploaded blob
            }
        }
    }

    async uploadI2VFrames(page, startImagePath, endImagePath) {
        this.log(`Bắt đầu quy trình upload I2V Frames...`);
        const cleanStart = startImagePath ? startImagePath.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '').replace(/^["']|["']$/g, '').trim() : null;
        const cleanEnd = endImagePath ? endImagePath.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '').replace(/^["']|["']$/g, '').trim() : null;

        const uploadBox = async (path, keywords) => {
            if (!path || !fs.existsSync(path)) {
                this.log(`⚠️ Bỏ qua frame (${keywords.join('/')}) vì file không tồn tại: ${path}`);
                return;
            }
            this.log(`Tìm ô "${keywords[0]}" để tải lên frame...`);
            
            let boxCoords = await page.evaluate((kwList) => {
                const getCenter = (r) => { return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
                const isVisible = (el) => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
                };
                
                const allEls = Array.from(document.querySelectorAll('button, div[role="button"], div[role="presentation"], span'));
                for (let el of allEls) {
                     if (!isVisible(el)) continue;
                     const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                     const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                     
                     for (let kw of kwList) {
                         if (text.includes(kw) || aria.includes(kw)) {
                             const r = el.getBoundingClientRect();
                             if (r.width > 30 && r.height > 30 && r.width < 500) {
                                 return getCenter(r);
                             }
                         }
                     }
                }
                return null;
            }, keywords);

            if (boxCoords) {
                this.log(`Đã tìm thấy ô chứa keyword "${keywords[0]}" tại [${boxCoords.x}, ${boxCoords.y}]. Đang click...`);
                let attempts = 0;
                let uploaded = false;
                
                while(attempts < 2 && !uploaded) {
                    attempts++;
                    await this.humanClick(page, boxCoords.x, boxCoords.y);
                    await this.sleep(1500);

                    const [fileChooser] = await Promise.all([
                        page.waitForFileChooser({ timeout: 5000 }).catch(() => null),
                        page.evaluate(() => {
                            const items = Array.from(document.querySelectorAll('div[role="menuitem"], li, button, span'));
                            const uploadOpt = items.find(el => {
                                const t = el.innerText.trim().toLowerCase();
                                return t === 'tải hình ảnh lên' || t === 'upload image' || t.includes('tải lên') || t.includes('tải hình ảnh');
                            });
                            if (uploadOpt) {
                                uploadOpt.click();
                                return true;
                            }
                            return false;
                        }).catch(() => false)
                    ]);

                    if (fileChooser) {
                        await fileChooser.accept([path]);
                        this.log(`✅ Đã đính kèm ảnh: ${path}`);
                        await this.sleep(3000); // Chờ UI upload
                        uploaded = true;
                    } else {
                        boxCoords.x += 10;
                        boxCoords.y += 10;
                        this.log(`⚠️ Không mở được File Chooser lần ${attempts}. Thử lại...`);
                    }
                }
                // FIX 3b: Throw nếu vẫn không upload được sau 2 lần thử
                if (!uploaded) {
                    throw new Error(`IMAGE_UPLOAD_FAILED: Could not upload frame "${keywords[0]}" after 2 attempts.`);
                }
            } else {
                this.log(`❌ Không tìm thấy ô chứa keyword "${keywords[0]}" trên giao diện.`);
            }
        };

        if (cleanStart) {
            await uploadBox(cleanStart, ['bắt đầu', 'start', 'khung hình đầu']);
        }

        if (cleanEnd) {
            await uploadBox(cleanEnd, ['kết thúc', 'end', 'khung hình cuối']);
        }

        this.log('Chờ 10 giây để hoàn tất xử lý UI cho I2V frames...');
        await this.sleep(10000);
    }

    async close() {
        this.log('Closing browser instance...');
        this.isOffline = true;
        this.isBusy = false;

        let browserPid = null;
        if (this.browser) {
            try {
                const childProcess = this.browser.process();
                if (childProcess) {
                    browserPid = childProcess.pid;
                }
                await this.browser.close();
            } catch (e) { }
            this.browser = null;
            this.page = null;
        }

        // Extremely aggressive cleanup: Force kill the browser's process tree perfectly guaranteeing no locks (like chrome-err.log) remain
        if (browserPid) {
            try {
                require('child_process').execSync(`taskkill /F /T /PID ${browserPid}`, { stdio: 'ignore' });
            } catch (killErr) { }
        }

        // --- SHADOW PROFILE TRASH COLLECTION ---
        // NẾU ĐÂY LÀ LUỒNG ĐẺ FILE TẠM, PHẢI XÓA BỎ CHÚNG ĐỂ CỨU SSD!
        if (this.isShadowProfile && this.profilePath) {
            const profileToDelete = path.dirname(this.profilePath);

            // Kill ALL processes that have this folder path in their command line
            if (process.platform === 'win32') {
                try {
                    // Use WMIC for more reliable process matching
                    const folderName = path.basename(profileToDelete).replace(/'/g, "''");
                    require('child_process').execSync(
                        `wmic process where "CommandLine like '%${folderName}%'" call terminate`,
                        { stdio: 'ignore', timeout: 10000 }
                    );
                } catch (e) { }

                // Also try taskkill for crashpad specifically
                try {
                    require('child_process').execSync(
                        `taskkill /F /IM crashpad_handler.exe 2>nul`,
                        { stdio: 'ignore', timeout: 5000 }
                    );
                } catch (e) { }
            }

            // Wait 5 seconds for all file handles to release
            await this.sleep(5000);

            // Aggressive retry loop with increasing delays
            for (let retry = 0; retry < 8; retry++) {
                try {
                    if (!fs.existsSync(profileToDelete)) {
                        this.log(`[Shadow Cleanup] Folder đã được xóa.`);
                        break;
                    }
                    await fs.promises.rm(profileToDelete, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
                    this.log(`[Shadow Cleanup] Xóa Folder Clone thành công: ${path.basename(profileToDelete)}`);
                    break;
                } catch (e) {
                    if (retry < 7) {
                        const delay = (retry + 1) * 3000; // 3s, 6s, 9s, 12s...
                        this.log(`[Shadow Cleanup] File bị khóa, thử lại sau ${delay / 1000}s (${retry + 1}/8)...`);
                        await this.sleep(delay);
                    } else {
                        this.log(`[Shadow Cleanup] Thất bại sau 8 lần thử. Sẽ dọn lần chạy sau: ${e.message}`);
                    }
                }
            }
        }
    }

    async processJob(jobData, outputDir) {
        this.isBusy = true;
        await this.orchestrator.runMediaJob(jobData, outputDir);
        // Do NOT set this.isBusy = false here! The Orchestrator (automation.js) 
        // handles the resting period and will mark it false after the random delay.
    }

    async _internalProcessJob(job, outputDir) {
        const isDebug = process.env.LOG_LEVEL === 'debug';
        let heartbeatInterval = setInterval(() => {
            if (this.isBusy) {
                const uptimeMs = Date.now() - this.startTime;
                const idleMs = Date.now() - this.lastActionTime;
                const uptimeStr = new Date(uptimeMs).toISOString().substring(11, 19);

                if (isDebug) {
                    console.log(`[HEARTBEAT Worker ${this.id}] Job: ${job.JOB_ID || 'Unknown'} | Uptime: ${uptimeStr} | Idle: ${Math.floor(idleMs / 1000)}s | Step: ${this.currentStep}`);
                }

                if (idleMs > 60000 && !this.currentStep.includes('Waiting up to')) {
                    this.io.emit('log', `[Worker ${this.id}] ⚠️ WARN: Worker idle for ${Math.floor(idleMs / 1000)}s! Step: ${this.currentStep}`);
                }
            }
        }, 10000);

        // Global Pause Check start
        while (this.automationService && this.automationService.isPaused) {
            this.log('Automation Paused. Worker waiting...');
            await this.sleep(3000);
        }

        const tempOutputDir = path.join(outputDir, `temp_${this.id}`);
        if (fs.existsSync(tempOutputDir)) {
            fs.rmSync(tempOutputDir, { recursive: true, force: true });
        }
        fs.mkdirSync(tempOutputDir, { recursive: true });

        try {
            if (!this.page) await this.launch();
            const page = this.page;

            // Enforce download path directly to tempOutputDir via CDP
            try {
                this.log(`Setting download path to: ${tempOutputDir}`);
                const client = await page.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: tempOutputDir
                });
            } catch (cdpErr) {
                this.log(`Failed to set CDP download path: ${cdpErr.message}`);
            }

            this.log('Resetting state for new job...');
            let url = await page.url();
            let navigated = false;
            let retries = 0;

            while (!url.includes('https://labs.google/fx/vi/tools/flow') && retries < 3) {
                this.log(`Navigating to Veo3 (Attempt ${retries + 1}/3)...`);
                try {
                    await page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'domcontentloaded', timeout: 20000 });
                    await page.waitForFunction('document.readyState === "complete" || document.readyState === "interactive"', { timeout: 10000 });
                    navigated = true;
                } catch (navErr) {
                    this.log(`Navigation error: ${navErr.message}`);
                }
                await this.sleep(3000);
                url = await page.url();
                retries++;
            }

            if (url.includes('accounts.google.com') || url.includes('signin') || url.includes('AccountChooser')) {
                this.log('Login redirect detected. Attempting to restore session...');

                await this.handleLoginWait();

                let currentUrl = await page.url();
                if (!currentUrl.includes('labs.google')) {
                    throw new Error('Timeout or failure during session restore.');
                } else {
                    this.log('Login restored successfully. Resuming job...');
                    url = currentUrl;
                    navigated = true;
                }
            }

            if (!url.includes('https://labs.google/fx/vi/tools/flow')) {
                throw new Error(`Browser failed to navigate. Stuck at: ${url}`);
            }
            if (navigated) {
                this.settingsApplied = false;
                // this.viewModeApplied = false; // View mode persists across F5 reloads
            }

            // Quick check for dropped session modal before proceeding
            await this.checkAndRecoverSession();

            // If we are stuck on the homepage, click "Dự án mới" (New Project) or "Create with Flow"
            this.log('Waiting for Initial UI to load...');
            const editorSelectors = [
                '[data-slate-editor="true"][role="textbox"]',
                'div[contenteditable="true"]',
                'div.cm-content[contenteditable="true"]'
            ];

            try {
                let foundUI = false;
                for (let i = 0; i < 3; i++) {
                    await this.checkAndRecoverSession();
                    try {
                        foundUI = await page.waitForFunction((selectors) => {
                            for (let sel of selectors) {
                                if (document.querySelector(sel)) return true;
                            }
                            const text = document.body.innerText || '';
                            return text.includes('Dự án mới') || text.includes('New Project') || text.includes('Tạo bằng Flow') || text.includes('Create with Flow');
                        }, { timeout: 5000 }, editorSelectors);
                        if (foundUI) break;
                    } catch (innerErr) { }
                }
            } catch (e) {
                this.log('Timeout waiting for Initial UI.');
            }

            let inputVisible = false;
            let foundSelector = null;
            for (let sel of editorSelectors) {
                inputVisible = await page.$(sel);
                if (inputVisible) {
                    foundSelector = sel;
                    break;
                }
            }

            if (!inputVisible) {
                this.log('Text area not found. Looking for "New Project" or "Create with Flow"...');

                let btnCoords = await page.evaluate(() => {
                    const allEls = Array.from(document.querySelectorAll('button, a, span, div'));

                    // Helper to get exactly matching text on button-sized elements
                    const findExact = (texts) => {
                        for (let el of allEls) {
                            const t = (el.innerText || el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
                            if (texts.includes(t) || texts.some(tx => t.includes(tx) && t.length < tx.length + 10)) {
                                const r = el.getBoundingClientRect();
                                // Filter out massive layout containers. A realistic button won't be wider than 400px or taller than 150px.
                                if (r.width > 0 && r.height > 0 && r.width < 400 && r.height < 150) {
                                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                                }
                            }
                        }
                        return null;
                    };

                    const createFlow = findExact(['tạo bằng flow', 'create with flow', '+ tạo bằng flow', '+ create with flow']);
                    if (createFlow) return { state: "create_flow", ...createFlow };

                    const newProject = findExact(['dự án mới', '+ dự án mới', 'new project', '+ new project']);
                    if (newProject) return { state: "new_project", ...newProject };

                    return null;
                });

                if (btnCoords && btnCoords.state === "create_flow") {
                    this.log('Clicking "Create with Flow". Waiting to click "New Project"...');
                    await this.humanClick(page, btnCoords.x, btnCoords.y);
                    await this.sleep(2000);
                    const newProjCoords = await page.evaluate(() => {
                        const allEls = Array.from(document.querySelectorAll('button, a, span, div'));
                        for (let el of allEls) {
                            const t = (el.innerText || el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
                            const texts = ['dự án mới', '+ dự án mới', 'new project', '+ new project'];
                            if (texts.includes(t) || texts.some(tx => t.includes(tx) && t.length < tx.length + 10)) {
                                const r = el.getBoundingClientRect();
                                if (r.width > 0 && r.height > 0 && r.width < 400 && r.height < 150) {
                                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                                }
                            }
                        }
                        return null;
                    });
                    if (newProjCoords) {
                        await this.humanClick(page, newProjCoords.x, newProjCoords.y);
                    }
                } else if (btnCoords && btnCoords.state === "new_project") {
                    this.log('Clicking "New Project".');
                    await this.humanClick(page, btnCoords.x, btnCoords.y);
                }

                await this.sleep(3000);
            }

            const prompt = job.PROMPT;

            // 1. Switch Mode

            // Coordinate Map from User UI Recorder
            // LƯU Ý: NẾU MUỐN SỬ DỤNG TỌA ĐỘ CỐ ĐỊNH CHO CÁC NÚT TRONG BẢNG CÀI ĐẶT, 
            // BẠN PHẢI GHI LẠI TỌA ĐỘ LÚC BẢNG CÀI ĐẶT ĐÃ MỞ VÀ HIỂN THỊ Ở GIỮA MÀN HÌNH!
            // Coordinate Map from User UI Recorder V3
            // Dynamic DOM Map
            const coords = {
                modes: {
                    'T2V': { type: 'text', value: ['videocam', 'Video', 'Tạo'] },
                    'IN2V': { type: 'text', value: ['crop_free', 'Ingredients', 'Thành phần'] },
                    'I2V': { type: 'text', value: ['chrome_extension', 'Frames', 'Khung hình'] },
                    'IMG': { type: 'text', value: ['image', 'Image', 'Ảnh'] },
                    trigger_create_menu: { type: 'selector', value: 'button[aria-haspopup="menu"]:has(div[data-type="button-overlay"]):not(:has(span))' }
                },
                ratioVideo: {
                    'Ngang': { type: 'text', value: ['crop_16_9', '16:9', 'Ngang'] },
                    'Dọc': { type: 'text', value: ['crop_9_16', '9:16', 'Dọc'] }
                },
                ratioImage: {
                    '16:9': { type: 'text', value: ['crop_16_9', '16:9'] },
                    '9:16': { type: 'text', value: ['crop_9_16', '9:16'] },
                    '1:1': { type: 'text', value: ['crop_square', '1:1'] },
                    '4:3': { type: 'text', value: ['crop_landscape', '4:3'] },
                    '3:4': { type: 'text', value: ['crop_portrait', '3:4'] }
                },
                countVideo: {
                    '1': { type: 'text', value: ['x1', '1'] },
                    '2': { type: 'text', value: ['x2', '2'] },
                    '3': { type: 'text', value: ['x3', '3'] },
                    '4': { type: 'text', value: ['x4', '4'] }
                },
                countImage: {
                    '1': { type: 'text', value: ['x1', '1'] },
                    '2': { type: 'text', value: ['x2', '2'] },
                    '3': { type: 'text', value: ['x3', '3'] },
                    '4': { type: 'text', value: ['x4', '4'] }
                },
                durationVideo: {
                    '4s': { type: 'text', value: ['4s'] },
                    '6s': { type: 'text', value: ['6s'] },
                    '8s': { type: 'text', value: ['8s'] }
                },
                model: {
                    trigger_video: { type: 'text', value: ['Veo 3.1 - Lite [Lower Priority]', 'Veo 3.1 - Lite', 'Veo 3.1 - Fast', 'Veo'] },
                    trigger_image: { type: 'text', value: ['Nano Banana Pro', 'nano banana 2', 'Imagen 3'] },
                    'Veo 3.1 - Lite [Lower Priority]': { type: 'text', value: ['Veo 3.1 - Lite [Lower Priority]'] },
                    'Veo 3.1 - Fast': { type: 'text', value: ['Veo 3.1 - Fast'] },
                    'Nano Banana Pro': { type: 'text', value: ['🍌 Nano Banana Pro', 'Nano Banana Pro'] },
                    'nano banana 2': { type: 'text', value: ['🍌 Nano Banana 2', 'nano banana 2'] }
                },
                submitBtn: { type: 'text', value: ['arrow_forward'] }, // From recorder
                viewMode: {
                    trigger: { type: 'text', value: ['settings_2'] },
                    batch: { type: 'selector', value: 'button[aria-label="Theo nhóm"], button[aria-label="Batch"]' }, // Override for safety since original is "Theo nhóm" but wait, the recorder got selector "button[aria-label="Theo nhóm"]", great!
                    size_S: { type: 'text', value: ['S'] },
                    sound_off: { type: 'text', value: ['Âm thanh khi di chuột', 'Sound'] },
                    return_silent: { type: 'text', value: ['Return silent videos'] },
                    info_on: { type: 'text', value: ['Hiện thông tin chi tiết về ô', 'Show info'] },
                    clear_off: { type: 'text', value: ['Xoá câu lệnh sau khi gửi', 'Clear prompt'] }
                }
            };

            const clickDynamicNode = async (map, key) => {
                if (!key || !map) return false;
                const c = map[key];
                if (!c) return false;
                let coordsXY = null;
                if (c.type === 'text') {
                    coordsXY = await this.findNodeByTextExact(page, c.value);
                } else if (c.type === 'selector') {
                    coordsXY = await this.findNodeBySelector(page, c.value);
                }
                
                if (coordsXY) {
                    await this.humanClick(page, coordsXY.x, coordsXY.y);
                    await this.sleep(400); 
                    return true;
                } else {
                    this.log(`⚠️ Lỗi DOM Scan: Không tìm thấy phần tử cho [${key}]`);
                    return false;
                }
            };

            const applyViewMode = async () => {
                await this.sleep(3000);
                this.log("Applying View Mode for the first time on this browser via DOM Scan...");
                await clickDynamicNode(coords.viewMode, 'trigger'); await this.sleep(1500);
                await clickDynamicNode(coords.viewMode, 'batch'); 
                await clickDynamicNode(coords.viewMode, 'size_S');
                await clickDynamicNode(coords.viewMode, 'sound_off');
                await clickDynamicNode(coords.viewMode, 'return_silent');
                await clickDynamicNode(coords.viewMode, 'info_on');
                await clickDynamicNode(coords.viewMode, 'clear_off');

                // Close View Mode Panel
                await this.humanClick(page, this.getRand(150), this.getRand(788));
                await this.sleep(1000);

                // Explicitly click IN2V mode to prevent UI glitches later
                this.log("First time setup: explicitly switching to IN2V mode to match view mode settings...");
                await clickDynamicNode(coords.modes, 'trigger_create_menu'); await this.sleep(1000);
                await clickDynamicNode(coords.modes, 'IN2V'); await this.sleep(1500);
                await this.humanClick(page, this.getRand(150), this.getRand(788)); // Close menu
                
                this.viewModeApplied = true;
            };

            // Hoist settings variables for use both inside try and after catch/finally
            const settings = job.settings || {};
            const isImg = job.TYPE_VIDEO === 'IMG';
            const currentSettings = isImg ? settings.imgSettings : settings.videoSettings;

            try {
                // 0. Wait for Prompt Box to ensure page is loaded
                const fallbackSelectors = [
                    '[data-slate-editor="true"][role="textbox"]',
                    'div[contenteditable="true"]',
                    'div.cm-content[contenteditable="true"]'
                ];
                let editorSelector = null;

                try {
                    editorSelector = await page.waitForFunction((selectors) => {
                        for (let sel of selectors) {
                            if (document.querySelector(sel)) return sel;
                        }
                        return null;
                    }, { timeout: 10000 }, fallbackSelectors);

                    editorSelector = await editorSelector.jsonValue();
                } catch (e) {
                    this.log(`Failed to find text area: ${e.message}`);
                    throw new Error("Text area not found. Is login required?");
                }

                if (!this.viewModeApplied) {
                    await applyViewMode();
                }

                // Close any potentially open popup menus first by clicking empty space
                await this.humanClick(page, this.getRand(150), this.getRand(788));
                await this.sleep(500);

                let cleanPrompt = prompt.replace(/--ar\s+\d+[:-]\d+/gi, '').replace(/--ar \d+\/\d+/gi, '').trim();
                const currentSettingsString = JSON.stringify(currentSettings);

                // 2. Open Create Menu and switch Mode + Settings (DO THIS FIRST BEFORE PROMPT)
                this.log(`Opening Create Menu via DOM Scan...`);
                await clickDynamicNode(coords.modes, 'trigger_create_menu');
                await this.sleep(1500);

                if (coords.modes[job.TYPE_VIDEO]) {
                    this.log(`Selecting Mode Tab: ${job.TYPE_VIDEO}`);
                    await clickDynamicNode(coords.modes, job.TYPE_VIDEO);
                    await this.sleep(1500);

                    // Apply settings if needed
                    if (currentSettings && (!this.settingsApplied || this.lastAppliedSettingsString !== currentSettingsString)) {
                        this.log(`Applying specific settings for ${job.TYPE_VIDEO}...`);

                        const clickCoord = async (map, key) => {
                            await clickDynamicNode(map, key);
                            await this.sleep(600); // Extra sleep here matches old behavior
                        };

                        if (isImg) {
                            await clickCoord(coords.ratioImage, currentSettings.ratio);
                            await clickCoord(coords.countImage, currentSettings.count?.toString());
                            if (currentSettings.model) {
                                await this.clickModelDropdownWithVerify(page, clickCoord, coords, 'trigger_image', currentSettings.model);
                            }
                        } else {
                            let ratioKey = currentSettings.ratio;
                            if (ratioKey === '16:9') ratioKey = 'Ngang';
                            if (ratioKey === '9:16') ratioKey = 'Dọc';

                            await clickCoord(coords.ratioVideo, ratioKey);
                            await clickCoord(coords.countVideo, currentSettings.count?.toString());
                            
                            // Mặc định ép chọn 8 giây cho mọi Video
                            await clickCoord(coords.durationVideo, '8s');

                            if (currentSettings.model) {
                                await this.clickModelDropdownWithVerify(page, clickCoord, coords, 'trigger_video', currentSettings.model);
                            }
                        }

                        this.settingsApplied = true;
                        this.lastAppliedSettingsString = currentSettingsString;
                    } else {
                        this.log(`Settings generation skipped (Already configured for ${job.TYPE_VIDEO}).`);
                    }
                } else {
                    this.log(`Warning: Mode ${job.TYPE_VIDEO} not found in map.`);
                }

                // Close Menu
                this.log("Closing settings menu...");
                await this.humanClick(page, this.getRand(150), this.getRand(788));
                await this.sleep(1500);

                // 3. Input Prompt (DO THIS AFTER SETTINGS SO IT DOESN'T GET CLEARED)
                this.log(`Clicking and focusing text area...`);
                // Click the editor directly
                await page.click(editorSelector);
                await this.sleep(200);

                // Also click the placeholder just to be absolutely sure the cursor is exactly on the text
                try {
                    const placeholder = await page.$('[data-slate-placeholder="true"]');
                    if (placeholder) {
                        await placeholder.click();
                        await this.sleep(200);
                    }
                } catch (e) { }

                // Clear old text by clicking the X (Xoá câu lệnh) button inside the text area
                this.log('Clearing editor content via X button...');
                const cleared = await page.evaluate(() => {
                    // The X button contains either:
                    // 1. A <i class="google-symbols"> with text "close"
                    // 2. A hidden <span> with text "Xoá câu lệnh"
                    const allBtns = Array.from(document.querySelectorAll('button'));
                    for (const btn of allBtns) {
                        const spans = Array.from(btn.querySelectorAll('span'));
                        const hasXLabel = spans.some(s => s.textContent.trim() === 'Xoá câu lệnh');
                        const googleIcon = btn.querySelector('i.google-symbols, i[class*="google-symbols"]');
                        const hasCloseIcon = googleIcon && googleIcon.textContent.trim() === 'close';
                        if (hasXLabel || hasCloseIcon) {
                            const r = btn.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {
                                btn.click();
                                return true;
                            }
                        }
                    }
                    return false;
                });

                if (cleared) {
                    this.log('Editor cleared via X button.');
                } else {
                    this.log('X button not found (text area may already be empty).');
                }
                await this.sleep(1000);

                // 3.5 PRE-FLIGHT CHECK: Did the X button actually disappear?
                const xStillExists = await page.evaluate(() => {
                    const allBtns = Array.from(document.querySelectorAll('button'));
                    for (const btn of allBtns) {
                        const spans = Array.from(btn.querySelectorAll('span'));
                        const hasXLabel = spans.some(s => s.textContent.trim() === 'Xoá câu lệnh' || (s.textContent.trim().toLowerCase() === 'clear prompt'));
                        const googleIcon = btn.querySelector('i.google-symbols, i[class*="google-symbols"]');
                        if (hasXLabel || (googleIcon && googleIcon.textContent.trim() === 'close')) {
                            const r = btn.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) return true;
                        }
                    }
                    return false;
                });

                if (xStillExists) {
                    this.log('ERROR: Prompt box failed to clear! The X button is still visible. Forcing a reload to prevent duplicate renders...');
                    await page.reload({ waitUntil: 'networkidle2' });
                    this.settingsApplied = false;
                    this.viewModeApplied = false;
                    throw new Error("PROMPT_JAM: Prompt failed to clear. Reloading page.");
                }

                this.log(`Pasting prompt instantly (Length: ${cleanPrompt.length}) via CDP...`);

                // Use Chrome DevTools Protocol to simulate a raw text paste without touching the OS clipboard
                const client = await page.target().createCDPSession();
                await client.send('Input.insertText', { text: cleanPrompt });
                await client.detach();

                await this.sleep(1000);

                // 4. Upload Images (DO THIS AFTER PROMPT SO UI STATE IS STABLE)
                if (job.TYPE_VIDEO === 'IN2V') {
                    const rawPaths = [job.IMAGE_PATH, job.IMAGE_PATH_2, job.IMAGE_PATH_3];
                    await this.uploadImages(page, rawPaths);
                } else if (job.TYPE_VIDEO === 'I2V') {
                    await this.uploadI2VFrames(page, job.IMAGE_PATH, job.IMAGE_PATH_2);
                }

                // 4. Generate
                if (this.automationService && this.automationService.requestSubmitLock && this.automationService.workerCount > 3) {
                    this.log('Requesting Global Submit Lock to prevent rate limiting...');
                    await this.automationService.requestSubmitLock(this.id);
                }

                this.log('Attempting Submit via DOM Scan (arrow_forward icon)...');

                let clicked = false;

                // Phương pháp 1: Dùng clickDynamicNode với coords.submitBtn (arrow_forward)
                try {
                    clicked = await clickDynamicNode(coords, 'submitBtn');
                } catch (e) {
                    this.log(`Submit via coords.submitBtn failed: ${e.message}`);
                }

                // Phương pháp 2: Fallback — tìm nút gửi gần editor bằng DOM scan
                if (!clicked) {
                    this.log('Fallback: Searching submit button near editor...');
                    try {
                        const fallbackCoords = await page.evaluate((selector) => {
                            const editor = document.querySelector(selector);
                            if (!editor) return null;
                            const container = editor.closest('div[style*="border-radius"], div[class*="container"]') || editor.parentElement?.parentElement;
                            if (!container) return null;
                            // Tìm icon arrow_forward bên trong container
                            const icons = container.querySelectorAll('i.google-symbols, i[class*="google-symbols"]');
                            for (const icon of icons) {
                                if ((icon.textContent || '').trim() === 'arrow_forward') {
                                    const btn = icon.closest('button') || icon;
                                    const r = btn.getBoundingClientRect();
                                    if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                                }
                            }
                            // Fallback: nút cuối cùng có SVG trong container
                            const buttons = Array.from(container.querySelectorAll('button:not([disabled])'));
                            const iconButtons = buttons.filter(b => b.querySelector('svg') || b.querySelector('i'));
                            if (iconButtons.length > 0) {
                                const btn = iconButtons[iconButtons.length - 1];
                                const r = btn.getBoundingClientRect();
                                if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }
                            return null;
                        }, editorSelector);

                        if (fallbackCoords) {
                            this.log('Fallback submit button found. Clicking...');
                            await this.humanClick(page, fallbackCoords.x, fallbackCoords.y);
                            clicked = true;
                        }
                    } catch (e) {
                        this.log(`Fallback submit scan failed: ${e.message}`);
                    }
                }

                await this.sleep(1000);

                // Phương pháp 3: Enter key
                if (!clicked) {
                    this.log('All submit methods failed. Pressing Enter as last resort...');
                    await page.focus(editorSelector);
                    await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        el.focus();
                        var range = document.createRange();
                        range.selectNodeContents(el);
                        range.collapse(false);
                        var selObj = window.getSelection();
                        selObj.removeAllRanges();
                        selObj.addRange(range);
                    }, editorSelector);
                    await page.keyboard.press('Enter');
                }

                // 4. Wait & Handle Errors during Generation
            } catch (uiErr) {
                this.log(`UI Interaction Error: ${uiErr.message}`);
                throw uiErr;
            } finally {
                this.log('UI configuration complete. Submit attempt finished. Verifying submit status...');
            }

            // --- BƯỚC KIỂM TRA: CHỜ ĐẢM BẢO RẰNG LỆNH ĐÃ ĐƯỢC GỬI ĐI VÀ HỆ THỐNG ĐANG TẠO ---
            // Vì có thể render nhiều video đồng thời nên nút Submit không bị mờ (disabled).
            // Ta sẽ đợi tối đa 15 giây để thấy Toast thông báo hoặc thấy % Render xuất hiện.
            this.log('Đang chờ hệ thống xác nhận đã gửi lệnh (Toast Thông Báo hoặc % Render)...');
            let submitConfirmed = false;
            for (let check = 0; check < 10; check++) {
                try {
                    submitConfirmed = await page.evaluate(() => {
                        // Check for snacks/alerts
                        const alerts = Array.from(document.querySelectorAll('[role="alert"], [class*="snackbar"], snack-bar, .msg, .toast'));
                        for (let a of alerts) {
                            if (a.offsetParent === null) continue;
                            const t = (a.innerText || "").toLowerCase();
                            if (t.includes('đang tạo') || t.includes('creating') || t.includes('queued') || t.includes('working')) {
                                return true;
                            }
                        }

                        // Check for % text or Generating text
                        const texts = Array.from(document.querySelectorAll('span, div, p'));
                        return texts.some(el => {
                            if (el.offsetParent === null) return false;
                            const t = el.textContent.trim();
                            if (t.includes('Đang tạo') || t.includes('Generating') || t.includes('queued') || t.includes('đang đợi') || t.includes('trong hàng đợi')) return true;
                            return t.endsWith('%') && t.length > 1 && t.length <= 5 && !isNaN(parseInt(t));
                        });
                    });

                    if (submitConfirmed) {
                        this.log('Đã xác nhận lệnh Tạo Video được hệ thống tiếp nhận. Bắt đầu theo dõi tiến trình Render...');
                        break;
                    }
                } catch (frameErr) {
                    this.log('ℹ️ Giao diện đang tự tải lại, thẻ DOM bị mất tạm thời. Đang thử lại...');
                }
                await this.sleep(1500);
            }

            if (!submitConfirmed) {
                this.log('CẢNH BÁO: Đã nhấn gửi nhưng sau 15 giây không thấy dấu hiệu Render. Có thể do nghẽn UI mạng. Sẽ tiếp tục theo dõi nhưng có rủi ro...');
            }

            // Wait a max 90s for video/images (nano banana 2 takes 65s)
            let hasError = false;
            let maxWaitSeconds = (job.TYPE_VIDEO === 'IN2V') ? 100 : 90;
            // Reuse settings/isImg/currentSettings from scope above (L1573-1576) — NO re-declaration
            if (currentSettings && currentSettings.model === 'nano banana 2') {
                maxWaitSeconds = 65;
            }
            this.log(`Waiting up to ${maxWaitSeconds} seconds for generation to complete...`);

            // Give the UI a brief moment to show the "Generating" state
            this.hasSeenGenerating = false;
            let targetMediaCoords = null;

            let hasZodOr429Error = false;
            let zodOr429Reason = '';
            let hasUnusualActivity = false; // FIX 1: HTTP 403 detection
            const consoleHandler = (msg) => {
                const text = msg.text() || '';
                if (text.includes('ZodError') || text.includes('429')) {
                    hasZodOr429Error = true;
                    zodOr429Reason = text.includes('ZodError') ? 'ZodError' : '429_Error';
                }
            };
            const responseHandler = (response) => {
                if (response.status() === 429) {
                    hasZodOr429Error = true;
                    zodOr429Reason = '429_Error';
                } else if (response.status() === 403) {
                    // Only flag 403 from Google API endpoints (avoid false-positives from CDN/fonts)
                    const url = response.url() || '';
                    if (url.includes('labs.google') || url.includes('googleapis.com') || url.includes('generativelanguage')) {
                        hasUnusualActivity = true;
                        this.log(`[responseHandler] HTTP 403 detected from: ${url.substring(0, 80)}`);
                    }
                }
            };
            page.on('console', consoleHandler);
            page.on('response', responseHandler);

            await this.sleep(3000);

            let clearedPromptDuringRender = false;
            const clearPromptTimeMs = Math.floor(Math.random() * (70000 - 30000 + 1)) + 30000;

            for (let i = 0; i < (maxWaitSeconds / 2); i++) {
                await this.sleep(2000);

                // Check if the "Đã xảy ra lỗi" (Error occurred) dialog/text appeared
                const errorCheck = await page.evaluate(() => {
                    // Helper to check if element is actually visible on screen
                    const isVisible = (el) => el.offsetParent !== null;

                    // 0. VETO: If there is ANY active "%" generation indicator on the screen, do NOT trigger any errors.
                    const allTexts = Array.from(document.querySelectorAll('span, div, p'));
                    const isGeneratingText = allTexts.some(el => {
                        if (!isVisible(el)) return false;

                        const t = el.innerText.trim();
                        // Also accept Veo generating texts
                        return (t.endsWith('%') && t.length > 1 && t.length <= 5 && !isNaN(parseInt(t))) || t.includes('Đang tạo') || t.includes('Generating') || t.includes('queued') || t.includes('đang đợi') || t.includes('trong hàng đợi');
                    });
                    if (isGeneratingText) return { isError: false, reason: 'is_generating_veto' };

                    // 1. Tìm BẤT KỲ text lỗi VISIBLE nào trên toàn trang (không giới hạn dialog/alert)
                    // VETO ở trên đã đảm bảo không false-positive khi đang generating.
                    const allVisible = Array.from(document.querySelectorAll('span, div, p, h1, h2, h3, [role="alert"], [role="alertdialog"]'));
                    for (let el of allVisible) {
                        if (!isVisible(el)) continue;
                        const t = (el.innerText || '').trim().toLowerCase();
                        // Chỉ match text ngắn (< 200 chars) để tránh match cả layout container
                        if (t.length > 200 || t.length < 3) continue;
                        if (t.includes('đã xảy ra lỗi') || t.includes('something went wrong') ||
                            t.includes('không thành công') || t.includes('unsuccessful') ||
                            t.includes('rất tiếc') || t.includes('vi phạm chính sách') ||
                            t.includes('vi phạm')) {
                            return { isError: true, reason: 'inline_error_text' };
                        }
                    }

                    return { isError: false, reason: 'no_error_indicators' };
                });

                let currentErrorReason = '';
                if (errorCheck.isError) {
                    currentErrorReason = errorCheck.reason;
                    hasError = true;
                } else if (hasZodOr429Error) {
                    currentErrorReason = zodOr429Reason;
                    hasError = true;
                }

                // FIX 1b: Break ngay khi phát hiện HTTP 403 (UNUSUAL_ACTIVITY_BAN)
                if (hasUnusualActivity) {
                    this.log('[Render Loop] HTTP 403 detected — breaking to throw UNUSUAL_ACTIVITY_BAN...');
                    break;
                }

                // --- FIXED LOGIC: DISCARD IN-PLACE RETRY & FORCE RELOAD ON 3-BUTTON VALIDATION ERRORS ---
                const hasThreeButtonError = await page.evaluate(() => {
                    const isVisible = (el) => el.offsetParent !== null;
                    const hasIcon = (b) => b.querySelector('svg') || b.querySelector('i.google-symbols, i[class*="google-symbols"], mat-icon, i[class*="material"]');

                    const buttonContainers = Array.from(document.querySelectorAll('div')).filter(container => {
                        if (!isVisible(container)) return false;
                        const rect = container.getBoundingClientRect();
                        // Giữ chặt: loại bỏ card/container lớn (video thành công cũng có 3 nút tải/hoàn tác/xóa)
                        if (rect.height > 200 || rect.width > 400 || rect.width < 50) return false;
                        if (rect.y > window.innerHeight - 250) return false; // Bỏ qua thanh Editor

                        const btns = Array.from(container.querySelectorAll('button, [role="button"]')).filter(b => isVisible(b) && hasIcon(b));
                        if (btns.length !== 3) return false;

                        // PHẢI có nút "Thử lại/Retry" để xác nhận đây là error card, không phải success card
                        const hasRetryButton = btns.some(b => {
                            const lbl = (b.getAttribute('aria-label') || b.innerText || b.getAttribute('data-tooltip') || '').toLowerCase();
                            return lbl.includes('thử lại') || lbl.includes('retry') || lbl.includes('lời nhắc khác') || lbl.includes('thử câu lệnh') || lbl.includes('tạo lại') || lbl.includes('regenerate');
                        });
                        if (hasRetryButton) return true;

                        // Fallback: kiểm tra text lỗi TRONG CHÍNH container này (không leo lên parent)
                        const errTexts = Array.from(container.querySelectorAll('span, div, p')).filter(el => isVisible(el));
                        return errTexts.some(el => {
                            const t = el.innerText.trim().toLowerCase();
                            if (t.length > 100) return false; // Bỏ qua text quá dài
                            return t.includes('vi phạm chính sách') || t.includes('không thể tạo') || t.includes('vi phạm') ||
                                   t.includes('không thành công') || t.includes('xảy ra lỗi') || t.includes('rất tiếc');
                        });
                    });

                    return buttonContainers.length > 0;
                });

                if (hasThreeButtonError) {
                    this.log(`🔄 Phát hiện hộp thoại lỗi 3 nút gây treo (Inline Error Card). TIẾN HÀNH BẮT BUỘC RELOAD LẠI TRANG...`);
                    await page.reload({ waitUntil: 'networkidle2' });
                    this.settingsApplied = false;
                    await this.sleep(4000);
                    throw new Error("MEDIA_GENERATION_FAILED: Phát hiện hộp thoại lỗi 3 nút gây treo. Bắt buộc Auto-reloaded để phục hồi.");
                }

                if (hasError) {
                    this.log(`Detected Google error message [Reason: ${currentErrorReason}]. Refreshing page and retrying...`);
                    break;
                }

                // --------- Session Expiry Check ---------
                if (await this.checkAndRecoverSession()) {
                    this.log('Session kicked out during render. Reloading and throwing error...');
                    await page.reload({ waitUntil: 'networkidle2' });
                    throw new Error('SESSION_DROPPED: Google asked to Sign in again mid-render.');
                }

                // Check for percentage progress indicators ("3%")
                const genInfo = await page.evaluate(() => {
                    const texts = Array.from(document.querySelectorAll('span, div, p'));
                    const el = texts.find(el => {
                        const t = el.textContent.trim();
                        if (t.includes('Đang tạo') || t.includes('Generating') || t.includes('queued') || t.includes('đang đợi') || t.includes('trong hàng đợi')) return true;
                        // Match strings like "3%", "10%", "99%" and length <= 5
                        return t.endsWith('%') && t.length > 1 && t.length <= 5 && !isNaN(parseInt(t));
                    });

                    if (el) {
                        const percentStr = el.textContent.trim().replace('%', '');
                        const percentInt = parseInt(percentStr);

                        let node = el;
                        let targetRect = el.getBoundingClientRect();
                        for (let i = 0; i < 6; i++) {
                            if (node && node.getBoundingClientRect) {
                                const r = node.getBoundingClientRect();
                                if (r.width > 150 && r.height > 100) {
                                    targetRect = r;
                                    break;
                                }
                            }
                            if (node) node = node.parentElement;
                        }
                        return { found: true, percent: isNaN(percentInt) ? 0 : percentInt, x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height / 2 };
                    }
                    return { found: false, percent: 0 };
                });

                // Scroll to top ONLY when generation percent is between 65 and 75
                if (genInfo.found && genInfo.percent >= 65 && genInfo.percent <= 75 && !this.scrolledToTopDuringRender) {
                    try {
                        this.log(`Generation at ${genInfo.percent}%. Scrolling to top of page...`);
                        await page.evaluate(() => window.scrollTo(0, 0));
                        this.scrolledToTopDuringRender = true;
                    } catch (scrollErr) { }
                }

                // Simulate human scrolling randomly while waiting for generation
                if (Math.random() > 0.6) {
                    await this.humanScroll(page);
                }

                if (genInfo.found) {
                    if (!this.hasSeenGenerating) {
                        this.log('Detected generation progress indicator (%). Tracking location for download...');
                        this.hasSeenGenerating = true;
                    }
                    targetMediaCoords = { x: genInfo.x, y: genInfo.y };
                } else if (this.hasSeenGenerating) {
                    // CRITICAL: % indicator biến mất có thể vì HOÀN THÀNH hoặc vì LỖI.
                    // Phải kiểm tra lại error trước khi kết luận video xong!
                    this.log('Progress indicator disappeared. Verifying completion vs error...');
                    await this.sleep(4000); // Buffer

                    // Re-check for error indicators after the buffer
                    const postGenErrorCheck = await page.evaluate(() => {
                        const isVisible = (el) => el.offsetParent !== null;

                        // 1. Check for error dialog text
                        const allElements = Array.from(document.querySelectorAll('span, div, p, [role="alert"], [role="alertdialog"]'));
                        const hasErrorText = allElements.some(el => {
                            if (!isVisible(el)) return false;
                            const t = (el.innerText || '').trim().toLowerCase();
                            return t.includes('đã xảy ra lỗi') || t.includes('something went wrong') ||
                                   t.includes('không thành công') || t.includes('unsuccessful') ||
                                   t.includes('rất tiếc') || t.includes('vi phạm');
                        });
                        if (hasErrorText) return { isError: true, reason: 'post_gen_error_dialog' };

                        // 2. Check for 3-button error card (CÓ NÚT "Thử lại/Retry")
                        const hasIcon = (b) => b.querySelector('svg') || b.querySelector('i.google-symbols, i[class*="google-symbols"], mat-icon');
                        const errorCards = Array.from(document.querySelectorAll('div')).filter(container => {
                            if (!isVisible(container)) return false;
                            const rect = container.getBoundingClientRect();
                            if (rect.height > 200 || rect.width > 400 || rect.width < 50) return false;
                            if (rect.y > window.innerHeight - 250) return false;
                            const btns = Array.from(container.querySelectorAll('button, [role="button"]')).filter(b => isVisible(b) && hasIcon(b));
                            if (btns.length !== 3) return false;

                            // Phải có nút retry HOẶC text lỗi trong container
                            const hasRetry = btns.some(b => {
                                const lbl = (b.getAttribute('aria-label') || b.innerText || b.getAttribute('data-tooltip') || '').toLowerCase();
                                return lbl.includes('thử lại') || lbl.includes('retry') || lbl.includes('tạo lại') || lbl.includes('regenerate');
                            });
                            if (hasRetry) return true;

                            const errTexts = Array.from(container.querySelectorAll('span, div, p')).filter(el => isVisible(el));
                            return errTexts.some(el => {
                                const t = el.innerText.trim().toLowerCase();
                                if (t.length > 100) return false;
                                return t.includes('không thành công') || t.includes('xảy ra lỗi') || t.includes('rất tiếc');
                            });
                        });
                        if (errorCards.length > 0) return { isError: true, reason: 'post_gen_3button_error' };

                        // NOTE: Không kiểm tra media existence vì video CŨ từ job trước luôn tồn tại trên trang
                        // → sẽ pass check dù job hiện tại đã lỗi. Chỉ dựa vào error text + 3-button detection.

                        return { isError: false };
                    });

                    if (postGenErrorCheck.isError) {
                        this.log(`🚨 Post-generation verification FAILED [Reason: ${postGenErrorCheck.reason}]. This was NOT a successful render!`);
                        hasError = true;
                        break;
                    }

                    this.log('✅ Post-generation verification PASSED. Media confirmed on page. Proceeding to download...');
                    break;
                } else {
                    // Has not started generating yet or indicator hasn't appeared. Just wait.
                }
            }

            page.off('console', consoleHandler);
            page.off('response', responseHandler);

            // FIX 1c: UNUSUAL_ACTIVITY_BAN — throw riêng, Orchestrator sẽ close + relaunch browser
            if (hasUnusualActivity) {
                this.log('UNUSUAL_ACTIVITY_BAN: HTTP 403 received from Google. Reloading and throwing for Orchestrator...');
                await page.reload({ waitUntil: 'networkidle2' });
                this.settingsApplied = false;
                await this.sleep(4000);
                throw new Error('UNUSUAL_ACTIVITY_BAN: HTTP 403 received from Google. Browser will be reset.');
            }

            if (hasError) {
                this.log(`Generation failed because Google returned an Error Message...`);
                await page.reload({ waitUntil: 'networkidle2' });
                this.settingsApplied = false;
                await this.sleep(4000);
                throw new Error("MEDIA_GENERATION_FAILED: Generation blocked by Google (Error screen or Network). Auto-reloaded for next attempt.");
            }

            if (!this.hasSeenGenerating) {
                this.log('ERROR: The wait time expired but no % generation indicator was ever detected. The submit prompt might have failed or the UI is stuck. Forcing retry...');
                await page.reload({ waitUntil: 'networkidle2' });
                this.settingsApplied = false;
                await this.sleep(4000);
                throw new Error('SUBMISSION_FAILED: Never saw the rendering progress % indicator.');
            }

            // 4.5. CLEAR PROMPT BOX (Only clear right before download step)
            this.log('Generation completed. Clicking X to clear prompt box to prevent UI overlap before download...');
            let promptCleared = false;
            try {
                promptCleared = await page.evaluate(() => {
                    const allBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    for (const btn of allBtns) {
                        const spans = Array.from(btn.querySelectorAll('span'));
                        const hasXLabel = spans.some(s => s.textContent.trim() === 'Xoá câu lệnh' || (s.textContent.trim().toLowerCase() === 'clear prompt'));
                        const googleIcon = btn.querySelector('i.google-symbols, i[class*="google-symbols"]');
                        if (hasXLabel || (googleIcon && googleIcon.textContent.trim() === 'close')) {
                            const r = btn.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) { btn.click(); return true; }
                        }
                    }
                    return false;
                });
            } catch (clearErr) {
                this.log('Error clearing prompt box (UI may have detached): ' + clearErr.message);
            }

            if (!promptCleared) {
                throw new Error("MEDIA_GENERATION_FAILED: Không tìm thấy nút Xoá prompt box để tiếp tục tải file.");
            }
            await this.sleep(1500);

            // 5. Download
            const resolution = job.settings?.videoSettings?.resolution || '1080p';
            this.log(`Downloading (${job.TYPE_VIDEO === 'IMG' ? 'Image' : 'Video'}) at ${resolution}...`);
            await this.handleDownload(job.VIDEO_NAME, tempOutputDir, outputDir, job.TYPE_VIDEO, resolution);

        } catch (e) {
            this.log(`Job Failed: ${e.message}`);
            // If the browser navigation crashed entirely (e.g. Chrome locked up at about:blank),
            // we must close the browser instance so the master controller forces a fresh launch on next retry,
            // preventing an infinite auto-run loop of failures on a stuck tab.
            if (e.message.includes('failed to navigate') || e.message.includes('Target closed') || e.message.includes('disconnected')) {
                this.log('Browser state appears broken. Force closing to allow fresh restart...');
                await this.close();
                this.browser = null;
                this.page = null;
            }
            throw e;
        } finally {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
        }
    }

    async checkNewProject() {
        // Obsolete as we reload the page entirely now, but keep for compatibility if called elsewhere
    }

    async handleDownload(targetName, tempOutputDir, finalOutputDir, type, resolution = '1080p') {
        const page = this.page;

        try {
            // Bước 8: Bắt toạ độ Media (video, canvas, img)
            this.log('Đang quét toạ độ Media lớn nhất trên trang...');
            const mediaCoords = await page.evaluate((mediaType) => {
                let selectors = ['video', 'canvas', 'img'];
                if (mediaType === 'IMG') {
                    selectors = ['img', 'canvas']; // Ưu tiên img
                }

                let bestElement = null;
                let maxArea = 0;
                let bestRect = null;

                for (const selector of selectors) {
                    const elements = Array.from(document.querySelectorAll(selector));
                    for (const el of elements) {
                        const rect = el.getBoundingClientRect();
                        const area = rect.width * rect.height;
                        
                        // Bỏ qua các icon nhỏ hoặc avatar
                        if (area > 40000) { 
                            if (selector === 'img' && (el.src.includes('avatar') || el.src.includes('logo'))) {
                                continue;
                            }
                            // Nếu tìm thấy video, ưu tiên dùng luôn
                            if (selector === 'video') {
                                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
                            }
                            if (area > maxArea) {
                                maxArea = area;
                                bestElement = el;
                                bestRect = rect;
                            }
                        }
                    }
                }

                if (bestRect) {
                    return { x: bestRect.left + bestRect.width / 2, y: bestRect.top + bestRect.height / 2, width: bestRect.width, height: bestRect.height };
                }
                return null;
            }, type);

            if (!mediaCoords) {
                throw new Error("MEDIA_GENERATION_FAILED: Không tìm thấy Media (Video/Canvas/Image) trên màn hình.");
            }

            // Scroll lên top để đảm bảo toạ độ chính xác (do evaluate trả về viewport coords)
            await page.evaluate(() => window.scrollTo(0, 0));
            await this.sleep(500);

            // Hover và Right-click
            this.log(`Click chuột phải vào toạ độ Media: x=${Math.round(mediaCoords.x)}, y=${Math.round(mediaCoords.y)}`);
            await page.mouse.move(mediaCoords.x, mediaCoords.y);
            await this.sleep(500);
            
            // Use humanClick if available, else standard click
            if (this.humanClick) {
                await this.humanClick(page, mediaCoords.x, mediaCoords.y, { button: 'right' });
            } else {
                await page.mouse.click(mediaCoords.x, mediaCoords.y, { button: 'right' });
            }
            await this.sleep(1500); // Chờ context menu hiện

            // Tìm và bấm "Tải xuống" từ menu
            this.log('Tìm nút Tải xuống trong Context Menu...');
            const dlClicked = await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('div[role="menuitem"], li, .mat-menu-item, span'));
                for (const item of items) {
                    const text = item.textContent.trim().toLowerCase();
                    if ((text === 'tải xuống' || text === 'download' || text.includes('tải xuống')) && !text.includes('tất cả') && !text.includes('zip') && text.length < 50) {
                        item.click();
                        return true;
                    }
                }
                return false;
            });

            if (!dlClicked) {
                throw new Error("MEDIA_GENERATION_FAILED: Không tìm thấy nút Tải xuống trong context menu.");
            }
            await this.sleep(1000);

            // Chọn chất lượng (Resolution)
            if (type === 'IMG') {
                const imgRes = resolution || '1K';
                this.log(`Chọn chất lượng ảnh (${imgRes})...`);
                try {
                    await page.evaluate((resText) => {
                        const items = Array.from(document.querySelectorAll('div[role="menu"] li, div[role="menu"] div[role="menuitem"], span, div[role="option"]'));
                        for (const it of items) {
                            const t = it.textContent.trim();
                            if (t.includes(resText) || (resText === '1K' && t.includes('Original')) || t.includes('High')) {
                                it.click();
                                return;
                            }
                        }
                    }, imgRes);
                } catch (e) { }
            } else {
                const resSetting = resolution || '1080p';
                this.log(`Chọn chất lượng video (${resSetting})...`);
                try {
                    await page.evaluate((resText) => {
                        const items = Array.from(document.querySelectorAll('div[role="menu"] li, div[role="menu"] div[role="menuitem"], span, div[role="option"]'));
                        for (const it of items) {
                            if (it.textContent.includes(resText)) {
                                it.click();
                                return;
                            }
                        }
                    }, resSetting);
                } catch (e) { }
            }

            // Bước 9: Lưu file (Polling File System)
            this.log('Đang chờ hệ thống tải file...');
            const getFiles = () => fs.readdirSync(tempOutputDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
            const before = getFiles();

            let newFile = null;
            let latestTime = 0;
            const waitTimeoutSeconds = (type !== 'IMG' && resolution === '1080p') ? 130 : 60;

            for (let i = 0; i < waitTimeoutSeconds; i++) {
                await this.sleep(1000);
                const now = getFiles();
                const diff = now.filter(f => !before.includes(f));

                if (diff.length > 0) {
                    for (const f of diff) {
                        try {
                            const stat = fs.statSync(path.join(tempOutputDir, f));
                            if (stat.mtimeMs > latestTime) {
                                latestTime = stat.mtimeMs;
                                newFile = f;
                            }
                        } catch (e) { }
                    }
                    if (newFile) break;
                }
            }

            if (newFile) {
                this.log(`Tải hoàn tất: ${newFile}`);
                const ext = path.extname(newFile);
                const safeName = targetName.replace(/[<>:"/\\|?*]/g, '_');
                const oldPath = path.join(tempOutputDir, newFile);
                const newPath = path.join(finalOutputDir, `${safeName}${ext}`);

                if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
                fs.renameSync(oldPath, newPath);
            } else {
                throw new Error("MEDIA_GENERATION_FAILED: Download timeout (Quá thời gian tải file).");
            }
        } finally {
            // Download process complete
        }
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = AutomationWorker;
