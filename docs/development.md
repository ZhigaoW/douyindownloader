# 开发与发布

## 环境

需要 Go 1.22 或更高版本。项目只使用标准库，没有 `go.sum`、npm 安装步骤或前端构建工具。Make 和 Bash 是 macOS/Linux 下的快捷工具，不是程序运行依赖。

以下命令均在项目根目录执行。

## 日常命令

```sh
make build   # 原生平台可执行文件 → bin/
make run     # 先编译再运行，使用项目 downloads/
make dev     # go run，同样使用项目 downloads/
make fmt     # 格式化 Go 文件
make test    # 模拟下载与接口测试，启用竞态检查
make vet     # Go 静态检查
make check   # test + vet
```

无 Make 的 Mac/Linux：

```sh
go build -trimpath -ldflags="-s -w" -o bin/douyin-downloader ./cmd/douyin-downloader
DOWNLOAD_DIR="$PWD/downloads" ./bin/douyin-downloader
```

Windows PowerShell：

```powershell
go build -trimpath -ldflags="-s -w" -o bin/douyin-downloader.exe ./cmd/douyin-downloader
$env:DOWNLOAD_DIR = Join-Path $PWD 'downloads'
.\bin\douyin-downloader.exe
go test ./...
go vet ./...
```

`go test -race ./...` 需要当前系统可用的竞态检测工具链；Mac 通常使用 Xcode Command Line Tools，Windows 需要对应的 C 工具链。普通测试不要求启用竞态检测。

直接用 `go run ./cmd/douyin-downloader` 时应显式设置 `DOWNLOAD_DIR`，否则默认位置会落在 Go 临时可执行文件旁。

## 修改位置

| 需求 | 文件 |
| --- | --- |
| 端口、下载目录、启动和浏览器打开行为 | `internal/app/app.go` |
| 接口、进度事件、任务互斥 | `internal/app/server.go` |
| 抖音页面解析、线路测速、断点续传 | `internal/app/download.go` |
| 页面结构 / 样式 / 交互 | `web/static/index.html` / `styles.css` / `app.js` |
| 可执行文件入口 | `cmd/douyin-downloader/main.go` |

网页使用 `go:embed`，修改后必须重新构建并重启。测试与实现位于同一 Go 包，不建立单独的顶层 `tests/`。

测试覆盖模拟视频完整下载、Range 续传、服务器忽略 Range、错误范围、不完整响应、文件命名、静态页面和接口。测试不访问真实抖音；解析能否适应当前线上页面仍需有效公开视频链接验证。测试中会替换包级 HTTP 客户端，因此这些测试不应加 `t.Parallel()`。

## 发布

```sh
make release
# 或 bash scripts/release.sh
```

输出如下，每个目录包含一个独立程序和使用说明：

```text
dist/
├── darwin-arm64/
├── darwin-amd64/
└── windows-amd64/
```

脚本使用 `CGO_ENABLED=0`，不引入系统动态库依赖。发布目录可以单独打包分发，不包含下载记录和本地资料。当前流程没有进行 macOS 签名、公证或 Windows 签名。

只编译一个平台，例如 Windows x64：

```sh
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o dist/windows-amd64/douyin-downloader.exe ./cmd/douyin-downloader
```

`bin/` 和 `dist/` 是可重新生成的产物；`downloads/` 含用户数据，清理构建产物时不要删除它。`local/0001.jpg` 是整理前保留的本地图片，不参与编译或发布。

## 本次目录迁移

- 原根目录 `main.go` 拆为程序入口及 `internal/app/` 下的三个职责文件。
- 原 `main_test.go` 移至 `internal/app/app_test.go`。
- 原 `public/` 移至 `web/static/`，通过 `web/assets.go` 嵌入。
- 原可执行文件移至 `bin/`；双击启动脚本同步更新。
- 清理了旧版留下的空 `src/`、`tests/`、`tools/` 目录。
- 根目录 `downloads/` 保持原位；直接运行 `bin/` 中程序时如需沿用该目录，请显式设置 `DOWNLOAD_DIR` 或使用启动脚本。
