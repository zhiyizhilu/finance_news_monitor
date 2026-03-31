// 新闻文章
export interface NewsArticle {
  id: string;
  source: string;
  sourceName: string;
  title: string;
  summary: string;
  content?: string;
  url: string;
  publishTime: Date;
  fetchedTime: Date;
  keywords: string[];
  aiImpactScore?: number;
  aiImpactDirection?: '利好' | '利空' | '中性';
  aiImpactReason?: string;
  positionAnalysis?: PositionAnalysis[]; // 每个持仓的详细分析结果
  notified: boolean;
  notificationLevel?: 'high' | 'medium' | 'low';
}

// 持仓
export interface Position {
  id: string;
  name: string;
  code: string;
  type: 'stock' | 'etf' | 'commodity' | 'bond' | 'fund';
  market: 'A' | 'HK' | 'US' | 'commodity';
  keywords: string[];
  excludeKeywords?: string[];
  enableAIAnalysis: boolean;
  impactThreshold: number;
  emailAlertThreshold?: number; // 邮件提醒阈值，超过此分数发送邮件
  createdAt: Date;
  updatedAt: Date;
}

// 投资组合
export interface Portfolio {
  id: string;
  name: string;
  positions: Position[];
  email: string;
  emailEnabled: boolean;
  realtimeHighImpact: boolean;
  scheduledTimes: string[];
}

// 新闻源
export interface NewsSource {
  id: string;
  name: string;
  url: string;
  category: 'macro' | 'policy' | 'capital' | 'commodity' | 'tech' | 'other';
  type: 'rss' | 'html' | 'api';
  enabled: boolean;
  fetchInterval: number; // 分钟
}

// 系统设置
export interface SystemSettings {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  notifyEmail: string;
  openRouterApiKey: string;
  aiModel: string;
  fetchInterval: number;
  scheduledTimes: string[];
}

// AI 分析结果
export interface AIAnalysisResult {
  impact: '利好' | '利空' | '中性';
  score: number;
  reason: string;
}

// 单个持仓的AI分析结果
export interface PositionAnalysis {
  positionCode: string;
  positionName: string;
  impact: '利好' | '利空' | '中性' | '无关';
  score: number;
  reason: string;
}

// 多持仓AI分析结果
export interface MultiPositionAnalysisResult {
  overallImpact: '利好' | '利空' | '中性';
  overallScore: number;
  analysis: PositionAnalysis[];
  summary: string;
}

// 通知记录
export interface NotificationRecord {
  id: string;
  articleId: string;
  positionId: string;
  email: string;
  type: 'realtime' | 'scheduled';
  sentTime: Date;
  status: 'success' | 'failed';
  error?: string;
}
