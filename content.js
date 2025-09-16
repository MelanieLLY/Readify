// content.js - 内容脚本，负责与网页交互
class ReadifyContent {
    constructor() {
        this.initMessageListener();
        this.initSelectionListener();
        this.icons = new Set(); // 跟踪已添加的图标
        this.paragraphIconsEnabled = false; // 段落图标是否启用
        this.currentAudio = null; // 当前播放的音频
        this.playedElements = new Set(); // 跟踪已播放的元素
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
                    this.playAudio(request.audioData, request.speed, request.paragraphId, request.paragraphIds).then(sendResponse);
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
                // 暂时禁用自动高亮功能，避免影响文本复制
                // this.highlightSelection(selection);
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

        // 监听DOM变化，为新添加的文本元素添加图标
        this.observer = new MutationObserver((mutations) => {
            if (!this.paragraphIconsEnabled) return;
            
            let shouldUpdate = false;
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // 检查是否添加了段落或列表
                            if (node.tagName === 'P' || 
                                node.tagName === 'UL' || 
                                node.tagName === 'OL' || 
                                node.querySelector('p, ul, ol')) {
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
        
        // 获取所有文本元素（段落和列表）
        const textElements = this.extractTextElements();
        
        textElements.forEach((textElement, index) => {
            const { element, type } = textElement;
            
            // 检查是否已经添加过图标
            if (element.querySelector('.readify-speak-icon')) {
                return;
            }

            // 跳过太短的元素
            if (element.textContent.trim().length < 10) {
                return;
            }

            // 为元素添加唯一ID
            const elementId = `readify-${type}-${Date.now()}-${index}`;
            element.setAttribute('data-readify-id', elementId);

            // 获取格式化后的文本
            const formattedText = this.formatTextElement(textElement);

            // 创建喇叭图标
            const icon = this.createSpeakIcon(elementId, formattedText);
            
            // 将图标添加到元素末尾
            element.appendChild(icon);
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

    // 显示通知
    showNotification(message, type = 'info') {
        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = `readify-notification ${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 16px;
            border-radius: 8px;
            color: white;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            transition: all 0.3s ease;
            max-width: 300px;
            word-wrap: break-word;
        `;

        // 根据类型设置背景色
        switch (type) {
            case 'success':
                notification.style.backgroundColor = '#28a745';
                break;
            case 'error':
                notification.style.backgroundColor = '#dc3545';
                break;
            case 'info':
            default:
                notification.style.backgroundColor = '#667eea';
                break;
        }

        // 添加到页面
        document.body.appendChild(notification);

        // 3秒后自动移除
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }

    // 播放音频
    async playAudio(audioData, speed, paragraphId, paragraphIds = []) {
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
                
                            // 标记当前元素为已播放
            this.playedElements.add(paragraphId);
            this.updateIconState(paragraphId, 'ended');
            
            console.log('播放完成，已播放元素:', Array.from(this.playedElements));
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
            
            // 重置当前播放的图标状态
            const playingIcons = document.querySelectorAll('.readify-speak-icon[data-playing="true"]');
            playingIcons.forEach(icon => {
                const paragraphId = icon.getAttribute('data-paragraph-id');
                if (this.playedElements.has(paragraphId)) {
                    // 如果已经播放过，恢复为已播放状态
                    icon.innerHTML = '✅';
                    icon.setAttribute('data-played', 'true');
                } else {
                    // 如果未播放过，恢复为默认状态
                    icon.innerHTML = '🔊';
                }
                icon.style.opacity = '1';
                icon.removeAttribute('data-playing');
            });
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
        
        // 检查是否已经播放过
        if (this.playedElements.has(paragraphId)) {
            icon.innerHTML = '✅';
            icon.setAttribute('data-played', 'true');
        } else {
            icon.innerHTML = '🔊';
        }
        
        icon.title = '点击朗读此段落';
        
        // 添加点击事件
        icon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.handleIconClick(paragraphId, text);
        });

        return icon;
    }

    // 获取准确的字符数量
    getCharacterCount(text) {
        if (!text) return 0;
        
        // 使用 Array.from() 来正确计算 Unicode 字符数量
        const charCount = Array.from(text).length;
        
        // 调试信息
        console.log('字符计数:', {
            text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
            length: text.length,
            charCount: charCount,
            isChinese: /[\u4e00-\u9fff]/.test(text)
        });
        
        return charCount;
    }

    // 检测文本语言并返回合适的目标字符数
    getTargetCharCount(text) {
        if (!text) return 450;
        
        // 检测是否包含中文字符
        const hasChinese = /[\u4e00-\u9fff]/.test(text);
        const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff]/.test(text);
        const hasKorean = /[\uac00-\ud7af]/.test(text);
        
        // 如果包含东亚语言字符，使用较小的目标字符数
        if (hasChinese || hasJapanese || hasKorean) {
            console.log('检测到东亚语言，使用较小的目标字符数: 200');
            return 200;
        }
        
        console.log('使用默认目标字符数: 450');
        return 450;
    }

    // 合并文本元素直到达到目标字符数
    async mergeParagraphs(startElementId, targetChars = null) {
        try {
            // 查找所有带有data-readify-id的文本元素（段落和列表）
            const textElements = document.querySelectorAll('p[data-readify-id], ul[data-readify-id], ol[data-readify-id]');
            const startIndex = Array.from(textElements).findIndex(el => el.getAttribute('data-readify-id') === startElementId);
            
            if (startIndex === -1) {
                return {
                    success: false,
                    error: '找不到起始元素'
                };
            }

            // 获取起始元素的文本内容来检测语言
            const startElement = textElements[startIndex];
            let startText = '';
            if (startElement.tagName === 'P') {
                startText = startElement.textContent.trim();
            } else if (startElement.tagName === 'UL' || startElement.tagName === 'OL') {
                startText = this.formatList(startElement);
            }

            // 如果没有指定目标字符数，根据语言自适应
            if (targetChars === null) {
                targetChars = this.getTargetCharCount(startText);
            }

            let mergedText = '';
            let mergedElementIds = [];
            let currentIndex = startIndex;
            let totalCharCount = 0;

            console.log('开始合并段落，目标字符数:', targetChars);

            // 从起始元素开始，逐步添加元素直到达到目标字符数
            while (currentIndex < textElements.length) {
                const element = textElements[currentIndex];
                const elementId = element.getAttribute('data-readify-id');
                
                // 根据元素类型获取格式化文本
                let text = '';
                if (element.tagName === 'P') {
                    text = element.textContent.trim();
                } else if (element.tagName === 'UL' || element.tagName === 'OL') {
                    text = this.formatList(element);
                }
                
                if (text) {
                    const textCharCount = this.getCharacterCount(text);
                    const separatorCharCount = this.getCharacterCount('\n\n');
                    
                    mergedText += text + '\n\n';
                    mergedElementIds.push(elementId);
                    totalCharCount += textCharCount + separatorCharCount;
                    
                    console.log('添加元素:', {
                        elementId: elementId,
                        textLength: text.length,
                        charCount: textCharCount,
                        totalCharCount: totalCharCount,
                        targetChars: targetChars
                    });
                    
                    // 如果累计字符数达到目标，停止合并
                    if (totalCharCount >= targetChars) {
                        console.log('达到目标字符数，停止合并');
                        break;
                    }
                }
                
                currentIndex++;
            }

            // 如果合并后仍然没有达到目标字符数，但已经合并了多个元素，也继续
            if (mergedElementIds.length === 0) {
                return {
                    success: false,
                    error: '没有找到可合并的元素'
                };
            }

            const finalCharCount = this.getCharacterCount(mergedText.trim());
            console.log('合并完成:', {
                elementCount: mergedElementIds.length,
                finalCharCount: finalCharCount,
                targetChars: targetChars
            });

            return {
                success: true,
                text: mergedText.trim(),
                paragraphIds: mergedElementIds, // 保持向后兼容
                elementIds: mergedElementIds,
                lastParagraphId: mergedElementIds[mergedElementIds.length - 1], // 保持向后兼容
                charCount: finalCharCount
            };

        } catch (error) {
            console.error('合并文本元素失败:', error);
            return {
                success: false,
                error: '合并文本元素时发生错误: ' + error.message
            };
        }
    }

    // 处理图标点击事件
    async handleIconClick(paragraphId, text) {
        try {
            console.log('点击图标，段落ID:', paragraphId, '是否已播放:', this.playedElements.has(paragraphId));
            
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

            // 合并段落（使用自适应目标字符数）
            const mergeResult = await this.mergeParagraphs(paragraphId, null);
            if (!mergeResult.success) {
                console.error('合并段落失败:', mergeResult.error);
                this.updateIconState(paragraphId, 'error');
                return;
            }

            // 为当前元素显示加载状态
            this.updateIconState(paragraphId, 'loading');

            // 发送消息给background script开始朗读
            const response = await chrome.runtime.sendMessage({
                action: 'startTTS',
                text: mergeResult.text,
                apiKey: settings.apiKey,
                speed: settings.speed || 1.0,
                voice: settings.voice || 'nova',
                paragraphIds: mergeResult.paragraphIds,
                lastParagraphId: mergeResult.lastParagraphId
            });

            if (!response.success) {
                console.error('朗读失败:', response.error);
                this.updateIconState(paragraphId, 'error');
            } else {
                // 为当前元素设置播放状态
                this.updateIconState(paragraphId, 'playing');
                
                // 显示缓存状态信息
                if (response.fromCache) {
                    this.showNotification('使用缓存的音频', 'info');
                } else {
                    this.showNotification('生成新的音频', 'info');
                }
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
        if (!icon) {
            console.log('找不到图标:', paragraphId);
            return;
        }

        console.log('更新图标状态:', paragraphId, state);

        // 清除所有状态属性
        icon.removeAttribute('data-loading');
        icon.removeAttribute('data-playing');
        icon.removeAttribute('data-played');
        icon.removeAttribute('data-error');

        switch (state) {
            case 'loading':
                icon.innerHTML = '⏳';
                icon.style.opacity = '0.7';
                icon.setAttribute('data-loading', 'true');
                console.log('设置为加载状态');
                break;
            
            case 'playing':
                icon.innerHTML = '🔊';
                icon.style.opacity = '1';
                icon.setAttribute('data-playing', 'true');
                console.log('设置为播放状态');
                break;
            
            case 'ended':
                icon.innerHTML = '✅';
                icon.style.opacity = '1';
                icon.setAttribute('data-played', 'true');
                console.log('设置为已播放状态');
                break;
            
            case 'stopped':
                icon.innerHTML = '🔊';
                icon.style.opacity = '1';
                console.log('设置为停止状态');
                break;
            
            case 'error':
                icon.innerHTML = '❌';
                icon.style.opacity = '1';
                icon.setAttribute('data-error', 'true');
                console.log('设置为错误状态');
                // 3秒后恢复默认状态
                setTimeout(() => {
                    if (icon) {
                        icon.innerHTML = '🔊';
                        icon.removeAttribute('data-error');
                        console.log('错误状态已恢复');
                    }
                }, 3000);
                break;
        }
    }

    // 朗读指定段落
    async readParagraph(paragraphId) {
        try {
            // 使用段落合并功能
            const mergeResult = await this.mergeParagraphs(paragraphId);
            if (!mergeResult.success) {
                return {
                    success: false,
                    error: mergeResult.error
                };
            }

            return {
                success: true,
                text: mergeResult.text,
                source: 'merged-paragraphs',
                paragraphIds: mergeResult.paragraphIds,
                lastParagraphId: mergeResult.lastParagraphId
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
            // 策略1: 尝试提取所有<p>标签和列表的文字
            const textElements = this.extractTextElements();
            if (textElements.length > 0) {
                const text = textElements
                    .map(element => this.formatTextElement(element))
                    .filter(text => text.length > 10) // 过滤掉太短的段落
                    .join('\n\n');
                
                if (text.length > 50) { // 确保有足够的内容
                    return {
                        success: true,
                        text: text,
                        source: 'text-elements'
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

    // 提取文本元素（包括段落和列表）
    extractTextElements() {
        const elements = [];
        
        // 获取所有段落
        const paragraphs = document.querySelectorAll('p');
        paragraphs.forEach(p => {
            if (p.textContent.trim().length > 10) {
                elements.push({ element: p, type: 'paragraph' });
            }
        });
        
        // 获取所有列表
        const lists = document.querySelectorAll('ul, ol');
        lists.forEach(list => {
            if (list.textContent.trim().length > 10) {
                elements.push({ element: list, type: 'list' });
            }
        });
        
        // 按DOM位置排序
        elements.sort((a, b) => {
            const aRect = a.element.getBoundingClientRect();
            const bRect = b.element.getBoundingClientRect();
            return aRect.top - bRect.top;
        });
        
        return elements;
    }

    // 格式化文本元素
    formatTextElement(textElement) {
        const { element, type } = textElement;
        
        if (type === 'paragraph') {
            return element.textContent.trim();
        } else if (type === 'list') {
            return this.formatList(element);
        }
        
        return element.textContent.trim();
    }

    // 格式化列表
    formatList(listElement) {
        const items = listElement.querySelectorAll('li');
        const isOrdered = listElement.tagName === 'OL';
        
        return Array.from(items)
            .map((item, index) => {
                const itemText = item.textContent.trim();
                if (isOrdered) {
                    return `${index + 1}. ${itemText}`;
                } else {
                    return `• ${itemText}`;
                }
            })
            .join('\n');
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

            // 使用准确的字符计数限制选中文字的长度
            const maxLength = 2000;
            const charCount = this.getCharacterCount(selectedText);
            const text = charCount > maxLength 
                ? Array.from(selectedText).slice(0, maxLength).join('') + '...'
                : selectedText;

            console.log('选中文字字符计数:', {
                originalLength: selectedText.length,
                charCount: charCount,
                finalLength: text.length
            });

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
            if (parent) {
                parent.replaceChild(document.createTextNode(el.textContent), el);
                parent.normalize();
            }
        });

        // 添加新的高亮（使用更安全的方法）
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            
            // 检查是否可以安全地添加高亮
            if (this.canSafelyHighlight(range)) {
                const span = document.createElement('span');
                span.className = 'readify-highlight';
                span.style.backgroundColor = '#ffeb3b';
                span.style.padding = '2px 4px';
                span.style.borderRadius = '3px';
                span.style.display = 'inline';
                span.style.userSelect = 'text'; // 确保文本可以被选择
                
                try {
                    range.surroundContents(span);
                } catch (e) {
                    console.log('高亮选中文字失败:', e);
                }
            }
        }
    }

    // 检查是否可以安全地添加高亮
    canSafelyHighlight(range) {
        try {
            // 检查是否在可编辑元素内
            const container = range.commonAncestorContainer;
            if (container.nodeType === Node.ELEMENT_NODE) {
                const element = container;
                if (element.contentEditable === 'true' || 
                    element.tagName === 'INPUT' || 
                    element.tagName === 'TEXTAREA') {
                    return false;
                }
            }
            
            // 检查是否在表单元素内
            const formElements = range.commonAncestorContainer.parentElement?.closest('form');
            if (formElements) {
                return false;
            }
            
            return true;
        } catch (e) {
            return false;
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