import { Router } from 'express';
import { getRecentArticles, getPortfolioArticles } from '../modules/fetcher/fetcher';
import { analyzeAllArticles, getAllPositions } from '../modules/analyzer/analyzer';
import { queryOne, queryAll } from '../config/database';
import { sendScheduledNotification } from '../modules/notifier/notifier';

const router = Router();

// 首页 - 系统概览
router.get('/', async (req, res) => {
  const totalArticles = (queryOne('SELECT COUNT(*) as count FROM articles') as any)?.count || 0;
  const relevantArticles = (queryOne("SELECT COUNT(*) as count FROM articles WHERE keywords IS NOT NULL AND keywords != '[]'") as any)?.count || 0;
  const notifiedArticles = (queryOne('SELECT COUNT(*) as count FROM articles WHERE notified = 1') as any)?.count || 0;
  const highImpactArticles = (queryOne('SELECT COUNT(*) as count FROM articles WHERE aiImpactScore >= 80') as any)?.count || 0;
  const positionsCount = (queryOne('SELECT COUNT(*) as count FROM positions') as any)?.count || 0;

  const recentNews = getPortfolioArticles(10);
  const positions = getAllPositions();

  res.render('index', {
    title: 'FinNews Monitor',
    stats: {
      totalArticles,
      relevantArticles,
      notifiedArticles,
      highImpactArticles,
      positionsCount
    },
    recentNews,
    positions
  });
});

// SSE：实时推送采集进度
router.get('/fetch/progress', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: string) => {
    res.write(`data: ${JSON.stringify({ msg: data })}\n\n`);
  };

  try {
    const { fetchAllNews } = await import('../modules/fetcher/fetcher');
    const total = await fetchAllNews(send);
    res.write(`data: ${JSON.stringify({ msg: `__DONE__:${total}` })}\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ msg: `__ERROR__:${(error as Error).message}` })}\n\n`);
  }

  res.end();
});

// 普通接口：触发采集（无进度，兼容旧调用）
router.post('/fetch', async (req, res) => {
  try {
    const { fetchAllNews } = await import('../modules/fetcher/fetcher');
    const total = await fetchAllNews();
    res.json({ success: true, message: `采集完成，新增 ${total} 篇文章` });
  } catch (error) {
    res.json({ success: false, message: (error as Error).message });
  }
});

// SSE：实时推送分析进度
router.get('/analyze/progress', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: string) => {
    res.write(`data: ${JSON.stringify({ msg: data })}\n\n`);
  };

  try {
    // 立即分析：不限制数量，分析所有待分析的文章
    await analyzeAllArticles(send, 0);
    res.write(`data: ${JSON.stringify({ msg: '__DONE__' }) }\n\n`);
  } catch (error) {
    res.write(`data: ${JSON.stringify({ msg: `__ERROR__:${(error as Error).message}` }) }\n\n`);
  }

  res.end();
});

// 普通接口：触发分析（兼容旧调用）
router.post('/analyze', async (req, res) => {
  try {
    // 立即分析：不限制数量，分析所有待分析的文章
    await analyzeAllArticles(undefined, 0);
    res.json({ success: true, message: '分析完成' });
  } catch (error) {
    res.json({ success: false, message: (error as Error).message });
  }
});

// 手动发送汇总邮件（测试用）
router.post('/send-summary', async (req, res) => {
  try {
    // 获取最近24小时内有keywords且未推送的文章
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const articles = queryAll(
      `SELECT * FROM articles 
       WHERE keywords IS NOT NULL AND keywords != '[]' 
       AND publishTime > ? 
       ORDER BY aiImpactScore DESC`,
      [oneDayAgo]
    );

    if (articles.length === 0) {
      res.json({ success: false, message: '没有需要汇总的新闻（最近24小时内无命中持仓的新闻）' });
      return;
    }

    // 转换keywords为数组
    const formattedArticles = articles.map((a: any) => {
      let keywords: string[] = [];
      try {
        if (Array.isArray(a.keywords)) {
          keywords = a.keywords;
        } else if (typeof a.keywords === 'string') {
          keywords = JSON.parse(a.keywords);
        }
      } catch (e) {
        keywords = [];
      }
      return { ...a, keywords };
    });

    const positions = getAllPositions();
    const result = await sendScheduledNotification(formattedArticles, positions);

    if (result) {
      res.json({ success: true, message: `汇总邮件已发送，包含 ${articles.length} 条新闻` });
    } else {
      res.json({ success: false, message: '邮件发送失败，请检查邮件配置' });
    }
  } catch (error) {
    res.json({ success: false, message: (error as Error).message });
  }
});

export default router;
