import axios from 'axios';
import * as cheerio from 'cheerio';
import { queryAll, queryOne, run } from '../../config/database';
import { Position, AIAnalysisResult } from '../../types';
import { matchKeywords, getSetting, getRandomUserAgent, stripHtml, truncate } from '../../utils/helpers';
import { getOpenCodeClient } from './opencode-client';

// 获取所有持仓
export function getAllPositions(): Position[] {
  const rows = queryAll('SELECT * FROM positions ORDER BY createdAt DESC');

  return rows.map((row: any) => {
    let keywords: string[] = [];
    let excludeKeywords: string[] = [];
    try {
      if (Array.isArray(row.keywords)) {
        keywords = row.keywords;
      } else if (typeof row.keywords === 'string') {
        keywords = JSON.parse(row.keywords || '[]');
      }
      if (Array.isArray(row.excludeKeywords)) {
        excludeKeywords = row.excludeKeywords;
      } else if (typeof row.excludeKeywords === 'string') {
        excludeKeywords = JSON.parse(row.excludeKeywords || '[]');
      }
    } catch (e) {
      keywords = [];
      excludeKeywords = [];
    }
    return {
      ...row,
      keywords,
      excludeKeywords,
      enableAIAnalysis: Boolean(row.enableAIAnalysis)
    };
  });
}

// 关键词匹配分析
export function analyzeWithKeywords(article: any, positions: Position[]): { matched: Position[], keywords: string[] } {
  const text = `${article.title} ${article.summary}`;
  const allMatched: Position[] = [];
  const allKeywords: string[] = [];

  for (const position of positions) {
    const matched = matchKeywords(text, position.keywords, position.excludeKeywords || []);
    if (matched.length > 0) {
      allMatched.push(position);
      allKeywords.push(...matched);
    }
  }

  return { matched: allMatched, keywords: [...new Set(allKeywords)] };
}

// 抓取文章正文（用于AI分析）
async function fetchArticleContent(url: string): Promise<string> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);

    // 移除脚本、样式、导航等无关元素
    $('script, style, nav, header, footer, .ad, .advertisement, .share, .comment').remove();

    // 尝试多种正文选择器
    const contentSelectors = [
      'article', '.article-content', '.content-main', '.post-content',
      '.news-content', '.article-body', '.content-body', '.detail-content',
      '#content', '#article-content', '.main-content', '.text-content',
      '[class*="content"]', '[class*="article"]', '.entry-content'
    ];

    let content = '';
    for (const selector of contentSelectors) {
      const el = $(selector).first();
      if (el.length && el.text().trim().length > 100) {
        content = el.text().trim();
        break;
      }
    }

    // 如果没找到，取 body 中段落最多的区域
    if (!content || content.length < 100) {
      const paragraphs: string[] = [];
      $('p').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 20) paragraphs.push(text);
      });
      content = paragraphs.join('\n');
    }

    // 清理并截断
    content = stripHtml(content)
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();

    return truncate(content, 2000); // 限制2000字，避免token过长
  } catch (error) {
    console.error('抓取正文失败:', (error as Error).message);
    return '';
  }
}

// 延迟函数
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 指数退避重试函数
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 2000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const statusCode = error?.response?.status;
      
      // 只有 429 限流错误才重试
      if (statusCode === 429 && attempt < maxRetries) {
        const waitTime = baseDelay * Math.pow(2, attempt); // 2s, 4s, 8s
        console.log(`  ⏳ 遇到限流(429)，等待 ${waitTime/1000}s 后重试 (${attempt + 1}/${maxRetries})...`);
        await delay(waitTime);
        continue;
      }
      
      // 其他错误或重试次数用尽，抛出错误
      throw error;
    }
  }
  
  throw lastError;
}

