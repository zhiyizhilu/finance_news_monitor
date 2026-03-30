import schedule from 'node-schedule';
import { fetchAllNews, getHighImpactArticles, getMediumImpactArticles, updateArticleNotification } from '../fetcher/fetcher';
import { analyzeAllArticles } from '../analyzer/analyzer';
import { sendRealtimeNotification, sendScheduledNotification } from '../notifier/notifier';
import { getAllPositions } from '../analyzer/analyzer';
import { getSetting } from '../../utils/helpers';

let isRunning = false;

// 主任务：采集 + 分析 + 通知
async function runMainTask() {
  if (isRunning) {
    console.log('⚠️ 任务正在执行中，跳过本次调度');
    return;
  }

  isRunning = true;
  console.log('\n========== 开始执行任务 ==========');

  try {
    // 1. 采集新闻
    console.log('\n[1/3] 采集新闻...');
    await fetchAllNews();

    // 2. AI分析
    console.log('\n[2/3] AI分析...');
    await analyzeAllArticles();

    // 3. 发送通知
    console.log('\n[3/3] 发送通知...');

    const positions = getAllPositions();
    const notifyEmail = await getSetting('notifyEmail');

    if (notifyEmail && positions.length > 0) {
      const highImpactArticles = getHighImpactArticles();
      for (const article of highImpactArticles) {
        await sendRealtimeNotification(article, positions);
        updateArticleNotification(article.id, 'high');
      }
    }

    console.log('\n========== 任务执行完成 ==========\n');
  } catch (error) {
    console.error('任务执行失败:', error);
  } finally {
    isRunning = false;
  }
}

// 定时汇总任务
async function runScheduledSummary() {
  console.log('\n========== 发送定时汇总 ==========');

  try {
    const positions = getAllPositions();
    const notifyEmail = await getSetting('notifyEmail');

    if (!notifyEmail || positions.length === 0) {
      console.log('未配置邮箱或持仓，跳过汇总');
      return;
    }

    const mediumArticles = getMediumImpactArticles();

    if (mediumArticles.length > 0) {
      await sendScheduledNotification(mediumArticles, positions);

      for (const article of mediumArticles) {
        updateArticleNotification(article.id, 'medium');
      }
    } else {
      console.log('没有需要汇总的文章');
    }

    console.log('========== 汇总完成 ==========\n');
  } catch (error) {
    console.error('汇总失败:', error);
  }
}

// 启动调度器
export function startScheduler(): void {
  console.log('\n📅 配置定时任务...');

  const fetchInterval = parseInt(process.env.FETCH_INTERVAL || '30');

  // 主任务：每30分钟执行一次
  schedule.scheduleJob(`*/${fetchInterval} * * * *`, async () => {
    await runMainTask();
  });

  console.log(`  ✓ 新闻采集: 每 ${fetchInterval} 分钟`);

  const scheduledTimes = (process.env.SCHEDULED_TIMES || '08:00,12:00,18:00').split(',');

  for (const time of scheduledTimes) {
    const [hour, minute] = time.trim().split(':');
    schedule.scheduleJob({ hour: parseInt(hour), minute: parseInt(minute) }, async () => {
      await runScheduledSummary();
    });
    console.log(`  ✓ 定时汇总: 每天 ${time}`);
  }

  console.log('');
}

// 手动触发任务
export async function triggerTask(): Promise<void> {
  await runMainTask();
}

// 手动触发汇总
export async function triggerSummary(): Promise<void> {
  await runScheduledSummary();
}

export default { startScheduler, triggerTask, triggerSummary };
