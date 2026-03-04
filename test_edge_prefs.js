const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const path = require('path');
const fs = require('fs');

async function run() {
    const profilePath = path.join(__dirname, 'temp_edge_profile2');
    console.log("Launching Edge...");
    try {
        const browser = await puppeteer.launch({
            headless: false,
            executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            userDataDir: profilePath,
            args: ['--start-maximized', '--disable-features=msTrackingPrevention']
        });

        console.log("Browser opened. Please go to edge://settings/privacy");
        console.log("1. Turn OFF Tracking Prevention");
        console.log("2. Turn ON Block third-party cookies");
        console.log("Waiting exactly 60 seconds...");

        let timeRemaining = 60;
        const interval = setInterval(() => {
            timeRemaining -= 10;
            if (timeRemaining > 0) {
                console.log(`${timeRemaining} seconds remaining...`);
            }
        }, 10000);

        await new Promise(resolve => setTimeout(resolve, 60000));
        clearInterval(interval);

        console.log("Closing browser and extracting preferences...");
        await browser.close();

        const prefsPath = path.join(profilePath, 'Default', 'Preferences');
        if (fs.existsSync(prefsPath)) {
            const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));

            console.log("EXTRACTED PREFS:");
            if (prefs.edge && prefs.edge.tracking_prevention) {
                console.log("edge.tracking_prevention:", JSON.stringify(prefs.edge.tracking_prevention, null, 2));
            } else {
                console.log("edge.tracking_prevention NOT FOUND");
                for (let k in prefs) {
                    if (k.toLowerCase().includes('track') || JSON.stringify(prefs[k]).toLowerCase().includes('track')) {
                        console.log(`Key ${k} contains tracking related info.`);
                    }
                }
                if (prefs.privacy && prefs.privacy.tracking) {
                    console.log("privacy.tracking:", JSON.stringify(prefs.privacy.tracking, null, 2));
                }
            }

            console.log("profile.block_third_party_cookies:", prefs.profile && prefs.profile.block_third_party_cookies);
            console.log("profile.cookie_controls_mode:", prefs.profile && prefs.profile.cookie_controls_mode);

            fs.writeFileSync(path.join(__dirname, 'edge_prefs_dump2.json'), JSON.stringify(prefs, null, 2));
            console.log("Full prefs dumped to edge_prefs_dump2.json");
        } else {
            console.log("Preferences file not found!");
        }
    } catch (err) {
        console.error("Error launching browser:", err);
    }
}

run();
