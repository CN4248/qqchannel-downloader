package com.qqchannel.downloader.core;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Parses a QQ Channel post's SSR payload into a flat list of downloadable media. */
public final class QqParser {
    private static final Pattern NUXT =
            Pattern.compile("(?s)<script[^>]*id=\"__NUXT_DATA__\"[^>]*>(.*?)</script>");
    private static final Pattern SPEC = Pattern.compile("/(?:b|c|m|s|0)=");

    private QqParser() {
    }

    public static final class Feed {
        public String id = "";
        public String guildId = "";
        public String channelId = "";
        public String posterId = "";
        public String posterName = "";
        public String title = "";
        public int imageCount;
        public int videoCount;
        public final List<Media> medias = new ArrayList<>();
    }

    public static final class Media {
        public String kind = "";
        public int seq;
        public int displayIndex;
        public String url = "";
        public String ext = "";
        public int width;
        public int height;
        public long expectedSize;
        public String md5 = "";
        public boolean gif;
        public String name = "";

        public String channelId = "";
        public String guildId = "";
        public String subChannelId = "";
        public String postId = "";
        public String posterId = "";
        public String posterName = "";
        public String title = "";

        public String fileName(String detectedExt) {
            String e = ext.isEmpty() ? detectedExt : ext;
            return name + "." + e;
        }
    }

    public static Feed parse(String html) throws Exception {
        Matcher m = NUXT.matcher(html);
        if (!m.find()) {
            throw new Exception("页面中没有 __NUXT_DATA__");
        }
        Object rootObj = Devalue.decode(m.group(1));
        Map<String, Object> root = asMap(rootObj);
        Map<String, Object> data = asMap(root.get("data"));
        Exception last = null;
        for (Object v : data.values()) {
            Map<String, Object> resp = asMap(v);
            if (resp.isEmpty() || lng(resp.get("retcode")) != 0) {
                continue;
            }
            Map<String, Object> body = asMap(resp.get("data"));
            Map<String, Object> fm = asMap(body.get("feed"));
            if (fm.isEmpty()) {
                continue;
            }
            try {
                return build(fm);
            } catch (Exception e) {
                last = e;
            }
        }
        if (last != null) {
            throw last;
        }
        throw new Exception("没有找到帖子详情（帖子可能已删除或需要登录）");
    }

