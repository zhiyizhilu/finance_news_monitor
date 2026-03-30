import { NewsSource } from '../types';

// 22个新闻源配置
export const newsSources: NewsSource[] = [
  // 宏观
  {
    id: 'cecn',
    name: '中国经济网',
    url: 'http://www.ce.cn/',
    category: 'macro',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  },
  {
    id: 'wallstreetcn',
    name: '华尔街见闻',
    url: 'https://api-prod.wallstreetcn.com/apiv1/content/articles?channel=global-channel&cursor=&limit=30',
    category: 'macro',
    type: 'api',
    enabled: true,
    fetchInterval: 30
  },
  {
    id: 'yicai',
    name: '第一财经',
    url: 'https://www.yicai.com/news/',
    category: 'macro',
    type: 'html',
    enabled: true,
    fetchInterval: 30
  },
  {
    id: 'caixin',
    name: '财新',
    url: 'https://www.caixin.com/',
    category: 'macro',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },
  {
    id: 'sina-finance',
    name: '新浪财经',
    url: 'https://finance.sina.com.cn/',
    category: 'macro',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },
  {
    id: 'ifeng-finance',
    name: '凤凰网财经',
    url: 'https://finance.ifeng.com/',
    category: 'macro',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  },

  // 政策
  {
    id: 'cnfin',
    name: '新华财经',
    url: 'https://www.cnfin.com/',
    category: 'policy',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },
  {
    id: 'ndrc',
    name: '发改委',
    url: 'https://www.ndrc.gov.cn/',
    category: 'policy',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  },
  {
    id: 'mof',
    name: '财政部',
    url: 'https://www.mof.gov.cn/zhengwuxinxi/',
    category: 'policy',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  },
  {
    id: 'nfra',
    name: '金管总局',
    url: 'https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemPId=914&itemId=915&itemUrl=ItemListRightList.html&itemName=%E7%9B%91%E7%AE%A1%E5%8A%A8%E6%80%81',
    category: 'policy',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  },
  {
    id: 'pbc',
    name: '人民银行',
    url: 'https://www.pbc.gov.cn/',
    category: 'policy',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  },
  {
    id: 'fed',
    name: '美联储',
    url: 'https://www.federalreserve.gov/newsevents/pressreleases.htm',
    category: 'policy',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },

  // 资本市场
  {
    id: 'cls',
    name: '财联社',
    url: 'https://www.cls.cn/',
    category: 'capital',
    type: 'html',
    enabled: true,
    fetchInterval: 30
  },
  {
    id: 'cnstock',
    name: '上证报',
    url: 'https://www.cnstock.com/',
    category: 'capital',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },
  {
    id: 'stcn',
    name: '证券时报',
    url: 'https://www.stcn.com/',
    category: 'capital',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },

  // 大宗商品
  {
    id: 'caixin-energy',
    name: '财新-能源',
    url: 'https://www.caixin.com/energy/',
    category: 'commodity',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },

  // 科技
  {
    id: '36kr',
    name: '36氪',
    url: 'https://36kr.com/feed',
    category: 'tech',
    type: 'rss',
    enabled: true,
    fetchInterval: 60
  },
  {
    id: 'huxiu',
    name: '虎嗅网',
    url: 'https://www.huxiu.com/',
    category: 'tech',
    type: 'html',
    enabled: true,
    fetchInterval: 60
  },
  {
    id: 'techcrunch',
    name: 'TechCrunch',
    url: 'https://techcrunch.com/',
    category: 'tech',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  },

  // 其他
  {
    id: 'tradingeconomics',
    name: 'Trading Economics',
    url: 'https://tradingeconomics.com/',
    category: 'other',
    type: 'html',
    enabled: true,
    fetchInterval: 120
  }
];

// 分类名称映射
export const categoryNames: Record<string, string> = {
  macro: '宏观',
  policy: '政策',
  capital: '资本市场',
  commodity: '大宗商品',
  tech: '科技',
  other: '其他'
};

// 获取启用的新闻源
export function getEnabledSources(): NewsSource[] {
  return newsSources.filter(s => s.enabled);
}

// 按分类获取新闻源
export function getSourcesByCategory(category: string): NewsSource[] {
  return newsSources.filter(s => s.category === category && s.enabled);
}
