// background.js - 后台脚本，负责TTS API调用和音频播放
class ReadifyBackground {
    constructor() {
        this.currentAudio = null;
        this.isPlaying = false;
        this.currentParagraphId = null;
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
                
                default:
                    sendResponse({ success: false, error: '未知操作' });
            }
        });
    }

    // 开始TTS
    async startTTS(request) {
        try {
            const { text, apiKey, speed = 1.0, voice = 'nova', paragraphId } = request;

            if (!text || !apiKey) {
                return {
                    success: false,
                    error: '缺少必要参数'
                };
            }

            // 停止当前播放
            await this.stopTTS();

            // 如果是段落朗读，更新当前段落ID
            if (paragraphId) {
                this.currentParagraphId = paragraphId;
            }

            // 调用OpenAI TTS API
            const audioBlob = await this.callOpenAITTS(text, apiKey, voice);
            
            if (!audioBlob) {
                return {
                    success: false,
                    error: 'TTS API调用失败'
                };
            }

            // 播放音频
            await this.playAudio(audioBlob, speed, paragraphId);

            return {
                success: true,
                message: '开始播放音频'
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
    async playAudio(audioBlob, speed, paragraphId) {
        try {
            // 将Blob转换为ArrayBuffer
            const arrayBuffer = await audioBlob.arrayBuffer();
            
            // 将ArrayBuffer转换为base64字符串
            const base64 = this.arrayBufferToBase64(arrayBuffer);
            
            // 向content script发送消息播放音频
            const response = await this.sendAudioToContentScript(base64, speed, paragraphId);
            
            if (response.success) {
                this.isPlaying = true;
                this.currentParagraphId = paragraphId;
            } else {
                throw new Error(response.error);
            }

        } catch (error) {
            console.error('播放音频失败:', error);
            throw error;
        }
    }

    // 向content script发送音频数据
    async sendAudioToContentScript(base64, speed, paragraphId) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'playAudio',
                audioData: base64,
                speed: speed,
                paragraphId: paragraphId
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
                this.updateParagraphIconState(paragraphId, 'playing');
                break;
                
            case 'audioEnded':
                this.isPlaying = false;
                this.currentParagraphId = null;
                this.updateParagraphIconState(paragraphId, 'ended');
                break;
                
            case 'audioError':
                this.isPlaying = false;
                this.currentParagraphId = null;
                this.updateParagraphIconState(paragraphId, 'error');
                break;
        }
    }

    // 获取当前播放状态
    getPlaybackStatus() {
        return {
            isPlaying: this.isPlaying,
            hasAudio: false, // 音频现在在content script中播放
            currentParagraphId: this.currentParagraphId
        };
    }
}

// 初始化后台脚本
new ReadifyBackground(); 