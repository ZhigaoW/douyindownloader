# 抖音视频下载器

用 Go 标准库实现的本地视频下载工具。粘贴抖音分享链接即可解析和下载；网页内嵌在可执行文件中，运行时无需 Node.js、Go 或其他依赖。

## 快速开始

**macOS：** 在 Finder 中双击 `start.command`。**Windows：** 双击 `start.bat`。

启动后浏览器自动打开 [本地下载器](http://127.0.0.1:3210)。粘贴链接或完整分享文案，点击“解析并下载”。通过项目启动脚本运行时，视频保存在项目根目录的 `downloads/`，关闭服务可在终端按 `Control + C`。

项目启动脚本使用 `bin/` 中与当前系统、架构匹配的可执行文件；不存在时，需要先安装 [Go 1.22 或更高版本](https://go.dev/dl/)，脚本会自动编译。修改源码或网页后，请重新构建。

## 开发

macOS / Linux，在项目根目录执行：

```sh
make build   # 编译到 bin/
make run     # 编译并运行，下载到项目 downloads/
make check   # 竞态测试和静态检查
make release # 生成 Apple Silicon、Intel Mac 和 Windows x64 可执行文件
```

没有 Make 时，也可以直接使用 Go 命令，见[开发指南](docs/development.md)。

## 项目结构

```text
.
├── cmd/douyin-downloader/    # 程序入口
├── internal/app/            # Go 后端及相邻测试
│   ├── app.go               # 配置、启动服务、打开浏览器
│   ├── server.go            # HTTP 接口和下载任务编排
│   ├── download.go          # 抖音解析、测速、续传和文件命名
│   └── app_test.go          # 模拟视频与接口测试
├── web/
│   ├── assets.go            # 静态资源嵌入声明
│   └── static/              # HTML、CSS、原生 JavaScript
├── scripts/release.sh       # 跨平台编译脚本
├── docs/                    # 使用、开发、架构文档
├── bin/                     # 本机编译产物（不入库）
├── dist/                    # 发布产物（构建后生成，不入库）
├── downloads/               # 下载视频和 .part 临时文件（不入库）
├── local/                   # 本地资料（不入库、不随程序分发）
├── start.command            # Mac 双击启动入口
├── start.bat                # Windows 双击启动入口
├── Makefile                 # 常用开发命令
└── go.mod                   # Go 模块定义，无第三方依赖
```

## 文档

- [使用与排错](docs/usage.md)：运行、保存位置、配置和常见问题。
- [开发与发布](docs/development.md)：构建、测试、跨平台发布和修改位置。
- [架构与接口](docs/architecture.md)：代码职责、数据流和 HTTP 接口。

## 支持范围

支持普通公开视频、分享短链接和完整分享文案。提供三线路测速、备用线路切换、断点续传、下载进度及最近下载列表；一次处理一个下载任务。

暂不支持图文、私密/好友可见内容、已删除作品和直播。抖音验证、网络限制或页面结构变化可能影响解析。程序仅监听 `127.0.0.1`，直接访问抖音，不读取浏览器 Cookie。请仅下载你有权保存的内容。
