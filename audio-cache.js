// audio-cache.js - 基于 IndexedDB 的持久化音频缓存系统
// 解决 MV3 Service Worker 重启后内存缓存丢失的问题

class AudioCache {
    constructor() {
        this.dbName = 'ReadifyAudioDB';
        this.dbVersion = 1;
        this.storeName = 'audio_cache';
        this.db = null;
        this.initPromise = this.initDB();
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };

            request.onerror = (event) => {
                console.error('[AudioCache] 打开 IndexedDB 失败:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    async ensureDB() {
        if (!this.db) {
            await this.initPromise;
        }
        return this.db;
    }

    // 生成稳定缓存键 (SHA-256 取前 16 位 16 进制，结合 voice 和 model)
    // 注意：不包含 speed，因为语速由播放器实时动态调整，无需重复缓存
    async generateKey(text, voice, model = 'tts-1') {
        const encoder = new TextEncoder();
        const data = encoder.encode(text.trim());
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
        return `${hashHex}_${voice}_${model}`;
    }

    // 获取缓存音频
    async get(key) {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const req = store.get(key);

                req.onsuccess = () => {
                    resolve(req.result || null);
                };
                req.onerror = () => {
                    resolve(null);
                };
            });
        } catch (err) {
            console.error('[AudioCache] 读取缓存失败:', err);
            return null;
        }
    }

    // 存储音频
    async set(key, item) {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const entry = {
                    key: key,
                    audioData: item.audioData, // base64
                    textPreview: (item.text || '').substring(0, 80),
                    charCount: (item.text || '').length,
                    voice: item.voice,
                    model: item.model || 'tts-1',
                    timestamp: Date.now(),
                    sizeBytes: item.audioData ? item.audioData.length : 0
                };

                const req = store.put(entry);
                req.onsuccess = () => resolve(true);
                req.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.error('[AudioCache] 写入缓存失败:', err);
            return false;
        }
    }

    // 清理过期缓存（默认保留 7 天）
    async cleanExpired(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
        try {
            const db = await this.ensureDB();
            const now = Date.now();
            return new Promise((resolve) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const index = store.index('timestamp');
                const range = IDBKeyRange.upperBound(now - maxAgeMs);
                const req = index.openCursor(range);
                let deletedCount = 0;

                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        cursor.delete();
                        deletedCount++;
                        cursor.continue();
                    } else {
                        resolve(deletedCount);
                    }
                };
                req.onerror = () => resolve(0);
            });
        } catch (err) {
            console.error('[AudioCache] 清理过期缓存失败:', err);
            return 0;
        }
    }

    // 清空全部缓存
    async clear() {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const req = store.clear();
                req.onsuccess = () => resolve(true);
                req.onerror = (e) => reject(e.target.error);
            });
        } catch (err) {
            console.error('[AudioCache] 清空缓存失败:', err);
            return false;
        }
    }

    // 获取缓存统计数据
    async getStats() {
        try {
            const db = await this.ensureDB();
            return new Promise((resolve) => {
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const req = store.getAll();

                req.onsuccess = () => {
                    const entries = req.result || [];
                    const totalBytes = entries.reduce((acc, cur) => acc + (cur.sizeBytes || 0), 0);
                    resolve({
                        count: entries.length,
                        totalBytes: totalBytes,
                        entries: entries.slice(-10).map(e => ({
                            key: e.key,
                            text: e.textPreview,
                            timestamp: e.timestamp,
                            voice: e.voice
                        }))
                    });
                };
                req.onerror = () => {
                    resolve({ count: 0, totalBytes: 0, entries: [] });
                };
            });
        } catch (err) {
            return { count: 0, totalBytes: 0, entries: [] };
        }
    }
}
