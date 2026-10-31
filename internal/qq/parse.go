package qq

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Feed is the normalized post detail.
type Feed struct {
	ID         string
	GuildID    string // 频道 ID（链接 /g/ 后的数字）
	ChannelID  string // 子频道 ID
	PosterID   string
	PosterName string
	Title      string
	CreateTime int64
	Images     []Image
	Videos     []Video
}

type Image struct {
	DisplayIndex int
	URL          string // original-quality URL
	Width        int
	Height       int
	OrigSize     int64
	MD5          string
	IsGIF        bool
}

type Video struct {
	DisplayIndex int
	URL          string
	Width        int
	Height       int
	DurationMS   int64
	Rate         int64
	FileID       string
}

// Media is one downloadable item with its final sequence number.
type Media struct {
	Kind         string // "image" or "video"
	Seq          int
	SourceIndex  int
	DisplayIndex int
	URL          string
	Ext          string
	Width        int
	Height       int
	ExpectedSize int64
	MD5          string
	IsGIF        bool
	Name         string

	// Naming metadata (filled from Feed by Medias).
	ChannelID    string // 频道 ID（guild，供 <channel_id> 使用）
	GuildID      string
	SubChannelID string
	PostID       string
	PosterID     string
	PosterName   string
	Title        string
}

var reSpecSegment = regexp.MustCompile(`/(?:b|c|m|s|0)=`)

// OriginalImageURL converts a QQ channel preview URL into the original-file URL.
// The CDN path segment /b= (big), /c= (cover), /m= (medium), /s= (small) or /0
// is replaced by /o=, which serves the exact uploaded file. The rest of the
// signed query string must be preserved.
func OriginalImageURL(u string) string {
	if u == "" {
		return ""
	}
	if strings.Contains(u, "/o=") {
		return u
	}
	if loc := reSpecSegment.FindStringIndex(u); loc != nil {
		return u[:loc[0]] + "/o=" + u[loc[1]:]
	}
	return u
}

