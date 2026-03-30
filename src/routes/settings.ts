import { Router } from 'express';
import { queryAll, run } from '../config/database';
import { reloadSettings } from '../utils/helpers';

const router = Router();

// 设置页面
router.get('/', (req, res) => {
  const settingsRows = queryAll('SELECT * FROM settings');

  const settingsMap: Record<string, string> = {};
  for (const s of settingsRows) {
    settingsMap[s.key] = s.value;
  }

  res.render('settings', {
    title: '系统设置',
    settings: settingsMap
  });
});

// 保存设置 - 使用 upsert 逻辑
function saveSetting(key: string, value: string): void {
  const existing = queryAll('SELECT key FROM settings WHERE key = ?', [key]);
  if (existing.length > 0) {
    run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  } else {
    run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }
}

router.post('/save', (req, res) => {
  const {
    smtpHost, smtpPort, smtpSecure,
    smtpUser, smtpPass, notifyEmail,
    openRouterApiKey, ollamaApiKey, ollamaUrl, opencodeCliPath,
    aiProvider, aiModel,
    fetchInterval, scheduledTimes
  } = req.body;

  if (smtpHost !== undefined) saveSetting('smtpHost', smtpHost || '');
  if (smtpPort !== undefined) saveSetting('smtpPort', smtpPort || '465');
  saveSetting('smtpSecure', smtpSecure === 'on' ? 'true' : 'false');
  if (smtpUser !== undefined) saveSetting('smtpUser', smtpUser || '');
  if (smtpPass && smtpPass.trim()) saveSetting('smtpPass', smtpPass);
  if (notifyEmail !== undefined) saveSetting('notifyEmail', notifyEmail || '');
  if (openRouterApiKey && openRouterApiKey.trim()) saveSetting('openRouterApiKey', openRouterApiKey);
  if (ollamaApiKey && ollamaApiKey.trim()) saveSetting('ollamaApiKey', ollamaApiKey);
  if (ollamaUrl !== undefined) saveSetting('ollamaUrl', ollamaUrl || 'https://api.ollama.com');
  if (opencodeCliPath !== undefined) saveSetting('opencodeCliPath', opencodeCliPath || '');
  if (aiProvider !== undefined) saveSetting('aiProvider', aiProvider || 'openrouter');
  if (aiModel !== undefined) saveSetting('aiModel', aiModel || 'deepseek/deepseek-chat:free');
  if (fetchInterval !== undefined) saveSetting('fetchInterval', fetchInterval || '30');
  if (scheduledTimes !== undefined) saveSetting('scheduledTimes', scheduledTimes || '08:00,12:00,18:00');

  reloadSettings();

  // 重新读取设置后渲染页面（带成功提示）
  const settingsRows = queryAll('SELECT * FROM settings');
  const settingsMap: Record<string, string> = {};
  for (const s of settingsRows) { settingsMap[s.key] = s.value; }

  res.render('settings', { title: '系统设置', settings: settingsMap, saved: true });
});

