package com.qqchannel.downloader;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.qqchannel.downloader.core.Downloader;
import com.qqchannel.downloader.core.Http;
import com.qqchannel.downloader.core.NameTemplate;
import com.qqchannel.downloader.core.QqParser;

import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class MainActivity extends Activity {
    private static final int REQ_TREE = 1001;
    private static final String DEFAULT_URL =
            "https://pd.qq.com/g/605695554027767602/post/B_51a2d56ad69b05001441152189397568750X60";

    private EditText urlInput;
    private EditText nameInput;
    private TextView dirText;
    private TextView statusText;
    private TextView logText;
    private ProgressBar progress;
    private Button chooseBtn;
    private Button startBtn;
    private Uri treeUri;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        SharedPreferences sp = getSharedPreferences("qqdl", MODE_PRIVATE);
        urlInput.setText(sp.getString("urls", sp.getString("url", DEFAULT_URL)));
        nameInput.setText(sp.getString("nameTemplate", NameTemplate.DEFAULT));
        String saved = sp.getString("tree", null);
        if (saved != null) {
            try {
                treeUri = Uri.parse(saved);
            } catch (Exception ignored) {
            }
        }
        updateDirText();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(18), dp(20), dp(12));
        root.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("QQ频道 原图 / 视频下载器");
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.rgb(20, 20, 20));
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("批量下载帖子里的全部图片、GIF 和视频，保存完整原文件，并按“频道ID-文章ID-序号”命名；命名规则可自定义。");
        sub.setTextSize(13);
        sub.setTextColor(Color.rgb(100, 100, 100));
        sub.setPadding(0, dp(8), 0, dp(14));
        root.addView(sub);

        urlInput = new EditText(this);
        urlInput.setHint("粘贴 QQ频道帖子链接，例如 https://pd.qq.com/g/.../post/B_...");
        urlInput.setTextSize(14);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_VARIATION_URI
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        urlInput.setHorizontallyScrolling(false);
        urlInput.setMinLines(3);
        urlInput.setMaxLines(6);
        urlInput.setGravity(Gravity.TOP | Gravity.START);
        root.addView(urlInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        chooseBtn = new Button(this);
        chooseBtn.setText("选择保存目录");
        chooseBtn.setAllCaps(false);
        chooseBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                chooseDir();
            }
        });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = dp(10);
        root.addView(chooseBtn, bp);

        dirText = new TextView(this);
        dirText.setTextSize(12);
        dirText.setTextColor(Color.rgb(90, 90, 90));
        dirText.setPadding(0, dp(6), 0, dp(10));
        root.addView(dirText);

        TextView nameLabel = new TextView(this);
        nameLabel.setText("文件命名规则（扩展名自动追加）");
        nameLabel.setTextSize(12);
        nameLabel.setTextColor(Color.rgb(90, 90, 90));
        root.addView(nameLabel);

        nameInput = new EditText(this);
        nameInput.setSingleLine(true);
        nameInput.setTextSize(13);
        nameInput.setTypeface(Typeface.MONOSPACE);
        nameInput.setText(NameTemplate.DEFAULT);
        nameInput.setHint("<channel_id>-<post_id>-<order>");
        root.addView(nameInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView nameHint = new TextView(this);
        nameHint.setText("可用：" + NameTemplate.tokenHint()
                + "\n用 / 分目录，例如 <title>/<channel_id>-<post_id>-<order>");
        nameHint.setTextSize(10);
        nameHint.setTextColor(Color.rgb(120, 120, 120));
        nameHint.setPadding(0, 0, 0, dp(8));
        root.addView(nameHint);

        startBtn = new Button(this);
        startBtn.setText("开始下载");
        startBtn.setAllCaps(false);
        startBtn.setTextSize(16);
        startBtn.setTextColor(Color.WHITE);
        startBtn.setBackgroundColor(Color.rgb(0, 153, 255));
        startBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startDownload();
            }
        });
        root.addView(startBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(50)));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(6));
        pp.topMargin = dp(10);
        root.addView(progress, pp);

        statusText = new TextView(this);
        statusText.setTextSize(13);
        statusText.setTextColor(Color.rgb(40, 40, 40));
        statusText.setPadding(0, dp(8), 0, dp(8));
        statusText.setText("就绪");
        root.addView(statusText);

        ScrollView scroll = new ScrollView(this);
        logText = new TextView(this);
        logText.setTextSize(12);
        logText.setTypeface(Typeface.MONOSPACE);
        logText.setTextColor(Color.rgb(35, 35, 35));
        logText.setTextIsSelectable(true);
        scroll.addView(logText);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        root.addView(scroll, lp);

        setContentView(root);
    }

    private void chooseDir() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(i, REQ_TREE);
        } catch (Exception e) {
            toast("无法打开目录选择器: " + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_TREE && resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri u = data.getData();
            try {
                int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                getContentResolver().takePersistableUriPermission(u, flags);
            } catch (Exception ignored) {
            }
            treeUri = u;
            getSharedPreferences("qqdl", MODE_PRIVATE).edit().putString("tree", u.toString()).apply();
            updateDirText();
        }
    }

    private void updateDirText() {
        if (treeUri != null) {
            dirText.setText("保存到（自定义目录）: " + treeUri);
        } else {
            dirText.setText("保存到（默认目录）: " + defaultDir().getAbsolutePath()
                    + "\n可点“选择保存目录”换成任意文件夹");
        }
    }

    private File defaultDir() {
        File base = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (base == null) {
            base = getFilesDir();
        }
        return new File(base, "QQChannel");
    }

    private void startDownload() {
        final List<String> urls = splitUrls(urlInput.getText().toString());
        if (urls.isEmpty()) {
            toast("请先粘贴至少一个帖子链接");
            return;
        }
        for (String u : urls) {
            if (!u.startsWith("http://") && !u.startsWith("https://")) {
                toast("链接格式不正确: " + u);
                return;
            }
            if (!u.contains("pd.qq.com/")) {
                toast("只支持 pd.qq.com 的帖子链接: " + u);
                return;
            }
        }
        final String nameTemplate = nameInput.getText().toString().trim().isEmpty()
                ? NameTemplate.DEFAULT : nameInput.getText().toString().trim();
        String templateError = NameTemplate.validate(nameTemplate);
        if (!templateError.isEmpty()) {
            toast(templateError);
            nameInput.requestFocus();
            return;
        }
        getSharedPreferences("qqdl", MODE_PRIVATE).edit()
                .putString("urls", urlInput.getText().toString())
                .putString("nameTemplate", nameTemplate)
                .apply();
        Downloader.Sink selected;
        try {
            selected = treeUri != null ? new SafSink(this, treeUri) : new FileSink(defaultDir());
        } catch (Exception e) {
            toast("所选目录不可用，已改用默认目录: " + e.getMessage());
            treeUri = null;
            getSharedPreferences("qqdl", MODE_PRIVATE).edit().remove("tree").apply();
            updateDirText();
            selected = new FileSink(defaultDir());
        }
        final Downloader.Sink sink = selected;
        final File temp = new File(getCacheDir(), "downloads");
        //noinspection ResultOfMethodCallIgnored
        temp.mkdirs();

        startBtn.setEnabled(false);
        chooseBtn.setEnabled(false);
        progress.setVisibility(View.VISIBLE);
        logText.setText("");
        statusText.setText("正在解析 " + urls.size() + " 个帖子...");

        executor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final List<QqParser.Media> all = new ArrayList<>();
                    int goodLinks = 0;
                    int badLinks = 0;
                    for (int i = 0; i < urls.size(); i++) {
                        final String current = urls.get(i);
                        final int linkNo = i + 1;
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                statusText.setText("正在解析 " + linkNo + "/" + urls.size() + "...");
                                append("== 帖子 " + linkNo + "/" + urls.size() + ": " + current);
                            }
                        });
                        try {
                            Http.Response page = Http.fetchPage(current);
                            final QqParser.Feed feed = QqParser.parse(page.body);
                            all.addAll(feed.medias);
                            goodLinks++;
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    append("发帖者: " + feed.posterName + " (" + feed.posterId + ")");
                                    append("频道ID: " + (feed.guildId.isEmpty() ? "—" : feed.guildId)
                                            + "  子频道ID: " + (feed.channelId.isEmpty() ? "—" : feed.channelId));
                                    append("文章ID: " + feed.id);
                                    if (!feed.title.isEmpty()) {
                                        append("标题: " + feed.title);
                                    }
                                    append("媒体: " + feed.imageCount + " 张图片 / " + feed.videoCount
                                            + " 个视频，共 " + feed.medias.size() + " 个文件");
                                    append("");
                                }
                            });
                        } catch (final Exception e) {
                            badLinks++;
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    append("✗ 该链接解析失败: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
                                    append("");
                                }
                            });
                        }
                    }
                    if (all.isEmpty()) {
                        throw new Exception("所有链接都没有可下载的图片、GIF 或视频");
                    }
                    final int total = all.size();
                    final int fgoodLinks = goodLinks;
                    final int fbadLinks = badLinks;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            append("== 批量解析完成: " + fgoodLinks + "/" + urls.size()
                                    + " 个帖子可用，共 " + total + " 个文件");
                            append("保存位置: " + sink.describe());
                            append("");
                            statusText.setText("开始下载 " + total + " 个文件...");
                        }
                    });
                    final AtomicInteger done = new AtomicInteger();
                    Downloader d = new Downloader(temp, sink, 4, new Downloader.Listener() {
                        @Override
                        public void onResult(final Downloader.Result r) {
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    int n = done.incrementAndGet();
                                    if (r.error != null) {
                                        append("✗ [" + n + "/" + total + "] " + r.media.name + " : " + r.error);
                                    } else {
                                        append((r.skipped ? "= " : "✓ ") + "[" + n + "/" + total + "] "
                                                + r.fileName + "  " + human(r.size));
                                    }
                                    statusText.setText("下载中 " + n + "/" + total);
                                }
                            });
                        }
                    });
                    d.setNameTemplate(nameTemplate);
                    List<Downloader.Result> results = d.downloadAll(all);
                    int ok = 0;
                    int bad = 0;
                    for (Downloader.Result r : results) {
                        if (r != null && r.ok()) {
                            ok++;
                        } else {
                            bad++;
                        }
                    }
                    final int fok = ok;
                    final int fbad = bad;
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            progress.setVisibility(View.GONE);
                            startBtn.setEnabled(true);
                            chooseBtn.setEnabled(true);
                            String linkNote = fbadLinks > 0 ? " / 链接失败 " + fbadLinks : "";
                            statusText.setText("完成：成功 " + fok + " / 失败 " + fbad + linkNote);
                            append("");
                            append("全部完成：成功 " + fok + "，失败 " + fbad
                                    + (fbadLinks > 0 ? "，链接失败 " + fbadLinks : ""));
                            toast(fbad == 0 ? "下载完成，共 " + fok + " 个文件" : "完成，但有 " + fbad + " 个失败");
                        }
                    });
                } catch (final Exception e) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            progress.setVisibility(View.GONE);
                            startBtn.setEnabled(true);
                            chooseBtn.setEnabled(true);
                            statusText.setText("失败");
                            append("错误: " + (e.getMessage() == null ? e.toString() : e.getMessage()));
                            toast("下载失败，请检查链接或网络");
                        }
                    });
                }
            }
        });
    }

    private List<String> splitUrls(String raw) {
        Set<String> seen = new LinkedHashSet<>();
        List<String> out = new ArrayList<>();
        if (raw == null) return out;
        for (String line : raw.split("[\\r\\n,，]+")) {
            String u = line.trim();
            if (u.isEmpty()) continue;
            if (u.startsWith("B_")) {
                u = "https://pd.qq.com/post/" + u;
            } else if (!u.startsWith("http://") && !u.startsWith("https://")
                    && u.contains("pd.qq.com/")) {
                u = "https://" + u;
            }
            if (seen.add(u)) out.add(u);
        }
        return out;
    }

    private void append(String line) {
        logText.append(line + "\n");
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private static String human(long n) {
        if (n < 1024) {
            return n + " B";
        }
        double d = n;
        String[] u = {"KB", "MB", "GB", "TB"};
        int i = -1;
        while (d >= 1024 && i < u.length - 1) {
            d /= 1024;
            i++;
        }
        return String.format(java.util.Locale.US, "%.2f %s", d, u[i]);
    }
}
