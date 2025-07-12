// popup.js - 弹出窗口的主要逻辑
class ReadifyPopup {
    constructor() {
        this.initElements();
        this.bindEvents();
        this.loadSettings();
    }

    // 初始化DOM元素引用
    initElements() {
        this.apiKeyInput = document.getElementById('apiKey');
        this.saveApiKeyBtn = document.getElementById('saveApiKey');
        this.speedSlider = document.getElementById('speedSlider');
        this.speedValue = document.getElementById('speedValue');
        this.voiceSelect = document.getElementById('voiceSelect');
        this.readPageBtn = document.getElementById('readPage');
        this.readSelectionBtn = document.getElementById('readSelection');
        this.stopReadingBtn = document.getElementById('stopReading');
        this.showParagraphIconsCheckbox = document.getElementById('showParagraphIcons');
        this.statusDiv = document.getElementById('status');
    }

    // 绑定事件监听器
    bindEvents() {
        // API Key保存
        this.saveApiKeyBtn.addEventListener('click', () => this.saveApiKey());
        
        // 语速滑块变化
        this.speedSlider.addEventListener('input', (e) => {
            this.speedValue.textContent = `${e.target.value}x`;
            // 实时应用新的语速到当前播放的音频
            this.applySpeedToCurrentAudio(parseFloat(e.target.value));
        });
        
        this.speedSlider.addEventListener('change', () => this.saveSettings());
        
        // 语音选择变化
        this.voiceSelect.addEventListener('change', () => this.saveSettings());
        
        // 段落图标开关
        this.showParagraphIconsCheckbox.addEventListener('change', () => this.toggleParagraphIcons());
        
        // 朗读控制按钮
        this.readPageBtn.addEventListener('click', () => this.readPageText());
        this.readSelectionBtn.addEventListener('click', () => this.readSelectedText());
        this.stopReadingBtn.addEventListener('click', () => this.stopReading());
    }

    // 加载保存的设置
    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get([
                'apiKey', 'speed', 'voice', 'showParagraphIcons'
            ]);
            
            // 恢复API Key
            if (result.apiKey) {
                this.apiKeyInput.value = result.apiKey;
            }
            
            // 恢复语速设置
            if (result.speed) {
                this.speedSlider.value = result.speed;
                this.speedValue.textContent = `${result.speed}x`;
            }
            
            // 恢复语音选择
            if (result.voice) {
                this.voiceSelect.value = result.voice;
            }
            
