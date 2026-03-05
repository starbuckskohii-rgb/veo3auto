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
        const baseProfileName = this.isShadowProfile ? `${accountProfileName}_shadow_${this.id}` : accountProfileName;
        this.profilePath = path.join(baseDir, baseProfileName, `${this.browserType}_data`);

        if (!fs.existsSync(this.profilePath)) {
            if (this.isShadowProfile && fs.existsSync(anchorProfilePath)) {
                this.log(`[Shadow Clone] Đang xào nấu Profile gốc sang mục Temporary cho luồng ${this.id}...`);
                try {
                    fs.cpSync(anchorProfilePath, this.profilePath, {
                        recursive: true, force: true, filter: (src) => {
                            if (src.includes('SingletonLock') || src.includes('SingletonCookie')) return false;
                            return true;
                        }
                    });
                    this.log(`[Shadow Clone] Copy thư mục Profile hoàn thành!`);
                } catch (e) {
                    this.log(`[Shadow Clone] Lỗi sao chép Cache: ${e.message}. Tiếp tục với Folder trống.`);
                    fs.mkdirSync(this.profilePath, { recursive: true });
                }
            } else {
                fs.mkdirSync(this.profilePath, { recursive: true });
            }
        }

        // Forcefully inject preferences to match user manual settings: Block Third Party Cookies ON, Tracking Prevention OFF, and Do Not Track ON
        try {
            const setPrefs = (prefs) => {
                if (!prefs.profile) prefs.profile = {};
                prefs.profile.cookie_controls_mode = 1; // 1 = BlockThirdPartyCookies ON
                prefs.profile.block_third_party_cookies = true;

                // Chrome & Edge: "Do Not Track" ON
                prefs.enable_do_not_track = true;

                if (!prefs.privacy) prefs.privacy = {};
                if (!prefs.privacy.tracking) prefs.privacy.tracking = {};
                prefs.privacy.tracking.tracking_protection_level = 0; // Chromium standard tracking protection off

                // Edge specific tracking prevention OFF
                if (!prefs.enhanced_tracking_prevention) prefs.enhanced_tracking_prevention = {};
                prefs.enhanced_tracking_prevention.enabled = false;

                // Brave specific: Disable "Private Product Analytics" banner
                if (!prefs.brave) prefs.brave = {};
                if (!prefs.brave.p3a) prefs.brave.p3a = {};
                prefs.brave.p3a.notice_acknowledged = true;
                prefs.brave.p3a.enabled = false;

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
                '--disable-features=IsolateOrigins,site-per-process,AutomationControlled,TrackingProtection3pcd,TrackingProtection,PrivacySandboxSettings4,msTrackingPrevention',
                '--disable-dev-shm-usage',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-session-crashed-bubble',
                '--hide-crash-restore-bubble',
                '--restore-last-session=false',
                '--do-not-track',
                '--new-window', // Force new window instead of opening a tab
                '--test-type', // Globally suppresses the 'Unsupported command-line flag' infobar
                `--user-data-dir=${this.profilePath}` // FORCED user-data-dir since puppeteer-real-browser drops it when ignoreAllFlags is true
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

        // Tìm nút +
        let plusBtnCoords = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            const attachBtn = btns.find(b => {
                const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                const hasPlusSvg = b.querySelector('svg path[d*="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"]'); // generic + path
                const hasGoogleIconPlus = Array.from(b.querySelectorAll('i, span, div.google-symbols')).some(el => {
                    const txt = el.textContent.trim();
                    return txt === 'add' || txt === 'attach_file';
                });

                const isMatch = aria.includes('tải lên') || aria.includes('upload') || aria.includes('đính kèm') || aria.includes('attach') || hasPlusSvg || hasGoogleIconPlus;
                if (!isMatch) return false;

                // Lọc để TRÁNH nút + ở góc trên cùng bên phải màn hình (New Project)
                // Nút upload ảnh của Editor chát luôn nằm nửa dưới màn hình và ở khu vực TRUNG TÂM HOẶC BÊN TRÁI.
                const r = b.getBoundingClientRect();
                const isOnScreenBottom = r.y > (window.innerHeight / 2);
                const isNotFarRight = r.x < (window.innerWidth - 300); // Ngăn không bấm nhầm vào các widget góc phải tít tắp (như X = 1371)

                return isOnScreenBottom && isNotFarRight;
            });

            if (attachBtn) {
                const r = attachBtn.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
            return null;
        });

        if (!plusBtnCoords) {
            // Try aggressive search for anything looking like an add attachment near the editor
            plusBtnCoords = await page.evaluate(() => {
                const editor = document.querySelector('[data-slate-editor="true"][role="textbox"]');
                if (!editor) return null;
                const container = editor.closest('div[style*="border-radius"]') || editor.parentElement.parentElement;
                if (!container) return null;

                const buttons = Array.from(container.querySelectorAll('button, [role="button"]'));
                if (buttons.length > 0) {
                    // Usually the attach button is the first icon button on the left
                    const r = Array.from(buttons).find(b => {
                        const r2 = b.getBoundingClientRect();
                        return r2.width > 0 && r2.height > 0;
                    });
                    if (r) {
                        const rect = r.getBoundingClientRect();
                        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                    }
                }
                return null;
            });
        }

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
                this.log('⚠️ Không mở được File Chooser (Có thể Google Veo đổi chữ trên nút, hoặc menu chưa mở). Ảnh sẽ bị bỏ qua.');
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
            const profileToDelete = this.profilePath;
            let retries = 0;
            const tryDelete = () => {
                setTimeout(async () => {
                    try {
                        if (fs.existsSync(profileToDelete)) {
                            // Dùng fs.promises.rm để chạy bất đồng bộ, không làm đơ (block) event loop
                            await fs.promises.rm(profileToDelete, { recursive: true, force: true, maxRetries: 10, retryDelay: 2000 });
                            this.log(`[Shadow Cleanup] Xóa Folder Clone thành công: ${profileToDelete}`);
                        }
                    } catch (e) {
                        if (retries < 5) {
                            retries++;
                            this.log(`[Shadow Cleanup] File bị khóa, thử Xóa lại lần ${retries}...`);
                            tryDelete();
                        } else {
                            this.log(`[Shadow Cleanup] Thất bại khi dọn dẹp (Vẫn bị khóa): ${e.message}`);
                        }
                    }
                }, 3000); // Đợi 3 giây sau khi Chrome gọi .close() để nhả lock
            };
            tryDelete();
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
            const coords = {
                modes: {
                    'T2V': { x: 1150, y: 653 },
                    'IN2V': { x: 1147, y: 691 },
                    'I2V': { x: 1020, y: 691 },
                    'IMG': { x: 1022, y: 653 },
                    trigger_create_menu: { x: 1176, y: 889 }
                },
                ratioVideo: {
                    'Ngang': { x: 1020, y: 730 },
                    'Dọc': { x: 1153, y: 727 }
                },
                ratioImage: {
                    '16:9': { x: 1022, y: 691 },
                    '9:16': { x: 1157, y: 691 },
                },
                countVideo: {
                    '1': { x: 981, y: 768 },
                    '2': { x: 1048, y: 765 },
                    '3': { x: 1114, y: 767 },
                    '4': { x: 1179, y: 767 }
                },
                countImage: {
                    '1': { x: 982, y: 729 },
                    '2': { x: 1048, y: 729 },
                    '3': { x: 1114, y: 728 },
                    '4': { x: 1182, y: 728 }
                },
                model: {
                    trigger_video: { x: 1079, y: 806 },
                    trigger_image: { x: 1077, y: 769 },
                    'Veo 3.1 - Fast [Lower Priority]': { x: 1062, y: 626 },
                    'Veo 3.1 - Fast': { x: 1066, y: 583 },
                    'Nano Banana Pro': { x: 1070, y: 811 },
                    'nano banana 2': { x: 792, y: 850 }
                },
                submitBtn: { x: 1236, y: 890 },
                viewMode: {
                    trigger: { x: 1709, y: 39 },
                    batch: { x: 1636, y: 128 },
                    size_S: { x: 1428, y: 202 },
                    sound_off: { x: 1609, y: 249 },
                    info_on: { x: 1685, y: 294 },
                    clear_off: { x: 1611, y: 341 }
                }
            };

            const applyViewMode = async () => {
                await this.sleep(3000);
                this.log("Applying View Mode for the first time on this browser...");
                await this.humanClick(page, this.getRand(coords.viewMode.trigger.x), this.getRand(coords.viewMode.trigger.y));
                await this.sleep(1500);
                await this.humanClick(page, this.getRand(coords.viewMode.batch.x), this.getRand(coords.viewMode.batch.y)); await this.sleep(400);
                await this.humanClick(page, this.getRand(coords.viewMode.size_S.x), this.getRand(coords.viewMode.size_S.y)); await this.sleep(400);
                await this.humanClick(page, this.getRand(coords.viewMode.sound_off.x), this.getRand(coords.viewMode.sound_off.y)); await this.sleep(400);
                await this.humanClick(page, this.getRand(coords.viewMode.info_on.x), this.getRand(coords.viewMode.info_on.y)); await this.sleep(400);
                await this.humanClick(page, this.getRand(coords.viewMode.clear_off.x), this.getRand(coords.viewMode.clear_off.y)); await this.sleep(400);

                // Close View Mode Panel
                await this.humanClick(page, this.getRand(150), this.getRand(788));
                await this.sleep(1000);

                // Explicitly click IN2V mode to prevent UI glitches later
                this.log("First time setup: explicitly switching to IN2V mode to match view mode settings...");
                await this.humanClick(page, this.getRand(coords.modes.trigger_create_menu.x), this.getRand(coords.modes.trigger_create_menu.y));
                await this.sleep(1000);
                await this.humanClick(page, this.getRand(coords.modes['IN2V'].x), this.getRand(coords.modes['IN2V'].y));
                await this.sleep(1500);
                await this.humanClick(page, this.getRand(150), this.getRand(788)); // Close menu

                this.viewModeApplied = true;
            };

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
                const settings = job.settings || {};
                const isImg = job.TYPE_VIDEO === 'IMG';
                const currentSettings = isImg ? settings.imgSettings : settings.videoSettings;
                const currentSettingsString = JSON.stringify(currentSettings);

                // 2. Open Create Menu and switch Mode + Settings (DO THIS FIRST BEFORE PROMPT)
                this.log(`Opening Create Menu: ${coords.modes.trigger_create_menu.x}, ${coords.modes.trigger_create_menu.y}`);
                await this.humanClick(page, this.getRand(coords.modes.trigger_create_menu.x), this.getRand(coords.modes.trigger_create_menu.y));
                await this.sleep(1500);

                if (coords.modes[job.TYPE_VIDEO]) {
                    this.log(`Selecting Mode Tab: ${job.TYPE_VIDEO}`);
                    await this.humanClick(page, this.getRand(coords.modes[job.TYPE_VIDEO].x), this.getRand(coords.modes[job.TYPE_VIDEO].y));
                    await this.sleep(1500);

                    // Apply settings if needed
                    if (currentSettings && (!this.settingsApplied || this.lastAppliedSettingsString !== currentSettingsString)) {
                        this.log(`Applying specific settings for ${job.TYPE_VIDEO}...`);

                        const clickCoord = async (map, key) => {
                            if (!key || !map) return;
                            const c = map[key];
                            if (c) {
                                await this.humanClick(page, this.getRand(c.x), this.getRand(c.y));
                                await this.sleep(1000);
                            }
                        };

                        if (isImg) {
                            await clickCoord(coords.ratioImage, currentSettings.ratio);
                            await clickCoord(coords.countImage, currentSettings.count?.toString());
                            if (currentSettings.model) {
                                await clickCoord(coords.model, "trigger_image");
                                await clickCoord(coords.model, currentSettings.model);
                            }
                        } else {
                            let ratioKey = currentSettings.ratio;
                            if (ratioKey === '16:9') ratioKey = 'Ngang';
                            if (ratioKey === '9:16') ratioKey = 'Dọc';

                            await clickCoord(coords.ratioVideo, ratioKey);
                            await clickCoord(coords.countVideo, currentSettings.count?.toString());
                            if (currentSettings.model) {
                                await clickCoord(coords.model, "trigger_video");
                                await clickCoord(coords.model, currentSettings.model);
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
                if (job.TYPE_VIDEO === 'IN2V' || job.TYPE_VIDEO === 'I2V') {
                    const rawPaths = [job.IMAGE_PATH, job.IMAGE_PATH_2, job.IMAGE_PATH_3];
                    await this.uploadImages(page, rawPaths);
                }

                // 4. Generate
                this.log('Requesting Global Submit Lock to prevent rate limiting...');
                if (this.automationService && this.automationService.requestSubmitLock) {
                    await this.automationService.requestSubmitLock(this.id);
                }

                this.log('Attempting programmatic Submit Arrow click...');

                // Attempt 1: Find the floating circle arrow button near the text area via DOM
                let submitBtnCoords = await page.evaluate((selector) => {
                    const editor = document.querySelector(selector);
                    if (!editor) return null;
                    const fieldContainer = editor.closest('div[style*="border-radius"], div[class*="container"]') || editor.parentElement.parentElement;
                    if (!fieldContainer) return null;
                    const buttons = Array.from(fieldContainer.querySelectorAll('button:not([disabled]), div[role="button"]:not([disabled])'));
                    let submitBtn = null;
                    for (const btn of buttons) {
                        const svgs = btn.querySelectorAll('svg');
                        for (const svg of svgs) {
                            const path = svg.innerHTML || '';
                            if (path.includes('arrow_forward') || path.includes('M5 13h11.17l-4.88 4.88c-.39.39-.39 1.03') || path.includes('m12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z') || path.includes('M2.01 21 23 12 2.01 3 2 10l15 2-15 2z')) {
                                submitBtn = btn; break;
                            }
                        }
                        if (submitBtn) break;
                    }
                    if (!submitBtn) {
                        const iconButtons = buttons.filter(b => b.textContent.replace(/\s/g, '') === '' && b.querySelector('svg'));
                        if (iconButtons.length > 0) submitBtn = iconButtons[iconButtons.length - 1];
                    }
                    if (submitBtn) {
                        const r = submitBtn.getBoundingClientRect();
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    }
                    return null;
                }, editorSelector);

                await this.sleep(1000);

                let clicked = false;
                if (submitBtnCoords) {
                    this.log('Programmatic submit button found. Simulating human click...');
                    await this.humanClick(page, submitBtnCoords.x, submitBtnCoords.y);
                    clicked = true;
                    await this.sleep(1000);
                }

                // Attempt 2: Explicit coordinate click if DOM search failed
                if (!clicked) {
                    this.log('Programmatic click missed. Clicking explicit coord Submit Arrow...');
                    await this.humanClick(page, this.getRand(coords.submitBtn.x), this.getRand(coords.submitBtn.y));
                    clicked = true;
                    await this.sleep(1000);
                }

                if (!clicked) {
                    this.log('Pressing Enter as additional fallback...');
                    await page.focus(editorSelector);
                    await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        el.focus();
                        // Select all and move cursor to end
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

            // --- BƯỚC KHÓA BẢO MẬT: CHỜ ĐẢM BẢO RẰNG LỆNH ĐÃ ĐƯỢC GỬI ĐI VÀ NÚT TẠO VIDEO ĐÃ BỊ KHÓA ---
            // Nếu nút vẫn còn nhấp nháy bấm được tức là UI chưa nhận lệnh (Mạng lag hoặc kẹt ảnh upload). 
            // Ta sẽ đợi tối đa 15 giây để nút Submit bị mờ đi. NGUYÊN TẮC: CHỈ QUÉT % TẠO VIDEO KHI NÚT SUBMIT ĐÃ TẮT.
            this.log('Đang chờ hệ thống xác nhận đã gửi lệnh (Nút Submit bị khóa)...');
            let submitConfirmed = false;
            for (let check = 0; check < 10; check++) {
                try {
                    const isSubmitLocked = await page.evaluate(() => {
                        const submitButtons = Array.from(document.querySelectorAll('button[aria-label="Tạo video"], button[aria-label="Create Video"], button[role="button"]')).filter(b => {
                            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                            return aria.includes('tạo') || aria.includes('create') || aria.includes('generate');
                        });
                        // Lệnh thực sự đã bay đi khi mọi nút Submit trên màn hình đều disabled hoặc không tìm thấy nút nào.
                        return submitButtons.length === 0 || submitButtons.every(b => b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true');
                    });

                    if (isSubmitLocked) {
                        submitConfirmed = true;
                        this.log('Đã xác nhận lệnh Tạo Video được gửi thành công. Bắt đầu theo dõi tiến trình Render...');
                        break;
                    }
                } catch (frameErr) {
                    this.log('ℹ️ Giao diện đang tự tải lại, thẻ DOM bị mất tạm thời (Attached Frame Error). Đang thử lại...');
                }
                await this.sleep(1500);
            }

            if (!submitConfirmed) {
                this.log('CẢNH BÁO: Đã nhấn gửi nhưng sau 15 giây nút Submit vẫn sáng. Có thể do nghẽn UI mạng hoặc Upload ảnh bị dính lỗi chìm. Sẽ vẫn tiếp tục theo dõi nhưng có rủi ro...');
            }

            // Wait a max 90s for video/images (nano banana 2 takes 65s)
            let hasError = false;
            let maxWaitSeconds = (job.TYPE_VIDEO === 'IN2V') ? 100 : 90;
            const settings = job.settings || {};
            const isImg = job.TYPE_VIDEO === 'IMG';
            const currentSettings = isImg ? settings.imgSettings : settings.videoSettings;
            if (currentSettings && currentSettings.model === 'nano banana 2') {
                maxWaitSeconds = 65;
            }
            this.log(`Waiting up to ${maxWaitSeconds} seconds for generation to complete...`);

            // Give the UI a brief moment to show the "Generating" state
            this.hasSeenGenerating = false;
            let targetMediaCoords = null;

            let hasZodOr429Error = false;
            let zodOr429Reason = '';
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

                    // KIỂM TRA ĐANG RENDER THỰC SỰ: Chỉ khi đang tạo Video thật sự, Veo mới hiện ra nút "Hủy" hoặc "Cancel" bên cạnh thẻ %
                    // Nút submit lúc upload ảnh cũng bị khóa, nhưng KHÔNG có nút Cancel.
                    const cancelBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
                        if (!isVisible(b)) return false;
                        const t = b.innerText.trim().toLowerCase();
                        return t === 'hủy' || t === 'cancel' || t === 'stop' || t === 'dừng';
                    });
                    const isTrulyGenerating = cancelBtns.length > 0;

                    // 0. VETO: If there is ANY active "%" generation indicator on the screen, AND it is truly generating, do NOT trigger any errors.
                    const allTexts = Array.from(document.querySelectorAll('span, div, p'));
                    const isGeneratingText = allTexts.some(el => {
                        if (!isVisible(el)) return false;

                        const t = el.innerText.trim();
                        // Also accept Veo generating texts
                        return (t.endsWith('%') && t.length > 1 && t.length <= 5 && !isNaN(parseInt(t))) || t.includes('Đang tạo') || t.includes('Generating');
                    });
                    if (isGeneratingText && isTrulyGenerating) return { isError: false, reason: 'is_generating_veto' };

                    // 1. Chỉ tìm Dialog Báo Lỗi Global hoặc Thông báo Lỗi Nổi Bật (Không tìm lỗi trong thẻ lịch sử cũ)
                    // Google Veo luôn hiện một thông báo khi tạo lỗi như: "Đã xảy ra lỗi.", "Không thành công."
                    const alerts = Array.from(document.querySelectorAll('[role="alert"], [class*="snackbar"], snack-bar, [role="alertdialog"], div[role="dialog"] h1, div[role="dialog"] h2, div[role="dialog"] p'));

                    for (let a of alerts) {
                        if (!isVisible(a)) continue;
                        const t = (a.innerText || "").trim().toLowerCase();
                        if (t.includes('đã xảy ra lỗi') || t.includes('something went wrong') || t.includes('không thành công') || t.includes('unsuccessful') || t.includes('thử lại') || t.includes('vi phạm')) {
                            return { isError: true, reason: 'global_dialog_error' };
                        }
                    }

                    // Không còn quét lịch sử lỗi bằng tọa độ Y nữa. Điều này ngăn chặn tình hướng "Poison Pill"
                    // (Lỗi cũ nằm trên đỉnh lịch sử làm tất cả Job mới đều bị đánh giá là lỗi).
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

                // --------- Random Clear Check ---------
                const timeElapsedMs = i * 2000 + 3000;
                if (timeElapsedMs >= clearPromptTimeMs && !clearedPromptDuringRender) {
                    this.log(`Random clear interval reached (${Math.round(timeElapsedMs / 1000)}s / 90s). Clicking X to clear prompt box...`);
                    await page.evaluate(() => {
                        const allBtns = Array.from(document.querySelectorAll('button'));
                        for (const btn of allBtns) {
                            const spans = Array.from(btn.querySelectorAll('span'));
                            const hasXLabel = spans.some(s => s.textContent.trim() === 'Xoá câu lệnh' || (s.textContent.trim().toLowerCase() === 'clear prompt'));
                            const googleIcon = btn.querySelector('i.google-symbols, i[class*="google-symbols"]');
                            if (hasXLabel || (googleIcon && googleIcon.textContent.trim() === 'close')) {
                                const r = btn.getBoundingClientRect();
                                if (r.width > 0 && r.height > 0) { btn.click(); return; }
                            }
                        }
                    });
                    clearedPromptDuringRender = true;
                }

                // Cuộn lên đầu trang trong lúc chờ render
                try {
                    await page.evaluate(() => window.scrollTo(0, 0));
                } catch (scrollErr) { }

                // Simulate human scrolling randomly while waiting for generation
                if (Math.random() > 0.6) {
                    await this.humanScroll(page);
                }

                // Check for percentage progress indicators (like "3%") or generating text and get its coordinates
                const genInfo = await page.evaluate(() => {
                    const texts = Array.from(document.querySelectorAll('span, div, p'));
                    const el = texts.find(el => {
                        const t = el.textContent.trim();
                        if (t.includes('Đang tạo') || t.includes('Generating')) return true;
                        // Match strings like "3%", "10%", "99%" and length <= 5 to avoid matching random long text with a % in it
                        return t.endsWith('%') && t.length > 1 && t.length <= 5 && !isNaN(parseInt(t));
                    });

                    // KIỂM TRA ĐANG RENDER THỰC SỰ: Nút "Hủy" hoặc "Cancel" phải xuất hiện trên màn hình
                    // Nút submit lúc upload ảnh cũng bị khóa, nhưng KHÔNG có nút Cancel.
                    const cancelBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
                        if (b.offsetParent === null) return false;
                        const t = b.innerText.trim().toLowerCase();
                        return t === 'hủy' || t === 'cancel' || t === 'stop' || t === 'dừng';
                    });
                    const isTrulyGenerating = cancelBtns.length > 0;

                    if (el && isTrulyGenerating) {
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
                        return { found: true, x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height / 2 };
                    }
                    return { found: false };
                });

                if (genInfo.found) {
                    if (!this.hasSeenGenerating) {
                        this.log('Detected generation progress indicator (%). Tracking location for download...');
                        this.hasSeenGenerating = true;
                    }
                    targetMediaCoords = { x: genInfo.x, y: genInfo.y };
                } else if (this.hasSeenGenerating) {
                    this.log('Generation appears complete (progress indicator disappeared). Proceeding to download...');
                    await this.sleep(4000); // Buffer after generation finishes
                    break;
                } else {
                    // Has not started generating yet or indicator hasn't appeared. Just wait.
                }
            }

            page.off('console', consoleHandler);
            page.off('response', responseHandler);

            if (!clearedPromptDuringRender && !hasError) {
                this.log('Video finished before the random clear time hit. Clicking X to clear prompt now...');
                await page.evaluate(() => {
                    const allBtns = Array.from(document.querySelectorAll('button'));
                    for (const btn of allBtns) {
                        const spans = Array.from(btn.querySelectorAll('span'));
                        const hasXLabel = spans.some(s => s.textContent.trim() === 'Xoá câu lệnh' || (s.textContent.trim().toLowerCase() === 'clear prompt'));
                        const googleIcon = btn.querySelector('i.google-symbols, i[class*="google-symbols"]');
                        if (hasXLabel || (googleIcon && googleIcon.textContent.trim() === 'close')) {
                            const r = btn.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) { btn.click(); return; }
                        }
                    }
                });
            }

            if (hasError) {
                this.log(`Generation failed because Google returned an Error Message...`);
                await page.reload({ waitUntil: 'networkidle2' });
                this.settingsApplied = false;
                await this.sleep(4000);
                throw new Error("MEDIA_GENERATION_FAILED: Generation blocked by Google (Error screen or Network). Auto-reloaded for next attempt.");
            }

            // 5. Download
            const resolution = job.settings?.videoSettings?.resolution || '720p';
            this.log(`Downloading (${job.TYPE_VIDEO === 'IMG' ? 'Image' : 'Video'}) at ${resolution}...`);
            await this.handleDownload(job.VIDEO_NAME, tempOutputDir, outputDir, job.TYPE_VIDEO, targetMediaCoords, resolution);

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

    async handleDownload(targetName, tempOutputDir, finalOutputDir, type, targetMediaCoords = null, resolution = '720p') {
        const page = this.page;

        try {
            const getFiles = () => fs.readdirSync(tempOutputDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
            const before = getFiles();

            if (type === 'IMG') {
                // --- Image: hover → 3-dot menu → Tải xuống → 1K ---
                this.log('Hovering over the latest image to reveal action buttons...');

                // Find the first large visible <img> element (the generated image)
                const imgCard = await page.evaluateHandle(() => {
                    const imgs = Array.from(document.querySelectorAll('img'));
                    for (const img of imgs) {
                        const rect = img.getBoundingClientRect();
                        const src = img.src || '';
                        if (rect.width > 100 && rect.height > 100 && !src.includes('avatar') && !src.includes('logo')) return img;
                    }
                    return null;
                });

                const hasImgCard = await page.evaluate(el => el instanceof Element, imgCard);

                if (targetMediaCoords) {
                    this.log(`Hovering explicit target at x: ${targetMediaCoords.x}, y: ${targetMediaCoords.y}...`);
                    await page.mouse.move(targetMediaCoords.x, targetMediaCoords.y);
                } else {
                    throw new Error('No explicit targetMediaCoords provided for image download.');
                }

                await this.sleep(800);

                // Right-Click to open context menu
                this.log('Right-clicking the image to open context menu...');
                try {
                    if (targetMediaCoords) {
                        this.log(`Targeting exact active generation at x: ${targetMediaCoords.x}, y: ${targetMediaCoords.y}...`);
                        await this.humanClick(page, targetMediaCoords.x, targetMediaCoords.y, { button: 'right' });
                    } else {
                        throw new Error('No valid image target to right-click.');
                    }
                } catch (e) {
                    this.log('Failed to right click image.');
                }
                await this.sleep(1000);

                // Hover "Tải xuống"
                this.log('Hovering "Tải xuống" in image context menu to reveal quality options...');
                let imgDlCoords = await page.evaluate(() => {
                    const items = Array.from(document.querySelectorAll(
                        '[role="menu"] li, [role="menu"] [role="menuitem"], [role="menu"] button'
                    ));
                    for (const item of items) {
                        // We only want elements where the user actually SEES the text "tải xuống", not just a hidden aria-label
                        const t = (item.innerText || '').trim().toLowerCase();
                        if ((t.includes('tải xuống') || t.includes('download')) && !t.includes('tất cả') && !t.includes('all') && !t.includes('zip') && t.length < 50) {
                            const rect = item.getBoundingClientRect();
                            if (rect.width > 70 && rect.height > 10) {
                                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                            }
                        }
                    }
                    return null;
                });

                if (!imgDlCoords) {
                    try {
                        const dlItem = await page.waitForSelector(
                            'xpath///li[contains(., "Tải xuống")] | //*[@role="menuitem"][contains(., "Tải xuống")]',
                            { timeout: 3000 }
                        );
                        if (dlItem) {
                            const box = await dlItem.boundingBox();
                            if (box) imgDlCoords = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                        }
                    } catch (e) { }
                }

                if (!imgDlCoords) throw new Error('Could not find "Tải xuống" in image context menu to hover.');
                await page.mouse.move(imgDlCoords.x, imgDlCoords.y);
                await this.sleep(800);

                // Click "1K" (Original Size) quality
                this.log('Selecting 1K (Original Size) quality for image...');
                let imgQualityCoords = await page.evaluate(() => {
                    const items = Array.from(document.querySelectorAll(
                        '[role="menu"] li, [role="menu"] [role="menuitem"], [role="menu"] button, li, div[role="option"]'
                    ));
                    for (const item of items) {
                        const t = item.textContent.trim();
                        if (t.startsWith('1K') || t.includes('Original')) {
                            const r = item.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                        }
                    }
                    return null;
                });

                if (!imgQualityCoords) {
                    try {
                        const q = await page.waitForSelector(
                            'xpath///*[starts-with(normalize-space(.), "1K")]',
                            { timeout: 3000 }
                        );
                        if (q) {
                            const box = await q.boundingBox();
                            if (box) imgQualityCoords = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                        }
                    } catch (e) { }
                }

                if (imgQualityCoords) {
                    await this.humanClick(page, imgQualityCoords.x, imgQualityCoords.y);
                } else {
                    this.log('Warning: 1K quality selection failed, download may proceed with default quality.');
                }
            } else {

                // --- UI FIX: Collapse text box before hovering ---
                this.log('Clearing text area to prevent UI overlap with download menu...');
                try {
                    const cleared = await page.evaluate(() => {
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
                        this.log('Text area cleared via X button.');
                    } else {
                        this.log('X button not found during download prep (text area may be empty).');
                    }
                } catch (e) { }
                await this.sleep(500);

                // --- Video: hover latest media → 3-dot context menu → Tải xuống → 720p ---
                this.log('Hovering over the latest media item to reveal action buttons...');

                // Find the first large visible media element (video, canvas, or img card)
                const videoCard = await page.evaluateHandle(() => {
                    // 1. Try <video> tags
                    for (const v of Array.from(document.querySelectorAll('video'))) {
                        const r = v.getBoundingClientRect();
                        if (r.width > 100 && r.height > 100) return v;
                    }
                    // 2. Try <canvas> tags (some sites render video on canvas)
                    for (const v of Array.from(document.querySelectorAll('canvas'))) {
                        const r = v.getBoundingClientRect();
                        if (r.width > 100 && r.height > 100) return v;
                    }
                    // 3. Try large <img> that looks like a thumbnail/result
                    for (const v of Array.from(document.querySelectorAll('img'))) {
                        const r = v.getBoundingClientRect();
                        const src = v.src || '';
                        if (r.width > 100 && r.height > 100 && !src.includes('avatar') && !src.includes('logo') && !src.includes('icon')) return v;
                    }
                    // 4. Try a div/section that contains a play button or video icon
                    const playBtns = Array.from(document.querySelectorAll('[aria-label*="play"], [aria-label*="Play"], mat-icon'));
                    for (const btn of playBtns) {
                        if (btn.textContent && btn.textContent.trim() === 'play_circle') {
                            const parent = btn.closest('div[class], section') || btn.parentElement;
                            if (parent) {
                                const r = parent.getBoundingClientRect();
                                if (r.width > 100 && r.height > 100) return parent;
                            }
                        }
                    }
                    return null;
                });

                const hasVideoCard = await page.evaluate(el => el instanceof Element, videoCard);

                if (targetMediaCoords) {
                    this.log(`Hovering explicit target at x: ${targetMediaCoords.x}, y: ${targetMediaCoords.y}...`);
                    await page.mouse.move(targetMediaCoords.x, targetMediaCoords.y);
                } else {
                    // Fallback: move mouse to center of viewport to trigger any hover states
                    this.log('No media element found; moving mouse to center of page as hover fallback...');
                    const viewport = page.viewport();
                    const cx = viewport ? Math.round(viewport.width / 2) : 600;
                    const cy = viewport ? Math.round(viewport.height / 2) : 400;
                    await page.mouse.move(cx, cy);
                }
                await this.sleep(800);

                // Right-Click to open context menu
                this.log('Right-clicking the video to open context menu...');
                try {
                    if (targetMediaCoords) {
                        this.log(`Targeting exact active generation at x: ${targetMediaCoords.x}, y: ${targetMediaCoords.y}...`);
                        await this.humanClick(page, targetMediaCoords.x, targetMediaCoords.y, { button: 'right' });
                    } else {
                        // Fallback: right click center of screen
                        const viewport = page.viewport();
                        const cx = viewport ? Math.round(viewport.width / 2) : 600;
                        const cy = viewport ? Math.round(viewport.height / 2) : 400;
                        await this.humanClick(page, cx, cy, { button: 'right' });
                    }
                } catch (e) {
                    this.log('Failed to right click video.');
                }
                await this.sleep(1000);

                // Hover "Tải xuống" in dropdown
                this.log('Hovering "Tải xuống" in context menu to reveal quality options...');
                let dlMenuCoords = await page.evaluate(() => {
                    const items = Array.from(document.querySelectorAll(
                        '[role="menu"] li, [role="menu"] [role="menuitem"], [role="menu"] button'
                    ));
                    for (const item of items) {
                        // We only want elements where the user actually SEES the text "tải xuống", not just a hidden aria-label
                        const t = (item.innerText || '').trim().toLowerCase();
                        if ((t.includes('tải xuống') || t.includes('download')) && !t.includes('tất cả') && !t.includes('all') && !t.includes('zip') && t.length < 50) {
                            const rect = item.getBoundingClientRect();
                            if (rect.width > 70 && rect.height > 10) {
                                return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                            }
                        }
                    }
                    return null;
                });

                if (!dlMenuCoords) {
                    try {
                        const dlItem = await page.waitForSelector(
                            'xpath///li[contains(., "Tải xuống")] | //*[@role="menuitem"][contains(., "Tải xuống")] | //button[contains(., "Tải xuống")]',
                            { timeout: 3000 }
                        );
                        if (dlItem) {
                            const box = await dlItem.boundingBox();
                            if (box) dlMenuCoords = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                        }
                    } catch (e) { }
                }

                if (!dlMenuCoords) throw new Error('Could not find "Tải xuống" in context menu to hover.');
                await page.mouse.move(dlMenuCoords.x, dlMenuCoords.y);
                await this.sleep(800);

                // Click resolution in quality submenu
                this.log(`Selecting ${resolution} quality...`);
                let qualityCoords = await page.evaluate((resText) => {
                    const items = Array.from(document.querySelectorAll(
                        '[role="menu"] li, [role="menu"] [role="menuitem"], [role="menu"] button, li, div[role="option"]'
                    ));
                    for (const item of items) {
                        const t = item.textContent.trim();
                        if (t.startsWith(resText) || t === resText) {
                            const r = item.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                        }
                    }
                    return null;
                }, resolution);

                if (!qualityCoords) {
                    try {
                        const q = await page.waitForSelector(
                            `xpath///*[starts-with(normalize-space(.), "${resolution}")]`,
                            { timeout: 3000 }
                        );
                        if (q) {
                            const box = await q.boundingBox();
                            if (box) qualityCoords = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                        }
                    } catch (e) { }
                }

                if (qualityCoords) {
                    await this.humanClick(page, qualityCoords.x, qualityCoords.y);
                }
            }

            // Wait for file (shared between IMG and Video)
            this.log(`Waiting for downloaded file (${resolution} upscale)...`);
            let newFile = null;
            let latestTime = 0;
            const maxWaitSeconds = (type !== 'IMG' && resolution === '1080p') ? 130 : 60;
            for (let i = 0; i < maxWaitSeconds; i++) {
                await this.sleep(1000);
                const now = getFiles();
                const diff = now.filter(f => !before.includes(f));
                if (diff.length > 0) {
                    for (const f of diff) {
                        try {
                            const stat = fs.statSync(path.join(tempOutputDir, f));
                            if (stat.mtimeMs > latestTime) { latestTime = stat.mtimeMs; newFile = f; }
                        } catch (e) { }
                    }
                    if (newFile) break;
                }
            }

            if (newFile) {
                this.log(`Downloaded: ${newFile}`);
                const ext = path.extname(newFile);
                const safeName = targetName.replace(/[<>:"/\\|?*]/g, '_');
                const oldPath = path.join(tempOutputDir, newFile);
                const newPath = path.join(finalOutputDir, `${safeName}${ext}`);
                if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
                fs.renameSync(oldPath, newPath);
            } else {
                throw new Error('Download timeout');
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
