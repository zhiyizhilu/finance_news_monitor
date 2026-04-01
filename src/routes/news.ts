import { Router } from 'express';
import { getRecentArticles, getRelevantArticles } from '../modules/fetcher/fetcher';
import { queryOne, queryAll } from '../config/database';
import { processArticle } from '../modules/analyzer/analyzer';

const router = Router();

// 新闻列表
router.get('/', (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const filter = (req.query.filter as string) || 'relevant';
  const sort = (req.query.sort as string) || 'score';
  const order = (req.query.order as string) || 'desc';
  const search = (req.query.search as string) || '';
  const positionId = (req.query.position as string) || '';
  const sourceFilter = (req.query.source as string) || '';
  // 日期范围：如果参数不存在（首次访问），默认近两天；如果参数为空字符串（点击"全部"），显示全部时间
  const dateRangeParam = req.query.dateRange;
  const dateRange = dateRangeParam === undefined ? '2days' : (dateRangeParam as string);
  // 分数筛选：默认60分以上，'all'表示全部
  const scoreFilterParam = req.query.score;
  const scoreFilter = scoreFilterParam === undefined ? '60' : (scoreFilterParam as string);

  // 获取所有持仓列表
  const positions = queryAll('SELECT * FROM positions ORDER BY createdAt DESC');

  // 获取所有新闻来源列表（去重）
  const sources = queryAll('SELECT DISTINCT sourceName FROM articles WHERE sourceName IS NOT NULL ORDER BY sourceName');
  const sourceList = [...new Set(sources.map((s: any) => s.sourceName?.trim()).filter(Boolean))];

  let articles: any[];
  if (filter === 'relevant') {
    articles = getRelevantArticles(500);
  } else if (filter === 'high') {
    const rows = queryAll(
      'SELECT * FROM articles WHERE aiImpactScore >= 80 ORDER BY publishTime DESC LIMIT 500'
    );
    articles = rows.map((row: any) => {
      let keywords: string[] = [];
      try {
        if (Array.isArray(row.keywords)) {
          keywords = row.keywords;
        } else if (typeof row.keywords === 'string') {
          keywords = JSON.parse(row.keywords);
        }
      } catch (e) { keywords = []; }
      return { ...row, keywords, notified: Boolean(row.notified) };
    });
  } else {
    articles = getRecentArticles(500);
  }

  // 按持仓筛选
  if (positionId) {
    const position = positions.find((p: any) => p.id === positionId);
    if (position) {
      let positionKeywords: string[] = [];
      try {
        if (Array.isArray(position.keywords)) {
          positionKeywords = position.keywords;
        } else if (typeof position.keywords === 'string') {
          positionKeywords = JSON.parse(position.keywords);
        }
      } catch (e) {
        positionKeywords = [];
      }
      if (positionKeywords.length > 0) {
        articles = articles.filter(a => {
          let articleKeywords: string[] = [];
          try {
            if (Array.isArray(a.keywords)) {
              articleKeywords = a.keywords;
            } else if (typeof a.keywords === 'string') {
              articleKeywords = JSON.parse(a.keywords);
            }
          } catch (e) {
            articleKeywords = [];
          }
          return articleKeywords.some((k: string) => 
            positionKeywords.some((pk: string) => 
              k.toLowerCase().includes(pk.toLowerCase()) || pk.toLowerCase().includes(k.toLowerCase())
            )
          );
        });
      }
    }
  }

  // 来源筛选
  if (sourceFilter) {
    articles = articles.filter(a => a.sourceName === sourceFilter);
  }

  // 搜索过滤
  if (search.trim()) {
    const searchLower = search.toLowerCase();
    articles = articles.filter(a => 
      a.title?.toLowerCase().includes(searchLower) ||
      a.summary?.toLowerCase().includes(searchLower)
    );
  }

  // 日期范围筛选（'all' 表示全部时间，不进行筛选）
  if (dateRange && dateRange !== 'all') {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let startDate: Date;

    switch (dateRange) {
      case 'today':
        startDate = today;
        break;
      case '2days':
        startDate = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
        break;
      case '5days':
        startDate = new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000);
        break;
      case '7days':
        startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30days':
        startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(0);
    }

    articles = articles.filter(a => {
      const articleDate = new Date(a.publishTime);
      return articleDate >= startDate;
    });
  }

  // 分数筛选（'all' 表示全部，不进行筛选）
  if (scoreFilter && scoreFilter !== 'all') {
    const minScore = parseInt(scoreFilter, 10);
    if (!isNaN(minScore)) {
      articles = articles.filter(a => (a.aiImpactScore || 0) >= minScore);
    }
  }

  // 排序
  articles.sort((a, b) => {
    let valA: any, valB: any;
    switch (sort) {
      case 'title':
        valA = a.title || '';
        valB = b.title || '';
        break;
      case 'source':
        valA = a.sourceName || '';
        valB = b.sourceName || '';
        break;
      case 'score':
        valA = a.aiImpactScore || 0;
        valB = b.aiImpactScore || 0;
        break;
      case 'publishTime':
      default:
        valA = new Date(a.publishTime || 0).getTime();
        valB = new Date(b.publishTime || 0).getTime();
        break;
    }
    if (order === 'asc') {
      return valA > valB ? 1 : valA < valB ? -1 : 0;
    } else {
      return valA < valB ? 1 : valA > valB ? -1 : 0;
    }
  });

  const totalCount = articles.length;
  const totalPages = Math.ceil(totalCount / limit) || 1;
  const paginatedArticles = articles.slice(offset, offset + limit);

  res.render('news', {
    title: '新闻浏览',
    articles: paginatedArticles,
    page,
    totalPages,
    totalCount,
    filter,
    sort,
    order,
    search,
    positions,
    positionId,
    dateRange,
    sources: sourceList,
    sourceFilter,
    scoreFilter
  });
});

// 新闻详情
router.get('/detail/:id', (req, res) => {
  const { id } = req.params;
  const article = queryOne('SELECT * FROM articles WHERE id = ?', [id]) as any;

  if (!article) {
    return res.status(404).render('error', { title: '404', message: '文章不存在' });
  }

  let keywords: string[] = [];
  try {
    if (Array.isArray(article.keywords)) {
      keywords = article.keywords;
    } else if (typeof article.keywords === 'string') {
      keywords = JSON.parse(article.keywords);
    }
  } catch (e) { keywords = []; }

  res.render('news-detail', {
    title: article.title,
    article: { ...article, keywords }
  });
});

// 单篇文章AI分析
router.post('/analyze/:id', async (req, res) => {
  const { id } = req.params;
  const article = queryOne('SELECT * FROM articles WHERE id = ?', [id]) as any;

  if (!article) {
    return res.status(404).json({ success: false, message: '文章不存在' });
  }

  try {
    // processArticle 会自动更新数据库
    await processArticle(article);

    // 重新查询数据库获取分析结果
    const updated = queryOne('SELECT * FROM articles WHERE id = ?', [id]) as any;
    const direction = updated?.aiImpactDirection;
    const score = updated?.aiImpactScore;

    if (direction && direction !== '无关') {
      return res.json({
        success: true,
        message: `分析完成：${direction}，影响评分 ${score}`,
        result: { impact: direction, score, reason: updated?.aiImpactReason }
      });
    } else if (direction === '无关') {
      return res.json({ success: false, message: '当前文章与持仓关键词无关，未进行深度分析' });
    } else {
      return res.json({ success: false, message: '分析完成，但未返回结果，请检查AI设置' });
    }
  } catch (error: any) {
    return res.status(500).json({ success: false, message: '分析失败：' + error.message });
  }
});

export default router;
