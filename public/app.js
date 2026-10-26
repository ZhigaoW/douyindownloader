const form = document.querySelector('#downloadForm');
const downloadCard = document.querySelector('#downloadCard');
const shareText = document.querySelector('#shareText');
const downloadButton = document.querySelector('#downloadButton');
const downloadButtonLabel = downloadButton.querySelector('span');
const pasteButton = document.querySelector('#pasteButton');
const detectHint = document.querySelector('#detectHint');
const platformChips = [...document.querySelectorAll('.platform-chip')];
const statusPill = document.querySelector('#statusPill');
const versionTag = document.querySelector('#versionTag');
const previewPanel = document.querySelector('#previewPanel');
const previewCover = document.querySelector('#previewCover');
const previewCoverFallback = document.querySelector('#previewCoverFallback');
const platformTag = document.querySelector('#platformTag');
const previewTitle = document.querySelector('#previewTitle');
const previewAuthor = document.querySelector('#previewAuthor');
const previewDuration = document.querySelector('#previewDuration');
const previewStats = document.querySelector('#previewStats');
const previewDesc = document.querySelector('#previewDesc');
const pageField = document.querySelector('#pageField');
const pageSelect = document.querySelector('#pageSelect');
const qualitySelect = document.querySelector('#qualitySelect');
const previewNote = document.querySelector('#previewNote');
const progressPanel = document.querySelector('#progressPanel');
const progressTitle = document.querySelector('#progressTitle');
const progressMeta = document.querySelector('#progressMeta');
const progressBar = document.querySelector('#progressBar');
const progressPercent = document.querySelector('#progressPercent');
const progressMessage = document.querySelector('#progressMessage');
const cancelButton = document.querySelector('#cancelButton');
const resultPanel = document.querySelector('#resultPanel');
const resultFilename = document.querySelector('#resultFilename');
const resultMeta = document.querySelector('#resultMeta');
const saveButton = document.querySelector('#saveButton');
const errorPanel = document.querySelector('#errorPanel');
const errorMessage = document.querySelector('#errorMessage');
const downloadList = document.querySelector('#downloadList');
const refreshButton = document.querySelector('#refreshButton');

const PLATFORM_NAMES = { douyin: '抖音', bilibili: '哔哩哔哩' };
const BILIBILI_SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn', 'bili22.cn', 'bili33.cn']);

const state = {
  preview: null,
  previewText: '',
  action: 'idle',
  controller: null,
  completed: false,
  failed: false
};
let healthy = false;
let healthTimer = null;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function detectPlatform(text) {
  const urls = text.match(/https?:\/\/[!-~]+/g) || [];
  for (const raw of urls) {
    const cleaned = raw.replace(/[)\]}>.,;:!?'"`]+$/, '');
    let host;
    try {
      host = new URL(cleaned).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (BILIBILI_SHORT_HOSTS.has(host) || host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
      return 'bilibili';
    }
    if (host === 'douyin.com' || host.endsWith('.douyin.com') || host.endsWith('.iesdouyin.com')) {
      return 'douyin';
    }
  }
  if (/(?:^|[^0-9A-Za-z])BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/i.test(text)) return 'bilibili';
  return null;
}

function refreshActionButton() {
  const busy = state.action !== 'idle';
  downloadButton.disabled = busy || !healthy;

  if (state.action === 'parse') {
    downloadButtonLabel.textContent = '正在解析…';
  } else if (state.action === 'download') {
    downloadButtonLabel.textContent = '正在下载…';
  } else if (!state.preview) {
    downloadButtonLabel.textContent = '解析视频';
  } else if (state.completed) {
    downloadButtonLabel.textContent = '再次下载';
  } else if (state.failed) {
    downloadButtonLabel.textContent = '重试下载';
  } else {
    downloadButtonLabel.textContent = '开始下载';
  }

  cancelButton.hidden = state.action !== 'download';
  if (state.action !== 'download') cancelButton.disabled = false;
  shareText.disabled = busy;
  pasteButton.disabled = busy;

  if (state.preview) {
    qualitySelect.disabled = busy || qualitySelect.options.length < 2;
    if (!pageField.hidden) pageSelect.disabled = busy;
  }
}

function setAction(action) {
  state.action = action;
  if (action === 'download') cancelButton.disabled = false;
  refreshActionButton();
}

