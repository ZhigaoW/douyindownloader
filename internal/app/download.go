package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"

var client = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 15 * time.Second}).DialContext, TLSHandshakeTimeout: 15 * time.Second, ResponseHeaderTimeout: 25 * time.Second}}
var linkRE = regexp.MustCompile(`https?://[^\s<>"'，。！]+`)
var idRE = regexp.MustCompile(`/(?:video|note)/(\d+)`)
var dataRE = regexp.MustCompile(`(?s)window\._ROUTER_DATA\s*=\s*({.*?})\s*</script>`)
var badName = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

type video struct {
	ID, Title, Author string
	URLs              []string
}
type route struct {
	URL   string
	Line  int
	Speed float64
	Total int64
}

func get(ctx context.Context, target, byteRange string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", ua)
	req.Header.Set("Referer", "https://www.douyin.com/")
	if byteRange != "" {
		req.Header.Set("Range", byteRange)
	}
	return client.Do(req)
}

func extract(text string) string {
	for _, raw := range linkRE.FindAllString(text, -1) {
		raw = strings.TrimRight(raw, ")]}>）")
		u, err := url.Parse(raw)
		if err == nil && (u.Hostname() == "douyin.com" || strings.HasSuffix(u.Hostname(), ".douyin.com")) {
			return raw
		}
	}
	return ""
}

func resolveVideo(ctx context.Context, target string) (video, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	id := idRE.FindStringSubmatch(target)
	if len(id) == 0 {
		resp, err := get(ctx, target, "")
		if err != nil {
			return video{}, err
		}
		resp.Body.Close()
		id = idRE.FindStringSubmatch(resp.Request.URL.Path)
	}
	if len(id) == 0 {
		return video{}, errors.New("短链接没有返回有效的视频地址")
	}
	resp, err := get(ctx, "https://www.iesdouyin.com/share/video/"+id[1]+"/", "")
	if err != nil {
		return video{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return video{}, fmt.Errorf("分享页面访问失败（HTTP %d）", resp.StatusCode)
	}
	html, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return video{}, err
	}
	match := dataRE.FindSubmatch(html)
	if len(match) == 0 {
		return video{}, errors.New("抖音没有返回视频信息，请先在浏览器打开分享链接并完成验证")
	}
	var data struct {
		LoaderData map[string]struct {
			VideoInfoRes struct {
				Items []struct {
					ID     string `json:"aweme_id"`
					Desc   string `json:"desc"`
					Author struct {
						Nickname string `json:"nickname"`
					} `json:"author"`
					Video struct {
						PlayAddr struct {
							URLs []string `json:"url_list"`
						} `json:"play_addr"`
					} `json:"video"`
				} `json:"item_list"`
			} `json:"videoInfoRes"`
		} `json:"loaderData"`
	}
	if err := json.Unmarshal(match[1], &data); err != nil {
		return video{}, fmt.Errorf("视频信息格式异常：%w", err)
	}
	for key, page := range data.LoaderData {
		if !strings.Contains(key, "video_") || len(page.VideoInfoRes.Items) == 0 {
			continue
		}
		item := page.VideoInfoRes.Items[0]
		if len(item.Video.PlayAddr.URLs) == 0 {
			continue
		}
		v := video{ID: id[1], Title: item.Desc, Author: item.Author.Nickname}
		if v.Title == "" {
			v.Title = "抖音视频"
		}
		u, err := url.Parse(strings.Replace(item.Video.PlayAddr.URLs[0], "/playwm/", "/play/", 1))
		if err != nil {
			return video{}, err
		}
		for line := 0; line < 3; line++ {
			q := u.Query()
			q.Set("line", strconv.Itoa(line))
			u.RawQuery = q.Encode()
			v.URLs = append(v.URLs, u.String())
		}
		return v, nil
	}
	return video{}, errors.New("未找到普通公开视频，暂不支持图文、私密或已删除作品")
}

