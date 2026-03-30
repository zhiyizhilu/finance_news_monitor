import axios from 'axios';
import * as cheerio from 'cheerio';
import { parseStringPromise } from 'xml2js';
import { queryAll, queryOne, run, saveDb } from '../../config/database';
import { NewsSource, NewsArticle } from '../../types';
import { generateId, randomDelay, getRandomUserAgent, stripHtml, truncate } from '../../utils/helpers';

interface ParsedArticle {
  title: string;
  summary: string;
  url: string;
  publishTime: Date;
}

// 检测摘要是否有效（过滤掉包含多个标题的列表型摘要）
function isValidSummary(summary: string, title: string): boolean {
  if (!summary || summary.length < 10) return false;
  if (summary === title) return false;
  
  // 如果摘要包含数字序号（如 "1.", "2.", "①" 等），可能是新闻列表
  const listPattern = /\d+[\.、]|①|②|③|④|⑤/;
  if (listPattern.test(summary)) {
    return false;
  }
  
  // 如果摘要包含太多换行，可能是列表
  if (summary.split('\n').length > 3) {
    return false;
  }
  
  return true;
}

// 进度回调类型
export type ProgressCallback = (msg: string) => void;

// 从元素上下文中提取发布时间（尝试多种策略）
function extractPublishTime($: cheerio.CheerioAPI, $el: cheerio.Cheerio<any>): Date {
  // 策略1：查找父容器里的 <time> 标签（含 datetime 属性）
  const $container = $el.closest('li, div, article, tr, .item, .news-item, .list-item');
  const $timeEl = $container.find('time[datetime]').first();
  if ($timeEl.length) {
    const dt = $timeEl.attr('datetime');
    if (dt) {
      const d = new Date(dt);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // 策略2：查找父容器中形如 "2026-03-29" 或 "03-29 10:00" 或 "10:30" 的时间文本
  const containerText = $container.text();
  // 匹配常见中文新闻时间格式
  const patterns = [
    // yyyy-mm-dd hh:mm  或  yyyy/mm/dd hh:mm
    /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s+\d{1,2}:\d{2})/,
    // mm-dd hh:mm  或  mm/dd hh:mm
    /(\d{1,2}[-\/]\d{1,2}\s+\d{1,2}:\d{2})/,
    // yyyy-mm-dd
    /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/,
    // hh:mm（仅时间，用今天日期补全）
    /\b(\d{1,2}:\d{2})\b/
  ];

  for (const pat of patterns) {
    const m = containerText.match(pat);
    if (m) {
      const raw = m[1];
      // 仅时间格式：补今天日期
      if (/^\d{1,2}:\d{2}$/.test(raw)) {
        const today = new Date();
        const [h, min] = raw.split(':').map(Number);
        today.setHours(h, min, 0, 0);
        if (!isNaN(today.getTime())) return today;
      }
      // mm-dd hh:mm：补今年
      if (/^\d{1,2}[-\/]\d{1,2}\s+\d{1,2}:\d{2}$/.test(raw)) {
        const year = new Date().getFullYear();
        const normalized = raw.replace(/\//g, '-');
        const d = new Date(`${year}-${normalized}`);
        if (!isNaN(d.getTime())) return d;
      }
      // 标准格式直接解析
      const normalized = raw.replace(/\//g, '-');
      const d = new Date(normalized);
      if (!isNaN(d.getTime())) return d;
    }
  }

  // 策略3：查找父容器里的 data-time / data-publish 属性
  const dataTime = $container.find('[data-time],[data-publish],[data-date]').first();
  if (dataTime.length) {
    const val = dataTime.attr('data-time') || dataTime.attr('data-publish') || dataTime.attr('data-date');
    if (val) {
      const d = new Date(val.replace(/\//g, '-'));
      if (!isNaN(d.getTime())) return d;
    }
  }

  // 无法解析：返回当前时间作为兜底
  return new Date();
}

// JSON API 解析器（用于华尔街见闻等提供 JSON API 的源）
async function fetchApiArticles(source: NewsSource, onProgress?: ProgressCallback): Promise<ParsedArticle[]> {
  const articles: ParsedArticle[] = [];

  try {
    const response = await axios.get(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://wallstreetcn.com',
        'Accept': 'application/json'
      },
      timeout: 20000
    });

    const data = response.data;

    // 华尔街见闻：{ code, message, data: { items: [...], next_cursor } }
    const items: any[] = data?.data?.items || data?.data?.list || data?.items || data?.list || [];

    for (const item of items) {
      const title = truncate(stripHtml(item.title || ''), 200);
      const url = item.uri || item.url || item.link || '';
      let summary = truncate(stripHtml(
        item.content_short || item.summary || item.abstract || item.description || ''
      ), 300);
      
      // 验证摘要是否有效，无效则使用空字符串
      if (!isValidSummary(summary, title)) {
        summary = '';
      }

      // display_time 是 Unix 时间戳（秒）
      const ts = item.display_time || item.publish_time || item.created_at;
      const publishTime = ts
        ? new Date(ts > 1e10 ? ts : ts * 1000)  // 兼容毫秒和秒
        : new Date();

      if (!title || title.length < 4 || !url.startsWith('http')) continue;

      articles.push({ title, summary, url, publishTime: isNaN(publishTime.getTime()) ? new Date() : publishTime });
      if (articles.length >= 30) break;
    }

    onProgress?.(`  ✓ [${source.name}] 解析到 ${articles.length} 篇文章`);
    console.log(`  [${source.name}] 解析到 ${articles.length} 篇文章`);
  } catch (error) {
    const errMsg = (error as Error).message;
    onProgress?.(`  ✗ [${source.name}] API 抓取失败: ${errMsg}`);
    console.error(`  [${source.name}] API 抓取失败:`, errMsg);
  }

  return articles;
}

// RSS 解析器
async function fetchRssArticles(source: NewsSource, onProgress?: ProgressCallback): Promise<ParsedArticle[]> {
  const articles: ParsedArticle[] = [];

  try {
    const response = await axios.get(source.url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      },
      timeout: 20000
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false, trim: true });

    // 兼容 RSS 2.0 和 Atom
    const channel = parsed?.rss?.channel || parsed?.feed;
    const items: any[] = channel
      ? (Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [])
      : (Array.isArray(parsed?.feed?.entry) ? parsed.feed.entry : parsed?.feed?.entry ? [parsed.feed.entry] : []);

    for (const item of items) {
      const title = truncate(stripHtml(item.title?.$?._ || item.title?._ || item.title || ''), 200);
      const link = item.link?.$ ? item.link?.$?.href : (item.link || item.guid);
      let summary = truncate(stripHtml(
        item.description?._ || item.description ||
        item['content:encoded']?._ || item['content:encoded'] ||
        item.summary?._ || item.summary || ''
      ), 300);
      
      // 验证摘要是否有效，无效则使用空字符串
      if (!isValidSummary(summary, title)) {
        summary = '';
      }

      const pubDate = item.pubDate || item.published || item.updated || item['dc:date'];
      const publishTime = pubDate ? new Date(pubDate) : new Date();

      if (!title || title.length < 4 || !link) continue;

      const fullUrl = typeof link === 'string' ? link : (link?._ || '');
      if (!fullUrl.startsWith('http')) continue;

      articles.push({ title, summary, url: fullUrl, publishTime: isNaN(publishTime.getTime()) ? new Date() : publishTime });

      if (articles.length >= 30) break;
    }

    onProgress?.(`  ✓ [${source.name}] RSS 解析到 ${articles.length} 篇文章`);
    console.log(`  [${source.name}] RSS 解析到 ${articles.length} 篇文章`);
  } catch (error) {
    const errMsg = (error as Error).message;
    onProgress?.(`  ✗ [${source.name}] RSS 抓取失败: ${errMsg}`);
    console.error(`  [${source.name}] RSS 抓取失败:`, errMsg);
  }

  return articles;
}

// HTML 解析器 - 改进版，多选择器兜底
async function fetchHtmlArticles(source: NewsSource, onProgress?: ProgressCallback): Promise<ParsedArticle[]> {
  const articles: ParsedArticle[] = [];

  try {
    const response = await axios.get(source.url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      },
      timeout: 20000,
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);

    // 分层选择器：从精确到通用，不 break，全部收集后去重
    const selectors = [
      // 常见新闻网站专用选择器
      '.news-item a', '.article-item a', '.news-list a', '.article-list a',
      '.item-title a', '.news-title a', '.list-item a',
      // 通用标题标签
      'h3 a', 'h2 a', 'h4 a',
      // 含关键词的 href
      'a[href*="/article/"]', 'a[href*="/news/"]', 'a[href*="/detail/"]',
      'a[href*="/content/"]', 'a[href*="/story/"]', 'a[href*="/post/"]',
      // 兜底：所有链接（过滤短标题）
      'a'
    ];

    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();

    for (const selector of selectors) {
      $(selector).each((_, element) => {
        const $el = $(element);
        const href = $el.attr('href');
        const rawTitle = $el.text().trim();
        const title = truncate(stripHtml(rawTitle), 200);

        // 过滤：标题太短、无链接、JS 链接
        if (!href || !title || title.length < 6) return;
        if (href.includes('javascript') || href.startsWith('#') || href.startsWith('mailto')) return;

        let fullUrl = href;
        if (!href.startsWith('http')) {
          try {
            const urlObj = new URL(source.url);
            fullUrl = href.startsWith('/')
              ? `${urlObj.protocol}//${urlObj.host}${href}`
              : `${urlObj.protocol}//${urlObj.host}/${href}`;
          } catch {
            return;
          }
        }

        // 过滤：已见过的 URL 或标题
        if (seenUrls.has(fullUrl) || seenTitles.has(title)) return;

        // 过滤：明显是导航/广告的链接（标题含常见导航词）
        const navWords = ['登录', '注册', '首页', '关于我们', 'About', 'Login', 'Sign', 'Home', '返回'];
        if (navWords.some(w => title === w || title.toLowerCase() === w.toLowerCase())) return;

        seenUrls.add(fullUrl);
        seenTitles.add(title);

        // 尝试获取摘要：父节点文本 or title 属性
        const parentText = $el.parent().text().trim();
        const summary = truncate(stripHtml(
          parentText.length > title.length ? parentText : ($el.attr('title') || title)
        ), 300);

        // 尝试从父容器提取真实发布时间
        const publishTime = extractPublishTime($, $el);

        articles.push({
          title,
          summary,
          url: fullUrl,
          publishTime
        });
      });

      // 收集到足够多就停止（避免兜底选择器采集太多无关链接）
      if (articles.length >= 30) break;
    }

    const count = articles.length;
    onProgress?.(`  ✓ [${source.name}] 解析到 ${count} 篇文章`);
    console.log(`  [${source.name}] 解析到 ${count} 篇文章`);
  } catch (error) {
    const errMsg = (error as any).code === 'ECONNABORTED'
      ? '连接超时'
      : (error as Error).message;
    onProgress?.(`  ✗ [${source.name}] 抓取失败: ${errMsg}`);
    console.error(`  [${source.name}] 抓取失败:`, errMsg);
  }

  return articles;
}

