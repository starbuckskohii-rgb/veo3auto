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
            const prompt = job.PROMPT;

            // 1. New Project Check
            await this.checkNewProject();

            // 2. Input (Thread-Safe / No Clipboard)
            const promptSelector = '#PINHOLE_TEXT_AREA_ELEMENT_ID';
            try {
                await page.waitForSelector(promptSelector, { timeout: 5000 });
            } catch (e) {
                await this.checkNewProject();
                await page.waitForSelector(promptSelector);
            }

            // Focus and Clear
            await page.click(promptSelector);
            await page.evaluate((selector) => {
                document.querySelector(selector).value = '';
            }, promptSelector);
            await this.sleep(400);

            // Thread-Safe Insert
            this.log(`Typing prompt (Length: ${prompt.length})...`);
            await page.evaluate((selector, text) => {
                const el = document.querySelector(selector);
                el.focus();
                document.execCommand('insertText', false, text);
            }, promptSelector, prompt);

            await this.sleep(1000);

            // 3. Generate
            this.log('Clicking Generate...');
            const generateBtn = await page.waitForSelector('xpath///button[contains(., "Tạo") and not(@disabled)] | //button[contains(., "Generate") and not(@disabled)]', { timeout: 10000 });
            await generateBtn.click();

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
        try {
            const startBtn = await this.page.evaluateHandle(() => {
                const xpath = '//div[contains(text(), "Dự án mới")] | //button[contains(., "Dự án mới")] | //div[contains(text(), "New Project")]';
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue;
            });
            if (startBtn && startBtn.click) {
                const inputVisible = await this.page.$('#PINHOLE_TEXT_AREA_ELEMENT_ID');
                if (!inputVisible) {
                    await startBtn.click();
                    await this.sleep(3000);
                }
            }
        } catch (e) { }
    }

    async handleDownload(targetName, outputDir, type) {
        const page = this.page;

        // Find Card (Last one)
        let card = null;
        try {
            const selector = 'article, div[data-testid="video-card"], div[data-testid="image-card"], div[class*="VisualCard"]';
            await page.waitForSelector(selector, { timeout: 30000 });
            const cards = await page.$$(selector);
            if (cards.length > 0) {
                card = cards[cards.length - 1];
            }
        } catch (e) {
            throw new Error("No content generated found.");
        }

        if (!card) throw new Error("Card not found");

        try { await card.hover(); } catch (e) { }
        await this.sleep(1000);

        // Download Button
        let dlBtn = await card.evaluateHandle(cardEl => {
            const buttons = Array.from(cardEl.querySelectorAll('button'));
            for (const btn of buttons) {
                // 1. Icon Text
                const icon = btn.querySelector('i, span[class*="icon"]');
                if (icon && (icon.textContent.trim() === 'download' || icon.textContent.trim() === 'file_download')) return btn;

                // 2. Button Text
                const text = btn.textContent.trim().toLowerCase();
                if (text.includes('tải xuống') || text.includes('download')) return btn;

                // 3. Aria Label / Title
                const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
                if (label.includes('download') || label.includes('tải xuống')) return btn;

                // 4. SVG Title?
                const svgTitle = btn.querySelector('svg title');
                if (svgTitle && (svgTitle.textContent.toLowerCase().includes('download') || svgTitle.textContent.toLowerCase().includes('tải xuống'))) return btn;
            }
            return null;
        });

        const isElement = await page.evaluate(el => el instanceof Element, dlBtn);
        if (!isElement) throw new Error("Download button not found");

        const getFiles = () => fs.readdirSync(outputDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
        const before = getFiles();

        await dlBtn.click();
        await this.sleep(1000);

        // Logic branching
        if (type === 'IMG') {
            this.log('Selecting resolution...');
            try {
                // Try 1K first, then generic "Download" or "Tải xuống" in menu
                // Sometimes it's just a direct download, but if a menu appears:
                const menuSelector = 'div[role="menu"]';
                try {
                    await page.waitForSelector(menuSelector, { timeout: 3000 });
                    // Click the item containing "1K" or just the first item if it looks like a download option
                    const item = await page.evaluateHandle(() => {
                        const items = Array.from(document.querySelectorAll('div[role="menu"] li, div[role="menu"] div[role="menuitem"]'));
                        for (const it of items) {
                            if (it.textContent.includes('1K') || it.textContent.includes('Original') || it.textContent.includes('High')) return it;
                        }
                        return items[0]; // Fallback to first item
                    });
                    if (item) await item.click();
                } catch (e) {
                    // No menu? Maybe direct download started.
                }
            } catch (e) {
                this.log("Warning: Resolution selection failed, assuming download started.");
            }
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
