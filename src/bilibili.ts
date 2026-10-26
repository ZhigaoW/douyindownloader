import { DESKTOP_UA, UserError, fetchJson, fetchWithTimeout, upgradeToHttps } from './http.ts';
import { fetchCoverDataUri } from './cover.ts';
import { isBilibiliHost, isBilibiliShortHost } from './input.ts';
import type { MediaPlan, PageOption, QualityOption, VideoPreview } from './types.ts';

const VIEW_API = 'https://api.bilibili.com/x/web-interface/view';
const PLAY_API = 'https://api.bilibili.com/x/player/playurl';

type BiliResponse<T> = {
  code: number;
  message?: string;
  data?: T;
};

type ViewData = {
  bvid?: string;
  aid?: number;
  cid?: number;
  title?: string;
  pic?: string;
  desc?: string;
  duration?: number;
  pubdate?: number;
  owner?: { name?: string };
  stat?: { view?: number };
  pages?: Array<{ cid?: number; page?: number; part?: string; duration?: number }>;
  videos?: number;
};

type PlayPart = {
  order?: number;
  size?: number;
  url: string;
  backup_url?: string[] | null;
  length?: number;
};

type PlayData = {
  quality: number;
  accept_quality?: number[];
  accept_description?: string[];
  timelength?: number;
  durl?: PlayPart[];
  dash?: unknown;
};

type VideoTargetId = { bvid?: string; aid?: number; page: number };

const QUALITY_LABELS: Record<number, string> = {
  127: '超高清 8K',
  126: '杜比视界',
  125: 'HDR 真彩',
  120: '超清 4K',
  116: '高清 1080P60',
  112: '高清 1080P+',
  80: '高清 1080P',
  74: '高清 720P60',
  64: '高清 720P',
  32: '清晰 480P',
  16: '流畅 360P',
  6: '极速 240P'
};

function apiHeaders(referer = 'https://www.bilibili.com/'): Record<string, string> {
  return {
    'user-agent': DESKTOP_UA,
    referer,
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9'
  };
}

function explainBiliError(code: number, message?: string): string {
  switch (code) {
    case -400:
      return '视频地址不正确，请检查链接后重试。';
    case -403:
      return 'B 站拒绝访问该视频，可能需要登录或权限不足。';
    case -404:
      return '视频不存在或已被删除。';
    case -352:
      return 'B 站风控校验未通过，请稍后重试。';
    case -10403:
      return '该视频存在地区限制，当前网络无法访问。';
    case -10404:
      return '该视频需要大会员或付费权限，暂不支持下载。';
    case 62002:
      return '该视频仅限大会员观看，暂不支持下载。';
    case 62004:
      return '该视频需要付费观看，暂不支持下载。';
    case 87007:
      return '该视频为充电专属内容，暂不支持下载。';
    case 87008:
      return '该视频为付费内容，暂不支持下载。';
    default:
      return message
        ? `B 站接口返回错误：${message}（${code}）`
        : `B 站接口返回错误（${code}）`;
  }
}

function formatCount(value: number | undefined): string {
  if (!value || value <= 0) return '';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
      .format(new Date(timestamp * 1000))
      .replace(/\//g, '-');
  } catch {
    return '';
  }
}

function buildStats(data: ViewData): string {
  const parts: string[] = [];
  const views = formatCount(data.stat?.view);
  if (views) parts.push(`${views} 播放`);
  const date = formatDate(data.pubdate);
  if (date) parts.push(date);
  return parts.join(' · ');
}

