package webui

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"qqchannel-downloader/internal/qq"
)

// DownloadRequest is the payload sent by the WebUI.
type DownloadRequest struct {
	URL          string   `json:"url,omitempty"`
	URLs         []string `json:"urls,omitempty"`
	OutDir       string   `json:"outDir"`
	Jobs         int      `json:"jobs"`
	Force        bool     `json:"force"`
	NameTemplate string   `json:"nameTemplate"`
}

type MediaView struct {
	Index        int    `json:"index"` // global 1-based index across the batch
	Seq          int    `json:"seq"`   // order inside its own post
	Kind         string `json:"kind"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	Size         int64  `json:"size"`
	Name         string `json:"name"` // complete/preview name, already rendered with the current template
	Ext          string `json:"ext"`
	IsGIF        bool   `json:"isGif"`
	ChannelID    string `json:"channelId"`
	GuildID      string `json:"guildId"`
	SubChannelID string `json:"subChannelId"`
	PostID       string `json:"postId"`
	PosterID     string `json:"posterId"`
	PosterName   string `json:"posterName"`
	Title        string `json:"title"`
	Order        int    `json:"order"`
}

type FeedView struct {
	Index      int         `json:"index"`
	URL        string      `json:"url"`
	ID         string      `json:"id"`
	GuildID    string      `json:"guildId"`
	ChannelID  string      `json:"channelId"`
	PosterID   string      `json:"posterId"`
	PosterName string      `json:"posterName"`
	Title      string      `json:"title"`
	ImageCount int         `json:"imageCount"`
	VideoCount int         `json:"videoCount"`
	Medias     []MediaView `json:"medias"`
	Error      string      `json:"error,omitempty"`
}

type FileView struct {
	Index  int    `json:"index"`
	Seq    int    `json:"seq"`
	FeedID string `json:"feedId,omitempty"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type JobView struct {
	ID           string     `json:"id"`
	Status       string     `json:"status"`
	URL          string     `json:"url,omitempty"`
	URLs         []string   `json:"urls,omitempty"`
	OutDir       string     `json:"outDir"`
	NameTemplate string     `json:"nameTemplate"`
	Total        int        `json:"total"`
	Done         int        `json:"done"`
	Success      int        `json:"success"`
	Skipped      int        `json:"skipped"`
	Failed       int        `json:"failed"`
	Error        string     `json:"error,omitempty"`
	Feeds        []FeedView `json:"feeds,omitempty"`
	Logs         []string   `json:"logs"`
	Results      []FileView `json:"results"`
	StartedAt    string     `json:"startedAt,omitempty"`
	FinishedAt   string     `json:"finishedAt,omitempty"`
}

type Job struct {
	id           string
	urls         []string
	outDir       string
	jobs         int
	force        bool
	nameTemplate string
	cancel       context.CancelFunc
	ctx          context.Context

	mu         sync.Mutex
	status     string
	feeds      []*FeedView
	mediaIndex map[*qq.Media]int
	total      int
	err        string
	logs       []string
	results    map[int]FileView
	startedAt  time.Time
	finishedAt time.Time
}

type feedItem struct {
	URL    string
	Feed   *qq.Feed
	Medias []*qq.Media
	Err    error
}

func (j *Job) log(msg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+"  "+msg)
}

func (j *Job) setFeeds(items []feedItem) {
	j.mu.Lock()
	defer j.mu.Unlock()

	j.feeds = make([]*FeedView, 0, len(items))
	j.mediaIndex = map[*qq.Media]int{}
	index := 0
	for i, item := range items {
		view := &FeedView{Index: i + 1, URL: item.URL, Medias: make([]MediaView, 0)}
		if item.Err != nil {
			view.Error = item.Err.Error()
		}
		if item.Feed != nil {
			f := item.Feed
			view.ID = f.ID
			view.GuildID = f.GuildID
			view.ChannelID = f.ChannelID
			view.PosterID = f.PosterID
			view.PosterName = f.PosterName
			view.Title = f.Title
			view.ImageCount = len(f.Images)
			view.VideoCount = len(f.Videos)
			view.Medias = make([]MediaView, 0, len(item.Medias))
		}
		for _, m := range item.Medias {
			index++
			view.Medias = append(view.Medias, MediaView{
				Index: index, Seq: m.Seq, Kind: m.Kind, Width: m.Width, Height: m.Height,
				Size: m.ExpectedSize, Name: qq.BuildName(m, j.nameTemplate, m.Ext), Ext: m.Ext, IsGIF: m.IsGIF,
				ChannelID: m.ChannelID, GuildID: m.GuildID, SubChannelID: m.SubChannelID,
				PostID: m.PostID, PosterID: m.PosterID, PosterName: m.PosterName, Title: m.Title, Order: m.Seq,
			})
			j.mediaIndex[m] = index
		}
		j.feeds = append(j.feeds, view)
	}
	j.total = index
}

