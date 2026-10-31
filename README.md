# QQ频道图文 / 视频原文件下载器

把 QQ频道（pd.qq.com）图文帖里的**全部图片、GIF 和视频**按原文件下载到本地：
不使用缩略图、不转码、不缩放，并自动重命名。

默认文件名格式为：

```
<频道ID>-<文章ID>-<图片序号>.<扩展名>
```

例如（测试帖属于频道 `605695554027767602`）：

```
605695554027767602-B_51a2d56ad69b05001441152189397568750X60-1.jpg
605695554027767602-B_51a2d56ad69b05001441152189397568750X60-2.jpg
605695554027767602-B_51a2d56ad69b05001441152189397568750X60-3.jpg
```

命名规则在命令行、WebUI、Android 和油猴脚本里都可以自定义，支持
`<channel_id>`、`<post_id>`、`<order>`、`<poster_id>`、`<poster_name>`、
`<sub_channel_id>`、`<title>`、`<kind>`、`<ext>`、`<width>`、`<height>`，
也接受中文变量名（如 `<频道ID>`）。默认自动追加扩展名；只有模板里写了
`<ext>` 时才由模板决定扩展名位置。

模板里的字面 `/` 会创建子目录，例如
`<title>/<channel_id>-<post_id>-<order>` 会把文件保存到
`下载目录/每日偶玛/605695554027767602-B_...-1.jpg`。变量值里本身带的 `/`
会被替换成 `_`，不会跳出所选下载目录；`..` 等路径段也会被丢弃。

同一帖子内所有媒体统一从 1 连续编号（图片和视频共用序号）；
默认按帖子里的 `display_index` 排序，序号相同时图片排在视频前。

同一个程序提供**命令行**和**可视化 WebUI**两种用法：Windows 双击 exe 就会打开浏览器界面，
也可以继续用命令行；Android 是原生 GUI；Docker 同时提供命令行版和 WebUI 版。

## 交付产物

| 端 | 文件 | 说明 |
| --- | --- | --- |
| Windows | `dist/qqdl-windows-amd64.exe` | Windows 10/11 x64 单文件；**双击打开可视化界面**，也可命令行 |
| Linux | `dist/qqdl-linux-amd64` | 静态单文件；`--web` 打开可视化界面，也可命令行 |
| Android | `dist/qqchannel-downloader.apk` | Android 8.0+（minSdk 26），已签名可直接安装，原生 GUI |
| Docker（命令行） | `docker-compose.cli.yml` + `Dockerfile` | 一条命令构建并运行，下载目录挂载到宿主机 |
| Docker（WebUI） | `docker-compose.yml` + `Dockerfile` | 浏览器操作，服务常驻，端口/目录可配置 |
| 油猴脚本 | `userscript/qqdl.user.js` | Tampermonkey 页面脚本，帖子页一键下载并可选保存文件夹 |

所有端共用同一套解析和下载规则，输出文件名、原图选择、完整性校验完全一致。

## 功能

- **可视化 WebUI**：Windows 双击 exe 即开，Linux 运行 `--web`；粘贴链接、编辑保存目录、
  预览帖子里的全部图片/GIF/视频，点“开始下载”看实时进度和日志，可取消、可打开目录。
- **原图，不是预览图**：QQ频道页面里的 `picUrl` 默认指向 `/b=` 压缩规格；程序会把 CDN 路径段替换为 `/o=`，取回上传时的原始文件。GIF 也按原始字节下载，不转成静图。
- **一个不少**：按帖子数据里的全部 `images` 和 `videos` 生成任务，包括 GIF 和视频封面图；下载后校验 HTTP `Content-Length`，图片再校验实际像素尺寸不小于页面标称尺寸。
- **完整尺寸**：保留原始像素尺寸，不做任何缩放或转码。
- **自定义下载路径**：命令行 `-o`；WebUI 在页面上直接填目录；Android 端用系统目录选择器任选文件夹；Docker 端通过 `DOWNLOAD_DIR` 挂载宿主机目录；油猴脚本用浏览器目录选择器任选文件夹。
- **断点友好**：先写 `.part` 临时文件，成功后再改名；重复运行会跳过已存在且大小一致的文件，`--force` 可强制覆盖。
- **自动识别扩展名**：按文件头识别 jpg / png / gif / webp / mp4 / webm，不依赖 URL 后缀。
- **批量多链接**：一次粘贴多个帖子链接，统一解析、统一保存目录、统一命名规则，所有帖子的文件并发下载；某个链接失败不会中断其他链接。
- **并发下载**：默认 4 并发，可调；帖子较多时可用 `-p` 控制同时处理的链接数。
- **刷新不丢进度**：WebUI 会把当前任务 ID 存在浏览器本地，刷新页面后自动重新拉取任务状态，继续显示进度、日志和逐文件结果。
- **绕过 EdgeOne 挑战**：直接解析页面里的混淆脚本计算 `__tst_status`，不需要浏览器或登录。

