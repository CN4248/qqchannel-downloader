package webui

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestQQJobHistoryRecoversRunning(t *testing.T) {
	dir := t.TempDir()
	raw := `[
	  {"id":"done-1","status":"done","urls":["https://pd.qq.com/post/B_a"],"outDir":"/out","total":2,"done":2,"success":2,"startedAt":"2026-01-01T00:00:00+08:00","finishedAt":"2026-01-01T00:00:10+08:00"},
	  {"id":"running-1","status":"running","urls":["https://pd.qq.com/post/B_b"],"outDir":"/out","total":3,"startedAt":"2026-01-01T00:01:00+08:00"}
	]`
	if err := os.WriteFile(filepath.Join(dir, "jobs.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewManager(context.Background(), "/out", dir)
	v, ok := m.Get("done-1")
	if !ok || v.Status != "done" || v.Success != 2 {
		t.Fatalf("done job not restored: %#v %v", v, ok)
	}
	v, ok = m.Get("running-1")
	if !ok || v.Status != "error" || v.Error == "" {
		t.Fatalf("running should become error: %#v %v", v, ok)
	}
	if len(m.List()) != 2 {
		t.Fatalf("List=%d, want 2", len(m.List()))
	}
}

func TestQQJobHistorySurvivesRemember(t *testing.T) {
	dir := t.TempDir()
	m := NewManager(context.Background(), "/out", dir)
	m.remember(JobView{ID: "j1", Status: "done", URLs: []string{"u"}, OutDir: "/out", Total: 1, Success: 1, StartedAt: "2026-01-01T00:00:00+08:00"})
	m2 := NewManager(context.Background(), "/out", dir)
	v, ok := m2.Get("j1")
	if !ok || v.Status != "done" || v.Total != 1 {
		t.Fatalf("remember/load failed: %#v %v", v, ok)
	}
}
