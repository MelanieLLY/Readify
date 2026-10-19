// offscreen.js - 离屏音频播放器，不受任何网页 CSP 限制，支持跨 Tab 稳定播放
const audio = document.getElementById('audioPlayer');
let currentBlobUrl = null;
let currentChunkMeta = null;

// 初始化消息监听
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.target !== 'offscreen') return false;

    switch (request.action) {
        case 'playAudio':
            handlePlay(request).then(sendResponse);
            return true;

        case 'pauseAudio':
            audio.pause();
            sendResponse({ success: true, isPaused: true });
            return true;

        case 'resumeAudio':
            audio.play()
                .then(() => sendResponse({ success: true, isPlaying: true }))
                .catch((err) => sendResponse({ success: false, error: err.message }));
            return true;

        case 'stopAudio':
            handleStop();
            sendResponse({ success: true });
            return true;

        case 'setSpeed':
            if (request.speed && !isNaN(request.speed)) {
                audio.playbackRate = Number(request.speed);
                sendResponse({ success: true, speed: audio.playbackRate });
            } else {
                sendResponse({ success: false, error: '无效语速' });
            }
            return true;

        case 'seekAudio':
            if (request.time !== undefined && !isNaN(request.time) && audio.src) {
                seekTo(Number(request.time));
                sendResponse({ success: true, currentTime: audio.currentTime });
            } else {
                sendResponse({ success: false, error: '无效跳转位置' });
            }
            return true;

        case 'getPlaybackStatus':
            sendResponse({
                isPlaying: !audio.paused && !audio.ended && audio.currentTime > 0,
                isPaused: audio.paused,
                currentTime: audio.currentTime,
                duration: audio.duration || 0,
                playbackRate: audio.playbackRate,
                currentChunkMeta
            });
            return true;

        default:
            sendResponse({ success: false, error: '未知操作' });
            return false;
    }
});

// 处理播放请求
async function handlePlay(request) {
    try {
        const { audioData, speed = 1.0, meta = {} } = request;

        // 清理上一个 Blob URL 避免内存泄露
        if (currentBlobUrl) {
            URL.revokeObjectURL(currentBlobUrl);
            currentBlobUrl = null;
        }

        let audioSource = '';
        if (audioData.startsWith('data:') || audioData.startsWith('blob:')) {
            audioSource = audioData;
        } else {
            // 将 base64 转为 Blob URL 播放，性能优于直接用 data 协议
            const blob = base64ToBlob(audioData, 'audio/mp3');
            currentBlobUrl = URL.createObjectURL(blob);
            audioSource = currentBlobUrl;
        }

        currentChunkMeta = meta;
        updateMediaMetadata(meta);
        audio.src = audioSource;
        const targetRate = Number(speed) || 0.85;
        audio.defaultPlaybackRate = targetRate;
        audio.playbackRate = targetRate;

        // 监听 play 与 playing 事件强制锁死语速，防止浏览器载入媒体流时重置
        const lockSpeed = () => {
            audio.playbackRate = targetRate;
        };
        audio.addEventListener('play', lockSpeed, { once: true });
        audio.addEventListener('playing', lockSpeed, { once: true });

        await audio.play();
        audio.playbackRate = targetRate;
        return { success: true };
    } catch (err) {
        console.error('[Offscreen] 播放音频失败:', err);
        return { success: false, error: err.message };
    }
}

let isStopping = false;

// 停止播放
function handleStop() {
    isStopping = true;
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute('src');
    audio.load(); // 规范重置媒体元素状态为 HAVE_NOTHING，不触发异常
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }
    currentChunkMeta = null;
    clearMediaSession();
    setTimeout(() => {
        isStopping = false;
    }, 100);
}

function seekTo(time) {
    if (!audio.src) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : time;
    audio.currentTime = Math.min(Math.max(0, time), max);
}

// ===== Chrome 全局媒体控制面板（工具栏 ♫）：通过 Media Session 显示朗读内容并接管按钮 =====
const mediaSession = 'mediaSession' in navigator ? navigator.mediaSession : null;

// 播放/暂停/切段统一交给后台处理，保证与网页迷你播放器、popup 的状态一致
function sendControl(action) {
    chrome.runtime.sendMessage({ action }).catch(() => {});
}

function setHandler(action, handler) {
    try {
        mediaSession.setActionHandler(action, handler);
    } catch (_) {
        // 旧版 Chrome 不支持部分动作时忽略
    }
}

