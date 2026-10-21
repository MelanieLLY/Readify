// background.js - 后台 Service Worker，负责 TTS API、GPT-5.6-Luna 智能处理、缓存调度与播放队列管理
importScripts('audio-cache.js');

// ElevenLabs 模型回退顺序：先最便宜、免费账号可用概率最高的
const ELEVEN_MODEL_FALLBACKS = ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v4_turbo', 'eleven_v4', 'eleven_v3'];
// 换模型可能解决的错误（无权限 / 不存在 / 套餐限制 / 额度不足以支付更贵的模型）
const ELEVEN_MODEL_ERRORS = ['model_not_found', 'model_access_denied', 'unsupported_model', 'feature_not_available', 'subscription_required', 'insufficient_credits'];
// 换音色可能解决的错误（免费账号无法通过 API 使用部分音色库音色）
const ELEVEN_VOICE_ERRORS = ['voice_not_found', 'voice_access_denied', 'invalid_voice_id'];

// 判断一段文字的朗读语言，传给 ElevenLabs 的 language_code，避免自动识别把中文读成粤语/英文混杂
// 按“词”计数：每个汉字算 1，每个拉丁字母单词算 1；汉字超过 1/3 即判为中文
function detectLanguage(text) {
    if (/[\u3040-\u30ff]/.test(text)) return 'ja'; // 有假名一定是日文（日文也含汉字，需先判断）
    const han = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
    const latinWords = (text.match(/[A-Za-z\u00c0-\u024f]+/g) || []);
    const units = han + hangul + latinWords.length;
    if (units === 0) return null;
    if (han / units > 1 / 3) return 'zh';
    if (hangul / units > 1 / 3) return 'ko';
    if (latinWords.length && latinWords.every(w => /^[A-Za-z]+$/.test(w))) return 'en';
    return null; // 法语、德语等交给 ElevenLabs 自动识别
}

class ReadifyBackground {
    constructor() {
        this.cache = new AudioCache();
        this.offscreenCreating = null;

        // 播放队列状态
        this.playlist = [];
        this.currentChunkIndex = -1;
        this.playbackState = 'idle'; // 'idle' | 'loading' | 'playing' | 'paused'
        this.currentSpeed = 1.0;
        this.activeTabId = null;
        this.currentSourceType = 'page'; // 'page' | 'selection' | 'paragraph' | 'summary' | 'snippet'
        this.playToken = 0; // 每次切换分片/停止时自增，用于丢弃过期的异步播放请求
        this.ttsConfig = null; // 当前朗读会话的 { provider, apiKey, voice, ttsModel }

        this.initListeners();
        this.initContextMenus();
    }

