import { Router } from 'express';
import { queryAll, run } from '../config/database';
import { generateId, getSetting } from '../utils/helpers';
import axios from 'axios';
import { getOpenCodeClient } from '../modules/analyzer/opencode-client';

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

// 清理AI返回的内容
function cleanResponse(content: string): string {
  if (!content) return '';
  
  // 去除Markdown代码块标记
  let cleaned = content
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^```\s*/i, '')
    .trim();
  
  return cleaned;
}

// 调用AI生成关键词
async function generateKeywordsWithAI(name: string, type: string, market: string): Promise<string[]> {
  const aiProvider = await getSetting('aiProvider') || 'openrouter';
  const apiKey = await getSetting('openRouterApiKey');
  const ollamaApiKey = await getSetting('ollamaApiKey');
  const ollamaUrl = await getSetting('ollamaUrl') || 'https://api.ollama.com';
  const opencodeCliPath = await getSetting('opencodeCliPath') || '';
  const model = await getSetting('aiModel') || 'deepseek/deepseek-chat:free';

  // 检查API配置
  if (aiProvider === 'openrouter' && !apiKey) {
    console.log('OpenRouter API Key未配置，跳过AI生成');
    return [];
  }
  
  if (aiProvider === 'ollama' && !ollamaApiKey) {
    console.log('Ollama API Key未配置，跳过AI生成');
    return [];
  }
  
  if (aiProvider === 'opencode') {
    // OpenCode不需要API Key，但需要检查CLI是否可用
    console.log('使用OpenCode生成关键词，模型:', model);
  }
  
  console.log(`开始AI生成关键词，提供商: ${aiProvider}, 模型: ${model}`);

  const prompt = `你是一位专业的金融分析师。请为以下持仓生成相关的关键词，用于新闻监控。

持仓信息:
- 持仓名称: ${name}
- 持仓类型: ${type}
- 市场: ${market}

请生成10-15个最相关的关键词，包括：
1. 公司名称的不同表述（如简称、英文名称等）
2. 相关行业关键词
3. 相关产品或服务关键词
4. 相关概念或技术关键词

请直接返回关键词列表，用逗号分隔，不要包含其他内容。

示例：
宁德时代, CATL, 锂电池, 动力电池, 新能源, 新能源车, 比亚迪, 特斯拉, 光伏, 储能`;

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
      // Ollama Cloud API
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
    
    const content = cleanResponse(rawContent);
    const keywords = content.split(',').map(k => k.trim()).filter(k => k);
    
    console.log(`AI生成关键词成功，生成 ${keywords.length} 个关键词:`, keywords.slice(0, 5).join(', ') + '...');
    
    return keywords;
  } catch (error: any) {
    console.error('AI生成关键词失败:', error.message);
    return [];
  }
}

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

// 根据持仓生成关键词
router.get('/generate-keywords', async (req, res) => {
  const { name, type, market } = req.query;
  
  // 确保name是字符串
  const nameStr = typeof name === 'string' ? name : '';
  
  if (!nameStr) {
    res.json({ keywords: [] });
    return;
  }
  
  try {
    // 首先尝试使用AI生成关键词
    let keywords = await generateKeywordsWithAI(nameStr, type as string || 'stock', market as string || 'A');
    const usedAI = keywords && keywords.length > 0;
    
    // 如果AI生成失败或没有结果，使用规则生成作为备选
    if (!usedAI) {
      console.log('AI生成关键词失败，使用规则生成作为备选');
      
      // 生成关键词的逻辑
      keywords = [nameStr];
      
      // 根据持仓名称提取关键词
      const nameLower = nameStr.toLowerCase();
      
      // 常见的公司名称后缀
      const suffixes = ['公司', '集团', '控股', '股份', '有限', '科技', '实业', '发展'];
      suffixes.forEach(suffix => {
        if (nameLower.includes(suffix)) {
          keywords.push(nameStr.replace(new RegExp(suffix, 'g'), '').trim());
        }
      });
      
      // 根据类型和市场添加相关关键词
      if (type === 'stock') {
        if (market === 'A') {
          keywords.push('A股', '上市公司');
        } else if (market === 'HK') {
          keywords.push('港股');
        } else if (market === 'US') {
          keywords.push('美股', '中概股');
        }
      } else if (type === 'etf') {
        keywords.push('ETF', '指数基金');
      } else if (type === 'commodity') {
        keywords.push('大宗商品', '期货');
      } else if (type === 'bond') {
        keywords.push('债券', '利率');
      } else if (type === 'fund') {
        keywords.push('基金', '净值');
      }
      
      // 根据持仓名称关联行业关键词
      const industryKeywords: Record<string, string[]> = {
        '新能源': ['宁德时代', '比亚迪', '特斯拉', '锂电池', '动力电池', '光伏', '新能源车'],
        '半导体': ['芯片', '半导体', '晶圆代工', '集成电路'],
        '消费': ['消费', '零售', '品牌', '市场'],
        '金融': ['银行', '保险', '券商', '金融'],
        '医疗': ['医药', '医疗', '健康', '生物'],
        '科技': ['科技', '创新', '互联网', '数字化'],
        '地产': ['房地产', '房价', '楼市', '物业'],
        '能源': ['能源', '电力', '煤炭', '石油']
      };
      
      // 匹配行业关键词
      Object.entries(industryKeywords).forEach(([industry, industryKeys]) => {
        if (nameLower.includes(industry)) {
          keywords = [...keywords, ...industryKeys];
        }
      });
    }
    
    // 去重并返回
    keywords = [...new Set(keywords)].filter(k => k);
    
    res.json({ keywords, usedAI });
  } catch (error) {
    console.error('生成关键词失败:', error);
    res.json({ keywords: [], usedAI: false });
  }
});

export default router;