// ParsePostHTML extracts the post detail from the Nuxt SSR payload.
func ParsePostHTML(html string) (*Feed, error) {
	m := reNuxtData.FindStringSubmatch(html)
	if m == nil {
		return nil, fmt.Errorf("no __NUXT_DATA__ payload found")
	}
	rootAny, err := decodeDevalue([]byte(m[1]))
	if err != nil {
		return nil, err
	}
	root, ok := rootAny.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected Nuxt root type %T", rootAny)
	}
	data, ok := root["data"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("Nuxt payload has no data map")
	}
	var lastErr error
	for _, v := range data {
		resp, ok := v.(map[string]interface{})
		if !ok {
			continue
		}
		if toInt64(resp["retcode"]) != 0 {
			continue
		}
		body, ok := resp["data"].(map[string]interface{})
		if !ok {
			continue
		}
		if fm, ok := body["feed"].(map[string]interface{}); ok {
			f, err := buildFeed(fm)
			if err != nil {
				lastErr = err
				continue
			}
			return f, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("post detail not found in SSR payload (the post may be deleted or private)")
}

func buildFeed(fm map[string]interface{}) (*Feed, error) {
	f := &Feed{}
	f.ID = toStr(fm["id"])
	if f.ID == "" {
		return nil, fmt.Errorf("feed has no id")
	}
	if p, ok := fm["poster"].(map[string]interface{}); ok {
		f.PosterID = firstNonEmpty(toStr(p["id"]), toStr(p["str_tiny_id"]), toStr(p["tiny_id"]), toStr(p["uin"]))
		f.PosterName = toStr(p["nick"])
	}
	if f.PosterID == "" {
		f.PosterID = "unknown"
	}
	f.Title = feedTitle(fm)
	f.GuildID, f.ChannelID = feedChannelIDs(fm)

	seenImg := map[string]bool{}
	if list, ok := fm["images"].([]interface{}); ok {
		for i, item := range list {
			im, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			u := toStr(im["picUrl"])
			if u == "" {
				u = bestVecImageURL(im["vecImageUrl"])
			}
			if u == "" {
				u = toStr(im["layerPicUrl"])
			}
			if u == "" {
				continue
			}
			di := int(toInt64(im["display_index"]))
			if di == 0 && i > 0 {
				di = i
			}
			key := fmt.Sprintf("%d|%s", di, u)
			if seenImg[key] {
				continue
			}
			seenImg[key] = true
			f.Images = append(f.Images, Image{
				DisplayIndex: di,
				URL:          OriginalImageURL(u),
				Width:        int(toInt64(im["width"])),
				Height:       int(toInt64(im["height"])),
				OrigSize:     toInt64(im["orig_size"]),
				MD5:          strings.ToLower(toStr(im["imageMD5"])),
				IsGIF:        toBool(im["is_gif"]) || strings.Contains(strings.ToLower(u), ".gif"),
			})
		}
	}

	seenVid := map[string]bool{}
	if list, ok := fm["videos"].([]interface{}); ok {
		for i, item := range list {
			vm, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			u, rate := bestVideoURL(vm["vecVideoUrl"])
			if u == "" {
				u = toStr(vm["playUrl"])
				rate = toInt64(vm["videoRate"])
			}
			if u == "" || strings.HasPrefix(u, "data:") {
				continue
			}
			key := toStr(vm["fileId"]) + "|" + u
			if seenVid[key] {
				continue
			}
			seenVid[key] = true
			di := int(toInt64(vm["display_index"]))
			if di == 0 && i > 0 {
				di = i
			}
			f.Videos = append(f.Videos, Video{
				DisplayIndex: di,
				URL:          u,
				Width:        int(toInt64(vm["width"])),
				Height:       int(toInt64(vm["height"])),
				DurationMS:   toInt64(vm["duration"]),
				Rate:         rate,
				FileID:       toStr(vm["fileId"]),
			})
		}
	}
	if len(f.Images) == 0 && len(f.Videos) == 0 {
		return nil, fmt.Errorf("post %s contains no downloadable images or videos", f.ID)
	}
	return f, nil
}

// Medias returns every image and video in display order, numbered from 1.
func (f *Feed) Medias() []*Media {
	type item struct {
		kind string
		di   int
		src  int
		img  *Image
		vid  *Video
	}
	var items []item
	for i := range f.Images {
		items = append(items, item{"image", f.Images[i].DisplayIndex, i, &f.Images[i], nil})
	}
	for i := range f.Videos {
		items = append(items, item{"video", f.Videos[i].DisplayIndex, i, nil, &f.Videos[i]})
	}
	sort.SliceStable(items, func(a, b int) bool {
		if items[a].di != items[b].di {
			return items[a].di < items[b].di
		}
		// images before videos when display indices tie
		if items[a].kind != items[b].kind {
			return items[a].kind == "image"
		}
		return items[a].src < items[b].src
	})
	out := make([]*Media, 0, len(items))
	for i, it := range items {
		m := &Media{Seq: i + 1, DisplayIndex: it.di, SourceIndex: it.src}
		if it.img != nil {
			m.Kind = "image"
			m.URL = it.img.URL
			m.Width, m.Height = it.img.Width, it.img.Height
			m.ExpectedSize, m.MD5, m.IsGIF = it.img.OrigSize, it.img.MD5, it.img.IsGIF
			if m.IsGIF {
				m.Ext = "gif"
			}
		} else {
			m.Kind = "video"
			m.URL = it.vid.URL
			m.Width, m.Height = it.vid.Width, it.vid.Height
			m.Ext = videoExt(it.vid.URL)
		}
		m.GuildID = f.GuildID
		m.SubChannelID = f.ChannelID
		m.ChannelID = firstNonEmpty(f.GuildID, f.ChannelID, f.PosterID)
		m.PostID = f.ID
		m.PosterID = f.PosterID
		m.PosterName = f.PosterName
		m.Title = f.Title
		m.Name = BuildBaseName(m, DefaultNameTemplate)
		out = append(out, m)
	}
	return out
}

// feedChannelIDs extracts the guild (channel) and sub-channel IDs from the
// feed's channelInfo.sign, falling back to the share payload and top level.
func feedChannelIDs(fm map[string]interface{}) (guild, channel string) {
	readSign := func(v interface{}) {
		m, ok := v.(map[string]interface{})
		if !ok {
			return
		}
		if guild == "" {
			guild = toStr(m["guild_id"])
		}
		if channel == "" {
			channel = toStr(m["channel_id"])
		}
	}
	if ci, ok := fm["channelInfo"].(map[string]interface{}); ok {
		readSign(ci["sign"])
	}
	if guild == "" || channel == "" {
		if share, ok := fm["share"].(map[string]interface{}); ok {
			if csi, ok := share["channelShareInfo"].(map[string]interface{}); ok {
				readSign(csi["channelSign"])
			}
		}
	}
	if guild == "" {
		guild = toStr(fm["guild_id"])
	}
	if channel == "" {
		channel = toStr(fm["channel_id"])
	}
	return guild, channel
}

func feedTitle(fm map[string]interface{}) string {
	if t, ok := fm["title"]; ok {
		if s := contentsText(t); s != "" {
			return truncate(strings.TrimSpace(s), 120)
		}
	}
	if s := contentsText(fm["contents"]); s != "" {
		return truncate(strings.TrimSpace(s), 120)
	}
	return truncate(strings.TrimSpace(toStr(fm["summary"])), 120)
}

// contentsText extracts the concatenated text of a QQ "contents" object.
func contentsText(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]interface{}:
		var b strings.Builder
		list, _ := t["contents"].([]interface{})
		for _, it := range list {
			m, ok := it.(map[string]interface{})
			if !ok {
				continue
			}
			if tc, ok := m["text_content"].(map[string]interface{}); ok {
				b.WriteString(toStr(tc["text"]))
			}
		}
		return b.String()
	}
	return ""
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func bestVecImageURL(v interface{}) string {
	list, ok := v.([]interface{})
	if !ok {
		return ""
	}
	best := ""
	bestW := -1
	for _, it := range list {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		w := int(toInt64(m["width"]))
		u := toStr(m["url"])
		if u != "" && w >= bestW {
			best, bestW = u, w
		}
	}
	return best
}

