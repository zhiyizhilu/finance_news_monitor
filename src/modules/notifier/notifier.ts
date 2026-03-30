import nodemailer from 'nodemailer';
import { queryAll, queryOne, run } from '../../config/database';
import { getSetting, generateId } from '../../utils/helpers';
import { NewsArticle, Position, NotificationRecord } from '../../types';

// 创建邮件传输器
async function createTransporter() {
  const host = await getSetting('smtpHost') || 'smtp.qq.com';
  const port = parseInt(await getSetting('smtpPort') || '465');
  const secure = (await getSetting('smtpSecure')) === 'true';
  const user = await getSetting('smtpUser');
  const pass = await getSetting('smtpPass');

  if (!user || !pass) {
    throw new Error('邮件配置不完整');
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

// 获取所有持仓（带配置）
function getAllPositions(): Position[] {
  const rows = queryAll('SELECT * FROM positions');

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

// 获取配置的通知邮箱
async function getNotifyEmail(): Promise<string> {
  return await getSetting('notifyEmail') || '';
}

// 发送高影响实时邮件
export async function sendRealtimeNotification(article: NewsArticle, positions: Position[]): Promise<boolean> {
  try {
    const transporter = await createTransporter();
    const notifyEmail = await getNotifyEmail();
    const smtpUser = await getSetting('smtpUser') || '';

    if (!notifyEmail) {
      console.log('  未配置通知邮箱');
      return false;
    }

    // 根据邮件提醒阈值筛选持仓
    const matchedPositions = positions.filter(p => {
      // 检查关键词匹配
      const keywordMatch = article.keywords?.some((k: string) => p.keywords.includes(k));
      if (!keywordMatch) return false;
      
      // 检查是否超过邮件提醒阈值
      const threshold = p.emailAlertThreshold;
      if (threshold === null || threshold === undefined) {
        // 未设置阈值，默认不发送（或可以设为总是发送）
        return false;
      }
      
      return (article.aiImpactScore ?? 0) >= threshold;
    });

    if (matchedPositions.length === 0) {
      console.log(`  文章分数 ${article.aiImpactScore} 未超过任何持仓的邮件提醒阈值`);
      return false;
    }

    const positionNames = matchedPositions.map(p => p.name).join(', ');

    const mailOptions = {
      from: `"FinNews Monitor" <${smtpUser}>`,
      to: notifyEmail,
      subject: `【紧急】${positionNames} - ${article.aiImpactDirection} - ${article.title.substring(0, 50)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #d9534f;">📈 持仓影响预警</h2>

          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">影响持仓</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${positionNames}</td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">影响方向</td>
              <td style="padding: 8px; border: 1px solid #ddd; color: ${article.aiImpactDirection === '利好' ? '#5cb85c' : article.aiImpactDirection === '利空' ? '#d9534f' : '#777'};">
                ${article.aiImpactDirection === '利好' ? '🔴 利好' : article.aiImpactDirection === '利空' ? '🔵 利空' : '⚪ 中性'}
              </td>
            </tr>
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">影响分数</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${article.aiImpactScore}/100</td>
            </tr>
          </table>

          <h3 style="margin-top: 20px;">相关新闻</h3>
          <p><strong>标题：</strong>${article.title}</p>
          <p><strong>来源：</strong>${article.sourceName} | <strong>时间：</strong>${new Date(article.publishTime).toLocaleString('zh-CN')}</p>
          <p><strong>摘要：</strong>${article.summary}</p>

          <h3 style="margin-top: 20px;">影响分析</h3>
          <p>${article.aiImpactReason || '无'}</p>

          <p style="margin-top: 30px;">
            <a href="${article.url}" style="display: inline-block; padding: 10px 20px; background: #337ab7; color: white; text-decoration: none; border-radius: 4px;">查看原文</a>
          </p>

          <hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;">
          <p style="color: #999; font-size: 12px;">FinNews Monitor 自动发送</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);

    // 标记文章为已推送
    run('UPDATE articles SET notified = 1 WHERE id = ?', [article.id]);

    // 记录通知
    for (const position of matchedPositions) {
      run(
        'INSERT INTO notifications (id, articleId, positionId, email, type, sentTime, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [generateId(), article.id, position.id, notifyEmail, 'realtime', new Date().toISOString(), 'success', null]
      );
    }

    console.log(`  ✓ 已发送实时通知: ${article.title.substring(0, 30)}...`);
    return true;
  } catch (error) {
    console.error('  ✗ 发送失败:', (error as Error).message);
    return false;
  }
}

// 发送定时汇总邮件
export async function sendScheduledNotification(articles: NewsArticle[], positions: Position[]): Promise<boolean> {
  if (articles.length === 0) {
    console.log('  没有需要汇总的文章');
    return false;
  }

  try {
    const transporter = await createTransporter();
    const notifyEmail = await getNotifyEmail();
    const smtpUser = await getSetting('smtpUser') || '';

    if (!notifyEmail) {
      console.log('  未配置通知邮箱');
      return false;
    }

    const highImpact = articles.filter(a => (a.aiImpactScore ?? 0) >= 80);
    const mediumImpact = articles.filter(a => (a.aiImpactScore ?? 0) >= 50 && (a.aiImpactScore ?? 0) < 80);

    const today = new Date().toLocaleDateString('zh-CN');

    let html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>📊 ${today} 新闻汇总</h2>
        <p>共 ${articles.length} 条相关新闻</p>
    `;

    if (highImpact.length > 0) {
      html += `<h3 style="color: #d9534f;">📈 高影响新闻 (${highImpact.length}条)</h3><ul style="padding-left: 20px;">`;
      html += highImpact.map(a => {
        const matched = positions.filter(p => a.keywords?.some((k: string) => p.keywords.includes(k)));
        const impactColor = a.aiImpactDirection === '利好' ? '#5cb85c' : a.aiImpactDirection === '利空' ? '#d9534f' : '#777';
        const impactEmoji = a.aiImpactDirection === '利好' ? '🔴' : a.aiImpactDirection === '利空' ? '🔵' : '⚪';
        return `
          <li style="margin-bottom: 15px; line-height: 1.6;">
            <div style="font-weight: bold; margin-bottom: 5px;">
              ${impactEmoji} <span style="color: ${impactColor};">[${a.aiImpactDirection}]</span> 
              <span style="color: #d9534f; font-weight: bold;">${a.aiImpactScore}分</span>
            </div>
            <div style="margin-bottom: 5px;">
              <a href="${a.url}" style="color: #337ab7; text-decoration: none; font-weight: 500;">${a.title}</a>
            </div>
            <div style="font-size: 12px; color: #666;">
              📰 ${a.sourceName} | 🕐 ${new Date(a.publishTime).toLocaleString('zh-CN')} | 🎯 命中: ${matched.map(p => p.name).join(', ')}
            </div>
          </li>
        `;
      }).join('');
      html += '</ul>';
    }

    if (mediumImpact.length > 0) {
      html += `<h3 style="color: #f0ad4e;">📌 中等影响新闻 (${mediumImpact.length}条)</h3><ul style="padding-left: 20px;">`;
      html += mediumImpact.map(a => {
        const matched = positions.filter(p => a.keywords?.some((k: string) => p.keywords.includes(k)));
        const impactColor = a.aiImpactDirection === '利好' ? '#5cb85c' : a.aiImpactDirection === '利空' ? '#d9534f' : '#777';
        const impactEmoji = a.aiImpactDirection === '利好' ? '🔴' : a.aiImpactDirection === '利空' ? '🔵' : '⚪';
        return `
          <li style="margin-bottom: 15px; line-height: 1.6;">
            <div style="font-weight: bold; margin-bottom: 5px;">
              ${impactEmoji} <span style="color: ${impactColor};">[${a.aiImpactDirection}]</span> 
              <span style="color: #f0ad4e; font-weight: bold;">${a.aiImpactScore}分</span>
            </div>
            <div style="margin-bottom: 5px;">
              <a href="${a.url}" style="color: #337ab7; text-decoration: none; font-weight: 500;">${a.title}</a>
            </div>
            <div style="font-size: 12px; color: #666;">
              📰 ${a.sourceName} | 🕐 ${new Date(a.publishTime).toLocaleString('zh-CN')} | 🎯 命中: ${matched.map(p => p.name).join(', ')}
            </div>
          </li>
        `;
      }).join('');
      html += '</ul>';
    }

    html += `<hr style="margin-top: 30px; border: none; border-top: 1px solid #eee;"><p style="color: #999; font-size: 12px;">FinNews Monitor 自动发送</p></div>`;

    const mailOptions = {
      from: `"FinNews Monitor" <${smtpUser}>`,
      to: notifyEmail,
      subject: `【FinNews Monitor】${today} 新闻汇总 - ${articles.length}条`,
      html
    };

    await transporter.sendMail(mailOptions);

    // 标记所有汇总文章为已推送
    for (const article of articles) {
      run('UPDATE articles SET notified = 1 WHERE id = ?', [article.id]);
    }

    console.log(`  ✓ 已发送汇总邮件: ${articles.length} 条`);
    return true;
  } catch (error) {
    console.error('  ✗ 发送失败:', (error as Error).message);
    return false;
  }
}

// 获取通知历史
export function getNotificationHistory(limit: number = 50): NotificationRecord[] {
  return queryAll(
    'SELECT * FROM notifications ORDER BY sentTime DESC LIMIT ?',
    [limit]
  ) as NotificationRecord[];
}

export default { sendRealtimeNotification, sendScheduledNotification, getNotificationHistory };
