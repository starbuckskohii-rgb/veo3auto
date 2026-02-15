const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

class AutomationWorker {
    constructor(id, io) {
        this.id = id;
        this.io = io;
        this.browser = null;
        this.page = null;
        this.isBusy = false;
        this.profilePath = path.resolve(`./user_data/profile_${id}`);
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
            this.log('Real-browser failed, using standard puppeteer.');
            this.browser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                userDataDir: this.profilePath,
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
        if (!this.page) await this.launch();
        this.isBusy = true;

        try {
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
            await page.waitForSelector('article, div[data-testid="video-card"]', { timeout: 15000 });
            const cards = await page.$$('article, div[data-testid="video-card"]');
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
                const icon = btn.querySelector('i');
                if (icon && icon.textContent.trim() === 'download') return btn;
                const text = btn.textContent.trim().toLowerCase();
                if (text.includes('tải xuống') || text.includes('download')) return btn;
                if (btn.getAttribute('aria-label')?.includes('Download') || btn.getAttribute('aria-label')?.includes('Tải xuống')) return btn;
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
            this.log('Selecting 1K resolution...');
            const option1K = await page.waitForSelector('xpath///div[contains(text(), "1K")] | //span[contains(text(), "1K")] | //li[contains(text(), "1K")]', { timeout: 5000 });
            if (option1K) {
                await option1K.click();
            } else {
                this.log("Warning: 1K option not found, checking if download started automatically...");
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