// 测试 AI API 连通性
router.post('/test-ai', async (req, res) => {
  const axios = require('axios');
  try {
    // 优先使用请求中的参数，如果没有则使用数据库配置
    const body = req.body || {};
    const settingsRows = queryAll('SELECT * FROM settings');
    const dbConfig: any = {};
    for (const s of settingsRows) { dbConfig[s.key] = s.value; }

    // 规范化 aiProvider 值
    let aiProvider = (body.aiProvider || dbConfig.aiProvider || 'opencode').toString().trim().toLowerCase();
    if (!['openrouter', 'ollama', 'opencode'].includes(aiProvider)) {
      console.log(`[TestAI] 未知的 aiProvider 值: "${aiProvider}", 使用默认值 opencode`);
      aiProvider = 'opencode';
    }
    
    const model = body.aiModel || dbConfig.aiModel || 'opencode/big-pickle';
    console.log(`[TestAI] 测试连通性: provider=${aiProvider}, model=${model}`);

    if (aiProvider === 'openrouter') {
      const apiKey = body.openRouterApiKey || dbConfig.openRouterApiKey;
      if (!apiKey) {
        return res.json({ success: false, message: '未配置 OpenRouter API Key' });
      }
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: '请回复"ok"，不需要其他内容。' }],
          max_tokens: 10
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://finnews-monitor.local',
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      );
      const reply = response.data?.choices?.[0]?.message?.content || '(无回复)';
      return res.json({ success: true, message: `✅ 连接成功！模型: ${model}，回复: ${reply.substring(0, 50)}` });

    } else if (aiProvider === 'ollama') {
      const ollamaApiKey = body.ollamaApiKey || dbConfig.ollamaApiKey;
      const ollamaBase = (body.ollamaUrl || dbConfig.ollamaUrl || 'https://ollama.com').replace(/\/$/, '');
      if (!ollamaApiKey) {
        return res.json({ success: false, message: '未配置 Ollama API Key' });
      }
      const response = await axios.post(
        `${ollamaBase}/api/chat`,
        {
          model,
          messages: [{ role: 'user', content: '请回复"ok"，不需要其他内容。' }],
          stream: false
        },
        {
          headers: {
            'Authorization': `Bearer ${ollamaApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      );
      const reply = response.data?.message?.content || response.data?.choices?.[0]?.message?.content || '(无回复)';
      return res.json({ success: true, message: `✅ 连接成功！模型: ${model}，回复: ${reply.substring(0, 50)}` });

    } else if (aiProvider === 'opencode') {
      // OpenCode 本地测试
      const { getOpenCodeClient } = require('../modules/analyzer/opencode-client');
      const cliPath = body.opencodeCliPath || dbConfig.opencodeCliPath;
      const client = getOpenCodeClient(cliPath || undefined);
      
      try {
        await client.ensureStarted();
        const reply = await client.chat([
          { role: 'user', content: '请回复"ok"，不需要其他内容。' }
        ]);
        return res.json({ success: true, message: `✅ OpenCode 本地服务连接成功！回复: ${reply.substring(0, 50)}` });
      } catch (error: any) {
        return res.json({ success: false, message: `❌ OpenCode 连接失败: ${error.message}` });
      }

    } else {
      return res.json({ success: false, message: '未知的 AI 服务提供商' });
    }
  } catch (error: any) {
    const statusCode = error?.response?.status;
    const errMsg = error?.response?.data?.error?.message || error.message || '未知错误';
    let hint = '';
    if (statusCode === 401) hint = '（API Key 无效或已过期）';
    else if (statusCode === 402) hint = '（账户余额不足，请使用免费模型或充值）';
    else if (statusCode === 404) hint = '（模型不存在，请检查模型名称）';
    else if (statusCode === 429) hint = '（请求频率超限，请稍后再试）';
    return res.json({ success: false, message: `❌ 连接失败 [${statusCode || 'N/A'}]${hint}: ${errMsg}` });
  }
});

// 获取 OpenCode 模型列表
router.get('/opencode-models', async (req, res) => {
  try {
    const { getOpenCodeClient } = require('../modules/analyzer/opencode-client');
    const settingsRows = queryAll('SELECT * FROM settings');
    const config: any = {};
    for (const s of settingsRows) { config[s.key] = s.value; }
    
    const client = getOpenCodeClient(config.opencodeCliPath || undefined);
    const models = await client.listModels();
    
    res.json({ success: true, models });
  } catch (error: any) {
    console.error('[Settings] 获取 OpenCode 模型列表失败:', error);
    // 返回默认模型列表
    res.json({ 
      success: true, 
      models: [
        'opencode/mimo-v2-omni-free',
        'opencode/mimo-v2-pro-free',
        'opencode/minimax-m2.5-free',
        'opencode/nemotron-3-super-free',
        'opencode/big-pickle',
        'opencode/gpt-5-nano'
      ],
      cached: true
    });
  }
});

// 检测 OpenCode CLI 路径
router.get('/detect-opencode', async (req, res) => {
  try {
    const { detectOpenCodePath } = require('../modules/analyzer/opencode-client');
    const result = detectOpenCodePath();
    res.json(result);
  } catch (error: any) {
    res.json({ found: false, path: '', message: '检测失败: ' + error.message });
  }
});

// 获取 OpenRouter 免费模型列表
router.get('/openrouter-models', async (req, res) => {
  try {
    const axios = require('axios');
    const response = await axios.get('https://openrouter.ai/api/v1/models', {
      timeout: 10000
    });
    
    // 过滤出免费模型（以 :free 结尾）
    const allModels = response.data.data || [];
    const freeModels = allModels
      .filter((m: any) => m.id && m.id.endsWith(':free'))
      .map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        description: m.description || ''
      }));
    
    res.json({ success: true, models: freeModels });
  } catch (error: any) {
    console.error('[Settings] 获取 OpenRouter 模型列表失败:', error.message);
    // 返回默认的免费模型列表
    res.json({ 
      success: true, 
      models: [
        { id: 'deepseek/deepseek-chat:free', name: 'deepseek/deepseek-chat:free' },
        { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'meta-llama/llama-3.3-70b-instruct:free' },
        { id: 'nvidia/llama-3.1-nemotron-70b-instruct:free', name: 'nvidia/llama-3.1-nemotron-70b-instruct:free' },
        { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'qwen/qwen-2.5-72b-instruct:free' }
      ],
      cached: true
    });
  }
});

// 测试邮件
router.post('/test-email', async (req, res) => {
  const nodemailer = require('nodemailer');

  try {
    const settingsRows = queryAll('SELECT * FROM settings');

    const config: any = {};
    for (const s of settingsRows) {
      config[s.key] = s.value;
    }

    if (!config.smtpUser || !config.smtpPass || !config.notifyEmail) {
      return res.json({ success: false, message: '邮件配置不完整' });
    }

    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: parseInt(config.smtpPort),
      secure: config.smtpSecure === 'true',
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass
      }
    });

    await transporter.sendMail({
      from: `"FinNews Monitor" <${config.smtpUser}>`,
      to: config.notifyEmail,
      subject: 'FinNews Monitor - 测试邮件',
      html: '<p>这是一封测试邮件，证明邮件配置正确。</p>'
    });

    res.json({ success: true, message: '测试邮件发送成功' });
  } catch (error) {
    res.json({ success: false, message: (error as Error).message });
  }
});

export default router;