            // 恢复段落图标设置
            if (result.showParagraphIcons !== undefined) {
                this.showParagraphIconsCheckbox.checked = result.showParagraphIcons;
            }
            
        } catch (error) {
            console.error('加载设置失败:', error);
            this.showStatus('加载设置失败', 'error');
        }
    }

    // 保存API Key
    async saveApiKey() {
        const apiKey = this.apiKeyInput.value.trim();
        
        if (!apiKey) {
            this.showStatus('请输入API Key', 'error');
            return;
        }
        
        try {
            await chrome.storage.sync.set({ apiKey });
            
            // 显示API Key保存成功提示，包含结尾信息
            const lastFourChars = apiKey.slice(-4);
            this.showStatus(`API Key (******** ${lastFourChars}) 保存成功`, 'success');
        } catch (error) {
            console.error('保存API Key失败:', error);
            this.showStatus('保存API Key失败', 'error');
        }
    }

    // 保存设置
    async saveSettings() {
        try {
            const settings = {
                speed: parseFloat(this.speedSlider.value),
                voice: this.voiceSelect.value
            };
            
            await chrome.storage.sync.set(settings);
            this.showStatus('设置已保存', 'success');
        } catch (error) {
            console.error('保存设置失败:', error);
            this.showStatus('保存设置失败', 'error');
        }
    }

    // 切换段落图标显示
    async toggleParagraphIcons() {
        try {
            const showIcons = this.showParagraphIconsCheckbox.checked;
            
            // 保存设置
            await chrome.storage.sync.set({ showParagraphIcons: showIcons });
            
            // 向content script发送消息
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            await chrome.tabs.sendMessage(tab.id, {
                action: 'toggleParagraphIcons',
                show: showIcons
            });
            
            this.showStatus(showIcons ? '已启用段落朗读功能' : '已禁用段落朗读功能', 'success');
            
        } catch (error) {
            console.error('切换段落图标失败:', error);
            this.showStatus('切换段落图标失败', 'error');
        }
    }

    // 实时应用语速到当前播放的音频
    async applySpeedToCurrentAudio(speed) {
        try {
            // 向content script发送消息更新语速
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            await chrome.tabs.sendMessage(tab.id, {
                action: 'updatePlaybackSpeed',
                speed: speed
            });
            
        } catch (error) {
            console.error('更新播放速度失败:', error);
            // 不显示错误提示，因为这是实时操作
        }
    }

    // 朗读页面文字
    async readPageText() {
        try {
            this.setButtonsState(true);
            this.showStatus('正在提取页面文字...', 'info');
            
            // 获取当前活动标签页
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            // 向content script发送消息，提取页面文字
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'extractPageText'
            });
            
            if (response.success && response.text) {
                await this.startReading(response.text);
            } else {
                this.showStatus('无法提取页面文字，请手动选择文字', 'error');
                this.setButtonsState(false);
            }
            
        } catch (error) {
            console.error('朗读页面文字失败:', error);
            this.showStatus('朗读失败: ' + error.message, 'error');
            this.setButtonsState(false);
        }
    }

    // 朗读选中的文字
    async readSelectedText() {
        try {
            this.setButtonsState(true);
            this.showStatus('正在获取选中文字...', 'info');
            
            // 获取当前活动标签页
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            
            // 向content script发送消息，获取选中文字
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: 'getSelectedText'
            });
            
            if (response.success && response.text) {
                await this.startReading(response.text);
            } else {
                this.showStatus('请先选择要朗读的文字', 'error');
                this.setButtonsState(false);
            }
            
        } catch (error) {
            console.error('朗读选中文字失败:', error);
            this.showStatus('朗读失败: ' + error.message, 'error');
            this.setButtonsState(false);
        }
    }

    // 开始朗读
    async startReading(text) {
        try {
            this.showStatus('正在生成语音...', 'info');
            
            // 获取设置
            const result = await chrome.storage.sync.get(['apiKey', 'speed', 'voice']);
            
            if (!result.apiKey) {
                this.showStatus('请先设置API Key', 'error');
                this.setButtonsState(false);
                return;
            }
            
            // 向background script发送消息，开始TTS
            const response = await chrome.runtime.sendMessage({
                action: 'startTTS',
                text: text,
                apiKey: result.apiKey,
                speed: result.speed || 1.0,
                voice: result.voice || 'nova'
            });
            
            if (response.success) {
                this.showStatus('正在朗读...', 'info');
            } else {
                this.showStatus('TTS失败: ' + response.error, 'error');
                this.setButtonsState(false);
            }
            
        } catch (error) {
            console.error('开始朗读失败:', error);
            this.showStatus('朗读失败: ' + error.message, 'error');
            this.setButtonsState(false);
        }
    }

    // 停止朗读
    async stopReading() {
        try {
            await chrome.runtime.sendMessage({ action: 'stopTTS' });
            this.showStatus('已停止朗读', 'info');
            this.setButtonsState(false);
        } catch (error) {
            console.error('停止朗读失败:', error);
            this.showStatus('停止朗读失败', 'error');
        }
    }

    // 设置按钮状态
    setButtonsState(isReading) {
        this.readPageBtn.disabled = isReading;
        this.readSelectionBtn.disabled = isReading;
        this.stopReadingBtn.disabled = !isReading;
    }

    // 显示状态信息
    showStatus(message, type = 'info') {
        this.statusDiv.textContent = message;
        this.statusDiv.className = `status ${type}`;
        
        // 3秒后自动清除成功和错误消息
        if (type === 'success' || type === 'error') {
            setTimeout(() => {
                this.statusDiv.textContent = '';
                this.statusDiv.className = 'status';
            }, 3000);
        }
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    new ReadifyPopup();
}); 