## 使用

### 可视化 WebUI（推荐）

**Windows**：双击 `qqdl-windows-amd64.exe`，程序启动本地服务并自动打开浏览器。

**Linux**：

```bash
chmod +x qqdl-linux-amd64
./qqdl-linux-amd64 --web
```

浏览器会自动打开；服务器默认监听 `127.0.0.1` 的随机端口，只允许本机访问。
也可以固定端口、不自动开浏览器：

```bash
./qqdl-linux-amd64 --web -listen 127.0.0.1:8765 -no-browser
# 然后访问 http://127.0.0.1:8765
```

界面用法：在“帖子链接”框里每行粘贴一个链接（可一次粘多个）→ 点“解析全部” →
确认每个帖子的媒体数量和文件列表 → 填/选保存目录（默认 `downloads`）→
点“开始下载全部”。下载中可看总进度、每个帖子的媒体状态、成功/跳过/失败统计和逐文件日志，
可随时取消；完成后可点“打开目录”。某个链接解析失败时会单独标红，其他链接照常下载。
“文件命名规则”里写 `/` 会创建子目录，例如 `<title>/<channel_id>-<post_id>-<order>`。

刷新浏览器页面不会丢失当前任务：页面会从本地记录的任务 ID 重新读取 `/api/jobs/{id}`，继续显示进度、日志和逐文件结果；只有 WebUI 进程重启后任务才会丢失（任务本身在服务进程内存中）。

也可以直接带链接打开：`http://127.0.0.1:8765/?url=<URL 编码后的帖子链接>`，页面会自动解析。

### Windows（命令行）

```bat
qqdl-windows-amd64.exe -o "D:\QQ下载" "https://pd.qq.com/g/605695554027767602/post/B_51a2d56ad69b05001441152189397568750X60"
```

一次下载多个帖子（多个链接用空格分隔，`-p` 控制同时处理的帖子数）：

```bat
qqdl-windows-amd64.exe -o "D:\QQ下载" -p 3 "https://pd.qq.com/g/.../post/B_..." "https://pd.qq.com/g/.../post/B_..."
```

也可以直接把帖子链接粘贴到命令行。路径含空格或中文时用英文双引号包住。

### Linux（命令行）

```bash
chmod +x qqdl-linux-amd64
./qqdl-linux-amd64 -o ~/Downloads/qq "https://pd.qq.com/g/.../post/B_..."


# 多个帖子同时下载
./qqdl-linux-amd64 -o ~/Downloads/qq -p 3 "https://pd.qq.com/g/.../post/B_..." "https://pd.qq.com/g/.../post/B_..."
```

### Android

1. 安装 `qqchannel-downloader.apk`（需要允许“安装未知来源应用”）。
2. 打开 App，在输入框里粘贴一个或多个帖子链接（每行一个）。
3. 点“选择保存目录”，用系统文件选择器指定任意文件夹；不选则保存到 App 专属目录
   `/sdcard/Android/data/com.qqchannel.downloader/files/Download/QQChannel`。
4. 可在“文件命名规则”里修改模板（默认 `<channel_id>-<post_id>-<order>`，界面下方
   有全部变量提示；模板里写 `/` 会在所选目录下自动创建子文件夹），再点“开始下载”，
   界面会显示每个文件的进度和结果。

Android 端使用 Storage Access Framework 写入用户选择的目录，不需要存储权限；
下载期间请保持 App 在前台。

### 油猴脚本（Tampermonkey）

脚本完全在浏览器内运行，不需要 `qqdl` 终端、WebUI、Docker 或任何本地服务；只要浏览器能访问 `pd.qq.com` 和媒体 CDN 即可。

