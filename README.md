# Readify 2.0 - 网页智能朗读与 AI 速读助手

Readify 是基于 Chrome Manifest V3（MV3）构建的现代化网页伴读扩展，结合 **OpenAI 官方 TTS** 语音合成与 **GPT-5.6-Luna** 智能分析能力，提供高保真口语播音、长文连续朗读、AI 摘要速读、自然句段高亮跟随与无感离屏播放体验。

---

## 🌟 核心特性与架构升级

### 1. 现代化音频架构（Offscreen Document）
- **免疫网页 CSP 阻断**：采用 Chrome 官方标准的 `offscreen` 离屏文档托管音频播放器，彻底解决在 GitHub、Twitter/X 等严格配置 `media-src` 网站上音频被拦截的问题。
- **跨 Tab / 页面跳转无损播放**：切换标签页或浏览其他页面时，音频不中断，背景服务统一掌控播放进度。
- **完整播放器控制**：支持实时【播放 / 暂停 / 继续】、【上一段 / 下一段】、【动态变速（0.5x ~ 2.5x）】。

### 2. 持久化音频缓存（IndexedDB）
- **真·持久缓存**：摒弃 MV3 Service Worker 易休眠丢失的内存 Map，改用浏览器底层 `IndexedDB` 存储音频 ArrayBuffer。
- **语速解耦**：语速由播放器前端实时动态变速，缓存键仅与 `hash(文本) + 音色 + 模型` 绑定，避免调节语速导致缓存失效与重复计费。
- **缓存健康管理**：Popup 面板实时展示已缓存音频项数与占用空间（KB/MB），支持一键清空与 7 天过期清理。

### 3. AI 智能赋能（遵循核心模型选型规范）
- **✨ AI 核心速读 (GPT-5.6-Luna)**：针对万字长文或新闻深度报道，一键调用 `gpt-5.6-luna` 快速提炼 200~400 字口语化播报摘要并即刻朗读，1 分钟掌握文章精华。
- **智能语义分块与预缓冲 (Semantic Chunking & Pre-buffering)**：
  - 自动根据句号、问号、感叹号与段落自然边界，将长文切分为自然发音分块，彻底突破单次 4096 字符的 API 限制。
  - **流式无缝预缓冲**：在播放第 N 段音频的同时，后台静默预先请求并缓存第 N+1 段音频，实现零卡顿的自然过渡连播。

### 4. 极致前端伴读体验
- **词句快速划词朗读（右键菜单）**：在页面中选中任意单词、生词或短语，鼠标右键点击 **“🔊 朗读选中的词句 / 发音”**，即可立即精准发音，选中文本同步呈现优雅荧光下划线，不弹扰民大卡片，干净轻巧。
- **Shadow DOM 迷你悬浮播放器**：朗读全文或长文时，页面右下角自动唤起精致小巧的控制条，样式完全与宿主页面隔离，避免样式污染。
- **句段高亮与平滑跟随**：长文朗读到哪一段，文本自动叠加淡紫色荧光背景，并自动平滑滚动至屏幕视野中心。
- **ElevenLabs 朗读引擎**：在「模型与音色」里把朗读引擎切换为 ElevenLabs，粘贴 ElevenLabs API Key 保存后自动加载账号下的音色，模型列表从账号实时拉取，并显示套餐剩余额度；点「检测可用」会用 1 个字符试读确认哪些模型可用（✓/✗）。朗读时如果模型或音色对当前账号不可用（如免费账号），会自动回退到可用模型（优先 `eleven_flash_v2_5`）或官方默认音色，并保存为新设置。AI 摘要仍使用 OpenAI Key。

---

## 🚀 安装与使用指南

### 1. 安装步骤
1. 打开 Chrome 浏览器，访问 `chrome://extensions/`。
2. 开启右上角 **“开发者模式”** 开关。
3. 点击 **“加载已解压的扩展程序”**，选择本项目根目录。

### 2. 配置与开始使用
1. 点击浏览器扩展栏的 **Readify** 图标打开面板。
2. 输入你的 **OpenAI API Key**（保存于本地 Chrome 存储）。
3. 选择首选配置：
   - **TTS 合成模型**：`tts-1`（标准极速 · 推荐）或 `tts-1-hd`（高清细腻）。
   - **AI 摘要模型**：`gpt-5.6-luna`（高效轻量）。
   - **播音音色**：Nova、Alloy、Echo、Fable、Onyx、Shimmer。
   - **语速调节**：0.5x ~ 2.5x。
4. 在任意网页点击 **“朗读整页正文”** 或 **“✨ AI 摘要速读”** 即可开始。

---

## 📁 项目目录结构

- [manifest.json](manifest.json)：Manifest V3 配置文件（声明 offscreen 与 contextMenus 权限）
- [background.js](background.js)：后台 Service Worker，负责 TTS API、GPT-5.6-Luna 调度、队列预缓冲与消息广播
- [offscreen.html](offscreen.html) / [offscreen.js](offscreen.js)：离屏音频播放器内核，不受 CSP 限制
- [audio-cache.js](audio-cache.js)：基于 IndexedDB 的持久化音频缓存模块
- [content.js](content.js) / [content.css](content.css)：页面正文提纯、高亮跟随、段落按钮与 Shadow DOM 悬浮播放器
- [popup.html](popup.html) / [popup.css](popup.css) / [popup.js](popup.js)：精美弹出控制面板与缓存管理器
- [tests/](tests/)：归档的开发与架构测试页面

---

## 📄 开源许可

本项目遵循 MIT 协议。