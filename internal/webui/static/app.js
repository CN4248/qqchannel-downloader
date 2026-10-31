'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_NAME_TEMPLATE = '<channel_id>-<post_id>-<order>';
const LAST_JOB_KEY = 'qqdl.webui.lastJob';
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
  'width': 'width', '宽度': 'width', 'height': 'height', '高度': 'height',
};
const FALLBACK_TOKENS = [
  ['<channel_id>', '频道ID'], ['<post_id>', '文章ID'], ['<order>', '图片序号'],
  ['<poster_id>', '发帖者ID'], ['<poster_name>', '发帖者昵称'],
  ['<sub_channel_id>', '子频道ID'], ['<title>', '标题'], ['<kind>', '类型'],
  ['<ext>', '扩展名'], ['<width>', '宽度'], ['<height>', '高度'],
];
const state = {
  feeds: [],
  media: [],
  jobId: null,
  running: false,
  timer: null,
  lastLogs: '',
  toastTimer: null,
  nameTemplate: DEFAULT_NAME_TEMPLATE,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function toast(message, isError) {
  const box = $('toast');
  box.textContent = message;
  box.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    box.className = 'toast' + (isError ? ' error' : '');
  }, 3600);
}

async function api(path, options) {
  const opts = Object.assign({ method: 'GET' }, options || {});
  if (opts.body && !opts.headers) {
    opts.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = {}; }
  }
  if (!res.ok) {
    const error = new Error(data.error || ('请求失败 (HTTP ' + res.status + ')'));
    error.status = res.status;
    throw error;
  }
  return data;
}

