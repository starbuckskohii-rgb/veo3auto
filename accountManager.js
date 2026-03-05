const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./encryption');

class AccountManager {
    constructor(userDataPath) {
        this.userDataPath = userDataPath || process.cwd();
        this.accountsFilePath = path.join(this.userDataPath, 'accounts.json');
        this.accounts = this.loadAccounts();
    }

    loadAccounts() {
        try {
            if (fs.existsSync(this.accountsFilePath)) {
                const data = fs.readFileSync(this.accountsFilePath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Error loading accounts:', error);
        }
        return [];
    }

    saveAccounts() {
        try {
            fs.writeFileSync(this.accountsFilePath, JSON.stringify(this.accounts, null, 2), 'utf8');
        } catch (error) {
            console.error('Error saving accounts:', error);
        }
    }

    getAccounts() {
        return this.accounts;
    }

    getAccountById(id) {
        return this.accounts.find(acc => acc.id === id);
    }

    addAccount(accountData) {
        const newAccount = {
            id: Date.now().toString(),
            profileName: accountData.profileName || `Profile ${this.accounts.length + 1}`,
            email: accountData.email || '',
            password: encrypt(accountData.password) || '',
            twoFactorSecret: encrypt(accountData.twoFactorSecret) || '',
            profilePath: accountData.email ? `profile_${accountData.email.replace(/[^a-zA-Z0-9]/g, '_')}` : `profile_${Date.now()}`,
            hasProfile: false,
            loginType: accountData.loginType || 'auto', // 'auto' or 'manual'
            status: 'Pending',
            createdAt: new Date().toISOString()
        };
        this.accounts.push(newAccount);
        this.saveAccounts();
        return newAccount;
    }

    updateAccount(id, updateData) {
        const index = this.accounts.findIndex(acc => acc.id === id);
        if (index !== -1) {
            // Re-encrypt if password/secret is passed in update
            let mergedData = { ...updateData };
            if (updateData.password !== undefined && updateData.password !== null && updateData.password !== '') {
                mergedData.password = encrypt(updateData.password);
            }
            if (updateData.twoFactorSecret !== undefined && updateData.twoFactorSecret !== null && updateData.twoFactorSecret !== '') {
                mergedData.twoFactorSecret = encrypt(updateData.twoFactorSecret);
            }
            // Decrypt before return? We keep them encrypted in transit unless specifically requested.

            this.accounts[index] = { ...this.accounts[index], ...mergedData };
            this.saveAccounts();
            return this.accounts[index];
        }
        return null;
    }

    deleteAccount(id, currentMapping = {}) {
        // currentMapping is expected to be { "1": "account_id", "2": "account_id" }
        const isMapped = Object.values(currentMapping).includes(id);
        if (isMapped) {
            throw new Error('Không thể xóa tài khoản đang được gán cho một Luồng (Thread). Vui lòng gỡ gán trước!');
        }

        const account = this.accounts.find(a => a.id === id);
        if (!account) return false;

        const initialLength = this.accounts.length;
        this.accounts = this.accounts.filter(acc => acc.id !== id);
        if (this.accounts.length !== initialLength) {
            this.saveAccounts();

            // Auto delete OS profile path
            if (account.profilePath) {
                const fullProfilePath = path.join(process.env.USER_DATA_PATH || path.resolve('./user_data'), account.profilePath);
                if (fs.existsSync(fullProfilePath)) {
                    try {
                        fs.rmSync(fullProfilePath, { recursive: true, force: true });
                    } catch (e) {
                        console.error(`Failed to delete profile folder for ${account.profileName}:`, e.message);
                    }
                }
            }
            return true;
        }
        return false;
    }
}

module.exports = AccountManager;
