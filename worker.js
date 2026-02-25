const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Global Mutex for synchronizing UI coordinate clicks across all workers
const uiMutex = {
    isLocked: false,
    queue: [],
    lock: async function () {
        return new Promise(resolve => {
            if (!this.isLocked) {
                this.isLocked = true;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    },
    unlock: function () {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.isLocked = false;
        }
    }
};

class AutomationWorker {
    constructor(id, io, browserType = 'edge') {
        this.id = id;
        this.io = io;
        this.browserType = browserType;
        this.browser = null;
        this.page = null;
        this.isBusy = false;
        this.isOffline = false;

        const baseDir = process.env.USER_DATA_PATH || path.resolve('./user_data');
        this.profilePath = path.join(baseDir, `profile_${id}`);

        if (!fs.existsSync(this.profilePath)) {
            fs.mkdirSync(this.profilePath, { recursive: true });
        }
    }

    log(msg) {
        const message = `[Worker ${this.id}] ${msg}`;
        console.log(message);
        this.io.emit('log', message);
    }

    async launch() {
        this.log(`Launching browser (${this.browserType})...`);

        if (this.browserType === 'chrome') {
            try {
                this.log('Trying puppeteer-real-browser for Chrome...');
                const { connect } = require('puppeteer-real-browser');
                const options = {
                    headless: false,
                    turnstile: true,
                    ignoreAllFlags: true,
                    args: [
                        '--start-maximized',
                        '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
                        '--disable-dev-shm-usage',
                        '--no-first-run',
                        '--no-default-browser-check',
                        '--disable-infobars'
                    ],
                    customConfig: {
                        userDataDir: this.profilePath
                    },
                    connectOption: { defaultViewport: null }
                };
                const result = await connect(options);
                this.browser = result.browser;
                this.page = result.page;

                this.browser.on('disconnected', () => {
                    this.isOffline = true;
                    this.io.emit('worker-status', { id: this.id, status: 'offline' });
                    this.log('Browser disconnected. Worker offline.');
                });

                await this.handleLoginWait();
                return;
            } catch (e) {
                this.log(`puppeteer-real-browser failed: ${e.message}. Falling back to standard Puppeteer.`);
            }
        }

        try {
            // Apply Stealth Plugin for standard launch
            const puppeteerExtra = require('puppeteer-extra');
            const StealthPlugin = require('puppeteer-extra-plugin-stealth');
            puppeteerExtra.use(StealthPlugin());

            // Try finding Microsoft Edge on Windows
            const edgePaths = [
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
            ];
            let executablePath = null;
            for (const ep of edgePaths) {
                if (fs.existsSync(ep)) {
                    executablePath = ep;
                    break;
                }
            }

            if (!executablePath) {
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
            } else {
                this.log(`Using Local Microsoft Edge: ${executablePath}`);
            }

            this.browser = await puppeteerExtra.launch({
                headless: false,
                defaultViewport: null,
                userDataDir: this.profilePath,
                executablePath: executablePath,
                ignoreDefaultArgs: ['--enable-automation'],
                args: [
                    '--start-maximized',
                    '--disable-infobars'
                ]
            });

            this.browser.on('disconnected', () => {
                this.isOffline = true;
                this.io.emit('worker-status', { id: this.id, status: 'offline' });
                this.log('Browser disconnected. Worker offline.');
            });

            this.page = await this.browser.newPage();
        } catch (e) {
            this.log(`Browser launch failed: ${e.message}`);
        }

        await this.handleLoginWait();
    }

    async handleLoginWait() {
        if (!this.page) return;
        try {
            await this.page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'networkidle2' });

            const currentUrl = await this.page.url();
            if (currentUrl.includes('accounts.google.com') || currentUrl.includes('AccountChooser') || currentUrl.includes('signin')) {
                this.log('Login screen detected! You have 3 minutes to login manually.');
                try {
                    await this.page.waitForFunction(
                        'window.location.href.includes("labs.google")',
                        { timeout: 180000, polling: 1000 }
                    );
                    this.log('Login successful! Proceeding...');
                } catch (timeoutErr) {
                    this.log('Login wait timed out after 3 minutes.');
                }
            }
        } catch (e) { }
    }

    getRand(base) {
        return base + Math.floor(Math.random() * 11) - 5;
    }

    async close() {
        if (this.browser) await this.browser.close();
    }

    async processJob(job, outputDir) {
        this.isBusy = true;

        try {
            if (!this.page) await this.launch();
            const page = this.page;

            // Enforce download path directly to outputDir via CDP
            try {
                this.log(`Setting download path to: ${outputDir}`);
                const client = await page.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: outputDir
                });
            } catch (cdpErr) {
                this.log(`Failed to set CDP download path: ${cdpErr.message}`);
            }

            this.log('Resetting state for new job...');
            try {
                const url = await page.url();
                if (!url.includes('https://labs.google/fx/vi/tools/flow')) {
                    await page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
                    this.settingsApplied = false;
                }
                await this.sleep(3000);

                // If we are stuck on the homepage, click "Dự án mới" (New Project)
                const startBtn = await page.evaluateHandle(() => {
                    const xpath = '//div[contains(text(), "Dự án mới")] | //button[contains(., "Dự án mới")] | //div[contains(text(), "New Project")]';
                    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    return result.singleNodeValue;
                });
                if (startBtn && startBtn.click) {
                    const inputVisible = await page.$('#PINHOLE_TEXT_AREA_ELEMENT_ID');
                    if (!inputVisible) {
                        this.log('Clicking New Project...');
                        await startBtn.click();
                        await this.sleep(3000);
                    }
                }
            } catch (e) {
                this.log('Navigation took too long, proceeding anyway...');
            }

            const prompt = job.PROMPT;

            // 1. Switch Mode

            // Coordinate Map from User UI Recorder
            // LƯU Ý: NẾU MUỐN SỬ DỤNG TỌA ĐỘ CỐ ĐỊNH CHO CÁC NÚT TRONG BẢNG CÀI ĐẶT, 
            // BẠN PHẢI GHI LẠI TỌA ĐỘ LÚC BẢNG CÀI ĐẶT ĐÃ MỞ VÀ HIỂN THỊ Ở GIỮA MÀN HÌNH!
            const coords = {
                modes: {
                    'T2V': { x: 709, y: 605 },
                    'I2V': { x: 724, y: 650 },
                    'IN2V': { x: 719, y: 692 },
                    'IMG': { x: 703, y: 736 },
                    trigger_t2v: { x: 723, y: 792 }
                },
                settingsBtn: { x: 1230, y: 792 },
                ratio: {
                    trigger: { x: 901, y: 604 },
                    '9:16': { x: 895, y: 539 },
                    '16:9': { x: 899, y: 495 },
                    '1:1': { x: 935, y: 839 },
                    '4:3': { x: 935, y: 839 }
                },
                count: {
                    trigger: { x: 1128, y: 607 },
                    '1': { x: 1124, y: 408 },
                    '2': { x: 1123, y: 451 },
                    '3': { x: 1125, y: 494 },
                    '4': { x: 1128, y: 538 }
                },
                model: {
                    trigger: { x: 998, y: 684 },
                    'Veo 3.1 - Fast [Lower Priority]': { x: 998, y: 439 },
                    'Veo 3.1 - Fast': { x: 932, y: 381 },
                    'Nano Banana Pro': { x: 1020, y: 611 }
                }
            };

            // 1. Switch Mode Strategy
            await uiMutex.lock();
            try {
                try {
                    this.log(`Attempting to switch to mode ${job.TYPE_VIDEO}...`);

                    // Click somewhere safe to close any open menus first.
                    await page.mouse.click(this.getRand(150), this.getRand(788));
                    await this.sleep(500);

                    // Open the Mode selector using the explicit recorded coordinate
                    this.log(`Opening mode selector at ${coords.modes.trigger_t2v.x}, ${coords.modes.trigger_t2v.y}`);
                    await page.mouse.click(this.getRand(coords.modes.trigger_t2v.x), this.getRand(coords.modes.trigger_t2v.y));
                    await this.sleep(1000);

                    if (coords.modes[job.TYPE_VIDEO]) {
                        this.log(`Selecting mode ${job.TYPE_VIDEO} at ${coords.modes[job.TYPE_VIDEO].x}, ${coords.modes[job.TYPE_VIDEO].y}`);
                        await page.mouse.click(this.getRand(coords.modes[job.TYPE_VIDEO].x), this.getRand(coords.modes[job.TYPE_VIDEO].y));
                    } else {
                        this.log(`Warning: Coordinate for mode ${job.TYPE_VIDEO} not found in map. Escaping mode switch.`);
                        await page.mouse.click(this.getRand(150), this.getRand(788)); // Escape
                    }

                    await this.sleep(1500);

                } catch (e) {
                    this.log(`Mode switch non-fatal error: ${e.message}`);
                }

                this.log(`Switched to mode ${job.TYPE_VIDEO}...`);
                await this.sleep(1500);

                // Clean prompt
                let cleanPrompt = prompt.replace(/--ar\s+\d+[:-]\d+/gi, '').replace(/--ar \d+\/\d+/gi, '').trim();

                const settings = job.settings || {};
                const isImg = job.TYPE_VIDEO === 'IMG';
                const currentSettings = isImg ? settings.imgSettings : settings.videoSettings;

                const currentSettingsString = JSON.stringify(currentSettings);

                if (currentSettings && (!this.settingsApplied || this.lastAppliedSettingsString !== currentSettingsString)) {
                    this.log(`Applying settings for ${job.TYPE_VIDEO} via Explicit Coordinates with Randomness...`);
                    try {
                        // 1. Click Settings Button
                        this.log(`Opening Settings modal (clicking ${coords.settingsBtn.x}, ${coords.settingsBtn.y})`);
                        await page.mouse.click(this.getRand(coords.settingsBtn.x), this.getRand(coords.settingsBtn.y));
                        await this.sleep(2000);

                        try {
                            // Debug screenshot removed by user request
                            // const sPath = path.join(outputDir, `debug_settings_${job.JOB_ID}.png`);
                            // await page.screenshot({ path: sPath });
                            // this.log(`Debug Settings Screenshot saved to ${sPath}`);
                        } catch (e) { }

                        const applyStrictCoordSetting = async (labelKeyword, optionsCoordMap, settingValue) => {
                            if (!settingValue) return;
                            this.log(`Attempting to apply setting [${labelKeyword}] = ${settingValue} using strict coords...`);

                            if (!optionsCoordMap.trigger) {
                                this.log(`No trigger coordinate defined for [${labelKeyword}]. Skipping.`);
                                return;
                            }

                            // 1. Click Trigger
                            this.log(`Clicking [${labelKeyword}] trigger at ${optionsCoordMap.trigger.x}, ${optionsCoordMap.trigger.y}`);
                            await page.mouse.click(this.getRand(optionsCoordMap.trigger.x), this.getRand(optionsCoordMap.trigger.y));
                            await this.sleep(1500);

                            // 2. Click Option
                            const mappedCoord = optionsCoordMap[settingValue];
                            if (mappedCoord) {
                                this.log(`Clicking mapped option coord for ${settingValue} at ${mappedCoord.x}, ${mappedCoord.y}`);
                                await page.mouse.click(this.getRand(mappedCoord.x), this.getRand(mappedCoord.y));
                            } else {
                                this.log(`No exact mapped coord for ${settingValue}. Clicking trigger again to close dropdown.`);
                                await page.mouse.click(this.getRand(optionsCoordMap.trigger.x), this.getRand(optionsCoordMap.trigger.y));
                            }
                            await this.sleep(1500);
                        };

                        await applyStrictCoordSetting('Tỷ lệ', coords.ratio, currentSettings.ratio);
                        await applyStrictCoordSetting('Đầu ra', coords.count, currentSettings.count?.toString());
                        await applyStrictCoordSetting('Mô hình', coords.model, currentSettings.model);

                        // Verify Settings before closing
                        this.log(`Verifying applied settings before proceeding...`);
                        const verificationResult = await page.evaluate((expected) => {
                            const triggerTexts = Array.from(document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button'))
                                .map(el => el.textContent.trim().toLowerCase());

                            const allTexts = triggerTexts.concat(Array.from(document.querySelectorAll('span')).map(el => el.textContent.trim().toLowerCase()));

                            let missing = [];

                            if (expected.ratio) {
                                const ratioMatch = allTexts.some(t => t.includes(expected.ratio.toLowerCase()));
                                if (!ratioMatch) missing.push(`Ratio: ${expected.ratio}`);
                            }

                            if (expected.model) {
                                const modelStr = expected.model.toLowerCase().replace(' [lower priority]', '');
                                const modelMatch = allTexts.some(t => t.includes(modelStr));
                                if (!modelMatch) missing.push(`Model: ${expected.model}`);
                            }

                            if (expected.count) {
                                const countStr = expected.count.toString();
                                const countMatch = allTexts.some(t => t === countStr || t === `x${countStr}` || t.includes(`${countStr} đầu ra`));
                                if (!countMatch) missing.push(`Count: ${expected.count}`);
                            }

                            return missing;
                        }, currentSettings);

                        if (verificationResult.length > 0) {
                            this.log(`Settings Verification Failed! Missing/Mismatched values: ${verificationResult.join(', ')}. Reloading page...`);
                            await page.evaluate(() => window.location.reload());
                            await this.sleep(4000);
                            this.settingsApplied = false;
                            throw new Error(`Settings Verification Failed! Missing/Mismatched values: ${verificationResult.join(', ')}. Generating will be aborted.`);
                        } else {
                            this.log(`Settings Verification Passed!`);
                        }

                        // Close Settings
                        await page.mouse.click(this.getRand(950), this.getRand(788));
                        await this.sleep(1500);

                        this.settingsApplied = true;
                        this.lastAppliedSettingsString = currentSettingsString;
                    } catch (e) {
                        this.log(`Failed to apply explicit coord settings: ${e.message}`);
                        throw e; // Bubble up error so job fails and prompt is not generated
                    }
                } else if (currentSettings) {
                    this.log(`Settings generation skipped (Already configured for ${job.TYPE_VIDEO}).`);
                }

                // 2. Input
                const promptSelector = '#PINHOLE_TEXT_AREA_ELEMENT_ID';
                try {
                    await page.waitForSelector(promptSelector, { timeout: 10000 });
                } catch (e) {
                    this.log(`Failed to find text area: ${e.message}`);
                    throw new Error("Text area not found. Is login required?");
                }

                await page.click(promptSelector);
                await page.evaluate((selector) => {
                    document.querySelector(selector).value = '';
                }, promptSelector);
                await this.sleep(400);

                this.log(`Typing prompt (Length: ${cleanPrompt.length})...`);
                await page.evaluate((selector, text) => {
                    const el = document.querySelector(selector);
                    el.focus();
                    document.execCommand('insertText', false, text);
                }, promptSelector, cleanPrompt);
                await this.sleep(1000);

                // 3. Generate
                this.log('Clicking Generate/Submit...');
                let clicked = false;

                // Wait a bit for the button state to stabilize
                await this.sleep(500);

                // Attempt 1: Find the floating circle arrow button near the text area
                clicked = await page.evaluate((selector) => {
                    const textarea = document.querySelector(selector);
                    if (!textarea) return false;

                    // The submit button is typically inside a container right next to the textarea
                    const fieldContainer = textarea.closest('div[style*="border-radius"], div[class*="container"]') || textarea.parentElement.parentElement;
                    if (!fieldContainer) return false;

                    const buttons = Array.from(fieldContainer.querySelectorAll('button:not([disabled]), div[role="button"]:not([disabled])'));

                    // specifically look for the button with the arrow SVG or use it if it's the last icon button
                    let submitBtn = null;
                    for (const btn of buttons) {
                        const svgs = btn.querySelectorAll('svg');
                        for (const svg of svgs) {
                            const path = svg.innerHTML || '';
                            // Looking for arrow-forward path specifically 
                            if (path.includes('arrow_forward') || path.includes('M5 13h11.17l-4.88 4.88c-.39.39-.39 1.03') || path.includes('m12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z') || path.includes('M2.01 21 23 12 2.01 3 2 10l15 2-15 2z')) {
                                submitBtn = btn;
                                break;
                            }
                        }
                        if (submitBtn) break;
                    }

                    // If no exact SVG match, the submit button is almost always the LAST circular icon button in the container
                    if (!submitBtn) {
                        const iconButtons = buttons.filter(b => b.textContent.replace(/\s/g, '') === '' && b.querySelector('svg'));
                        if (iconButtons.length > 0) {
                            submitBtn = iconButtons[iconButtons.length - 1]; // The one on the far right
                        }
                    }

                    if (submitBtn) {
                        submitBtn.click();
                        return true;
                    }

                    return false;
                }, promptSelector);

                if (clicked) {
                    this.log('Clicked submit arrow button.');
                } else {
                    this.log('Pressing Enter as fallback...');
                    // The most reliable fallback is to focus the text area, move to end, and press Enter
                    await page.focus(promptSelector);
                    await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        el.selectionStart = el.selectionEnd = el.value.length;
                    }, promptSelector);
                    await page.keyboard.press('Enter');
                }

                // 4. Wait & Handle Errors during Generation
            } catch (uiErr) {
                this.log(`UI Interaction Error: ${uiErr.message}`);
                throw uiErr;
            } finally {
                // Release the lock immediately after clicking generate so other workers can start configuring
                uiMutex.unlock();
                this.log('Released UI lock. Background generation beginning...');
            }

            this.log('Waiting for generation (~60s)...');
            let generationStartedTime = Date.now();
            let hasError = false;

            // Wait 90s for video, 60s for images
            const waitSeconds = job.TYPE_VIDEO === 'IMG' ? 60 : 90;
            this.log(`Waiting up to ${waitSeconds} seconds for generation to complete...`);

            for (let i = 0; i < waitSeconds; i++) {
                await this.sleep(1000);

                // Check if the "Đã xảy ra lỗi" (Error occurred) dialog/text appeared
                const errorFound = await page.evaluate(() => {
                    const texts = Array.from(document.querySelectorAll('div, span, h1, h2, h3, h4, p'));
                    return texts.some(el => el.textContent.trim() === 'Đã xảy ra lỗi.' || el.textContent.trim() === 'Something went wrong.' || el.textContent.includes('Đã xảy ra lỗi'));
                });

                if (errorFound) {
                    this.log('Detected Google error message ("Đã xảy ra lỗi"). Refreshing page and retrying...');
                    hasError = true;
                    break;
                }

                // If it successfully downloads or finishes, we'll just wait out the loop or break early if we implement progress tracking
                // For now, simple fixed wait is fine if no error is seen. We wait the full assigned seconds.
            }

            if (hasError) {
                await page.reload({ waitUntil: 'networkidle2' });
                this.settingsApplied = false;
                await this.sleep(5000);
                throw new Error("Generation blocked by Google (Error screen). Auto-reloaded for next attempt.");
            }

            // 5. Download
            this.log(`Downloading (${job.TYPE_VIDEO === 'IMG' ? 'Image' : 'Video'})...`);
            await this.handleDownload(job.VIDEO_NAME, outputDir, job.TYPE_VIDEO);

        } catch (e) {
            this.log(`Job Failed: ${e.message}`);
            throw e;
        } finally {
            this.isBusy = false;
        }
    }

    async checkNewProject() {
        // Obsolete as we reload the page entirely now, but keep for compatibility if called elsewhere
    }

    async handleDownload(targetName, outputDir, type) {
        const page = this.page;

        // Try to find Download Button ANYWHERE on the page
        let dlBtn = await page.evaluateHandle(() => {
            const possibleBtns = Array.from(document.querySelectorAll('button, a[download], div[role="button"], a[role="button"]'));
            for (const btn of possibleBtns) {
                const icon = btn.querySelector('i, span[class*="icon"], mat-icon');
                const text = btn.textContent.trim().toLowerCase();
                const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
                const svgTitle = btn.querySelector('svg title');

                // check internal svgs for common download paths
                let hasDownloadSvg = false;
                const svgs = btn.querySelectorAll('svg');
                for (const svg of svgs) {
                    if (svg.innerHTML.includes('M19 9h-4V3H9v6H5l7 7 7-7z') || svg.innerHTML.includes('cloud_download')) {
                        hasDownloadSvg = true;
                    }
                }

                if (
                    (icon && (icon.textContent.trim() === 'download' || icon.textContent.trim() === 'file_download')) ||
                    text === 'tải xuống' || text === 'download' || text.includes('tải xuống') ||
                    label.includes('download') || label.includes('tải xuống') ||
                    (svgTitle && (svgTitle.textContent.toLowerCase().includes('download') || svgTitle.textContent.toLowerCase().includes('tải xuống'))) ||
                    hasDownloadSvg
                ) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) return btn;
                }
            }
            return null;
        });

        const isElement = await page.evaluate(el => el instanceof Element, dlBtn);

        // EXTRACTION FALLBACK FOR IMAGES IF NO BUTTON
        if (!isElement && type === 'IMG') {
            this.log('Download button not found. Attempting direct Image extraction...');
            const extracted = await page.evaluate(async () => {
                const imgs = Array.from(document.querySelectorAll('img'));
                let bestImg = null;
                let maxArea = 0;
                for (const img of imgs) {
                    const rect = img.getBoundingClientRect();
                    const area = rect.width * rect.height;
                    const src = img.src || '';
                    if (area > 40000 && !src.includes('avatar') && !src.includes('logo')) {
                        maxArea = area;
                        bestImg = img;
                    }
                }
                if (!bestImg) return null;

                // Try fetching if it's a blob url or standard image to bypass canvas CORS
                if (bestImg.src.startsWith('blob:') || bestImg.src.startsWith('http')) {
                    try {
                        const res = await fetch(bestImg.src);
                        const blob = await res.blob();
                        const reader = new FileReader();
                        return await new Promise(resolve => {
                            reader.onloadend = () => {
                                resolve({ data: reader.result.split(',')[1], ext: '.png' });
                            };
                            reader.readAsDataURL(blob);
                        });
                    } catch (e) {
                        console.log('Fetch failed, falling back to canvas', e);
                    }
                }

                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = bestImg.naturalWidth || bestImg.width || 1024;
                    canvas.height = bestImg.naturalHeight || bestImg.height || 1024;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(bestImg, 0, 0);
                    return { data: canvas.toDataURL('image/png').split(',')[1], ext: '.png' };
                } catch (e) {
                    return { url: bestImg.src };
                }
            });

            if (extracted && extracted.data) {
                const safeName = targetName.replace(/[<>:"/\\|?*]/g, '_');
                const newPath = path.join(outputDir, `${safeName}${extracted.ext}`);
                fs.writeFileSync(newPath, extracted.data, 'base64');
                this.log(`Image extracted directly to: ${newPath}`);
                return; // done
            } else if (extracted && extracted.url) {
                this.log(`Image extraction blocked by CORS. Need to download URL from Node: ${extracted.url}`);
                // Since this is just a quick workaround, we will just fail and let the screenshot show the issue
            }
            throw new Error("Download button not found and direct image extraction failed.");
        }

        if (!isElement) throw new Error("Download button not found");

        await uiMutex.lock();
        try {
            const getFiles = () => fs.readdirSync(outputDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
            const before = getFiles();

            await dlBtn.click();
            await this.sleep(1000);

            if (type === 'IMG') {
                this.log('Selecting resolution...');
                try {
                    const menuSelector = 'div[role="menu"]';
                    try {
                        await page.waitForSelector(menuSelector, { timeout: 3000 });
                        const item = await page.evaluateHandle(() => {
                            const items = Array.from(document.querySelectorAll('div[role="menu"] li, div[role="menu"] div[role="menuitem"]'));
                            for (const it of items) {
                                if (it.textContent.includes('1K') || it.textContent.includes('Original') || it.textContent.includes('High')) return it;
                            }
                            return items[0];
                        });
                        if (item) await item.click();
                    } catch (e) { }
                } catch (e) { }
            } else {
                try {
                    const quality = await page.waitForSelector('xpath///div[contains(text(), "720p")] | //span[contains(text(), "720p")]', { timeout: 3000 });
                    if (quality) await quality.click();
                } catch (e) { }
            }

            this.log('Waiting for file system...');
            let newFile = null;
            let latestTime = 0;

            for (let i = 0; i < 60; i++) {
                await this.sleep(1000);
                const now = getFiles();
                const diff = now.filter(f => !before.includes(f));

                if (diff.length > 0) {
                    // If there are multiple new files, pick the most recently modified one
                    for (const f of diff) {
                        try {
                            const stat = fs.statSync(path.join(outputDir, f));
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
                this.log(`Downloaded: ${newFile}`);
                const ext = path.extname(newFile);
                const safeName = targetName.replace(/[<>:"/\\|?*]/g, '_');
                const oldPath = path.join(outputDir, newFile);
                const newPath = path.join(outputDir, `${safeName}${ext}`);

                if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
                fs.renameSync(oldPath, newPath);
            } else {
                throw new Error("Download timeout");
            }
        } finally {
            uiMutex.unlock();
        }
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = AutomationWorker;
