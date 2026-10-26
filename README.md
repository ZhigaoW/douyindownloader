# 抖音 / 哔哩哔哩视频下载器

本地运行的视频下载工具，支持 Windows / macOS / Linux。粘贴分享链接即可解析、选择清晰度并保存到本机，无需安装 npm 依赖、Python 或 FFmpeg。

![界面预览](docs/ui-preview.png)

## 功能

- 哔哩哔哩：BV / av、`b23.tv` 短链、分 P、清晰度选择。
- 抖音：`v.douyin.com` 短链、完整分享文案。
- 自动识别平台，解析封面、标题、作者和时长。
- 测速选线、失败切换、断点续传、随时取消。
- 本地运行，仅监听 `127.0.0.1`。

## 启动

| 系统 | 方式 |
| --- | --- |
| Windows | 双击 `start.bat` |
| macOS | 双击 `start-macos.command` |
| Linux | `./start-linux.sh` 或 `bash start-linux.sh` |

支持 64 位 Windows（x64 / ARM64）、macOS（Intel / Apple Silicon）和 Linux（x64 / ARM64）。

启动器优先使用系统 Node.js 22.18+；没有或版本过低时，首次启动会自动下载便携版 Node.js 24.18.0（约 40–60 MB，需联网，失败自动切换国内镜像），之后可离线使用。启动后浏览器会打开 <http://127.0.0.1:3210>。

macOS 若无法打开 `.command`：右键选择“打开”，或执行 `chmod +x start-macos.command`。  
Linux 若无执行权限：执行 `chmod +x start-linux.sh`。

## 使用

1. 粘贴链接或分享文案，点击“解析视频”。
2. 选择清晰度 / 分 P，点击“开始下载”。
3. 完成后点击“保存到电脑”，或到 `downloads` 文件夹查看。

视频保存为 `[平台] 标题 [ID].mp4`；同名文件自动追加序号，中断后保留 `.part` 并支持续传。下载历史只显示视频文件。

## 支持范围

- B 站：普通投稿和分 P，未登录最高 720P；不支持番剧、影视、课程、直播、充电专属和付费内容。
- 抖音：公开视频和分享短链；不支持图文、私密作品和直播。抖音偶发风控，若提示“没有找到视频信息”，请先在浏览器确认视频可播放再重试。
- 界面参考 [Siemens Industrial Experience](https://ix.siemens.io/docs/home/overview) 的浅色主题。

## 开发

```bash
npm start
```

需要 Node.js 22.18+。也可通过 `PORT=3211 npm start` 或 Windows 的 `$env:PORT=3211; npm.cmd start` 修改端口。

## 目录

```text
src/       本地服务、解析与下载
public/    前端页面、样式与交互
scripts/   跨平台启动引导
docs/      界面截图
downloads/ 下载输出（不提交）
```

## 说明

程序不读取浏览器 Cookie，也不会上传链接或视频。请仅下载你有权保存的内容，并遵守平台规则和版权。
