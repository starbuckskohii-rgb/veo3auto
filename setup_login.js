const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        userDataDir: './user_data', // Persistent profile
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    try {
        await page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'networkidle2' });
    } catch (e) {
        console.log('Navigation error (might be okay if redirected):', e.message);
    }

    console.log('\n--------------------------------------------------');
    console.log('ACTION REQUIRED:');
    console.log('1. Log in to Google Labs in the opened Chrome window.');
    console.log('2. Ensure you are on the video creation page.');
    console.log('3. Return to this terminal and press ENTER to save the page structure.');
    console.log('--------------------------------------------------\n');

    process.stdin.resume();
    process.stdin.once('data', async () => {
        console.log('Capturing page structure...');
        try {
            const html = await page.content();
            fs.writeFileSync('page_dump.html', html);
            console.log('Successfully saved to page_dump.html');
            
            await page.screenshot({ path: 'page_snapshot.png' });
            console.log('Successfully saved to page_snapshot.png');
        } catch (err) {
            console.error('Error capturing page:', err);
        }
        
        console.log('Closing browser...');
        await browser.close();
        process.exit(0);
    });
})();
