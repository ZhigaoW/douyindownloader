export type Platform = 'douyin' | 'bilibili';

export type QualityOption = {
  value: string;
  label: string;
  recommended?: boolean;
};

export type PageOption = {
  index: number;
  title: string;
  duration: number;
  cid: number;
};

export type VideoPreview = {
  platform: Platform;
  id: string;
  url: string;
  title: string;
  author: string;
  cover?: string;
  duration: number;
  stats: string;
  description: string;
  pages: PageOption[];
  selectedPage: number;
  qualities: QualityOption[];
  defaultQuality: string;
  note: string;
};

export type MediaSegment = {
  url: string;
  backupUrls: string[];
  size: number;
  headers: Record<string, string>;
};

export type MediaPlan = {
  qualityLabel: string;
  segments: MediaSegment[];
};