func bestVideoURL(v interface{}) (string, int64) {
	list, ok := v.([]interface{})
	if !ok {
		return "", 0
	}
	best := ""
	var bestRate int64 = -1
	var bestLevel int64 = -1
	for _, it := range list {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		u := toStr(m["playUrl"])
		if u == "" {
			continue
		}
		rate := toInt64(m["videoRate"])
		level := toInt64(m["levelType"])
		if rate > bestRate || (rate == bestRate && level > bestLevel) {
			best, bestRate, bestLevel = u, rate, level
		}
	}
	if bestRate < 0 {
		bestRate = 0
	}
	return best, bestRate
}

func videoExt(u string) string {
	low := strings.ToLower(u)
	if i := strings.IndexAny(low, "?#"); i >= 0 {
		low = low[:i]
	}
	for _, ext := range []string{".mp4", ".m4v", ".mov", ".webm", ".mkv"} {
		if strings.HasSuffix(low, ext) {
			return strings.TrimPrefix(ext, ".")
		}
	}
	return "mp4"
}

// NormalizeInput accepts a post URL or a bare feed id (B_...) and returns a URL.
func NormalizeInput(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		return s
	}
	if strings.HasPrefix(s, "B_") {
		return "https://pd.qq.com/post/" + s
	}
	if strings.HasPrefix(s, "pd.qq.com/") {
		return "https://" + s
	}
	return s
}

// SafeName keeps only characters that are safe on Windows, macOS and Linux.
func SafeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "x"
	}
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}

func toStr(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

func toInt64(v interface{}) int64 {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i
		}
		if f, err := t.Float64(); err == nil {
			return int64(f)
		}
	case float64:
		return int64(t)
	case int:
		return int64(t)
	case int64:
		return t
	case string:
		i, _ := strconv.ParseInt(t, 10, 64)
		return i
	case bool:
		if t {
			return 1
		}
	}
	return 0
}

func toBool(v interface{}) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return t == "true" || t == "1"
	case json.Number:
		return t.String() != "0"
	case float64:
		return t != 0
	}
	return false
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v != "" {
			return v
		}
	}
	return ""
}
