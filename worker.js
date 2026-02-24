const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

class AutomationWorker {
    constructor(id, io) {
        this.id = id;
        this.io = io;
        this.browser = null;
        this.page = null;
        this.isBusy = false;

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
        this.log('Launching browser...');
        try {
            const { connect } = require('puppeteer-real-browser');
            const options = {
                headless: false,
                turnstile: true,
                args: [
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-dev-shm-usage',
                    '--no-first-run',
                    '--no-default-browser-check'
                ],
                customConfig: {
                    userDataDir: this.profilePath
                },
                connectOption: { defaultViewport: null }
            };
            const result = await connect(options);
            this.browser = result.browser;
            this.page = result.page;
        } catch (e) {
            this.log(`Real-browser failed, switching to standard Puppeteer.`);

            // Auto-Download Chrome if missing
            const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(process.env.USER_DATA_PATH || '.', 'puppeteer_cache');
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

            // Create fetcher
            const browserFetcher = puppeteer.createBrowserFetcher({ path: cacheDir });
            const revisionInfo = browserFetcher.revisionInfo(puppeteer.PUPPETEER_REVISIONS.chromium);

            if (!revisionInfo.local) {
                this.log('Downloading Chrome (First Run)... This may take a minute.');
                await browserFetcher.download(puppeteer.PUPPETEER_REVISIONS.chromium, (downloaded, total) => {
                    // Optional: progress logging
                });
                this.log('Download complete.');
            }

            this.browser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                userDataDir: this.profilePath,
                executablePath: revisionInfo.executablePath,
                args: ['--start-maximized']
            });
            this.page = await this.browser.newPage();
        }

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

            // 1. Switch Mode (Video vs Image)
            await page.evaluate(async (isImg) => {
                const targetTexts = isImg ? ['tạo hình ảnh', 'create image'] : ['từ văn bản sang video', 'text to video'];
                const otherTexts = isImg ? ['từ văn bản sang video', 'text to video'] : ['tạo hình ảnh', 'create image'];

                const findElByTextRegex = (texts) => {
                    const all = Array.from(document.querySelectorAll('button, div[role="button"], div[role="combobox"], [role="option"], [role="menuitem"], a[role="tab"], div[class*="chip"]'));
                    for (const el of all) {
                        const txt = el.textContent.trim().toLowerCase();
                        if (txt === 'hình ảnh' || txt === 'image') continue; // Skip top nav
                        if (texts.some(t => txt.includes(t))) return el;
                    }
                    return null;
                };

                // Click the currently active chip to open the menu
                let activeChip = findElByTextRegex([...targetTexts, ...otherTexts]);
                if (activeChip && !activeChip.closest('[role="menu"]')) {
                    const currentTxt = activeChip.textContent.trim().toLowerCase();
                    const alreadyCorrect = targetTexts.some(t => currentTxt.includes(t));

                    if (!alreadyCorrect) {
                        activeChip.click(); // Open menu
                        await new Promise(r => setTimeout(r, 1000));

                        // Find the correct option in the opened menu
                        const menuItems = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] li, [role="listbox"] [role="option"]'));
                        let found = false;
                        for (const item of menuItems) {
                            const itemTxt = item.textContent.trim().toLowerCase();
                            if (targetTexts.some(t => itemTxt.includes(t))) {
                                item.click();
                                found = true;
                                break;
                            }
                        }
                        // Fallback if menu querySelector didn't work
                        if (!found) {
                            const options = findElByTextRegex(targetTexts);
                            if (options) options.click();
                        }
                    }
                } else {
                    // direct fallback
                    const btn = findElByTextRegex(targetTexts);
                    if (btn) btn.click();
                }
            }, job.TYPE_VIDEO === 'IMG');
            this.log(`Switched to ${job.TYPE_VIDEO === 'IMG' ? 'Image' : 'Video'} mode...`);
            await this.sleep(1500);

            // Handle Aspect Ratio (Cỡ) from prompt
            let cleanPrompt = prompt;
            let targetRatio = null;
            if (prompt.includes('16:9') || prompt.includes('16/9')) targetRatio = '16:9';
            else if (prompt.includes('9:16') || prompt.includes('9/16')) targetRatio = '9:16';
            else if (prompt.includes('1:1')) targetRatio = '1:1';
            else if (prompt.includes('4:3') || prompt.includes('4/3')) targetRatio = '4:3';
            else if (prompt.includes('3:4') || prompt.includes('3/4')) targetRatio = '3:4';

            cleanPrompt = prompt.replace(/--ar\s+\d+[:-]\d+/gi, '').replace(/--ar \d+\/\d+/gi, '').trim();

            if (targetRatio) {
                this.log(`Attempting to set Aspect Ratio to ${targetRatio}...`);
                try {
                    await page.evaluate(async (ratio) => {
                        // Find the aspect ratio button (usually next to the model chip, looks like a rectangle or has ratio text)
                        // It may have aria-label like "Tỷ lệ khung hình", "Aspect ratio", "Dimensions"
                        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
                        let ratioBtn = buttons.find(b => {
                            const label = (b.getAttribute('aria-label') || '').toLowerCase();
                            const title = (b.getAttribute('title') || '').toLowerCase();
                            return label.includes('tỷ lệ') || label.includes('aspect') || label.includes('ratio') || label.includes('khung hình') || label.includes(ratio) || title.includes('tỷ lệ');
                        });

                        // If not found by aria-label, try to find by svg or inner text
                        if (!ratioBtn) {
                            ratioBtn = buttons.find(b => b.textContent.includes(ratio));
                        }

                        if (ratioBtn) {
                            ratioBtn.click();
                            await new Promise(r => setTimeout(r, 1000));
                            // Now find the option in the menu
                            const options = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] li, [role="listbox"] [role="option"]'));
                            for (const opt of options) {
                                if (opt.textContent.includes(ratio)) {
                                    opt.click();
                                    break;
                                }
                            }
                        }
                    }, targetRatio);
                    await this.sleep(1000);
                } catch (e) {
                    this.log(`Failed to set aspect ratio: ${e.message}`);
                }
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

            // 4. Wait
            this.log('Waiting for generation (~60s)...');
            await this.sleep(60000);

            // 5. Download
            this.log(`Downloading (${job.TYPE_VIDEO === 'IMG' ? 'Image' : 'Video'})...`);
            await this.handleDownload(job.VIDEO_NAME, outputDir, job.TYPE_VIDEO);

        } catch (e) {
            this.log(`Job Failed: ${e.message}`);
            try {
                if (this.page) {
                    const errorPath = path.join(outputDir, `error_${job.JOB_ID}.png`);
                    await this.page.screenshot({ path: errorPath, fullPage: true });
                    this.log(`Screenshot saved to: ${errorPath}`);
                }
            } catch (err) {
                console.error("Failed to save error screenshot:", err);
            }
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
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = AutomationWorker;
