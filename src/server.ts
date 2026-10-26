import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { bilibiliMediaPlan, resolveBilibili, resolveBilibiliPreview } from './bilibili.ts';
import { douyinMediaPlan, resolveDouyin, resolveDouyinPreview } from './douyin.ts';
import { platformLabel, requireTarget, type VideoTarget } from './input.ts';
import { UserError, errorMessage } from './http.ts';
import { downloadPlan, sendEvent } from './download.ts';
import type { MediaPlan, Platform } from './types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const DOWNLOAD_DIR = join(ROOT, 'downloads');
const PORT = Number(process.env.PORT || 3210) || 3210;
const HOST = '127.0.0.1';
const VERSION = '2.2.0';

mkdirSync(DOWNLOAD_DIR, { recursive: true });

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new UserError('提交的内容过长。', 413);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    throw new UserError('请求内容不是有效的 JSON。', 400);
  }
}

function statusFor(error: unknown): number {
  return error instanceof UserError ? error.status : 502;
}

function friendlyError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const raw = errorMessage(error);
  if (/abort|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(raw)) {
    return '网络连接失败或超时，请检查网络后重试。';
  }
  if (/HTTP 403/.test(raw)) {
    return '视频服务器拒绝了下载请求（HTTP 403），请稍后重试。';
  }
  return raw || '发生未知错误，请稍后重试。';
}

function enrichError(platform: Platform, error: unknown): string {
  const message = friendlyError(error);
  if (
    platform === 'douyin' &&
    /验证|视频信息|风控|没有找到/.test(message) &&
    !message.includes('浏览器')
  ) {
    return `${message}。请先在浏览器中打开分享链接，确认视频可以正常播放后再试。`;
  }
  return message;
}

function cleanFilename(value: string): string {
  return value
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

function buildBaseName(
  platform: Platform,
  title: string,
  id: string,
  page: number,
  pageCount: number
): string {
  const prefix = platform === 'bilibili' ? '[B站]' : '[抖音]';
  const fallback = platform === 'bilibili' ? '哔哩哔哩视频' : '抖音视频';
  const safeTitle = [...cleanFilename(title)].slice(0, 72).join('') || fallback;
  const tag = pageCount > 1 ? `${id} P${page}` : id;
  return `${prefix} ${safeTitle} [${tag}]`;
}

function uniqueVideoPath(baseName: string): string {
  const first = join(DOWNLOAD_DIR, `${baseName}.mp4`);
  if (!existsSync(first)) return first;

  let index = 2;
  while (existsSync(join(DOWNLOAD_DIR, `${baseName} (${index}).mp4`))) index += 1;
  return join(DOWNLOAD_DIR, `${baseName} (${index}).mp4`);
}

function safeDownloadPath(urlPath: string): string | null {
  let filename: string;
  try {
    filename = decodeURIComponent(urlPath.slice('/downloads/'.length));
  } catch {
    return null;
  }
  if (!filename || filename.includes('/') || filename.includes('\\')) return null;
  const fullPath = resolve(DOWNLOAD_DIR, filename);
  return relative(DOWNLOAD_DIR, fullPath).startsWith('..') ? null : fullPath;
}

function listDownloads(): Array<{ name: string; url: string; size: number; updatedAt: string }> {
  return readdirSync(DOWNLOAD_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== '.gitkeep' &&
        !entry.name.startsWith('.') &&
        !entry.name.endsWith('.part') &&
        VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())
    )
    .map((entry) => {
      const info = statSync(join(DOWNLOAD_DIR, entry.name));
      return {
        name: entry.name,
        url: `/downloads/${encodeURIComponent(entry.name)}`,
        size: info.size,
        updatedAt: info.mtime.toISOString()
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function serveFile(res: ServerResponse, filePath: string, download = false): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    json(res, 404, { error: '文件不存在' });
    return;
  }

  const size = statSync(filePath).size;
  const headers: Record<string, string | number> = {
    'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff'
  };
  if (download) {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(filePath))}`;
  }

  let status = 200;
  let start = 0;
  let end = Math.max(0, size - 1);
  const range = res.req?.headers.range;

  if (range && size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const startText = match[1];
      const endText = match[2];
      if (startText) {
        start = Number(startText);
        end = endText ? Math.min(Number(endText), size - 1) : size - 1;
      } else if (endText) {
        start = Math.max(0, size - Number(endText));
        end = size - 1;
      }

      if (start >= 0 && start < size && end >= start) {
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
        headers['content-length'] = end - start + 1;
      } else {
        res.writeHead(416, {
          'content-range': `bytes */${size}`,
          'content-type': 'text/plain; charset=utf-8'
        });
        res.end('请求的下载范围无效');
        return;
      }
    }
  }

  if (headers['content-length'] === undefined) headers['content-length'] = size;
  res.writeHead(status, headers);
  if (res.req?.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  createReadStream(filePath, status === 206 ? { start, end } : undefined)
    .on('error', () => {
      if (!res.writableEnded) res.destroy();
    })
    .pipe(res);
}

async function handleParse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let target: VideoTarget | null = null;
  try {
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text : '';
    target = requireTarget(text);
    const preview =
      target.platform === 'douyin'
        ? await resolveDouyinPreview(target.url)
        : await resolveBilibiliPreview(target.url);
    json(res, 200, preview);
  } catch (error) {
    const message = target ? enrichError(target.platform, error) : friendlyError(error);
    json(res, statusFor(error), { error: message });
  }
}

async function handleDownload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (error) {
    json(res, statusFor(error), { error: friendlyError(error) });
    return;
  }

  let target: VideoTarget;
  try {
    target = requireTarget(typeof body.text === 'string' ? body.text : '');
  } catch (error) {
    json(res, statusFor(error), { error: friendlyError(error) });
    return;
  }

  const quality = typeof body.quality === 'string' ? body.quality : '';
  const requestedPage =
    typeof body.page === 'number' && Number.isFinite(body.page) ? Math.floor(body.page) : 0;

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive'
  });
  sendEvent(res, {
    type: 'start',
    platform: target.platform,
    platformLabel: platformLabel(target.platform),
    url: target.url
  });

  let partialPath = '';
  try {
    sendEvent(res, { type: 'log', message: '正在获取视频信息…' });

    let title = '';
    let author = '';
    let id = '';
    let baseName = '';
    let plan: MediaPlan;

    if (target.platform === 'douyin') {
      const video = await resolveDouyin(target.url);
      title = video.title;
      author = video.author;
      id = video.id;
      sendEvent(res, {
        type: 'metadata',
        platform: 'douyin',
        title,
        author,
        duration: video.duration,
        id,
        page: 1,
        pages: 1,
        pageTitle: video.title
      });
      plan = douyinMediaPlan(video);
      baseName = buildBaseName('douyin', title, id, 1, 1);
    } else {
      const video = await resolveBilibili(target.url);
      if (requestedPage > 0 && requestedPage !== video.selectedPage) {
        const page = video.pages[Math.min(requestedPage, video.pages.length) - 1];
        video.selectedPage = page.index;
        video.cid = page.cid;
        video.duration = page.duration;
        video.pageUrl =
          video.pages.length > 1
            ? `https://www.bilibili.com/video/${video.bvid}/?p=${page.index}`
            : `https://www.bilibili.com/video/${video.bvid}/`;
      }

      const pageInfo = video.pages[video.selectedPage - 1];
      title = video.title;
      author = video.author;
      id = video.bvid;
      sendEvent(res, {
        type: 'metadata',
        platform: 'bilibili',
        title,
        author,
        duration: video.duration,
        id,
        page: video.selectedPage,
        pages: video.pages.length,
        pageTitle: pageInfo?.title || '',
        stats: video.stats
      });
      sendEvent(res, { type: 'log', message: '正在获取 B 站播放地址…' });
      plan = await bilibiliMediaPlan(video, quality);
      sendEvent(res, { type: 'quality', label: plan.qualityLabel });
      baseName = buildBaseName('bilibili', title, id, video.selectedPage, video.pages.length);
    }

    const finalPath = uniqueVideoPath(baseName);
    partialPath = `${finalPath}.part`;
    await downloadPlan(plan, { res, partialPath });

    renameSync(partialPath, finalPath);
    partialPath = '';

    const filename = basename(finalPath);
    sendEvent(res, {
      type: 'complete',
      filename,
      url: `/downloads/${encodeURIComponent(filename)}`,
      size: statSync(finalPath).size,
      platform: target.platform
    });
  } catch (error) {
    sendEvent(res, { type: 'error', message: enrichError(target.platform, error) });
  } finally {
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

function handleReveal(res: ServerResponse): void {
  const command =
    process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [DOWNLOAD_DIR], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    json(res, 200, { ok: true });
  } catch {
    json(res, 502, { error: '无法打开下载文件夹，请手动打开项目中的 downloads 目录。' });
  }
}