func totalSize(resp *http.Response) int64 {
	if _, total, ok := strings.Cut(resp.Header.Get("Content-Range"), "/"); ok {
		if n, err := strconv.ParseInt(total, 10, 64); err == nil {
			return n
		}
	}
	if resp.ContentLength > 0 {
		return resp.ContentLength
	}
	return 0
}

func rank(ctx context.Context, urls []string) []route {
	results := make(chan route, len(urls))
	var wg sync.WaitGroup
	for line, target := range urls {
		wg.Add(1)
		go func(line int, target string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
			defer cancel()
			started := time.Now()
			resp, err := get(ctx, target, "bytes=0-524287")
			if err != nil {
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != 200 && resp.StatusCode != 206 {
				return
			}
			n, _ := io.Copy(io.Discard, io.LimitReader(resp.Body, 512<<10))
			if n > 0 {
				results <- route{resp.Request.URL.String(), line, float64(n) / time.Since(started).Seconds(), totalSize(resp)}
			}
		}(line, target)
	}
	wg.Wait()
	close(results)
	routes := []route{}
	for r := range results {
		routes = append(routes, r)
	}
	sort.Slice(routes, func(i, j int) bool { return routes[i].Speed > routes[j].Speed })
	return routes
}

func download(ctx context.Context, r route, path string, send func(event)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	timer := time.AfterFunc(25*time.Second, cancel)
	defer timer.Stop()
	var offset int64
	if info, err := os.Stat(path); err == nil {
		offset = info.Size()
	}
	byteRange := ""
	if offset > 0 {
		byteRange = fmt.Sprintf("bytes=%d-", offset)
	}
	resp, err := get(ctx, r.URL, byteRange)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// A complete partial file can remain after interruption just before renaming.
	if resp.StatusCode == 416 && offset > 0 && totalSize(resp) == offset {
		return nil
	}
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		return fmt.Errorf("下载线路返回 HTTP %d", resp.StatusCode)
	}
	flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	if resp.StatusCode == 206 {
		var start, end, total int64
		if _, err := fmt.Sscanf(resp.Header.Get("Content-Range"), "bytes %d-%d/%d", &start, &end, &total); err != nil || start != offset || end < start || total <= end {
			return errors.New("下载线路返回了不正确的续传范围")
		}
		flags = os.O_CREATE | os.O_WRONLY | os.O_APPEND
	} else {
		offset = 0
	}
	file, err := os.OpenFile(path, flags, 0644)
	if err != nil {
		return err
	}
	defer file.Close()
	total, received := totalSize(resp), offset
	started, last := time.Now(), time.Time{}
	buffer := make([]byte, 64<<10)
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			timer.Reset(25 * time.Second)
			if _, err := file.Write(buffer[:n]); err != nil {
				return err
			}
			received += int64(n)
			if time.Since(last) > 350*time.Millisecond || received == total {
				speed := float64(received-offset) / time.Since(started).Seconds()
				percent, eta := "", ""
				if total > 0 {
					percent = fmt.Sprintf("%.1f", float64(received)*100/float64(total))
					eta = fmt.Sprintf("%.0f 秒", float64(total-received)/speed)
				}
				send(event{"type": "progress", "percent": percent, "speed": fmt.Sprintf("%.1f MB/s", speed/(1<<20)), "eta": eta, "received": received, "total": total})
				last = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if total > 0 && received != total {
		return errors.New("视频数据不完整，已保留临时文件供下次续传")
	}
	if received == 0 {
		return errors.New("下载线路返回了空视频")
	}
	return file.Close()
}

func (a *app) videoPath(v video) string {
	title := []rune(strings.Join(strings.Fields(badName.ReplaceAllString(v.Title, "")), " "))
	for len(title) > 60 || len(string(title)) > 180 {
		title = title[:len(title)-1]
	}
	name := strings.TrimRight(string(title), ". ")
	if name == "" {
		name = "抖音视频"
	}
	base := fmt.Sprintf("%s [%s]", name, v.ID)
	path := filepath.Join(a.dir, base+".mp4")
	for i := 2; ; i++ {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return path
		}
		path = filepath.Join(a.dir, fmt.Sprintf("%s (%d).mp4", base, i))
	}
}
