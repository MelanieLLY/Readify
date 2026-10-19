// popup.js - 弹出面板逻辑与全局控制

class ReadifyPopup {
    constructor() {
        this.initElements();
        this.bindEvents();
        this.loadSettings();
        this.pollPlaybackStatus();
        this.loadCacheStats();
        this.initStatusListener();
    }

    // 初始化 DOM 引用
    initElements() {
        // 状态与顶部
        this.statusTag = document.getElementById('statusTag');
        this.toast = document.getElementById('toastMessage');

        // 播放控制台 (Deck)
        this.playerDeck = document.getElementById('playerDeck');
        this.deckModeBadge = document.getElementById('deckModeBadge');
        this.deckProgress = document.getElementById('deckProgress');
        this.deckSnippet = document.getElementById('deckSnippet');
        this.deckPrevBtn = document.getElementById('deckPrevBtn');
        this.deckPlayPauseBtn = document.getElementById('deckPlayPauseBtn');
        this.deckNextBtn = document.getElementById('deckNextBtn');
        this.deckStopBtn = document.getElementById('deckStopBtn');

        // 朗读操作按钮
        this.readPageBtn = document.getElementById('readPageBtn');
        this.summaryPageBtn = document.getElementById('summaryPageBtn');
        this.readSelectionBtn = document.getElementById('readSelectionBtn');

        // 设置表单
        this.ttsProviderSelect = document.getElementById('ttsProvider');
        this.openaiSettings = document.getElementById('openaiSettings');
        this.elevenSettings = document.getElementById('elevenSettings');
        this.elevenModelSelect = document.getElementById('elevenModel');
        this.elevenVoiceSelect = document.getElementById('elevenVoice');
        this.refreshElevenVoicesBtn = document.getElementById('refreshElevenVoices');
        this.probeElevenModelsBtn = document.getElementById('probeElevenModels');
        this.elevenAccountInfo = document.getElementById('elevenAccountInfo');
        this.elevenApiKeyInput = document.getElementById('elevenApiKey');
        this.saveElevenApiKeyBtn = document.getElementById('saveElevenApiKey');
        this.ttsModelSelect = document.getElementById('ttsModel');
        this.voiceSelect = document.getElementById('voiceSelect');
        this.speedSlider = document.getElementById('speedSlider');
        this.speedValue = document.getElementById('speedValue');
        this.showParagraphIcons = document.getElementById('showParagraphIcons');
        this.apiKeyInput = document.getElementById('apiKey');
        this.saveApiKeyBtn = document.getElementById('saveApiKey');

        // 缓存控制
        this.cacheStats = document.getElementById('cacheStats');
        this.clearCacheBtn = document.getElementById('clearCacheBtn');
        this.cleanExpiredBtn = document.getElementById('cleanExpiredBtn');

        this.currentStatus = { state: 'idle' };
    }

    // 绑定交互事件
    bindEvents() {
        // API Key 保存
        this.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());

