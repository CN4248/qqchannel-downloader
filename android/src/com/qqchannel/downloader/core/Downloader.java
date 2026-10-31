package com.qqchannel.downloader.core;

import android.graphics.BitmapFactory;
import com.qqchannel.downloader.core.QqParser.Media;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Concurrent, retrying downloader for the media list produced by QqParser. */
public final class Downloader {
    public interface Sink {
        /** True when a finished file with this base name and size already exists. */
        boolean exists(String baseName, long expectedSize);

        /** Persists the temporary file under the final display name. */
        void save(File temp, String fileName) throws IOException;

        String describe();
    }

    public interface Listener {
        void onResult(Result r);
    }

    public static final class Result {
        public final Media media;
        public String fileName = "";
        public long size;
        public boolean skipped;
        public String md5 = "";
        public String error;
        public String location = "";

        Result(Media m) {
            this.media = m;
        }

        public boolean ok() {
            return error == null;
        }
    }

    private final File tempDir;
    private final Sink sink;
    private final int jobs;
    private final Listener listener;
    private volatile boolean cancelled;
    private String nameTemplate = NameTemplate.DEFAULT;

    public Downloader(File tempDir, Sink sink, int jobs, Listener listener) {
        this.tempDir = tempDir;
        this.sink = sink;
        this.jobs = Math.max(1, Math.min(16, jobs));
        this.listener = listener;
    }

    public void setNameTemplate(String template) {
        this.nameTemplate = template == null || template.trim().isEmpty()
                ? NameTemplate.DEFAULT : template.trim();
    }

    public void cancel() {
        cancelled = true;
    }

    public List<Result> downloadAll(List<Media> medias) {
        if (!tempDir.exists() && !tempDir.mkdirs()) {
            List<Result> out = new ArrayList<>();
            for (Media m : medias) {
                Result r = new Result(m);
                r.error = "无法创建临时目录: " + tempDir;
                out.add(r);
                if (listener != null) {
                    listener.onResult(r);
                }
            }
            return out;
        }
        ExecutorService pool = Executors.newFixedThreadPool(jobs);
        List<Future<Result>> futures = new ArrayList<>();
        for (final Media m : medias) {
            futures.add(pool.submit(new Callable<Result>() {
                @Override
                public Result call() {
                    Result r = downloadOne(m);
                    if (listener != null) {
                        listener.onResult(r);
                    }
                    return r;
                }
            }));
        }
        List<Result> results = new ArrayList<>();
        for (Future<Result> f : futures) {
            try {
                results.add(f.get());
            } catch (Exception e) {
                results.add(null);
            }
        }
        pool.shutdown();
        try {
            pool.awaitTermination(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return results;
    }

    private Result downloadOne(Media m) {
        Result last = new Result(m);
        for (int attempt = 0; attempt < 3; attempt++) {
            if (cancelled) {
                last.error = "已取消";
                return last;
            }
            if (attempt > 0) {
                try {
                    Thread.sleep(1500L * attempt);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    last.error = "已取消";
                    return last;
                }
            }
            Result r = fetchOnce(m);
            if (r.ok()) {
                return r;
            }
            last = r;
        }
        return last;
    }

    private Result fetchOnce(Media m) {
        Result r = new Result(m);
        String baseName = NameTemplate.baseName(m, nameTemplate);
        if (!m.ext.isEmpty() && sink.exists(baseName, m.expectedSize)) {
            r.skipped = true;
            r.fileName = NameTemplate.fileName(m, nameTemplate, m.ext);
            r.location = sink.describe();
            return r;
        }
        HttpURLConnection c = null;
        File tmp = null;
        try {
            c = (HttpURLConnection) new URL(m.url).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(30_000);
            c.setReadTimeout(180_000);
            c.setRequestProperty("User-Agent", Http.UA);
            c.setRequestProperty("Referer", "https://pd.qq.com/");
            c.setRequestProperty("Accept", "*/*");
            c.setRequestProperty("Accept-Encoding", "identity");
            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new IOException("HTTP " + code);
            }
            long expectedHttp = c.getContentLengthLong();
            tmp = File.createTempFile("qqdl-", ".part", tempDir);
            MessageDigest digest = MessageDigest.getInstance("MD5");
            long total = 0;
            try (InputStream in = c.getInputStream();
                 OutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    digest.update(buf, 0, n);
                    total += n;
                    if (cancelled) {
                        throw new IOException("已取消");
                    }
                }
            }
            if (expectedHttp > 0 && total != expectedHttp) {
                throw new IOException("下载不完整: " + total + "/" + expectedHttp + " 字节");
            }
            if ("image".equals(m.kind) && m.width > 0 && m.height > 0) {
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(tmp.getAbsolutePath(), options);
                if (options.outWidth > 0 && options.outHeight > 0
                        && (options.outWidth < m.width || options.outHeight < m.height)) {
                    throw new IOException("图片尺寸 " + options.outWidth + "x" + options.outHeight
                            + " 小于页面标称 " + m.width + "x" + m.height + "，可能不是原图");
                }
            }
            String ext = m.ext.isEmpty() ? detectExt(tmp) : m.ext;
            String fileName = NameTemplate.fileName(m, nameTemplate, ext);
            sink.save(tmp, fileName);
            r.fileName = fileName;
            r.size = total;
            r.md5 = hex(digest.digest());
            r.location = sink.describe();
            return r;
        } catch (Exception e) {
            r.error = e.getMessage() == null ? e.toString() : e.getMessage();
            return r;
        } finally {
            if (c != null) {
                c.disconnect();
            }
            if (tmp != null) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        }
    }

    private static String detectExt(File f) throws IOException {
        byte[] b = new byte[16];
        int n;
        try (InputStream in = new FileInputStream(f)) {
            n = in.read(b);
        }
        if (n >= 3 && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8 && (b[2] & 0xFF) == 0xFF) {
            return "jpg";
        }
        if (n >= 8 && b[0] == (byte) 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
            return "png";
        }
        if (n >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F') {
            return "gif";
        }
        if (n >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
            return "webp";
        }
        if (n >= 12 && b[4] == 'f' && b[5] == 't' && b[6] == 'y' && b[7] == 'p') {
            return "mp4";
        }
        if (n >= 4 && b[0] == 0x1A && b[1] == 0x45 && b[2] == (byte) 0xDF && b[3] == (byte) 0xA3) {
            return "webm";
        }
        return "bin";
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) {
            s.append(Character.forDigit((x >> 4) & 0xF, 16));
            s.append(Character.forDigit(x & 0xF, 16));
        }
        return s.toString();
    }
}
