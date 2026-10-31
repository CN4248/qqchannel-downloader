package webui

import (
	"context"
	"testing"

	"qqchannel-downloader/internal/qq"
)

func TestNormalizePostURL(t *testing.T) {
	ok := []string{
		"https://pd.qq.com/g/1/post/B_x",
		"http://pd.qq.com/post/B_x",
		"pd.qq.com/post/B_x",
	}
	for _, in := range ok {
		if _, err := normalizePostURL(in); err != nil {
			t.Errorf("normalizePostURL(%q) error: %v", in, err)
		}
	}
	bad := []string{"", "https://example.com/post/B_x", "not a url", "javascript:alert(1)"}
	for _, in := range bad {
		if _, err := normalizePostURL(in); err == nil {
			t.Errorf("normalizePostURL(%q) should fail", in)
		}
	}
}

func TestManagerRejectsNonQQURL(t *testing.T) {
	m := NewManager(context.Background(), t.TempDir(), t.TempDir())
	if _, err := m.Start(DownloadRequest{URL: "https://example.com/x"}, 4); err == nil {
		t.Fatal("expected error for non-QQ URL")
	}
}

func TestFormatSize(t *testing.T) {
	cases := map[int64]string{0: "0 B", 1024: "1.0 KB", 75776: "74.0 KB", 1604052: "1.5 MB"}
	for in, want := range cases {
		if got := formatSize(in); got != want {
			t.Errorf("formatSize(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestBatchURLsDeduplicate(t *testing.T) {
	req := DownloadRequest{URLs: []string{
		"https://pd.qq.com/post/B_one",
		"https://pd.qq.com/post/B_one",
		"pd.qq.com/post/B_two",
	}}
	urls, err := normalizePostURLs(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(urls) != 2 {
		t.Fatalf("got %d urls, want 2: %v", len(urls), urls)
	}
	if urls[0] != "https://pd.qq.com/post/B_one" || urls[1] != "https://pd.qq.com/post/B_two" {
		t.Fatalf("unexpected urls: %v", urls)
	}
}

func TestBatchURLsRejectInvalidOne(t *testing.T) {
	req := DownloadRequest{URLs: []string{"https://pd.qq.com/post/B_one", "https://example.com/post/B_two"}}
	if _, err := normalizePostURLs(req); err == nil {
		t.Fatal("expected invalid batch URL to be rejected")
	}
}

func TestRequestURLsEmpty(t *testing.T) {
	if got := requestURLs(DownloadRequest{}); len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestBatchRelativeResultPath(t *testing.T) {
	media := &qq.Media{Seq: 2, Kind: "image", Ext: "jpg", PostID: "B_x"}
	j := &Job{
		outDir:       "/tmp/qqdl-out",
		nameTemplate: qq.DefaultNameTemplate,
		results:      map[int]FileView{},
		mediaIndex:   map[*qq.Media]int{media: 1},
	}
	j.record(qq.Result{Media: media, Path: "/tmp/qqdl-out/每日偶玛/file.jpg", Size: 123}, false)
	got := j.results[1]
	if got.Name != "每日偶玛/file.jpg" {
		t.Fatalf("result name = %q, want relative path", got.Name)
	}
}