        // 语速滑块
        this.speedSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.speedValue.textContent = `${val.toFixed(2)}x`;
            chrome.runtime.sendMessage({ action: 'setSpeed', speed: val });
        });
        this.speedSlider.addEventListener('change', () => this.saveSettings());

        // 音色与模型
        this.voiceSelect.addEventListener('change', () => this.saveSettings());
        this.ttsModelSelect.addEventListener('change', () => this.saveSettings());

        // 朗读引擎切换
        this.ttsProviderSelect.addEventListener('change', () => {
            this.toggleProviderSettings();
            this.saveSettings();
            if (this.ttsProviderSelect.value === 'elevenlabs' && this.elevenVoiceSelect.options.length <= 1) {
                this.loadElevenAccount();
            }
        });
        this.elevenModelSelect.addEventListener('change', () => this.saveSettings());
        this.elevenVoiceSelect.addEventListener('change', () => this.saveSettings());
        this.refreshElevenVoicesBtn.addEventListener('click', () => this.loadElevenVoices(true));
        this.probeElevenModelsBtn.addEventListener('click', () => this.probeElevenModels());
        this.saveElevenApiKeyBtn.addEventListener('click', () => this.saveElevenApiKey());

        // 段落图标开关
        this.showParagraphIcons.addEventListener('change', async (e) => {
            const show = e.target.checked;
            await chrome.storage.sync.set({ showParagraphIcons: show });
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                chrome.tabs.sendMessage(tab.id, { action: 'toggleParagraphIcons', show: show }).catch(() => {});
            }
            this.showToast(show ? '已开启网页段落朗读按钮' : '已关闭网页段落朗读按钮');
        });

        // 朗读操作
        this.readPageBtn.addEventListener('click', () => this.startReadingPage(false));
        this.summaryPageBtn.addEventListener('click', () => this.startReadingPage(true));
        this.readSelectionBtn.addEventListener('click', () => this.startReadingSelection());

        // 控制台操作
        this.deckPlayPauseBtn.addEventListener('click', () => {
            if (this.currentStatus.state === 'playing') {
                chrome.runtime.sendMessage({ action: 'pauseReading' });
            } else if (this.currentStatus.state === 'paused') {
                chrome.runtime.sendMessage({ action: 'resumeReading' });
            }
        });

        this.deckPrevBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'prevChunk' });
        });

        this.deckNextBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'nextChunk' });
        });

        this.deckStopBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'stopReading' });
        });

        // 缓存操作
        this.clearCacheBtn.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ action: 'clearCache' });
            this.showToast('全部缓存已清空');
            this.loadCacheStats();
        });

        this.cleanExpiredBtn.addEventListener('click', async () => {
            const res = await chrome.runtime.sendMessage({ action: 'cleanExpiredCache' });
            this.showToast(`已清理 ${res.deletedCount || 0} 个过期音频缓存`);
            this.loadCacheStats();
        });
    }

    // 加载设置
    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get([
                'apiKey', 'speed', 'voice', 'ttsModel', 'showParagraphIcons',
                'ttsProvider', 'elevenApiKey', 'elevenModel', 'elevenVoiceId', 'elevenVoiceName'
            ]);

            this.ttsProviderSelect.value = result.ttsProvider || 'openai';
            if (result.elevenApiKey) this.elevenApiKeyInput.value = result.elevenApiKey;
            if (result.elevenModel) this.elevenModelSelect.value = result.elevenModel;
            if (result.elevenVoiceId) {
                // 先放入已保存的音色，避免列表加载前丢失选择
                this.elevenVoiceSelect.innerHTML = '';
                this.elevenVoiceSelect.add(new Option(result.elevenVoiceName || result.elevenVoiceId, result.elevenVoiceId));
            }
            this.toggleProviderSettings();
            if (this.ttsProviderSelect.value === 'elevenlabs' && result.elevenApiKey) {
                this.loadElevenAccount();
            }

            if (result.apiKey) this.apiKeyInput.value = result.apiKey;
            const currentSpeed = result.speed !== undefined ? parseFloat(result.speed) : 0.85;
            this.speedSlider.value = currentSpeed;
            this.speedValue.textContent = `${currentSpeed.toFixed(2)}x`;
            if (result.voice) this.voiceSelect.value = result.voice;
            if (result.ttsModel) this.ttsModelSelect.value = result.ttsModel;
            if (result.showParagraphIcons !== undefined) {
                this.showParagraphIcons.checked = !!result.showParagraphIcons;
            }
        } catch (e) {
            console.error('加载设置失败:', e);
        }
    }

    // 保存设置
    async saveSettings() {
        const elevenOption = this.elevenVoiceSelect.selectedOptions[0];
        const settings = {
            speed: parseFloat(this.speedSlider.value),
            voice: this.voiceSelect.value,
            ttsModel: this.ttsModelSelect.value,
            ttsProvider: this.ttsProviderSelect.value,
            elevenModel: this.elevenModelSelect.value,
            elevenVoiceId: this.elevenVoiceSelect.value,
            elevenVoiceName: elevenOption && elevenOption.value ? elevenOption.textContent : ''
        };
        await chrome.storage.sync.set(settings);
    }

    // 后台自动回退后，同步下拉框显示
    async syncElevenSelectionFromStorage() {
        const { elevenVoiceId, elevenVoiceName } = await chrome.storage.sync.get(['elevenVoiceId', 'elevenVoiceName']);
        await this.renderElevenModelOptions();
        if (elevenVoiceId && ![...this.elevenVoiceSelect.options].some(o => o.value === elevenVoiceId)) {
            this.elevenVoiceSelect.add(new Option(elevenVoiceName || elevenVoiceId, elevenVoiceId));
        }
        if (elevenVoiceId) this.elevenVoiceSelect.value = elevenVoiceId;
    }

    toggleProviderSettings() {
        const isEleven = this.ttsProviderSelect.value === 'elevenlabs';
        this.elevenSettings.style.display = isEleven ? 'block' : 'none';
        this.openaiSettings.style.display = isEleven ? 'none' : 'block';
    }

    // 保存 ElevenLabs API Key 并加载音色列表
    async saveElevenApiKey() {
        const key = this.elevenApiKeyInput.value.trim();
        if (!key) {
            this.showToast('请输入有效的 ElevenLabs API Key');
            return;
        }
        await chrome.storage.sync.set({ elevenApiKey: key });
        this.showToast(`ElevenLabs Key (•••• ${key.slice(-4)}) 已保存`);
        // 新 Key 可能对应不同账号，清掉旧的可用性检测结果
        await chrome.storage.sync.set({ elevenModelStatus: {} });
        await this.loadElevenAccount();
    }

    // 加载 ElevenLabs 账号信息：模型列表、套餐额度、音色
    async loadElevenAccount() {
        await Promise.all([this.loadElevenModels(), this.loadElevenSubscription(), this.loadElevenVoices()]);
    }

    elevenHeaders() {
        return { 'xi-api-key': this.elevenApiKeyInput.value.trim() };
    }

    // 从 /v1/models 拉取支持朗读的模型（该接口不区分套餐，实际可用性用「检测可用」或播放时自动回退确认）
    async loadElevenModels() {
        if (!this.elevenApiKeyInput.value.trim()) return;
        try {
            const res = await fetch('https://api.elevenlabs.io/v1/models', { headers: this.elevenHeaders() });
            if (!res.ok) return;
            const models = (await res.json())
                .filter(m => m.can_do_text_to_speech && !m.requires_alpha_access);
            if (models.length === 0) return;
            this.elevenModels = models;
            await this.renderElevenModelOptions();
        } catch (_) {
            // 拉取失败时保留内置的模型列表
        }
    }

    async renderElevenModelOptions() {
        const { elevenModel, elevenModelStatus = {} } = await chrome.storage.sync.get(['elevenModel', 'elevenModelStatus']);
        const models = this.elevenModels || [...this.elevenModelSelect.options].map(o => ({ model_id: o.value, name: o.value }));
        const order = ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v4_turbo', 'eleven_v4'];
        const rank = id => (order.indexOf(id) + 1) || order.length + 1;
        models.sort((a, b) => rank(a.model_id) - rank(b.model_id));

        const selected = elevenModel || this.elevenModelSelect.value;
        this.elevenModelSelect.innerHTML = '';
        models.forEach(m => {
            const mark = elevenModelStatus[m.model_id] === 'ok' ? '✓ ' : (elevenModelStatus[m.model_id] === 'denied' ? '✗ ' : '');
            const suffix = elevenModelStatus[m.model_id] === 'denied' ? '（当前账号不可用）' : '';
            const label = m.name && m.name !== m.model_id ? `${m.model_id} · ${m.name}` : m.model_id;
            this.elevenModelSelect.add(new Option(`${mark}${label}${suffix}`, m.model_id));
        });
        if (models.some(m => m.model_id === selected)) {
            this.elevenModelSelect.value = selected;
        }
    }

    // 显示套餐与剩余额度（Key 缺少 User 读取权限时静默跳过）
    async loadElevenSubscription() {
        if (!this.elevenApiKeyInput.value.trim()) return;
        try {
            const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: this.elevenHeaders() });
            if (!res.ok) return;
            const sub = await res.json();
            const left = Math.max(0, (sub.character_limit || 0) - (sub.character_count || 0));
            this.elevenAccountInfo.textContent = `套餐 ${sub.tier}，本期剩余 ${left.toLocaleString()} / ${(sub.character_limit || 0).toLocaleString()} 字符额度；模型不可用时会自动切换`;
        } catch (_) {}
    }

    // 逐个模型发送 1 个字符的试读请求，确认当前账号能用哪些模型
    async probeElevenModels() {
        if (!this.elevenApiKeyInput.value.trim()) {
            this.showToast('请先填写并保存 ElevenLabs API Key');
            return;
        }
        const voiceId = this.elevenVoiceSelect.value || 'JBFqnCBsd6RMkjVDRZzb';
        const ids = [...this.elevenModelSelect.options].map(o => o.value);
        const status = {};
        this.probeElevenModelsBtn.disabled = true;
        this.probeElevenModelsBtn.textContent = '检测中...';

        try {
            for (const id of ids) {
                const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_22050_32`, {
                    method: 'POST',
                    headers: { ...this.elevenHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: 'a', model_id: id })
                });
                if (res.ok) {
                    status[id] = 'ok';
                    continue;
                }
                const err = await res.json().catch(() => ({}));
                const code = err.detail?.code || err.detail?.status || '';
                const message = err.detail?.message || res.statusText;
                if (['voice_not_found', 'voice_access_denied', 'invalid_voice_id'].includes(code) || (/voice/i.test(message) && res.status === 403)) {
                    this.showToast(`当前音色不可用（${message}），请换一个音色后再检测`);
                    return;
                }
                if (res.status === 401 || code === 'insufficient_credits' || res.status === 429) {
                    this.showToast(`检测中断: ${res.status} ${message}`);
                    return;
                }
                status[id] = 'denied';
            }

            await chrome.storage.sync.set({ elevenModelStatus: status });
            const okIds = ids.filter(id => status[id] === 'ok');
            if (okIds.length && status[this.elevenModelSelect.value] !== 'ok') {
                this.elevenModelSelect.value = okIds[0];
                await this.saveSettings();
            }
            await this.renderElevenModelOptions();
            this.showToast(okIds.length
                ? `可用模型 ${okIds.length}/${ids.length}，当前使用 ${this.elevenModelSelect.value}`
                : '当前账号没有可用的朗读模型');
        } catch (err) {
            this.showToast(`检测失败: ${err.message}`);
        } finally {
            this.probeElevenModelsBtn.disabled = false;
            this.probeElevenModelsBtn.textContent = '检测可用';
        }
    }

    // 拉取账号下可用的 ElevenLabs 音色（含预置音色与自己克隆/收藏的音色）
    async loadElevenVoices(manual = false) {
        const key = this.elevenApiKeyInput.value.trim();
        if (!key) {
            if (manual) this.showToast('请先填写并保存 ElevenLabs API Key');
            return;
        }

        this.refreshElevenVoicesBtn.disabled = true;
        try {
            const res = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', {
                headers: { 'xi-api-key': key }
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const detail = err.detail?.message || err.detail?.status || res.statusText;
                throw new Error(`${res.status} ${detail}`);
            }
            const data = await res.json();
            const voices = data.voices || [];
            if (voices.length === 0) throw new Error('账号下没有可用音色');

            const savedId = (await chrome.storage.sync.get('elevenVoiceId')).elevenVoiceId;
            this.elevenVoiceSelect.innerHTML = '';
            voices.forEach(v => {
                const tags = [v.labels?.gender, v.labels?.accent].filter(Boolean).join(' · ');
                this.elevenVoiceSelect.add(new Option(tags ? `${v.name} (${tags})` : v.name, v.voice_id));
            });
            if (savedId && voices.some(v => v.voice_id === savedId)) {
                this.elevenVoiceSelect.value = savedId;
            }
            await this.saveSettings();
            if (manual) this.showToast(`已加载 ${voices.length} 个音色`);
        } catch (err) {
            this.showToast(`加载 ElevenLabs 音色失败: ${err.message}`);
        } finally {
            this.refreshElevenVoicesBtn.disabled = false;
        }
    }

    // 保存 API Key
    async saveApiKey() {
        const key = this.apiKeyInput.value.trim();
        if (!key) {
            this.showToast('请输入有效的 OpenAI API Key');
            return;
        }

        await chrome.storage.sync.set({ apiKey: key });
        const tail = key.slice(-4);
        this.showToast(`API Key (•••• ${tail}) 已安全保存！`);
    }

    // 开始朗读整页正文 (支持全文或 AI 摘要速读)
    async startReadingPage(isSummary = false) {
        const apiKey = this.apiKeyInput.value.trim();
        if (!this.ensureKeysFor(isSummary)) return;

        this.showToast(isSummary ? '正在提取全文并调用 GPT-5.6-Luna 提炼摘要...' : '正在解析网页正文并生成朗读队列...');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) {
                this.showToast('未找到有效网页标签');
                return;
            }

            // 从 Content Script 提取结构化正文
            const contentRes = await this.sendToTab(tab.id, { action: 'extractPageContent' });
            if (!contentRes || !contentRes.success) {
                this.showToast(contentRes ? contentRes.error : '未能提取到网页正文');
                return;
            }

            // 发送给 Background 开启朗读
            const response = await chrome.runtime.sendMessage({
                action: 'startReading',
                text: contentRes.fullText,
                pageTitle: contentRes.title || tab.title || '',
                mode: isSummary ? 'summary' : 'full',
                apiKey: apiKey,
                voice: this.voiceSelect.value,
                speed: parseFloat(this.speedSlider.value),
                ttsModel: this.ttsModelSelect.value,
                elevenApiKey: this.elevenApiKeyInput.value.trim(),
                tabId: tab.id
            });

            if (!response || !response.success) {
                this.showToast(response ? response.error : '朗读启动失败');
            } else {
                this.showToast(isSummary ? 'AI 摘要生成完毕，开始播放' : `正文解析完成，共 ${response.totalChunks} 个分段`);
            }
        } catch (err) {
            this.showToast('启动朗读失败: ' + err.message);
        }
    }

    // 检查当前引擎所需的 Key（AI 摘要始终需要 OpenAI Key）
    ensureKeysFor(isSummary) {
        if ((isSummary || this.ttsProviderSelect.value === 'openai') && !this.apiKeyInput.value.trim()) {
            this.showToast(isSummary ? 'AI 摘要需要 OpenAI API Key' : '请先输入并保存 OpenAI API Key');
            this.apiKeyInput.focus();
            return false;
        }
        if (this.ttsProviderSelect.value === 'elevenlabs' && !this.elevenApiKeyInput.value.trim()) {
            this.showToast('请先输入并保存 ElevenLabs API Key');
            this.elevenApiKeyInput.focus();
            return false;
        }
        return true;
    }

    // 向页面发消息；扩展安装/重载前已打开的标签页没有 content script，按需注入后重试
    async sendToTab(tabId, message) {
        try {
            return await chrome.tabs.sendMessage(tabId, message);
        } catch (_) {
            try {
                await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
                await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
            } catch (err) {
                throw new Error('当前页面不支持朗读（浏览器内置页或扩展商店页面）');
            }
            return chrome.tabs.sendMessage(tabId, message);
        }
    }

    // 朗读选中文本
    async startReadingSelection() {
        const apiKey = this.apiKeyInput.value.trim();
        if (!this.ensureKeysFor(false)) return;

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            const selRes = await this.sendToTab(tab.id, { action: 'getSelectedText' });
            if (!selRes || !selRes.success || !selRes.text) {
                this.showToast('请先在网页上划词选中要朗读的文本');
                return;
            }

            const response = await chrome.runtime.sendMessage({
                action: 'startReading',
                text: selRes.text,
                pageTitle: tab.title || '',
                mode: 'selection',
                apiKey: apiKey,
                voice: this.voiceSelect.value,
                speed: parseFloat(this.speedSlider.value),
                ttsModel: this.ttsModelSelect.value,
                elevenApiKey: this.elevenApiKeyInput.value.trim(),
                tabId: tab.id
            });

            this.showToast(response && response.success ? '开始朗读选中文本' : `朗读启动失败: ${response?.error || '未知错误'}`);
        } catch (err) {
            this.showToast('获取选中文本失败: ' + err.message);
        }
    }

    // 监听实时播放状态广播
    initStatusListener() {
        chrome.runtime.onMessage.addListener((request) => {
            if (request.action === 'playbackStatusUpdate') {
                this.updateDeckUI(request);
            } else if (request.action === 'elevenFallback') {
                this.showToast(request.message);
                this.syncElevenSelectionFromStorage();
            }
        });
    }

    // 主动拉取一次播放状态
    async pollPlaybackStatus() {
        try {
            const status = await chrome.runtime.sendMessage({ action: 'getPlaybackStatus' });
            if (status) {
                this.updateDeckUI(status);
            }
        } catch (_) {}
    }

    // 更新 Deck 状态面板
    updateDeckUI(status) {
        this.currentStatus = status;

        // 状态标签
        const state = status.state || 'idle';
        this.statusTag.className = `status-tag ${state}`;
        const map = {
            idle: '就绪',
            playing: '播放中',
            paused: '已暂停',
            loading: '加载中',
            ended: '就绪',
            stopped: '就绪',
            error: '出错'
        };
        this.statusTag.textContent = map[state] || state;

        if (state === 'idle' || state === 'stopped' || state === 'ended') {
            this.playerDeck.style.display = 'none';
            return;
        }

        this.playerDeck.style.display = 'block';

        // 模式徽章
        if (status.mode === 'summary') {
            this.deckModeBadge.textContent = '✨ AI 摘要速读 (GPT-5.6-Luna)';
        } else if (status.mode === 'selection') {
            this.deckModeBadge.textContent = '✂️ 选中文本';
        } else {
            this.deckModeBadge.textContent = '🔊 全文朗读';
        }

        // 进度
        const curIdx = (status.chunkIndex !== undefined && status.chunkIndex >= 0) ? status.chunkIndex + 1 : 1;
        const total = status.totalChunks || 1;
        this.deckProgress.textContent = `${curIdx} / ${total} 段`;

        // 预览文字
        const chunk = status.chunk || status.currentChunk;
        if (status.message) {
            this.deckSnippet.textContent = status.message;
        } else if (chunk && chunk.text) {
            this.deckSnippet.textContent = chunk.text;
        }

        // 播放暂停按钮文本
        if (state === 'playing') {
            this.deckPlayPauseBtn.textContent = '⏸ 暂停';
        } else if (state === 'paused') {
            this.deckPlayPauseBtn.textContent = '▶️ 继续';
        } else if (state === 'loading') {
            this.deckPlayPauseBtn.textContent = '⏳ 加载';
        }
    }

    // 加载持久化缓存统计
    async loadCacheStats() {
        try {
            const stats = await chrome.runtime.sendMessage({ action: 'getCacheStats' });
            if (stats) {
                const count = stats.count || 0;
                const sizeKb = ((stats.totalBytes || 0) / 1024).toFixed(1);
                const sizeMb = ((stats.totalBytes || 0) / (1024 * 1024)).toFixed(2);
                const sizeStr = (stats.totalBytes > 1024 * 1024) ? `${sizeMb} MB` : `${sizeKb} KB`;
                this.cacheStats.textContent = `${count} 项 (${sizeStr})`;
            }
        } catch (_) {
            this.cacheStats.textContent = '0 项 (0 KB)';
        }
    }

    // 优雅弹出消息
    showToast(msg) {
        if (!this.toast) return;
        this.toast.textContent = msg;
        this.toast.style.display = 'block';
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            this.toast.style.display = 'none';
        }, 2800);
    }
}

// 页面加载完成后实例化
document.addEventListener('DOMContentLoaded', () => {
    new ReadifyPopup();
});