    private static Feed build(Map<String, Object> fm) throws Exception {
        Feed f = new Feed();
        f.id = str(fm.get("id"));
        if (f.id.isEmpty()) {
            throw new Exception("帖子缺少 id");
        }
        Map<String, Object> poster = asMap(fm.get("poster"));
        f.posterId = first(str(poster.get("id")), str(poster.get("str_tiny_id")),
                str(poster.get("tiny_id")), str(poster.get("uin")));
        if (f.posterId.isEmpty()) {
            f.posterId = "unknown";
        }
        f.posterName = str(poster.get("nick"));
        f.title = truncate(contentsText(fm.get("title")), 120);
        if (f.title.isEmpty()) {
            f.title = truncate(contentsText(fm.get("contents")), 120);
        }
        String[] ids = channelIds(fm);
        f.guildId = ids[0];
        f.channelId = ids[1];

        List<Item> items = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        List<Object> images = asList(fm.get("images"));
        for (int i = 0; i < images.size(); i++) {
            Map<String, Object> im = asMap(images.get(i));
            if (im.isEmpty()) {
                continue;
            }
            String u = str(im.get("picUrl"));
            if (u.isEmpty()) {
                u = bestVecImage(im.get("vecImageUrl"));
            }
            if (u.isEmpty()) {
                u = str(im.get("layerPicUrl"));
            }
            if (u.isEmpty()) {
                continue;
            }
            int di = (int) lng(im.get("display_index"));
            if (di == 0 && i > 0) {
                di = i;
            }
            String key = di + "|" + u;
            if (!seen.add("i:" + key)) {
                continue;
            }
            Media md = new Media();
            md.kind = "image";
            md.displayIndex = di;
            md.url = originalImageUrl(u);
            md.width = (int) lng(im.get("width"));
            md.height = (int) lng(im.get("height"));
            md.expectedSize = lng(im.get("orig_size"));
            md.md5 = str(im.get("imageMD5")).toLowerCase();
            md.gif = bool(im.get("is_gif")) || u.toLowerCase().endsWith(".gif");
            if (md.gif) {
                md.ext = "gif";
            }
            items.add(new Item(md, i));
        }

        List<Object> videos = asList(fm.get("videos"));
        for (int i = 0; i < videos.size(); i++) {
            Map<String, Object> vm = asMap(videos.get(i));
            if (vm.isEmpty()) {
                continue;
            }
            String[] best = bestVideo(vm.get("vecVideoUrl"));
            String u = best[0];
            long rate = Long.parseLong(best[1]);
            if (u.isEmpty()) {
                u = str(vm.get("playUrl"));
                rate = lng(vm.get("videoRate"));
            }
            if (u.isEmpty() || u.startsWith("data:")) {
                continue;
            }
            int di = (int) lng(vm.get("display_index"));
            if (di == 0 && i > 0) {
                di = i;
            }
            String key = str(vm.get("fileId")) + "|" + u;
            if (!seen.add("v:" + key)) {
                continue;
            }
            Media md = new Media();
            md.kind = "video";
            md.displayIndex = di;
            md.url = u;
            md.width = (int) lng(vm.get("width"));
            md.height = (int) lng(vm.get("height"));
            md.ext = videoExt(u);
            md.md5 = "";
            items.add(new Item(md, i));
        }

        if (items.isEmpty()) {
            throw new Exception("帖子中没有可下载的图片或视频");
        }

        final Feed ff = f;
        items.sort(new Comparator<Item>() {
            @Override
            public int compare(Item a, Item b) {
                if (a.media.displayIndex != b.media.displayIndex) {
                    return Integer.compare(a.media.displayIndex, b.media.displayIndex);
                }
                if (!a.media.kind.equals(b.media.kind)) {
                    return a.media.kind.equals("image") ? -1 : 1;
                }
                return Integer.compare(a.src, b.src);
            }
        });
        int seq = 1;
        for (Item it : items) {
            Media md = it.media;
            md.seq = seq++;
            md.guildId = ff.guildId;
            md.subChannelId = ff.channelId;
            md.channelId = first(ff.guildId, ff.channelId, ff.posterId);
            md.postId = ff.id;
            md.posterId = ff.posterId;
            md.posterName = ff.posterName;
            md.title = ff.title;
            md.name = NameTemplate.baseName(md, NameTemplate.DEFAULT);
            if (md.kind.equals("image")) {
                ff.imageCount++;
            } else {
                ff.videoCount++;
            }
            ff.medias.add(md);
        }
        return ff;
    }

    private static final class Item {
        final Media media;
        final int src;

        Item(Media m, int src) {
            this.media = m;
            this.src = src;
        }
    }

    /** Replaces the CDN's /b=, /c=, /m=, /s= or /0 prefix with /o= (original file). */
    public static String originalImageUrl(String u) {
        if (u == null || u.isEmpty() || u.contains("/o=")) {
            return u;
        }
        Matcher m = SPEC.matcher(u);
        if (m.find()) {
            return u.substring(0, m.start()) + "/o=" + u.substring(m.end());
        }
        return u;
    }

    private static String bestVecImage(Object v) {
        List<Object> list = asList(v);
        String best = "";
        int bestW = -1;
        for (Object o : list) {
            Map<String, Object> m = asMap(o);
            String u = str(m.get("url"));
            int w = (int) lng(m.get("width"));
            if (!u.isEmpty() && w >= bestW) {
                best = u;
                bestW = w;
            }
        }
        return best;
    }

    /** Returns {url, rate}; prefers the highest bitrate variant. */
    private static String[] bestVideo(Object v) {
        List<Object> list = asList(v);
        String best = "";
        long bestRate = -1;
        long bestLevel = -1;
        for (Object o : list) {
            Map<String, Object> m = asMap(o);
            String u = str(m.get("playUrl"));
            if (u.isEmpty()) {
                continue;
            }
            long rate = lng(m.get("videoRate"));
            long level = lng(m.get("levelType"));
            if (rate > bestRate || (rate == bestRate && level > bestLevel)) {
                best = u;
                bestRate = rate;
                bestLevel = level;
            }
        }
        if (bestRate < 0) {
            bestRate = 0;
        }
        return new String[]{best, Long.toString(bestRate)};
    }

