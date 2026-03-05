const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

const GITHUB_TOKEN = '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';
const REPO_OWNER = 'starbuckskohii-rgb';
const REPO_NAME = 'veo3auto';
const VERSION = pkg.version;
const TAG_NAME = `v${VERSION}`;
const RELEASE_NAME = `Veo3 Auto v${VERSION} (T2V Soft Retry & Attach Bounding Fixes)`;
const ASSETS_TO_UPLOAD = [
    { path: path.resolve(`dist/Veo3.Auto.Setup.${VERSION}.exe`), name: `Veo3.Auto.Setup.${VERSION}.exe` },
    { path: path.resolve('dist/latest.yml'), name: 'latest.yml' }
];

async function createRelease() {
    console.log(`Creating release ${TAG_NAME}...`);

    // 1. Create Release
    const response = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases`, {
        method: 'POST',
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Veo3-Release-Script'
        },
        body: JSON.stringify({
            tag_name: TAG_NAME,
            target_commitish: 'main',
            name: RELEASE_NAME,
            body: 'Automated release of Veo3 Automation Tool.',
            draft: false,
            prerelease: false
        })
    });

    if (!response.ok) {
        const err = await response.text();
        console.error('Failed to create release:', err);
        // If already exists, maybe try to get it?
        if (err.includes('already_exists')) {
            console.log('Release already exists. Finding it...');
            return getReleaseByTag();
        }
        process.exit(1);
    }

    const data = await response.json();
    console.log(`Release created: ${data.html_url}`);
    return data;
}

async function getReleaseByTag() {
    const response = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${TAG_NAME}`, {
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'User-Agent': 'Veo3-Release-Script'
        }
    });
    if (!response.ok) throw new Error('Could not find existing release.');
    return await response.json();
}

async function uploadAssets(release) {
    for (const asset of ASSETS_TO_UPLOAD) {
        if (!fs.existsSync(asset.path)) {
            console.error(`Asset not found: ${asset.path}`);
            continue;
        }

        const stats = fs.statSync(asset.path);
        const fileSize = stats.size;

        // Check if asset already exists
        const existingAsset = release.assets.find(a => a.name === asset.name);
        if (existingAsset) {
            console.log(`Asset ${asset.name} already exists, deleting old one...`);
            await deleteAsset(existingAsset.id);
        }

        console.log(`Uploading ${asset.name} (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);

        const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${asset.name}`);
        const fileStream = fs.readFileSync(asset.path);

        const response = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/octet-stream',
                'Content-Length': fileSize,
                'User-Agent': 'Veo3-Release-Script'
            },
            body: fileStream
        });

        if (!response.ok) {
            console.error(`Failed to upload asset ${asset.name}:`, await response.text());
            continue;
        }

        const data = await response.json();
        console.log(`Asset ${asset.name} uploaded successfully: ${data.browser_download_url}`);
    }
}

async function deleteAsset(assetId) {
    await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/assets/${assetId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'User-Agent': 'Veo3-Release-Script'
        }
    });
}

(async () => {
    try {
        const release = await createRelease();
        await uploadAssets(release);
        console.log('Done!');
    } catch (e) {
        console.error(e);
    }
})();
