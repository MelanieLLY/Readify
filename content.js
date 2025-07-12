// content.js - 内容脚本，负责与网页交互
class ReadifyContent {
    constructor() {
        this.initMessageListener();
        this.initSelectionListener();
        this.icons = new Set(); // 跟踪已添加的图标
        this.paragraphIconsEnabled = false; // 段落图标是否启用
        this.currentAudio = null; // 当前播放的音频
        this.initParagraphIcons();
    }

    // 初始化消息监听器
    initMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            switch (request.action) {
                case 'extractPageText':
                    this.extractPageText().then(sendResponse);
                    return true; // 保持消息通道开放
                
                case 'getSelectedText':
                    this.getSelectedText().then(sendResponse);
                    return true;
                
                case 'readParagraph':
                    this.readParagraph(request.paragraphId).then(sendResponse);
                    return true;
                
                case 'updateIconState':
                    this.updateIconState(request.paragraphId, request.state);
                    sendResponse({ success: true });
                    return true;
                
                case 'toggleParagraphIcons':
                    this.toggleParagraphIcons(request.show);
                    sendResponse({ success: true });
                    return true;
                
                case 'playAudio':
                    this.playAudio(request.audioData, request.speed, request.paragraphId).then(sendResponse);
                    return true;
                
                case 'stopAudio':
                    this.stopAudio();
                    sendResponse({ success: true });
                    return true;
                
                case 'updatePlaybackSpeed':
                    this.updatePlaybackSpeed(request.speed);
                    sendResponse({ success: true });
                    return true;
                
                default:
                    sendResponse({ success: false, error: '未知操作' });
            }
        });
    }

    // 初始化选择监听器
    initSelectionListener() {
        // 监听用户选择文字的变化
        document.addEventListener('selectionchange', () => {
            const selection = window.getSelection();
            if (selection && selection.toString().trim()) {
                // 可以在这里添加高亮选中文字的功能
                this.highlightSelection(selection);
            }
        });
    }

    // 初始化段落图标
    async initParagraphIcons() {
        // 检查是否启用段落图标
        try {
            const result = await chrome.storage.sync.get(['showParagraphIcons']);
            this.paragraphIconsEnabled = result.showParagraphIcons || false;
            
            if (this.paragraphIconsEnabled) {
                this.addParagraphIcons();
            }
        } catch (error) {
            console.error('检查段落图标设置失败:', error);
        }

        // 监听DOM变化，为新添加的段落添加图标
        this.observer = new MutationObserver((mutations) => {
            if (!this.paragraphIconsEnabled) return;
            
            let shouldUpdate = false;
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.tagName === 'P' || node.querySelector('p')) {
                                shouldUpdate = true;
                            }
                        }
                    });
                }
            });
            
            if (shouldUpdate) {
                setTimeout(() => this.addParagraphIcons(), 100);
            }
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 为段落添加喇叭图标
    addParagraphIcons() {
        if (!this.paragraphIconsEnabled) return;
        
        const paragraphs = document.querySelectorAll('p');
        
        paragraphs.forEach((paragraph, index) => {
            // 检查是否已经添加过图标
            if (paragraph.querySelector('.readify-speak-icon')) {
                return;
            }

            // 跳过太短的段落
            if (paragraph.textContent.trim().length < 10) {
                return;
            }

            // 为段落添加唯一ID
            const paragraphId = `readify-p-${Date.now()}-${index}`;
            paragraph.setAttribute('data-readify-id', paragraphId);

            // 创建喇叭图标
            const icon = this.createSpeakIcon(paragraphId, paragraph.textContent.trim());
            
            // 将图标添加到段落末尾
            paragraph.appendChild(icon);
            this.icons.add(icon);
        });
    }

    // 切换段落图标显示
    toggleParagraphIcons(show) {
        this.paragraphIconsEnabled = show;
        
        if (show) {
            this.addParagraphIcons();
        } else {
            this.removeAllParagraphIcons();
        }
    }

    // 移除所有段落图标
    removeAllParagraphIcons() {
        const icons = document.querySelectorAll('.readify-speak-icon');
        icons.forEach(icon => {
            icon.remove();
        });
        this.icons.clear();
    }

    // 显示错误通知
    showErrorNotification(message) {
        // 移除已存在的通知
        const existingNotification = document.querySelector('.readify-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = 'readify-notification';
        notification.innerHTML = `
            <div class="notification-content">
                <span class="notification-icon">⚠️</span>
                <span class="notification-text">${message}</span>
                <button class="notification-close">×</button>
            </div>
        `;

        // 添加关闭按钮事件
        const closeBtn = notification.querySelector('.notification-close');
        closeBtn.addEventListener('click', () => {
            notification.remove();
        });

        // 添加到页面
        document.body.appendChild(notification);

        // 5秒后自动移除
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 5000);
    }

    // 播放音频
    async playAudio(audioData, speed, paragraphId) {
        try {
            // 停止当前播放的音频
            this.stopAudio();
            
            // 创建data URL
            const audioUrl = `data:audio/mp3;base64,${audioData}`;
            
            // 创建音频元素
            this.currentAudio = new Audio(audioUrl);
            
            // 设置播放速度
            this.currentAudio.playbackRate = speed;
            
            // 设置事件监听器
            this.currentAudio.addEventListener('ended', () => {
                // 通知background script播放结束
                this.notifyBackgroundScript('audioEnded', paragraphId);
                this.currentAudio = null;
            });

            this.currentAudio.addEventListener('error', (error) => {
                console.error('音频播放错误:', error);
                // 通知background script播放错误
                this.notifyBackgroundScript('audioError', paragraphId);
                this.currentAudio = null;
            });

            // 开始播放
            await this.currentAudio.play();
            
            // 通知background script开始播放
            this.notifyBackgroundScript('audioStarted', paragraphId);
            
            return { success: true };

        } catch (error) {
            console.error('播放音频失败:', error);
            return { success: false, error: error.message };
        }
    }

    // 停止音频播放
    stopAudio() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            this.currentAudio.src = '';
            this.currentAudio = null;
        }
    }

    // 更新播放速度
    updatePlaybackSpeed(speed) {
        if (this.currentAudio && !this.currentAudio.paused) {
            this.currentAudio.playbackRate = speed;
            console.log(`播放速度已更新为: ${speed}x`);
        }
    }

    // 通知background script音频状态变化
    async notifyBackgroundScript(event, paragraphId) {
        try {
            await chrome.runtime.sendMessage({
                action: 'audioEvent',
                event: event,
                paragraphId: paragraphId
            });
        } catch (error) {
            console.error('通知background script失败:', error);
        }
    }

    // 创建喇叭图标
    createSpeakIcon(paragraphId, text) {
        const icon = document.createElement('span');
        icon.className = 'readify-speak-icon';
        icon.setAttribute('data-paragraph-id', paragraphId);
        icon.setAttribute('data-text', text);
        icon.innerHTML = '🔊';
        icon.title = '点击朗读此段落';
        
        // 添加点击事件
        icon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleIconClick(paragraphId, text);
        });

        return icon;
    }

    // 处理图标点击
    async handleIconClick(paragraphId, text) {
        try {
            // 显示加载状态
            const icon = document.querySelector(`[data-paragraph-id="${paragraphId}"]`);
            if (icon) {
                icon.innerHTML = '⏳';
                icon.style.opacity = '0.7';
                icon.setAttribute('data-loading', 'true');
            }

            // 获取用户设置
            const settings = await chrome.storage.sync.get(['apiKey', 'speed', 'voice']);
            
            if (!settings.apiKey) {
                console.error('未设置API Key');
                this.updateIconState(paragraphId, 'error');
                // 显示提示信息
                this.showErrorNotification('请先在插件设置中配置OpenAI API Key');
                return;
            }

            // 发送消息给background script开始朗读
            const response = await chrome.runtime.sendMessage({
                action: 'startTTS',
                text: text,
                apiKey: settings.apiKey,
                speed: settings.speed || 1.0,
                voice: settings.voice || 'nova',
                paragraphId: paragraphId
            });

            if (!response.success) {
                console.error('朗读失败:', response.error);
                // 恢复图标状态
                this.updateIconState(paragraphId, 'error');
            }

        } catch (error) {
            console.error('处理图标点击失败:', error);
            // 恢复图标状态
            this.updateIconState(paragraphId, 'error');
        }
    }

    // 更新图标状态
    updateIconState(paragraphId, state) {
        const icon = document.querySelector(`[data-paragraph-id="${paragraphId}"]`);
        if (!icon) return;

        switch (state) {
            case 'loading':
                icon.innerHTML = '⏳';
                icon.style.opacity = '0.7';
                icon.setAttribute('data-loading', 'true');
                break;
            
            case 'playing':
                icon.innerHTML = '🔊';
                icon.style.opacity = '1';
                icon.setAttribute('data-loading', 'false');
                icon.style.backgroundColor = '#4caf50';
                break;
            
            case 'ended':
            case 'stopped':
                icon.innerHTML = '🔊';
                icon.style.opacity = '1';
                icon.setAttribute('data-loading', 'false');
                icon.style.backgroundColor = '#667eea';
                break;
            
            case 'error':
                icon.innerHTML = '❌';
                icon.style.opacity = '1';
                icon.setAttribute('data-loading', 'false');
                icon.style.backgroundColor = '#f44336';
                // 3秒后恢复默认状态
                setTimeout(() => {
                    if (icon) {
                        icon.innerHTML = '🔊';
                        icon.style.backgroundColor = '#667eea';
                    }
                }, 3000);
                break;
        }
    }

    // 朗读指定段落
    async readParagraph(paragraphId) {
        try {
            const paragraph = document.querySelector(`[data-readify-id="${paragraphId}"]`);
            if (!paragraph) {
                return {
                    success: false,
                    error: '找不到指定段落'
                };
            }

            const text = paragraph.textContent.trim();
            if (!text) {
                return {
                    success: false,
                    error: '段落内容为空'
                };
            }

            return {
                success: true,
                text: text,
                source: 'paragraph'
            };

        } catch (error) {
            console.error('朗读段落失败:', error);
            return {
                success: false,
                error: '朗读段落时发生错误: ' + error.message
            };
        }
    }

    // 提取页面文字
    async extractPageText() {
        try {
            // 策略1: 尝试提取所有<p>标签的文字
            const paragraphs = document.querySelectorAll('p');
            if (paragraphs.length > 0) {
                const text = Array.from(paragraphs)
                    .map(p => p.textContent.trim())
                    .filter(text => text.length > 10) // 过滤掉太短的段落
                    .join('\n\n');
                
                if (text.length > 50) { // 确保有足够的内容
                    return {
                        success: true,
                        text: text,
                        source: 'paragraphs'
                    };
                }
            }

            // 策略2: 尝试提取主要内容区域
            const mainContent = this.extractMainContent();
            if (mainContent) {
                return {
                    success: true,
                    text: mainContent,
                    source: 'main-content'
                };
            }

            // 策略3: 提取所有文本内容（作为后备方案）
            const allText = this.extractAllText();
            if (allText) {
                return {
                    success: true,
                    text: allText,
                    source: 'all-text'
                };
            }

            return {
                success: false,
                error: '无法找到可朗读的文字内容'
            };

        } catch (error) {
            console.error('提取页面文字失败:', error);
            return {
                success: false,
                error: '提取文字时发生错误: ' + error.message
            };
        }
    }

    // 提取主要内容区域
    extractMainContent() {
        // 尝试找到主要内容区域
        const selectors = [
            'main',
            'article',
            '.content',
            '.main-content',
            '.post-content',
            '.entry-content',
            '#content',
            '#main',
            '.article-content'
        ];

        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
                const text = this.cleanText(element.textContent);
                if (text.length > 100) {
                    return text;
                }
            }
        }

        return null;
    }

    // 提取所有文本内容
    extractAllText() {
        // 获取body的文本内容，但排除脚本、样式等
        const body = document.body;
        if (!body) return null;

        // 创建临时元素来获取纯文本
        const temp = document.createElement('div');
        temp.innerHTML = body.innerHTML;

        // 移除脚本、样式、导航等不需要的元素
        const elementsToRemove = temp.querySelectorAll('script, style, nav, header, footer, .nav, .navigation, .menu, .sidebar, .ad, .advertisement');
        elementsToRemove.forEach(el => el.remove());

        const text = this.cleanText(temp.textContent);
        return text.length > 50 ? text : null;
    }

    // 清理文本内容
    cleanText(text) {
        if (!text) return '';
        
        return text
            .replace(/\s+/g, ' ') // 合并多个空白字符
            .replace(/\n+/g, '\n') // 合并多个换行符
            .trim()
            .substring(0, 5000); // 限制长度，避免过长的文本
    }

    // 获取用户选中的文字
    async getSelectedText() {
        try {
            const selection = window.getSelection();
            const selectedText = selection.toString().trim();

            if (selectedText.length === 0) {
                return {
                    success: false,
                    error: '请先选择要朗读的文字'
                };
            }

            // 限制选中文字的长度
            const maxLength = 2000;
            const text = selectedText.length > maxLength 
                ? selectedText.substring(0, maxLength) + '...'
                : selectedText;

            return {
                success: true,
                text: text,
                source: 'selection'
            };

        } catch (error) {
            console.error('获取选中文字失败:', error);
            return {
                success: false,
                error: '获取选中文字时发生错误: ' + error.message
            };
        }
    }

    // 高亮选中的文字（可选功能）
    highlightSelection(selection) {
        // 移除之前的高亮
        const existingHighlights = document.querySelectorAll('.readify-highlight');
        existingHighlights.forEach(el => {
            const parent = el.parentNode;
            parent.replaceChild(document.createTextNode(el.textContent), el);
            parent.normalize();
        });

        // 添加新的高亮
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const span = document.createElement('span');
            span.className = 'readify-highlight';
            span.style.backgroundColor = '#ffeb3b';
            span.style.padding = '2px 4px';
            span.style.borderRadius = '3px';
            
            try {
                range.surroundContents(span);
            } catch (e) {
                // 如果surroundContents失败，尝试其他方法
                console.log('高亮选中文字失败:', e);
            }
        }
    }
}

// 页面加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new ReadifyContent();
    });
} else {
    new ReadifyContent();
} 