import { MOBILE_UA, UserError, fetchWithTimeout, upgradeToHttps } from './http.ts';
import { fetchCoverDataUri } from './cover.ts';
import type { MediaPlan, VideoPreview } from './types.ts';

const SHARE_HOST = 'https://www.iesdouyin.com';

type DouyinItem = {
  aweme_id?: string;
  desc?: string;
  create_time?: number;
  images?: unknown[];
  image_post_info?: unknown;
  author?: { nickname?: string };
  statistics?: { play_count?: number; digg_count?: number };
  video?: {
    duration?: number;
    cover?: { url_list?: string[] };
    origin_cover?: { url_list?: string[] };
    play_addr?: { url_list?: string[] };
  };
  cover?: { url_list?: string[] };
};

export type DouyinVideo = {
  id: string;
  title: string;
  author: string;
  coverUrl: string;
  duration: number;
  stats: string;
  description: string;
  mediaUrls: string[];
  headers: Record<string, string>;
  pageUrl: string;
};

function formatCount(value: number | undefined): string {
  if (!value || value <= 0) return '';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

async function getSharePageUrl(inputUrl: string): Promise<string> {
  const parsed = new URL(inputUrl);
  if (/\/(?:note|slides)\//i.test(parsed.pathname)) {
    throw new UserError('该链接是图文作品，暂不支持下载。', 422);
  }

  const directId =
    parsed.pathname.match(/\/(?:video|note|slides)\/(\d+)/)?.[1] ||
    parsed.searchParams.get('modal_id')?.match(/^\d+$/)?.[0];
  if (directId) return `${SHARE_HOST}/share/video/${directId}/`;

  const response = await fetchWithTimeout(inputUrl, {
    redirect: 'manual',
    headers: { 'user-agent': MOBILE_UA, accept: 'text/html' }
  });
  const location = response.headers.get('location');
  if (!location) {
    if (response.ok) return inputUrl;
    throw new UserError('短链接没有返回有效的视频地址，请检查链接后重试。', 422);
  }

  const redirected = new URL(location, inputUrl).toString();
  const redirectedUrl = new URL(redirected);
  if (
    /\/(?:note|slides)\//i.test(redirectedUrl.pathname) ||
    /[?&]is_slides=1(?:&|$)/.test(redirectedUrl.search)
  ) {
    throw new UserError('该链接是图文作品，暂不支持下载。', 422);
  }

  const redirectedId =
    redirected.match(/\/(?:video|note|slides)\/(\d+)/)?.[1] ||
    redirected.match(/[?&]modal_id=(\d+)/)?.[1];
  if (redirected.includes('iesdouyin.com/share/video/') && redirectedId) {
    return `${SHARE_HOST}/share/video/${redirectedId}/`;
  }
  if (redirectedId) return `${SHARE_HOST}/share/video/${redirectedId}/`;
  throw new UserError('该分享链接不是可下载的抖音视频，可能指向图文或直播内容。', 422);
}

function findVideoPageData(loaderData: Record<string, unknown>): Record<string, unknown> | null {
  for (const [key, value] of Object.entries(loaderData)) {
    if (key.includes('video_') && value && typeof value === 'object') {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function buildLineUrls(mediaUrl: string): string[] {
  const base = upgradeToHttps(mediaUrl).replace('/playwm/', '/play/');
  const urls: string[] = [];
  for (const line of [0, 1, 2]) {
    const candidate = new URL(base);
    candidate.searchParams.set('line', String(line));
    urls.push(candidate.toString());
  }
  return [...new Set(urls)];
}

export async function resolveDouyin(inputUrl: string): Promise<DouyinVideo> {
  const shareUrl = await getSharePageUrl(inputUrl);
  const response = await fetchWithTimeout(shareUrl, {
    headers: { 'user-agent': MOBILE_UA, accept: 'text/html,application/xhtml+xml' }
  });
  if (!response.ok) {
    throw new UserError(`抖音分享页面访问失败（HTTP ${response.status}），请稍后重试。`, 502);
  }

  const html = await response.text();
  const match = html.match(/window\._ROUTER_DATA\s*=\s*({.*?})\s*<\/script>/s);
  if (!match) {
    throw new UserError('抖音没有返回视频信息，可能需要先在浏览器中通过验证', 502);
  }

  let routerData: { loaderData?: Record<string, unknown> };
  try {
    routerData = JSON.parse(match[1]) as { loaderData?: Record<string, unknown> };
  } catch {
    throw new UserError('抖音返回的视频信息无法解析，请稍后重试。', 502);
  }

  const pageData = findVideoPageData(routerData.loaderData || {});
  const videoInfoRes = pageData?.videoInfoRes as
    | { item_list?: DouyinItem[]; filter_list?: Array<{ detail_msg?: string; filter_reason?: string }> }
    | undefined;
  const item = videoInfoRes?.item_list?.[0];

  if (!item) {
    const reason = videoInfoRes?.filter_list?.[0];
    if (reason?.detail_msg) throw new UserError(`抖音无法解析该作品：${reason.detail_msg}`, 422);
    throw new UserError(
      '没有找到视频信息。抖音可能触发了风控验证，请先在浏览器中打开分享链接确认视频可播放，再回来重试。',
      422
    );
  }

  if (item.images?.length || item.image_post_info) {
    throw new UserError('该链接是图文作品，暂不支持下载。', 422);
  }

  const mediaUrl = item.video?.play_addr?.url_list?.[0];
  if (!mediaUrl) {
    throw new UserError('此分享内容不是普通公开视频，暂不支持图文、图文合集或受限作品。', 422);
  }

  const coverUrl = upgradeToHttps(
    item.video?.cover?.url_list?.[0] ||
      item.video?.origin_cover?.url_list?.[0] ||
      item.cover?.url_list?.[0] ||
      ''
  );
  const durationMs = Number(item.video?.duration || 0);
  const playCount = formatCount(item.statistics?.play_count);
  const awemeId = String(item.aweme_id || pageData?.itemId || Date.now());

  return {
    id: awemeId,
    title: String(item.desc || '抖音视频').trim(),
    author: item.author?.nickname || '',
    coverUrl,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    stats: playCount ? `${playCount} 播放` : '',
    description: '',
    mediaUrls: buildLineUrls(mediaUrl),
    headers: {
      'user-agent': MOBILE_UA,
      referer: 'https://www.douyin.com/',
      accept: '*/*'
    },
    pageUrl: `https://www.douyin.com/video/${awemeId}`
  };
}

export async function resolveDouyinPreview(inputUrl: string): Promise<VideoPreview> {
  const video = await resolveDouyin(inputUrl);
  const cover = await fetchCoverDataUri(video.coverUrl, 'https://www.douyin.com/');

  return {
    platform: 'douyin',
    id: video.id,
    url: video.pageUrl,
    title: video.title,
    author: video.author,
    cover,
    duration: video.duration,
    stats: video.stats,
    description: video.description,
    pages: [
      {
        index: 1,
        title: video.title || '视频',
        duration: video.duration,
        cid: 0
      }
    ],
    selectedPage: 1,
    qualities: [{ value: 'auto', label: '自动（最高清晰度）', recommended: true }],
    defaultQuality: 'auto',
    note: '抖音会自动请求当前可用的最高清晰度。'
  };
}

export function douyinMediaPlan(video: DouyinVideo): MediaPlan {
  const urls = [...new Set(video.mediaUrls.filter(Boolean))];
  if (!urls.length) throw new UserError('没有找到可下载的抖音视频地址。', 422);

  return {
    qualityLabel: '抖音原画（自动）',
    segments: [
      {
        url: urls[0],
        backupUrls: urls.slice(1),
        size: 0,
        headers: video.headers
      }
    ]
  };
}
