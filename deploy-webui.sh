#!/bin/sh
# 一键构建并启动 QQ频道下载器 WebUI（Synology / Linux）
set -eu
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未找到 docker 命令。请在 Synology 的 Container Manager 中启动 Docker，或通过 SSH 使用 sudo。" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "错误：docker compose / docker-compose 均不可用。" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "错误：缺少 .env，请从 .env.example 复制并修改 DOWNLOAD_DIR。" >&2
  exit 1
fi

SAVE_DIR=$(sed -n 's/^DOWNLOAD_DIR=//p' .env | tail -n 1)
[ -n "$SAVE_DIR" ] || SAVE_DIR=./downloads
if ! mkdir -p "$SAVE_DIR"; then
  echo "错误：无法创建下载目录 $SAVE_DIR，请检查权限。" >&2
  exit 1
fi

PORT=$(sed -n 's/^WEB_PORT=//p' .env | tail -n 1)
[ -n "$PORT" ] || PORT=8765

echo "使用：$DC"
echo "项目目录：$(pwd)"
echo "下载目录：$SAVE_DIR"
echo "开始构建并启动（首次构建需要下载基础镜像，可能耗时几分钟）..."
$DC -f docker-compose.webui.yml up -d --build
echo
$DC -f docker-compose.webui.yml ps
echo
echo "完成。浏览器访问：http://<NAS局域网IP>:$PORT"