// 保存文章到数据库
function saveArticles(source: NewsSource, articles: ParsedArticle[]): number {
  let savedCount = 0;

  for (const article of articles) {
    const existing = queryOne('SELECT id FROM articles WHERE url = ?', [article.url]);
    if (!existing) {
      run(
        'INSERT INTO articles (id, source, sourceName, title, summary, url, publishTime, fetchedTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          generateId(),
          source.id,
          source.name,
          article.title,
          article.summary,
          article.url,
          article.publishTime.toISOString(),
          new Date().toISOString()
        ]
      );
      savedCount++;
    }
  }

  return savedCount;
}

// 获取最近的文章（用于展示）
export function getRecentArticles(limit: number = 50): NewsArticle[] {
  const rows = queryAll(
    'SELECT * FROM articles ORDER BY publishTime DESC LIMIT ?',
    [limit]
  );

  return rows.map((row: any) => {
    let keywords: string[] = [];
    try {
      // keywords 可能已经是数组（从JSON数据库读取）或字符串（从SQLite读取）
      if (Array.isArray(row.keywords)) {
        keywords = row.keywords;
      } else if (typeof row.keywords === 'string') {
        keywords = JSON.parse(row.keywords);
      }
    } catch (e) {
      keywords = [];
    }
    return {
      ...row,
      keywords,
      notified: Boolean(row.notified)
    };
  });
}

