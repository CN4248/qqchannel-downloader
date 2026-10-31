#!/usr/bin/env bash
# Builds a signed, installable APK without Gradle, using only the Android SDK
# command-line tools and a JDK (>= 17).
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
JAVA_BIN="${JAVA_HOME:-/opt/jdk21}/bin"
export PATH="$JAVA_BIN:$PATH"
OUT="build"
KS="qqdl-debug.keystore"
KS_PASS="qqdl123456"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "[1/6] aapt2 compile"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"

echo "[2/6] aapt2 link"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest AndroidManifest.xml \
  "$OUT/res.zip" \
  --java "$OUT/gen" \
  --min-sdk-version 26 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 1.0

echo "[3/6] javac"
"$JAVA_BIN/javac" --release 8 -parameters -encoding UTF-8 -Xlint:-options -cp "$PLATFORM" \
  -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')

echo "[4/6] d8"
"$BT/d8" --release --min-api 26 --lib "$PLATFORM" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "[5/6] package dex"
python3 - "$OUT/base.apk" "$OUT/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo "[6/6] sign"
if [ ! -f "$KS" ]; then
  "$JAVA_BIN/keytool" -genkeypair -v \
    -keystore "$KS" -storetype PKCS12 \
    -alias qqdl -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=QQDL, OU=Dev, O=QQDL, L=CN, ST=CN, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-key-alias qqdl \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out ../dist/qqchannel-downloader.apk "$OUT/aligned.apk"

"$BT/apksigner" verify --print-certs ../dist/qqchannel-downloader.apk | head -5
ls -lh ../dist/qqchannel-downloader.apk