func (j *Job) record(r qq.Result, writeLog bool) {
	fv := FileView{Seq: r.Media.Seq, Size: r.Size, Status: "success", FeedID: r.Media.PostID}
	if r.Err != nil {
		fv.Status = "failed"
		fv.Error = r.Err.Error()
	} else if r.Skipped {
		fv.Status = "skipped"
	}
	if r.Path != "" {
		if rel, err := filepath.Rel(j.outDir, r.Path); err == nil && rel != "." {
			fv.Name = filepath.ToSlash(rel)
		} else {
			fv.Name = filepath.Base(r.Path)
		}
	} else {
		fv.Name = qq.BuildName(r.Media, j.nameTemplate, r.Media.Ext)
	}

	j.mu.Lock()
	if j.results == nil {
		j.results = map[int]FileView{}
	}
	fv.Index = j.mediaIndex[r.Media]
	if fv.Index == 0 {
		fv.Index = r.Media.Seq
	}
	j.results[fv.Index] = fv
	if writeLog {
		switch fv.Status {
		case "failed":
			j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+"  ✗ "+fv.Name+"："+fv.Error)
		case "skipped":
			j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+"  = "+fv.Name+" 已存在，跳过")
		default:
			j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+"  ✓ "+fv.Name+"  "+formatSize(fv.Size))
			if r.Warning != "" {
				j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+"  ! "+fv.Name+"："+r.Warning)
			}
		}
	}
	j.mu.Unlock()
}

func appendCapped(logs []string, msg string) []string {
	if len(logs) >= 500 {
		logs = logs[len(logs)-400:]
	}
	return append(logs, msg)
}

func (j *Job) fail(err error) {
	j.mu.Lock()
	j.finishedAt = time.Now()
	if j.ctx.Err() != nil {
		j.status = "canceled"
		j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+"  任务已取消")
	} else {
		j.err = err.Error()
		j.status = "error"
		j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+"  ✗ "+err.Error())
	}
	j.mu.Unlock()
}

func (j *Job) finish() {
	j.mu.Lock()
	j.finishedAt = time.Now()
	if j.ctx.Err() != nil {
		j.status = "canceled"
	} else {
		j.status = "done"
	}
	success, skipped, failed := 0, 0, 0
	for _, r := range j.results {
		switch r.Status {
		case "failed":
			failed++
		case "skipped":
			skipped++
		default:
			success++
		}
	}
	if j.status == "canceled" {
		j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+fmt.Sprintf("  任务已取消：成功 %d，跳过 %d，失败 %d", success, skipped, failed))
	} else {
		j.logs = appendCapped(j.logs, time.Now().Format("15:04:05")+fmt.Sprintf("  全部完成：成功 %d，跳过 %d，失败 %d", success, skipped, failed))
	}
	j.mu.Unlock()
}

func (j *Job) snapshot() JobView {
	j.mu.Lock()
	defer j.mu.Unlock()
	v := JobView{
		ID: j.id, Status: j.status, OutDir: j.outDir, Total: j.total, Error: j.err,
		NameTemplate: j.nameTemplate,
		Logs:         append([]string(nil), j.logs...),
		URLs:         append([]string(nil), j.urls...),
	}
	if len(j.urls) > 0 {
		v.URL = j.urls[0]
	}
	if !j.startedAt.IsZero() {
		v.StartedAt = j.startedAt.Format(time.RFC3339)
	}
	if !j.finishedAt.IsZero() {
		v.FinishedAt = j.finishedAt.Format(time.RFC3339)
	}
	for _, f := range j.feeds {
		if f == nil {
			continue
		}
		item := *f
		item.Medias = append([]MediaView(nil), f.Medias...)
		v.Feeds = append(v.Feeds, item)
	}
	indexes := make([]int, 0, len(j.results))
	for index := range j.results {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	for _, index := range indexes {
		r := j.results[index]
		v.Results = append(v.Results, r)
		switch r.Status {
		case "failed":
			v.Failed++
		case "skipped":
			v.Skipped++
		default:
			v.Success++
		}
	}
	v.Done = len(v.Results)
	return v
}

func (j *Job) isRunning() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status == "running"
}

// Manager owns at most one active batch and keeps the last batch for polling.
type Manager struct {
	ctx        context.Context
	defaultOut string
	mu         sync.Mutex
	current    *Job
	seq        int64
}

func NewManager(ctx context.Context, defaultOut string) *Manager {
	return &Manager{ctx: ctx, defaultOut: defaultOut}
}

func normalizePostURL(raw string) (string, error) {
	u := qq.NormalizeInput(raw)
	if u == "" {
		return "", errors.New("请填写帖子链接")
	}
	parsed, err := url.Parse(u)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("链接格式不正确")
	}
	if !strings.EqualFold(parsed.Hostname(), "pd.qq.com") {
		return "", errors.New("只支持 pd.qq.com 的帖子链接")
	}
	return u, nil
}

