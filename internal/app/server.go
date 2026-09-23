package app

import (
	"douyin-downloader/web"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type event = map[string]any
type app struct {
	dir  string
	busy sync.Mutex
}

func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (a *app) handleDownload(w http.ResponseWriter, req *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 64<<10)).Decode(&body); err != nil {
		jsonResponse(w, 400, event{"error": "请求格式不正确或内容过长"})
		return
	}
	target := extract(body.Text)
	if target == "" {
		jsonResponse(w, 400, event{"error": "没有找到有效的抖音链接，请粘贴完整分享文案或链接。"})
		return
	}
	if !a.busy.TryLock() {
		jsonResponse(w, 409, event{"error": "已有下载正在进行，请完成后重试。"})
		return
	}
	defer a.busy.Unlock()
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	send := func(e event) { _ = json.NewEncoder(w).Encode(e); _ = http.NewResponseController(w).Flush() }
	fail := func(err error) { send(event{"type": "error", "message": err.Error()}) }
	send(event{"type": "start", "url": target})
	send(event{"type": "log", "message": "正在读取公开视频信息…"})
	v, err := resolveVideo(req.Context(), target)
	if err != nil {
		fail(err)
		return
	}
	send(event{"type": "metadata", "title": v.Title, "author": v.Author})
	send(event{"type": "route_test", "message": "正在测速 3 条下载线路…"})
	routes := rank(req.Context(), v.URLs)
	if len(routes) == 0 {
		fail(errors.New("所有下载线路均无法连接"))
		return
	}
	send(event{"type": "route_selected", "line": routes[0].Line, "speed": fmt.Sprintf("%.1f MB/s", routes[0].Speed/(1<<20)), "total": routes[0].Total})
	path := a.videoPath(v)
	for i, r := range routes {
		if req.Context().Err() != nil {
			return
		}
		if i > 0 {
			send(event{"type": "log", "message": fmt.Sprintf("正在切换备用线路 %d…", r.Line)})
		}
		err = download(req.Context(), r, path+".part", send)
		if err == nil {
			break
		}
	}
	if err == nil {
		err = os.Rename(path+".part", path)
	}
	if err != nil {
		fail(err)
		return
	}
	name := filepath.Base(path)
	send(event{"type": "complete", "filename": name, "url": "/downloads/" + url.PathEscape(name)})
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, event{"ready": true, "version": "2.0.0"})
	})
	mux.HandleFunc("POST /api/download", a.handleDownload)
	mux.HandleFunc("GET /api/downloads", func(w http.ResponseWriter, r *http.Request) {
		entries, err := os.ReadDir(a.dir)
		if err != nil {
			jsonResponse(w, 500, event{"error": err.Error()})
			return
		}
		files := []event{}
		for _, entry := range entries {
			if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".mp4") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			files = append(files, event{"name": entry.Name(), "url": "/downloads/" + url.PathEscape(entry.Name()), "size": info.Size(), "updatedAt": info.ModTime().UTC().Format(time.RFC3339Nano)})
		}
		sort.Slice(files, func(i, j int) bool { return files[i]["updatedAt"].(string) > files[j]["updatedAt"].(string) })
		jsonResponse(w, 200, event{"files": files})
	})
	mux.HandleFunc("GET /downloads/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if strings.ContainsAny(name, `/\`) || !strings.HasSuffix(name, ".mp4") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(a.dir, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("download") == "1" {
			w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
		}
		http.ServeFile(w, r, path)
	})
	public, _ := fs.Sub(web.Files, "static")
	mux.Handle("GET /", http.FileServer(http.FS(public)))
	return mux
}
