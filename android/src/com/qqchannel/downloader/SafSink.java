package com.qqchannel.downloader;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import com.qqchannel.downloader.core.Downloader;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** Sink that writes into a user-selected folder through the Storage Access Framework. */
public final class SafSink implements Downloader.Sink {
    private final ContentResolver resolver;
    private final Uri treeUri;
    private final Uri parentUri;

    public SafSink(Context context, Uri treeUri) {
        this.resolver = context.getContentResolver();
        this.treeUri = treeUri;
        String docId = DocumentsContract.getTreeDocumentId(treeUri);
        this.parentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
    }

    @Override
    public boolean exists(String baseName, long expectedSize) {
        PathParts parts = splitPath(baseName);
        Uri dir;
        try {
            dir = resolveDir(parts.dir, false);
        } catch (Exception e) {
            return false;
        }
        if (dir == null) {
            return false;
        }
        Child child = findChildByPrefix(dir, parts.leaf + ".");
        return child != null && (expectedSize <= 0 || child.size == expectedSize);
    }

    @Override
    public void save(File temp, String fileName) throws IOException {
        PathParts parts = splitPath(fileName);
        Uri dir = resolveDir(parts.dir, true);
        if (dir == null) {
            throw new IOException("无法创建子目录: " + parts.dir);
        }
        String base = stripExt(parts.leaf);
        Child existing = findChildByPrefix(dir, base);
        if (existing != null) {
            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(existing.mime)) {
                throw new IOException("同名目录已存在，无法写入文件: " + parts.leaf);
            }
            try {
                DocumentsContract.deleteDocument(resolver, existing.uri);
            } catch (Exception ignored) {
            }
        }
        Uri doc = DocumentsContract.createDocument(resolver, dir, mimeOf(parts.leaf), parts.leaf);
        if (doc == null) {
            throw new IOException("无法在所选目录创建文件（目录可能只读）");
        }
        try (InputStream in = new FileInputStream(temp);
             OutputStream out = resolver.openOutputStream(doc, "w")) {
            if (out == null) {
                throw new IOException("无法写入所选目录");
            }
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        } catch (IOException e) {
            try {
                DocumentsContract.deleteDocument(resolver, doc);
            } catch (Exception ignored) {
            }
            throw e;
        }
    }

    @Override
    public String describe() {
        return treeUri.toString();
    }

    private Uri resolveDir(String path, boolean create) throws IOException {
        Uri current = parentUri;
        if (path == null || path.trim().isEmpty()) {
            return current;
        }
        for (String part : path.split("/")) {
            if (part.isEmpty()) {
                continue;
            }
            Child child = findChildExact(current, part);
            if (child != null) {
                if (!DocumentsContract.Document.MIME_TYPE_DIR.equals(child.mime)) {
                    throw new IOException("同名文件已存在，无法创建目录: " + part);
                }
                current = child.uri;
                continue;
            }
            if (!create) {
                return null;
            }
            Uri created = DocumentsContract.createDocument(
                    resolver, current, DocumentsContract.Document.MIME_TYPE_DIR, part);
            if (created == null) {
                throw new IOException("无法创建子目录: " + part);
            }
            current = created;
        }
        return current;
    }

    private Child findChildExact(Uri parent, String name) {
        return findChild(parent, name, false);
    }

    private Child findChildByPrefix(Uri parent, String prefix) {
        return findChild(parent, prefix, true);
    }

    private Child findChild(Uri parent, String name, boolean prefix) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
                treeUri, DocumentsContract.getDocumentId(parent));
        String[] cols = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor c = resolver.query(children, cols, null, null, null)) {
            if (c != null) {
                int idCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
                int nameCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                int sizeCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE);
                int mimeCol = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE);
                while (c.moveToNext()) {
                    String display = nameCol < 0 || c.isNull(nameCol) ? "" : c.getString(nameCol);
                    boolean match = prefix ? display.startsWith(name) : display.equals(name);
                    if (!match) {
                        continue;
                    }
                    String id = idCol < 0 ? null : c.getString(idCol);
                    if (id == null) {
                        continue;
                    }
                    Uri uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id);
                    long size = sizeCol < 0 || c.isNull(sizeCol) ? -1 : c.getLong(sizeCol);
                    String mime = mimeCol < 0 || c.isNull(mimeCol) ? "" : c.getString(mimeCol);
                    return new Child(uri, size, mime);
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static final class Child {
        final Uri uri;
        final long size;
        final String mime;

        Child(Uri uri, long size, String mime) {
            this.uri = uri;
            this.size = size;
            this.mime = mime;
        }
    }

    private static final class PathParts {
        final String dir;
        final String leaf;

        PathParts(String dir, String leaf) {
            this.dir = dir;
            this.leaf = leaf;
        }
    }

    private static PathParts splitPath(String path) {
        String p = path == null ? "" : path.trim();
        while (p.startsWith("/")) {
            p = p.substring(1);
        }
        int slash = p.lastIndexOf('/');
        if (slash < 0) {
            return new PathParts("", p);
        }
        return new PathParts(p.substring(0, slash), p.substring(slash + 1));
    }

    private static String stripExt(String name) {
        int i = name.lastIndexOf('.');
        return i > 0 ? name.substring(0, i) : name;
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".mov")) return "video/quicktime";
        return "application/octet-stream";
    }
}