// AI分析新闻影响
export async function analyzeWithAI(article: any, position: Position): Promise<AIAnalysisResult> {
  const aiProvider = await getSetting('aiProvider') || 'openrouter';
  const apiKey = await getSetting('openRouterApiKey');
  const ollamaApiKey = await getSetting('ollamaApiKey');
  const ollamaUrl = await getSetting('ollamaUrl') || 'https://api.ollama.com';
  const opencodeCliPath = await getSetting('opencodeCliPath') || '';
  const model = await getSetting('aiModel') || 'deepseek/deepseek-chat:free';

  if (aiProvider === 'openrouter' && !apiKey) {
    return {
      impact: '中性',
      score: 50,
      reason: '未配置OpenRouter API Key，使用默认评分'
    };
  }
  
  if (aiProvider === 'ollama' && !ollamaApiKey) {
    return {
      impact: '中性',
      score: 50,
      reason: '未配置Ollama API Key，使用默认评分'
    };
  }

  // 如果没有正文，尝试抓取
  let content = article.content || '';
  if (!content || content.length < 100) {
    content = await fetchArticleContent(article.url);
    // 保存正文到数据库
    if (content) {
      run('UPDATE articles SET content = ? WHERE id = ?', [content, article.id]);
    }
  }

  // 构建分析内容：优先使用正文，摘要可能不准确
  let analysisContent = '';
  if (content && content.length > 100) {
    // 有正文时，主要使用正文
    analysisContent = `\n新闻内容:\n${content.substring(0, 2000)}`;
  } else if (article.summary && article.summary.length > 10 && article.summary !== article.title) {
    // 无正文时使用摘要
    analysisContent = `\n新闻摘要:\n${article.summary}`;
  }

  const prompt = `你是一位专业的金融分析师。请分析以下新闻对持仓的影响。

持仓信息:
- 持仓名称: ${position.name}
- 持仓代码: ${position.code}

新闻标题: ${article.title}${analysisContent}

请分析:
1. 此新闻对持仓的影响方向 (利好/利空/中性)
2. 影响程度评分 (0-100)
3. 简要说明理由

请用JSON格式返回:
{"impact": "利好|利空|中性", "score": 0-100, "reason": "原因说明"}`;

  // 清理AI返回的JSON内容（去除Markdown代码块、中文前缀等）
  function cleanJsonResponse(content: string): string {
    if (!content) return '';
    
    // 去除Markdown代码块标记
    let cleaned = content
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/i, '')
      .replace(/^```\s*/i, '')
      .trim();
    
    // 提取JSON对象 - 查找第一个 { 和最后一个 }
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
    }
    
    // 处理可能的换行和多余空格
    cleaned = cleaned.replace(/\n\s*/g, ' ').trim();
    
    return cleaned;
  }

  try {
    let rawContent = '';
    
    if (aiProvider === 'opencode') {
      // OpenCode 本地 CLI 服务
      const client = getOpenCodeClient(opencodeCliPath || undefined);
      rawContent = await client.chat([
        { role: 'user', content: prompt }
      ], {
        model: model || 'auto',
        temperature: 0.3
      });
    } else if (aiProvider === 'ollama') {
      // Ollama Cloud API - native /api/chat format
      const ollamaBase = (ollamaUrl || 'https://ollama.com').replace(/\/$/, '');
      const headers: any = {
        'Content-Type': 'application/json'
      };
      if (ollamaApiKey) {
        headers['Authorization'] = `Bearer ${ollamaApiKey}`;
      }
      
      const response = await retryWithBackoff(() => axios.post(
        `${ollamaBase}/api/chat`,
        {
          model: model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          options: { temperature: 0.3 }
        },
        {
          headers,
          timeout: 60000
        }
      ));
      rawContent = response.data.message?.content || response.data.choices?.[0]?.message?.content || '';
    } else {
      // OpenRouter API
      const response = await retryWithBackoff(() => axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://finnews-monitor.local',
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      ));
      rawContent = response.data.choices[0].message.content;
    }
    
    const content = cleanJsonResponse(rawContent);
    const result = JSON.parse(content);
    return {
      impact: result.impact as '利好' | '利空' | '中性',
      score: Math.min(100, Math.max(0, parseInt(result.score) || 50)),
      reason: result.reason
    };
  } catch (error: any) {
    const errorMsg = error?.response?.data?.error?.message || error.message || 'Unknown error';
    const errorCode = error?.response?.status || 'N/A';
    console.error('AI分析失败:', `[${errorCode}]`, errorMsg);
    return {
      impact: '中性',
      score: 50,
      reason: `AI分析调用失败: [${errorCode}] ${errorMsg}`
    };
  }
}

// 处理单篇文章
export async function processArticle(article: any): Promise<void> {
  const positions = getAllPositions();
  const { matched, keywords } = analyzeWithKeywords(article, positions);

  if (matched.length === 0) {
    // 没有持仓匹配，标记为无关，避免下次重复处理
    run(
      'UPDATE articles SET aiImpactDirection = ?, aiImpactScore = ?, aiImpactReason = ? WHERE id = ?',
      ['无关', 0, '无持仓关键词匹配', article.id]
    );
    return;
  }

  // 更新文章的关键词
  run(
    'UPDATE articles SET keywords = ? WHERE id = ?',
    [JSON.stringify(keywords), article.id]
  );

  // 对每个匹配的持仓进行AI分析（取第一个匹配持仓，避免重复写入）
  const position = matched[0];
  if (!position.enableAIAnalysis) {
    // 不使用AI，根据关键词数量评分
    const score = keywords.length >= 3 ? 80 : keywords.length >= 2 ? 60 : 40;
    const direction = score >= 60 ? '利好' : '中性';

    run(
      'UPDATE articles SET aiImpactScore = ?, aiImpactDirection = ?, aiImpactReason = ? WHERE id = ?',
      [score, direction, `关键词匹配: ${keywords.join(', ')}`, article.id]
    );
  } else {
    // 使用AI分析
    const result = await analyzeWithAI(article, position);

    run(
      'UPDATE articles SET aiImpactScore = ?, aiImpactDirection = ?, aiImpactReason = ? WHERE id = ?',
      [result.score, result.impact, result.reason, article.id]
    );
  }
}

// 批量处理所有未分析的文章（支持进度回调）
export async function analyzeAllArticles(onProgress?: (msg: string) => void, limit: number = 50): Promise<number> {
  // 先做关键词匹配（所有还没打关键词且未标记为无关的文章）
  const unmatched = queryAll(
    "SELECT * FROM articles WHERE (keywords IS NULL OR keywords = '[]') AND (aiImpactDirection IS NULL OR aiImpactDirection != '无关') ORDER BY fetchedTime DESC LIMIT 200"
  );

  if (unmatched.length > 0) {
    onProgress?.(`🔍 关键词匹配 ${unmatched.length} 篇文章...`);
    const positions = getAllPositions();
    let matchedCount = 0;
    for (const article of unmatched) {
      const { matched, keywords } = analyzeWithKeywords(article, positions);
      if (matched.length > 0) {
        run('UPDATE articles SET keywords = ? WHERE id = ?', [JSON.stringify(keywords), article.id]);
        matchedCount++;
      } else {
        // 明确标记为无关，下次不再重复扫描
        run(
          'UPDATE articles SET keywords = ?, aiImpactDirection = ?, aiImpactScore = ?, aiImpactReason = ? WHERE id = ?',
          ['[]', '无关', 0, '无持仓关键词匹配', article.id]
        );
      }
    }
    onProgress?.(`  ✓ 关键词命中 ${matchedCount} 篇，其余已标记为无关`);
  }

  // 统计已分析过（有 aiImpactDirection 或 aiImpactScore > 0）的相关文章数量，用于提示
  const alreadyAnalyzed = queryAll(
    "SELECT COUNT(*) as cnt FROM articles WHERE keywords IS NOT NULL AND keywords != '[]' AND (aiImpactDirection IS NOT NULL OR aiImpactScore > 0)"
  );
  const skippedCount = (alreadyAnalyzed[0]?.cnt as number) || 0;

  // 获取待AI分析的文章（用 aiImpactDirection IS NULL 且 aiImpactScore IS NULL 判断未分析，避免重复）
  const limitClause = limit > 0 ? `LIMIT ${limit}` : '';
  const rows = queryAll(
    `SELECT * FROM articles WHERE keywords IS NOT NULL AND keywords != '[]' AND aiImpactDirection IS NULL AND (aiImpactScore IS NULL OR aiImpactScore = 0) ORDER BY fetchedTime DESC ${limitClause}`
  );

  if (rows.length === 0) {
    const msg = skippedCount > 0
      ? `✓ 没有需要分析的文章（已跳过 ${skippedCount} 篇已分析文章）`
      : '✓ 没有需要分析的文章';
    console.log(msg);
    onProgress?.(msg);
    return 0;
  }

  if (skippedCount > 0) {
    const skipMsg = `⏭️ 跳过 ${skippedCount} 篇已分析文章`;
    console.log(skipMsg);
    onProgress?.(skipMsg);
  }

  const startMsg = `\n🤖 开始分析 ${rows.length} 篇相关文章...`;
  console.log(startMsg);
  onProgress?.(startMsg);

  for (let i = 0; i < rows.length; i++) {
    const article = rows[i];
    onProgress?.(`[${i + 1}/${rows.length}] 分析: ${article.title.substring(0, 40)}...`);
    await processArticle(article);
    // 增加请求间隔，避免触发限流（OpenRouter免费模型建议每秒1-2请求）
    await delay(1500);
  }

  const doneMsg = `✅ 分析完成，共处理 ${rows.length} 篇${skippedCount > 0 ? `（跳过 ${skippedCount} 篇已分析）` : ''}`;
  console.log(doneMsg);
  onProgress?.(doneMsg);
  return rows.length;
}

export default { getAllPositions, analyzeWithKeywords, analyzeWithAI, analyzeAllArticles };