function openBrowser(): void {
  if (process.env.OPEN_BROWSER !== '1') return;
  const url = `http://${HOST}:${PORT}`;
  const command =
    process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Opening a browser is a convenience, never a fatal error.
  }
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return (host === '127.0.0.1' || host === 'localhost') && port === PORT;
  } catch {
    return false;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = normalize(requestUrl.pathname).replace(/\\/g, '/');

  if (req.method === 'POST' && !isAllowedOrigin(req.headers.origin)) {
    json(res, 403, { error: '拒绝来自其他网站的请求。' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    json(res, 200, { ready: true, version: VERSION, platforms: ['douyin', 'bilibili'] });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/downloads') {
    json(res, 200, { files: listDownloads() });
    return;
  }
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    serveFile(res, join(PUBLIC_DIR, 'favicon.svg'));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/parse') {
    await handleParse(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/download') {
    await handleDownload(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/reveal') {
    handleReveal(res);
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/downloads/')) {
    const filePath = safeDownloadPath(pathname);
    if (!filePath) {
      json(res, 400, { error: '无效文件名' });
      return;
    }
    serveFile(res, filePath, requestUrl.searchParams.get('download') === '1');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: '不支持的请求方式' });
    return;
  }

  const publicPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(PUBLIC_DIR, publicPath);
  if (relative(PUBLIC_DIR, filePath).startsWith('..')) {
    json(res, 403, { error: '禁止访问' });
    return;
  }
  serveFile(res, filePath);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    console.error('请求处理失败：', error);
    if (!res.headersSent) json(res, 500, { error: '服务器内部错误，请稍后重试。' });
    else if (!res.writableEnded && !res.destroyed) res.end();
  });
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被其他程序占用。`);
    console.error('请关闭占用该端口的程序，或设置环境变量 PORT 使用其他端口后重试。');
  } else {
    console.error('服务器启动失败：', error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log('视频下载器已启动：http://127.0.0.1:' + PORT);
  console.log('支持平台：抖音、哔哩哔哩');
  console.log('请保持此窗口开启，然后在浏览器中使用上面的地址。');
  openBrowser();
});
