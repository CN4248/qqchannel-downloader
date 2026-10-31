package qq

import (
	"strings"
	"testing"
)

func TestOriginalImageURL(t *testing.T) {
	cases := map[string]string{
		"https://channel.qpic.cn/psc?/channel/abc/b=&bo=xyz&ek=1": "https://channel.qpic.cn/psc?/channel/abc/o=&bo=xyz&ek=1",
		"https://channel.qpic.cn/psc?/channel/abc/c=&bo=xyz":      "https://channel.qpic.cn/psc?/channel/abc/o=&bo=xyz",
		"https://channel.qpic.cn/psc?/channel/abc/o=&bo=xyz":      "https://channel.qpic.cn/psc?/channel/abc/o=&bo=xyz",
		"https://example.com/image.jpg":                           "https://example.com/image.jpg",
	}
	for in, want := range cases {
		if got := OriginalImageURL(in); got != want {
			t.Errorf("OriginalImageURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSolveEdgeOne(t *testing.T) {
	body := `<script>/* __tst_status */ var e={WTKkN:1019500695,bOYDu:12345,dtzqS:function(a,n){return a+n},wyeCN:67890};var t=0;x=(t,1624571904);</script>`
	ck, ok := solveEdgeOne(body)
	if !ok {
		t.Fatal("solver did not detect the challenge")
	}
	want := "__tst_status=1019580930#; EO_Bot_Ssid=1624571904"
	if ck != want {
		t.Fatalf("cookie = %q, want %q", ck, want)
	}
	if _, ok := solveEdgeOne("plain html"); ok {
		t.Fatal("solver must ignore pages without a challenge")
	}
}

func TestDecodeDevalue(t *testing.T) {
	root, err := decodeDevalue([]byte(`[{"x":1},{"id":2},"B_test",-7]`))
	if err != nil {
		t.Fatal(err)
	}
	m, ok := root.(map[string]interface{})
	if !ok || m["id"] != "B_test" {
		t.Fatalf("unexpected root: %#v", root)
	}
	// A reactive wrapper must resolve to the referenced value.
	root, err = decodeDevalue([]byte(`[{"x":1},["ShallowReactive",2],"B_wrapped"]`))
	if err != nil || root != "B_wrapped" {
		t.Fatalf("wrapper decode = %#v, %v", root, err)
	}
}

func TestMediasOrderAndNames(t *testing.T) {
	f := &Feed{
		ID:       "B_123",
		PosterID: "144000000000000000",
		Images: []Image{
			{DisplayIndex: 0, URL: "https://x/1.jpg", OrigSize: 11},
			{DisplayIndex: 0, URL: "https://x/2.jpg", OrigSize: 22},
			{DisplayIndex: 2, URL: "https://x/3.gif", OrigSize: 33, IsGIF: true},
		},
		Videos: []Video{{DisplayIndex: 1, URL: "https://x/v.f104007.mp4", Rate: 900}},
	}
	ms := f.Medias()
	if len(ms) != 4 {
		t.Fatalf("got %d medias", len(ms))
	}
	wantKinds := []string{"image", "image", "video", "image"}
	for i, want := range wantKinds {
		if ms[i].Kind != want {
			t.Errorf("media %d kind = %s, want %s", i, ms[i].Kind, want)
		}
		if ms[i].Seq != i+1 {
			t.Errorf("media %d seq = %d", i, ms[i].Seq)
		}
	}
	if ms[0].Name != "144000000000000000-B_123-1" || ms[3].Name != "144000000000000000-B_123-4" {
		t.Errorf("unexpected names: %q / %q", ms[0].Name, ms[3].Name)
	}
	if ms[2].Ext != "mp4" {
		t.Errorf("video ext = %q", ms[2].Ext)
	}
	if !strings.HasSuffix(ms[3].Name, "-4") || ms[3].Ext != "gif" {
		t.Errorf("gif media = %+v", ms[3])
	}
}

func TestSafeName(t *testing.T) {
	if got := SafeName("144115218939756875"); got != "144115218939756875" {
		t.Errorf("SafeName numeric = %q", got)
	}
	if got := SafeName("a b/../c?d"); strings.ContainsAny(got, ` /\?`) {
		t.Errorf("SafeName left unsafe chars: %q", got)
	}
	if got := SafeName("中文"); got == "" {
		t.Error("SafeName returned empty")
	}
}

func TestNormalizeInput(t *testing.T) {
	cases := map[string]string{
		"  https://pd.qq.com/g/1/post/B_x?showGuild=1#frag  ": "https://pd.qq.com/g/1/post/B_x?showGuild=1#frag",
		"B_abc":           "https://pd.qq.com/post/B_abc",
		"pd.qq.com/s/xyz": "https://pd.qq.com/s/xyz",
	}
	for in, want := range cases {
		if got := NormalizeInput(in); got != want {
			t.Errorf("NormalizeInput(%q) = %q, want %q", in, got, want)
		}
	}
}
