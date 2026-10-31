package qq

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// DefaultNameTemplate keeps the channel ID, post ID and media order. The
// extension is appended automatically unless the template contains <ext>.
const DefaultNameTemplate = "<channel_id>-<post_id>-<order>"

// NameToken describes one variable accepted by BuildName.
type NameToken struct {
	Token string `json:"token"`
	Desc  string `json:"desc"`
}

// NameTokens is the public list shown by the WebUI/CLI help.
var NameTokens = []NameToken{
	{"<channel_id>", "频道ID（链接 /g/ 后的数字，也接受 <guild_id>）"},
	{"<post_id>", "文章ID（帖子 ID，也接受 <feed_id>）"},
	{"<order>", "图片/视频序号（从 1 开始，也接受 <seq>）"},
	{"<poster_id>", "发帖者ID"},
	{"<poster_name>", "发帖者昵称"},
	{"<sub_channel_id>", "子频道ID"},
	{"<title>", "帖子标题"},
	{"<kind>", "媒体类型：image 或 video"},
	{"<ext>", "扩展名（不写则自动追加到末尾）"},
	{"<width>", "像素宽度"},
	{"<height>", "像素高度"},
}

var reNameToken = regexp.MustCompile(`<([^<>]+)>`)

// nameAlias maps English and Chinese spellings to one canonical token.
var nameAlias = map[string]string{
	"channel_id": "channel_id", "频道id": "channel_id", "频道": "channel_id",
	"guild_id": "guild_id", "guild": "guild_id",
	"sub_channel_id": "sub_channel_id", "子频道id": "sub_channel_id", "子频道": "sub_channel_id",
	"post_id": "post_id", "feed_id": "post_id", "文章id": "post_id", "文章": "post_id",
	"order": "order", "seq": "order", "图片序号": "order", "序号": "order",
	"poster_id": "poster_id", "作者id": "poster_id", "作者": "poster_id",
	"poster_name": "poster_name", "作者名": "poster_name",
	"title": "title", "标题": "title",
	"kind": "kind", "类型": "kind",
	"ext": "ext", "extension": "ext", "扩展名": "ext",
	"width": "width", "宽度": "width", "height": "height", "高度": "height",
}

func canonicalToken(tok string) (string, bool) {
	name, ok := nameAlias[strings.ToLower(strings.TrimSpace(tok))]
	return name, ok
}

// ValidateNameTemplate returns an error for an unknown angle-bracket variable.
func ValidateNameTemplate(tpl string) error {
	if strings.TrimSpace(tpl) == "" {
		return nil
	}
	for _, m := range reNameToken.FindAllStringSubmatch(tpl, -1) {
		if _, ok := canonicalToken(m[1]); !ok {
			return fmt.Errorf("未知命名变量 <%s>，可用变量：<channel_id>、<post_id>、<order>、<poster_id>、<poster_name>、<sub_channel_id>、<title>、<kind>、<ext>、<width>、<height>", strings.TrimSpace(m[1]))
		}
	}
	return nil
}

func hasExtToken(tpl string) bool {
	for _, m := range reNameToken.FindAllStringSubmatch(tpl, -1) {
		if c, ok := canonicalToken(m[1]); ok && c == "ext" {
			return true
		}
	}
	return false
}

func tokenValue(m *Media, canonical, ext string) string {
	switch canonical {
	case "channel_id":
		if m.ChannelID != "" {
			return m.ChannelID
		}
		if m.GuildID != "" {
			return m.GuildID
		}
		return m.PosterID
	case "guild_id":
		if m.GuildID != "" {
			return m.GuildID
		}
		return m.ChannelID
	case "sub_channel_id":
		return m.SubChannelID
	case "post_id":
		return m.PostID
	case "order":
		return strconv.Itoa(m.Seq)
	case "poster_id":
		return m.PosterID
	case "poster_name":
		return m.PosterName
	case "title":
		return m.Title
	case "kind":
		return m.Kind
	case "ext":
		return ext
	case "width":
		return strconv.Itoa(m.Width)
	case "height":
		return strconv.Itoa(m.Height)
	}
	return ""
}

func renderName(m *Media, tpl, ext string, appendExt bool) string {
	if strings.TrimSpace(tpl) == "" {
		tpl = DefaultNameTemplate
	}
	hadExt := hasExtToken(tpl)
	// Only literal "/" in the template separates folders. Slashes inside a
	// substituted value (for example a post title) are sanitized to "_" so a
	// title can never escape the chosen download directory.
	parts := strings.Split(tpl, "/")
	segments := make([]string, 0, len(parts))
	for _, part := range parts {
		rendered := reNameToken.ReplaceAllStringFunc(part, func(raw string) string {
			sub := reNameToken.FindStringSubmatch(raw)
			if sub == nil {
				return ""
			}
			c, ok := canonicalToken(sub[1])
			if !ok {
				return "_"
			}
			return tokenValue(m, c, ext)
		})
		segment := sanitizeFileName(rendered)
		if segment == "" {
			continue
		}
		segments = append(segments, segment)
	}
	if len(segments) == 0 {
		segments = append(segments, "file")
	}
	if appendExt && !hadExt && ext != "" {
		last := len(segments) - 1
		segments[last] += "." + ext
	}
	return strings.Join(segments, "/")
}

// BuildName renders a complete filename, appending the extension when the
// template does not contain <ext>.
func BuildName(m *Media, tpl, ext string) string {
	return renderName(m, tpl, ext, true)
}

// BuildBaseName renders the template without an automatic extension; it is
// used for previews and for legacy skip checks.
func BuildBaseName(m *Media, tpl string) string {
	return renderName(m, tpl, "", false)
}

var illegalFileName = `<>:"/\|?*`

func sanitizeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 32:
			continue
		case strings.ContainsRune(illegalFileName, r):
			b.WriteByte('_')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	out = strings.TrimRight(out, " .")
	if out == "" || out == "." || out == ".." {
		return ""
	}
	// Keep the filename comfortably below the common 255-byte limit.
	for utf8.RuneCountInString(out) > 180 {
		_, size := utf8.DecodeLastRuneInString(out)
		out = out[:len(out)-size]
	}
	return out
}

// TokenHint is a compact multi-line help for CLI/README.
func TokenHint() string {
	var b strings.Builder
	for _, t := range NameTokens {
		b.WriteString(fmt.Sprintf("%s = %s\n", t.Token, t.Desc))
	}
	return strings.TrimRight(b.String(), "\n")
}
