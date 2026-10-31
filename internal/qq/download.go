package qq

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Result struct {
	Media   *Media
	Path    string
	Size    int64
	MD5     string
	Warning string
	Skipped bool
	Err     error
}

type Downloader struct {
	Client       *Client
	OutDir       string
	Jobs         int
	Force        bool
	NameTemplate string
	OnEvent      func(Result)
}

type mediaHTTP struct {
	c *http.Client
}

func newMediaHTTP() *mediaHTTP {
	return &mediaHTTP{c: &http.Client{
		Timeout: 0,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           dualStackDialContext,
			MaxIdleConns:          64,
			MaxIdleConnsPerHost:   16,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   20 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		},
	}}
}

// DownloadAll downloads every media item concurrently.
func (d *Downloader) DownloadAll(ctx context.Context, medias []*Media) []Result {
	if d.Jobs <= 0 {
		d.Jobs = 4
	}
	if err := os.MkdirAll(d.OutDir, 0o755); err != nil {
		res := make([]Result, len(medias))
		for i, m := range medias {
			res[i] = Result{Media: m, Err: err}
		}
		return res
	}
	results := make([]Result, len(medias))
	sem := make(chan struct{}, d.Jobs)
	var wg sync.WaitGroup
	mh := newMediaHTTP()
	for i, m := range medias {
		wg.Add(1)
		go func(i int, m *Media) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				results[i] = Result{Media: m, Err: ctx.Err()}
				return
			}
			r := d.downloadOne(ctx, mh, m)
			results[i] = r
			if d.OnEvent != nil {
				d.OnEvent(r)
			}
		}(i, m)
	}
	wg.Wait()
	return results
}

func (d *Downloader) downloadOne(ctx context.Context, mh *mediaHTTP, m *Media) Result {
	base := BuildBaseName(m, d.NameTemplate)
	// A completed file from a previous run is kept.
	if !d.Force {
		if p, size, ok := findExisting(d.OutDir, base, m); ok {
			return Result{Media: m, Path: p, Size: size, Skipped: true}
		}
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(attempt) * 2 * time.Second):
			case <-ctx.Done():
				return Result{Media: m, Err: ctx.Err()}
			}
		}
		r := d.fetchToFile(ctx, mh, m)
		if r.Err == nil {
			return r
		}
		lastErr = r.Err
	}
	return Result{Media: m, Err: lastErr}
}

func (d *Downloader) fetchToFile(ctx context.Context, mh *mediaHTTP, m *Media) Result {
	base := BuildBaseName(m, d.NameTemplate)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL, nil)
	if err != nil {
		return Result{Media: m, Err: err}
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Referer", "https://pd.qq.com/")
	req.Header.Set("Accept", "*/*")
	resp, err := mh.c.Do(req)
	if err != nil {
		return Result{Media: m, Err: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Result{Media: m, Err: fmt.Errorf("HTTP %d", resp.StatusCode)}
	}
	base = filepath.FromSlash(base)
	tmpDir := filepath.Join(d.OutDir, filepath.Dir(base))
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return Result{Media: m, Err: err}
	}
	tmp := filepath.Join(tmpDir, "."+filepath.Base(base)+".part")
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return Result{Media: m, Err: err}
	}
	h := md5.New()
	n, copyErr := io.Copy(io.MultiWriter(out, h), resp.Body)
	closeErr := out.Close()
	if copyErr != nil {
		os.Remove(tmp)
		return Result{Media: m, Err: copyErr}
	}
	if closeErr != nil {
		os.Remove(tmp)
		return Result{Media: m, Err: closeErr}
	}
	if resp.ContentLength > 0 && n != resp.ContentLength {
		os.Remove(tmp)
		return Result{Media: m, Err: fmt.Errorf("truncated download: got %d of %d bytes", n, resp.ContentLength)}
	}
	warning := ""
	if m.ExpectedSize > 0 && n != m.ExpectedSize {
		warning = fmt.Sprintf("页面元数据大小 %d 字节，实际文件 %d 字节", m.ExpectedSize, n)
	}
	if m.Kind == "image" && m.Width > 0 && m.Height > 0 {
		if w, h, ok := imageDimensions(tmp); ok && (w < m.Width || h < m.Height) {
			os.Remove(tmp)
			return Result{Media: m, Err: fmt.Errorf("图片尺寸 %dx%d 小于页面标称 %dx%d，可能不是原图", w, h, m.Width, m.Height)}
		}
	}
	sum := hex.EncodeToString(h.Sum(nil))
	ext := m.Ext
	if ext == "" {
		ext = detectExt(tmp)
	}
	finalRel := filepath.FromSlash(BuildName(m, d.NameTemplate, ext))
	final := filepath.Join(d.OutDir, finalRel)
	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		os.Remove(tmp)
		return Result{Media: m, Err: err}
	}
	if d.Force {
		_ = os.Remove(final)
	}
	if err := os.Rename(tmp, final); err != nil {
		// Windows cannot overwrite; try removing first.
		_ = os.Remove(final)
		if err2 := os.Rename(tmp, final); err2 != nil {
			os.Remove(tmp)
			return Result{Media: m, Err: err2}
		}
	}
	return Result{Media: m, Path: final, Size: n, MD5: sum, Warning: warning}
}

func findExisting(dir, base string, m *Media) (string, int64, bool) {
	base = filepath.FromSlash(base)
	matches, _ := filepath.Glob(filepath.Join(dir, base) + ".*")
	for _, p := range matches {
		if strings.HasSuffix(p, ".part") {
			continue
		}
		st, err := os.Stat(p)
		if err != nil || st.IsDir() || st.Size() == 0 {
			continue
		}
		if m.ExpectedSize > 0 && st.Size() == m.ExpectedSize {
			return p, st.Size(), true
		}
		// 部分帖子的 orig_size 是过期/错误元数据。图片只要实际尺寸不小于
		// 页面标称尺寸，就可以视为已经完整下载。
		if m.Kind == "image" && m.Width > 0 && m.Height > 0 {
			if w, h, ok := imageDimensions(p); ok && w >= m.Width && h >= m.Height {
				return p, st.Size(), true
			}
		}
	}
	return "", 0, false
}

func imageDimensions(path string) (int, int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

func detectExt(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return "bin"
	}
	defer f.Close()
	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	buf = buf[:n]
	switch {
	case len(buf) >= 3 && buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF:
		return "jpg"
	case len(buf) >= 8 && string(buf[:8]) == "\x89PNG\r\n\x1a\n":
		return "png"
	case len(buf) >= 6 && (string(buf[:6]) == "GIF87a" || string(buf[:6]) == "GIF89a"):
		return "gif"
	case len(buf) >= 12 && string(buf[:4]) == "RIFF" && string(buf[8:12]) == "WEBP":
		return "webp"
	case len(buf) >= 12 && string(buf[4:8]) == "ftyp":
		return "mp4"
	case len(buf) >= 4 && string(buf[:4]) == "\x1a\x45\xdf\xa3":
		return "webm"
	default:
		return "bin"
	}
}
