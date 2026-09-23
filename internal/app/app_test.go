package app

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadResume(t *testing.T) {
	data := "test video payload"
	for _, mode := range []string{"resume", "restart", "wrong-range", "truncated", "complete"} {
		t.Run(mode, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Range") != "bytes=5-" {
					t.Errorf("missing resume range: %s", r.Header.Get("Range"))
				}
				switch mode {
				case "resume":
					w.Header().Set("Content-Range", fmt.Sprintf("bytes 5-%d/%d", len(data)-1, len(data)))
					w.WriteHeader(206)
					io.WriteString(w, data[5:])
				case "restart":
					io.WriteString(w, data)
				case "wrong-range":
					w.Header().Set("Content-Range", "bytes 0-17/18")
					w.WriteHeader(206)
					io.WriteString(w, data)
				case "truncated":
					w.Header().Set("Content-Length", "100")
					io.WriteString(w, data)
				case "complete":
					w.Header().Set("Content-Range", "bytes */5")
					w.WriteHeader(416)
				}
			}))
			defer server.Close()
			path := filepath.Join(t.TempDir(), "video.part")
			if err := os.WriteFile(path, []byte(data[:5]), 0644); err != nil {
				t.Fatal(err)
			}
			err := download(context.Background(), route{URL: server.URL}, path, func(event) {})
			if mode == "wrong-range" || mode == "truncated" {
				if err == nil {
					t.Fatal("expected failure")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(path)
			expected := data
			if mode == "complete" {
				expected = data[:5]
			}
			if string(got) != expected {
				t.Fatalf("got %q", got)
			}
		})
	}
}

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestFullDownloadAndRoutes(t *testing.T) {
	old := client
	defer func() { client = old }()
	client = &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		body := "video bytes"
		if r.URL.Hostname() == "www.iesdouyin.com" {
			body = `<script>window._ROUTER_DATA = {"loaderData":{"video_test":{"videoInfoRes":{"item_list":[{"desc":"测试视频","author":{"nickname":"作者"},"video":{"play_addr":{"url_list":["https://media.example/playwm/test"]}}}]}}}}</script>`
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), ContentLength: int64(len(body)), Request: r}, nil
	})}
	a := &app{dir: t.TempDir()}
	handler := a.handler()
	req := httptest.NewRequest("POST", "/api/download", strings.NewReader(`{"text":"分享 https://www.douyin.com/video/123456/"}`))
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, req)
	if !strings.Contains(result.Body.String(), `"type":"complete"`) {
		t.Fatal(result.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(a.dir, "测试视频 [123456].mp4"))
	if err != nil || string(data) != "video bytes" {
		t.Fatalf("download: %q, %v", data, err)
	}
	for _, path := range []string{"/", "/app.js", "/styles.css", "/api/health", "/api/downloads", "/downloads/测试视频%20%5B123456%5D.mp4?download=1"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 {
			t.Errorf("%s: %d", path, response.Code)
		}
	}
	for _, body := range []string{`null`, `{"text":12}`, `{"text":"https://example.com"}`, strings.Repeat("x", 65537)} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/download", strings.NewReader(body)))
		if response.Code != 400 {
			t.Errorf("invalid request status: %d", response.Code)
		}
	}
	for _, path := range []string{"/downloads/secret.part", "/downloads/a%2Fb.mp4"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 404 {
			t.Errorf("unsafe path status: %d", response.Code)
		}
	}
}

func TestFilename(t *testing.T) {
	a := &app{dir: t.TempDir()}
	path := a.videoPath(video{ID: "1234567890123456789", Title: strings.Repeat("🎬", 100)})
	if len(filepath.Base(path)) > 255 {
		t.Fatalf("filename too long: %d bytes", len(filepath.Base(path)))
	}
	if err := os.WriteFile(path, []byte("test"), 0644); err != nil {
		t.Fatal(err)
	}
	if a.videoPath(video{ID: "1234567890123456789", Title: strings.Repeat("🎬", 100)}) == path {
		t.Fatal("overwrites existing video")
	}
}