// 获取与持仓相关的文章
export function getRelevantArticles(limit: number = 100): NewsArticle[] {
  const rows = queryAll(
    "SELECT * FROM articles WHERE keywords IS NOT NULL AND keywords != '[]' ORDER BY publishTime DESC LIMIT ?",
    [limit]
  );

  return rows.map((row: any) => {
    let keywords: string[] = [];
    try {
      // keywords 可能已经是数组（从JSON数据库读取）或字符串（从SQLite读取）
      if (Array.isArray(row.keywords)) {
        keywords = row.keywords;
      } else if (typeof row.keywords === 'string') {
        keywords = JSON.parse(row.keywords);
      }
    } catch (e) {
      keywords = [];
    }
    return {
      ...row,
      keywords,
      notified: Boolean(row.notified)
    };
  });
}

// 更新文章的通知状态
export function updateArticleNotification(articleId: string, level: 'high' | 'medium' | 'low'): void {
  run(
    'UPDATE articles SET notified = 1, notificationLevel = ? WHERE id = ?',
    [level, articleId]
  );
}

// 更新文章的AI分析结果
export function updateArticleAIResult(articleId: string, score: number, direction: string, reason: string): void {
  run(
    'UPDATE articles SET aiImpactScore = ?, aiImpactDirection = ?, aiImpactReason = ? WHERE id = ?',
    [score, direction, reason, articleId]
  );
}

