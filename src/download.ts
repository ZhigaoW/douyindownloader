import { createWriteStream, existsSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { MediaPlan, MediaSegment } from './types.ts';
import { UserError, fetchWithTimeout } from './http.ts';

const IDLE_TIMEOUT_MS = 25_000;
const TEST_TIMEOUT_MS = 9_000;
const TEST_BYTES = 512 * 1024;

type RouteCandidate = {
  url: string;
  speed: number;
  total: number;
};

type Tracker = {
  completedBytes: number;
  totalBytes: number;
  label: string;
};

export function sendEvent(res: ServerResponse, event: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`${JSON.stringify(event)}\n`);
}

function totalFromHeaders(headers: Headers): number {
  const contentRange = headers.get('content-range');
  const rangedTotal = contentRange?.match(/\/(\d+)$/)?.[1];
  return Number(rangedTotal || headers.get('content-length') || 0);
}

function formatSpeed(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function candidateUrls(segment: MediaSegment): string[] {
  return [...new Set([segment.url, ...segment.backupUrls].filter(Boolean))];
}

async function testRoute(
  url: string,
  headers: Record<string, string>
): Promise<RouteCandidate | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let received = 0;
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { ...headers, range: `bytes=0-${TEST_BYTES - 1}` }
    });
    if (!response.ok || !response.body) return null;
    total = totalFromHeaders(response.headers);
    reader = response.body.getReader();
    while (received < TEST_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
    }
  } catch {
    if (received === 0) return null;
  } finally {
    clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {
      // The stream may already be closed.
    }
  }

  if (received === 0) return null;
  const seconds = Math.max(0.15, (Date.now() - startedAt) / 1000);
  return { url, speed: received / seconds, total };
}

async function rankRoutes(segment: MediaSegment): Promise<RouteCandidate[]> {
  const urls = candidateUrls(segment);
  const results = await Promise.all(urls.map((url) => testRoute(url, segment.headers)));
  const routes = results
    .filter((route): route is RouteCandidate => route !== null && route.speed > 0)
    .sort((a, b) => b.speed - a.speed);

  if (!routes.length) {
    throw new UserError('所有下载线路都无法连接，请稍后重试。', 502);
  }
  return routes;
}

function sendProgress(
  res: ServerResponse,
  tracker: Tracker,
  receivedInSegment: number,
  speed: number
): void {
  const overallReceived = tracker.completedBytes + receivedInSegment;
  const overallTotal = tracker.totalBytes;
  const percent = overallTotal > 0 ? Math.min(100, (overallReceived / overallTotal) * 100) : null;
  const eta =
    overallTotal > 0 && speed > 0 ? Math.max(0, (overallTotal - overallReceived) / speed) : 0;

  sendEvent(res, {
    type: 'progress',
    percent: percent === null ? '' : percent.toFixed(1),
    speed: speed > 0 ? formatSpeed(speed) : '',
    eta: eta > 0 ? `${Math.ceil(eta)} 秒` : '',
    received: overallReceived,
    total: overallTotal,
    stage: tracker.label
  });
}

async function closeWriteStream(file: ReturnType<typeof createWriteStream>): Promise<void> {
  file.destroy();
  if (file.closed) return;
  try {
    await once(file, 'close');
  } catch {
    // Ignore close errors, the caller will report the original failure.
  }
}

