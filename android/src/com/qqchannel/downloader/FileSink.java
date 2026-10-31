package com.qqchannel.downloader;

import com.qqchannel.downloader.core.Downloader;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** Sink for an ordinary, writable directory (the app-specific default folder). */
public final class FileSink implements Downloader.Sink {
    private final File dir;

    public FileSink(File dir) {
        this.dir = dir;
    }

    @Override
    public boolean exists(String baseName, long expectedSize) {
        File target = new File(dir, baseName);
        File parent = target.getParentFile();
        String leaf = target.getName();
        File[] fs = parent == null ? null : parent.listFiles();
        if (fs == null) {
            return false;
        }
        for (File f : fs) {
            if (f.getName().startsWith(leaf + ".") && !f.getName().endsWith(".part")) {
                if (expectedSize <= 0 || f.length() == expectedSize) {
                    return true;
                }
            }
        }
        return false;
    }

    @Override
    public void save(File temp, String fileName) throws IOException {
        File target = new File(dir, fileName);
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("无法创建目录: " + parent);
        }
        Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    @Override
    public String describe() {
        return dir.getAbsolutePath();
    }
}