1. 安装 Tampermonkey，把 `userscript/qqdl.user.js` 添加为新脚本；
2. 打开 QQ频道帖子页，右下角出现「一键下载全部（N）」；
3. 首次点按钮后选择保存文件夹并允许写入；不选文件夹时会保存到浏览器默认下载目录（手机端通常使用这种方式）。
4. 需要批量时，在面板“额外帖子链接”里每行填一个链接，点“解析额外链接”，
   再点“开始下载全部”；当前帖子和额外帖子会一起下载。

脚本会取 `/o=` 原图、最高码率视频，按文件头识别扩展名，并保持
`<频道ID>-<文章ID>-<序号>.<扩展名>` 命名（面板中也可改成任意模板）。完整安装、路径授权说明和实测结果见
[userscript/README.md](userscript/README.md)。

### Docker Compose

> 当前目录下 `docker-compose.yml` 是 **WebUI 版**，方便 Container Manager 直接识别；
> 命令行一次性版是 `docker-compose.cli.yml`。

命令行版：

```bash
cp .env.example .env
# 编辑 .env：QQDL_URL=帖子链接，DOWNLOAD_DIR=宿主机保存目录
docker compose -f docker-compose.cli.yml up --build
```

下载完成后容器退出，文件出现在 `DOWNLOAD_DIR`。也可以临时指定链接和目录：

```bash
docker compose -f docker-compose.cli.yml run --rm qqdl -o /downloads -j 8 "https://pd.qq.com/g/.../post/B_..."
```

`docker-compose.cli.yml` 里已经把宿主机目录挂载到容器内 `/downloads`，所以
`-o /downloads` 写进去的文件会直接落到宿主机。这个 compose 是“下载完就退出”的一次性任务。

#### Docker 构建加速

默认 Dockerfile 使用国内镜像源，并在 `apk` 阶段使用阿里云 Alpine 镜像：

```env
GO_IMAGE=docker.m.daocloud.io/library/golang:1.22-alpine
ALPINE_IMAGE=docker.m.daocloud.io/library/alpine:3.20
ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
GOPROXY=https://goproxy.cn,direct
```

这些值都写在 `.env` 里，已经由 compose 的 `build.args` 传入。若 DaoCloud 在你的网络下仍慢，
可改成：

```env
GO_IMAGE=docker.1ms.run/library/golang:1.22-alpine
ALPINE_IMAGE=docker.1ms.run/library/alpine:3.20
```

或者改回官方源：

```env
GO_IMAGE=golang:1.22-alpine
ALPINE_IMAGE=alpine:3.20
```

改完后重新构建：

```bash
sudo docker compose build --no-cache
sudo docker compose up -d
```

#### Docker WebUI（常驻服务）

```bash
# 一键脚本（Synology/Linux，需 sudo）
sudo ./deploy-webui.sh

# 或手动
docker compose up -d --build
# 浏览器打开 http://localhost:8765
```

- 容器内监听 `0.0.0.0:8765`，宿主机端口由 `WEB_PORT` 控制（默认 8765）；
- 下载目录仍由 `DOWNLOAD_DIR` 挂载到容器 `/downloads`；
- 服务常驻，适合 NAS / 小主机；停止用 `docker compose down`。
- 也可以显式指定 `docker compose -f docker-compose.webui.yml up -d --build`。

> WebUI 没有登录鉴权，compose 会把端口发布到宿主机。只建议在局域网使用；若要公网访问，
> 必须在前面加反向代理和访问控制，不要直接暴露 8765。

## 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-o` | `downloads` | 输出目录，可写绝对路径或相对路径 |
| `-name` | `<channel_id>-<post_id>-<order>` | 自定义文件名模板，扩展名默认自动追加 |
| `-j` | `4` | 单个帖子内的并发下载数 |
| `-p` | `3` | 同时处理的帖子链接数（批量时） |
| `--dry-run` | 关 | 只解析并列出媒体清单，不下载 |
| `--force` | 关 | 已存在也重新下载并覆盖 |
| `--web` | 关 | 启动可视化 WebUI（不带任何参数时也默认启动） |
| `-listen` | `127.0.0.1:0` | WebUI 监听地址；`0` 表示随机端口 |
| `-no-browser` | 关 | WebUI 启动后不自动打开浏览器 |
| `-v` | 关 | 打印版本 |
| `-h` | - | 帮助 |