// 获取待发送高影响文章
export function getHighImpactArticles(): NewsArticle[] {
  const rows = queryAll(
    'SELECT * FROM articles WHERE notified = 0 AND aiImpactScore >= 80 ORDER BY publishTime DESC'
  );

  return rows.map((row: any) => {
    let keywords: string[] = [];
    try {
      if (Array.isArray(row.keywords)) {
        keywords = row.keywords;
      } else if (typeof row.keywords === 'string') {
        keywords = JSON.parse(row.keywords);
      }
    } catch (e) {
      keywords = [];
    }
    return {
      ...row,
      keywords,
      notified: Boolean(row.notified)
    };
  });
}

// 获取待汇总的中等影响文章
export function getMediumImpactArticles(): NewsArticle[] {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const rows = queryAll(
    'SELECT * FROM articles WHERE notified = 0 AND aiImpactScore >= 50 AND aiImpactScore < 80 AND publishTime >= ? ORDER BY publishTime DESC',
    [yesterday.toISOString()]
  );

  return rows.map((row: any) => {
    let keywords: string[] = [];
    try {
      if (Array.isArray(row.keywords)) {
        keywords = row.keywords;
      } else if (typeof row.keywords === 'string') {
        keywords = JSON.parse(row.keywords);
      }
    } catch (e) {
      keywords = [];
    }
    return {
      ...row,
      keywords,
      notified: Boolean(row.notified)
    };
  });
}

// 主采集函数（支持进度回调）
export async function fetchAllNews(onProgress?: ProgressCallback): Promise<number> {
  const { getEnabledSources } = await import('../../config/news-sources');
  const sources = getEnabledSources();

  const startMsg = `\n📰 开始采集 ${sources.length} 个新闻源...`;
  console.log(startMsg);
  onProgress?.(startMsg);

  let totalSaved = 0;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    onProgress?.(`\n[${i + 1}/${sources.length}] 正在采集: ${source.name}`);

    const articles = source.type === 'rss'
      ? await fetchRssArticles(source, onProgress)
      : source.type === 'api'
        ? await fetchApiArticles(source, onProgress)
        : await fetchHtmlArticles(source, onProgress);
    const saved = saveArticles(source, articles);
    totalSaved += saved;

    if (saved > 0) {
      onProgress?.(`  💾 新增 ${saved} 篇入库`);
    }

    // 最后一个不需要延迟
    if (i < sources.length - 1) {
      await randomDelay(1000, 2000); // 缩短延迟，提升速度
    }
  }

  const doneMsg = `\n✅ 采集完成，共新增 ${totalSaved} 篇文章`;
  console.log(doneMsg);
  onProgress?.(doneMsg);

  return totalSaved;
}

// 获取命中持仓的新闻，按影响度降序排序
export function getPortfolioArticles(limit: number = 10): NewsArticle[] {
  const rows = queryAll(
    `SELECT * FROM articles 
     WHERE keywords IS NOT NULL AND keywords != '[]' 
     ORDER BY COALESCE(aiImpactScore, 0) DESC, publishTime DESC 
     LIMIT ?`,
    [limit]
  );

  return rows.map((row: any) => {
    let keywords: string[] = [];
    try {
      if (Array.isArray(row.keywords)) {
        keywords = row.keywords;
      } else if (typeof row.keywords === 'string') {
        keywords = JSON.parse(row.keywords);
      }
    } catch (e) {
      keywords = [];
    }
    return {
      ...row,
      keywords,
      content: row.content || ''
    } as NewsArticle;
  });
}

export default { fetchAllNews, getRecentArticles, getRelevantArticles, getPortfolioArticles };