function parsePageNumber(value: string | null): number {
  if (!value) return 1;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

async function followShortLink(inputUrl: string): Promise<string> {
  let current = inputUrl;

  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetchWithTimeout(
      current,
      {
        redirect: 'manual',
        headers: { 'user-agent': DESKTOP_UA, accept: 'text/html,application/xhtml+xml' }
      },
      15_000
    );

    const location = response.headers.get('location');
    if (!location) {
      if (response.ok) {
        const html = await response.text();
        const found = html.match(
          /https?:\\?\/\\?\/(?:www|m)\.bilibili\.com\\?\/video\\?\/(?:BV[0-9A-Za-z]{10}|av\d+)/i
        )?.[0];
        if (found) return found.replace(/\\\//g, '/');
      }
      break;
    }

    current = new URL(location, current).toString();
    const host = new URL(current).hostname;
    if (!isBilibiliHost(host)) {
      throw new UserError('B 站短链接跳转到了非 B 站地址，请检查链接。', 422);
    }
    if (!isBilibiliShortHost(host)) break;
  }

  return current;
}

async function resolveVideoTarget(input: string): Promise<VideoTargetId> {
  const trimmed = input.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    const bv = trimmed.match(/^(BV[0-9A-Za-z]{10})$/i)?.[1];
    if (bv) return { bvid: bv, page: 1 };
    const aid = trimmed.match(/^av(\d+)$/i)?.[1];
    if (aid) return { aid: Number(aid), page: 1 };
    throw new UserError('无法识别 B 站视频链接，请粘贴完整的视频地址。', 400);
  }

  if (isBilibiliShortHost(url.hostname)) {
    url = new URL(await followShortLink(url.toString()));
  } else if (!isBilibiliHost(url.hostname)) {
    throw new UserError('这不是 B 站链接，请检查后重试。', 400);
  }

  const path = url.pathname;
  if (/\/bangumi\//i.test(path) || /\/cheese\//i.test(path)) {
    throw new UserError('暂不支持番剧、影视和课堂等付费内容，目前仅支持普通投稿视频。', 422);
  }
  if (/^\/live\//i.test(path)) {
    throw new UserError('暂不支持直播内容。', 422);
  }
  if (/^\/(read|opus)\//i.test(path)) {
    throw new UserError('暂不支持图文 / 专栏内容。', 422);
  }

  const page = parsePageNumber(url.searchParams.get('p') || url.searchParams.get('page'));
  const bv = path.match(/\/video\/(BV[0-9A-Za-z]{10})/i)?.[1];
  if (bv) return { bvid: bv, page };

  const aid = path.match(/\/video\/av(\d+)/i)?.[1];
  if (aid) return { aid: Number(aid), page };

  throw new UserError('链接里没有找到视频 ID，请粘贴具体的视频播放页地址。', 422);
}

async function fetchView(target: VideoTargetId): Promise<ViewData> {
  const query =
    target.bvid !== undefined
      ? `bvid=${encodeURIComponent(target.bvid)}`
      : `aid=${encodeURIComponent(String(target.aid || 0))}`;
  const payload = await fetchJson<BiliResponse<ViewData>>(`${VIEW_API}?${query}`, {
    headers: apiHeaders()
  });

  if (payload.code !== 0 || !payload.data) {
    throw new UserError(explainBiliError(payload.code, payload.message), payload.code === -404 ? 404 : 422);
  }
  return payload.data;
}

async function fetchPlayInfo(
  bvid: string,
  cid: number,
  qn: number,
  fnval: number
): Promise<PlayData> {
  const params = new URLSearchParams({
    bvid,
    cid: String(cid),
    qn: String(qn),
    fnval: String(fnval),
    fourk: '1',
    platform: 'pc',
    high_quality: '1'
  });
  const referer = `https://www.bilibili.com/video/${bvid}/`;
  const payload = await fetchJson<BiliResponse<PlayData>>(`${PLAY_API}?${params.toString()}`, {
    headers: apiHeaders(referer)
  }, 25_000);

  if (payload.code !== 0 || !payload.data) {
    throw new UserError(explainBiliError(payload.code, payload.message), 422);
  }
  return payload.data;
}

function describeQuality(qn: number, play?: PlayData): string {
  const index = play?.accept_quality?.indexOf(qn) ?? -1;
  if (index >= 0 && play?.accept_description?.[index]) return play.accept_description[index];
  return QUALITY_LABELS[qn] || `清晰度 ${qn}`;
}

function buildQualityOptions(play: PlayData): QualityOption[] {
  const qnList =
    play.accept_quality && play.accept_quality.length ? play.accept_quality : [play.quality];
  const seen = new Set<number>();
  const options: QualityOption[] = [];

  for (const qn of qnList) {
    if (!Number.isFinite(qn) || seen.has(qn)) continue;
    seen.add(qn);
    options.push({
      value: String(qn),
      label: describeQuality(qn, play),
      recommended: qn === play.quality
    });
  }

  if (!options.length) {
    options.push({
      value: String(play.quality),
      label: describeQuality(play.quality, play),
      recommended: true
    });
  }

  return options.sort((a, b) => Number(b.value) - Number(a.value));
}

