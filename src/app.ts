import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { initDatabase, deleteOldArticles } from './config/database';
import indexRoutes from './routes/index';
import portfolioRoutes from './routes/portfolio';
import newsRoutes from './routes/news';
import settingsRoutes from './routes/settings';
import { startScheduler } from './modules/scheduler/scheduler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// 视图引擎 - 指向 src/views 源目录（避免构建时复制问题）
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'src', 'views'));

// 路由
app.use('/', indexRoutes);
app.use('/portfolio', portfolioRoutes);
app.use('/news', newsRoutes);
app.use('/settings', settingsRoutes);

// 错误处理
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).render('error', { message: err.message });
});

// 启动服务器
async function start() {
  try {
    // 初始化数据库
    await initDatabase();
    console.log('✓ 数据库初始化完成');

    // 清理旧新闻
    deleteOldArticles();
    console.log('✓ 旧新闻清理完成');

    // 启动定时任务
    startScheduler();
    console.log('✓ 定时任务已启动');

    // 启动服务器
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════╗
║   FinNews Monitor 已启动                    ║
║   本地访问: http://localhost:${PORT}            ║
╚═══════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    console.error('启动失败:', error);
    process.exit(1);
  }
}

start();
