import { DESKTOP_UA, fetchWithTimeout, upgradeToHttps } from './http.ts';

const IMAGE_HOSTS = [
  'hdslb.com',
  'biliimg.com',
  'douyinpic.com',
  'byteimg.com',
  'pstatp.com',
  'douyinvod.com'
];

const MAX_COVER_BYTES = 4 * 1024 * 1024;

function isAllowedImageHost(host: string): boolean {
  return IMAGE_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export async function fetchCoverDataUri(
  rawUrl: string | undefined,
  referer: string
): Promise<string | undefined> {
  if (!rawUrl) return undefined;
  const url = upgradeToHttps(rawUrl.trim());
  if (!/^https:\/\//i.test(url)) return undefined;

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!isAllowedImageHost(host)) return undefined;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          'user-agent': DESKTOP_UA,
          referer,
          accept: 'image/avif,image/webp,image/jpeg,image/png'
        }
      },
      8_000
    );
    if (!response.ok) return undefined;

    const contentType = (response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!/^image\/(jpeg|jpg|png|webp|avif)$/.test(contentType)) return undefined;

    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_COVER_BYTES) return undefined;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_COVER_BYTES) return undefined;

    const mime = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return undefined;
  }
}
