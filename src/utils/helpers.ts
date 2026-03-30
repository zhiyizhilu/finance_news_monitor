import { v4 as uuidv4 } from 'uuid';

export function generateId(): string {
  return uuidv4();
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString();
}

export function parseDate(dateStr: string): Date {
  return new Date(dateStr);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 随机延迟
export function randomDelay(min: number = 2000, max: number = 5000): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(delay);
}

// User-Agent 轮换
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0'
];

export function getRandomUserAgent(): string {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// 清理HTML标签
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

// 截断文本
export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.substring(0, length) + '...';
}

// 关键词匹配
export function matchKeywords(text: string, keywords: string[], excludeKeywords: string[] = []): string[] {
  const matched: string[] = [];
  const lowerText = text.toLowerCase();

  // 先检查排除词
  for (const exclude of excludeKeywords) {
    if (lowerText.includes(exclude.toLowerCase())) {
      return []; // 包含排除词，不匹配
    }
  }

  // 匹配关键词
  for (const keyword of keywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      matched.push(keyword);
    }
  }

  return matched;
}

// 判断是否是工作日
export function isWeekday(): boolean {
  const day = new Date().getDay();
  return day !== 0 && day !== 6;
}

// 获取今天的日期字符串
export function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

// 获取设置
const settingsCache: Map<string, string> = new Map();

export async function getSetting(key: string): Promise<string | undefined> {
  // 先从缓存获取
  if (settingsCache.has(key)) {
    return settingsCache.get(key);
  }

  // 从数据库获取
  try {
    const { getDb } = await import('../config/database');
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;

    if (row) {
      settingsCache.set(key, row.value);
      return row.value;
    }
  } catch (error) {
    // 数据库可能还没初始化
  }

  // 从环境变量获取
  const envKey = key.toUpperCase();
  return process.env[envKey];
}

// 重新加载设置缓存
export function reloadSettings(): void {
  settingsCache.clear();
}
