const crypto = require('crypto');

// Use a secure key generation approach for production
// For now, we use a fixed secret or preferably from ENV variables.
// The key must be 32 bytes (256 bits) for aes-256-cbc.
const ENCRYPTION_KEY = process.env.VEO_ENCRYPTION_KEY || 'veo3_auto_secret_key_12345678901'; // Fallback 32 chars
const IV_LENGTH = 16; // For AES, this is always 16

function encrypt(text) {
    if (!text) return text;

    // Ensure the key is exactly 32 bytes long
    const key = crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest('base64').substring(0, 32);

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    if (!text) return text;
    try {
        // Ensure the key is exactly 32 bytes long
        const key = crypto.createHash('sha256').update(String(ENCRYPTION_KEY)).digest('base64').substring(0, 32);

        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');

        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString();
    } catch (e) {
        console.error("Decryption failed:", e.message);
        return null; // Return null or original text depending on strictness
    }
}

module.exports = {
    encrypt,
    decrypt
};