function setReady(ready, version) {
  healthy = Boolean(ready);
  statusPill.className = `status-pill ${healthy ? 'ready' : 'offline'}`;
  statusPill.querySelector('span').textContent = healthy ? '本地服务已就绪' : '服务未连接';
  if (version) {
    statusPill.title = `本地服务 v${version}`;
    versionTag.textContent = `v${version}`;
  }
  refreshActionButton();
}

function setProgress(percent, text) {
  progressBar.style.width = `${Math.max(3, Math.min(100, percent))}%`;
  progressPercent.textContent = text;
}

function showProgress(title, message) {
  progressPanel.hidden = false;
  resultPanel.hidden = true;
  errorPanel.hidden = true;
  progressTitle.textContent = title;
  progressMeta.textContent = '请稍候…';
  progressMessage.textContent = message;
  setProgress(4, '0%');
}

function showError(message) {
  progressPanel.hidden = true;
  resultPanel.hidden = true;
  errorPanel.hidden = false;
  errorMessage.textContent = message || '操作失败，请稍后重试。';
  refreshActionButton();
}

function resetPreview() {
  state.preview = null;
  state.previewText = '';
  state.completed = false;
  state.failed = false;

  previewPanel.hidden = true;
  previewPanel.removeAttribute('data-platform');
  progressPanel.hidden = true;
  resultPanel.hidden = true;
  errorPanel.hidden = true;
  downloadCard.removeAttribute('data-platform');
  previewCover.removeAttribute('src');
  previewCover.hidden = true;
  previewNote.hidden = true;
  previewNote.textContent = '';
  previewDesc.hidden = true;
  previewDesc.textContent = '';
  pageField.hidden = true;
  pageSelect.replaceChildren();
  qualitySelect.replaceChildren();
  refreshActionButton();
}

function updateDetection() {
  const platform = detectPlatform(shareText.value);
  for (const chip of platformChips) {
    chip.classList.toggle('active', chip.dataset.platform === platform);
  }
  detectHint.dataset.platform = platform || '';
  detectHint.querySelector('span').textContent = platform
    ? `已识别${PLATFORM_NAMES[platform]}链接，可以开始解析`
    : '支持抖音、哔哩哔哩分享链接或整段文案';

  if (state.action === 'idle' && state.preview && shareText.value !== state.previewText) {
    resetPreview();
  }
}

