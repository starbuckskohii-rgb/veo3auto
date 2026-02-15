const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = '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';
const REPO_OWNER = 'starbuckskohii-rgb';
const REPO_NAME = 'veo3auto';
const TAG_NAME = 'v1.0.0';
const RELEASE_NAME = 'Veo3 Auto v1.0.0';
const ASSET_PATH = path.resolve('dist/Veo3 Auto Setup 1.0.0.exe');
const ASSET_NAME = 'Veo3 Auto Setup 1.0.0.exe';

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

async function uploadAsset(release) {
    if (!fs.existsSync(ASSET_PATH)) {
        console.error(`Asset not found: ${ASSET_PATH}`);
        process.exit(1);
    }

    const stats = fs.statSync(ASSET_PATH);
    const fileSize = stats.size;

    // Check if asset already exists
    const existingAsset = release.assets.find(a => a.name === ASSET_NAME);
    if (existingAsset) {
        console.log('Asset already exists, deleting old one...');
        await deleteAsset(existingAsset.id);
    }

    console.log(`Uploading ${ASSET_NAME} (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);

    const uploadUrl = release.upload_url.replace('{?name,label}', `?name=${ASSET_NAME}`);

    const fileStream = fs.readFileSync(ASSET_PATH);

    const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/vnd.microsoft.portable-executable',
            'Content-Length': fileSize,
            'User-Agent': 'Veo3-Release-Script'
        },
        body: fileStream
    });

    if (!response.ok) {
        console.error('Failed to upload asset:', await response.text());
        process.exit(1);
    }

    const data = await response.json();
    console.log(`Asset uploaded successfully: ${data.browser_download_url}`);
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
        await uploadAsset(release);
        console.log('Done!');
    } catch (e) {
        console.error(e);
    }
})();
