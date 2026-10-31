package com.qqchannel.downloader.core;

import com.qqchannel.downloader.core.QqParser.Media;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Renders user-defined file names such as {@code <channel_id>-<post_id>-<order>}. */
public final class NameTemplate {
    public static final String DEFAULT = "<channel_id>-<post_id>-<order>";

    private static final Pattern TOKEN = Pattern.compile("<([^<>]+)>");
    private static final Pattern ILLEGAL = Pattern.compile("[<>:\"/\\\\|?*\\x00-\\x1f]");
    private static final Map<String, String> ALIASES = new HashMap<>();

    static {
        alias("channel_id", "channel_id", "频道id", "频道", "guild_id", "guild");
        alias("sub_channel_id", "sub_channel_id", "子频道id", "子频道");
        alias("post_id", "post_id", "feed_id", "文章id", "文章");
        alias("order", "order", "seq", "图片序号", "序号");
        alias("poster_id", "poster_id", "作者id", "作者");
        alias("poster_name", "poster_name", "作者名");
        alias("title", "title", "标题");
        alias("kind", "kind", "类型");
        alias("ext", "ext", "extension", "扩展名");
        alias("width", "width", "宽度");
        alias("height", "height", "高度");
    }

    private static void alias(String canonical, String... names) {
        for (String n : names) {
            ALIASES.put(n.toLowerCase(), canonical);
        }
    }

    private NameTemplate() {
    }

    private static String canonical(String raw) {
        String key = raw == null ? "" : raw.trim().toLowerCase();
        String c = ALIASES.get(key);
        return c == null ? "" : c;
    }

    private static boolean hasExt(String template) {
        Matcher m = TOKEN.matcher(template == null ? "" : template);
        while (m.find()) {
            if ("ext".equals(canonical(m.group(1)))) return true;
        }
        return false;
    }

    private static String value(Media media, String canonical, String ext) {
        switch (canonical) {
            case "channel_id":
                if (!media.channelId.isEmpty()) return media.channelId;
                if (!media.guildId.isEmpty()) return media.guildId;
                return media.posterId;
            case "guild_id":
                return media.guildId.isEmpty() ? media.channelId : media.guildId;
            case "sub_channel_id":
                return media.subChannelId;
            case "post_id":
                return media.postId;
            case "order":
                return String.valueOf(media.seq);
            case "poster_id":
                return media.posterId;
            case "poster_name":
                return media.posterName;
            case "title":
                return media.title;
            case "kind":
                return media.kind;
            case "ext":
                return ext;
            case "width":
                return String.valueOf(media.width);
            case "height":
                return String.valueOf(media.height);
            default:
                return "";
        }
    }

    /** Validate unknown tokens; returns an error message or an empty string. */
    public static String validate(String template) {
        if (template == null || template.trim().isEmpty()) return "";
        Matcher m = TOKEN.matcher(template);
        StringBuilder bad = new StringBuilder();
        while (m.find()) {
            if (canonical(m.group(1)).isEmpty()) {
                if (bad.length() > 0) bad.append("、");
                bad.append('<').append(m.group(1).trim()).append('>');
            }
        }
        if (bad.length() == 0) return "";
        return "未知命名变量 " + bad + "，可用变量：" + tokenHint();
    }

    public static String tokenHint() {
        return "<channel_id>、<post_id>、<order>、<poster_id>、<poster_name>、"
                + "<sub_channel_id>、<title>、<kind>、<ext>、<width>、<height>";
    }

    private static String render(Media media, String template, String ext, boolean appendExt) {
        String tpl = template == null || template.trim().isEmpty() ? DEFAULT : template;
        boolean hadExt = hasExt(tpl);
        String[] parts = tpl.split("/", -1);
        List<String> segments = new ArrayList<>();
        for (String part : parts) {
            Matcher m = TOKEN.matcher(part);
            StringBuffer out = new StringBuffer();
            while (m.find()) {
                String c = canonical(m.group(1));
                String val = c.isEmpty() ? "_" : value(media, c, ext);
                m.appendReplacement(out, Matcher.quoteReplacement(val));
            }
            m.appendTail(out);
            String segment = sanitizeSegment(out.toString());
            if (!segment.isEmpty()) {
                segments.add(segment);
            }
        }
        if (segments.isEmpty()) {
            segments.add("file");
        }
        if (appendExt && !hadExt && ext != null && !ext.isEmpty()) {
            int last = segments.size() - 1;
            segments.set(last, segments.get(last) + "." + ext);
        }
        return String.join("/", segments);
    }

    /** Complete file name; the extension is appended when the template has no &lt;ext&gt;. */
    public static String fileName(Media media, String template, String ext) {
        return render(media, template, ext, true);
    }

    /** Base preview without auto-appending an extension. */
    public static String baseName(Media media, String template) {
        return render(media, template, "", false);
    }

    private static String sanitizeSegment(String name) {
        String out = ILLEGAL.matcher(name == null ? "" : name).replaceAll("_").trim();
        int end = out.length();
        while (end > 0 && (out.charAt(end - 1) == '.' || out.charAt(end - 1) == ' ')) {
            end--;
        }
        out = out.substring(0, end);
        if (out.isEmpty() || out.equals(".") || out.equals("..")) return "";
        if (out.codePointCount(0, out.length()) > 180) {
            out = out.substring(0, out.offsetByCodePoints(0, 180));
        }
        return out;
    }
}
