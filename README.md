# GetV for Safari

GetV 是一个面向 macOS / iOS Safari 的 Web Extension。它会从媒体元素、链接、Performance Resource Timing、`fetch`、XHR 和 MediaSource 中发现视频资源。

## 安装

通过 Homebrew 安装 macOS 版本：

```sh
brew tap chensiyue98/tap
brew install --cask get-v
```

## 已实现

- 直接识别 MP4、M4V、WEBM、FLV、MP3、M4A、AAC、MOV 与 HLS/m3u8。页面中途切换或创建播放器时会通过媒体生命周期事件立即重扫；没有文件扩展名的播放地址会在后台用 MIME 和最多 64 KB 文件头验证。
- 解析 HLS master playlist，按分辨率和码率默认选择最高画质，也允许手动选择其他清晰度。
- 识别 `EXT-X-MEDIA` 独立音频轨，默认选择标记为 `DEFAULT` 的语言，也允许在弹窗里手动切换音轨。
- 视频与音频 HLS 分片并发下载（2–12 路）、AES-128 解密、暂停/继续、重命名与导出部分结果。任务可以单独删除或一键清空；这些操作不会删除已经保存到磁盘的文件。
- 下载任务和分片都保存在扩展的 IndexedDB 中，不占用 `browser.storage.local` 的小容量配置配额；页面关闭或进程重启后可以继续，合并时才创建磁盘文件。
- fMP4 HLS 会按 init segment + media segments 合并为 MP4；传统 MPEG-TS（H.264/AAC）通过本地打包的 mux.js 转封装。独立音视频轨由 MP4Box.js 重建双轨初始化段，并把对应的音视频片段封装在同一个 movie fragment 中，以兼容 Safari 和 QuickTime。
- 录制模式在页面上下文中钩住 `SourceBuffer.appendBuffer`，可暂停并保存已捕获部分。
- 弹窗设置支持下载线程数、自动保存、保存后清理缓存，以及按网页标题或资源文件名命名；配置保存在小体积的 `browser.storage.local` 中。

## 平台边界

- Safari 的 WebExtension API 不允许读取扩展注入之前已经存在于 MediaSource 内部的字节，只能从钩子安装后捕获新追加的数据。建议刷新页面后立即开始捕获。
- FairPlay/EME DRM 数据不能被扩展解密或导出。
- MPEG-TS 转封装当前覆盖常见的 H.264/AAC 组合；HEVC、AC-3 等不受 mux.js 支持的 TS 编码会报出明确错误。未分离音轨的普通 TS 下载仍可回退保存为 `.ts`，不会生成伪 MP4。
- 录制模式对单一、复用的 fMP4 SourceBuffer 最可靠；分离音视频轨的 DASH 播放器需要额外的 MP4 muxer。
- 只应用于你有权保存的非 DRM 媒体，并遵守网站条款和当地法律。

## 开发

1. 用 Xcode 打开 `get-v.xcodeproj`，选择 `get-v (macOS)` scheme 运行。
2. 在 Safari → 设置 → 扩展中启用 GetV，并允许访问需要下载的网站。
3. 播放页面视频，然后点击工具栏图标。

运行 JavaScript 检查与单元测试：

```sh
npm run check
npm test
```

第三方组件及许可证位于 `Shared (Extension)/Resources/vendor/`：mux.js（Apache-2.0）和 MP4Box.js（BSD-3-Clause）。

GitHub Actions 发布与签名配置见 [`docs/RELEASING.md`](docs/RELEASING.md)。
