import axios from 'axios';
import * as cheerio from 'cheerio';
import { queryAll, queryOne, run } from '../../config/database';
import { Position, AIAnalysisResult, MultiPositionAnalysisResult, PositionAnalysis } from '../../types';
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

// 抓取文章正文和发布时间（用于AI分析）
async function fetchArticleContent(url: string): Promise<{ content: string, publishTime?: Date }> {
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

    // 提取发布时间
    let publishTime: Date | undefined;
    
    // 策略1：查找 <time> 标签（含 datetime 属性）
    const $timeEl = $('time[datetime]').first();
    if ($timeEl.length) {
      const dt = $timeEl.attr('datetime');
      if (dt) {
        const d = new Date(dt);
        if (!isNaN(d.getTime())) publishTime = d;
      }
    }

    // 策略2：查找常见的时间元素
    if (!publishTime) {
      const timeSelectors = [
        '.time', '.publish-time', '.post-time', '.article-time',
        '.news-time', '.date', '.article-date', '.publish-date'
      ];
      
      for (const selector of timeSelectors) {
        const $el = $(selector).first();
        if ($el.length) {
          const text = $el.text().trim();
          // 匹配常见时间格式：2026-03-28 12:26, 2026/03/28 12:26, 2026-03-28等
          const timePattern = /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(\s+\d{1,2}:\d{2})?)/;
          const match = text.match(timePattern);
          if (match) {
            const normalized = match[1].replace(/\//g, '-');
            const d = new Date(normalized);
            if (!isNaN(d.getTime())) {
              publishTime = d;
              break;
            }
          }
        }
      }
    }

    // 策略3：从页面文本中提取时间
    if (!publishTime) {
      const pageText = $('body').text();
      const timePattern = /(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s+\d{1,2}:\d{2})/;
      const match = pageText.match(timePattern);
      if (match) {
        const normalized = match[1].replace(/\//g, '-');
        const d = new Date(normalized);
        if (!isNaN(d.getTime())) publishTime = d;
      }
    }

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

    return {
      content: truncate(content, 5000), // 限制5000字，保证内容完整性
      publishTime
    };
  } catch (error) {
    console.error('抓取正文失败:', (error as Error).message);
    return { content: '' };
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

// 创建默认的多持仓分析结果（用于API未配置时）
function createDefaultMultiResult(positions: Position[], reason: string): MultiPositionAnalysisResult {
  const analysis: PositionAnalysis[] = positions.map(p => ({
    positionCode: p.code,
    positionName: p.name,
    impact: '中性' as const,
    score: 50,
    reason
  }));

  return {
    overallImpact: '中性',
    overallScore: 50,
    analysis,
    summary: reason
  };
}

// AI分析新闻影响（支持多持仓）
export async function analyzeWithAI(article: any, positions: Position[]): Promise<MultiPositionAnalysisResult> {
  console.log(`开始分析文章 [ID: ${article.id}] - ${article.title.substring(0, 50)}...`);
  console.log(`文章 [ID: ${article.id}] - 分析 ${positions.length} 个持仓: ${positions.map(p => p.name).join(', ')}`);
  
  const aiProvider = await getSetting('aiProvider') || 'openrouter';
  const apiKey = await getSetting('openRouterApiKey');
  const ollamaApiKey = await getSetting('ollamaApiKey');
  const ollamaUrl = await getSetting('ollamaUrl') || 'https://api.ollama.com';
  const opencodeCliPath = await getSetting('opencodeCliPath') || '';
  const model = await getSetting('aiModel') || 'deepseek/deepseek-chat:free';

  if (aiProvider === 'openrouter' && !apiKey) {
    console.warn(`文章 [ID: ${article.id}] - 未配置OpenRouter API Key，使用默认评分`);
    return createDefaultMultiResult(positions, '未配置OpenRouter API Key，使用默认评分');
  }
  
  if (aiProvider === 'ollama' && !ollamaApiKey) {
    console.warn(`文章 [ID: ${article.id}] - 未配置Ollama API Key，使用默认评分`);
    return createDefaultMultiResult(positions, '未配置Ollama API Key，使用默认评分');
  }

  // 如果没有正文，尝试抓取
  let content = article.content || '';
  if (!content || content.length < 100) {
    console.log(`文章 [ID: ${article.id}] - 尝试抓取正文...`);
    const result = await fetchArticleContent(article.url);
    content = result.content;
    // 保存正文到数据库
    if (content) {
      console.log(`文章 [ID: ${article.id}] - 成功抓取正文，长度: ${content.length}`);
      run('UPDATE articles SET content = ? WHERE id = ?', [content, article.id]);
    } else {
      console.warn(`文章 [ID: ${article.id}] - 抓取正文失败，将使用摘要分析`);
    }
    // 如果找到真实发布时间，更新到数据库
    if (result.publishTime) {
      console.log(`文章 [ID: ${article.id}] - 找到真实发布时间: ${result.publishTime.toISOString()}`);
      run('UPDATE articles SET publishTime = ? WHERE id = ?', [result.publishTime.toISOString(), article.id]);
    }
  }

  // 构建分析内容：优先使用正文，摘要可能不准确
  let analysisContent = '';
  if (content && content.length > 100) {
    // 有正文时，主要使用正文
    analysisContent = `\n新闻内容:\n${content.substring(0, 5000)}`;
    console.log(`文章 [ID: ${article.id}] - 使用正文分析，长度: ${content.length}`);
  } else if (article.summary && article.summary.length > 10 && article.summary !== article.title) {
    // 无正文时使用摘要
    analysisContent = `\n新闻摘要:\n${article.summary}`;
    console.log(`文章 [ID: ${article.id}] - 使用摘要分析，长度: ${article.summary.length}`);
  } else {
    console.warn(`文章 [ID: ${article.id}] - 无足够内容进行分析`);
  }

  // 构建持仓列表
  const positionsList = positions.map((p, i) => `${i + 1}. ${p.name} (${p.code}) - ${p.type}`).join('\n');

  const prompt = `你是一位专业的金融分析师。请分析以下新闻对用户持仓组合的影响。

用户的持仓列表:
${positionsList}

新闻标题: ${article.title}${analysisContent}

请分析这条新闻对每个持仓的影响，并返回JSON格式:

{
  "overallImpact": "利好|利空|中性",
  "overallScore": 0-100,
  "analysis": [
    {
      "positionCode": "持仓代码",
      "positionName": "持仓名称",
      "impact": "利好|利空|中性|无关",
      "score": 0-100,
      "reason": "具体影响原因"
    }
  ],
  "summary": "整体分析总结"
}

注意:
- 对明显无关的持仓，impact设为"无关"，score设为0
- 重点分析与新闻直接相关的持仓
- overallScore取所有持仓中的最高影响分数
- 确保返回的JSON格式完整且有效`;

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
    
    console.log(`文章 [ID: ${article.id}] - 使用${aiProvider}进行AI分析，模型: ${model}`);
    
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
    
    console.log(`文章 [ID: ${article.id}] - AI返回原始内容长度: ${rawContent.length}`);
    
    const content = cleanJsonResponse(rawContent);
    console.log(`文章 [ID: ${article.id}] - 清理后JSON: ${content.substring(0, 200)}...`);
    
    const result = JSON.parse(content);
    console.log(`文章 [ID: ${article.id}] - 整体分析结果: ${result.overallImpact}, 评分: ${result.overallScore}`);
    console.log(`文章 [ID: ${article.id}] - 各持仓分析数量: ${result.analysis?.length || 0}`);
    
    // 验证并规范化结果
    const analysis: PositionAnalysis[] = (result.analysis || []).map((item: any) => ({
      positionCode: item.positionCode || '',
      positionName: item.positionName || '',
      impact: ['利好', '利空', '中性', '无关'].includes(item.impact) ? item.impact : '中性',
      score: Math.min(100, Math.max(0, parseInt(item.score) || 0)),
      reason: item.reason || '无分析原因'
    }));

    // 补充未返回的持仓（AI可能漏掉某些持仓）
    const returnedCodes = new Set(analysis.map(a => a.positionCode));
    for (const pos of positions) {
      if (!returnedCodes.has(pos.code)) {
        analysis.push({
          positionCode: pos.code,
          positionName: pos.name,
          impact: '中性',
          score: 50,
          reason: 'AI未返回该持仓的分析结果'
        });
      }
    }
    
    return {
      overallImpact: ['利好', '利空', '中性'].includes(result.overallImpact) ? result.overallImpact : '中性',
      overallScore: Math.min(100, Math.max(0, parseInt(result.overallScore) || 50)),
      analysis,
      summary: result.summary || '无整体总结'
    };
  } catch (error: any) {
    const errorMsg = error?.response?.data?.error?.message || error.message || 'Unknown error';
    const errorCode = error?.response?.status || 'N/A';
    console.error(`文章 [ID: ${article.id}] - AI分析失败: [${errorCode}] ${errorMsg}`);
    console.error(`文章 [ID: ${article.id}] - 标题: ${article.title}`);
    console.error(`文章 [ID: ${article.id}] - URL: ${article.url}`);
    return createDefaultMultiResult(positions, `AI分析调用失败: [${errorCode}] ${errorMsg}`);
  }
}

// 处理单篇文章
export async function processArticle(article: any): Promise<void> {
  console.log(`开始处理文章 [ID: ${article.id}] - ${article.title.substring(0, 50)}...`);
  
  const positions = getAllPositions();
  const { matched, keywords } = analyzeWithKeywords(article, positions);

  if (matched.length === 0) {
    console.log(`文章 [ID: ${article.id}] - 无持仓关键词匹配，标记为无关`);
    // 没有持仓匹配，标记为无关，避免下次重复处理
    run(
      'UPDATE articles SET aiImpactDirection = ?, aiImpactScore = ?, aiImpactReason = ? WHERE id = ?',
      ['无关', 0, '无持仓关键词匹配', article.id]
    );
    return;
  }

  console.log(`文章 [ID: ${article.id}] - 匹配到 ${matched.length} 个持仓，关键词: ${keywords.join(', ')}`);
  
  // 更新文章的关键词
  run(
    'UPDATE articles SET keywords = ? WHERE id = ?',
    [JSON.stringify(keywords), article.id]
  );

  // 检查是否所有匹配的持仓都启用了AI分析
  const enabledAIPositions = matched.filter(p => p.enableAIAnalysis);
  
  if (enabledAIPositions.length === 0) {
    // 所有匹配的持仓都未启用AI分析，根据关键词数量评分
    const score = keywords.length >= 3 ? 80 : keywords.length >= 2 ? 60 : 40;
    const direction = score >= 60 ? '利好' : '中性';
    
    console.log(`文章 [ID: ${article.id}] - 未启用AI分析，根据关键词评分: ${score} (${direction})`);

    run(
      'UPDATE articles SET aiImpactScore = ?, aiImpactDirection = ?, aiImpactReason = ? WHERE id = ?',
      [score, direction, `关键词匹配: ${keywords.join(', ')}`, article.id]
    );
  } else {
    // 使用AI分析所有启用了AI分析的持仓
    console.log(`文章 [ID: ${article.id}] - 开始AI分析 ${enabledAIPositions.length} 个持仓...`);
    const result = await analyzeWithAI(article, enabledAIPositions);
    
    console.log(`文章 [ID: ${article.id}] - AI分析完成，整体结果: ${result.overallImpact}, 评分: ${result.overallScore}`);
    
    // 找出影响最大的持仓
    const maxImpactPosition = result.analysis.reduce((max, curr) => curr.score > max.score ? curr : max, result.analysis[0]);
    console.log(`文章 [ID: ${article.id}] - 影响最大的持仓: ${maxImpactPosition.positionName} (${maxImpactPosition.impact}, ${maxImpactPosition.score}分)`);

    // 保存整体分析结果到文章表
    run(
      'UPDATE articles SET aiImpactScore = ?, aiImpactDirection = ?, aiImpactReason = ? WHERE id = ?',
      [result.overallScore, result.overallImpact, result.summary, article.id]
    );
    
    // 保存每个持仓的详细分析结果（存储为JSON）
    run(
      'UPDATE articles SET positionAnalysis = ? WHERE id = ?',
      [JSON.stringify(result.analysis), article.id]
    );
  }
  
  console.log(`文章 [ID: ${article.id}] - 处理完成`);
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
