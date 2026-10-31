package com.qqchannel.downloader.core;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Solves Tencent EdgeOne's cookie challenge without executing JavaScript. */
public final class EdgeOne {
    private static final Pattern FIELD = Pattern.compile("[A-Za-z_$][\\w$]*\\s*:\\s*(\\d{5,})");
    private static final Pattern SSID = Pattern.compile("\\(\\s*t\\s*,\\s*(\\d{5,})\\s*\\)");

    private EdgeOne() {
    }

    public static String solve(String body) {
        if (body == null || (!body.contains("__tst_status") && !body.contains("EO_Bot_Ssid"))) {
            return null;
        }
        List<Long> parts = new ArrayList<>();
        int start = body.indexOf("var e={");
        if (start >= 0) {
            String seg = body.substring(start);
            int end = seg.indexOf(",t=0");
            if (end > 0) {
                seg = seg.substring(0, end);
            }
            Matcher m = FIELD.matcher(seg);
            while (m.find()) {
                try {
                    parts.add(Long.parseLong(m.group(1)));
                } catch (NumberFormatException ignored) {
                }
            }
        }
        String ssid = "";
        Matcher sm = SSID.matcher(body);
        if (sm.find()) {
            ssid = sm.group(1);
        }
        if (parts.size() >= 3) {
            long sum = parts.get(0) + parts.get(1) + parts.get(2);
            return "__tst_status=" + sum + "#" + (ssid.isEmpty() ? "" : "; EO_Bot_Ssid=" + ssid);
        }
        return ssid.isEmpty() ? null : "EO_Bot_Ssid=" + ssid;
    }
}
