package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"qqchannel-downloader/internal/qq"
	"qqchannel-downloader/internal/webui"
)

func main() {
	var (
		out       = flag.String("o", "downloads", "输出目录（可自定义下载路径）")
		jobs      = flag.Int("j", 4, "并发下载数")
		dry       = flag.Bool("dry-run", false, "只解析并列出文件，不下载")
		force     = flag.Bool("force", false, "覆盖已存在的文件")
		nameTpl   = flag.String("name", qq.DefaultNameTemplate, "文件名模板，默认 <channel_id>-<post_id>-<order>")
		version   = flag.Bool("v", false, "显示版本")
		web       = flag.Bool("web", false, "启动可视化 WebUI（无参数时默认启动）")
		listen    = flag.String("listen", "127.0.0.1:0", "WebUI 监听地址，例如 127.0.0.1:8765")
		noBrowser = flag.Bool("no-browser", false, "启动 WebUI 时不自动打开浏览器")
		batch     = flag.Int("p", 3, "同时处理的帖子数（1-10）")
	)
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, `QQ频道图文/视频原文件下载器

用法:
  qqdl [选项] <帖子链接或feedId> [更多链接...]   命令行下载
  qqdl --web [选项]                               启动可视化界面

示例:
  qqdl "https://pd.qq.com/g/605695554027767602/post/B_51a2d56ad69b05001441152189397568750X60"
  qqdl -o "D:\\QQ下载" -j 8 "https://pd.qq.com/s/xxxx"
  qqdl --web
  qqdl --web -listen 0.0.0.0:8765 -no-browser

选项:
`)
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\n命名变量:\n%s\n", qq.TokenHint())
	}
	flag.Parse()
	if err := qq.ValidateNameTemplate(*nameTpl); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *version {
		fmt.Println("qqdl 1.0.0")
		return
	}
	args := flag.Args()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// No arguments (often a double-click on Windows) opens the visual UI.
	if *web || len(args) == 0 {
		err := webui.Run(ctx, webui.Config{
			DefaultOut: *out,
			Jobs:       *jobs,
			Listen:     *listen,
			Version:    "1.0.0",
			NoBrowser:  *noBrowser,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "WebUI 启动失败: %v\n", err)
			os.Exit(1)
		}
		return
	}

	outDir, err := filepath.Abs(*out)
	if err != nil {
		outDir = *out
	}
	if *batch < 1 {
		*batch = 1
	}
	if *batch > 10 {
		*batch = 10
	}

	var (
		failed  int
		failMu  sync.Mutex
		printMu sync.Mutex
		wg      sync.WaitGroup
	)
	sem := make(chan struct{}, *batch)
	for _, arg := range args {
		wg.Add(1)
		go func(arg string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ok, bad := processArg(ctx, arg, outDir, *jobs, *dry, *force, *nameTpl, &printMu)
			if !ok || bad > 0 {
				failMu.Lock()
				failed++
				failMu.Unlock()
			}
		}(arg)
	}
	wg.Wait()
	if failed > 0 {
		os.Exit(1)
	}
}

func extOr(e string) string {
	if e == "" {
		return ".(自动识别扩展名)"
	}
	return "." + e
}

func humanSize(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
