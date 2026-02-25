const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

// Load Prompts from Excel (using the shared helper logic)
const xlsx = require('xlsx');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
    // 1. Ask for Excel File
    let excelPath = '';
    while (!excelPath) {
        try {
            console.log('Attempting to open file dialog...');
            // Use Powershell to open a file dialog
            const cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'Excel Files (*.xlsx)|*.xlsx'; $f.ShowDialog() | Out-Null; $f.FileName"`;
            const output = execSync(cmd).toString().trim();
            if (output && fs.existsSync(output)) {
                excelPath = output;
            } else {
                console.log('File dialog did not return a path (or failed).');
                // Fallback to manual input or drag-drop (simulated by reading from stdin or just hardcoded path for testing if this fails)
                // For now, let's ask user to paste path
                const readline = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                excelPath = await new Promise(resolve => {
                    readline.question('Please paste the full path to your Excel file (or drag and drop it here): ', (answer) => {
                        readline.close();
                        resolve(answer.replace(/"/g, '').trim());
                    });
                });
            }
        } catch (e) {
            console.log('Error picking file:', e.message);
        }
    }
    console.log(`Selected Excel: ${excelPath}`);

    // 2. Ask for Output Directory
    let outputDir = '';
    while (!outputDir) {
        try {
            console.log('Attempting to open folder dialog...');
            const cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog() | Out-Null; $f.SelectedPath"`;
            const output = execSync(cmd).toString().trim();
            if (output && fs.existsSync(output)) {
                outputDir = output;
            } else {
                console.log('Folder dialog did not return a path.');
                const readline = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                outputDir = await new Promise(resolve => {
                    readline.question('Please paste the full path to your Output folder: ', (answer) => {
                        readline.close();
                        resolve(answer.replace(/"/g, '').trim());
                    });
                });
            }
        } catch (e) {
            console.log('Error picking folder:', e.message);
        }
    }
    console.log(`Selected Output: ${outputDir}`);


    // Read Excel
    const workbook = xlsx.readFile(excelPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: "A" }); // Use A, B, C...

    // Filter for prompts (Col B)
    // Assume Col B is prompt, Col G is Name (from user instruction: "lấy prompt ở cột B và tên ở cột G")
    const prompts = data.map(row => ({
        prompt: row['B'],
        name: row['G']
    })).filter(p => p.prompt);

    console.log(`Found ${prompts.length} items (Prompts in Col B, Names in Col G).`);

    // 3. Launch Browser using puppeteer-real-browser
    console.log('Launching browser (Real Browser Mode)...');

    let browser, page;
    try {
        const { connect } = require('puppeteer-real-browser');
        const options = {
            headless: false,
            turnstile: true,
            ignoreAllFlags: true,
            args: [
                '--start-maximized',
                '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-default-browser-check',
                '--no-zygote',
                '--disable-infobars'
            ],
            customConfig: {},
            connectOption: {
                defaultViewport: null
            }
        };

        // Use a different user data dir to avoid conflicts or use existing one carefully
        options.args.push(`--user-data-dir=${path.resolve('./user_data')}`);

        const result = await connect(options);
        browser = result.browser;
        page = result.page;

    } catch (e) {
        console.error('Failed to launch real browser:', e);
        console.log('Falling back to standard puppeteer...');
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            userDataDir: './user_data',
            args: ['--start-maximized']
        });
        page = await browser.newPage();
    }

    // Enable download behavior
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: outputDir,
    });

    try {
        await page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'networkidle2' });
    } catch (e) {
        console.log('Navigation error:', e.message);
    }

    // Helper to copy to clipboard on Windows
    function copyToClipboard(text) {
        const tempFile = path.resolve('./temp_clipboard.txt');
        try {
            fs.writeFileSync(tempFile, text);
            execSync(`powershell -NoProfile -Command "Get-Content -LiteralPath '${tempFile}' -Encoding UTF8 | Set-Clipboard"`);
            fs.unlinkSync(tempFile);
        } catch (e) {
            console.error('Clipboard error:', e);
        }
    }

    // Process prompts
    console.log('Looking for "New Project" button...');
    try {
        // Try multiple selectors for New Project
        const selectors = [
            'xpath///div[contains(text(), "Dự án mới")]',
            'xpath///button[contains(., "Dự án mới")]',
            'xpath///div[contains(text(), "New Project")]',
            'xpath///button[contains(., "New Project")]',
            'button[aria-label="Create new project"]',
            'button[aria-label="Tạo dự án mới"]',
            // Generic fallback: check known classes if possible, but Xpath is usually safer for text
        ];

        let newProjectBtn = null;
        for (const sel of selectors) {
            try {
                newProjectBtn = await page.waitForSelector(sel, { timeout: 2000 });
                if (newProjectBtn) break;
            } catch (e) { }
        }

        if (newProjectBtn) {
            await newProjectBtn.click();
            console.log('Clicked "New Project". Waiting for editor...');
            await sleep(5000);
        } else {
            console.log('"New Project" button not found. Assuming already in editor.');
        }
    } catch (e) {
        console.log('Error looking for New Project:', e.message);
    }

    const promptSelector = '#PINHOLE_TEXT_AREA_ELEMENT_ID';

    try {
        await page.waitForSelector(promptSelector, { timeout: 60000 });
    } catch (e) {
        console.log('Could not find prompt input. Are you logged in?');
        console.log('Please log in manually if needed.');
        await page.waitForSelector(promptSelector, { timeout: 0 }); // Wait indefinitely
    }

    // Process prompts
    for (let i = 0; i < prompts.length; i++) {
        const item = prompts[i];
        const prompt = item.prompt;
        const targetName = item.name ? item.name.toString().trim() : `video_${Date.now()}`;

        console.log(`Processing [${i + 1}/${prompts.length}]: "${targetName}"`);

        try {
            // Click input to focus
            await page.click(promptSelector);
            await sleep(500);

            // Clear input (Ctrl+A -> Backspace)
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await sleep(500);

            // Copy prompt to clipboard
            copyToClipboard(prompt);

            // Paste (Ctrl+V)
            await page.keyboard.down('Control');
            await page.keyboard.press('V');
            await page.keyboard.up('Control');

            await sleep(2000);

            // Count video items before generation to identify the new one
            // We assume video items have a specific class or structure. 
            // Based on observation, they are likely blocks in a container.
            // Let's try to find a generic selector for video/image cards.
            const getVideoCount = async () => {
                return await page.$$eval('div[data-testid="video-card"], div[class*="VideoCard"], article, div[role="article"]', els => els.length);
            };

            // Check for EN "Generate" or VI "Tạo"
            const generateBtn = await page.waitForSelector('xpath///button[contains(., "Tạo") and not(@disabled)] | //button[contains(., "Generate") and not(@disabled)]', { timeout: 10000 }).catch(() => null);

            if (!generateBtn) {
                console.log('Generate button not found or disabled.');
                continue;
            }

            await generateBtn.click();
            console.log('Clicked Generate...');

            // WAIT FOR GENERATION
            // Increased to 90 seconds as requested
            console.log('Waiting for generation (approx 90s)...');
            await sleep(90000);

            // CHECK FOR FAILURE & RETRY
            try {
                const failureSelector = 'xpath///div[contains(text(), "Không tạo được") or contains(text(), "failed")]';
                // Use shorter timeout for failure check
                const failedElement = await page.waitForSelector(failureSelector, { timeout: 5000 }).catch(() => null);

                if (failedElement) {
                    console.log('Generation failed ("Không tạo được"). Attempting Retry...');

                    // Find retry button near the failure text
                    // We need to evaluate in browser context to be safe and avoid handle issues
                    const retrySuccess = await page.evaluate((failEl) => {
                        if (!failEl) return false;
                        const parent = failEl.parentElement;
                        // Start looking for buttons in parent or grand-parent
                        let container = parent;
                        let buttons = container.querySelectorAll('button');
                        if (buttons.length === 0 && container.parentElement) {
                            container = container.parentElement;
                            buttons = container.querySelectorAll('button');
                        }

                        // Heuristic: The retry button usually has an svg icon of a refresh arrow
                        // Or aria-label "Retry" / "Thử lại"
                        for (const btn of buttons) {
                            if (btn.innerText === "Retry" || btn.innerText === "Thử lại") {
                                btn.click();
                                return true;
                            }
                            const aria = btn.getAttribute('aria-label') || "";
                            if (aria.includes("Retry") || aria.includes("Thử lại")) {
                                btn.click();
                                return true;
                            }
                            // Check for SVG?
                            if (btn.querySelector('svg')) {
                                // Potentially the retry button if it's not the 3-dots (More)
                                // And usually not "Add to scene"
                                // And usually to the left of "More"
                                if (!aria.includes("More") && !aria.includes("Khác") && !aria.includes("Add") && !aria.includes("Thêm")) {
                                    btn.click();
                                    return true;
                                }
                            }
                        }
                        return false;
                    }, failedElement);

                    if (retrySuccess) {
                        console.log('Clicked Retry button (in page context).');
                        await sleep(3000); // Wait for prompt to refill

                        // Click Generate again
                        const genBtnRetry = await page.waitForSelector('xpath///button[contains(., "Tạo") and not(@disabled)] | //button[contains(., "Generate") and not(@disabled)]', { timeout: 5000 }).catch(() => null);

                        if (genBtnRetry) {
                            await genBtnRetry.click();
                            console.log('Clicked Generate (Retry)...');
                            console.log('Waiting again (90s)...');
                            await sleep(90000);
                        }
                    } else {
                        console.log('Could not find/click Retry button.');
                    }
                }
            } catch (retryErr) {
                console.log('Error in retry logic:', retryErr.message);
            }

            // DOWNLOAD & RENAME
            console.log('--- Starting Download Phase ---');
            try {

                // (A) Select Video Target
                const addToSceneHandles = await page.evaluateHandle(() => {
                    const results = [];
                    // Check for "Add to scene" OR "Thêm vào cảnh"
                    const xpath = '//button[contains(., "Add to scene")] | //button[contains(., "Thêm vào cảnh")]';
                    const query = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                    for (let i = 0; i < query.snapshotLength; i++) {
                        // Assuming the first one is the newest one (top of list)
                        results.push(query.snapshotItem(i));
                    }
                    return results;
                });

                const properties = await addToSceneHandles.getProperties();
                const addToSceneBtns = [];
                for (const property of properties.values()) {
                    const element = property.asElement();
                    if (element) addToSceneBtns.push(element);
                }

                if (addToSceneBtns.length === 0) {
                    console.log('No video cards found (no "Add to scene" buttons).');
                    continue;
                }
                const targetAnchor = addToSceneBtns[0]; // Top-most
                console.log('Found video card anchor.');

                // (B) Get Card
                // Find the closest container that looks like a Card.
                // We'll look for 'article' or a div with specific attributes, or just go up 2-3 levels.
                const cardHandle = await page.evaluateHandle(el => {
                    return el.closest('article') || el.closest('div[data-testid="video-card"]') || el.parentElement.parentElement;
                }, targetAnchor);

                if (!cardHandle) {
                    console.log('Could not determine Card container from anchor.');
                    continue;
                }

                // (C) Hover Card
                console.log('Hovering video card...');
                // Move mouse to center of card
                try {
                    const boundingBox = await cardHandle.boundingBox();
                    if (boundingBox) {
                        await page.mouse.move(
                            boundingBox.x + boundingBox.width / 2,
                            boundingBox.y + boundingBox.height / 2
                        );
                    } else {
                        await cardHandle.hover();
                    }
                } catch (e) {
                    await cardHandle.hover();
                }
                await sleep(1000); // Wait for UI to react

                // (D) Find Download and Click
                // STRATEGY UPDATE:
                // Debug HTML shows the button has NO aria-label or title.
                // It has: <button ...><i ...>download</i><span ...>Tải xuống</span></button>
                // The span is visually hidden (clip rect).
                // We will search for button that contains 'download' icon text or 'Tải xuống' span text.

                let dlBtn = await cardHandle.evaluateHandle(card => {
                    const buttons = Array.from(card.querySelectorAll('button'));
                    for (const btn of buttons) {
                        // Check for Icon name "download"
                        const icon = btn.querySelector('i');
                        if (icon && icon.textContent.trim() === 'download') {
                            return btn;
                        }

                        // Check for local text "Tải xuống" or "Download" (even if hidden)
                        const text = btn.textContent.trim().toLowerCase();
                        if (text.includes('tải xuống') || text.includes('download') || text.includes('tải về')) {
                            return btn;
                        }
                    }
                    return null;
                });

                const isElement = await page.evaluate(el => el instanceof Element, dlBtn);
                if (!isElement) dlBtn = null;

                if (!dlBtn) {
                    console.log('Download button not found by icon/text. Trying generic position...');
                    const buttons = await cardHandle.$$('button');
                    dlBtn = await page.evaluateHandle((...buttons) => {
                        for (const btn of buttons) {
                            const text = btn.textContent.toLowerCase();
                            if (text.includes('tải về') || text.includes('download')) return btn;
                        }
                        return null;
                    }, ...buttons);
                    const isNull = await page.evaluate(el => !el, dlBtn);
                    if (isNull) dlBtn = null;
                }

                if (dlBtn) {
                    // Start checking file system BEFORE clicking
                    const getFiles = () => fs.readdirSync(outputDir).filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
                    const filesBefore = getFiles();

                    console.log('Found Download button. Clicking...');
                    await dlBtn.click();

                    // Click "720p"
                    // Selectors: "Original size (720p)", "Kích thước gốc (720p)", or just contains "720p"
                    // Wait a bit for menu
                    await sleep(1000);

                    const qualityOption = await page.waitForSelector('xpath///div[contains(text(), "720p")] | //span[contains(text(), "720p")] | //li[contains(., "720p")]', { timeout: 5000 }).catch(() => null);

                    if (qualityOption) {
                        await qualityOption.click();
                        console.log('Clicked 720p.');
                    } else {
                        console.log('720p option not found. (Maybe direct download?)');
                        // Proceed to check for file
                    }

                    console.log('Waiting for file...');
                    let newFile = null;
                    for (let w = 0; w < 40; w++) {
                        await sleep(1000);
                        const filesNow = getFiles();
                        const diff = filesNow.filter(f => !filesBefore.includes(f));
                        if (diff.length > 0) {
                            newFile = diff[0];
                            break;
                        }
                    }

                    if (newFile) {
                        console.log(`Downloaded: ${newFile}`);
                        const oldPath = path.join(outputDir, newFile);
                        const ext = path.extname(newFile);
                        const safeName = targetName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_');
                        const newPath = path.join(outputDir, `${safeName}${ext}`);
                        try {
                            if (fs.existsSync(newPath)) {
                                const timestamp = Date.now();
                                fs.renameSync(oldPath, path.join(outputDir, `${safeName}_${timestamp}${ext}`));
                            } else {
                                fs.renameSync(oldPath, newPath);
                            }
                            console.log('Renamed successfully.');
                        } catch (e) { console.error('Rename failed:', e.message); }
                    } else {
                        console.log('Timeout waiting for file.');
                    }

                } else {
                    console.log('Download button NOT found on card.');
                    // const cardHtml = await page.evaluate(el => el.outerHTML, cardHandle);
                    // fs.writeFileSync(`card_debug_${Date.now()}.html`, cardHtml);
                    // console.log('Saved card_debug.html');
                    // await page.screenshot({ path: `debug_dl_btn_fail_${Date.now()}.png` });
                }

            } catch (dlErr) {
                console.log('Error in download phase:', dlErr.message);
                // Try dumping card HTML if available
                // await page.screenshot({ path: `debug_error_${Date.now()}.png` });
            }

        } catch (e) {
            console.log(`Error processing prompt "${targetName}":`, e.message);
            // await page.screenshot({ path: `debug_step_fail_${Date.now()}.png` });
        }
    }

    console.log('All prompts processed.');
    // await browser.close();
}

run();
