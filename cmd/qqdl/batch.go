package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"qqchannel-downloader/internal/qq"
)

// processArg parses and downloads one post link. It is safe to run several
// calls concurrently: output is serialized by printMu and every line carries
// the post's short ID.
func processArg(ctx context.Context, raw, outDir string, jobs int, dry, force bool, nameTpl string, printMu *sync.Mutex) (bool, int) {
	tag := postTag(raw)
	p := func(format string, args ...interface{}) {
		printMu.Lock()
		defer printMu.Unlock()
		all := make([]interface{}, 0, len(args)+1)
		all = append(all, tag)
		all = append(all, args...)
		fmt.Printf("[%s] "+format+"\n", all...)
	}

	url := qq.NormalizeInput(raw)
	p("解析: %s", url)
	client := qq.NewClient()
	html, final, err := client.FetchPage(ctx, url)
	if err != nil {
		p("✗ 解析页面失败: %v", err)
		return false, 0
	}
	feed, err := qq.ParsePostHTML(html)
	if err != nil {
		p("✗ 解析帖子失败: %v (final=%s)", err, final)
		return false, 0
	}
	medias := feed.Medias()
	p("发帖者: %s (%s)", feed.PosterName, feed.PosterID)
	p("文章ID: %s", feed.ID)
	if feed.Title != "" {
		p("标题: %s", feed.Title)
	}
	p("媒体: %d 张图片 / %d 个视频，共 %d 个文件", len(feed.Images), len(feed.Videos), len(medias))
	for _, m := range medias {
		p("  [%d/%d] %-5s %dx%d  %s", m.Seq, len(medias), m.Kind, m.Width, m.Height, qq.BuildName(m, nameTpl, m.Ext))
	}
	if dry {
		return true, 0
	}

	dl := &qq.Downloader{Client: client, OutDir: outDir, Jobs: jobs, Force: force, NameTemplate: nameTpl}
	var doneMu sync.Mutex
	done := 0
	start := time.Now()
	dl.OnEvent = func(r qq.Result) {
		doneMu.Lock()
		done++
		n := done
		doneMu.Unlock()
		if r.Err != nil {
			p("  ✗ [%d/%d] %s: %v", n, len(medias), qq.BuildName(r.Media, nameTpl, r.Media.Ext), r.Err)
			return
		}
		status := "✓"
		if r.Skipped {
			status = "="
		}
		name := filepath.Base(r.Path)
		if rel, relErr := filepath.Rel(outDir, r.Path); relErr == nil && rel != "." {
			name = filepath.ToSlash(rel)
		}
		p("  %s [%d/%d] %s  %s", status, n, len(medias), name, humanSize(r.Size))
		if r.Warning != "" {
			p("    ! %s", r.Warning)
		}
	}
	results := dl.DownloadAll(ctx, medias)
	ok, skipped, bad := 0, 0, 0
	for _, r := range results {
		switch {
		case r.Err != nil:
			bad++
		case r.Skipped:
			skipped++
			ok++
		default:
			ok++
		}
	}
	p("完成: 成功 %d（其中跳过 %d）/ 失败 %d，用时 %s", ok, skipped, bad, time.Since(start).Round(time.Millisecond))
	p("目录: %s", outDir)
	return true, bad
}

func postTag(raw string) string {
	u := qq.NormalizeInput(raw)
	if i := strings.LastIndex(u, "/"); i >= 0 && i+1 < len(u) {
		u = u[i+1:]
	}
	u = strings.TrimSpace(u)
	if len(u) > 18 {
		u = u[:18]
	}
	if u == "" {
		u = "link"
	}
	return u
}
