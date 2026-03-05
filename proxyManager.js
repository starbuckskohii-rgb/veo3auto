const fs = require('fs');
const path = require('path');
const net = require('net');

class ProxyManager {
    constructor(userDataPath) {
        this.proxyFilePath = path.join(userDataPath, 'proxies.json');
        this.proxies = this.loadProxies();
    }

    loadProxies() {
        if (fs.existsSync(this.proxyFilePath)) {
            try {
                return JSON.parse(fs.readFileSync(this.proxyFilePath, 'utf8'));
            } catch (e) {
                console.error("Error reading proxies.json:", e);
                return [];
            }
        }
        return [];
    }

    saveProxies() {
        fs.writeFileSync(this.proxyFilePath, JSON.stringify(this.proxies, null, 2), 'utf8');
    }

    getProxies(isAdmin = false) {
        if (isAdmin) return this.proxies;
        return this.proxies.filter(p => !p.isSystem);
    }

    getLiveProxies() {
        return this.proxies.filter(p => p.status === 'live').sort((a, b) => a.ping - b.ping);
    }

    addProxiesRaw(rawText, isSystem = false) {
        // Parse flexible proxy formats (e.g. USER:PASS@IP:PORT, IP:PORT:USER:PASS, IP:PORT)
        const lines = rawText.split('\n');
        let addedCount = 0;

        for (const line of lines) {
            let clean = line.trim();
            if (!clean) continue;

            let ip = '', port = '', username = '', password = '';

            // Format 1: user:pass@ip:port
            if (clean.includes('@')) {
                const parts = clean.split('@');
                const auth = parts[0].split(':');
                const server = parts[1].split(':');
                if (auth.length >= 2 && server.length >= 2) {
                    username = auth[0];
                    password = auth[1];
                    ip = server[0];
                    port = server[1];
                }
            }
            // Format 2: ip:port:user:pass OR ip:port
            else {
                const parts = clean.split(':');
                if (parts.length >= 2) {
                    ip = parts[0];
                    port = parts[1];
                    if (parts.length >= 4) {
                        username = parts[2];
                        password = parts[3];
                    }
                }
            }

            if (ip && port) {
                // Check if exists
                const exists = this.proxies.find(p => p.ip === ip && p.port === port);
                if (!exists) {
                    this.proxies.push({
                        id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
                        ip,
                        port,
                        username,
                        password,
                        status: 'untested',
                        ping: 0,
                        isSystem: isSystem || false
                    });
                    addedCount++;
                } else if (isSystem && !exists.isSystem) {
                    // Update existing proxy to become system protected
                    exists.isSystem = true;
                }
            }
        }

        if (addedCount > 0) this.saveProxies();
        return addedCount;
    }

    deleteProxy(id, isAdmin = false) {
        const initialLen = this.proxies.length;
        this.proxies = this.proxies.filter(p => {
            if (p.id === id) {
                if (p.isSystem && !isAdmin) return true; // Keep system proxy
                return false; // Safely delete
            }
            return true;
        });
        if (this.proxies.length !== initialLen) {
            this.saveProxies();
            return true;
        }
        return false;
    }

    deleteAllDead(isAdmin = false) {
        const initialLen = this.proxies.length;
        this.proxies = this.proxies.filter(p => {
            if (p.status === 'dead') {
                if (p.isSystem && !isAdmin) return true; // Don't wipe dead system proxies from UI if not admin
                return false;
            }
            return true;
        });
        if (this.proxies.length !== initialLen) {
            this.saveProxies();
            return true;
        }
        return false;
    }

    async checkProxies(io = null) {
        if (io) io.emit('log', `Checking ${this.proxies.length} proxies...`);

        const checkSingleProxy = (proxy) => {
            return new Promise((resolve) => {
                const start = Date.now();
                const socket = new net.Socket();
                socket.setTimeout(5000); // 5 seconds timeout

                socket.on('connect', () => {
                    const ping = Date.now() - start;
                    proxy.status = 'live';
                    proxy.ping = ping;
                    socket.destroy();
                    resolve(true);
                });

                socket.on('timeout', () => {
                    proxy.status = 'dead';
                    proxy.ping = 9999;
                    socket.destroy();
                    resolve(false);
                });

                socket.on('error', () => {
                    proxy.status = 'dead';
                    proxy.ping = 9999;
                    socket.destroy();
                    resolve(false);
                });

                socket.connect(parseInt(proxy.port), proxy.ip);
            });
        };

        // Check concurrently for speed
        const promises = this.proxies.map(p => checkSingleProxy(p));
        await Promise.all(promises);

        this.saveProxies();
        if (io) io.emit('log', `Proxy check completed. Found ${this.getLiveProxies().length} live proxies.`);
        return this.proxies;
    }
}

module.exports = ProxyManager;
