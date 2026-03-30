import fs from 'fs';
import path from 'path';

// 数据目录放在项目根目录的 data 文件夹
const dataDir = path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'database.json');

// 确保数据目录存在
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 内存数据库
interface Database {
  positions: any[];
  articles: any[];
  notifications: any[];
  settings: Record<string, string>;
  sources: any[];
}

let db: Database = {
  positions: [],
  articles: [],
  notifications: [],
  settings: {},
  sources: []
};

// 加载数据库
function loadDb(): void {
  if (fs.existsSync(dbPath)) {
    try {
      const data = fs.readFileSync(dbPath, 'utf-8');
      if (data.trim()) {
        db = JSON.parse(data);
      }
    } catch (error) {
      console.error('加载数据库失败:', error);
      db = { positions: [], articles: [], notifications: [], settings: {}, sources: [] };
    }
  }
}

// 保存数据库
export function saveDb(): void {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf-8');
  } catch (error) {
    console.error('保存数据库失败:', error);
  }
}

export async function initDatabase(): Promise<void> {
  loadDb();

  // 初始化默认设置
  const defaultSettings: Record<string, string> = {
    smtpHost: 'smtp.qq.com',
    smtpPort: '465',
    smtpSecure: 'true',
    smtpUser: '',
    smtpPass: '',
    notifyEmail: '',
    openRouterApiKey: '',
    ollamaApiKey: '',
    ollamaUrl: 'https://ollama.com',
    aiProvider: 'openrouter',
    aiModel: 'deepseek/deepseek-chat:free',
    fetchInterval: '30',
    scheduledTimes: '08:00,12:00,18:00'
  };

  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!(key in db.settings)) {
      db.settings[key] = value;
    }
  }

  saveDb();
  console.log('✓ 数据库初始化完成');
}

