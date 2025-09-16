// background.js - 后台脚本，负责TTS API调用和音频播放
class ReadifyBackground {
    constructor() {
        this.currentAudio = null;
        this.isPlaying = false;
        this.currentParagraphId = null;
        this.currentParagraphIds = []; // 新增：支持多个段落ID
        this.audioCache = new Map(); // 新增：音频缓存
        this.cacheSize = 50; // 最大缓存数量
        this.initMessageListener();
    }

    // 初始化消息监听器
    initMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            switch (request.action) {
                case 'startTTS':
                    this.startTTS(request).then(sendResponse);
                    return true; // 保持消息通道开放
                
                case 'stopTTS':
                    this.stopTTS().then(sendResponse);
                    return true;
                
                case 'audioEvent':
                    this.handleAudioEvent(request);
                    sendResponse({ success: true });
                    return true;
                
                case 'getCacheStats':
                    sendResponse(this.getCacheStats());
                    return true;
                
                case 'clearCache':
                    this.audioCache.clear();
                    sendResponse({ success: true, message: '缓存已清空' });
                    return true;
                
                case 'cleanExpiredCache':
                    this.cleanExpiredCache();
                    sendResponse({ success: true, message: '过期缓存已清理' });
                    return true;
                
                default:
                    sendResponse({ success: false, error: '未知操作' });
            }
        });
    }

    // 开始TTS
    async startTTS(request) {
        try {
            const { text, apiKey, speed = 1.0, voice = 'nova', paragraphIds, lastParagraphId } = request;

            if (!text || !apiKey) {
                return {
                    success: false,
                    error: '缺少必要参数'
                };
            }

            // 停止当前播放
            await this.stopTTS();

            // 如果是段落朗读，更新当前段落ID
            if (paragraphIds && lastParagraphId) {
                this.currentParagraphIds = paragraphIds;
                this.currentParagraphId = lastParagraphId; // 用于向后兼容
            }

            // 检查缓存中是否有音频
            const cachedAudio = this.getCachedAudio(text, voice, speed);
            let audioBlob;

            if (cachedAudio) {
                console.log('使用缓存的音频');
                audioBlob = cachedAudio.blob;
            } else {
                console.log('调用TTS API生成音频');
                // 调用OpenAI TTS API
                audioBlob = await this.callOpenAITTS(text, apiKey, voice);
                
                if (!audioBlob) {
                    return {
                        success: false,
                        error: 'TTS API调用失败'
                    };
                }

                // 将音频存储到缓存
                this.cacheAudio(text, voice, speed, audioBlob);
            }

            // 播放音频
            await this.playAudio(audioBlob, speed, lastParagraphId, paragraphIds);

            return {
                success: true,
                message: cachedAudio ? '播放缓存的音频' : '开始播放音频',
                fromCache: !!cachedAudio
            };

        } catch (error) {
            console.error('TTS失败:', error);
            return {
                success: false,
                error: 'TTS失败: ' + error.message
            };
        }
    }

    // 调用OpenAI TTS API
    async callOpenAITTS(text, apiKey, voice) {
        try {
            // 准备请求数据
            const requestData = {
                model: 'gpt-4o-mini-tts',
                voice: voice,
                input: text,
                response_format: 'mp3'
            };

            // 发送请求到OpenAI API
            const response = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestData)
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`API错误: ${response.status} - ${errorData.error?.message || response.statusText}`);
            }

            // 获取音频数据
            const audioBlob = await response.blob();
            return audioBlob;

        } catch (error) {
            console.error('OpenAI TTS API调用失败:', error);
            throw error;
        }
    }

    // 播放音频
    async playAudio(audioBlob, speed, paragraphId, paragraphIds = []) {
        try {
            // 将Blob转换为ArrayBuffer
            const arrayBuffer = await audioBlob.arrayBuffer();
            
            // 将ArrayBuffer转换为base64字符串
            const base64 = this.arrayBufferToBase64(arrayBuffer);
            
            // 向content script发送消息播放音频
            const response = await this.sendAudioToContentScript(base64, speed, paragraphId, paragraphIds);
            
            if (response.success) {
                this.isPlaying = true;
                this.currentParagraphId = paragraphId;
                this.currentParagraphIds = paragraphIds;
            } else {
                throw new Error(response.error);
            }

        } catch (error) {
            console.error('播放音频失败:', error);
            throw error;
        }
    }

    // 向content script发送音频数据
    async sendAudioToContentScript(base64, speed, paragraphId, paragraphIds = []) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'playAudio',
                audioData: base64,
                speed: speed,
                paragraphId: paragraphId,
                paragraphIds: paragraphIds
            });
            
            return response;
        } catch (error) {
            console.error('发送音频到content script失败:', error);
            return { success: false, error: error.message };
        }
    }

    // 将ArrayBuffer转换为base64字符串
    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    // 更新段落图标状态
    updateParagraphIconState(paragraphId, state) {
        // 向content script发送消息更新图标状态
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    action: 'updateIconState',
                    paragraphId: paragraphId,
                    state: state
                }).catch(() => {
                    // 忽略错误，可能页面已经关闭
                });
            }
        });
    }

    // 停止TTS
    async stopTTS() {
        try {
            if (this.isPlaying) {
                // 通知content script停止播放
                await this.stopAudioInContentScript();
                
                this.isPlaying = false;
                // 清理所有相关段落的状态
                if (this.currentParagraphIds.length > 0) {
                    this.currentParagraphIds.forEach(id => {
                        this.updateParagraphIconState(id, 'stopped');
                    });
                    this.currentParagraphIds = [];
                }
                this.currentParagraphId = null;
            }

            return {
                success: true,
                message: '已停止播放'
            };

        } catch (error) {
            console.error('停止TTS失败:', error);
            return {
                success: false,
                error: '停止播放失败: ' + error.message
            };
        }
    }

    // 通知content script停止音频播放
    async stopAudioInContentScript() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            await chrome.tabs.sendMessage(tab.id, {
                action: 'stopAudio'
            });
        } catch (error) {
            console.error('通知content script停止播放失败:', error);
        }
    }

    // 处理音频事件
    handleAudioEvent(request) {
        const { event, paragraphId } = request;
        
        switch (event) {
            case 'audioStarted':
                this.isPlaying = true;
                this.currentParagraphId = paragraphId;
                // 只更新当前段落的图标状态
                this.updateParagraphIconState(paragraphId, 'playing');
                break;
                
            case 'audioEnded':
                this.isPlaying = false;
                // 只更新当前段落的图标状态
                this.updateParagraphIconState(paragraphId, 'ended');
                this.currentParagraphId = null;
                break;
                
            case 'audioError':
                this.isPlaying = false;
                // 只更新当前段落的图标状态
                this.updateParagraphIconState(paragraphId, 'error');
                this.currentParagraphId = null;
                break;
        }
    }

    // 获取当前播放状态
    getPlaybackStatus() {
        return {
            isPlaying: this.isPlaying,
            hasAudio: false, // 音频现在在content script中播放
            currentParagraphId: this.currentParagraphId,
            currentParagraphIds: this.currentParagraphIds
        };
    }

    // 生成缓存键
    generateCacheKey(text, voice, speed) {
        // 使用文本内容、语音和速度生成唯一的缓存键
        const textHash = this.hashString(text);
        return `${textHash}_${voice}_${speed}`;
    }

    // 简单的字符串哈希函数
    hashString(str) {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString();
    }

    // 检查缓存中是否有音频
    getCachedAudio(text, voice, speed) {
        const cacheKey = this.generateCacheKey(text, voice, speed);
        return this.audioCache.get(cacheKey);
    }

    // 将音频存储到缓存
    cacheAudio(text, voice, speed, audioBlob) {
        const cacheKey = this.generateCacheKey(text, voice, speed);
        
        // 如果缓存已满，删除最旧的条目
        if (this.audioCache.size >= this.cacheSize) {
            const firstKey = this.audioCache.keys().next().value;
            this.audioCache.delete(firstKey);
        }
        
        // 存储音频数据
        this.audioCache.set(cacheKey, {
            blob: audioBlob,
            timestamp: Date.now(),
            text: text.substring(0, 100) + '...' // 存储文本预览
        });
        
        console.log(`音频已缓存，当前缓存大小: ${this.audioCache.size}`);
    }

    // 清理过期缓存
    cleanExpiredCache() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24小时
        
        for (const [key, value] of this.audioCache.entries()) {
            if (now - value.timestamp > maxAge) {
                this.audioCache.delete(key);
            }
        }
    }

    // 获取缓存统计信息
    getCacheStats() {
        return {
            size: this.audioCache.size,
            maxSize: this.cacheSize,
            entries: Array.from(this.audioCache.entries()).map(([key, value]) => ({
                key: key,
                text: value.text,
                timestamp: value.timestamp
            }))
        };
    }
}

// 初始化后台脚本
new ReadifyBackground(); 