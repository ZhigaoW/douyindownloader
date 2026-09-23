# 架构与接口

## 设计

项目是一台本地 HTTP 服务加原生网页。后端保留一个内部业务包 `internal/app`，仅按文件拆分职责，避免为小项目增加不必要的接口层和框架。

```text
cmd/douyin-downloader → internal/app → web（嵌入资源）
                            │
浏览器 ← HTTP / NDJSON → 本地服务 → 抖音分享页与视频线路
                            │
                     downloads/*.part → *.mp4
```

- `app.go`：读取环境变量、建立监听、打开浏览器。`Run()` 返回错误，由程序入口记录并退出。
- `server.go`：HTTP 路由、参数校验、下载互斥、进度事件和文件访问。
- `download.go`：提取链接、解析视频信息、线路测速、传输、续传和命名。
- `web/assets.go`：编译时嵌入 `web/static/`，运行时无需外部网页文件。

## 下载流程

1. 从分享文案提取抖音链接，将视频地址转换为分享页。
2. 解析页面的 `window._ROUTER_DATA`，取得标题、作者和媒体地址。
3. 并行测试三个 `line` 参数的线路，每条读取最多 512 KiB，限时 8 秒，按速度排序。
4. 按最快线路下载；25 秒无数据则取消该线路，尝试下一条。
5. 已存在 `.part` 时携带 Range，校验返回范围；服务端返回完整响应时从头写入。
6. 下载完成后把 `.part` 重命名为 `.mp4`，通过 NDJSON 通知网页刷新记录。

请求断开会取消相关网络操作，已写入的临时文件保留。任务使用进程内互斥锁，同一个服务一次只处理一个下载请求。多个独立进程不应共用同一个下载目录。

## HTTP 接口

地址默认为 `http://127.0.0.1:3210`。

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/health` | `{ "ready": true, "version": "2.0.0" }` |
| GET | `/api/downloads` | `{ "files": [...] }`，按修改时间倒序 |
| POST | `/api/download` | NDJSON 下载事件流 |
| GET | `/downloads/{name}` | 视频内容；`?download=1` 触发附件保存 |
| GET | `/`、`/app.js`、`/styles.css` | 嵌入的网页资源 |

下载请求：

```json
{"text":"https://www.douyin.com/video/123456/"}
```

请求体限制为 64 KiB。格式错误或无有效链接返回 HTTP 400；已有任务返回 HTTP 409。进入下载流程后返回 HTTP 200，后续业务失败由流中的 `error` 事件表示。

每一行是独立 JSON 对象，事件类型包括：

| type | 主要字段 | 用途 |
| --- | --- | --- |
| `start` | `url` | 已识别链接 |
| `log` | `message` | 解析、切换线路等提示 |
| `metadata` | `title`, `author` | 视频信息 |
| `route_test` | `message` | 测速开始 |
| `route_selected` | `line`, `speed`, `total` | 选择最快线路 |
| `progress` | `percent`, `speed`, `eta`, `received`, `total` | 下载进度 |
| `complete` | `filename`, `url` | 下载完成 |
| `error` | `message` | 下载失败 |

`received`、`total` 为字节数；`percent`、`speed`、`eta` 为展示字符串。总大小未知时 `total` 为 0，`percent` 和 `eta` 为空。线路编号为 0、1、2。

下载记录包含 `name`、URL 编码后的 `url`、字节数 `size` 及 RFC 3339 格式的 `updatedAt`。列表只展示普通 `.mp4` 文件，忽略 `.part`。下载接口拒绝目录穿越及符号链接。

## 边界

服务仅绑定回环地址，无账号系统、数据库或后台队列。页面解析依赖抖音返回的公开数据结构；自动化测试使用固定模拟响应，不证明线上所有视频均可下载。若要增加图文或其他平台支持，先在解析与传输逻辑处扩展，再补充对应测试。