// 查询所有记录
export function queryAll(sql: string, params: any[] = []): any[] {
  // 确保数据库已加载
  loadDb();

  // 简单的 SQL 模拟（实际使用 JSON 查询）
  if (sql.includes('FROM positions')) {
    let results = [...db.positions];
    if (sql.includes('ORDER BY')) {
      results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    if (sql.includes('LIMIT')) {
      const limitMatch = sql.match(/LIMIT (\d+)/);
      if (limitMatch) results = results.slice(0, parseInt(limitMatch[1]));
    }
    return results;
  }

  if (sql.includes('FROM articles')) {
    let results = [...db.articles];

    // WHERE 条件匹配
    if (sql.includes('WHERE url = ?') && params.length > 0) {
      results = results.filter(a => a.url === params[0]);
    }
    if (sql.includes('WHERE id = ?') && params.length > 0) {
      results = results.filter(a => a.id === params[0]);
    }
    if (sql.includes('WHERE source = ?') && params.length > 0) {
      results = results.filter(a => a.source === params[0]);
    }

    // 过滤条件
    if (sql.includes("keywords IS NOT NULL AND keywords != '[]'")) {
      results = results.filter(a => a.keywords && a.keywords.length > 0);
    }
    if (sql.includes('notified = 0')) {
      results = results.filter(a => !a.notified);
    }
    if (sql.includes('notified = 1')) {
      results = results.filter(a => a.notified === true);
    }
    if (sql.includes('aiImpactScore >=')) {
      const match = sql.match(/aiImpactScore >= (\d+)/);
      if (match) results = results.filter(a => a.aiImpactScore >= parseInt(match[1]));
    }
    if (sql.includes('aiImpactScore <')) {
      const match = sql.includes('aiImpactScore < 80') ? 80 :
                    sql.includes('aiImpactScore < 50') ? 50 : 0;
      results = results.filter(a => a.aiImpactScore < match);
    }
    if (sql.includes('aiImpactScore IS NULL')) {
      results = results.filter(a => a.aiImpactScore === undefined || a.aiImpactScore === null);
    }
    if (sql.includes('aiImpactDirection IS NULL')) {
      results = results.filter(a => !a.aiImpactDirection);
    }
    if (sql.includes("aiImpactDirection != '无关'")) {
      results = results.filter(a => a.aiImpactDirection !== '无关');
    }
    if (sql.includes('aiImpactDirection IS NOT NULL')) {
      results = results.filter(a => a.aiImpactDirection);
    }

    // 排序
    if (sql.includes('ORDER BY')) {
      if (sql.includes('aiImpactScore')) {
        // 按影响度降序，然后按发布时间降序
        results.sort((a, b) => {
          const scoreA = a.aiImpactScore || 0;
          const scoreB = b.aiImpactScore || 0;
          if (scoreB !== scoreA) return scoreB - scoreA;
          return new Date(b.publishTime).getTime() - new Date(a.publishTime).getTime();
        });
      } else if (sql.includes('publishTime')) {
        results.sort((a, b) => new Date(b.publishTime).getTime() - new Date(a.publishTime).getTime());
      } else if (sql.includes('fetchedTime')) {
        results.sort((a, b) => new Date(b.fetchedTime).getTime() - new Date(a.fetchedTime).getTime());
      } else if (sql.includes('sentTime')) {
        results.sort((a, b) => new Date(b.sentTime).getTime() - new Date(a.sentTime).getTime());
      }
    }

    // 限制
    if (sql.includes('LIMIT')) {
      const limitMatch = sql.match(/LIMIT (\d+)/);
      if (limitMatch) results = results.slice(0, parseInt(limitMatch[1]));
    }

    return results;
  }

  if (sql.includes('FROM notifications')) {
    let results = [...db.notifications];
    if (sql.includes('ORDER BY')) {
      results.sort((a, b) => new Date(b.sentTime).getTime() - new Date(a.sentTime).getTime());
    }
    if (sql.includes('LIMIT')) {
      const limitMatch = sql.match(/LIMIT (\d+)/);
      if (limitMatch) results = results.slice(0, parseInt(limitMatch[1]));
    }
    return results;
  }

  if (sql.includes('FROM settings')) {
    let results = Object.entries(db.settings).map(([key, value]) => ({ key, value }));
    // 处理 WHERE key = ? 条件
    if (sql.includes('WHERE key = ?') && params.length > 0) {
      results = results.filter(s => s.key === params[0]);
    }
    return results;
  }

  return [];
}

// 查询单条记录
export function queryOne(sql: string, params: any[] = []): any | undefined {
  // 处理 COUNT(*) 查询
  if (sql.includes('COUNT(*)')) {
    const results = queryAll(sql.replace(/SELECT COUNT\(\*\) as \w+/i, 'SELECT *'), params);
    return { count: results.length };
  }
  const results = queryAll(sql, params);
  return results[0];
}

// 执行插入/更新/删除
export function run(sql: string, params: any[] = []): void {
  if (sql.startsWith('INSERT INTO positions')) {
    db.positions.push({
      id: params[0],
      name: params[1],
      code: params[2],
      type: params[3],
      market: params[4],
      keywords: params[5],
      excludeKeywords: params[6],
      enableAIAnalysis: params[7],
      impactThreshold: params[8],
      emailAlertThreshold: params[9],
      createdAt: params[10],
      updatedAt: params[11]
    });
  }

  if (sql.startsWith('INSERT INTO articles')) {
    // 检查是否存在
    const exists = db.articles.find(a => a.url === params[5]);
    if (!exists) {
      db.articles.push({
        id: params[0],
        source: params[1],
        sourceName: params[2],
        title: params[3],
        summary: params[4],
        url: params[5],
        publishTime: params[6],
        fetchedTime: params[7],
        keywords: [],
        notified: false
      });
    }
  }

  if (sql.startsWith('INSERT INTO notifications')) {
    db.notifications.push({
      id: params[0],
      articleId: params[1],
      positionId: params[2],
      email: params[3],
      type: params[4],
      sentTime: params[5],
      status: params[6],
      error: params[7]
    });
  }

  if (sql.startsWith('UPDATE positions')) {
    const id = params[params.length - 1];
    const index = db.positions.findIndex(p => p.id === id);
    if (index !== -1) {
      db.positions[index] = {
        ...db.positions[index],
        name: params[0],
        code: params[1],
        type: params[2],
        market: params[3],
        keywords: params[4],
        excludeKeywords: params[5],
        enableAIAnalysis: params[6],
        impactThreshold: params[7],
        emailAlertThreshold: params[8],
        updatedAt: params[9]
      };
    }
  }

  if (sql.startsWith('UPDATE articles')) {
    const id = params[params.length - 1];
    const index = db.articles.findIndex(a => a.id === id);
    if (index !== -1) {
      // 根据 SQL 内容更新
      if (sql.includes('keywords = ?')) {
        db.articles[index].keywords = JSON.parse(params[0]);
      }
      // 处理 aiImpact 字段更新 - 需要解析SQL中的字段顺序
      if (sql.includes('aiImpactScore = ?') || sql.includes('aiImpactDirection = ?')) {
        // 解析SQL中的字段顺序，例如：SET aiImpactDirection = ?, aiImpactScore = ?, aiImpactReason = ?
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
        if (setMatch) {
          const setClause = setMatch[1];
          // 提取所有字段名（按顺序）
          const fieldMatches = [...setClause.matchAll(/(aiImpact\w+)\s*=\s*\?/g)];
          const fields = fieldMatches.map(m => m[1]);
          
          // 根据字段顺序赋值（排除最后的id参数）
          const values = params.slice(0, -1);
          fields.forEach((field, i) => {
            if (i < values.length) {
              db.articles[index][field] = values[i];
            }
          });
        }
      }
      if (sql.includes('content = ?')) {
        db.articles[index].content = params[0];
      }
      if (sql.includes('notified = 1')) {
        db.articles[index].notified = true;
      }
    }
  }

  if (sql.startsWith('UPDATE settings')) {
    db.settings[params[1]] = params[0];
  }

  if (sql.startsWith('DELETE FROM positions')) {
    const id = params[0];
    db.positions = db.positions.filter(p => p.id !== id);
  }

  saveDb();
}

export function closeDb(): void {
  saveDb();
}

// 便捷别名
export function getDb() {
  return {
    prepare: (sql: string) => ({
      all: (...params: any[]) => queryAll(sql, params),
      get: (...params: any[]) => queryOne(sql, params),
      run: (...params: any[]) => run(sql, params)
    })
  };
}
