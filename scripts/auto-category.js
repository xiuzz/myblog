// Auto-categorize posts based on content and tags before generation.
// Rules: network > daily > algo > kernel > other

const RULES = [
  {
    cat: 'network',
    keywords: ['网络', 'TCP', 'UDP', 'HTTP', 'DNS', 'TLS', 'SSL', 'socket',
               'IP', 'QUIC', 'WebSocket', 'REST', 'API', 'grpc', 'proxy'],
  },
  {
    cat: 'daily',
    keywords: ['博客', '日常', '生活', '随笔', '杂谈', '记录'],
  },
  {
    cat: 'algo',
    keywords: ['算法', '数据结构', '排序', '搜索', '图论', '动态规划',
               'LeetCode', '复杂度', '哈希', '树', '链表'],
  },
  {
    cat: 'kernel',
    keywords: ['内核', 'kernel', '操作系统', '进程', '线程', '内存管理',
               '文件系统', '调度', '中断', '驱动', 'OS', 'Linux'],
  },
];

function catForPost(post) {
  const title = (post.title || '').toLowerCase();
  const tags  = (post.tags && post.tags.data || []).map(t => t.name.toLowerCase());
  const cats  = (post.categories && post.categories.data || []).map(c => c.name.toLowerCase());
  const text  = title + ' ' + tags.join(' ');
  const own   = new Set(cats);

  // If the post already has one of our canonical categories, keep it
  const canonical = RULES.map(r => r.cat);
  const hasCanonical = canonical.some(c => own.has(c));
  if (hasCanonical) return null; // nothing to change

  for (const rule of RULES) {
    if (rule.keywords.some(k => text.includes(k.toLowerCase()))) {
      return rule.cat;
    }
  }
  return 'other';
}

hexo.extend.filter.register('before_post_render', function (data) {
  const cat = catForPost(data);
  if (!cat) return data;
  // Set categories as array (Hexo's persistent format)
  data.categories = data.categories || { data: [] };
  data.categories.data = [{ name: cat }];
  return data;
});
