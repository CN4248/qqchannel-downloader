package com.qqchannel.downloader.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Minimal HTTP client with the browser headers QQ Channel expects. */
public final class Http {
    public static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    private Http() {
    }

    public static final class Response {
        public final int code;
        public final String body;
        public final String finalUrl;

        Response(int code, String body, String finalUrl) {
            this.code = code;
            this.body = body;
            this.finalUrl = finalUrl;
        }
    }

    public static Response get(String url, String cookie) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(30_000);
            c.setReadTimeout(120_000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
            c.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            c.setRequestProperty("Accept-Encoding", "identity");
            if (cookie != null && !cookie.isEmpty()) {
                c.setRequestProperty("Cookie", cookie);
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            byte[] data = readAll(in, 32 << 20);
            return new Response(code, new String(data, StandardCharsets.UTF_8), c.getURL().toString());
        } finally {
            c.disconnect();
        }
    }

    /** Fetches a post page, clearing EdgeOne's challenge cookie when present. */
    public static Response fetchPage(String url) throws IOException {
        String cookie = "";
        Response last = null;
        for (int attempt = 0; attempt < 6; attempt++) {
            Response r = get(url, cookie);
            last = r;
            if (r.body != null && r.body.contains("__NUXT_DATA__")) {
                return r;
            }
            String ck = EdgeOne.solve(r.body);
            if (ck == null) {
                throw new IOException("页面不含帖子数据（HTTP " + r.code + "，可能是帖子已删除或需要登录）");
            }
            cookie = ck;
        }
        throw new IOException("EdgeOne 验证未通过（" + (last == null ? "?" : last.code) + "）");
    }

    private static byte[] readAll(InputStream in, int limit) throws IOException {
        if (in == null) {
            return new byte[0];
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 16);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > limit) {
                    throw new IOException("HTTP response too large");
                }
            }
            return out.toByteArray();
        } finally {
            in.close();
        }
    }
}
