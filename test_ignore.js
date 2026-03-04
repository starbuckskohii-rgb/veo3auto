const { connect } = require('puppeteer-real-browser');

(async () => {
    try {
        const result = await connect({
            headless: false,
            ignoreAllFlags: true,
            args: [
                '--start-maximized',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        console.log("Browser launched successfully!");
        await result.page.goto('https://google.com');
        await new Promise(r => setTimeout(r, 2000));
        await result.browser.close();
    } catch (e) {
        console.error(e);
    }
})();
