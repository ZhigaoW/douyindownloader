package app

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// Run starts the local HTTP service using environment configuration.
func Run() error {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3210"
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("PORT 必须为 1–65535 的整数")
	}
	dir := os.Getenv("DOWNLOAD_DIR")
	if dir == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		dir = filepath.Join(filepath.Dir(exe), "downloads")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return fmt.Errorf("启动失败（端口可能已被占用）：%w", err)
	}
	address := "http://" + listener.Addr().String()
	fmt.Printf("抖音视频下载器已启动：%s\n视频目录：%s\n请保持窗口开启，按 Control + C 停止服务。\n", address, dir)
	if os.Getenv("NO_OPEN") != "1" {
		go func() {
			command, args := "open", []string{address}
			if runtime.GOOS == "windows" {
				command, args = "rundll32", []string{"url.dll,FileProtocolHandler", address}
			} else if runtime.GOOS != "darwin" {
				command = "xdg-open"
			}
			if err := exec.Command(command, args...).Run(); err != nil {
				log.Printf("请手动在浏览器中打开 %s", address)
			}
		}()
	}
	server := &http.Server{Handler: (&app{dir: dir}).handler(), ReadHeaderTimeout: 10 * time.Second}
	return server.Serve(listener)
}