支持一次传多个链接；`-p` 控制同时解析/下载的帖子数（默认 3，最大 10）。
WebUI、Android、油猴面板也都支持一次添加多个链接。

## 原图与视频的取法

1. 请求帖子页 `https://pd.qq.com/g/{guild}/post/{feedId}`。
2. 若命中 EdgeOne 挑战页，从 `var e={...}` 中取三个数值求和，构造
   `__tst_status=<sum>#; EO_Bot_Ssid=<sid>` 后重试。
3. 从 HTML 的 `__NUXT_DATA__`（Nuxt devalue 扁平数组）解码出 `feed` 数据。
4. 图片：`picUrl` 中的 `/b=`、`/c=`、`/m=`、`/s=`、`/0=` 替换为 `/o=`；
   若没有规格段则原样使用。GIF 的 `picUrl` 本身通常已是 `/o=`。
5. 视频：在 `videos[].vecVideoUrl` 中选 `videoRate` 最大的一路（同码率取更高
   `levelType`），回退到 `videos[].playUrl`。
6. 下载后校验 HTTP `Content-Length`；图片用文件头确认格式，并解码校验实际像素
   尺寸不小于页面标称尺寸。`orig_size` 仅作提示，不作为失败依据。

> 说明：帖子 JSON 里的 `imageMD5` 和 `orig_size` 都可能过期/写错。实测有帖子
> 第五张图的 `orig_size` 写 51788 字节、`imageMD5` 也对不上，但 CDN 的 `/o=`
> 实际返回的是 254166 字节、1192×1192 的完整原图。因此程序不因这两个字段不符
> 而删除正确文件；改为校验真实像素尺寸，只有实际尺寸小于页面标称值才判失败。

## 构建

### 桌面端（Go）

```bash
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o dist/qqdl-windows-amd64.exe ./cmd/qqdl
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o dist/qqdl-linux-amd64 ./cmd/qqdl
```

### Android（无需 Gradle）

需要 JDK 17+ 与 Android SDK（platform 34、build-tools 34.0.0）：

```bash
export JAVA_HOME=/path/to/jdk
export ANDROID_SDK_ROOT=/path/to/android-sdk
cd android && ./build-apk.sh
```

脚本依次执行 aapt2 → javac → d8 → 打包 dex → zipalign → apksigner，
产物为 `dist/qqchannel-downloader.apk`。首次构建会在 `android/` 下生成调试签名
`qqdl-debug.keystore`（口令 `qqdl123456`），正式发布请替换为自己的密钥。

### Docker

```bash
# WebUI 版（默认 compose）
docker compose up -d --build

# 命令行一次性版
docker compose -f docker-compose.cli.yml run --rm qqdl -o /downloads "帖子链接"
```

## 实测记录

对以下公开帖子做过完整下载与尺寸核对：

| 帖子 | 媒体 | 结果 |
| --- | --- | --- |
| `B_51a2d56ad69b05001441152189397568750X60`（每日偶玛） | 3 图 | 75776 / 272363 / 176942 字节；640x913 / 1000x1917 / 1315x1920 |
| `B_937d3d667d0c02001441152186811359640X60`（NASA 黑洞） | 1 视频 + 1 封面 | 视频 1604052 字节 952x528；封面 149301 字节 600x338 |
| `B_ba59cb6a515a07001441152204654110990X60`（GIF 帖） | 3 图 + 1 GIF | 87042 / 1592614 / 1298912 / 1660627 字节；GIF 1103x1072，MD5 与帖子一致 |

