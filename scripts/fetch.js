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

// Time windows
const LONGFORM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Seen-links: persistent dedup across all days
const seenLinksFile = join(__dirname, '..', 'data', 'seen-links.json');

function loadSeenLinks() {
  if (!existsSync(seenLinksFile)) return new Set();
  try {
    const data = JSON.parse(readFileSync(seenLinksFile, 'utf-8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveSeenLinks(seenSet) {
  writeFileSync(seenLinksFile, JSON.stringify([...seenSet], null, 2), 'utf-8');
}

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
        const articles = (feed.items || []).slice(0, 10).map((item) => ({
          title: item.title || '',
          link: item.link || '',
          description: item.contentSnippet || item.content || '',
          pubDate: item.pubDate || item.isoDate || '',
          sourceName: source.name,
          sourceId: source.id,
          region: source.region,
          country: source.country,
          lang: source.lang || 'en',
          longform: source.longform || false,
          conservative: source.conservative || false,
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
 * Filter by recency: longform sources get 30-day window, news gets 7-day window.
 * Also filter out already-seen links.
 */
function filterArticles(articles, seenLinks) {
  const now = Date.now();
  return articles.filter((a) => {
    if (!a.link || !a.title) return false;
    if (seenLinks.has(a.link)) return false;

    if (a.pubDate) {
      const d = new Date(a.pubDate).getTime();
      if (!isNaN(d)) {
        const window = a.longform ? LONGFORM_WINDOW_MS : NEWS_WINDOW_MS;
        if (d < now - window) return false;
      }
    }
    return true;
  });
}

/**
 * Select 7 articles with slot guarantees:
 *   - 2 slots: longform/depth (New Yorker, Atlantic, Guardian Long Read, Granta, Aeon, 南风窗)
 *   - 1 slot: conservative perspective (The Economist)
 *   - 4 slots: diverse investigative/international, maximize region diversity, no source repeat
 */
function selectArticles(articles) {
  const shuffled = [...articles].sort(() => Math.random() - 0.5);

  const INVESTIGATIVE_SOURCES = new Set([
    'propublica', 'guardian-longread', 'intercept', 'reuters',
    'daily-maverick', 'the-wire',
  ]);

  const scored = shuffled.map((a) => ({
    ...a,
    score:
      (INVESTIGATIVE_SOURCES.has(a.sourceId) ? 3 : 0) +
      (a.categories?.includes('investigative') ? 2 : 0) +
      (a.description?.length > 200 ? 1 : 0),
  }));

  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);

  const selected = [];
  const usedSources = new Set();
  const usedRegions = new Set();

  // Slot 1-2: longform depth pieces
  for (const article of scored) {
    if (selected.length >= 2) break;
    if (article.longform && !usedSources.has(article.sourceId)) {
      selected.push(article);
      usedSources.add(article.sourceId);
      usedRegions.add(article.region);
    }
  }

  // Slot 3: conservative perspective
  for (const article of scored) {
    if (selected.length >= 3) break;
    if (article.conservative && !usedSources.has(article.sourceId)) {
      selected.push(article);
      usedSources.add(article.sourceId);
      usedRegions.add(article.region);
    }
  }

  // Slot 4-5: maximize region diversity
  for (const article of scored) {
    if (selected.length >= 5) break;
    if (usedSources.has(article.sourceId)) continue;
    if (!usedRegions.has(article.region)) {
      selected.push(article);
      usedSources.add(article.sourceId);
      usedRegions.add(article.region);
    }
  }

  // Slot 6-7: fill remaining
  for (const article of scored) {
    if (selected.length >= 7) break;
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
async function generateSummary(title, content, sourceName, lang) {
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

  const systemPrompt = lang === 'zh'
    ? '你是一位资深编辑。请将以下报道用中文总结为3段：第一段用一句话说明核心事件或论点；第二段展开关键细节和背景；第三段点出这篇报道的独特价值或启发。总字数控制在200-300字。语言要简洁有力。'
    : '你是一位资深新闻编辑。请将以下英文报道用中文总结为3段：第一段用一句话说明核心事件或论点；第二段展开关键细节和背景；第三段点出这篇报道的独特价值或启发。总字数控制在200-300字。语言要简洁有力，不要翻译腔。';

  try {
    const response = await withTimeout(
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
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

  const today = new Date().toISOString().slice(0, 10);
  const dataDir = join(__dirname, '..', 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Load seen links for dedup
  const seenLinks = loadSeenLinks();
  console.log(`Loaded ${seenLinks.size} seen links for dedup`);

  // 1. Fetch all feeds
  const allArticles = await fetchAllFeeds();

  // 2. Filter by recency + dedup
  const filtered = filterArticles(allArticles, seenLinks);
  console.log(`${filtered.length} articles after recency + dedup filter`);

  // 3. Select 7
  const selected = selectArticles(filtered);
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
        article.sourceName,
        article.lang
      );
    }

    output.push({
      title: article.title,
      link: article.link,
      sourceName: article.sourceName,
      sourceId: article.sourceId,
      region: article.region,
      country: article.country,
      lang: article.lang,
      longform: article.longform,
      pubDate: article.pubDate,
      description: article.description.slice(0, 500),
      summary: summary || '（摘要生成中，请点击阅读原文）',
      fetchedAt: new Date().toISOString(),
    });
  }

  // 5. Update seen-links
  for (const article of output) {
    seenLinks.add(article.link);
  }
  saveSeenLinks(seenLinks);

  // 6. Write output
  const outputData = {
    date: today,
    articles: output,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(
    join(dataDir, 'latest.json'),
    JSON.stringify(outputData, null, 2),
    'utf-8'
  );
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
}, 5 * 60 * 1000).unref();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