function applyPreview(data) {
  if (!data || (data.platform !== 'douyin' && data.platform !== 'bilibili')) {
    throw new Error('解析结果格式异常，请重试。');
  }

  state.preview = data;
  state.previewText = shareText.value;
  state.completed = false;
  state.failed = false;
  downloadCard.dataset.platform = data.platform;
  previewPanel.dataset.platform = data.platform;

  previewCover.onerror = () => {
    previewCover.hidden = true;
    previewCoverFallback.hidden = false;
  };
  if (typeof data.cover === 'string' && data.cover.startsWith('data:image/')) {
    previewCover.src = data.cover;
    previewCover.hidden = false;
    previewCoverFallback.hidden = true;
  } else {
    previewCover.removeAttribute('src');
    previewCover.hidden = true;
    previewCoverFallback.textContent = data.platform === 'bilibili' ? 'B 站' : '抖音';
    previewCoverFallback.hidden = false;
  }

  platformTag.textContent = PLATFORM_NAMES[data.platform];
  platformTag.dataset.platform = data.platform;
  previewTitle.textContent = data.title || '未命名视频';
  previewAuthor.textContent = data.author ? `作者：${data.author}` : '';
  previewDuration.textContent = data.duration ? formatDuration(data.duration) : '';
  previewStats.textContent = data.stats || '';
  previewDesc.textContent = data.description || '';
  previewDesc.hidden = !data.description;

  const pages = Array.isArray(data.pages) ? data.pages : [];
  if (pages.length > 1) {
    pageSelect.replaceChildren(
      ...pages.map((page) => new Option(`P${page.index} · ${page.title || ''}`, String(page.index)))
    );
    const selected = Math.min(Math.max(1, Number(data.selectedPage) || 1), pages.length);
    pageSelect.value = String(selected);
    pageField.hidden = false;
    pageSelect.disabled = false;
  } else {
    pageField.hidden = true;
    pageSelect.replaceChildren();
  }

  const qualities =
    Array.isArray(data.qualities) && data.qualities.length
      ? data.qualities
      : [{ value: 'auto', label: '自动（最高清晰度）' }];
  qualitySelect.replaceChildren(
    ...qualities.map((quality) => new Option(quality.label || '清晰度', String(quality.value)))
  );
  const preferred = String(data.defaultQuality ?? '');
  if (qualities.some((quality) => String(quality.value) === preferred)) {
    qualitySelect.value = preferred;
  }
  qualitySelect.disabled = qualities.length < 2;

  previewNote.textContent = data.note || '';
  previewNote.hidden = !data.note;

  resultPanel.hidden = true;
  errorPanel.hidden = true;
  previewPanel.hidden = false;
  refreshActionButton();

  if (window.matchMedia('(max-width: 760px)').matches) {
    previewPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function handleEvent(event) {
  if (event.type === 'start') {
    progressMessage.textContent = `已识别${event.platformLabel || '视频'}链接，正在读取视频信息…`;
  } else if (event.type === 'metadata') {
    progressTitle.textContent = event.title || '正在下载视频';
    const parts = [];
    if (event.author) parts.push(`作者：${event.author}`);
    if (event.pages > 1) parts.push(`P${event.page}/${event.pages}`);
    if (event.stats) parts.push(event.stats);
    progressMeta.textContent = parts.join(' · ') || '视频信息已获取';
  } else if (event.type === 'quality') {
    progressMessage.textContent = `清晰度：${event.label}`;
  } else if (event.type === 'route_test') {
    progressMessage.textContent = event.message;
  } else if (event.type === 'route_selected') {
    progressMessage.textContent = `已选择最快线路（约 ${event.speed}），开始下载…`;
    progressMeta.textContent = event.total ? `视频大小 ${formatBytes(event.total)}` : '正在下载';
  } else if (event.type === 'progress') {
    const numeric = Number.parseFloat(event.percent);
    if (Number.isFinite(numeric)) {
      setProgress(numeric, `${numeric.toFixed(1)}%`);
    }
    const meta = [];
    if (event.stage) meta.push(event.stage);
    if (event.speed) meta.push(event.speed);
    if (event.eta) meta.push(`剩余 ${event.eta}`);
    progressMeta.textContent = meta.join(' · ') || '正在下载';
    progressMessage.textContent = event.total
      ? `正在保存到本机… ${formatBytes(event.received)} / ${formatBytes(event.total)}`
      : '正在保存到本机…';
  } else if (event.type === 'log') {
    progressMessage.textContent = event.message;
  } else if (event.type === 'complete') {
    state.completed = true;
    state.failed = false;
    setProgress(100, '100%');
    progressPanel.hidden = true;
    errorPanel.hidden = true;
    resultPanel.hidden = false;
    resultFilename.textContent = event.filename;
    const meta = [];
    if (event.platform && PLATFORM_NAMES[event.platform]) meta.push(PLATFORM_NAMES[event.platform]);
    if (event.size) meta.push(formatBytes(event.size));
    resultMeta.textContent = meta.join(' · ');
    saveButton.href = `${event.url}?download=1`;
    loadDownloads();
  } else if (event.type === 'error') {
    state.failed = true;
    showError(event.message);
  }
}

function handleLine(line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  handleEvent(event);
}

async function consumeStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) handleLine(line);
    if (done) break;
  }
  if (buffer.trim()) handleLine(buffer);
}

async function parseLink() {
  const text = shareText.value.trim();
  if (!text) {
    shareText.focus();
    return;
  }

  state.preview = null;
  state.previewText = '';
  state.completed = false;
  state.failed = false;
  previewPanel.hidden = true;
  downloadCard.removeAttribute('data-platform');
  setAction('parse');
  showProgress('正在解析视频', '正在读取视频信息…');

  try {
    const response = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `解析失败（HTTP ${response.status}）`);
    progressPanel.hidden = true;
    setAction('idle');
    applyPreview(data);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    setAction('idle');
    refreshActionButton();
  }
}

async function startDownload() {
  if (!state.preview) return;

  state.controller = new AbortController();
  state.completed = false;
  state.failed = false;
  setAction('download');
  showProgress('正在准备下载', '正在获取视频地址…');
  if (window.matchMedia('(max-width: 760px)').matches) {
    progressPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: shareText.value.trim(),
        quality: qualitySelect.value || state.preview.defaultQuality,
        page: pageSelect.value ? Number(pageSelect.value) : state.preview.selectedPage
      }),
      signal: state.controller.signal
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    }
    if (!response.body) throw new Error('浏览器不支持读取下载进度。');
    await consumeStream(response.body);
  } catch (error) {
    state.failed = true;
    progressPanel.hidden = true;
    const aborted =
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error && error.name === 'AbortError');
    if (aborted) {
      showError('已取消下载。已经下载的部分会保留，再次下载同一视频时可以继续。');
    } else {
      showError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    state.controller = null;
    setAction('idle');
    refreshActionButton();
  }
}

