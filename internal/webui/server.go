package webui

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"qqchannel-downloader/internal/qq"
)

//go:embed static/index.html static/style.css static/app.js
var staticFS embed.FS

// Config controls the local WebUI server.
type Config struct {
	DefaultOut string
	Jobs       int
	Listen     string
	Version    string
	NoBrowser  bool
	DataDir    string
}

type server struct {
	cfg     Config
	manager *Manager
}

// Run starts the WebUI and blocks until the context is cancelled.
func Run(ctx context.Context, cfg Config) error {
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:0"
	}
	if cfg.Jobs <= 0 {
		cfg.Jobs = 4
	}
	if strings.TrimSpace(cfg.DataDir) == "" {
		cfg.DataDir = "data"
	}
	if absData, err := filepath.Abs(cfg.DataDir); err == nil {
		cfg.DataDir = absData
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return fmt.Errorf("创建数据目录失败：%w", err)
	}
	abs, err := filepath.Abs(cfg.DefaultOut)
	if err == nil {
		cfg.DefaultOut = abs
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("无法监听 %s：%w", cfg.Listen, err)
	}
	defer ln.Close()

	host, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		host, port = "127.0.0.1", "0"
	}
	browserHost := host
	if host == "0.0.0.0" || host == "::" || host == "" {
		browserHost = "127.0.0.1"
	}
	url := "http://" + net.JoinHostPort(browserHost, port)

	s := &server{cfg: cfg, manager: NewManager(ctx, cfg.DefaultOut, cfg.DataDir)}
	httpServer := &http.Server{
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	fmt.Println("QQ频道 原文件下载器 · WebUI")
	fmt.Println("地址:", url)
	fmt.Println("保存目录:", cfg.DefaultOut)
	fmt.Println("按 Ctrl+C 停止服务")
	if !cfg.NoBrowser {
		if err := openBrowser(url); err != nil {
			fmt.Println("未能自动打开浏览器，请手动访问上面的地址。")
		}
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.Serve(ln) }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
		return nil
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	static := http.StripPrefix("/static/", http.FileServer(http.FS(sub)))
	staticHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		static.ServeHTTP(w, r)
	})

	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.Handle("GET /static/", staticHandler)
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/config", s.handleConfig)
	mux.HandleFunc("POST /api/parse", s.handleParse)
	mux.HandleFunc("POST /api/download", s.handleDownload)
	mux.HandleFunc("GET /api/jobs", s.handleJobs)
	mux.HandleFunc("GET /api/jobs/{id}", s.handleJob)
	mux.HandleFunc("POST /api/jobs/{id}/cancel", s.handleCancel)
	mux.HandleFunc("POST /api/open-dir", s.handleOpenDir)

	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	b, err := staticFS.ReadFile("static/index.html")
	if err != nil {
		http.Error(w, "index missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

func (s *server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"defaultOut":          s.cfg.DefaultOut,
		"jobs":                s.cfg.Jobs,
		"version":             s.cfg.Version,
		"platform":            runtime.GOOS,
		"defaultNameTemplate": qq.DefaultNameTemplate,
		"nameTokens":          qq.NameTokens,
	})
}

func (s *server) handleParse(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL          string   `json:"url"`
		URLs         []string `json:"urls"`
		NameTemplate string   `json:"nameTemplate"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	urls, err := normalizePostURLs(DownloadRequest{URL: req.URL, URLs: req.URLs})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	nameTemplate := strings.TrimSpace(req.NameTemplate)
	if nameTemplate == "" {
		nameTemplate = qq.DefaultNameTemplate
	}
	if err := qq.ValidateNameTemplate(nameTemplate); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second)
	defer cancel()
	feeds := make([]FeedView, 0, len(urls))
	total := 0
	globalIndex := 1
	for i, raw := range urls {
		view := FeedView{Index: i + 1, URL: raw, Medias: make([]MediaView, 0)}
		client := qq.NewClient()
		html, _, err := client.FetchPage(ctx, raw)
		if err != nil {
			view.Error = "解析页面失败：" + err.Error()
			feeds = append(feeds, view)
			continue
		}
		feed, err := qq.ParsePostHTML(html)
		if err != nil {
			view.Error = "解析帖子失败：" + err.Error()
			feeds = append(feeds, view)
			continue
		}
		medias := feed.Medias()
		if len(medias) == 0 {
			view.Error = "帖子中没有可下载的图片、GIF 或视频"
			feeds = append(feeds, view)
			continue
		}
		built := buildFeedView(feed, medias, nameTemplate)
		built.Index = i + 1
		built.URL = raw
		for j := range built.Medias {
			built.Medias[j].Index = globalIndex
			globalIndex++
		}
		feeds = append(feeds, *built)
		total += len(medias)
	}
	if total == 0 {
		writeJSON(w, http.StatusOK, map[string]interface{}{"feeds": feeds, "total": 0})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"feeds": feeds, "total": total})
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	var req DownloadRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if _, err := normalizePostURLs(req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	job, err := s.manager.Start(req, s.cfg.Jobs)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]interface{}{"id": job.id})
}

func (s *server) handleJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"jobs": s.manager.List()})
}

func (s *server) handleJob(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	job, ok := s.manager.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "任务不存在")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *server) handleCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.manager.Cancel(id) {
		writeError(w, http.StatusConflict, "任务不存在或已经结束")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (s *server) handleOpenDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeError(w, http.StatusBadRequest, "路径为空")
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		writeError(w, http.StatusBadRequest, "路径无效")
		return
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		writeError(w, http.StatusBadRequest, "目录不存在")
		return
	}
	if err := openDirectory(abs); err != nil {
		writeError(w, http.StatusInternalServerError, "无法打开目录："+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func buildFeedView(feed *qq.Feed, medias []*qq.Media, nameTemplate string) *FeedView {
	v := &FeedView{
		ID:         feed.ID,
		GuildID:    feed.GuildID,
		ChannelID:  feed.ChannelID,
		PosterID:   feed.PosterID,
		PosterName: feed.PosterName,
		Title:      feed.Title,
		ImageCount: len(feed.Images),
		VideoCount: len(feed.Videos),
		Medias:     make([]MediaView, 0, len(medias)),
	}
	for _, m := range medias {
		v.Medias = append(v.Medias, MediaView{
			Seq: m.Seq, Kind: m.Kind, Width: m.Width, Height: m.Height,
			Size: m.ExpectedSize, Name: qq.BuildName(m, nameTemplate, m.Ext), Ext: m.Ext, IsGIF: m.IsGIF,
			ChannelID: m.ChannelID, GuildID: m.GuildID, SubChannelID: m.SubChannelID,
			PostID: m.PostID, PosterID: m.PosterID, PosterName: m.PosterName, Title: m.Title, Order: m.Seq,
		})
	}
	return v
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst interface{}) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

func openDirectory(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	return cmd.Start()
}
