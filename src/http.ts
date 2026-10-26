export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class UserError extends Error {
  status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
  timeout = 20_000
): Promise<T> {
  const response = await fetchWithTimeout(url, options, timeout);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UserError(`服务器返回了无法识别的内容（HTTP ${response.status}），请稍后重试。`, 502);
  }
}

export function upgradeToHttps(value: string): string {
  if (value.startsWith('//')) return `https:${value}`;
  return value.replace(/^http:\/\//i, 'https://');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|abort/i.test(error.message));
}