async function loadDownloads() {
  try {
    const response = await fetch('/api/downloads');
    const data = await response.json();
    const files = Array.isArray(data.files) ? data.files : [];
    if (!files.length) {
      downloadList.innerHTML = '<div class="empty-state">下载完成的视频会出现在这里</div>';
      return;
    }

    downloadList.innerHTML = files
      .slice(0, 10)
      .map((file) => {
        const extension = (file.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4);
        const href = escapeAttr(file.url);
        return `
          <div class="download-item">
            <span class="file-icon">${escapeHtml(extension)}</span>
            <div class="file-info">
              <strong title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong>
              <span>${formatBytes(file.size)} · ${escapeHtml(formatDateTime(file.updatedAt))}</span>
            </div>
            <div class="file-actions">
              <a class="download-link preview-link" href="${href}" target="_blank" rel="noreferrer">预览</a>
              <a class="download-link" href="${href}?download=1" download>保存</a>
            </div>
          </div>`;
      })
      .join('');
  } catch {
    downloadList.innerHTML = '<div class="empty-state">暂时无法读取下载记录</div>';
  }
}

async function checkHealth() {
  if (healthTimer) {
    clearTimeout(healthTimer);
    healthTimer = null;
  }
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    setReady(Boolean(data.ready), data.version);
  } catch {
    setReady(false);
  }
  if (!healthy) {
    healthTimer = setTimeout(checkHealth, 4000);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.action !== 'idle') return;
  if (state.preview) startDownload();
  else parseLink();
});

shareText.addEventListener('input', updateDetection);

pasteButton.addEventListener('click', async () => {
  if (state.action !== 'idle') return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      shareText.value = text;
      updateDetection();
    }
    shareText.focus();
  } catch {
    shareText.focus();
    detectHint.dataset.platform = '';
    detectHint.querySelector('span').textContent = '浏览器未允许读取剪贴板，请按 Ctrl + V 粘贴';
  }
});

cancelButton.addEventListener('click', () => {
  if (!state.controller) return;
  cancelButton.disabled = true;
  progressMessage.textContent = '正在取消下载…';
  state.controller.abort();
});

function handleSelectionChange() {
  if (!state.preview) return;
  state.completed = false;
  state.failed = false;
  resultPanel.hidden = true;
  errorPanel.hidden = true;
  const selectedPage = state.preview.pages?.find(
    (page) => String(page.index) === pageSelect.value
  );
  if (selectedPage?.duration) {
    previewDuration.textContent = formatDuration(selectedPage.duration);
  }
  refreshActionButton();
}

pageSelect.addEventListener('change', handleSelectionChange);
qualitySelect.addEventListener('change', handleSelectionChange);

const navLinks = [...document.querySelectorAll('[data-nav]')];
const navSections = ['download', 'history', 'support']
  .map((id) => ({ id, element: document.getElementById(id) }))
  .filter((section) => section.element);

let navFrame = null;
let navLockUntil = 0;

function setActiveNav(id) {
  for (const link of navLinks) {
    link.classList.toggle('is-active', link.dataset.nav === id);
  }
}

function updateActiveNav() {
  if (!navSections.length || Date.now() < navLockUntil) return;

  const threshold = window.innerWidth <= 720 ? 128 : 96;
  let active = navSections[0].id;

  for (const section of navSections) {
    if (section.element.getBoundingClientRect().top <= threshold) {
      active = section.id;
    }
  }

  setActiveNav(active);
}

window.addEventListener(
  'scroll',
  () => {
    if (navFrame !== null) return;
    navFrame = requestAnimationFrame(() => {
      updateActiveNav();
      navFrame = null;
    });
  },
  { passive: true }
);
window.addEventListener('resize', updateActiveNav);

for (const link of navLinks) {
  link.addEventListener('click', () => {
    navLockUntil = Date.now() + 1000;
    setActiveNav(link.dataset.nav);
  });
}

refreshButton.addEventListener('click', loadDownloads);
updateActiveNav();

for (const button of document.querySelectorAll('[data-action="open-folder"]')) {
  button.addEventListener('click', async () => {
    const original = button.textContent;
    button.disabled = true;
    try {
      const response = await fetch('/api/reveal', { method: 'POST' });
      if (!response.ok) throw new Error('failed');
      button.textContent = '已打开';
    } catch {
      button.textContent = '打开失败';
    }
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1600);
  });
}

updateDetection();
checkHealth();
loadDownloads();
