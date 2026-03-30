import { Router } from 'express';
import { queryAll, run } from '../config/database';
import { generateId } from '../utils/helpers';

const router = Router();

// 获取所有持仓
router.get('/', (req, res) => {
  const positions = queryAll('SELECT * FROM positions ORDER BY createdAt DESC');

  res.render('portfolio', {
    title: '持仓管理',
    positions
  });
});

// 添加持仓
router.post('/add', (req, res) => {
  const { name, code, type, market, keywords, excludeKeywords, enableAIAnalysis, impactThreshold, emailAlertThreshold } = req.body;

  const now = new Date().toISOString();

  run(
    'INSERT INTO positions (id, name, code, type, market, keywords, excludeKeywords, enableAIAnalysis, impactThreshold, emailAlertThreshold, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      generateId(),
      name,
      code,
      type || 'stock',
      market || 'A',
      JSON.stringify(keywords ? keywords.split(',').map((k: string) => k.trim()).filter((k: string) => k) : []),
      JSON.stringify(excludeKeywords ? excludeKeywords.split(',').map((k: string) => k.trim()).filter((k: string) => k) : []),
      enableAIAnalysis === 'on' ? 1 : 0,
      parseInt(impactThreshold) || 50,
      emailAlertThreshold ? parseInt(emailAlertThreshold) : null,
      now,
      now
    ]
  );

  res.redirect('/portfolio');
});

// 编辑持仓
router.post('/edit/:id', (req, res) => {
  const { id } = req.params;
  const { name, code, type, market, keywords, excludeKeywords, enableAIAnalysis, impactThreshold, emailAlertThreshold } = req.body;

  const now = new Date().toISOString();

  run(
    'UPDATE positions SET name = ?, code = ?, type = ?, market = ?, keywords = ?, excludeKeywords = ?, enableAIAnalysis = ?, impactThreshold = ?, emailAlertThreshold = ?, updatedAt = ? WHERE id = ?',
    [
      name,
      code,
      type || 'stock',
      market || 'A',
      JSON.stringify(keywords ? keywords.split(',').map((k: string) => k.trim()).filter((k: string) => k) : []),
      JSON.stringify(excludeKeywords ? excludeKeywords.split(',').map((k: string) => k.trim()).filter((k: string) => k) : []),
      enableAIAnalysis === 'on' ? 1 : 0,
      parseInt(impactThreshold) || 50,
      emailAlertThreshold ? parseInt(emailAlertThreshold) : null,
      now,
      id
    ]
  );

  res.redirect('/portfolio');
});

// 删除持仓
router.post('/delete/:id', (req, res) => {
  const { id } = req.params;

  run('DELETE FROM positions WHERE id = ?', [id]);

  res.redirect('/portfolio');
});

// 预设关键词
const presetKeywords: Record<string, string[]> = {
  '新能源': ['宁德时代', '比亚迪', '特斯拉', '锂电池', '动力电池', '光伏', '隆基绿能', '新能源车', '电动车'],
  '半导体': ['中芯国际', '英特尔', '英伟达', '芯片', '半导体', '晶圆代工', 'AMD', '台积电'],
  '消费': ['茅台', '五粮液', '海天味业', '农夫山泉', '伊利', '蒙牛'],
  '金融': ['工商银行', '建设银行', '招商银行', '中国平安', '银行', '保险', '券商'],
  '黄金': ['黄金', 'COMEX', '伦敦金', '金价', '避险'],
  '原油': ['原油', '石油', 'OPEC', '布伦特', 'WTI', '油气']
};

// 获取预设关键词
router.get('/presets', (req, res) => {
  res.json(presetKeywords);
});

export default router;