if (mediaSession) {
    setHandler('play', () => sendControl('resumeReading'));
    setHandler('pause', () => sendControl('pauseReading'));
    setHandler('stop', () => sendControl('stopReading'));
    setHandler('seekto', (details) => {
        if (Number.isFinite(details.seekTime)) seekTo(details.seekTime);
    });
    setHandler('seekbackward', (details) => seekTo(audio.currentTime - (details.seekOffset || 10)));
    setHandler('seekforward', (details) => seekTo(audio.currentTime + (details.seekOffset || 10)));
}

function updateMediaMetadata(meta) {
    if (!mediaSession) return;
    const total = meta.totalChunks || 1;
    const index = (meta.chunkIndex || 0) + 1;
    mediaSession.metadata = new MediaMetadata({
        title: meta.title || 'Readify 朗读',
        artist: total > 1 ? `Readify · 片段 ${index}/${total}` : 'Readify',
        album: meta.pageTitle || '',
        artwork: [
            { src: chrome.runtime.getURL('icons/icon128.png'), sizes: '128x128', type: 'image/png' },
            { src: chrome.runtime.getURL('icons/icon48.png'), sizes: '48x48', type: 'image/png' }
        ]
    });
    // 只在有上一段/下一段时显示 ⏮ ⏭ 按钮
    setHandler('previoustrack', index > 1 ? () => sendControl('prevChunk') : null);
    setHandler('nexttrack', index < total ? () => sendControl('nextChunk') : null);
}

function updatePositionState() {
    if (!mediaSession || !mediaSession.setPositionState) return;
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
        mediaSession.setPositionState({
            duration,
            playbackRate: audio.playbackRate || 1,
            position: Math.min(Math.max(0, audio.currentTime), duration)
        });
    } catch (_) {}
}

function clearMediaSession() {
    if (!mediaSession) return;
    mediaSession.metadata = null;
    mediaSession.playbackState = 'none';
    setHandler('previoustrack', null);
    setHandler('nexttrack', null);
    try {
        mediaSession.setPositionState();
    } catch (_) {}
}

audio.addEventListener('loadedmetadata', updatePositionState);
audio.addEventListener('ratechange', updatePositionState);
audio.addEventListener('playing', () => {
    if (mediaSession) mediaSession.playbackState = 'playing';
    updatePositionState();
});

// 辅助方法：Base64 转 Blob
function base64ToBlob(base64, mimeType = 'audio/mp3') {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

// 事件监听与通知 Background
audio.addEventListener('play', () => {
    chrome.runtime.sendMessage({
        action: 'offscreenEvent',
        event: 'play',
        meta: currentChunkMeta
    }).catch(() => {});
});

audio.addEventListener('pause', () => {
    if (mediaSession && !isStopping) mediaSession.playbackState = 'paused';
    // 如果是自然结束或正在切换，不发送普通暂停事件
    if (!audio.ended && !isStopping) {
        chrome.runtime.sendMessage({
            action: 'offscreenEvent',
            event: 'pause',
            meta: currentChunkMeta
        }).catch(() => {});
    }
});

audio.addEventListener('ended', () => {
    if (!isStopping) {
        chrome.runtime.sendMessage({
            action: 'offscreenEvent',
            event: 'ended',
            meta: currentChunkMeta
        }).catch(() => {});
    }
});

audio.addEventListener('error', (e) => {
    // 过滤主动清空、停止或重置导致的虚假 Empty src 报错
    if (isStopping || !audio.src || audio.src === '' || audio.src === window.location.href || !currentChunkMeta) {
        return;
    }
    const errorMsg = audio.error ? (audio.error.message || `MediaError Code: ${audio.error.code}`) : '未知音频错误';
    chrome.runtime.sendMessage({
        action: 'offscreenEvent',
        event: 'error',
        error: errorMsg,
        meta: currentChunkMeta
    }).catch(() => {});
});

// 暂停状态下跳转不会触发 timeupdate 节流后的广播，seeked 时立即同步一次进度
audio.addEventListener('seeked', () => {
    updatePositionState();
    chrome.runtime.sendMessage({
        action: 'offscreenEvent',
        event: 'timeupdate',
        currentTime: audio.currentTime,
        duration: audio.duration || 0,
        meta: currentChunkMeta
    }).catch(() => {});
});

let lastProgressTime = 0;
audio.addEventListener('timeupdate', () => {
    const now = Date.now();
    // 节流，每 250ms 发送一次进度更新
    if (now - lastProgressTime > 250) {
        lastProgressTime = now;
        chrome.runtime.sendMessage({
            action: 'offscreenEvent',
            event: 'timeupdate',
            currentTime: audio.currentTime,
            duration: audio.duration || 0,
            meta: currentChunkMeta
        }).catch(() => {});
    }
});