    // 初始化监听器
    initListeners() {
        // 监听来自 popup、content script、offscreen 的消息
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            // 处理 offscreen 事件
            if (request.action === 'offscreenEvent') {
                this.handleOffscreenEvent(request);
                sendResponse({ success: true });
                return true;
            }

            switch (request.action) {
                case 'startReading':
                    this.startReading(request, sender).then(sendResponse);
                    return true;

                case 'pauseReading':
                    this.pauseReading().then(sendResponse);
                    return true;

                case 'resumeReading':
                    this.resumeReading().then(sendResponse);
                    return true;

                case 'stopReading':
                case 'stopTTS':
                    this.stopReading().then(sendResponse);
                    return true;

                case 'nextChunk':
                    this.playNextChunk().then(sendResponse);
                    return true;

                case 'prevChunk':
                    this.playPrevChunk().then(sendResponse);
                    return true;

                case 'setSpeed':
                    this.updateSpeed(request.speed).then(sendResponse);
                    return true;

                case 'seekReading':
                    this.seekReading(request.time).then(sendResponse);
                    return true;

                case 'getPlaybackStatus':
                    this.getPlaybackStatus().then(sendResponse);
                    return true;

                // 缓存操作
                case 'getCacheStats':
                    this.cache.getStats().then(sendResponse);
                    return true;

                case 'clearCache':
                    this.cache.clear().then(() => sendResponse({ success: true, message: '缓存已清空' }));
                    return true;

                case 'cleanExpiredCache':
                    this.cache.cleanExpired().then((count) => sendResponse({ success: true, deletedCount: count }));
                    return true;

                default:
                    sendResponse({ success: false, error: '未知操作' });
                    return false;
            }
        });

        // 标签页关闭或刷新时，如果是当前播放页面，停止播放并重置
        chrome.tabs.onRemoved.addListener((tabId) => {
            if (this.activeTabId === tabId) {
                this.stopReading();
            }
        });
    }

    // 初始化右键菜单
    initContextMenus() {
        const createMenus = () => {
            chrome.contextMenus.create({
                id: 'readify_read_snippet',
                title: '🔊 朗读选中的词句 / 发音',
                contexts: ['selection']
            }, () => void chrome.runtime.lastError);
        };

        // Service Worker 每次启动都重建菜单（同时清掉旧版本遗留的“AI 摘要”菜单项）
        chrome.contextMenus.removeAll(createMenus);

        chrome.contextMenus.onClicked.addListener((info, tab) => {
            const selectedText = info.selectionText;
            if (!selectedText || !tab || tab.id === undefined || tab.id < 0) return;

            if (info.menuItemId === 'readify_read_snippet') {
                this.startReadingWithSelectedText(selectedText, tab.id, 'snippet', tab.title || '');
            }
        });
    }

    // 右键启动朗读辅助
    async startReadingWithSelectedText(text, tabId, mode = 'snippet', pageTitle = '') {
        const settings = await chrome.storage.sync.get(['speed']);
        const res = await this.startReading({
            text: text,
            mode: mode, // 'snippet' (词句快速发音)
            speed: settings.speed || 0.85,
            tabId: tabId,
            pageTitle: pageTitle
        });
        if (!res.success && res.reported !== true) {
            chrome.tabs.sendMessage(tabId, {
                action: 'showNotification',
                message: res.error,
                type: 'error'
            }).catch(() => {});
        }
    }

    // 根据设置决定朗读引擎；请求里显式传入的值（来自 popup 未保存的输入）优先
    async resolveTTSConfig(request) {
        const s = await chrome.storage.sync.get([
            'ttsProvider', 'apiKey', 'voice', 'ttsModel', 'elevenApiKey', 'elevenModel', 'elevenVoiceId'
        ]);
        if ((s.ttsProvider || 'openai') === 'elevenlabs') {
            const apiKey = request.elevenApiKey || s.elevenApiKey;
            if (!apiKey) return { error: '请先在 Readify 设置中保存 ElevenLabs API Key' };
            return {
                provider: 'elevenlabs',
                apiKey,
                voice: s.elevenVoiceId || 'JBFqnCBsd6RMkjVDRZzb', // 未选择时用官方示例音色 George
                ttsModel: s.elevenModel || 'eleven_flash_v2_5'
            };
        }
        const apiKey = request.apiKey || s.apiKey;
        if (!apiKey) return { error: '请先在 Readify 设置中保存 OpenAI API Key' };
        return {
            provider: 'openai',
            apiKey,
            voice: request.voice || s.voice || 'nova',
            ttsModel: request.ttsModel || s.ttsModel || 'tts-1'
        };
    }

    // 保证 Offscreen Document 存在
    async ensureOffscreen() {
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });

        if (existingContexts.length > 0) {
            return;
        }

        if (this.offscreenCreating) {
            await this.offscreenCreating;
            return;
        }

        this.offscreenCreating = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['AUDIO_PLAYBACK'],
            justification: '用于在后台无损稳定播放 TTS 音频，解决网页 CSP 阻断与跨 Tab 播放中断问题'
        });

        try {
            await this.offscreenCreating;
        } catch (err) {
            if (!String(err.message).includes('single offscreen')) throw err;
        } finally {
            this.offscreenCreating = null;
        }
    }

    async hasOffscreen() {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        return contexts.length > 0;
    }

    // 核心开始朗读入口
    async startReading(request, sender = null) {
        try {
            const {
                text,
                chunks = null,
                mode = 'full', // 'full' | 'summary' | 'paragraph' | 'selection' | 'snippet'
                speed = 1.0,
                targetParagraphId = null
            } = request;

            const ttsConfig = await this.resolveTTSConfig(request);
            if (ttsConfig.error) {
                return { success: false, error: ttsConfig.error };
            }

            // AI 摘要始终走 OpenAI
            const openaiKey = request.apiKey || (await chrome.storage.sync.get('apiKey')).apiKey;
            if (mode === 'summary' && !openaiKey) {
                return { success: false, error: 'AI 摘要需要 OpenAI API Key' };
            }

            if (!text && (!chunks || chunks.length === 0)) {
                return { success: false, error: '朗读文本内容为空' };
            }

            // 确定发起标签页 ID
            this.activeTabId = request.tabId || (sender && sender.tab ? sender.tab.id : null);
            if (!this.activeTabId) {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (tab) this.activeTabId = tab.id;
            }

            this.currentSpeed = parseFloat(speed) || 0.85;
            this.currentSourceType = mode;
            this.activeTabTitle = request.pageTitle || (sender && sender.tab ? sender.tab.title : '') || '';

            // 先停止当前朗读
            await this.stopReading(false);

            // 广播加载中状态
            this.playbackState = 'loading';
            const loadingMsg = mode === 'summary' 
                ? 'GPT-5.6-Luna 正在提炼核心速读摘要...' 
                : (mode === 'snippet' ? `🔊 正在获取发音: "${text.trim().substring(0, 30)}"...` : '正在准备朗读内容...');
            this.broadcastStatus({
                state: 'loading',
                message: loadingMsg,
                text: text
            });

            let finalChunks = [];

            // 1. 如果是 AI 摘要模式，先调用 GPT-5.6-Luna
            if (mode === 'summary') {
                const summaryText = await this.generateAISummary(text, openaiKey);
                finalChunks = this.splitIntoSemanticChunks(summaryText, 'ai-summary');
            } else if (mode === 'snippet') {
                // 2. 词句快捷发音模式：单个紧凑分片，无需多段拆分
                finalChunks = [{
                    index: 0,
                    text: text.trim(),
                    elementId: null,
                    total: 1
                }];
            } else if (chunks && chunks.length > 0) {
                // 前端已经按段落切分好的 chunks
                finalChunks = chunks;
            } else {
                // 全文或选择文本切块
                finalChunks = this.splitIntoSemanticChunks(text, targetParagraphId);
            }

            if (finalChunks.length === 0) {
                this.playbackState = 'idle';
                this.broadcastStatus({ state: 'idle' });
                return { success: false, error: '未能生成有效朗读片段' };
            }

            this.playlist = finalChunks;
            this.currentChunkIndex = 0;
            this.ttsConfig = ttsConfig;

            // 开始播放第 0 个分片
            await this.playChunk(0);

            return {
                success: true,
                totalChunks: this.playlist.length,
                mode: mode
            };

        } catch (err) {
            console.error('[Background] startReading 失败:', err);
            this.playbackState = 'idle';
            this.broadcastStatus({ state: 'error', error: err.message });
            return { success: false, error: err.message, reported: true };
        }
    }

    // 调用 GPT-5.6-Luna 生成适合口语朗读的核心摘要
    async generateAISummary(rawText, apiKey) {
        const truncated = rawText.substring(0, 15000); // 截取前 15000 字
        const prompt = `你是一位专业的有声书与新闻播音编辑。请将以下网页内容提炼为一段结构严谨、通俗流畅、适合口语播报的核心摘要（200-400字）。
要求：
1. 语言简练精粹，突出核心论点与关键事实。
2. 适合发音朗读，直接输出播报正文。严禁包含“本文主要介绍了”、“摘要如下”、“总的来说”等套话，不要包含任何 Markdown 格式或特殊符号。`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-5.6-luna', // 严格遵守 Rule 4 核心模型选型规范
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: truncated }
                ],
                temperature: 0.5
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(`AI 摘要生成失败: ${response.status} - ${errData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content?.trim();
        if (!summary) throw new Error('AI 未返回有效摘要内容');
        return summary;
    }

    // 智能语义切分长文本（突破 4096 字符限制并保持自然句段停顿）
    splitIntoSemanticChunks(text, baseElementId = null) {
        if (!text) return [];
        const clean = text.trim();
        if (clean.length <= 600) {
            return [{
                index: 0,
                text: clean,
                elementId: baseElementId,
                total: 1
            }];
        }

        const chunks = [];
        // 按段落和句子自然断句
        const paragraphs = clean.split(/\n+/);
        let currentChunkText = '';

        for (const p of paragraphs) {
            const trimmedP = p.trim();
            if (!trimmedP) continue;

            if (currentChunkText.length + trimmedP.length < 500) {
                currentChunkText += (currentChunkText ? '\n' : '') + trimmedP;
            } else {
                if (currentChunkText) {
                    chunks.push(currentChunkText);
                    currentChunkText = '';
                }

                // 如果单个自然段落超过 500 字，按标点符号进一步切分
                if (trimmedP.length > 500) {
                    const sentenceParts = trimmedP.split(/([。！？!?\.\n]+)/);
                    let subChunk = '';
                    for (let i = 0; i < sentenceParts.length; i += 2) {
                        const sentence = sentenceParts[i] + (sentenceParts[i + 1] || '');
                        if (subChunk.length + sentence.length < 500) {
                            subChunk += sentence;
                        } else {
                            if (subChunk) chunks.push(subChunk);
                            subChunk = sentence;
                        }
                    }
                    if (subChunk) chunks.push(subChunk);
                } else {
                    currentChunkText = trimmedP;
                }
            }
        }

        if (currentChunkText) {
            chunks.push(currentChunkText);
        }

        return chunks.map((item, idx) => ({
            index: idx,
            text: item,
            elementId: baseElementId,
            total: chunks.length
        }));
    }

    // 播放指定分片
    async playChunk(index) {
        if (index < 0 || index >= this.playlist.length) {
            await this.stopReading(true);
            return;
        }

        const token = ++this.playToken;
        const config = this.ttsConfig;
        this.currentChunkIndex = index;
        const chunk = this.playlist[index];

        this.playbackState = 'loading';
        this.broadcastStatus({
            state: 'loading',
            chunkIndex: index,
            totalChunks: this.playlist.length,
            chunk: chunk
        });

        // 1. 检查持久化缓存（IndexedDB）
        const cacheKey = await this.cacheKeyFor(chunk.text, config);
        let audioData = null;
        let fromCache = false;

        const cached = await this.cache.get(cacheKey);
        if (cached && cached.audioData) {
            audioData = cached.audioData;
            fromCache = true;
        } else {
            // 2. 调用当前朗读引擎（OpenAI / ElevenLabs，后者在模型/音色不可用时自动回退）
            const result = await this.fetchTTS(chunk.text, config);
            if (token !== this.playToken) return; // 请求期间已被停止或切换
            audioData = result.audioData;
            const used = result.config;
            const usedKey = used === config ? cacheKey : await this.cacheKeyFor(chunk.text, used);
            // 异步存入缓存
            this.cache.set(usedKey, {
                audioData: audioData,
                text: chunk.text,
                voice: used.voice,
                model: used.ttsModel
            }).catch(() => {});
        }

        if (token !== this.playToken) return;

        // 3. 发送给 Offscreen Document 播放（离屏文档可能因长时间静音被 Chrome 回收，每次播放前确保存在）
        await this.ensureOffscreen();
        if (token !== this.playToken) return;
        const response = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'playAudio',
            audioData: audioData,
            speed: this.currentSpeed,
            meta: {
                chunkIndex: index,
                totalChunks: this.playlist.length,
                elementId: chunk.elementId,
                fromCache: fromCache,
                // 供 Chrome 媒体控制面板显示
                title: chunk.text.replace(/\s+/g, ' ').slice(0, 80),
                pageTitle: this.activeTabTitle
            }
        });

        if (token !== this.playToken) return;
        if (!response || !response.success) {
            throw new Error(response ? response.error : 'Offscreen 播放未响应');
        }

        this.playbackState = 'playing';
        this.broadcastStatus({
            state: 'playing',
            chunkIndex: index,
            totalChunks: this.playlist.length,
            chunk: chunk,
            fromCache: fromCache
        });

        // 4. 流式预缓冲机制 (Pre-buffering)：预先请求下一个分片
        this.prebufferNextChunk(index + 1, this.ttsConfig);
    }

    // 切换分片的安全入口：失败时广播错误，而不是让状态卡在 loading
    async safePlayChunk(index) {
        try {
            await this.playChunk(index);
            return { success: true };
        } catch (err) {
            console.error('[Background] 播放分片失败:', err);
            this.playbackState = 'error';
            this.broadcastStatus({ state: 'error', error: err.message });
            return { success: false, error: err.message };
        }
    }

    // 预缓冲下一个分片
    async prebufferNextChunk(nextIndex, config) {
        if (nextIndex >= this.playlist.length) return;
        const nextChunk = this.playlist[nextIndex];
        if (!nextChunk) return;
        const nextCacheKey = await this.cacheKeyFor(nextChunk.text, config);

        const cached = await this.cache.get(nextCacheKey);
        if (!cached) {
            try {
                const { audioData: nextAudio, config: used } = await this.fetchTTS(nextChunk.text, config);
                const usedKey = used === config ? nextCacheKey : await this.cacheKeyFor(nextChunk.text, used);
                await this.cache.set(usedKey, {
                    audioData: nextAudio,
                    text: nextChunk.text,
                    voice: used.voice,
                    model: used.ttsModel
                });
                console.log(`[Background] 预缓冲分片 ${nextIndex + 1}/${this.playlist.length} 完成`);
            } catch (e) {
                console.warn('[Background] 预缓冲分片失败（不影响主流程）:', e.message);
            }
        }
    }

    // ElevenLabs 的缓存键带上语言：同时让旧版本自动识别读错的缓存失效
    cacheKeyFor(text, config) {
        const model = config.provider === 'elevenlabs'
            ? `${config.ttsModel}|${detectLanguage(text) || 'auto'}`
            : config.ttsModel;
        return this.cache.generateKey(text, config.voice, model);
    }

    // 返回 { audioData, config }，config 为实际使用的配置（ElevenLabs 回退后可能与传入不同）
    async fetchTTS(text, config) {
        if (config.provider === 'elevenlabs') {
            return this.fetchElevenLabsWithFallback(text, config);
        }
        const audioData = await this.fetchOpenAITTS(text, config.apiKey, config.voice, config.ttsModel);
        return { audioData, config };
    }

    // ElevenLabs：当前模型或音色对该账号不可用时，自动换到可用的模型/默认音色，并保存为新的设置
    async fetchElevenLabsWithFallback(text, config) {
        let current = config;
        const tried = new Set();
        let voiceSwitched = false;

        for (;;) {
            tried.add(current.ttsModel);
            try {
                const audioData = await this.fetchElevenLabsTTS(text, current.apiKey, current.voice, current.ttsModel);
                if (current !== config) await this.adoptElevenConfig(config, current);
                return { audioData, config: current };
            } catch (err) {
                const isVoiceError = ELEVEN_VOICE_ERRORS.includes(err.code) ||
                    (['feature_not_available', 'subscription_required'].includes(err.code) && /voice/i.test(err.message));

                if (isVoiceError && !voiceSwitched) {
                    const fallbackVoice = await this.findDefaultElevenVoice(current.apiKey, current.voice);
                    if (!fallbackVoice) throw err;
                    voiceSwitched = true;
                    current = { ...current, voice: fallbackVoice.voice_id, voiceName: fallbackVoice.name };
                    continue;
                }

                if (ELEVEN_MODEL_ERRORS.includes(err.code)) {
                    const { elevenModelStatus = {} } = await chrome.storage.sync.get('elevenModelStatus');
                    if (err.code !== 'insufficient_credits') {
                        // 额度不足不是永久无权限，只在本次跳过，不标记为不可用
                        elevenModelStatus[current.ttsModel] = 'denied';
                        await chrome.storage.sync.set({ elevenModelStatus });
                    }

                    // 优先选「检测可用」确认过的模型，其次按默认回退顺序
                    const verified = Object.keys(elevenModelStatus).filter(id => elevenModelStatus[id] === 'ok');
                    const next = [...verified, ...ELEVEN_MODEL_FALLBACKS]
                        .find(id => !tried.has(id) && elevenModelStatus[id] !== 'denied');
                    if (!next) throw err;
                    current = { ...current, ttsModel: next };
                    continue;
                }

                throw err;
            }
        }
    }

    // 把回退后的模型/音色写回设置，并在页面上提示一次
    async adoptElevenConfig(original, used) {
        const prev = this.ttsConfig;
        if (prev && prev.provider === 'elevenlabs' && prev.apiKey === original.apiKey) {
            this.ttsConfig = { ...prev, ttsModel: used.ttsModel, voice: used.voice };
        }
        const changed = [];
        const update = {};
        if (used.ttsModel !== original.ttsModel) {
            update.elevenModel = used.ttsModel;
            const { elevenModelStatus = {} } = await chrome.storage.sync.get('elevenModelStatus');
            elevenModelStatus[used.ttsModel] = 'ok';
            update.elevenModelStatus = elevenModelStatus;
            changed.push(`模型 ${original.ttsModel} → ${used.ttsModel}`);
        }
        if (used.voice !== original.voice) {
            update.elevenVoiceId = used.voice;
            update.elevenVoiceName = used.voiceName || used.voice;
            changed.push(`音色 → ${used.voiceName || used.voice}`);
        }
        await chrome.storage.sync.set(update);

        const key = changed.join('，');
        if (changed.length && this.lastFallbackNotice !== key) {
            this.lastFallbackNotice = key;
            const message = `当前 ElevenLabs 账号不可用原设置，已自动切换：${key}`;
            if (this.activeTabId) {
                chrome.tabs.sendMessage(this.activeTabId, { action: 'showNotification', message, type: 'info' }).catch(() => {});
            }
            chrome.runtime.sendMessage({ action: 'elevenFallback', message }).catch(() => {});
        }
    }

    // 找一个账号可用的官方默认音色
    async findDefaultElevenVoice(apiKey, excludeId) {
        try {
            const res = await fetch('https://api.elevenlabs.io/v2/voices?voice_type=default&page_size=100', {
                headers: { 'xi-api-key': apiKey }
            });
            if (!res.ok) return null;
            const data = await res.json();
            return (data.voices || []).find(v => v.voice_id !== excludeId) || null;
        } catch (_) {
            return null;
        }
    }

    // 调用 ElevenLabs TTS（默认返回 mp3_44100_128，与现有缓存/播放流程一致；语速由播放器调整）
    elevenRequestBody(text, model) {
        const body = { text: text, model_id: model };
        const language = detectLanguage(text);
        // 官方说明 multilingual_v2 不支持 language_code，其余模型传入以锁定语言
        if (language && !model.startsWith('eleven_multilingual_v2')) {
            body.language_code = language;
        }
        return body;
    }

    async fetchElevenLabsTTS(text, apiKey, voiceId, model = 'eleven_flash_v2_5') {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify(this.elevenRequestBody(text, model))
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            const d = errData.detail;
            const message = Array.isArray(d)
                ? d.map(x => x.msg).join('; ')
                : (d?.message || d?.status || response.statusText);
            const code = Array.isArray(d) ? 'validation_error' : (d?.code || d?.status || '');
            const hint = {
                invalid_api_key: 'API Key 无效，请在设置中重新粘贴',
                missing_api_key: '缺少 API Key',
                insufficient_credits: '本期字符额度已用完',
                rate_limit_exceeded: '请求太频繁，请稍后再试',
                concurrent_limit_exceeded: '并发请求超过套餐限制，请稍后再试'
            }[code];
            const err = new Error(`ElevenLabs TTS 失败: ${response.status} - ${hint ? `${hint}（${message}）` : message}`);
            err.code = code;
            err.httpStatus = response.status;
            throw err;
        }

        const buffer = await response.arrayBuffer();
        return this.arrayBufferToBase64(buffer);
    }

    // 调用 OpenAI 官方 TTS 端点
    async fetchOpenAITTS(text, apiKey, voice = 'nova', model = 'tts-1') {
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model, // 'tts-1' 或 'tts-1-hd'
                voice: voice,
                input: text,
                response_format: 'mp3'
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(`OpenAI TTS 失败: ${response.status} - ${errData.error?.message || response.statusText}`);
        }

        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        return this.arrayBufferToBase64(buffer);
    }

    // ArrayBuffer 转 Base64
    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const step = 0x8000;
        for (let i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        }
        return btoa(binary);
    }

    // 处理来自 Offscreen 播放器的事件
    async handleOffscreenEvent(request) {
        const { event, meta, currentTime, duration, error } = request;

        switch (event) {
            case 'play':
                this.playbackState = 'playing';
                this.broadcastStatus({ state: 'playing', meta: meta });
                break;

            case 'pause':
                this.playbackState = 'paused';
                this.broadcastStatus({ state: 'paused', meta: meta });
                break;

            case 'timeupdate':
                this.broadcastStatus({
                    state: this.playbackState,
                    currentTime: currentTime,
                    duration: duration,
                    meta: meta
                });
                break;

            case 'ended':
                // 自然播放完毕，自动无缝连播下一个分片
                if (this.currentChunkIndex + 1 < this.playlist.length) {
                    await this.safePlayChunk(this.currentChunkIndex + 1);
                } else {
                    // 全文播放完成
                    await this.stopReading(true);
                }
                break;

            case 'error':
                // 仅记录并处理真实异常，过滤掉主动停止或资源重置产生的误报
                if (error && !error.includes('Empty src') && !error.includes('interrupted') && !error.includes('abort')) {
                    console.warn('[Background] Offscreen 播放器异常提示:', error);
                    this.playbackState = 'error';
                    this.broadcastStatus({ state: 'error', error: error, meta: meta });
                }
                break;
        }
    }

    // 暂停播放
    async pauseReading() {
        if (this.playbackState === 'playing') {
            await chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'pauseAudio'
            }).catch(() => {});
            this.playbackState = 'paused';
            this.broadcastStatus({ state: 'paused' });
            return { success: true };
        }
        return { success: false, error: '当前未处于播放状态' };
    }

    // 恢复播放
    async resumeReading() {
        if (this.playbackState === 'paused') {
            // 暂停超过 30 秒后 Chrome 会回收离屏文档，此时从当前分片重新播放（命中缓存，无需重新请求）
            const res = (await this.hasOffscreen())
                ? await chrome.runtime.sendMessage({ target: 'offscreen', action: 'resumeAudio' }).catch(() => null)
                : null;
            if (!res || !res.success) {
                return this.safePlayChunk(this.currentChunkIndex);
            }
            this.playbackState = 'playing';
            this.broadcastStatus({ state: 'playing' });
            return { success: true };
        }
        return { success: false, error: '当前未处于暂停状态' };
    }

    // 停止播放
    async stopReading(isFinished = false) {
        this.playToken++;
        try {
            await chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'stopAudio'
            }).catch(() => {});
        } catch (_) {}

        this.playbackState = 'idle';
        this.playlist = [];
        this.currentChunkIndex = -1;

        this.broadcastStatus({
            state: isFinished ? 'ended' : 'stopped'
        });

        return { success: true };
    }

    // 播放下一段
    async playNextChunk() {
        if (this.currentChunkIndex + 1 < this.playlist.length) {
            return this.safePlayChunk(this.currentChunkIndex + 1);
        }
        return { success: false, error: '已是最后一段' };
    }

    // 播放上一段
    async playPrevChunk() {
        if (this.currentChunkIndex - 1 >= 0) {
            return this.safePlayChunk(this.currentChunkIndex - 1);
        }
        return { success: false, error: '已是第一段' };
    }

    // 当前片段内跳转
    async seekReading(time) {
        if (!(this.playbackState === 'playing' || this.playbackState === 'paused') || !Number.isFinite(time)) {
            return { success: false, error: '当前无法跳转' };
        }
        const res = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'seekAudio',
            time: Math.max(0, time)
        }).catch(() => null);
        return res || { success: false, error: '播放器未响应' };
    }

    // 调整语速
    async updateSpeed(speed) {
        this.currentSpeed = parseFloat(speed) || 1.0;
        await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'setSpeed',
            speed: this.currentSpeed
        }).catch(() => {});

        this.broadcastStatus({ speed: this.currentSpeed });
        return { success: true, speed: this.currentSpeed };
    }

    // 获取当前播放状态
    async getPlaybackStatus() {
        let offscreenStatus = null;
        try {
            offscreenStatus = await chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'getPlaybackStatus'
            });
        } catch (_) {}

        return {
            state: this.playbackState,
            currentChunkIndex: this.currentChunkIndex,
            totalChunks: this.playlist.length,
            currentChunk: this.playlist[this.currentChunkIndex] || null,
            speed: this.currentSpeed,
            mode: this.currentSourceType,
            offscreen: offscreenStatus
        };
    }

    // 向当前关联的 Tab 和 Popup 广播最新状态
    broadcastStatus(data) {
        const payload = {
            action: 'playbackStatusUpdate',
            state: this.playbackState,
            chunkIndex: this.currentChunkIndex,
            totalChunks: this.playlist.length,
            currentChunk: this.playlist[this.currentChunkIndex] || null,
            speed: this.currentSpeed,
            mode: this.currentSourceType,
            ...data
        };

        // 发给网页 Content Script
        if (this.activeTabId) {
            chrome.tabs.sendMessage(this.activeTabId, payload).catch(() => {});
        }

        // 发给 Popup
        chrome.runtime.sendMessage(payload).catch(() => {});
    }
}

// 实例化运行
new ReadifyBackground();