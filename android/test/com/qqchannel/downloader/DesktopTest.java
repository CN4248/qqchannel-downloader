package com.qqchannel.downloader;

import com.qqchannel.downloader.core.Downloader;
import com.qqchannel.downloader.core.Http;
import com.qqchannel.downloader.core.QqParser;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/** Desktop harness that exercises the exact parser/downloader code shipped in the APK. */
public final class DesktopTest {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: DesktopTest <url> <outdir>");
            System.exit(2);
        }
        String url = args[0];
        File out = new File(args[1]);
        if (!out.exists() && !out.mkdirs()) {
            throw new IOException("cannot create " + out);
        }
        System.out.println("==> " + url);
        Http.Response page = Http.fetchPage(url);
        QqParser.Feed feed = QqParser.parse(page.body);
        System.out.println("发帖者: " + feed.posterName + " (" + feed.posterId + ")");
        System.out.println("文章ID: " + feed.id);
        System.out.println("标题: " + feed.title);
        System.out.println("媒体: " + feed.imageCount + " 图 / " + feed.videoCount + " 视频");
        for (QqParser.Media m : feed.medias) {
            System.out.printf("  [%d/%d] %-5s %dx%d %s%s%n", m.seq, feed.medias.size(),
                    m.kind, m.width, m.height, m.name, m.ext.isEmpty() ? "" : "." + m.ext);
        }
        DirSink sink = new DirSink(out);
        Downloader d = new Downloader(new File(System.getProperty("java.io.tmpdir")), sink, 4,
                new Downloader.Listener() {
                    @Override
                    public void onResult(Downloader.Result r) {
                        if (r.error != null) {
                            System.out.println("  FAIL " + r.media.name + ": " + r.error);
                        } else {
                            System.out.println((r.skipped ? "  SKIP " : "  OK   ") + r.fileName
                                    + "  " + r.size + " B  md5=" + r.md5);
                        }
                    }
                });
        List<Downloader.Result> results = d.downloadAll(feed.medias);
        int ok = 0;
        int bad = 0;
        List<String> files = new ArrayList<>();
        for (Downloader.Result r : results) {
            if (r == null) {
                bad++;
            } else if (r.ok()) {
                ok++;
                files.add(r.fileName);
            } else {
                bad++;
            }
        }
        System.out.println("RESULT ok=" + ok + " failed=" + bad + " dir=" + out.getAbsolutePath());
        for (String f : files) {
            File file = new File(out, f);
            System.out.println("  " + f + " " + file.length() + " B");
        }
        if (bad > 0) {
            System.exit(1);
        }
    }

    static final class DirSink implements Downloader.Sink {
        private final File dir;

        DirSink(File dir) {
            this.dir = dir;
        }

        @Override
        public boolean exists(String baseName, long expectedSize) {
            File[] fs = dir.listFiles();
            if (fs == null) {
                return false;
            }
            for (File f : fs) {
                if (f.getName().startsWith(baseName + ".") && !f.getName().endsWith(".part")) {
                    if (expectedSize <= 0 || f.length() == expectedSize) {
                        return true;
                    }
                }
            }
            return false;
        }

        @Override
        public void save(File temp, String fileName) throws IOException {
            Files.move(temp.toPath(), new File(dir, fileName).toPath(),
                    StandardCopyOption.REPLACE_EXISTING);
        }

        @Override
        public String describe() {
            return dir.getAbsolutePath();
        }
    }
}