function normalizePages(data: ViewData, bvid: string): PageOption[] {
  const rawPages = Array.isArray(data.pages) ? data.pages : [];
  if (!rawPages.length) {
    return [
      {
        index: 1,
        title: (data.title || bvid).trim(),
        duration: Number(data.duration || 0),
        cid: Number(data.cid || 0)
      }
    ];
  }

  return rawPages.map((page, index) => ({
    index: index + 1,
    title: (page.part || data.title || `P${index + 1}`).trim(),
    duration: Number(page.duration || 0),
    cid: Number(page.cid || 0)
  }));
}

export type BilibiliVideo = {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  author: string;
  coverUrl: string;
  duration: number;
  description: string;
  stats: string;
  pages: PageOption[];
  selectedPage: number;
  pageUrl: string;
};

export async function resolveBilibili(input: string): Promise<BilibiliVideo> {
  const target = await resolveVideoTarget(input);
  const data = await fetchView(target);
  const bvid = (data.bvid || target.bvid || '').trim();
  if (!bvid) throw new UserError('B 站没有返回视频编号，请检查链接。', 422);

  const pages = normalizePages(data, bvid);
  const selectedPage = Math.min(Math.max(1, target.page), pages.length);
  const page = pages[selectedPage - 1];
  if (!page.cid) throw new UserError('没有找到该分 P 的视频信息，请稍后重试。', 422);

  const pageUrl =
    pages.length > 1
      ? `https://www.bilibili.com/video/${bvid}/?p=${selectedPage}`
      : `https://www.bilibili.com/video/${bvid}/`;

  return {
    bvid,
    aid: Number(data.aid || target.aid || 0),
    cid: page.cid,
    title: (data.title || `B 站视频 ${bvid}`).trim(),
    author: data.owner?.name || '',
    coverUrl: upgradeToHttps(data.pic || ''),
    duration: Number(page.duration || data.duration || 0),
    description: (data.desc || '').replace(/\s+/g, ' ').trim(),
    stats: buildStats(data),
    pages,
    selectedPage,
    pageUrl
  };
}

export async function resolveBilibiliPreview(input: string): Promise<VideoPreview> {
  const video = await resolveBilibili(input);
  const play = await fetchPlayInfo(video.bvid, video.cid, 127, 1);
  if (!play.durl?.length) {
    throw new UserError('该视频只提供音视频分离格式，暂不支持下载。', 422);
  }

  const qualities = buildQualityOptions(play);
  const topQuality = qualities[0];
  const cover = await fetchCoverDataUri(video.coverUrl, video.pageUrl);

  return {
    platform: 'bilibili',
    id: video.bvid,
    url: video.pageUrl,
    title: video.title,
    author: video.author,
    cover,
    duration: video.duration,
    stats: video.stats,
    description: [...video.description].slice(0, 240).join(''),
    pages: video.pages,
    selectedPage: video.selectedPage,
    qualities,
    defaultQuality: String(play.quality),
    note: `未登录 B 站时可获取「${topQuality?.label || '当前清晰度'}」，更高清晰度需要登录，暂不支持。`
  };
}

export async function bilibiliMediaPlan(
  video: BilibiliVideo,
  qualityValue?: string
): Promise<MediaPlan> {
  const requested = Number.parseInt(qualityValue || '', 10);
  const qn = Number.isFinite(requested) && requested > 0 ? requested : 64;
  const play = await fetchPlayInfo(video.bvid, video.cid, qn, 1);

  if (!play.durl?.length) {
    throw new UserError('B 站没有返回可下载的视频地址，该视频可能受限。', 422);
  }

  const headers: Record<string, string> = {
    'user-agent': DESKTOP_UA,
    referer: video.pageUrl,
    origin: 'https://www.bilibili.com',
    accept: '*/*'
  };

  return {
    qualityLabel: describeQuality(play.quality, play),
    segments: play.durl.map((part) => ({
      url: upgradeToHttps(part.url),
      backupUrls: (part.backup_url || []).map(upgradeToHttps),
      size: Number(part.size || 0),
      headers
    }))
  };
}