function setBusy(btn, busy, label) {
  const span = btn.querySelector('.btnText');
  if (busy) {
    btn.dataset.label = span.textContent;
    span.textContent = label;
    btn.disabled = true;
    btn.classList.add('loading');
  } else {
    span.textContent = btn.dataset.label || span.textContent;
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

function formatSize(n) {
  if (!n || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i];
}

function kindLabel(m) {
  if (m.kind === 'video') return '视频';
  return m.isGif ? 'GIF' : '图片';
}

function canonicalToken(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return NAME_ALIASES[key] || '';
}

function tokenValue(m, canonical) {
  switch (canonical) {
    case 'channel_id': return m.channelId || m.guildId || m.posterId || 'channel';
    case 'guild_id': return m.guildId || m.channelId || '';
    case 'sub_channel_id': return m.subChannelId || '';
    case 'post_id': return m.postId || state.feeds[0] && state.feeds[0].id || '';
    case 'order': return String(m.order || m.seq || 0);
    case 'poster_id': return m.posterId || '';
    case 'poster_name': return m.posterName || '';
    case 'title': return m.title || state.feeds[0] && state.feeds[0].title || '';
    case 'kind': return m.kind || '';
    case 'ext': return m.ext || '';
    case 'width': return String(m.width || '');
    case 'height': return String(m.height || '');
    default: return '';
  }
}

function templateHasExt(tpl) {
  let found = false;
  String(tpl || '').replace(/<([^<>]+)>/g, (_, inner) => {
    if (canonicalToken(inner) === 'ext') found = true;
    return '';
  });
  return found;
}

function sanitizePreviewSegment(name) {
  let out = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  out = out.trim().replace(/[ .]+$/, '');
  if (!out || out === '.' || out === '..') return '';
  return Array.from(out).slice(0, 180).join('');
}

function renderMediaName(m, tpl) {
  const template = String(tpl || '').trim() || DEFAULT_NAME_TEMPLATE;
  const hadExt = templateHasExt(template);
  // Only literal "/" in the template creates folders; slashes in token values
  // (for example a title) are sanitized inside that segment.
  const segments = [];
  template.split('/').forEach((part) => {
    const rendered = part.replace(/<([^<>]+)>/g, (raw, inner) => {
      const c = canonicalToken(inner);
      return c ? tokenValue(m, c) : '_';
    });
    const safe = sanitizePreviewSegment(rendered);
    if (safe) segments.push(safe);
  });
  if (!segments.length) segments.push('file');
  if (!hadExt && m.ext) segments[segments.length - 1] += '.' + m.ext;
  return segments.join('/');
}

function validateNameTemplate(tpl) {
  const unknown = [];
  String(tpl || '').replace(/<([^<>]+)>/g, (_, inner) => {
    if (!canonicalToken(inner)) unknown.push('<' + inner + '>');
    return '';
  });
  return unknown.length ? '未知变量 ' + unknown.join('、') : '';
}

function renderNameTokens(tokens) {
  const box = $('nameTokens');
  if (!box) return;
  box.textContent = '';
  (tokens && tokens.length ? tokens : FALLBACK_TOKENS).forEach((item) => {
    const token = Array.isArray(item) ? item[0] : item.token;
    const desc = Array.isArray(item) ? item[1] : item.desc;
    const btn = el('button', 'nameToken');
    btn.type = 'button';
    btn.dataset.token = token;
    btn.title = '插入 ' + token + '：' + desc;
    btn.appendChild(el('code', '', token));
    btn.appendChild(el('span', '', desc));
    btn.addEventListener('click', () => {
      const input = $('nameTemplate');
      const start = input.selectionStart == null ? input.value.length : input.selectionStart;
      const end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      input.setRangeText(token, start, end, 'end');
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    box.appendChild(btn);
  });
}

function refreshMediaNames() {
  document.querySelectorAll('.mediaItem').forEach((row) => {
    const index = Number(row.dataset.index);
    const media = state.media.find((m) => m.index === index);
    if (!media) return;
    const nameEl = row.querySelector('.mediaName');
    if (nameEl) {
      nameEl.textContent = renderMediaName(media, state.nameTemplate);
      nameEl.title = nameEl.textContent;
    }
  });
}

function applyNameTemplate(showError) {
  const input = $('nameTemplate');
  if (!input) return true;
  const tpl = input.value.trim() || DEFAULT_NAME_TEMPLATE;
  state.nameTemplate = tpl;
  const error = validateNameTemplate(tpl);
  const errorEl = $('nameError');
  if (errorEl) {
    errorEl.textContent = error ? error + '，可用变量见上方提示。' : '';
    errorEl.hidden = !error;
  }
  refreshMediaNames();
  if (showError && error) toast(error, true);
  $('startBtn').disabled = !state.media.length || state.running || !!error;
  return !error;
}

function renderFeeds(feeds) {
  state.feeds = (feeds || []).filter(Boolean);
  state.media = [];
  const list = $('feedsList');
  list.textContent = '';
  let total = 0;
  let validFeeds = 0;
  let nextIndex = 1;

  state.feeds.forEach((feed) => {
    const group = el('div', 'feedGroup' + (feed.error ? ' feedGroupError' : ''));
    const top = el('div', 'feedTop');
    const titleWrap = el('div', 'feedTitleWrap');
    titleWrap.appendChild(el('h3', '', feed.error ? '链接无法解析' : (feed.title || '未命名帖子')));
    if (feed.error) {
      titleWrap.appendChild(el('p', 'feedError', (feed.url || '') + ' · ' + feed.error));
    } else {
      titleWrap.appendChild(el('p', '',
        '发帖者：' + (feed.posterName || '未知') + '（' + (feed.posterId || '—') + '）' +
        '  ·  频道ID：' + (feed.guildId || '—') +
        '  ·  文章ID：' + (feed.id || '—')));
    }
    top.appendChild(titleWrap);
    if (!feed.error) {
      const stats = el('div', 'feedStats');
      stats.appendChild(el('span', 'statChip image', (feed.imageCount || 0) + ' 张图片'));
      stats.appendChild(el('span', 'statChip video', (feed.videoCount || 0) + ' 个视频'));
      top.appendChild(stats);
    }
    group.appendChild(top);

    const medias = Array.isArray(feed.medias) ? feed.medias : [];
    if (medias.length) {
      validFeeds++;
      const mediaList = el('div', 'mediaList');
      medias.forEach((m) => {
        const index = Number(m.index) || nextIndex;
        nextIndex = Math.max(nextIndex + 1, index + 1);
        m.index = index;
        state.media.push(m);
        total++;
        const row = el('div', 'mediaItem');
        row.dataset.index = String(index);
        row.dataset.seq = String(m.seq || m.order || index);
        const thumbClass = m.kind === 'video' ? 'video' : (m.isGif ? 'gif' : 'image');
        const thumbText = m.kind === 'video' ? 'VID' : (m.isGif ? 'GIF' : 'IMG');
        row.appendChild(el('div', 'mediaThumb ' + thumbClass, thumbText));
        const body = el('div', 'mediaBody');
        const nameEl = el('div', 'mediaName', renderMediaName(m, state.nameTemplate));
        nameEl.title = nameEl.textContent;
        body.appendChild(nameEl);
        const meta = kindLabel(m) + '  ·  ' + (m.width || '?') + '×' + (m.height || '?') +
          '  ·  ' + (m.size > 0 ? formatSize(m.size) : '大小由文件头校验') +
          (m.ext ? '' : '  ·  扩展名下载后识别');
        body.appendChild(el('div', 'mediaMeta', meta));
        row.appendChild(body);
        row.appendChild(el('span', 'mediaTag', m.kind === 'video' ? '最高码率' : '原图'));
        mediaList.appendChild(row);
      });
      group.appendChild(mediaList);
    }
    list.appendChild(group);
  });

  $('emptyState').hidden = state.feeds.length > 0;
  $('feedBox').hidden = state.feeds.length === 0;
  $('countBadge').hidden = total === 0;
  $('countBadge').textContent = validFeeds + ' 个帖子 · ' + total + ' 个文件';
  if (state.feeds.length && total === 0) {
    list.appendChild(el('div', 'emptyState', '这些链接里没有可下载的图片、GIF 或视频。'));
  }
  applyNameTemplate(false);
  $('parseBtn').disabled = false;
}

async function parsePost() {
  const urls = $('url').value.split(/[\r\n,，]+/).map((v) => v.trim()).filter(Boolean);
  if (!urls.length) {
    toast('请先粘贴至少一个帖子链接', true);
    $('url').focus();
    return;
  }
  const btn = $('parseBtn');
  setBusy(btn, true, '解析中…');
  $('startBtn').disabled = true;
  try {
    const data = await api('/api/parse', {
      method: 'POST',
      body: JSON.stringify({ urls: urls, nameTemplate: state.nameTemplate }),
    });
    const feeds = data.feeds || [];
    renderFeeds(feeds);
    const ok = feeds.filter((f) => f && !f.error).length;
    const bad = feeds.length - ok;
    const count = feeds.reduce((n, f) => n + ((f && f.medias) ? f.medias.length : 0), 0);
    if (count) {
      toast('已解析 ' + ok + ' 个帖子，共 ' + count + ' 个文件' + (bad ? '，' + bad + ' 个链接失败' : ''));
    } else {
      toast('没有解析到可下载内容，请检查链接', true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(btn, false);
    $('parseBtn').disabled = false;
  }
}

function resetProgress() {
  $('progressCard').hidden = false;
  $('barFill').style.width = '0%';
  $('barText').textContent = '0%';
  $('statDone').textContent = '0 / 0';
  $('statSuccess').textContent = '0';
  $('statSkipped').textContent = '0';
  $('statFailed').textContent = '0';
  $('log').textContent = '';
  $('jobState').className = 'jobState running';
  $('jobState').innerHTML = '<i></i> 进行中';
  $('cancelBtn').hidden = false;
  $('cancelBtn').disabled = false;
  $('progressSub').textContent = '正在创建任务…';
  state.lastLogs = '';
}

function setJobState(status) {
  const map = {
    running: ['running', '进行中'],
    done: ['done', '已完成'],
    error: ['error', '失败'],
    canceled: ['canceled', '已取消'],
  };
  const item = map[status] || ['running', status];
  const node = $('jobState');
  node.className = 'jobState ' + item[0];
  node.innerHTML = '<i></i> ';
  node.appendChild(document.createTextNode(item[1]));
}

function updateResultRows(results) {
  (results || []).forEach((r) => {
    let row = document.querySelector('.mediaItem[data-index="' + r.index + '"]');
    if (!row) row = document.querySelector('.mediaItem[data-seq="' + r.seq + '"]');
    if (!row) return;
    const name = row.querySelector('.mediaName');
    if (name && r.name) {
      name.textContent = r.name;
      name.title = r.name;
    }
    const tag = row.querySelector('.mediaTag');
    if (!tag) return;
    if (r.status === 'success') {
      tag.textContent = '完成';
      tag.className = 'mediaTag ok';
    } else if (r.status === 'skipped') {
      tag.textContent = '已存在';
      tag.className = 'mediaTag ok';
    } else if (r.status === 'failed') {
      tag.textContent = '失败';
      tag.className = 'mediaTag fail';
      tag.title = r.error || '';
    }
  });
}

function renderJob(job) {
  if (Array.isArray(job.feeds) && job.feeds.length &&
      state.feeds.length !== job.feeds.length) {
    renderFeeds(job.feeds);
  }
  const total = job.total || 0;
  const done = job.done || 0;
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;
  $('barFill').style.width = pct + '%';
  $('barText').textContent = pct + '%';
  $('statDone').textContent = done + ' / ' + total;
  $('statSuccess').textContent = job.success || 0;
  $('statSkipped').textContent = job.skipped || 0;
  $('statFailed').textContent = job.failed || 0;
  $('progressSub').textContent = '保存到：' + (job.outDir || '—');
  setJobState(job.status);
  updateResultRows(job.results);

  if (job.status !== 'running') {
    state.running = false;
    $('cancelBtn').hidden = true;
    $('parseBtn').disabled = false;
    $('startBtn').disabled = !state.media.length;
  }

  const logs = (job.logs || []).join('\n');
  if (logs !== state.lastLogs) {
    const box = $('log');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.textContent = logs;
    if (nearBottom) box.scrollTop = box.scrollHeight;
    state.lastLogs = logs;
  }
}

function pollJob() {
  clearTimeout(state.timer);
  state.timer = null;
  if (!state.jobId) return;
  api('/api/jobs/' + encodeURIComponent(state.jobId)).then((job) => {
    renderJob(job);
    if (job.status === 'running') {
      state.timer = setTimeout(pollJob, 600);
    } else {
      if (job.status === 'done') toast('下载完成：成功 ' + job.success + '，跳过 ' + job.skipped + '，失败 ' + job.failed);
      if (job.status === 'error') toast(job.error || '任务失败', true);
      if (job.status === 'canceled') toast('任务已取消');
      $('startBtn').disabled = !state.media.length;
    }
  }).catch((err) => {
    if (err.status === 404) {
      state.jobId = null;
      state.running = false;
      try { localStorage.removeItem(LAST_JOB_KEY); } catch (_) { /* ignore */ }
      $('cancelBtn').hidden = true;
      $('progressCard').hidden = true;
      toast('任务已结束，或本地 WebUI 已重启');
      return;
    }
    toast(err.message, true);
    state.timer = setTimeout(pollJob, 1500);
  });
}

async function startDownload() {
  if (!state.media.length) {
    toast('请先解析帖子', true);
    return;
  }
  if (!applyNameTemplate(true)) {
    $('nameTemplate').focus();
    return;
  }
  const urls = $('url').value.split(/[\r\n,，]+/).map((v) => v.trim()).filter(Boolean);
  const outDir = $('outDir').value.trim();
  let jobs = parseInt($('jobs').value, 10);
  if (!Number.isFinite(jobs)) jobs = 4;
  jobs = Math.max(1, Math.min(16, jobs));
  $('jobs').value = String(jobs);

  const btn = $('startBtn');
  setBusy(btn, true, '提交中…');
  $('parseBtn').disabled = true;
  resetProgress();
  try {
    const data = await api('/api/download', {
      method: 'POST',
      body: JSON.stringify({
        urls: urls,
        outDir: outDir,
        jobs: jobs,
        force: $('force').checked,
        nameTemplate: state.nameTemplate,
      }),
    });
    state.jobId = data.id;
    state.running = true;
    try {
      localStorage.setItem(LAST_JOB_KEY, data.id);
      localStorage.setItem(LAST_JOB_KEY + '.outDir', outDir);
      localStorage.setItem(LAST_JOB_KEY + '.urls', urls.join('\n'));
    } catch (_) { /* ignore */ }
    toast('任务已开始');
    pollJob();
  } catch (err) {
    toast(err.message, true);
    state.running = false;
    $('progressCard').hidden = true;
    $('parseBtn').disabled = false;
  } finally {
    setBusy(btn, false);
    $('startBtn').disabled = state.running || !state.media.length;
  }
}

async function cancelJob() {
  if (!state.jobId) return;
  $('cancelBtn').disabled = true;
  try {
    await api('/api/jobs/' + encodeURIComponent(state.jobId) + '/cancel', { method: 'POST' });
    toast('正在取消…');
  } catch (err) {
    toast(err.message, true);
    $('cancelBtn').disabled = false;
  }
}

async function openDirectory() {
  const path = $('outDir').value.trim();
  if (!path) {
    toast('请先填写保存目录', true);
    return;
  }
  try {
    await api('/api/open-dir', { method: 'POST', body: JSON.stringify({ path: path }) });
    toast('已打开目录');
  } catch (err) {
    toast(err.message, true);
  }
}

function toggleLog() {
  const box = $('log');
  const hidden = box.hidden;
  box.hidden = !hidden;
  $('toggleLogBtn').textContent = hidden ? '收起' : '展开';
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    if (!$('outDir').value.trim()) $('outDir').value = cfg.defaultOut || 'downloads';
    if (cfg.jobs) $('jobs').value = String(cfg.jobs);
    if (cfg.defaultNameTemplate) {
      $('nameTemplate').value = cfg.defaultNameTemplate;
      state.nameTemplate = cfg.defaultNameTemplate;
    }
    renderNameTokens(cfg.nameTokens);
    applyNameTemplate(false);
    if (cfg.version) $('version').textContent = 'v' + cfg.version;
    $('footerPath').textContent = '默认目录：' + (cfg.defaultOut || 'downloads');
  } catch (_) {
    if (!$('outDir').value.trim()) $('outDir').value = 'downloads';
    renderNameTokens(FALLBACK_TOKENS);
    applyNameTemplate(false);
  }
}

function bindEvents() {
  $('parseBtn').addEventListener('click', parsePost);
  $('startBtn').addEventListener('click', startDownload);
  $('cancelBtn').addEventListener('click', cancelJob);
  $('openDirBtn').addEventListener('click', openDirectory);
  $('toggleLogBtn').addEventListener('click', toggleLog);
  $('nameTemplate').addEventListener('input', () => applyNameTemplate(false));
  $('resetNameBtn').addEventListener('click', () => {
    $('nameTemplate').value = DEFAULT_NAME_TEMPLATE;
    applyNameTemplate(false);
  });
  $('url').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      parsePost();
    }
  });
  $('outDir').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.media.length) startDownload();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && state.media.length) {
      e.preventDefault();
      startDownload();
    }
  });
}

