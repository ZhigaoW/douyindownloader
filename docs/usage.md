# 使用与排错

## 运行发布版

选择与系统及架构匹配的可执行文件。Apple Silicon Mac 使用 `darwin-arm64`，Intel Mac 使用 `darwin-amd64`，Windows x64 使用 `windows-amd64`。

Mac 在终端运行 `./douyin-downloader`；Windows 双击 `douyin-downloader.exe`。程序应放在有写入权限的文件夹。网页已经内嵌，无需复制网页目录，也无需安装 Go 或 Node.js。

浏览器会自动打开 `http://127.0.0.1:3210`。粘贴分享文案或视频链接，点击“解析并下载”。直接运行可执行文件时，视频默认保存在**可执行文件旁边的 `downloads` 文件夹**。

## 从项目目录运行

- Mac：双击根目录 `start.command`。
- Windows：双击根目录 `start.bat`。
- 启动脚本使用 `bin/` 中的程序；缺失时用 Go 1.22+ 编译。
- 脚本默认将下载目录设为**项目根目录的 `downloads/`**，已有 `DOWNLOAD_DIR` 配置则优先使用。
- 修改代码或网页后要重新编译，启动脚本不会自动检查源码是否更新。

保持终端窗口开启；按 `Control + C` 停止服务。关闭网页不会停止服务。Mac 剪贴板权限未获允许时，可使用 `Command + V` 粘贴。

“保存到电脑”会通过浏览器再保存一份；原始视频已经在程序的下载目录中。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3210` | 本地端口，范围 1–65535 |
| `DOWNLOAD_DIR` | 可执行文件旁的 `downloads/` | 启动脚本和 `make run/dev` 默认指定项目的 `downloads/` |
| `NO_OPEN` | 未设置 | 设为 `1` 时不自动打开浏览器 |

Mac/Linux，直接运行发布版：

```sh
PORT=3211 DOWNLOAD_DIR="$HOME/Movies/抖音下载" NO_OPEN=1 ./douyin-downloader
```

Windows PowerShell，在项目根目录：

```powershell
$env:PORT = '3211'
$env:DOWNLOAD_DIR = "$HOME\Videos\抖音下载"
.\bin\douyin-downloader.exe
```

相对下载路径以当前工作目录为基准；建议使用绝对路径。

## 常见问题

**端口被占用**：关闭之前运行的下载器，或设置其他 `PORT`。程序不会终止占用端口的其他进程。

**Mac 启动文件没有执行权限**：在项目目录执行 `chmod +x start.command`，或运行 `bash start.command`。

**找不到 Go**：使用与系统匹配的预编译程序，或者安装 Go 1.22+ 后再编译。Mac 启动脚本会检查常见的官方安装路径及 Homebrew 路径。

**下载中断**：`.part` 文件会保留；再次下载相同视频会尝试续传。若服务端不支持 Range，则自动从头下载。不要在下载过程中移动临时文件。

**解析失败、要求验证**：先在浏览器打开原分享链接，确认作品公开且可播放。浏览器验证结果不会自动传给本工具，因为它不读取浏览器 Cookie。若平台接口或页面变化，需要更新解析代码。

**不支持的作品**：暂不支持图文、直播、私密/好友可见或已删除作品。
