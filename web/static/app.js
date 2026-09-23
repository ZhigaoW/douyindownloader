const form = document.querySelector('#downloadForm');
const shareText = document.querySelector('#shareText');
const downloadButton = document.querySelector('#downloadButton');
const pasteButton = document.querySelector('#pasteButton');
const statusPill = document.querySelector('#statusPill');
const progressPanel = document.querySelector('#progressPanel');
const progressBar = document.querySelector('#progressBar');
const progressPercent = document.querySelector('#progressPercent');
const progressMeta = document.querySelector('#progressMeta');
const progressMessage = document.querySelector('#progressMessage');
const resultPanel = document.querySelector('#resultPanel');
const resultFilename = document.querySelector('#resultFilename');
const saveButton = document.querySelector('#saveButton');
const errorPanel = document.querySelector('#errorPanel');
const errorMessage = document.querySelector('#errorMessage');
const downloadList = document.querySelector('#downloadList');
const refreshButton = document.querySelector('#refreshButton');

function setReady(ready) {
  statusPill.className = `status-pill ${ready ? 'ready' : 'offline'}`;
  statusPill.querySelector('span').textContent = ready ? '本地服务已就绪' : '服务未就绪';
  downloadButton.disabled = !ready;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replaceAll('"', '&quot;');
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    setReady(Boolean(data.ready));
  } catch {
    statusPill.className = 'status-pill offline';
    statusPill.querySelector('span').textContent = '服务未连接';
    downloadButton.disabled = true;
  }
}

async function loadDownloads() {
  try {
    const response = await fetch('/api/downloads');
    const data = await response.json();
    if (!data.files?.length) {
      downloadList.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4zM4 14h5l1 3h4l1-3h5M12 7v5m-2-2 2 2 2-2"/></svg><strong>还没有下载记录</strong><p>从一个喜欢的视频开始吧。</p></div>`;
      return;
    }
    downloadList.innerHTML = data.files.slice(0, 8).map((file) => `
      <div class="download-item">
        <span class="file-icon">MP4</span>
        <div class="file-info">
          <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
          <span>${formatBytes(file.size)} · ${new Date(file.updatedAt).toLocaleString('zh-CN')}</span>
        </div>
        <a class="download-link" href="${file.url}?download=1" download>保存</a>
      </div>
    `).join('');
  } catch {
    downloadList.innerHTML = '<div class="empty-state">暂时无法读取下载记录</div>';
  }
}

function resetPanels() {
  progressPanel.hidden = false;
  resultPanel.hidden = true;
  errorPanel.hidden = true;
  progressBar.style.width = '3%';
  progressBar.parentElement.removeAttribute('aria-valuenow');
  progressPercent.textContent = '0%';
  document.querySelector('#progressTitle').textContent = '正在解析视频';
  progressMeta.textContent = '请稍候…';
  progressMessage.textContent = '正在连接抖音…';
}

function handleEvent(event) {
  if (event.type === 'start') {
    progressMessage.textContent = '已识别分享链接，正在解析视频信息…';
  } else if (event.type === 'metadata') {
    document.querySelector('#progressTitle').textContent = event.title || '正在下载视频';
    progressMessage.textContent = event.author ? `作者：${event.author}` : '视频信息解析完成';
  } else if (event.type === 'route_test') {
    progressMessage.textContent = event.message;
    progressMeta.textContent = '正在选择最快节点';
  } else if (event.type === 'route_selected') {
    progressMessage.textContent = `已选择线路 ${event.line}，开始下载…`;
    progressMeta.textContent = `测速约 ${event.speed}`;
  } else if (event.type === 'progress') {
    const numeric = Number.parseFloat(event.percent);
    if (Number.isFinite(numeric)) {
      progressBar.style.width = `${Math.max(3, Math.min(100, numeric))}%`;
      progressPercent.textContent = `${numeric.toFixed(1)}%`;
      progressBar.parentElement.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, numeric))));
    }
    progressMeta.textContent = [event.speed, event.eta && `剩余 ${event.eta}`].filter(Boolean).join(' · ') || '正在下载';
    progressMessage.textContent = '视频数据正在保存到本机…';
  } else if (event.type === 'log') {
    progressMessage.textContent = event.message;
  } else if (event.type === 'complete') {
    progressBar.style.width = '100%';
    progressBar.parentElement.setAttribute('aria-valuenow', '100');
    progressPercent.textContent = '100%';
    progressPanel.hidden = true;
    resultPanel.hidden = false;
    resultFilename.textContent = event.filename;
    saveButton.href = `${event.url}?download=1`;
    loadDownloads();
  } else if (event.type === 'error') {
    progressPanel.hidden = true;
    errorPanel.hidden = false;
    errorMessage.textContent = event.message;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!shareText.value.trim()) return;
  resetPanels();
  downloadButton.disabled = true;
  downloadButton.querySelector('span').textContent = '正在处理…';

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: shareText.value })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败（${response.status}）`);
    }
    if (!response.body) throw new Error('浏览器不支持读取下载进度');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) handleEvent(JSON.parse(line));
      }
      if (done) break;
    }
  } catch (error) {
    progressPanel.hidden = true;
    errorPanel.hidden = false;
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    downloadButton.disabled = false;
    downloadButton.querySelector('span').textContent = '解析并下载';
  }
});

pasteButton.addEventListener('click', async () => {
  try {
    shareText.value = await navigator.clipboard.readText();
    shareText.focus();
  } catch {
    shareText.focus();
    const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Command ⌘ + V' : 'Ctrl + V';
    shareText.placeholder = `浏览器未允许读取剪贴板，请按 ${shortcut} 粘贴`;
  }
});

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
document.querySelector('#shortcutHint').textContent = isMac ? '⌘ ↵' : 'Ctrl ↵';
shareText.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault();
    if (!downloadButton.disabled) form.requestSubmit();
  }
});
function updateNavigation() {
  const current = location.hash === '#history' ? '#history' : '#new-download';
  document.querySelectorAll('.nav-item').forEach((link) => {
    const active = link.getAttribute('href') === current;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', updateNavigation);
updateNavigation();
refreshButton.addEventListener('click', loadDownloads);
checkHealth();
loadDownloads();
