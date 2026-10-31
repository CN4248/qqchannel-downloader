package qq

import "testing"

func nameMedia() *Media {
	return &Media{
		Kind: "image", Seq: 2, Width: 640, Height: 913,
		ChannelID: "605695554027767602", GuildID: "605695554027767602",
		SubChannelID: "659725119", PostID: "B_test", PosterID: "144115218939756875",
		PosterName: "奇迹海", Title: "每日偶玛",
	}
}

func TestDefaultName(t *testing.T) {
	got := BuildName(nameMedia(), DefaultNameTemplate, "jpg")
	want := "605695554027767602-B_test-2.jpg"
	if got != want {
		t.Fatalf("BuildName = %q, want %q", got, want)
	}
}

func TestCustomName(t *testing.T) {
	m := nameMedia()
	cases := []struct{ tpl, ext, want string }{
		{"<poster_name>_<post_id>_<order>.<ext>", "jpg", "奇迹海_B_test_2.jpg"},
		{"<channel_id>-<order>", "png", "605695554027767602-2.png"},
		{"<sub_channel_id>_<poster_id>_<order>", "mp4", "659725119_144115218939756875_2.mp4"},
		{"<title>_<width>x<height>", "jpg", "每日偶玛_640x913.jpg"},
	}
	for _, c := range cases {
		if got := BuildName(m, c.tpl, c.ext); got != c.want {
			t.Errorf("BuildName(%q) = %q, want %q", c.tpl, got, c.want)
		}
	}
}

func TestNameExtensionNotDuplicated(t *testing.T) {
	m := nameMedia()
	if got, want := BuildName(m, "<channel_id>-<order>.<ext>", "jpg"), "605695554027767602-2.jpg"; got != want {
		t.Fatalf("BuildName = %q, want %q", got, want)
	}
	if got, want := BuildBaseName(m, "<poster_name>_<order>"), "奇迹海_2"; got != want {
		t.Fatalf("BuildBaseName = %q, want %q", got, want)
	}
}

func TestNameSanitizeAndValidate(t *testing.T) {
	m := nameMedia()
	if got, want := BuildName(m, "<title>/<order>", "jpg"), "每日偶玛/2.jpg"; got != want {
		t.Fatalf("subfolder name = %q, want %q", got, want)
	}
	if err := ValidateNameTemplate("<channel_id>-<order>"); err != nil {
		t.Fatalf("valid template rejected: %v", err)
	}
	if err := ValidateNameTemplate("<bogus>"); err == nil {
		t.Fatal("unknown token was accepted")
	}
}

func TestNameEmptyTemplateFallsBack(t *testing.T) {
	m := nameMedia()
	if got, want := BuildName(m, "", "jpg"), "605695554027767602-B_test-2.jpg"; got != want {
		t.Fatalf("empty template = %q, want %q", got, want)
	}
}

func TestNameSubfoldersAndTraversal(t *testing.T) {
	m := nameMedia()
	cases := []struct{ tpl, want string }{
		{"<title>/<channel_id>-<post_id>-<order>", "每日偶玛/605695554027767602-B_test-2"},
		{"/<title>/<order>", "每日偶玛/2"},
		{"<title>//<order>", "每日偶玛/2"},
		{"../../<title>/<order>", "每日偶玛/2"},
		{"<title>/../<order>", "每日偶玛/2"},
		{"<title>\\..\\<order>", "每日偶玛_.._2"},
	}
	for _, c := range cases {
		if got := BuildBaseName(m, c.tpl); got != c.want {
			t.Errorf("BuildBaseName(%q) = %q, want %q", c.tpl, got, c.want)
		}
	}
	m.Title = "A/B:C"
	if got, want := BuildName(m, "<title>/<order>", "jpg"), "A_B_C/2.jpg"; got != want {
		t.Errorf("title slash must stay inside one segment: got %q, want %q", got, want)
	}
}
