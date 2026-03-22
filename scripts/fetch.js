import RSSParser from 'rss-parser';
import { extract } from '@extractus/article-extractor';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const parser = new RSSParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'DailyReads/1.0 (RSS Reader)',
  },
});

// Load sources
const sources = JSON.parse(
  readFileSync(join(__dirname, 'sources.json'), 'utf-8')
).sources;

/**
 * Fetch articles from all RSS sources
 */
async function fetchAllFeeds() {
  console.log(`Fetching from ${sources.length} sources...`);
  const allArticles = [];

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      try {
        const feed = await parser.parseURL(source.url);
        const articles = (feed.items || []).slice(0, 5).map((item) => ({
          title: item.title || '',
          link: item.link || '',
          description: item.contentSnippet || item.content || '',
          pubDate: item.pubDate || item.isoDate || '',
          sourceName: source.name,
          sourceId: source.id,
          region: source.region,
          country: source.country,
          categories: source.categories,
        }));
        return articles;
      } catch (err) {
        console.warn(`Failed to fetch ${source.name}: ${err.message}`);
        return [];
      }
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allArticles.push(...result.value);
    }
  }

  console.log(`Fetched ${allArticles.length} articles total`);
  return allArticles;
}

/**
 * Filter: recent articles (within 3 days), with valid links
 */
function filterRecent(articles) {
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  return articles.filter((a) => {
    if (!a.link || !a.title) return false;
    if (a.pubDate) {
      const d = new Date(a.pubDate).getTime();
      if (!isNaN(d) && d < threeDaysAgo) return false;
    }
    return true;
  });
}

/**
 * Select 3 articles ensuring source diversity
 * - No two articles from the same source
 * - Try to cover different regions
 * - Prefer longer descriptions (likely more substantive)
 */
function selectThree(articles) {
  // Shuffle for randomness
  const shuffled = articles.sort(() => Math.random() - 0.5);

  const selected = [];
  const usedSources = new Set();
  const usedRegions = new Set();

  // First pass: maximize region diversity
  for (const article of shuffled) {
    if (selected.length >= 3) break;
    if (usedSources.has(article.sourceId)) continue;
    if (!usedRegions.has(article.region)) {
      selected.push(article);
      usedSources.add(article.sourceId);
      usedRegions.add(article.region);
    }
  }

  // Second pass: fill remaining slots with different sources
  for (const article of shuffled) {
    if (selected.length >= 3) break;
    if (usedSources.has(article.sourceId)) continue;
    selected.push(article);
    usedSources.add(article.sourceId);
  }

  return selected;
}

/**
 * Hard timeout wrapper
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Extract full article content from URL
 */
async function extractArticle(url) {
  try {
    const article = await withTimeout(extract(url), 10000);
    if (article && article.content) {
      const text = article.content
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, 5000);
    }
  } catch (err) {
    console.warn(`Failed to extract ${url}: ${err.message}`);
  }
  return null;
}

/**
 * Generate Chinese summary using DeepSeek API (OpenAI-compatible)
 */
async function generateSummary(title, content, sourceName) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.AI_MODEL || 'deepseek-chat';

  if (!apiKey) {
    console.warn('No AI_API_KEY set, using description as fallback');
    return null;
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`,
  });

  try {
    const response = await withTimeout(
      client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content:
              '你是一位资深新闻编辑。请将以下英文报道用中文总结为3段：第一段用一句话说明核心事件或论点；第二段展开关键细节和背景；第三段点出这篇报道的独特价值或启发。总字数控制在200-300字。语言要简洁有力，不要翻译腔。',
          },
          {
            role: 'user',
            content: `来源: ${sourceName}\n标题: ${title}\n\n正文:\n${content}`,
          },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
      30000
    );

    return response.choices[0]?.message?.content || null;
  } catch (err) {
    console.warn(`AI summary failed: ${err.message}`);
    return null;
  }
}

/**
 * Main pipeline
 */
async function main() {
  console.log('=== Daily Reads - Fetching ===');
  console.log(new Date().toISOString());

  // 1. Fetch all feeds
  const allArticles = await fetchAllFeeds();

  // 2. Filter recent
  const recent = filterRecent(allArticles);
  console.log(`${recent.length} recent articles after filtering`);

  // 3. Select 3
  const selected = selectThree(recent);
  console.log(
    `Selected: ${selected.map((a) => `[${a.sourceName}] ${a.title}`).join('\n          ')}`
  );

  // 4. Extract full text and generate summaries
  const output = [];
  for (const article of selected) {
    console.log(`Processing: ${article.title}`);
    const fullText = await extractArticle(article.link);
    const contentForSummary = fullText || article.description;

    let summary = null;
    if (contentForSummary) {
      summary = await generateSummary(
        article.title,
        contentForSummary,
        article.sourceName
      );
    }

    output.push({
      title: article.title,
      link: article.link,
      sourceName: article.sourceName,
      sourceId: article.sourceId,
      region: article.region,
      country: article.country,
      pubDate: article.pubDate,
      description: article.description.slice(0, 500),
      summary: summary || '（摘要生成中，请点击阅读原文）',
      fetchedAt: new Date().toISOString(),
    });
  }

  // 5. Write output
  const dataDir = join(__dirname, '..', 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const outputData = {
    date: today,
    articles: output,
    generatedAt: new Date().toISOString(),
  };

  // Write as latest.json (for the frontend)
  writeFileSync(
    join(dataDir, 'latest.json'),
    JSON.stringify(outputData, null, 2),
    'utf-8'
  );

  // Also archive by date
  writeFileSync(
    join(dataDir, `${today}.json`),
    JSON.stringify(outputData, null, 2),
    'utf-8'
  );

  // Copy latest.json to public/ for the frontend
  const publicDir = join(__dirname, '..', 'public');
  if (!existsSync(join(publicDir, 'data')))
    mkdirSync(join(publicDir, 'data'), { recursive: true });
  writeFileSync(
    join(publicDir, 'data', 'latest.json'),
    JSON.stringify(outputData, null, 2),
    'utf-8'
  );

  console.log(`\nDone! Saved ${output.length} articles for ${today}`);
}

// Global timeout: force exit after 5 minutes
setTimeout(() => {
  console.error('Global timeout reached (5min), force exiting');
  process.exit(1);
}, 5 * 60 * 1000);

main().catch(console.error);
