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
                const max = Number.isFinite(audio.duration) ? audio.duration : Number(request.time);
                audio.currentTime = Math.min(Math.max(0, Number(request.time)), max);
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
    setTimeout(() => {
        isStopping = false;
    }, 100);
}

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
