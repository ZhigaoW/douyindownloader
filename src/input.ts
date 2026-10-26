import type { Platform } from './types.ts';
import { UserError } from './http.ts';

const URL_PATTERN = /https?:\/\/[!-~]+/gi;
const TRAILING_PUNCTUATION = /[)\]}>.,;:!?'"`]+$/;

const DOUYIN_DOMAINS = ['douyin.com', 'iesdouyin.com'];
const BILIBILI_DOMAINS = ['bilibili.com'];
const BILIBILI_SHORT_DOMAINS = ['b23.tv', 'bili2233.cn', 'bili22.cn', 'bili33.cn'];

export type VideoTarget = {
  platform: Platform;
  url: string;
};

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isDouyinHost(host: string): boolean {
  return hostMatches(host.toLowerCase(), DOUYIN_DOMAINS);
}

export function isBilibiliHost(host: string): boolean {
  const lower = host.toLowerCase();
  return hostMatches(lower, BILIBILI_DOMAINS) || BILIBILI_SHORT_DOMAINS.includes(lower);
}

export function isBilibiliShortHost(host: string): boolean {
  return BILIBILI_SHORT_DOMAINS.includes(host.toLowerCase());
}

export function platformLabel(platform: Platform): string {
  return platform === 'douyin' ? '抖音' : '哔哩哔哩';
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  const urls: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(TRAILING_PUNCTUATION, '');
    if (!cleaned) continue;
    try {
      const url = new URL(cleaned);
      url.hash = '';
      urls.push(url.toString());
    } catch {
      // Not a real URL, keep looking.
    }
  }
  return urls;
}

export function extractBvId(text: string): string | null {
  const match = text.match(/(?:^|[^0-9A-Za-z])(BV[0-9A-Za-z]{10})(?![0-9A-Za-z])/i);
  return match ? match[1] : null;
}

export function extractAvId(text: string): string | null {
  const match = text.match(/(?:^|[^0-9A-Za-z])av(\d{1,18})(?![0-9A-Za-z])/i);
  return match ? match[1] : null;
}

export function detectTarget(text: string): VideoTarget | null {
  for (const url of extractUrls(text)) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (isDouyinHost(host)) return { platform: 'douyin', url };
    if (isBilibiliHost(host)) return { platform: 'bilibili', url };
  }

  const bvId = extractBvId(text);
  if (bvId) return { platform: 'bilibili', url: `https://www.bilibili.com/video/${bvId}/` };

  const avId = extractAvId(text);
  if (avId) return { platform: 'bilibili', url: `https://www.bilibili.com/video/av${avId}/` };

  return null;
}

export function requireTarget(text: string): VideoTarget {
  const trimmed = text.trim();
  if (!trimmed) throw new UserError('请先粘贴视频链接或分享文案。', 400);
  const target = detectTarget(trimmed);
  if (!target) throw new UserError('没有识别到抖音或哔哩哔哩链接，请检查后重试。', 400);
  return target;
}
