// content.js - 网页内容交互、段落图标、句段高亮跟随与悬浮迷你播放器
// 包在 IIFE 中：popup 可能对已存在旧脚本的页面重新注入，避免 class 重复声明报错
(() => {

    class ReadifyContent {
        constructor() {
            this.paragraphIconsEnabled = false;
            this.activeHighlightElement = null;
            this.currentStatus = { state: 'idle' };
            this.playerShadow = null;
            this.playerRoot = null;

            this.initMessageListener();
            this.initSettings();
            this.initMiniPlayer();
        }

        // 初始化配置
        async initSettings() {
            try {
                const settings = await chrome.storage.sync.get(['showParagraphIcons']);
                this.paragraphIconsEnabled = !!settings.showParagraphIcons;
                if (this.paragraphIconsEnabled) {
                    this.renderParagraphIcons();
                }
            } catch (_) {}
        }

        // 初始化消息通道
        initMessageListener() {
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                switch (request.action) {
                    case 'extractPageContent':
                        this.extractPageContent().then(sendResponse);
                        return true;

                    case 'getSelectedText':
                        sendResponse(this.getSelectedText());
                        return true;

                    case 'playbackStatusUpdate':
                        this.handlePlaybackStatusUpdate(request);
                        sendResponse({ success: true });
                        return true;

                    case 'toggleParagraphIcons':
                        this.paragraphIconsEnabled = !!request.show;
                        if (this.paragraphIconsEnabled) {
                            this.renderParagraphIcons();
                        } else {
                            this.removeParagraphIcons();
                        }
                        sendResponse({ success: true });
                        return true;

                    case 'showNotification':
                        this.showToast(request.message, request.type || 'info');
                        sendResponse({ success: true });
                        return true;

                    default:
                        return false;
                }
            });
        }

        // 获取选中文本
        getSelectedText() {
            const selection = window.getSelection();
            const text = selection ? selection.toString().trim() : '';
            return {
                success: !!text,
                text: text,
                length: text.length
            };
        }

        // 智能提取正文内容并建立 DOM 映射（修复原版跳过标题、DOM卡顿与表情包污染的 Bug）
        async extractPageContent() {
            try {
                const title = document.title || '';
                const root = this.findMainContentRoot();

                // 抓取标题、段落、引用与列表
                const candidateElements = root.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote, li');
                const validBlocks = [];

                candidateElements.forEach((el, index) => {
                    // 忽略导航、页眉、页脚、侧边栏或隐藏元素
                    if (this.isNoiseElement(el)) return;

                    // 提取纯净文本，彻底剔除已存在的喇叭图标，绝不污染朗读内容
                    const cleanText = this.getCleanTextFromElement(el);
                    if (cleanText.length < 8) return;

                    const elementId = el.getAttribute('data-readify-id') || `readify-block-${Date.now()}-${index}`;
                    el.setAttribute('data-readify-id', elementId);

                    validBlocks.push({
                        elementId: elementId,
                        text: cleanText,
                        tag: el.tagName.toLowerCase()
                    });
                });

                if (validBlocks.length === 0) {
                    return { success: false, error: '未能在当前页面找到足够的可朗读正文' };
                }

                // 组合并返回结构化数据
                const fullText = validBlocks.map(b => b.text).join('\n\n');

                return {
                    success: true,
                    title: title,
                    blocks: validBlocks,
                    fullText: fullText
                };

            } catch (err) {
                console.error('[Content] 提取正文失败:', err);
                return { success: false, error: err.message };
            }
        }

        // 查找主要正文区域
        findMainContentRoot() {
            const selectors = ['article', 'main', '.article-content', '.post-content', '.entry-content', '#content', '#main'];
            for (const sel of selectors) {
                const target = document.querySelector(sel);
                if (target && target.innerText && target.innerText.length > 300) {
                    return target;
                }
            }
            return document.body;
        }

        // 过滤页面噪音（广告、导航、版权、工具栏）
        isNoiseElement(el) {
            if (!el || el.offsetParent === null) return true; // 隐藏元素
            const tag = el.tagName.toLowerCase();
            if (['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript'].includes(tag)) return true;

            const parentCls = (el.closest('header, footer, nav, aside, .sidebar, .comments, .comment, .nav, .ad, .advertisement') !== null);
            if (parentCls) return true;

            return false;
        }

        // 获取纯净文本（剥离所有插件生成的 UI 图标）
        getCleanTextFromElement(element) {
            const clone = element.cloneNode(true);
            // 彻底移除喇叭图标
            const icons = clone.querySelectorAll('.readify-speak-icon');
            icons.forEach(ic => ic.remove());
            return (clone.textContent || '').replace(/\s+/g, ' ').trim();
        }

        // 为正文段落添加朗读图标
        renderParagraphIcons() {
            if (!this.paragraphIconsEnabled) return;

            const root = this.findMainContentRoot();
            const elements = root.querySelectorAll('p, blockquote, h1, h2, h3');

            elements.forEach((el, index) => {
                if (this.isNoiseElement(el)) return;
                if (el.querySelector('.readify-speak-icon')) return;

                const text = this.getCleanTextFromElement(el);
                if (text.length < 15) return;

                const elementId = el.getAttribute('data-readify-id') || `readify-block-${Date.now()}-${index}`;
                el.setAttribute('data-readify-id', elementId);

                const iconBtn = document.createElement('span');
                iconBtn.className = 'readify-speak-icon';
                iconBtn.setAttribute('data-block-id', elementId);
                iconBtn.innerHTML = '🔊 朗读';
                iconBtn.title = '使用 Readify 朗读此段';

                iconBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.triggerBlockReading(elementId);
                });

                // 智能放置在元素末尾
                el.appendChild(iconBtn);
            });
        }

        // 移除所有段落图标
        removeParagraphIcons() {
            document.querySelectorAll('.readify-speak-icon').forEach(el => el.remove());
        }

        // 点击单个段落喇叭触发朗读
        async triggerBlockReading(elementId) {
            const targetEl = document.querySelector(`[data-readify-id="${elementId}"]`);
            if (!targetEl) return;

            const text = this.getCleanTextFromElement(targetEl);
            // 朗读引擎与 API Key 由后台按设置决定，缺少 Key 时通过返回的错误提示
            const settings = await chrome.storage.sync.get(['speed']);

            // 更新按钮为加载状态
            const icon = targetEl.querySelector('.readify-speak-icon');
            if (icon) {
                icon.setAttribute('data-state', 'loading');
                icon.innerHTML = '⏳ 加载';
            }

            this.activeIconId = elementId;
            chrome.runtime.sendMessage({
                action: 'startReading',
                text: text,
                mode: 'paragraph',
                targetParagraphId: elementId,
                pageTitle: document.title,
                speed: settings.speed || 1.0
            }).then((res) => {
                if (res && !res.success) {
                    this.setIconState(elementId, 'error');
                    this.showToast(`朗读失败: ${res.error}`, 'error', 3500);
                }
            }).catch(() => {});
        }

        // 处理后台广播的播放状态
        handlePlaybackStatusUpdate(status) {
            const prevState = this.currentStatus ? this.currentStatus.state : 'idle';
            const stateChanged = (status.state !== prevState);
            this.currentStatus = status;

            // 1. 同步悬浮播放器（仅在状态变迁时触发 Toast，避免 timeupdate 持续刷新）
            this.updateMiniPlayer(status, stateChanged);

            // 2. 高亮跟随与视图平滑滚动
            if (status.mode === 'snippet') {
                if (status.state === 'playing') {
                    this.highlightSelectionRange();
                } else if (status.state === 'ended' || status.state === 'stopped' || status.state === 'error') {
                    this.clearSelectionRangeHighlight();
                }
            } else {
                if (status.state === 'playing' || status.state === 'loading') {
                    const chunk = status.chunk || status.currentChunk;
                    const elementId = chunk?.elementId || status.meta?.elementId;

                    if (elementId) {
                        this.highlightElement(elementId);
                    }
                } else if (status.state === 'ended' || status.state === 'stopped' || status.state === 'error') {
                    this.clearHighlight();
                }
            }

            // 3. 更新段落图标状态（结束/停止广播不带 meta，因此记住上一个激活的图标）
            const iconId = status.meta?.elementId || (status.chunk || status.currentChunk)?.elementId || this.activeIconId;
            if (iconId) {
                if (this.activeIconId && this.activeIconId !== iconId) {
                    this.setIconState(this.activeIconId, 'stopped');
                }
                this.setIconState(iconId, status.state);
                this.activeIconId = ['ended', 'stopped', 'error', 'idle'].includes(status.state) ? null : iconId;
            }
        }

        setIconState(elementId, state) {
            const icon = document.querySelector(`[data-block-id="${elementId}"]`);
            if (!icon) return;
            icon.setAttribute('data-state', state);
            if (state === 'playing') icon.innerHTML = '▶️ 播放中';
            if (state === 'paused') icon.innerHTML = '⏸ 已暂停';
            if (state === 'ended') icon.innerHTML = '✓ 已读';
            if (state === 'stopped' || state === 'error') icon.innerHTML = '🔊 朗读';
        }

        // 为划词/选中的词句添加临时轻量高亮
        highlightSelectionRange() {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

            try {
                const range = selection.getRangeAt(0);
                if (!this.snippetSpan) {
                    const span = document.createElement('span');
                    span.className = 'readify-snippet-highlight';
                    range.surroundContents(span);
                    this.snippetSpan = span;
                }
            } catch (_) {
                // 如果选中区域跨越复杂的非对称标签，则静默忽略避免影响网页 DOM
            }
        }

        // 清除选词临时高亮
        clearSelectionRangeHighlight() {
            if (this.snippetSpan && this.snippetSpan.parentNode) {
                const parent = this.snippetSpan.parentNode;
                while (this.snippetSpan.firstChild) {
                    parent.insertBefore(this.snippetSpan.firstChild, this.snippetSpan);
                }
                this.snippetSpan.remove();
                this.snippetSpan = null;
                parent.normalize();
            }
        }

        // 元素高亮与平滑跟随
        highlightElement(elementId) {
            const target = document.querySelector(`[data-readify-id="${elementId}"]`);
            if (!target) return;

            if (this.activeHighlightElement === target) return; // timeupdate 每 250ms 广播一次，同一段不重复滚动

            if (this.activeHighlightElement) {
                this.activeHighlightElement.classList.remove('readify-active-reading');
            }

            target.classList.add('readify-active-reading');
            this.activeHighlightElement = target;

            // 平滑滚动到当前朗读视野中心
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }

        // 清除高亮
        clearHighlight() {
            if (this.activeHighlightElement) {
                this.activeHighlightElement.classList.remove('readify-active-reading');
                this.activeHighlightElement = null;
            }
        }

        // 初始化 Shadow DOM 浮动迷你播放器（样式完全隔离）
        initMiniPlayer() {
            // 扩展重载后旧脚本遗留的播放器已失效，移除后重建
            document.getElementById('readify-mini-player-root')?.remove();
            document.getElementById('readify-toast-element')?.remove();

            const container = document.createElement('div');
            container.id = 'readify-mini-player-root';
            document.body.appendChild(container);

            this.playerRoot = container;
            this.playerShadow = container.attachShadow({ mode: 'open' });

            this.playerShadow.innerHTML = `
                <style>
                    .player-card {
                        display: none;
                        width: 320px;
                        background: rgba(255, 255, 255, 0.95);
                        backdrop-filter: blur(12px);
                        border: 1px solid rgba(226, 232, 240, 0.8);
                        border-radius: 16px;
                        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15), 0 1px 3px rgba(0, 0, 0, 0.05);
                        padding: 14px 16px;
                        box-sizing: border-box;
                        color: #1e293b;
                        font-size: 13px;
                        animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                    }

                    @keyframes slideUp {
                        from { transform: translateY(20px); opacity: 0; }
                        to { transform: translateY(0); opacity: 1; }
                    }

                    .player-header {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        margin-bottom: 8px;
                        cursor: move;
                        user-select: none;
                        touch-action: none;
                    }

                    .progress-row {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        margin-bottom: 10px;
                    }

                    .track {
                        flex: 1;
                        height: 6px;
                        touch-action: none;
                        background: #e2e8f0;
                        border-radius: 9999px;
                        cursor: pointer;
                        position: relative;
                    }
                    .track.disabled { cursor: default; }
                    .track::before {
                        /* 扩大点击热区，不改变视觉高度 */
                        content: '';
                        position: absolute;
                        inset: -6px 0;
                    }

                    .fill {
                        height: 100%;
                        width: 0%;
                        background: #667eea;
                        border-radius: 9999px;
                        pointer-events: none;
                    }

                    .time-label {
                        font-size: 11px;
                        color: #64748b;
                        font-variant-numeric: tabular-nums;
                        min-width: 72px;
                        text-align: right;
                    }

                    .badge {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        padding: 2px 8px;
                        background: #ede9fe;
                        color: #6d28d9;
                        font-size: 11px;
                        font-weight: 600;
                        border-radius: 9999px;
                    }

                    .badge.summary {
                        background: #dbeafe;
                        color: #1d4ed8;
                    }

                    .close-btn {
                        background: none;
                        border: none;
                        color: #94a3b8;
                        cursor: pointer;
                        font-size: 16px;
                        line-height: 1;
                        padding: 4px;
                    }
                    .close-btn:hover { color: #475569; }

                    .content-preview {
                        color: #475569;
                        font-size: 12px;
                        line-height: 1.4;
                        max-height: 34px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        display: -webkit-box;
                        -webkit-line-clamp: 2;
                        -webkit-box-orient: vertical;
                        margin-bottom: 10px;
                    }

                    .progress-info {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 11px;
                        color: #64748b;
                        margin-bottom: 8px;
                    }

                    .controls-row {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 8px;
                    }

                    .btn-group {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }

                    .ctrl-btn {
                        background: #f1f5f9;
                        border: none;
                        border-radius: 8px;
                        color: #334155;
                        padding: 6px 10px;
                        font-size: 12px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.15s ease;
                    }
                    .ctrl-btn:hover { background: #e2e8f0; }

                    .ctrl-btn.primary {
                        background: #667eea;
                        color: white;
                        padding: 6px 14px;
                        font-weight: 600;
                    }
                    .ctrl-btn.primary:hover { background: #5a6fd8; }

                    .speed-btn {
                        background: #f8fafc;
                        border: 1px solid #cbd5e1;
                        border-radius: 6px;
                        padding: 4px 8px;
                        font-size: 11px;
                        font-weight: 600;
                        color: #475569;
                        cursor: pointer;
                    }
                    .speed-btn:hover { background: #f1f5f9; }
                </style>

                <div class="player-card" id="card">
                    <div class="player-header">
                        <span class="badge" id="modeBadge" title="拖动可移动播放器，双击恢复到右下角">🔊 正在朗读</span>
                        <button class="close-btn" id="closeBtn" title="停止并关闭">✕</button>
                    </div>
                    <div class="content-preview" id="snippetText">准备朗读...</div>
                    <div class="progress-row">
                        <div class="track disabled" id="progressTrack" title="点击或拖动跳转到当前片段的对应位置">
                            <div class="fill" id="progressFill"></div>
                        </div>
                        <span class="time-label" id="timeLabel">0:00 / 0:00</span>
                    </div>
                    <div class="progress-info">
                        <span id="chunkIndicator">分片 1/1</span>
                        <span id="cacheIndicator" style="display:none; color: #10b981;">⚡ 缓存命中</span>
                    </div>
                    <div class="controls-row">
                        <div class="btn-group">
                            <button class="ctrl-btn" id="prevBtn" title="上一段">⏮</button>
                            <button class="ctrl-btn primary" id="playPauseBtn">⏸ 暂停</button>
                            <button class="ctrl-btn" id="nextBtn" title="下一段">⏭</button>
                        </div>
                        <button class="speed-btn" id="speedToggleBtn">1.0x</button>
                    </div>
                </div>
            `;

            // 绑定按钮事件
            const shadow = this.playerShadow;
            shadow.getElementById('closeBtn').addEventListener('click', () => {
                chrome.runtime.sendMessage({ action: 'stopReading' });
            });

            shadow.getElementById('playPauseBtn').addEventListener('click', () => {
                if (this.currentStatus.state === 'playing') {
                    chrome.runtime.sendMessage({ action: 'pauseReading' });
                } else if (this.currentStatus.state === 'paused') {
                    chrome.runtime.sendMessage({ action: 'resumeReading' });
                }
            });

            shadow.getElementById('prevBtn').addEventListener('click', () => {
                chrome.runtime.sendMessage({ action: 'prevChunk' });
            });

            shadow.getElementById('nextBtn').addEventListener('click', () => {
                chrome.runtime.sendMessage({ action: 'nextChunk' });
            });

            shadow.getElementById('speedToggleBtn').addEventListener('click', () => {
                const speeds = [1.0, 1.25, 1.5, 2.0, 0.75];
                const current = this.currentStatus.speed || 1.0;
                const nextIdx = (speeds.indexOf(current) + 1) % speeds.length;
                const nextSpeed = speeds[nextIdx];
                chrome.runtime.sendMessage({ action: 'setSpeed', speed: nextSpeed });
            });

            // 进度条：点击或按住拖动跳转（仅限当前片段），拖动时本地预览，松手才发送跳转
            const track = shadow.getElementById('progressTrack');
            const seekable = () => {
                const { state } = this.currentStatus;
                return (state === 'playing' || state === 'paused') && Number.isFinite(this.progressDuration) && this.progressDuration > 0;
            };
            const ratioAt = (clientX) => {
                const rect = track.getBoundingClientRect();
                return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            };
            const preview = (ratio) => {
                shadow.getElementById('progressFill').style.width = `${(ratio * 100).toFixed(1)}%`;
                shadow.getElementById('timeLabel').textContent =
                    `${this.formatTime(ratio * this.progressDuration)} / ${this.formatTime(this.progressDuration)}`;
            };

            track.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || !seekable()) return;
                this.scrubbing = { id: e.pointerId, ratio: ratioAt(e.clientX) };
                track.setPointerCapture(e.pointerId);
                preview(this.scrubbing.ratio);
                e.preventDefault();
            });
            track.addEventListener('pointermove', (e) => {
                if (!this.scrubbing || e.pointerId !== this.scrubbing.id) return;
                this.scrubbing.ratio = ratioAt(e.clientX);
                preview(this.scrubbing.ratio);
            });
            const endScrub = (e, commit) => {
                if (!this.scrubbing || e.pointerId !== this.scrubbing.id) return;
                const { ratio } = this.scrubbing;
                this.scrubbing = null;
                if (commit && seekable()) {
                    const time = ratio * this.progressDuration;
                    this.progressTime = time;
                    chrome.runtime.sendMessage({ action: 'seekReading', time });
                } else {
                    this.updateProgress(this.currentStatus);
                }
            };
            track.addEventListener('pointerup', (e) => endScrub(e, true));
            track.addEventListener('pointercancel', (e) => endScrub(e, false));

            this.initDragging();
        }

        // 拖动播放器标题栏移动位置，位置保存在 chrome.storage.local，双击恢复右下角
        initDragging() {
            const header = this.playerShadow.querySelector('.player-header');
            const root = this.playerRoot;
            let drag = null;

            const apply = (pos) => {
                if (!pos) {
                    ['left', 'top', 'right', 'bottom'].forEach(k => root.style.removeProperty(k));
                    return;
                }
                root.style.setProperty('left', `${pos.left}px`);
                root.style.setProperty('top', `${pos.top}px`);
                root.style.setProperty('right', 'auto');
                root.style.setProperty('bottom', 'auto');
            };
            this.applyPlayerPosition = apply;

            header.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || e.target.closest('button')) return;
                const rect = root.getBoundingClientRect();
                drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, id: e.pointerId };
                header.setPointerCapture(e.pointerId);
                e.preventDefault();
            });

            header.addEventListener('pointermove', (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                this.playerPos = this.clampPlayerPos(e.clientX - drag.dx, e.clientY - drag.dy);
                apply(this.playerPos);
            });

            const endDrag = (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                drag = null;
                if (this.playerPos) {
                    chrome.storage.local.set({ miniPlayerPos: this.playerPos }).catch(() => {});
                }
            };
            header.addEventListener('pointerup', endDrag);
            header.addEventListener('pointercancel', endDrag);

            header.addEventListener('dblclick', (e) => {
                if (e.target.closest('button')) return;
                this.playerPos = null;
                apply(null);
                chrome.storage.local.remove('miniPlayerPos').catch(() => {});
            });

            // 窗口缩小时把播放器拉回可视区域
            window.addEventListener('resize', () => {
                if (this.playerPos && this.isPlayerVisible()) {
                    this.playerPos = this.clampPlayerPos(this.playerPos.left, this.playerPos.top);
                    apply(this.playerPos);
                }
            });

            chrome.storage.local.get('miniPlayerPos').then(({ miniPlayerPos }) => {
                if (miniPlayerPos && Number.isFinite(miniPlayerPos.left) && Number.isFinite(miniPlayerPos.top)) {
                    this.playerPos = miniPlayerPos;
                    apply(miniPlayerPos);
                }
            }).catch(() => {});
        }

        clampPlayerPos(left, top) {
            const rect = this.playerRoot.getBoundingClientRect();
            return {
                left: Math.min(Math.max(0, window.innerWidth - rect.width), Math.max(0, left)),
                top: Math.min(Math.max(0, window.innerHeight - rect.height), Math.max(0, top))
            };
        }

        isPlayerVisible() {
            const card = this.playerShadow?.getElementById('card');
            return !!card && card.style.display === 'block';
        }

        formatTime(sec) {
            if (!Number.isFinite(sec) || sec < 0) return '0:00';
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return `${m}:${String(s).padStart(2, '0')}`;
        }

        // 更新当前片段的播放进度（timeupdate 携带 currentTime/duration；切换片段或加载时归零）
        updateProgress(status) {
            const fill = this.playerShadow.getElementById('progressFill');
            const label = this.playerShadow.getElementById('timeLabel');
            const track = this.playerShadow.getElementById('progressTrack');

            if (status.chunkIndex !== this.progressChunkIndex || status.state === 'loading') {
                this.progressChunkIndex = status.chunkIndex;
                this.progressDuration = 0;
                this.progressTime = 0;
            }
            const staleMeta = status.meta && status.meta.chunkIndex !== undefined && status.meta.chunkIndex !== status.chunkIndex;
            if (this.scrubbing) return; // 拖动中保持用户的预览位置
            if (typeof status.currentTime === 'number' && !staleMeta) {
                this.progressTime = status.currentTime;
                this.progressDuration = status.duration;
            }

            const duration = this.progressDuration;
            const valid = Number.isFinite(duration) && duration > 0;
            const ratio = valid ? Math.min(1, this.progressTime / duration) : 0;
            fill.style.width = `${(ratio * 100).toFixed(1)}%`;
            label.textContent = `${this.formatTime(this.progressTime)} / ${valid ? this.formatTime(duration) : '0:00'}`;
            track.classList.toggle('disabled', !valid);
        }

        // 更新迷你播放器视图
        updateMiniPlayer(status, stateChanged = true) {
            if (!this.playerShadow) return;
            const card = this.playerShadow.getElementById('card');
            if (!card) return;

            // 词句发音模式或空闲/停止时，隐藏底部的多功能大卡片，保持页面完全干净
            if (status.state === 'idle' || status.state === 'stopped' || status.state === 'ended' || status.mode === 'snippet') {
                card.style.display = 'none';

                // 针对词句快捷发音模式：仅在状态发生变化时通知一次，严禁在 timeupdate 时反复触发！
                if (status.mode === 'snippet' && stateChanged) {
                    const chunk = status.chunk || status.currentChunk;
                    const preview = (chunk?.text || status.text || '').substring(0, 30);
                    if (status.state === 'loading') {
                        this.showToast(`🔊 正在获取发音: "${preview}"...`, 'info', 3000);
                    } else if (status.state === 'playing') {
                        const tag = status.fromCache ? '⚡ ' : '🔊 ';
                        this.showToast(`${tag}发音中: "${preview}"`, 'success', 2500);
                    } else if (status.state === 'ended') {
                        this.showToast(`✓ 发音完成: "${preview}"`, 'info', 1800);
                    } else if (status.state === 'error') {
                        this.showToast(`❌ 发音失败: ${status.error || '未知错误'}`, 'error', 3500);
                    }
                }
                return;
            }

            const wasHidden = card.style.display !== 'block';
            card.style.display = 'block';
            if (wasHidden && this.playerPos) {
                // 保存的位置可能来自更大的窗口，显示时重新约束到可视区域
                this.playerPos = this.clampPlayerPos(this.playerPos.left, this.playerPos.top);
                this.applyPlayerPosition(this.playerPos);
            }

            this.updateProgress(status);

            const badge = this.playerShadow.getElementById('modeBadge');
            if (status.mode === 'summary') {
                badge.className = 'badge summary';
                badge.textContent = '✨ AI 摘要速读 (GPT-5.6-Luna)';
            } else {
                badge.className = 'badge';
                badge.textContent = '🔊 正文朗读';
            }

            const playPauseBtn = this.playerShadow.getElementById('playPauseBtn');
            if (status.state === 'playing') {
                playPauseBtn.textContent = '⏸ 暂停';
                playPauseBtn.style.background = '#667eea';
            } else if (status.state === 'paused') {
                playPauseBtn.textContent = '▶️ 继续';
                playPauseBtn.style.background = '#10b981';
            } else if (status.state === 'loading') {
                playPauseBtn.textContent = '⏳ 加载中';
                playPauseBtn.style.background = '#f59e0b';
            } else if (status.state === 'error') {
                playPauseBtn.textContent = '❌ 出错';
                playPauseBtn.style.background = '#ef4444';
            }

            const snippet = this.playerShadow.getElementById('snippetText');
            const chunk = status.chunk || status.currentChunk;
            if (status.state === 'error' && status.error) {
                snippet.textContent = `朗读失败: ${status.error}`;
            } else if (status.message) {
                snippet.textContent = status.message;
            } else if (chunk && chunk.text) {
                snippet.textContent = chunk.text;
            }

            const indicator = this.playerShadow.getElementById('chunkIndicator');
            const currentIdx = (status.chunkIndex !== undefined && status.chunkIndex >= 0) ? status.chunkIndex + 1 : 1;
            const total = status.totalChunks || 1;
            indicator.textContent = `片段 ${currentIdx} / ${total}`;

            const cacheTag = this.playerShadow.getElementById('cacheIndicator');
            if (status.fromCache) {
                cacheTag.style.display = 'inline';
            } else {
                cacheTag.style.display = 'none';
            }

            const speedBtn = this.playerShadow.getElementById('speedToggleBtn');
            speedBtn.textContent = `${status.speed || 0.85}x`;
        }

        // 优雅消息 Toast (单例复用，防止重复堆叠与重影刷新)
        showToast(message, type = 'info', duration = 2500) {
            if (!this.toastEl) {
                this.toastEl = document.createElement('div');
                this.toastEl.id = 'readify-toast-element';
                this.toastEl.style.cssText = `
                    position: fixed !important;
                    top: 24px !important;
                    right: 24px !important;
                    z-index: 2147483647 !important;
                    padding: 10px 18px !important;
                    border-radius: 20px !important;
                    font-size: 13px !important;
                    font-weight: 500 !important;
                    color: white !important;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22) !important;
                    transition: opacity 0.25s ease, transform 0.25s ease !important;
                    max-width: 360px !important;
                    line-height: 1.4 !important;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                    pointer-events: none !important;
                    transform: translateY(-8px) !important;
                    opacity: 0 !important;
                `;
                document.body.appendChild(this.toastEl);
            }

            const bg = (type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#6366f1'));
            this.toastEl.style.backgroundColor = bg;
            this.toastEl.textContent = message;

            clearTimeout(this.toastTimer);

            requestAnimationFrame(() => {
                if (this.toastEl) {
                    this.toastEl.style.transform = 'translateY(0)';
                    this.toastEl.style.opacity = '1';
                }
            });

            this.toastTimer = setTimeout(() => {
                if (this.toastEl) {
                    this.toastEl.style.opacity = '0';
                    this.toastEl.style.transform = 'translateY(-8px)';
                }
            }, duration);
        }
    }

    // 页面加载完成后实例化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new ReadifyContent());
    } else {
        new ReadifyContent();
    }
})();