    private static String contentsText(Object v) {
        if (v instanceof String) {
            return (String) v;
        }
        Map<String, Object> m = asMap(v);
        if (m.isEmpty()) {
            return "";
        }
        StringBuilder b = new StringBuilder();
        for (Object o : asList(m.get("contents"))) {
            Map<String, Object> item = asMap(o);
            Map<String, Object> tc = asMap(item.get("text_content"));
            b.append(str(tc.get("text")));
        }
        return b.toString();
    }

    private static String first(String... vs) {
        for (String v : vs) {
            if (v != null && !v.isEmpty()) {
                return v;
            }
        }
        return "";
    }

    private static String truncate(String s, int n) {
        if (s == null) {
            return "";
        }
        s = s.trim();
        if (s.codePointCount(0, s.length()) <= n) {
            return s;
        }
        return s.substring(0, s.offsetByCodePoints(0, n));
    }

    private static String[] channelIds(Map<String, Object> fm) {
        String guild = "";
        String channel = "";
        Map<String, Object> ci = asMap(fm.get("channelInfo"));
        Map<String, Object> sign = asMap(ci.get("sign"));
        guild = str(sign.get("guild_id"));
        channel = str(sign.get("channel_id"));
        if (guild.isEmpty() || channel.isEmpty()) {
            Map<String, Object> share = asMap(fm.get("share"));
            Map<String, Object> csi = asMap(share.get("channelShareInfo"));
            Map<String, Object> cs = asMap(csi.get("channelSign"));
            guild = first(guild, str(cs.get("guild_id")));
            channel = first(channel, str(cs.get("channel_id")));
        }
        guild = first(guild, str(fm.get("guild_id")));
        channel = first(channel, str(fm.get("channel_id")));
        return new String[]{guild, channel};
    }

    public static String safeName(String s) {
        if (s == null) {
            return "x";
        }
        String out = s.replaceAll("[^A-Za-z0-9_-]", "_").replaceAll("^_+|_+$", "");
        if (out.isEmpty()) {
            return "x";
        }
        return out.length() > 100 ? out.substring(0, 100) : out;
    }

    private static String videoExt(String u) {
        String low = u.toLowerCase();
        int q = low.indexOf('?');
        if (q >= 0) {
            low = low.substring(0, q);
        }
        int h = low.indexOf('#');
        if (h >= 0) {
            low = low.substring(0, h);
        }
        for (String e : new String[]{".mp4", ".m4v", ".mov", ".webm", ".mkv"}) {
            if (low.endsWith(e)) {
                return e.substring(1);
            }
        }
        return "mp4";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o) {
        if (o instanceof Map) {
            return (Map<String, Object>) o;
        }
        return new java.util.LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object o) {
        if (o instanceof List) {
            return (List<Object>) o;
        }
        return new ArrayList<>();
    }

    private static String str(Object o) {
        if (o == null || JSONObject.NULL.equals(o)) {
            return "";
        }
        if (o instanceof String) {
            return (String) o;
        }
        if (o instanceof Number) {
            double d = ((Number) o).doubleValue();
            if (d == Math.rint(d) && Math.abs(d) < 9.0e15) {
                return Long.toString(((Number) o).longValue());
            }
        }
        return String.valueOf(o);
    }

    private static long lng(Object o) {
        if (o instanceof Number) {
            return ((Number) o).longValue();
        }
        if (o instanceof String) {
            try {
                return (long) Double.parseDouble((String) o);
            } catch (NumberFormatException ignored) {
            }
        }
        return 0;
    }

    private static boolean bool(Object o) {
        if (o instanceof Boolean) {
            return (Boolean) o;
        }
        if (o instanceof Number) {
            return ((Number) o).doubleValue() != 0;
        }
        if (o instanceof String) {
            return "true".equals(o) || "1".equals(o);
        }
        return false;
    }
}
