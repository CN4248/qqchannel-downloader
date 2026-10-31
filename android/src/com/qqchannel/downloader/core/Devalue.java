package com.qqchannel.downloader.core;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Decoder for Nuxt's devalue flat-array payload (__NUXT_DATA__). */
public final class Devalue {
    private final JSONArray arr;
    private final Map<Integer, Object> cache = new HashMap<>();

    private Devalue(JSONArray arr) {
        this.arr = arr;
    }

    public static Object decode(String json) throws JSONException {
        JSONArray arr = new JSONArray(new JSONTokener(json));
        if (arr.length() < 2) {
            throw new JSONException("__NUXT_DATA__ too short");
        }
        return new Devalue(arr).ref(1);
    }

    private Object ref(int i) {
        if (i < 0 || i >= arr.length()) {
            return null;
        }
        if (cache.containsKey(i)) {
            return cache.get(i);
        }
        Object x = arr.opt(i);
        if (x instanceof JSONObject) {
            Map<String, Object> m = new LinkedHashMap<>();
            cache.put(i, m);
            JSONObject o = (JSONObject) x;
            for (Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                m.put(k, value(o.opt(k)));
            }
            return m;
        }
        if (x instanceof JSONArray) {
            JSONArray t = (JSONArray) x;
            String marker = (t.length() > 0 && t.opt(0) instanceof String) ? (String) t.opt(0) : null;
            if (marker != null) {
                switch (marker) {
                    case "Reactive":
                    case "ShallowReactive":
                    case "Ref":
                    case "ShallowRef":
                    case "EmptyRef":
                    case "ShallowReactiveRef": {
                        if (t.length() > 1) {
                            Object v = ref(index(t.opt(1)));
                            cache.put(i, v);
                            return v;
                        }
                        return null;
                    }
                    case "Set": {
                        List<Object> l = new ArrayList<>();
                        cache.put(i, l);
                        for (int j = 1; j < t.length(); j++) {
                            l.add(value(t.opt(j)));
                        }
                        return l;
                    }
                    case "Map": {
                        Map<String, Object> m = new LinkedHashMap<>();
                        cache.put(i, m);
                        for (int j = 1; j + 1 < t.length(); j += 2) {
                            m.put(String.valueOf(value(t.opt(j))), value(t.opt(j + 1)));
                        }
                        return m;
                    }
                    case "Date":
                    case "BigInt":
                    case "RegExp":
                    case "URL":
                    case "Object": {
                        if (t.length() > 1) {
                            Object v = value(t.opt(1));
                            cache.put(i, v);
                            return v;
                        }
                        return null;
                    }
                    default:
                        break;
                }
            }
            List<Object> l = new ArrayList<>(t.length());
            cache.put(i, l);
            for (int j = 0; j < t.length(); j++) {
                l.add(value(t.opt(j)));
            }
            return l;
        }
        cache.put(i, x);
        return x;
    }

    private Object value(Object v) {
        if (v == null || JSONObject.NULL.equals(v)) {
            return null;
        }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (d >= 0 && d == Math.rint(d) && d <= Integer.MAX_VALUE) {
                return ref((int) d);
            }
        }
        return v;
    }

    private int index(Object v) {
        return v instanceof Number ? ((Number) v).intValue() : -1;
    }
}