async function streamToFile(args: {
  res: ServerResponse;
  segment: MediaSegment;
  route: RouteCandidate;
  partialPath: string;
  allowResume: boolean;
  append: boolean;
  tracker: Tracker;
}): Promise<number> {
  const { res, segment, route, partialPath, allowResume, tracker } = args;
  let resumeFrom = 0;
  if (allowResume && existsSync(partialPath)) resumeFrom = statSync(partialPath).size;
  if (allowResume && route.total > 0 && resumeFrom === route.total) return resumeFrom;

  const headers: Record<string, string> = { ...segment.headers };
  if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;

  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  armIdle();

  let response: Response;
  try {
    response = await fetch(route.url, { signal: controller.signal, headers });
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    throw error;
  }

  if (response.status === 416 && resumeFrom > 0) {
    if (idleTimer) clearTimeout(idleTimer);
    return resumeFrom;
  }
  if (!response.ok || !response.body) {
    if (idleTimer) clearTimeout(idleTimer);
    throw new UserError(`下载线路返回 HTTP ${response.status}`, 502);
  }

  const acceptsRange = resumeFrom > 0 && response.status === 206;
  if (resumeFrom > 0 && !acceptsRange) resumeFrom = 0;
  const append =
    acceptsRange || (!allowResume && args.append && existsSync(partialPath));

  const total = totalFromHeaders(response.headers) || route.total || segment.size || 0;
  const file = createWriteStream(partialPath, { flags: append ? 'a' : 'w' });
  file.on('error', () => undefined);

  let received = resumeFrom;
  let sessionReceived = 0;
  let lastReport = 0;
  const startedAt = Date.now();

  try {
    const stream = response.body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
    for await (const chunk of stream) {
      if (res.destroyed) throw new UserError('下载已取消', 499);
      armIdle();
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      sessionReceived += buffer.length;
      if (!file.write(buffer)) await once(file, 'drain');

      const now = Date.now();
      if (now - lastReport > 350) {
        const elapsed = Math.max(0.2, (now - startedAt) / 1000);
        const reliableSpeed = sessionReceived >= 512 * 1024 || elapsed >= 1.0;
        sendProgress(res, tracker, received, reliableSpeed ? sessionReceived / elapsed : 0);
        lastReport = now;
      }
    }

    file.end();
    await once(file, 'finish');
    if (!file.closed) await once(file, 'close');
  } catch (error) {
    await closeWriteStream(file);
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  const elapsed = Math.max(0.2, (Date.now() - startedAt) / 1000);
  const reliableSpeed =
    sessionReceived >= 512 * 1024 || received >= (route.total || segment.size || 0);
  sendProgress(res, tracker, received, reliableSpeed ? sessionReceived / elapsed : 0);

  if (total > 0 && received < total) {
    throw new UserError('下载连接提前结束，准备续传…', 502);
  }
  return received;
}

async function downloadSingle(
  plan: MediaPlan,
  res: ServerResponse,
  partialPath: string
): Promise<void> {
  const segment = plan.segments[0];
  if (existsSync(partialPath)) {
    const partialSize = statSync(partialPath).size;
    if (partialSize > 0) {
      sendEvent(res, {
        type: 'log',
        message: `检测到未完成的下载（${formatBytes(partialSize)}），将从断点继续…`
      });
    }
  }
  sendEvent(res, { type: 'route_test', message: '正在测试下载线路速度…' });
  const routes = await rankRoutes(segment);
  const best = routes[0];
  const total = best.total || segment.size || 0;

  sendEvent(res, {
    type: 'route_selected',
    line: 1,
    speed: formatSpeed(best.speed),
    total,
    routes: routes.length
  });
  sendEvent(res, { type: 'log', message: `线路测速完成，正在保存「${plan.qualityLabel}」…` });

  const tracker: Tracker = { completedBytes: 0, totalBytes: total, label: plan.qualityLabel };
  let lastError: unknown;

  for (const [index, route] of routes.entries()) {
    if (res.destroyed) throw new UserError('下载已取消', 499);
    if (index > 0) {
      sendEvent(res, { type: 'log', message: '当前线路中断，正在切换备用线路…' });
    }
    try {
      await streamToFile({
        res,
        segment,
        route,
        partialPath,
        allowResume: true,
        append: false,
        tracker
      });
      return;
    } catch (error) {
      if (res.destroyed) throw new UserError('下载已取消', 499);
      lastError = error;
    }
  }

  throw lastError ?? new UserError('所有下载线路均已中断，请稍后重试。', 502);
}

async function probeSize(segment: MediaSegment): Promise<number> {
  if (segment.size > 0) return segment.size;
  try {
    const response = await fetchWithTimeout(
      segment.url,
      { method: 'HEAD', headers: segment.headers },
      8_000
    );
    return totalFromHeaders(response.headers);
  } catch {
    return 0;
  }
}

async function downloadMultiple(
  plan: MediaPlan,
  res: ServerResponse,
  partialPath: string
): Promise<void> {
  const segments = plan.segments;
  if (existsSync(partialPath)) unlinkSync(partialPath);

  sendEvent(res, { type: 'route_test', message: `正在准备 ${segments.length} 段视频…` });
  const sizes = await Promise.all(segments.map((segment) => probeSize(segment)));
  const totalBytes = sizes.every((size) => size > 0)
    ? sizes.reduce((sum, size) => sum + size, 0)
    : 0;

  const firstRoutes = await rankRoutes(segments[0]);
  sendEvent(res, {
    type: 'route_selected',
    line: 1,
    speed: formatSpeed(firstRoutes[0].speed),
    total: totalBytes,
    routes: firstRoutes.length
  });

  let completedBytes = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const routes: RouteCandidate[] =
      index === 0
        ? firstRoutes
        : candidateUrls(segment).map((url) => ({ url, speed: 0, total: segment.size }));
    const tracker: Tracker = {
      completedBytes,
      totalBytes,
      label: `${plan.qualityLabel} · 第 ${index + 1}/${segments.length} 段`
    };

    sendEvent(res, {
      type: 'log',
      message: `正在保存第 ${index + 1}/${segments.length} 段…`
    });

    let completed = false;
    let lastError: unknown;

    for (const route of routes) {
      if (res.destroyed) throw new UserError('下载已取消', 499);
      try {
        await streamToFile({
          res,
          segment,
          route,
          partialPath,
          allowResume: false,
          append: completedBytes > 0,
          tracker
        });
        completed = true;
        break;
      } catch (error) {
        if (res.destroyed) throw new UserError('下载已取消', 499);
        lastError = error;
        if (existsSync(partialPath) && statSync(partialPath).size > completedBytes) {
          truncateSync(partialPath, completedBytes);
        }
        sendEvent(res, { type: 'log', message: '该段下载中断，正在重试…' });
      }
    }

    if (!completed) {
      throw lastError ?? new UserError(`第 ${index + 1} 段下载失败，请稍后重试。`, 502);
    }

    const actualSize = existsSync(partialPath) ? statSync(partialPath).size : 0;
    const expectedSize = sizes[index] || 0;
    if (expectedSize > 0 && actualSize !== completedBytes + expectedSize) {
      throw new UserError('视频分段校验失败，请重新下载。', 502);
    }
    completedBytes = actualSize;
  }
}

export async function downloadPlan(
  plan: MediaPlan,
  options: { res: ServerResponse; partialPath: string }
): Promise<void> {
  if (!plan.segments.length) throw new UserError('没有找到可下载的视频地址。', 422);
  if (plan.segments.length === 1) {
    await downloadSingle(plan, options.res, options.partialPath);
  } else {
    await downloadMultiple(plan, options.res, options.partialPath);
  }
}