async function restoreJob() {
  let id = '';
  try { id = localStorage.getItem(LAST_JOB_KEY) || ''; } catch (_) { /* ignore */ }
  if (!id) return false;
  let job;
  try {
    job = await api('/api/jobs/' + encodeURIComponent(id));
  } catch (err) {
    if (err.status === 404) {
      try { localStorage.removeItem(LAST_JOB_KEY); } catch (_) { /* ignore */ }
    }
    return false;
  }
  state.jobId = id;
  state.running = job.status === 'running';
  if (job.nameTemplate) {
    state.nameTemplate = job.nameTemplate;
    $('nameTemplate').value = job.nameTemplate;
  }
  if (Array.isArray(job.urls) && job.urls.length) {
    $('url').value = job.urls.join('\n');
  }
  if (job.outDir) $('outDir').value = job.outDir;
  renderFeeds(job.feeds || []);
  resetProgress();
  $('progressCard').hidden = false;
  renderJob(job);
  if (state.running) {
    $('parseBtn').disabled = true;
    $('startBtn').disabled = true;
    pollJob();
  } else {
    $('startBtn').disabled = !state.media.length;
    $('parseBtn').disabled = false;
  }
  toast('已恢复上次任务：' + (job.status === 'running' ? '下载中' : '已结束'));
  return true;
}

async function init() {
  bindEvents();
  await loadConfig();
  const restored = await restoreJob();
  const fromQuery = new URLSearchParams(location.search).get('url');
  if (!restored && fromQuery) {
    $('url').value = fromQuery;
    await parsePost();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