同一测试帖在 Linux 命令行与 Android APK 上产出的 3 个文件逐字节相同
（MD5 `03ae87e3…` / `a85dccd1…` / `e7e2db51…`），尺寸与帖子 `orig_size` 完全一致。
默认文件名已验证为 `605695554027767602-B_51a2d56ad69b05001441152189397568750X60-1.jpg`
等；把 Android 模板改成 `<poster_name>_<order>.<ext>` 后，实际得到
`奇迹海_1.jpg` / `奇迹海_2.jpg` / `奇迹海_3.jpg`，大小不变。WebUI 与油猴脚本也做了
同样的默认/自定义模板实测。模板里带 `/` 的子目录也已实测：CLI、WebUI、油猴使用
`<title>/<channel_id>-<post_id>-<order>` 时，文件实际落盘为
`每日偶玛/605695554027767602-B_...-1.jpg` 等；Android 的文件写入层用同一模板通过
JVM 测试验证了子目录创建，SAF 子目录代码已编译进 APK。
Android APK 已在 Android 11 模拟器上实际安装、点击下载并核对文件；Android 批量输入
两个帖子（每日偶玛 + NASA 黑洞）后一次得到 5/5 个文件（3 图 + 1 视频 + 1 封面），
文件名为 `频道ID-文章ID-序号`，逐文件尺寸与单帖下载一致；截图见
[`docs/android-batch.png`](docs/android-batch.png)。Windows exe 与
Linux 版由同一份 Go 源码交叉编译。Linux 静态二进制在只含 CA 证书与 resolv.conf 的
最小 rootfs（chroot）中完整下载通过，等价于 alpine 容器的运行条件。重复运行会正确
跳过已下载文件。

WebUI 已在 Linux + Chromium 上实际操作：一次粘贴上面三个帖子链接，解析出
`3 个帖子 · 9 个文件`，点击“开始下载”后进度到 9/9、成功 9、失败 0，9 个文件与单帖下载
逐字节一致；界面截图见 [`docs/webui.png`](docs/webui.png)。

CLI 用 `-p 3` 同时处理这三个帖子同样得到 9/9；油猴脚本在页面面板的“额外帖子链接”
中加入另外两个帖子，批量结果也是 9/9。批量中混入一个失效链接时，失败链接会单独标红，
其余帖子照常下载。

## 限制

- 只能下载**公开可访问**的帖子；需要登录/入频道权限的帖子会解析失败。
- Windows 版双击会打开本地 WebUI；如果只想用命令行，请从 `cmd` 或 PowerShell 运行。
  WebUI 默认只监听 `127.0.0.1`，不会对局域网开放。
- Windows exe 在 Linux 环境交叉编译并校验了 PE 结构，本次未在真实 Windows 上运行；
  其解析/下载逻辑与已实测的 Linux 版完全同源。WebUI 的浏览器交互在 Linux + Chromium
  上实测通过。
- 部分杀毒软件可能对未签名的 Go 单文件 exe 误报，可自行校验 `SHA256SUMS.txt`。
- 视频取 QQ频道 CDN 实际提供的最高码率版本；CDN 未暴露的“更高原始档”无法凭空取得。
- EdgeOne 挑战脚本若大改，可能需要更新解析规则。
- 本次构建环境没有 Docker daemon，未实际执行 `docker compose up`；已通过 compose
  配置解析、release 包内源码重建、以及最小 rootfs 完整下载验证容器运行条件。
- Android 端未实现后台服务，批量下载时请保持 App 前台。
- 未实现 HLS（`.m3u8`）分片合并；QQ频道图文帖目前使用 MP4 直链。

## 免责声明

仅供下载自己有权保存的内容，用于个人备份。请遵守 QQ频道服务条款和著作权规定，
不要用于批量抓取、二次分发或商业用途。

## 目录结构

```
.
├── cmd/qqdl/                 # 命令行 + WebUI 入口
├── internal/qq/              # 解析、EdgeOne、下载核心
├── internal/webui/           # 可视化 WebUI（Go 服务 + 内嵌 HTML/CSS/JS）
├── android/                  # Android 工程（无 Gradle）
│   ├── src/                  # App 与共享 Java 核心
│   ├── res/                  # 图标与字符串
│   └── build-apk.sh
├── dist/                     # 各端产物
├── docs/                     # 实测截图
├── userscript/               # Tampermonkey 脚本
├── Dockerfile
├── docker-compose.yml        # WebUI 版 compose（默认，Container Manager 可识别）
├── docker-compose.webui.yml  # WebUI 版 compose（同内容，兼容旧命令）
├── docker-compose.cli.yml    # 命令行一次性下载 compose
├── deploy-webui.sh           # 一键构建并启动 WebUI（Synology）
└── README.md
```

## 任务记录持久化（1.0.1+）

- 任务历史写在 `data/jobs.json`；Docker 已把 `./data` 挂到 `/data`，并用 `-data /data` 启动。
- 重启后已完成/失败/取消任务全部保留；重启时仍在运行的任务标为失败（“服务重启导致任务中断”）。
- WebUI 增加“历史任务”面板，可回看、点开旧任务结果。
