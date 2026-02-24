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
                customConfig: {},
                connectOption: { defaultViewport: null }
            };
            options.args.push(`--user-data-dir=${this.profilePath}`);
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

            this.log('Resetting state for new job...');
            try {
                await page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await this.sleep(3000);
            } catch (e) {
                this.log('Navigation took too long, proceeding anyway...');
            }

            const prompt = job.PROMPT;

            // 1. Switch Mode (Video vs Image)
            if (job.TYPE_VIDEO === 'IMG') {
                this.log('Switching to Image mode...');
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="tab"]'));
                    for (const b of btns) {
                        const txt = b.textContent.trim().toLowerCase();
                        if (txt === 'hình ảnh' || txt === 'image') {
                            b.click();
                            break;
                        }
                    }
                });
                await this.sleep(1000);
            } else {
                this.log('Switching to Video mode...');
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, div[role="button"], a[role="tab"]'));
                    for (const b of btns) {
                        const txt = b.textContent.trim().toLowerCase();
                        if (txt === 'video') {
                            b.click();
                            break;
                        }
                    }
                });
                await this.sleep(1000);
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

            this.log(`Typing prompt (Length: ${prompt.length})...`);
            await page.evaluate((selector, text) => {
                const el = document.querySelector(selector);
                el.focus();
                document.execCommand('insertText', false, text);
            }, promptSelector, prompt);
            await this.sleep(1000);

            // 3. Generate
            this.log('Clicking Generate/Submit...');
            let clicked = false;

            // Wait a bit for the button state to stabilize
            await this.sleep(500);

            // Attempt 1: Click the standard "Tạo" / "Generate" text button
            try {
                const generateBtn = await page.waitForSelector('xpath///button[contains(., "Tạo") and not(@disabled)] | //button[contains(., "Generate") and not(@disabled)]', { timeout: 3000 });
                await generateBtn.click();
                clicked = true;
                this.log('Clicked text button.');
            } catch (e) {
                this.log('Text button not found, trying icons...');
            }

            // Attempt 2: Find the submit arrow icon button based on aria-labels or SVG paths
            if (!clicked) {
                clicked = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button:not([disabled])'));
                    for (const btn of buttons) {
                        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                        const svg = btn.querySelector('svg');

                        // Look for typical submit indicators: play arrow, send, submit
                        if (ariaLabel.includes('tạo') || ariaLabel.includes('gửi') || ariaLabel.includes('submit') || ariaLabel.includes('send') || ariaLabel.includes('generate')) {
                            btn.click();
                            return true;
                        }

                        // If it has an SVG and is near the text area (often the last button in the input group)
                        if (svg && btn.closest('div').querySelector('textarea')) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                });
                if (clicked) this.log('Clicked icon button.');
            }

            // Attempt 3: Fallback to pressing Enter inside the textarea
            if (!clicked) {
                this.log('Pressing Enter as fallback...');
                await page.focus(promptSelector);
                // Sometimes shift+enter is new line, and enter is submit.
                // Or ctrl+enter. Standardizing on Enter first.
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
            const possibleBtns = Array.from(document.querySelectorAll('button, a[download]'));
            for (const btn of possibleBtns) {
                const icon = btn.querySelector('i, span[class*="icon"], mat-icon');
                const text = btn.textContent.trim().toLowerCase();
                const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
                const svgTitle = btn.querySelector('svg title');

                if (
                    (icon && (icon.textContent.trim() === 'download' || icon.textContent.trim() === 'file_download')) ||
                    text === 'tải xuống' || text === 'download' || text.includes('tải xuống') ||
                    label.includes('download') || label.includes('tải xuống') ||
                    (svgTitle && (svgTitle.textContent.toLowerCase().includes('download') || svgTitle.textContent.toLowerCase().includes('tải xuống')))
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
                    if (area > 40000 && !img.src.includes('avatar') && !img.src.includes('logo')) {
                        maxArea = area;
                        bestImg = img;
                    }
                }
                if (!bestImg) return null;

                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = bestImg.naturalWidth || bestImg.width || 1024;
                    canvas.height = bestImg.naturalHeight || bestImg.height || 1024;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(bestImg, 0, 0);
                    return { data: canvas.toDataURL('image/png').split(',')[1], ext: '.png' };
                } catch (e) {
                    try {
                        const res = await fetch(bestImg.src);
                        const blob = await res.blob();
                        return new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                resolve({ data: reader.result.split(',')[1], ext: '.png' });
                            };
                            reader.onerror = () => resolve(null);
                            reader.readAsDataURL(blob);
                        });
                    } catch (err) {
                        return null;
                    }
                }
            });

            if (extracted && extracted.data) {
                const safeName = targetName.replace(/[^a-z0-9]/gi, '_');
                const newPath = path.join(outputDir, `${safeName}${extracted.ext}`);
                fs.writeFileSync(newPath, extracted.data, 'base64');
                this.log(`Image extracted directly to: ${newPath}`);
                return; // done
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
        for (let i = 0; i < 60; i++) {
            await this.sleep(1000);
            const now = getFiles();
            const diff = now.filter(f => !before.includes(f));
            if (diff.length > 0) {
                newFile = diff[0];
                break;
            }
        }

        if (newFile) {
            this.log(`Downloaded: ${newFile}`);
            const ext = path.extname(newFile);
            const safeName = targetName.replace(/[^a-z0-9]/gi, '_');
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
