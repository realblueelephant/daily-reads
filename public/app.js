const REGION_LABELS = {
  'europe': '欧洲',
  'north-america': '北美',
  'south-asia': '南亚',
  'southeast-asia': '东南亚',
  'middle-east': '中东',
  'africa': '非洲',
  'global-south': '全球南方',
  'global': '全球',
  'east-asia': '东亚',
  'latin-america': '拉美',
};

function formatDate(dateStr) {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const weekday = weekdays[d.getDay()];
  return `${year}年${month}月${day}日 周${weekday}`;
}

function renderArticle(article) {
  const region = REGION_LABELS[article.region] || article.country || '';
  const pubDate = article.pubDate
    ? new Date(article.pubDate).toLocaleDateString('zh-CN')
    : '';

  return `
    <article class="article-card">
      <div class="article-meta">
        <span class="source-tag">${article.sourceName}</span>
        ${region ? `<span class="region-tag">${region}</span>` : ''}
        ${pubDate ? `<span>${pubDate}</span>` : ''}
      </div>
      <h2 class="article-title">${article.title}</h2>
      <div class="article-summary">${article.summary}</div>
      <a href="${article.link}" target="_blank" rel="noopener" class="read-link">
        阅读原文 →
      </a>
    </article>
  `;
}

async function loadArticles() {
  const container = document.getElementById('articles');
  const dateEl = document.getElementById('date');

  try {
    const res = await fetch('data/latest.json');
    if (!res.ok) throw new Error('No data');
    const data = await res.json();

    dateEl.textContent = formatDate(data.date);

    if (!data.articles || data.articles.length === 0) {
      container.innerHTML = `
        <div class="empty">
          <p>今天还没有更新</p>
          <p>明天再来看看吧</p>
        </div>
      `;
      return;
    }

    container.innerHTML = data.articles.map(renderArticle).join('');
  } catch (err) {
    container.innerHTML = `
      <div class="empty">
        <p>暂无数据</p>
        <p>首次部署后需要运行一次抓取</p>
      </div>
    `;
    dateEl.textContent = formatDate(new Date().toISOString());
  }
}

loadArticles();
