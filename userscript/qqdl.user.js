// ==UserScript==
// @name         QQ频道 原图 / 视频一键下载
// @namespace    https://pd.qq.com/
// @version      1.4.7
// @description  在 QQ频道图文帖子页一键下载全部原图、GIF 和视频，保持完整尺寸，按“频道ID-文章ID-序号”命名，命名规则可自定义；支持自选保存文件夹、模板 / 子目录和批量多链接。
// @author       qqdl
// @match        https://pd.qq.com/g/*/post/*
// @match        https://pd.qq.com/post/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      pd.qq.com
// @connect      channel.qpic.cn
// @connect      qchannelvideo.photo.qq.com
// @connect      qpic.cn
// @connect      qq.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.4.7';
  const HOST_ID = 'qqdl-userscript-host';
  const DB_NAME = 'qqdl-userscript';
  const DB_STORE = 'kv';
  const FAB_IDLE_TEXT = '一键下载全部';
  const DEFAULT_NAME_TEMPLATE = '<channel_id>-<post_id>-<order>';
  const NAME_ALIASES = {
    'channel_id': 'channel_id', '频道id': 'channel_id', '频道': 'channel_id',
    'guild_id': 'guild_id', 'guild': 'guild_id',
    'sub_channel_id': 'sub_channel_id', '子频道id': 'sub_channel_id', '子频道': 'sub_channel_id',
    'post_id': 'post_id', 'feed_id': 'post_id', '文章id': 'post_id', '文章': 'post_id',
    'order': 'order', 'seq': 'order', '图片序号': 'order', '序号': 'order',
    'poster_id': 'poster_id', '作者id': 'poster_id', '作者': 'poster_id',
    'poster_name': 'poster_name', '作者名': 'poster_name',
    'title': 'title', '标题': 'title',
    'kind': 'kind', '类型': 'kind',
    'ext': 'ext', 'extension': 'ext', '扩展名': 'ext',
    'width': 'width', '宽度': 'width', 'height': 'height', '高度': 'height'
  };
  const NAME_VARIABLES = '<channel_id> 频道ID · <post_id> 文章ID · <order> 序号 · ' +
    '<poster_id> 发帖者ID · <poster_name> 昵称 · <sub_channel_id> 子频道ID · ' +
    '<title> 标题 · <kind> 类型 · <ext> 扩展名 · <width> 宽 · <height> 高';

  const SPECIAL_TAGS = new Set([
    'Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef',
    'ShallowReactiveRef', 'Set', 'Map', 'Date', 'BigInt', 'RegExp', 'URL', 'Object'
  ]);

  const state = {
    feed: null,
    feeds: [],
    extraFeeds: [],
    media: [],
    dirHandle: null,
    dirPermission: 'unknown',
    running: false,
    cancel: false,
    skip: true,
    nameTemplate: DEFAULT_NAME_TEMPLATE,
    done: 0,
    feedToken: 0,
    uiReady: false
  };

  let shadow = null;
  let ui = {};
  let toastTimer = 0;
  let dbPromise = null;

  /* ------------------------------------------------------------------ *
   * Nuxt devalue decoding
   * ------------------------------------------------------------------ */

  function decodeNuxtText(text) {
    const arr = JSON.parse(String(text));
    if (!Array.isArray(arr) || !arr.length) throw new Error('页面数据格式不正确');
    const memo = new Map();

    function special(index, raw) {
      const tag = raw[0];
      const value = raw[1];
      switch (tag) {
        case 'Reactive':
        case 'ShallowReactive':
        case 'ShallowReactiveRef':
        case 'Ref':
        case 'ShallowRef':
        case 'EmptyRef':
          return hydrate(value);
        case 'Set': {
          const out = new Set();
          memo.set(index, out);
          const items = hydrate(value);
          if (Array.isArray(items)) items.forEach(function (x) { out.add(x); });
          return out;
        }
        case 'Map': {
          const out = new Map();
          memo.set(index, out);
          const entries = hydrate(value);
          if (Array.isArray(entries)) {
            entries.forEach(function (pair) {
              if (Array.isArray(pair) && pair.length >= 2) out.set(pair[0], pair[1]);
            });
          }
          return out;
        }
        case 'Date': {
          const v = hydrate(value);
          return new Date(typeof v === 'number' ? v : String(v));
        }
        case 'BigInt':
          return String(hydrate(value));
        case 'RegExp': {
          const v = hydrate(value);
          if (Array.isArray(v)) return new RegExp(v[0], v[1]);
          return new RegExp(String(v));
        }
        case 'URL':
          return new URL(String(hydrate(value)));
        case 'Object':
          return hydrate(value);
        default:
          return hydrate(value);
      }
    }

    function hydrate(index) {
      if (typeof index !== 'number') return index;
      if (index < 0) {
        if (index === -1) return undefined;
        if (index === -2) return NaN;
        if (index === -3) return Infinity;
        if (index === -4) return -Infinity;
        if (index === -5) return -0;
        return null;
      }
      if (memo.has(index)) return memo.get(index);
      if (index >= arr.length) return null;
      const raw = arr[index];

      if (raw === null || typeof raw !== 'object') {
        memo.set(index, raw);
        return raw;
      }

      if (Array.isArray(raw)) {
        if (raw.length === 2 && typeof raw[0] === 'string' && SPECIAL_TAGS.has(raw[0])) {
          const out = special(index, raw);
          memo.set(index, out);
          return out;
        }
        const out = [];
        memo.set(index, out);
        raw.forEach(function (item) { out.push(hydrate(item)); });
        return out;
      }

      const out = {};
      memo.set(index, out);
      Object.keys(raw).forEach(function (key) {
        out[key] = hydrate(raw[key]);
      });
      return out;
    }

    const root = arr.length > 1 && arr[1] && typeof arr[1] === 'object' ? hydrate(1) : hydrate(0);
    return root;
  }

  function looksLikeFeed(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value instanceof Map || value instanceof Set) return false;
    const hasId = value.id || value.feed_id || value.feedId;
    const hasMedia = Array.isArray(value.images) || Array.isArray(value.videos);
    return !!(hasId && (hasMedia || value.poster));
  }

  function feedScore(feed) {
    const images = Array.isArray(feed.images) ? feed.images.length : 0;
    const videos = Array.isArray(feed.videos) ? feed.videos.length : 0;
    return images + videos * 2 + (feed.poster ? 1 : 0);
  }

  function findPostFeed(root) {
    let best = null;
    const seen = new Set();

    function walk(value, depth) {
      if (!value || typeof value !== 'object' || depth > 12) return;
      if (value instanceof Map || value instanceof Set) return;
      if (seen.has(value)) return;
      seen.add(value);

      if (!Array.isArray(value) && looksLikeFeed(value)) {
        if (!best || feedScore(value) > feedScore(best)) best = value;
      }

      if (Array.isArray(value)) {
        value.forEach(function (item) { walk(item, depth + 1); });
        return;
      }

      if (value.feed) walk(value.feed, depth + 1);
      if (value.data) walk(value.data, depth + 1);
      Object.keys(value).forEach(function (key) {
        if (key === 'feed' || key === 'data') return;
        const child = value[key];
        if (child && typeof child === 'object') walk(child, depth + 1);
      });
    }

    walk(root, 0);
    return best;
  }

  function parseFeedFromNuxtText(text) {
    const root = decodeNuxtText(text);
    const feed = findPostFeed(root);
    if (!feed) throw new Error('页面中没有找到帖子数据');
    return feed;
  }

  function parseFeedFromHtml(html) {
    const source = String(html || '');
    let match = source.match(/<script[^>]*\bid=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) {
      match = source.match(/<script[^>]*\bdata-nuxt-data=["']nuxt-app["'][^>]*>([\s\S]*?)<\/script>/i);
    }
    if (!match) throw new Error('页面中没有 __NUXT_DATA__');
    return parseFeedFromNuxtText(match[1]);
  }

  /* ------------------------------------------------------------------ *
   * Feed -> media model
   * ------------------------------------------------------------------ */

  function toStringValue(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function firstNonEmpty() {
    for (let i = 0; i < arguments.length; i++) {
      const value = arguments[i];
      if (value !== null && value !== undefined && String(value) !== '') return String(value);
    }
    return '';
  }

  function toInt(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }

  function currentPostId() {
    try {
      const match = String(location.pathname || '').match(/\/post\/([^/?#]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (error) {
      return '';
    }
  }

  function feedIdOf(feed) {
    return firstNonEmpty(feed.id, feed.feed_id, feed.feedId, currentPostId(), 'unknown');
  }

  function posterOf(feed) {
    const poster = feed.poster && typeof feed.poster === 'object' ? feed.poster : {};
    const id = firstNonEmpty(poster.id, poster.str_tiny_id, poster.tiny_id, poster.uin, feed.poster_id, '0');
    const nick = firstNonEmpty(poster.nick, poster.nickname, poster.name, '未知发帖者');
    return { id: id, nick: nick };
  }

  function channelOf(feed) {
    const info = feed && feed.channelInfo && typeof feed.channelInfo === 'object' ? feed.channelInfo : {};
    const sign = info.sign && typeof info.sign === 'object' ? info.sign : {};
    const share = feed && feed.share && typeof feed.share === 'object' ? feed.share : {};
    const shareInfo = share.channelShareInfo && typeof share.channelShareInfo === 'object' ? share.channelShareInfo : {};
    const shareSign = shareInfo.channelSign && typeof shareInfo.channelSign === 'object' ? shareInfo.channelSign : {};
    const guildId = firstNonEmpty(sign.guild_id, sign.guildId, shareSign.guild_id, shareSign.guildId,
      feed.guild_id, feed.guildId, '');
    const subChannelId = firstNonEmpty(sign.channel_id, sign.channelId, shareSign.channel_id,
      shareSign.channelId, feed.channel_id, feed.channelId, '');
    return { guildId: guildId, subChannelId: subChannelId };
  }

  function contentsText(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) {
      return value.map(contentsText).join('');
    }
    if (value.text_content && typeof value.text_content === 'object') {
      return toStringValue(value.text_content.text);
    }
    if (value.text_content && typeof value.text_content === 'string') {
      return value.text_content;
    }
    if (Array.isArray(value.contents)) {
      return value.contents.map(contentsText).join('');
    }
    return '';
  }

  function feedTitle(feed) {
    let title = contentsText(feed.title);
    if (!title) title = contentsText(feed.contents);
    if (!title) title = toStringValue(feed.summary);
    return title.trim().slice(0, 120);
  }

  function originalImageUrl(url) {
    return String(url || '').replace(/\/(?:b|c|m|s|0)=/g, '/o=');
  }

  function extFromUrl(url) {
    const match = String(url || '').match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    if (!match) return '';
    let ext = match[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    return ['jpg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mov', 'm4v'].indexOf(ext) >= 0 ? ext : '';
  }

  function pickImageUrl(image) {
    const direct = firstNonEmpty(image.picUrl, image.pic_url);
    if (direct) return originalImageUrl(direct);

    const variants = Array.isArray(image.vecImageUrl) ? image.vecImageUrl.slice()
      : (image.vecImageUrl && typeof image.vecImageUrl === 'object' ? Object.values(image.vecImageUrl) : []);
    variants.sort(function (a, b) {
      return toInt(b && (b.width || b.w)) - toInt(a && (a.width || a.w));
    });
    for (let i = 0; i < variants.length; i++) {
      const item = variants[i] || {};
      const url = firstNonEmpty(item.url, item.picUrl, item.pic_url);
      if (url) return originalImageUrl(url);
    }
    const layer = firstNonEmpty(image.layerPicUrl, image.layer_pic_url);
    return layer ? originalImageUrl(layer) : '';
  }

  function pickVideoUrl(video) {
    const variants = Array.isArray(video.vecVideoUrl) ? video.vecVideoUrl.slice()
      : (video.vecVideoUrl && typeof video.vecVideoUrl === 'object' ? Object.values(video.vecVideoUrl) : []);
    variants.sort(function (a, b) {
      const rateA = toInt(a && (a.videoRate !== undefined ? a.videoRate : a.video_rate));
      const rateB = toInt(b && (b.videoRate !== undefined ? b.videoRate : b.video_rate));
      if (rateB !== rateA) return rateB - rateA;
      return toInt(b && (b.levelType !== undefined ? b.levelType : b.level_type)) -
        toInt(a && (a.levelType !== undefined ? a.levelType : a.level_type));
    });
    for (let i = 0; i < variants.length; i++) {
      const item = variants[i] || {};
      const url = firstNonEmpty(item.playUrl, item.play_url, item.url);
      if (url) return url;
    }
    return firstNonEmpty(video.playUrl, video.play_url, video.url);
  }

  function sanitizeName(name) {
    let out = String(name || '')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!out) out = 'file';
    return out.slice(0, 180);
  }

  function canonicalToken(raw) {
    const key = String(raw || '').trim().toLowerCase();
    return NAME_ALIASES[key] || '';
  }

  function tokenValue(media, canonical, ext) {
    switch (canonical) {
      case 'channel_id': return media.channelId || media.guildId || media.subChannelId || media.posterId || 'channel';
      case 'guild_id': return media.guildId || media.channelId || '';
      case 'sub_channel_id': return media.subChannelId || '';
      case 'post_id': return media.postId || media.feedId || '';
      case 'order': return String(media.order || media.seq || 0);
      case 'poster_id': return media.posterId || '';
      case 'poster_name': return media.posterName || '';
      case 'title': return media.title || (state.feed && feedTitle(state.feed)) || '';
      case 'kind': return media.kind || '';
      case 'ext': return ext || '';
      case 'width': return String(media.width || '');
      case 'height': return String(media.height || '');
      default: return '';
    }
  }

  function templateHasExt(tpl) {
    let found = false;
    String(tpl || '').replace(/<([^<>]+)>/g, function (_, inner) {
      if (canonicalToken(inner) === 'ext') found = true;
      return '';
    });
    return found;
  }

  function sanitizeSegment(name) {
    let out = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
    out = out.replace(/[ .]+$/, '');
    if (!out || out === '.' || out === '..') return '';
    return Array.from(out).slice(0, 180).join('');
  }

  function renderName(media, tpl, extOverride) {
    const template = String(tpl || '').trim() || DEFAULT_NAME_TEMPLATE;
    const ext = extOverride === undefined ? (media.ext || '') : String(extOverride || '');
    const hadExt = templateHasExt(template);
    // 模板里字面量 "/" 用来分目录；变量值里的 "/" 会被清洗成 "_"，
    // 所以标题无法跳出用户选择的下载目录。
    const segments = [];
    template.split('/').forEach(function (part) {
      const rendered = part.replace(/<([^<>]+)>/g, function (_, inner) {
        const canonical = canonicalToken(inner);
        return canonical ? tokenValue(media, canonical, ext) : '_';
      });
      const safe = sanitizeSegment(rendered);
      if (safe) segments.push(safe);
    });
    if (!segments.length) segments.push('file');
    if (!hadExt && ext) segments[segments.length - 1] += '.' + ext;
    return segments.join('/');
  }

  function splitRelativePath(name) {
    const p = String(name || '').replace(/^\/+|\/+$/g, '');
    const i = p.lastIndexOf('/');
    return i < 0 ? { dir: '', leaf: p } : { dir: p.slice(0, i), leaf: p.slice(i + 1) };
  }

  function leafName(name) {
    return splitRelativePath(name).leaf || 'file';
  }

  function validateNameTemplate(tpl) {
    const bad = [];
    String(tpl || '').replace(/<([^<>]+)>/g, function (_, inner) {
      if (!canonicalToken(inner)) bad.push('<' + inner.trim() + '>');
      return '';
    });
    return bad.length ? '未知命名变量 ' + bad.join('、') + '；可用变量：' + NAME_VARIABLES : '';
  }

  function sanitizeSubdir(input) {
    return String(input || '')
      .split(/[\\/]+/)
      .map(function (segment) {
        let value = segment
          .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
          .replace(/^\.+$/, '_')
          .trim()
          .replace(/[. ]+$/g, '');
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = '_' + value;
        return value.slice(0, 60);
      })
      .filter(Boolean)
      .slice(0, 4)
      .join('/')
      .slice(0, 180);
  }

  function withExt(name, ext) {
    const cleanExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const base = String(name || 'file').replace(/\.[^./\\]+$/, '');
    return base + '.' + cleanExt;
  }

  function buildMedia(feed) {
    const poster = posterOf(feed);
    const feedId = feedIdOf(feed);
    const channel = channelOf(feed);
    const title = feedTitle(feed);
    const items = [];
    const images = Array.isArray(feed.images) ? feed.images : [];
    const videos = Array.isArray(feed.videos) ? feed.videos : [];

    images.forEach(function (image, index) {
      if (!image || typeof image !== 'object') return;
      const url = pickImageUrl(image);
      if (!url) return;
      const isGif = !!(image.is_gif || image.isGif);
      const ext = extFromUrl(url) || (isGif ? 'gif' : 'jpg');
      items.push({
        kind: isGif ? 'gif' : 'image',
        order: 0,
        sourceIndex: index,
        sortIndex: Object.prototype.hasOwnProperty.call(image, 'display_index') ? toInt(image.display_index) : index + 1,
        width: toInt(image.width),
        height: toInt(image.height),
        size: toInt(image.orig_size || image.origin_size || image.file_size),
        url: url,
        ext: ext
      });
    });

    videos.forEach(function (video, index) {
      if (!video || typeof video !== 'object') return;
      const url = pickVideoUrl(video);
      if (!url) return;
      items.push({
        kind: 'video',
        order: 1,
        sourceIndex: index,
        sortIndex: Object.prototype.hasOwnProperty.call(video, 'display_index') ? toInt(video.display_index) : index + 1,
        width: toInt(video.width),
        height: toInt(video.height),
        size: 0,
        url: url,
        ext: extFromUrl(url) || 'mp4'
      });
    });

    items.sort(function (a, b) {
      if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex;
      if (a.order !== b.order) return a.order - b.order;
      return a.sourceIndex - b.sourceIndex;
    });

    items.forEach(function (item, index) {
      item.seq = index + 1;
      item.order = item.seq;
      item.feedId = feedId;
      item.postId = feedId;
      item.posterId = poster.id;
      item.posterName = poster.nick;
      item.title = title;
      item.guildId = channel.guildId;
      item.subChannelId = channel.subChannelId;
      item.channelId = channel.guildId || channel.subChannelId || poster.id || 'channel';
      item.name = renderName(item, DEFAULT_NAME_TEMPLATE, item.ext);
      item.mime = item.ext === 'mp4' ? 'video/mp4' : (item.ext === 'webm' ? 'video/webm' : '');
    });

    return items;
  }

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function friendlyError(error) {
    const message = String((error && (error.message || error.error || error.details)) || error || '未知错误');
    if (/AbortError|aborted/i.test(message)) return '已取消';
    if (/NotAllowedError|Permission denied|permission/i.test(message)) return '没有文件夹写入权限';
    if (/QuotaExceededError|quota/i.test(message)) return '磁盘空间不足';
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return '网络错误，可尝试关闭代理/VPN 后重试';
    return message.slice(0, 100);
  }

  function directoryPicker() {
    try {
      const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
      if (pageWindow && typeof pageWindow.showDirectoryPicker === 'function') {
        return pageWindow.showDirectoryPicker.bind(pageWindow);
      }
    } catch (error) {
      /* 某些管理器不暴露 unsafeWindow，退回普通 window */
    }
    if (typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function') {
      return window.showDirectoryPicker.bind(window);
    }
    return null;
  }

  function supportsFileSystem() {
    return !!directoryPicker();
  }

  function getSetting(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function setSetting(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (error) { /* ignore */ }
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('indexedDB 不可用'));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('indexedDB 打开失败')); };
    });
    return dbPromise;
  }

  async function idbSet(key, value) {
    const db = await openDb();
    await new Promise(function (resolve, reject) {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return await new Promise(function (resolve, reject) {
      const tx = db.transaction(DB_STORE, 'readonly');
      const request = tx.objectStore(DB_STORE).get(key);
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /* ------------------------------------------------------------------ *
   * Network (GM_xhr avoids the image CDN's missing CORS headers)
   * ------------------------------------------------------------------ */

  function toArrayBuffer(value) {
    if (!value) return null;
    // Some userscript managers / browser sandboxes return the payload as a
    // binary string (or an ArrayBuffer from another realm) even when
    // responseType is "arraybuffer". Handle all of these shapes so the
    // standalone script works without a local proxy.
    if (typeof value === 'string') {
      const bytes = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
      return bytes.buffer;
    }
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    if (typeof value.byteLength === 'number' && typeof value.slice === 'function') {
      return value.slice(0);
    }
    return null;
  }

  function gmGet(url, onProgress) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          responseType: 'blob',
          binary: true,
          timeout: 180000,
          headers: { 'Accept': '*/*', 'Referer': 'https://pd.qq.com/' },
          onprogress: function (event) {
            if (onProgress) {
              onProgress({
                loaded: event && event.loaded ? event.loaded : 0,
                total: event && event.total ? event.total : 0,
                lengthComputable: !!(event && event.lengthComputable)
              });
            }
          },
          onload: async function (response) {
            try {
              if (!(response.status >= 200 && response.status < 300)) {
                throw new Error('HTTP ' + response.status);
              }
              let buffer = response.response;
              if (!buffer && typeof response.responseText === 'string') buffer = response.responseText;
              const fromString = typeof buffer === 'string';
              if (buffer && typeof buffer.arrayBuffer === 'function' &&
                  Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') {
                buffer = await buffer.arrayBuffer();
              }
              buffer = toArrayBuffer(buffer);
              const expected = parseInt(headerValue(response.responseHeaders, 'content-length'), 10);
              const encoded = headerValue(response.responseHeaders, 'content-encoding');
              if (buffer && expected > 0 && !encoded && buffer.byteLength !== expected) {
                throw new Error('响应字节数不完整（收到 ' + buffer.byteLength + ' / 应为 ' + expected + '）');
              }
              if (!buffer) {
                const kind = Object.prototype.toString.call(buffer);
                throw new Error('服务器返回的不是二进制数据（' + kind + '）');
              }
              resolve({ buffer: buffer, headers: String(response.responseHeaders || ''), fromString: fromString });
            } catch (error) {
              reject(error);
            }
          },
          onerror: function () { reject(new Error('网络请求失败')); },
          ontimeout: function () { reject(new Error('网络请求超时')); }
        });
        return;
      }

      if (typeof fetch === 'function') {
        fetch(url, { credentials: 'omit', mode: 'cors' })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.arrayBuffer();
          })
          .then(function (buffer) { resolve({ buffer: buffer, headers: '' }); })
          .catch(function (error) {
            reject(new Error('CORS/网络错误：' + (error && error.message ? error.message : error)));
          });
        return;
      }

      reject(new Error('当前脚本管理器不支持 GM_xmlhttpRequest'));
    });
  }

  // Binary-safe getter for folder mode. Some managers corrupt blob payloads;
  // requesting an ArrayBuffer with a byte-preserving MIME avoids UTF-8 decoding.
  function gmGetBinarySafe(url, onProgress) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前脚本管理器不支持 GM_xmlhttpRequest'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        binary: true,
        overrideMimeType: 'text/plain; charset=x-user-defined',
        timeout: 180000,
        headers: { 'Accept': '*/*', 'Referer': 'https://pd.qq.com/' },
        onprogress: function (event) {
          if (onProgress) {
            onProgress({
              loaded: event && event.loaded ? event.loaded : 0,
              total: event && event.total ? event.total : 0,
              lengthComputable: !!(event && event.lengthComputable)
            });
          }
        },
        onload: async function (response) {
          try {
            if (!(response.status >= 200 && response.status < 300)) {
              throw new Error('HTTP ' + response.status);
            }
            let raw = response.response;
            if (!raw && typeof response.responseText === 'string') raw = response.responseText;
            let buffer = raw;
            if (typeof buffer === 'string') {
              buffer = toArrayBuffer(buffer);
            } else if (buffer && typeof buffer.arrayBuffer === 'function' &&
                Object.prototype.toString.call(buffer) !== '[object ArrayBuffer]') {
              buffer = await buffer.arrayBuffer();
            }
            buffer = toArrayBuffer(buffer);
            if (!buffer) throw new Error('服务器返回的不是二进制数据');
            const expected = parseInt(headerValue(response.responseHeaders, 'content-length'), 10);
            const encoded = headerValue(response.responseHeaders, 'content-encoding');
            if (expected > 0 && !encoded && buffer.byteLength !== expected) {
              throw new Error('响应字节数不完整（收到 ' + buffer.byteLength + ' / 应为 ' + expected + '）');
            }
            resolve({
              buffer: buffer,
              headers: String(response.responseHeaders || ''),
              fromString: typeof raw === 'string'
            });
          } catch (error) {
            reject(error);
          }
        },
        onerror: function () { reject(new Error('网络请求失败')); },
        ontimeout: function () { reject(new Error('网络请求超时')); }
      });
    });
  }

  async function fetchPageText(url) {
    // The userscript runs on pd.qq.com, so a normal same-origin fetch carries
    // the login/EdgeOne cookies. Fall back to GM_xhr if the page fetch fails.
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (response.ok) {
        const text = await response.text();
        if (text && text.length > 5000) return text;
      }
    } catch (error) { /* try GM_xhr below */ }
    const result = await gmGet(url);
    return new TextDecoder('utf-8').decode(new Uint8Array(result.buffer));
  }

  function normalizeExtraUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    if (/^B_/i.test(u)) u = 'https://pd.qq.com/post/' + u;
    else if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const parsed = new URL(u);
      if (parsed.hostname !== 'pd.qq.com') return '';
      return parsed.href;
    } catch (error) {
      return '';
    }
  }

  function rebuildMedia() {
    const feeds = [state.feed].concat(state.extraFeeds || []).filter(Boolean);
    state.feeds = feeds;
    state.media = [];
    feeds.forEach(function (feed) {
      try { state.media = state.media.concat(buildMedia(feed)); } catch (error) { /* skip broken feed */ }
    });
  }

  async function parseExtraFeeds(showLog) {
    if (!ui.extraUrls) return true;
    const raw = ui.extraUrls.value || '';
    const current = currentPostId();
    const urls = [];
    const seen = new Set();
    raw.split(/[\r\n,，]+/).forEach(function (line) {
      const u = normalizeExtraUrl(line);
      if (!u || seen.has(u)) return;
      if (current && u.indexOf(current) >= 0) return;
      seen.add(u);
      urls.push(u);
    });
    if (!urls.length) {
      state.extraFeeds = [];
      rebuildMedia();
      refreshFab();
      refreshPanel();
      return true;
    }
    if (ui.parseExtra) { ui.parseExtra.disabled = true; ui.parseExtra.textContent = '解析中…'; }
    if (ui.start) ui.start.disabled = true;
    state.extraFeeds = [];
    const currentId = state.feed ? feedIdOf(state.feed) : '';
    for (let i = 0; i < urls.length; i++) {
      if (showLog) log('解析额外链接 ' + (i + 1) + '/' + urls.length + '：' + urls[i], 'info');
      try {
        const text = await fetchPageText(urls[i]);
        const feed = parseFeedFromHtml(text);
        if (!feed) throw new Error('没有读取到帖子数据');
        const id = feedIdOf(feed);
        if (id && id === currentId) continue;
        state.extraFeeds.push(feed);
        if (showLog) {
          const count = buildMedia(feed).length;
          log('✓ ' + (feedTitle(feed) || id || urls[i]) + ' · ' + count + ' 个文件', 'ok');
        }
      } catch (error) {
        if (showLog) log('✗ ' + urls[i] + '：' + friendlyError(error), 'err');
      }
    }
    rebuildMedia();
    if (ui.parseExtra) { ui.parseExtra.disabled = false; ui.parseExtra.textContent = '解析额外链接'; }
    refreshFab();
    refreshPanel();
    return true;
  }

  function headerValue(headers, name) {
    const lines = String(headers || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].indexOf(':');
      if (at < 0) continue;
      if (lines[i].slice(0, at).trim().toLowerCase() === name.toLowerCase()) {
        return lines[i].slice(at + 1).trim();
      }
    }
    return '';
  }

  function extFromMime(mime) {
    const value = String(mime || '').toLowerCase();
    if (value.indexOf('image/jpeg') === 0) return 'jpg';
    if (value.indexOf('image/png') === 0) return 'png';
    if (value.indexOf('image/gif') === 0) return 'gif';
    if (value.indexOf('image/webp') === 0) return 'webp';
    if (value.indexOf('image/avif') === 0) return 'avif';
    if (value.indexOf('video/mp4') === 0) return 'mp4';
    if (value.indexOf('video/webm') === 0) return 'webm';
    return '';
  }

  function probeContentType(url) {
    return new Promise(function (resolve) {
      if (typeof GM_xmlhttpRequest !== 'function') { resolve(''); return; }
      let settled = false;
      let request = null;
      function done(mime) {
        if (settled) return;
        settled = true;
        resolve(String(mime || ''));
        try { if (request && typeof request.abort === 'function') request.abort(); } catch (error) { /* ignore */ }
      }
      request = GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        binary: true,
        timeout: 15000,
        headers: { 'Accept': '*/*', 'Referer': 'https://pd.qq.com/' },
        onheadersreceived: function (response) {
          done(headerValue(response && response.responseHeaders, 'content-type'));
        },
        onload: function (response) {
          done(headerValue(response && response.responseHeaders, 'content-type'));
        },
        onerror: function () { done(''); },
        ontimeout: function () { done(''); }
      });
    });
  }

  async function fetchBuffer(media, onProgress) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await gmGetBinarySafe(media.url, onProgress);
        if (!result.buffer || !result.buffer.byteLength) {
          throw new Error('服务器返回空文件');
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(400 * attempt);
      }
    }
    throw lastError || new Error('下载失败');
  }

  function sniffExt(buffer) {
    if (!buffer) return '';
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpg';
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
      if (brand === 'avif' || brand === 'avis') return 'avif';
      return 'mp4';
    }
    if (bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) return 'webm';
    return '';
  }

  function imageComplete(buffer, ext) {
    if (!buffer) return false;
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!b.length) return false;
    if (ext === 'jpg') {
      if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8 || b[2] !== 0xFF) return false;
      const end = Math.max(0, b.length - 4096);
      for (let i = b.length - 2; i >= end; i--) {
        if (b[i] === 0xFF && b[i + 1] === 0xD9) return true;
      }
      return false;
    }
    if (ext === 'png') {
      if (b.length < 20 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4E || b[3] !== 0x47) return false;
      const tail = String.fromCharCode.apply(null, Array.prototype.slice.call(b, Math.max(0, b.length - 32)));
      return tail.indexOf('IEND') >= 0;
    }
    if (ext === 'gif') {
      return b.length > 8 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[b.length - 1] === 0x3B;
    }
    if (ext === 'webp') {
      if (b.length < 12) return false;
      const size = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
      return size + 8 <= b.length + 1;
    }
    return true; // AVIF/其它容器交给浏览器判断
  }

  function mediaExtForBuffer(media, buffer) {
    const detected = sniffExt(buffer);
    if (!detected) {
      throw new Error('服务器返回的内容不是有效图片/视频（可能被 CDN 拦截或需要登录）');
    }
    const imageExts = ['jpg', 'png', 'gif', 'webp', 'avif'];
    if (media.kind === 'image' && imageExts.indexOf(detected) < 0) {
      throw new Error('服务器返回的是 ' + detected + '，不是有效图片');
    }
    if (media.kind === 'video' && detected !== 'mp4' && detected !== 'webm') {
      throw new Error('服务器返回的是 ' + detected + '，不是有效视频');
    }
    return detected;
  }

  function mimeFor(ext) {
    const map = {
      jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4'
    };
    return map[ext] || 'application/octet-stream';
  }

  /* ------------------------------------------------------------------ *
   * File System Access API
   * ------------------------------------------------------------------ */

  async function ensurePermission(handle) {
    try {
      if (!handle) return false;
      if (typeof handle.queryPermission !== 'function') return true;
      const options = { mode: 'readwrite' };
      let permission = await handle.queryPermission(options);
      if (permission === 'granted') return true;
      if (permission === 'prompt') {
        if (typeof handle.requestPermission !== 'function') return false;
        permission = await handle.requestPermission(options);
        return permission === 'granted';
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  async function resolveDir(root, subdir) {
    let dir = root;
    const parts = String(subdir || '').split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    return dir;
  }

  async function existingSize(dir, name) {
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return file.size;
    } catch (error) {
      return -1;
    }
  }

  async function resolvePath(root, path, create) {
    let dir = root;
    const parts = String(path || '').split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
    }
    return dir;
  }

  async function findExisting(dir, name) {
    const parts = splitRelativePath(name);
    let parent;
    try {
      parent = await resolvePath(dir, parts.dir, false);
    } catch (error) {
      return { size: -1, name: name };
    }
    const exts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm'];
    for (let i = 0; i < exts.length; i++) {
      const candidate = String(parts.leaf).replace(/[ .]+$/, '') + '.' + exts[i];
      const size = await existingSize(parent, candidate);
      if (size >= 0) {
        return { size: size, name: (parts.dir ? parts.dir + '/' : '') + candidate };
      }
    }
    return { size: -1, name: name };
  }

  async function writeBuffer(dir, name, buffer, mime) {
    const parts = splitRelativePath(name);
    const parent = await resolvePath(dir, parts.dir, true);
    const fileHandle = await parent.getFileHandle(parts.leaf, { create: true });
    if (typeof fileHandle.createWritable !== 'function') {
      throw new Error('浏览器不支持写入文件夹');
    }
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(buffer);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (ignored) { /* ignore */ }
      throw error;
    }
  }

  function decodeImageSize(buffer) {
    if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
    return Promise.race([
      createImageBitmap(new Blob([buffer])).then(function (bitmap) {
        const size = { width: bitmap.width, height: bitmap.height };
        if (typeof bitmap.close === 'function') bitmap.close();
        return size;
      }).catch(function () { return null; }),
      new Promise(function (resolve) {
        setTimeout(function () { resolve(null); }, 4000);
      })
    ]);
  }

  async function validateImageBuffer(media, buffer) {
    if (media.kind !== 'image' || !media.width || !media.height) return;
    const actual = await decodeImageSize(buffer);
    if (!actual) {
      log('⚠ ' + renderName(media, state.nameTemplate, '') + ' 无法读取图片尺寸，已按原文件保存', 'warn');
      return;
    }
    if (actual.width < media.width || actual.height < media.height) {
      log('⚠ 页面标称 ' + media.width + 'x' + media.height + '，实际图片 ' +
        actual.width + 'x' + actual.height + '；页面尺寸字段不可靠，按实际原文件保存', 'warn');
    }
    if (media.size > 0 && buffer.byteLength !== media.size) {
      log('⚠ 页面元数据大小 ' + media.size + ' 字节，实际文件 ' + buffer.byteLength +
        ' 字节；尺寸 ' + actual.width + 'x' + actual.height +
        ' 与页面一致，按完整原图保存（原大小字段不可靠）', 'warn');
    }
  }

  /* ------------------------------------------------------------------ *
   * Download fallback (browser default download folder)
   * ------------------------------------------------------------------ */

  function gmDownload(url, name) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_download !== 'function') {
        reject(new Error('当前脚本管理器不支持 GM_download'));
        return;
      }
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('下载超时（180 秒）'));
      }, 180000);

      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const detail = (error && (error.error || error.details || error.message)) || '下载失败';
        reject(new Error(String(detail)));
      }

      try {
        GM_download({
          url: url,
          name: name,
          saveAs: false,
          onload: done,
          onerror: fail,
          ontimeout: function () { fail(new Error('下载超时')); }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  function saveBlob(buffer, name, mime) {
    return new Promise(function (resolve, reject) {
      try {
        const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = name;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        setTimeout(function () {
          anchor.remove();
          URL.revokeObjectURL(blobUrl);
        }, 60000);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  function updateRowName(message, finalName) {
    try {
      const row = message && message.closest ? message.closest('.logLine') : null;
      const nameEl = row && row.querySelector('.logName');
      if (nameEl) nameEl.textContent = finalName;
    } catch (error) {
      /* 仅影响展示 */
    }
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  const UI_HTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.fab{position:fixed;right:22px;bottom:22px;z-index:2147483646;display:flex;align-items:center;gap:9px;',
    'height:54px;padding:0 22px;border:0;border-radius:27px;cursor:pointer;color:#fff;',
    'background:linear-gradient(135deg,#1677ff 0%,#00a6ff 100%);font:600 15px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'box-shadow:0 10px 28px rgba(22,119,255,.38);transition:transform .16s ease,box-shadow .16s ease,opacity .16s ease}',
    '.fab:hover{transform:translateY(-2px);box-shadow:0 14px 34px rgba(22,119,255,.46)}',
    '.fab:active{transform:translateY(0)}',
    '.fab:disabled{cursor:default;opacity:.6;transform:none;box-shadow:0 8px 20px rgba(15,23,42,.18);background:#94a3b8}',
    '.fabIcon{font-size:18px;line-height:1}',
    '.backdrop{position:fixed;inset:0;z-index:2147483645;background:rgba(15,23,42,.46);backdrop-filter:blur(2px)}',
    '.panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;',
    'width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 44px);overflow:auto;padding:22px;border-radius:18px;',
    'background:#fff;color:#0f172a;box-shadow:0 28px 80px rgba(2,8,23,.42);',
    'font:14px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-right:2px}',
    '.title{font-size:19px;font-weight:700;letter-spacing:.2px}',
    '.sub{margin-top:3px;font-size:12px;color:#64748b;word-break:break-all}',
    '.iconBtn{flex:0 0 auto;width:30px;height:30px;border:0;border-radius:9px;background:#f1f5f9;color:#475569;font-size:20px;line-height:1;cursor:pointer}',
    '.iconBtn:hover{background:#e2e8f0}',
    '.stats{margin-top:14px;padding:9px 12px;border-radius:10px;background:#eff6ff;color:#1d4ed8;font-size:13px;font-weight:600}',
    '.files{margin-top:10px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}',
    '.fileRow{display:flex;align-items:center;gap:9px;padding:7px 11px;border-bottom:1px solid #f1f5f9;font-size:12px}',
    '.fileRow:last-child{border-bottom:0}',
    '.idx{flex:0 0 22px;color:#94a3b8;text-align:right}',
    '.fname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#334155}',
    '.fsize{flex:0 0 auto;color:#94a3b8}',
    '.more{padding:6px 11px;font-size:12px;color:#64748b;background:#f8fafc}',
    '.pathBox{margin-top:14px;padding:11px 12px;border:1px solid #e2e8f0;border-radius:11px;background:#f8fafc}',
    '.path{display:flex;align-items:flex-start;gap:8px;margin-top:8px;font-size:12px;color:#475569;word-break:break-all}',
    '.pathBadge{flex:0 0 auto;padding:1px 7px;border-radius:999px;background:#e0f2fe;color:#0369a1;font-size:11px;font-weight:600}',
    '.field{display:block;margin-top:13px;font-size:12px;color:#475569}',
    '.field input,.field textarea{margin-top:6px;width:100%;height:38px;padding:0 11px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#0f172a;font:13px system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;outline:none}',
    '.field textarea{height:64px;padding:8px 11px;resize:vertical;line-height:1.5}',
    '.field input:focus,.field textarea:focus{border-color:#1677ff;box-shadow:0 0 0 3px rgba(22,119,255,.12)}',
    '.check{display:flex;align-items:center;gap:7px;margin-top:10px;font-size:12px;color:#475569;cursor:pointer}',
    '.check input{width:15px;height:15px;accent-color:#1677ff}',
    '.actions{display:flex;align-items:center;gap:9px;margin-top:15px}',
    'button.primary{flex:1 1 auto;height:42px;border:0;border-radius:10px;background:#1677ff;color:#fff;font:600 14px system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer}',
    'button.primary:hover{background:#0f6ae8}',
    'button.primary:disabled{cursor:default;background:#bfdbfe;color:#eff6ff}',
    'button.ghost{height:38px;padding:0 14px;border:1px solid #cbd5e1;border-radius:9px;background:#fff;color:#334155;font:500 12px system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer}',
    'button.ghost:hover{background:#f8fafc;border-color:#94a3b8}',
    'button.ghost:disabled{opacity:.55;cursor:default}',
    '.progressWrap{margin-top:14px;padding:11px 12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0}',
    '.bar{height:7px;border-radius:999px;background:#e2e8f0;overflow:hidden}',
    '.bar i{display:block;width:0;height:100%;border-radius:999px;background:linear-gradient(90deg,#1677ff,#00b6ff);transition:width .2s ease}',
    '.progressText{margin-top:6px;font-size:12px;color:#475569}',
    '.log{margin-top:12px;max-height:190px;overflow:auto;border-top:1px solid #f1f5f9;padding-top:8px;font-size:12px}',
    '.logLine{display:flex;align-items:flex-start;gap:8px;padding:4px 0;word-break:break-all;color:#475569}',
    '.logLine .logName{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:#334155}',
    '.logLine .logMsg{flex:0 0 auto;max-width:52%;text-align:right;color:#64748b}',
    '.logLine.ok .logMsg{color:#15803d}',
    '.logLine.err .logMsg{color:#b91c1c}',
    '.logLine.skip .logMsg{color:#b45309}',
    '.logLine.warn .logMsg{color:#b45309}',
    '.logLine.info{display:block;color:#64748b}',
    '.logLine.ok.info{color:#15803d}',
    '.logLine.err.info{color:#b91c1c}',
    '.hint{margin-top:12px;font-size:11.5px;line-height:1.6;color:#94a3b8}',
    '.ver{font-size:11px;font-weight:500;color:#94a3b8;margin-left:6px}\n.nameVars{margin-top:6px;font-size:11px;line-height:1.55;color:#94a3b8;word-break:break-word}',
    '.toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;max-width:calc(100vw - 32px);',
    'padding:9px 14px;border-radius:9px;background:rgba(15,23,42,.92);color:#fff;font:12px system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 10px 30px rgba(2,8,23,.3)}',
    '[hidden]{display:none!important}',
    '@media (max-width:640px){.panel{width:calc(100vw - 20px);max-height:calc(100vh - 24px);padding:16px;border-radius:14px}.fab{right:14px;bottom:14px;height:50px;padding:0 18px;font-size:14px}}',
    '</style>',
    '<button class="fab" id="fab" type="button" title="一键下载本帖全部原图、GIF 和视频">',
    '  <span class="fabIcon">⬇</span><span id="fabText">读取帖子中…</span>',
    '</button>',
    '<div class="backdrop" id="backdrop" hidden></div>',
    '<section class="panel" id="panel" role="dialog" aria-modal="true" aria-label="QQ频道原文件下载" hidden>',
    '  <div class="head">',
    '    <div><div class="title">QQ频道 原文件下载 <span class="ver" id="ver"></span></div><div class="sub" id="feedSub">正在读取帖子…</div></div>',
    '    <button class="iconBtn" id="close" type="button" title="关闭" aria-label="关闭">×</button>',
    '  </div>',
    '  <div class="stats" id="stats">正在解析…</div>',
    '  <div class="files" id="files" hidden></div>',
    '  <div class="pathBox">',
    '    <button class="ghost" id="pick" type="button">选择保存文件夹</button>',
    '    <button class="ghost" id="defaultDir" type="button" style="margin-left:8px" hidden>默认下载目录</button>',
    '    <div class="path" id="pathLabel"><span class="pathBadge">保存到</span><span id="pathText">浏览器默认下载目录</span></div>',
    '  </div>',
    '  <label class="field">子目录（可选，留空则直接保存到所选文件夹）',
    '    <input id="subdir" type="text" maxlength="120" autocomplete="off" spellcheck="false" placeholder="例如：每日偶玛；多级用 / 分隔">',
    '  </label>',
    '  <label class="field">额外帖子链接（可选，每行一个，批量下载）',
    '    <textarea id="extraUrls" rows="2" autocomplete="off" spellcheck="false" placeholder="粘贴其他帖子链接，可与当前文章一起下载"></textarea>',
    '  </label>',
    '  <button class="ghost" id="parseExtra" type="button" style="margin-top:6px">解析额外链接</button>',
    '  <label class="field">文件命名规则（扩展名自动追加，用 / 分目录）',
    '    <input id="nameTemplate" type="text" maxlength="180" autocomplete="off" spellcheck="false" placeholder="<channel_id>-<post_id>-<order>">',
    '  </label>',
    '  <div class="nameVars" id="nameVars"></div>',
    '  <label class="check"><input type="checkbox" id="skip" checked> 跳过已存在且大小一致的文件</label>',
    '  <div class="actions">',
    '    <button class="primary" id="start" type="button">开始下载全部</button>',
    '    <button class="ghost" id="cancel" type="button" hidden>取消</button>',
    '  </div>',
    '  <div class="progressWrap" id="progressWrap" hidden>',
    '    <div class="bar"><i id="bar"></i></div>',
    '    <div class="progressText" id="progressText"></div>',
    '  </div>',
    '  <div class="log" id="log"></div>',
    '  <div class="hint" id="hint"></div>',
    '  <div class="toast" id="toast" hidden></div>',
    '</section>'
  ].join('\n');

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (host) {
      if (!host.shadowRoot) host.attachShadow({ mode: 'open' });
      return host;
    }
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(host);
    host.attachShadow({ mode: 'open' });
    return host;
  }

  function q(id) {
    return shadow ? shadow.getElementById(id) : null;
  }

  function initUI() {
    if (state.uiReady) return;
    const host = ensureHost();
    shadow = host.shadowRoot;
    shadow.innerHTML = UI_HTML;

    ui = {
      fab: q('fab'), fabText: q('fabText'),
      backdrop: q('backdrop'), panel: q('panel'), close: q('close'),
      feedSub: q('feedSub'), stats: q('stats'), files: q('files'),
      pick: q('pick'), defaultDir: q('defaultDir'), pathText: q('pathText'), subdir: q('subdir'),
      extraUrls: q('extraUrls'), parseExtra: q('parseExtra'),
      nameTemplate: q('nameTemplate'), nameVars: q('nameVars'),
      skip: q('skip'), start: q('start'), cancel: q('cancel'),
      progressWrap: q('progressWrap'), bar: q('bar'), progressText: q('progressText'),
      log: q('log'), hint: q('hint'), toast: q('toast')
    };

    state.uiReady = true;
    state.skip = getSetting('qqdl-skip', '1') !== '0';
    ui.skip.checked = state.skip;
    state.nameTemplate = getSetting('qqdl-name-template', DEFAULT_NAME_TEMPLATE) || DEFAULT_NAME_TEMPLATE;
    ui.nameTemplate.value = state.nameTemplate;
    ui.nameVars.textContent = '可用变量：' + NAME_VARIABLES;

    ui.fab.addEventListener('click', onFabClick);
    ui.pick.addEventListener('click', pickFolder);
    if (ui.defaultDir) ui.defaultDir.addEventListener('click', useDefaultDir);
    ui.start.addEventListener('click', startDownload);
    ui.cancel.addEventListener('click', cancelDownload);
    ui.close.addEventListener('click', hidePanel);
    ui.backdrop.addEventListener('click', function () { hidePanel(); });
    ui.subdir.addEventListener('input', refreshPath);
    ui.nameTemplate.addEventListener('input', function () {
      state.nameTemplate = ui.nameTemplate.value.trim() || DEFAULT_NAME_TEMPLATE;
      setSetting('qqdl-name-template', state.nameTemplate);
      const error = validateNameTemplate(state.nameTemplate);
      ui.nameVars.textContent = error || ('可用变量：' + NAME_VARIABLES);
      ui.nameVars.style.color = error ? '#d14343' : '';
      refreshPanel();
    });
    if (ui.extraUrls) {
      ui.extraUrls.value = getSetting('qqdl-extra-urls', '') || '';
      ui.extraUrls.addEventListener('input', function () {
        setSetting('qqdl-extra-urls', ui.extraUrls.value);
      });
    }
    if (ui.parseExtra) ui.parseExtra.addEventListener('click', function () { parseExtraFeeds(true); });
    ui.skip.addEventListener('change', function () {
      state.skip = !!ui.skip.checked;
      setSetting('qqdl-skip', state.skip ? '1' : '0');
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && ui.panel && !ui.panel.hidden) hidePanel();
    });

    if (!supportsFileSystem()) {
      ui.pick.disabled = true;
      ui.pick.textContent = '浏览器默认下载（独立运行）';
    }
    ui.fab.disabled = true;
    ui.fabText.textContent = '读取帖子中…';
    ui.start.disabled = true;
    refreshPath();
    if (ui.ver) ui.ver.textContent = 'v' + VERSION;
  }

  function refreshPath() {
    if (!ui.pathText) return;
    const subdir = sanitizeSubdir(ui.subdir ? ui.subdir.value : '');
    let text;
    if (state.dirHandle) {
      text = state.dirHandle.name || '已选文件夹';
      if (subdir) text += ' / ' + subdir;
      if (state.dirPermission !== 'granted') text += '（下载时会请求授权）';
    } else {
      text = '浏览器默认下载目录（独立运行，无需电脑）';
      if (subdir) text += '（子目录仅在选择文件夹后生效）';
    }
    ui.pathText.textContent = text;
    ui.pathText.title = text;

    if (ui.pick) {
      ui.pick.textContent = state.dirHandle ? '更换保存文件夹' : '选择保存文件夹（可选）';
      ui.pick.disabled = state.running || !supportsFileSystem();
    }
    if (ui.defaultDir) {
      ui.defaultDir.hidden = !state.dirHandle;
      ui.defaultDir.disabled = state.running;
    }
    if (ui.hint) {
      if (supportsFileSystem()) {
        ui.hint.textContent = state.dirHandle
          ? '当前为自选文件夹模式。部分脚本管理器返回的字节可能被文本化而损坏图片；若下载后打不开，请点上方“默认下载目录”重新下载。'
          : '脚本完全在浏览器内运行，不需要电脑终端或本地服务。原图通过 /o= 地址获取；文件交给浏览器原生下载，推荐保持此模式。';
      } else {
        ui.hint.textContent = '脚本完全在浏览器内运行，不需要电脑终端或本地服务。当前浏览器不支持自定义文件夹，文件会交给浏览器默认下载目录；需要完整路径控制时可用 Chrome / Edge + Tampermonkey。';
      }
    }
  }

  function refreshFab() {
    if (!ui.fab) return;
    if (state.running) {
      ui.fab.disabled = true;
      ui.fabText.textContent = '下载中 ' + state.done + '/' + state.media.length;
      return;
    }
    if (state.media.length) {
      ui.fab.disabled = false;
      ui.fabText.textContent = FAB_IDLE_TEXT + '（' + state.media.length + '）';
    } else {
      ui.fab.disabled = true;
      ui.fabText.textContent = state.feed ? '未找到媒体' : '读取帖子中…';
    }
  }

  function refreshPanel() {
    if (!ui.panel) return;
    if (!state.feed) {
      ui.stats.textContent = '正在解析…';
      ui.start.disabled = true;
      return;
    }

    const poster = posterOf(state.feed);
    const title = feedTitle(state.feed);
    const feedCount = (state.feeds && state.feeds.length) || 1;
    ui.feedSub.textContent = (feedCount > 1 ? '共 ' + feedCount + ' 个帖子 · 当前：' : '发帖者：') +
      poster.nick + '（' + poster.id + '）' + (title ? ' · ' + title : '');

    const images = state.media.filter(function (m) { return m.kind === 'image'; }).length;
    const gifs = state.media.filter(function (m) { return m.kind === 'gif'; }).length;
    const videos = state.media.filter(function (m) { return m.kind === 'video'; }).length;
    const parts = [];
    if (images) parts.push(images + ' 张图片');
    if (gifs) parts.push(gifs + ' 个动图');
    if (videos) parts.push(videos + ' 个视频');
    ui.stats.textContent = parts.length
      ? (feedCount > 1 ? feedCount + ' 个帖子 · ' : '') + parts.join(' · ') + ' · 共 ' + state.media.length + ' 个文件'
      : '没有可下载的媒体';

    if (state.media.length) {
      ui.files.hidden = false;
      const preview = state.media.slice(0, 8).map(function (media, index) {
        return '<div class="fileRow"><span class="idx">' + (index + 1) + '</span>' +
          '<span class="fname" title="' + escapeHtml(renderName(media, state.nameTemplate, media.ext)) + '">' + escapeHtml(renderName(media, state.nameTemplate, media.ext)) + '</span>' +
          '<span class="fsize">' + escapeHtml(media.size ? formatSize(media.size) : media.kind === 'video' ? '视频' : '—') + '</span></div>';
      }).join('');
      const more = state.media.length > 8 ? '<div class="more">还有 ' + (state.media.length - 8) + ' 个文件…</div>' : '';
      ui.files.innerHTML = preview + more;
    } else {
      ui.files.hidden = true;
      ui.files.innerHTML = '';
    }

    ui.start.textContent = state.running ? '正在下载…' : '开始下载全部（' + state.media.length + ' 个文件）';
    ui.start.disabled = state.running || !state.media.length;
    ui.cancel.hidden = !state.running;
    ui.cancel.disabled = false;
    refreshPath();
  }

  function showPanel() {
    if (!ui.panel) return;
    ui.panel.hidden = false;
    ui.backdrop.hidden = false;
    refreshPanel();
  }

  function hidePanel() {
    if (!ui.panel) return;
    if (state.running) {
      toast('下载进行中，请等待完成或取消');
      return;
    }
    ui.panel.hidden = true;
    ui.backdrop.hidden = true;
  }

  function toast(message) {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.hidden = true; }, 3200);
  }

  function log(message, kind) {
    if (!ui.log) return;
    const line = document.createElement('div');
    line.className = 'logLine ' + (kind || 'info');
    line.textContent = message;
    ui.log.prepend(line);
    while (ui.log.childElementCount > 160) ui.log.lastElementChild.remove();
  }

  function addFileRow(media) {
    const row = document.createElement('div');
    row.className = 'logLine';
    const name = document.createElement('span');
    name.className = 'logName';
    name.textContent = renderName(media, state.nameTemplate, media.ext);
    const message = document.createElement('span');
    message.className = 'logMsg';
    message.textContent = '等待中';
    row.appendChild(name);
    row.appendChild(message);
    ui.log.prepend(row);
    while (ui.log.childElementCount > 160) ui.log.lastElementChild.remove();
    return message;
  }

  function setProgress(done, total, ok, skipped, fail) {
    state.done = done;
    if (ui.progressWrap) ui.progressWrap.hidden = false;
    if (ui.bar) ui.bar.style.width = (total ? Math.round(done * 100 / total) : 0) + '%';
    if (ui.progressText) {
      ui.progressText.textContent = done + ' / ' + total + ' · 成功 ' + ok +
        ' · 跳过 ' + skipped + ' · 失败 ' + fail;
    }
    if (state.running) {
      ui.fabText.textContent = '下载中 ' + done + '/' + total;
    }
  }

  /* ------------------------------------------------------------------ *
   * UI actions
   * ------------------------------------------------------------------ */

  async function onFabClick() {
    if (state.running) {
      showPanel();
      return;
    }
    if (!state.media.length) {
      toast('本帖没有可下载的媒体');
      return;
    }
    if (state.dirHandle) {
      const allowed = await ensurePermission(state.dirHandle);
      state.dirPermission = allowed ? 'granted' : 'denied';
      refreshPath();
      if (allowed) {
        showPanel();
        startDownload();
        return;
      }
      toast('文件夹权限未授予，请在面板中重新选择或授权');
    }
    showPanel();
  }

  async function useDefaultDir() {
    state.dirHandle = null;
    state.dirPermission = '';
    setSetting('qqdl-folder-version', '');
    try { await idbSet('dir', null); } catch (error) { /* 清理失败不影响本次 */ }
    refreshPath();
    log('已切换到浏览器默认下载目录（推荐，原生下载不会损坏图片）', 'warn');
  }

  async function pickFolder() {
    if (!supportsFileSystem()) {
      toast('当前浏览器不支持选择文件夹');
      return;
    }
    let handle = null;
    try {
      const picker = directoryPicker();
      if (!picker) throw new Error('当前环境不支持 showDirectoryPicker');
      try {
        handle = await picker({ id: 'qqdl-userscript', mode: 'readwrite', startIn: 'downloads' });
      } catch (firstError) {
        if (firstError && firstError.name === 'AbortError') return;
        handle = await picker({ mode: 'readwrite' });
      }
    } catch (error) {
      if (error && error.name !== 'AbortError') {
        log('选择文件夹失败：' + friendlyError(error), 'err');
      }
      return;
    }
    if (!handle) return;
    const allowed = await ensurePermission(handle);
    if (!allowed) {
      log('没有获得文件夹写入权限', 'err');
      return;
    }
    state.dirHandle = handle;
    state.dirPermission = 'granted';
    setSetting('qqdl-folder-version', VERSION);
    try { await idbSet('dir', handle); } catch (error) { /* 句柄持久化是附加功能 */ }
    refreshPath();
    log('已选择保存文件夹：' + (handle.name || ''), 'ok');
  }

  function cancelDownload() {
    if (!state.running) return;
    state.cancel = true;
    ui.cancel.disabled = true;
    log('正在取消：当前文件完成后停止', 'warn');
  }

  async function startDownload() {
    if (state.running) return;
    if (ui.extraUrls && ui.extraUrls.value.trim()) {
      await parseExtraFeeds(true);
    }
    if (!state.media.length) return;

    const template = (ui.nameTemplate && ui.nameTemplate.value.trim()) || DEFAULT_NAME_TEMPLATE;
    const templateError = validateNameTemplate(template);
    if (templateError) {
      toast(templateError);
      if (ui.nameTemplate) ui.nameTemplate.focus();
      return;
    }
    state.nameTemplate = template;
    setSetting('qqdl-name-template', template);

    const subdir = sanitizeSubdir(ui.subdir ? ui.subdir.value : '');
    const useDirectory = !!state.dirHandle;

    if (useDirectory) {
      const allowed = await ensurePermission(state.dirHandle);
      if (!allowed) {
        state.dirPermission = 'denied';
        refreshPath();
        log('没有文件夹写入权限，请重新选择文件夹或授权', 'err');
        return;
      }
      state.dirPermission = 'granted';
    } else if (typeof GM_download !== 'function' && typeof GM_xmlhttpRequest !== 'function') {
      log('未选择文件夹，且脚本管理器不支持 GM_download / GM_xmlhttpRequest；请选择一个保存文件夹', 'err');
      return;
    }

    state.running = true;
    state.cancel = false;
    state.done = 0;
    ui.start.disabled = true;
    ui.cancel.hidden = false;
    ui.cancel.disabled = false;
    ui.pick.disabled = true;
    ui.subdir.disabled = true;
    ui.nameTemplate.disabled = true;
    ui.skip.disabled = true;
    ui.progressWrap.hidden = false;
    ui.bar.style.width = '0%';
    ui.log.innerHTML = '';
    refreshFab();
    refreshPanel();

    let dir = null;
    try {
      if (useDirectory) {
        dir = await resolveDir(state.dirHandle, subdir);
      }
    } catch (error) {
      log('创建子目录失败：' + friendlyError(error), 'err');
      finishRun(0, 0, 0, 0, 0);
      return;
    }

    if (dir) {
      log('保存到文件夹：' + (state.dirHandle.name || '') + (subdir ? ' / ' + subdir : ''), 'info');
    } else {
      log('未选择文件夹：将按文件真实类型命名后保存到浏览器默认下载目录；如浏览器询问“下载多个文件”，请允许', 'warn');
      if (subdir) log('默认下载目录不支持子目录，已忽略：' + subdir, 'warn');
    }

    const total = state.media.length;
    const skip = state.skip;
    let next = 0;
    let done = 0;
    let ok = 0;
    let skipped = 0;
    let failed = 0;

    async function saveOne(media, message) {
      if (dir) {
        const existing = await findExisting(dir, renderName(media, state.nameTemplate, ''));
        if (skip && media.size > 0 && existing.size === media.size) {
          skipped++;
          updateRowName(message, existing.name);
          message.textContent = '已存在，跳过';
          message.className = 'logMsg';
          return;
        }

        const fetched = await fetchBuffer(media, function (progress) {
          if (progress && progress.total) {
            message.textContent = '下载 ' + Math.min(99, Math.round(progress.loaded * 100 / progress.total)) + '%';
          } else if (progress && progress.loaded) {
            message.textContent = '已下载 ' + formatSize(progress.loaded);
          }
        });
        const buffer = fetched.buffer;
        if (fetched.fromString && media.kind === 'image' && !(await decodeImageSize(buffer))) {
          throw new Error('脚本管理器把图片返回成了文本，写入会损坏文件；请取消“选择文件夹”改用浏览器默认下载，或换 Chrome/Edge');
        }

        const ext = mediaExtForBuffer(media, buffer);
        if (media.kind === 'image' && !imageComplete(buffer, ext)) {
          throw new Error('图片文件不完整（文件尾校验失败），已阻止写入损坏文件；请点“默认下载目录”后重新下载，或换 Chrome/Edge');
        }
        const finalName = renderName(media, state.nameTemplate, ext);
        await validateImageBuffer(media, buffer);
        await writeBuffer(dir, finalName, buffer, mimeFor(ext));

        updateRowName(message, finalName);
        message.textContent = formatSize(buffer.byteLength);
        message.className = 'logMsg';
        ok++;
        return;
      }

      /* 未选择文件夹：优先交给浏览器/脚本管理器的下载器，避免管理器把二进制响应转成字符串而损坏文件。 */
      if (typeof GM_download === 'function') {
        try {
          const mime = await probeContentType(media.url);
          if (/^text\/html/i.test(mime)) {
            throw new Error('CDN 返回的是网页而不是图片/视频（可能链接已过期，请刷新帖子后重试）');
          }
          const ext = extFromMime(mime) || media.ext || (media.kind === 'video' ? 'mp4' : 'jpg');
          const finalName = renderName(media, state.nameTemplate, ext);
          const downloadName = leafName(finalName);
          if (downloadName !== finalName) {
            log('⚠ 浏览器默认下载目录不能创建子目录，已只保留文件名：' + downloadName, 'warn');
          }
          await gmDownload(media.url, downloadName);
          updateRowName(message, finalName);
          message.textContent = '已交给浏览器';
          message.className = 'logMsg';
          ok++;
          return;
        } catch (error) {
          if (/CDN 返回的是网页/.test(String(error && error.message))) throw error;
          log('⚠ GM_download 失败，改用脚本读取字节：' + friendlyError(error), 'warn');
        }
      }

      if (typeof GM_xmlhttpRequest === 'function') {
        const fetched = await fetchBuffer(media, function (progress) {
          if (progress && progress.total) {
            message.textContent = '下载 ' + Math.min(99, Math.round(progress.loaded * 100 / progress.total)) + '%';
          } else if (progress && progress.loaded) {
            message.textContent = '已下载 ' + formatSize(progress.loaded);
          }
        });
        const buffer = fetched.buffer;
        if (fetched.fromString) {
          throw new Error('脚本管理器把媒体响应返回成了文本，写入会损坏文件；请改用浏览器默认下载或换 Chrome/Edge');
        }
        const ext = mediaExtForBuffer(media, buffer);
        const finalName = renderName(media, state.nameTemplate, ext);
        const downloadName = leafName(finalName);
        if (downloadName !== finalName) {
          log('⚠ 浏览器默认下载目录不能创建子目录，已只保留文件名：' + downloadName, 'warn');
        }
        await validateImageBuffer(media, buffer);
        await saveBlob(buffer, downloadName, mimeFor(ext));
        updateRowName(message, finalName);
        message.textContent = formatSize(buffer.byteLength);
        message.className = 'logMsg';
        ok++;
        return;
      }

      throw new Error('当前脚本管理器不支持下载');
    }

    async function worker() {
      while (!state.cancel) {
        const index = next++;
        if (index >= total) return;
        const media = state.media[index];
        const message = addFileRow(media);
        try {
          await saveOne(media, message);
        } catch (error) {
          failed++;
          message.textContent = friendlyError(error);
          message.className = 'logMsg';
          log('失败：' + renderName(media, state.nameTemplate, media.ext) + ' · ' + friendlyError(error), 'err');
        }
        done++;
        setProgress(done, total, ok, skipped, failed);
      }
    }

    const concurrency = Math.min(3, Math.max(1, total));
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(worker());
    await Promise.all(workers);

    if (state.cancel && done < total) {
      log('已取消：完成 ' + done + '/' + total, 'warn');
    }
    finishRun(total, ok, skipped, failed, done);
  }

  function finishRun(total, ok, skipped, failed, done) {
    state.running = false;
    state.cancel = false;
    if (ui.start) {
      ui.start.disabled = !state.media.length;
      ui.start.textContent = '开始下载全部（' + state.media.length + ' 个文件）';
    }
    if (ui.cancel) {
      ui.cancel.hidden = true;
      ui.cancel.disabled = false;
    }
    if (ui.pick) ui.pick.disabled = !supportsFileSystem();
    if (ui.subdir) ui.subdir.disabled = false;
    if (ui.nameTemplate) ui.nameTemplate.disabled = false;
    if (ui.skip) ui.skip.disabled = false;
    if (ui.progressWrap) ui.progressWrap.hidden = false;
    if (ui.progressText) {
      ui.progressText.textContent = done + ' / ' + total + ' · 成功 ' + ok +
        ' · 跳过 ' + skipped + ' · 失败 ' + failed;
    }
    if (failed) {
      log('完成：成功 ' + ok + '，跳过 ' + skipped + '，失败 ' + failed + '（可再次点击重试）', 'warn');
    } else if (done < total) {
      log('已停止：完成 ' + done + ' / ' + total + '，成功 ' + ok + '，跳过 ' + skipped, 'warn');
    } else {
      log('全部完成：成功 ' + ok + '，跳过 ' + skipped + '，失败 0', 'ok');
    }
    refreshFab();
    refreshPath();
  }

  /* ------------------------------------------------------------------ *
   * Feed loading / SPA navigation
   * ------------------------------------------------------------------ */

  async function loadFeed() {
    const token = ++state.feedToken;
    const urlPostId = currentPostId();
    if (!urlPostId) {
      ui.fab.hidden = true;
      return;
    }
    ui.fab.hidden = false;

    let feed = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (token !== state.feedToken) return;
      try {
        const script = document.querySelector('script#__NUXT_DATA__') ||
          document.querySelector('script[data-nuxt-data="nuxt-app"]');
        if (script && script.textContent && script.textContent.length > 80) {
          const candidate = parseFeedFromNuxtText(script.textContent);
          const id = feedIdOf(candidate);
          if (!id || id === urlPostId) {
            feed = candidate;
            break;
          }
        }
      } catch (error) {
        /* 页面可能还在渲染，继续等 */
      }
      await sleep(400);
    }

    if (token !== state.feedToken) return;
    if (!feed) {
      try {
        const html = await fetchPageText(location.href);
        const candidate = parseFeedFromHtml(html);
        const id = feedIdOf(candidate);
        if (!id || id === urlPostId) feed = candidate;
      } catch (error) {
        /* 页面没有 SSR 或网络失败，下面显示错误 */
      }
    }
    if (!feed) {
      ui.fab.disabled = true;
      ui.fabText.textContent = '未找到帖子数据';
      ui.feedSub.textContent = '没有读取到帖子数据；请刷新页面后重试';
      ui.stats.textContent = '解析失败';
      return;
    }

    state.feed = feed;
    state.extraFeeds = [];
    if (ui.extraUrls) ui.extraUrls.value = '';
    rebuildMedia();
    refreshFab();
    if (!ui.panel.hidden) refreshPanel();
  }

  async function restoreFolder() {
    try {
      // 旧版本保存的目录句柄不再自动恢复，避免回到可能损坏图片的文本路径。
      if (getSetting('qqdl-folder-version', '') !== VERSION) return;
      const handle = await idbGet('dir');
      if (handle && typeof handle.queryPermission === 'function') {
        state.dirHandle = handle;
        state.dirPermission = await handle.queryPermission({ mode: 'readwrite' });
        refreshPath();
      }
    } catch (error) {
      /* 没有保存过文件夹，或浏览器禁止持久化 */
    }
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  function bootstrap() {
    if (typeof window === 'undefined' || window.__QQDL_US_BOOTED__) return;
    window.__QQDL_US_BOOTED__ = true;

    initUI();
    restoreFolder();
    loadFeed();

    let lastHref = location.href;
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href;
        state.feedToken++;
        setTimeout(loadFeed, 350);
      }
      if (!document.getElementById(HOST_ID)) {
        state.uiReady = false;
        initUI();
        refreshFab();
      }
    }, 800);
  }

  const Core = {
    version: VERSION,
    decodeNuxtText: decodeNuxtText,
    parseFeedFromNuxtText: parseFeedFromNuxtText,
    parseFeedFromHtml: parseFeedFromHtml,
    findPostFeed: findPostFeed,
    buildMedia: buildMedia,
    renderName: renderName,
    validateNameTemplate: validateNameTemplate,
    DEFAULT_NAME_TEMPLATE: DEFAULT_NAME_TEMPLATE,
    channelOf: channelOf,
    originalImageUrl: originalImageUrl,
    sanitizeName: sanitizeName,
    sanitizeSubdir: sanitizeSubdir,
    withExt: withExt,
    sniffExt: sniffExt,
    feedTitle: feedTitle,
    posterOf: posterOf,
    feedIdOf: feedIdOf,
    pickVideoUrl: pickVideoUrl,
    pickImageUrl: pickImageUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    } else {
      bootstrap();
    }
  }
})();