func requestURLs(req DownloadRequest) []string {
	raw := make([]string, 0, len(req.URLs)+1)
	raw = append(raw, req.URLs...)
	if req.URL != "" {
		raw = append(raw, req.URL)
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func normalizePostURLs(req DownloadRequest) ([]string, error) {
	raw := requestURLs(req)
	if len(raw) == 0 {
		return nil, errors.New("请至少填写一个帖子链接")
	}
	if len(raw) > 30 {
		return nil, errors.New("一次最多解析 30 个链接")
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		u, err := normalizePostURL(item)
		if err != nil {
			return nil, fmt.Errorf("%s：%w", item, err)
		}
		if seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	return out, nil
}

func (m *Manager) Start(req DownloadRequest, defaultJobs int) (*Job, error) {
	urls, err := normalizePostURLs(req)
	if err != nil {
		return nil, err
	}
	nameTemplate := strings.TrimSpace(req.NameTemplate)
	if nameTemplate == "" {
		nameTemplate = qq.DefaultNameTemplate
	}
	if err := qq.ValidateNameTemplate(nameTemplate); err != nil {
		return nil, err
	}
	out := strings.TrimSpace(req.OutDir)
	if out == "" {
		out = m.defaultOut
	}
	if out == "" {
		out = "downloads"
	}
	abs, err := filepath.Abs(out)
	if err != nil {
		return nil, fmt.Errorf("保存目录无效：%w", err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("无法创建保存目录：%w", err)
	}
	jobs := req.Jobs
	if jobs <= 0 {
		jobs = defaultJobs
	}
	if jobs < 1 {
		jobs = 1
	}
	if jobs > 16 {
		jobs = 16
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.current != nil && m.current.isRunning() {
		return nil, fmt.Errorf("已有下载任务在运行，请等待完成或取消")
	}
	ctx, cancel := context.WithCancel(m.ctx)
	j := &Job{
		id:           fmt.Sprintf("job-%d-%d", time.Now().Unix(), atomic.AddInt64(&m.seq, 1)),
		urls:         urls,
		outDir:       abs,
		jobs:         jobs,
		force:        req.Force,
		nameTemplate: nameTemplate,
		cancel:       cancel,
		ctx:          ctx,
		status:       "running",
		logs:         []string{},
		results:      map[int]FileView{},
		startedAt:    time.Now(),
	}
	m.current = j
	go m.run(j)
	return j, nil
}

func (m *Manager) run(j *Job) {
	defer j.cancel()

	items := make([]feedItem, 0, len(j.urls))
	for i, raw := range j.urls {
		if j.ctx.Err() != nil {
			j.fail(j.ctx.Err())
			return
		}
		j.log(fmt.Sprintf("正在解析第 %d/%d 个帖子…", i+1, len(j.urls)))
		client := qq.NewClient()
		html, _, err := client.FetchPage(j.ctx, raw)
		if err != nil {
			j.log("✗ " + raw + " 解析页面失败：" + err.Error())
			items = append(items, feedItem{URL: raw, Err: err})
			continue
		}
		feed, err := qq.ParsePostHTML(html)
		if err != nil {
			j.log("✗ " + raw + " 解析帖子失败：" + err.Error())
			items = append(items, feedItem{URL: raw, Err: err})
			continue
		}
		medias := feed.Medias()
		if len(medias) == 0 {
			err = errors.New("帖子中没有可下载的图片、GIF 或视频")
			j.log("✗ " + raw + "：" + err.Error())
			items = append(items, feedItem{URL: raw, Err: err})
			continue
		}
		j.log(fmt.Sprintf("  ✓ %s：%d 张图片 / %d 个视频，共 %d 个文件",
			feed.ID, len(feed.Images), len(feed.Videos), len(medias)))
		items = append(items, feedItem{URL: raw, Feed: feed, Medias: medias})
	}

	j.setFeeds(items)
	if j.total == 0 {
		j.fail(errors.New("所有链接都没有可下载的图片、GIF 或视频"))
		return
	}
	parsedFeeds := 0
	for _, item := range items {
		if item.Feed != nil {
			parsedFeeds++
		}
	}
	j.log(fmt.Sprintf("批量解析完成：%d/%d 个帖子可用，共 %d 个文件", parsedFeeds, len(j.urls), j.total))
	j.log("开始下载，保存到 " + j.outDir)

	all := make([]*qq.Media, 0, j.total)
	for _, item := range items {
		all = append(all, item.Medias...)
	}
	dl := &qq.Downloader{
		Client:       qq.NewClient(),
		OutDir:       j.outDir,
		Jobs:         j.jobs,
		Force:        j.force,
		NameTemplate: j.nameTemplate,
		OnEvent:      func(r qq.Result) { j.record(r, true) },
	}
	results := dl.DownloadAll(j.ctx, all)
	for _, r := range results {
		j.record(r, false)
	}
	j.finish()
}

func (m *Manager) Get(id string) (JobView, bool) {
	m.mu.Lock()
	j := m.current
	m.mu.Unlock()
	if j == nil || j.id != id {
		return JobView{}, false
	}
	return j.snapshot(), true
}

func (m *Manager) Cancel(id string) bool {
	m.mu.Lock()
	j := m.current
	m.mu.Unlock()
	if j == nil || j.id != id || !j.isRunning() {
		return false
	}
	j.cancel()
	return true
}

func formatSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
