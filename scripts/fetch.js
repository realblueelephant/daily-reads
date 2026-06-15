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

// How many articles to publish per day
const TARGET_COUNT = 7;
// Minimum extracted body length (chars) to consider an article usable.
// Paywalled pages and broken extractions return only a teaser; summarizing
// that produces vague, padded text. Below this threshold we skip the article
// instead of feeding a stub to the summarizer.
const MIN_CONTENT_CHARS = 800;

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
 * Rank all candidate articles into a priority-ordered list.
 *
 * We no longer hard-cap at 7 here, because extraction may fail for some
 * articles (thin content gets skipped downstream). Instead we return a fully
 * ordered candidate pool and let the main loop pick the first TARGET_COUNT
 * that pass the content gate, while keeping source/region diversity.
 *
 * Ordering favours: longform depth pieces, then investigative reporting, then
 * region diversity, with light randomization so the daily mix stays fresh.
 */
function selectArticles(articles) {
  const shuffled = [...articles].sort(() => Math.random() - 0.5);

  const INVESTIGATIVE_SOURCES = new Set([
    'propublica', 'guardian-longread', 'intercept', 'undark',
    'daily-maverick', 'the-wire',
  ]);

  const scored = shuffled.map((a) => ({
    ...a,
    score:
      (a.longform ? 4 : 0) +
      (INVESTIGATIVE_SOURCES.has(a.sourceId) ? 3 : 0) +
      (a.categories?.includes('investigative') ? 2 : 0) +
      (a.description?.length > 200 ? 1 : 0),
  }));

  // Primary order by score; ties broken randomly.
  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);

  // Interleave to spread regions out near the top so the first picks aren't
  // all from one continent, without dropping any candidate.
  const ordered = [];
  const seenRegionOnce = new Set();
  const rest = [];
  for (const a of scored) {
    if (!seenRegionOnce.has(a.region)) {
      ordered.push(a);
      seenRegionOnce.add(a.region);
    } else {
      rest.push(a);
    }
  }
  return [...ordered, ...rest];
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

  // Use Beijing time (UTC+8) for date so cron runs between 00:00-09:00 BJT produce correct date
  const now = new Date();
  const beijingMs = now.getTime() + 8 * 60 * 60 * 1000;
  const today = new Date(beijingMs).toISOString().slice(0, 10);
  const dataDir = join(__dirname, '..', 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Skip if today's data already exists (multi-cron retry guard)
  const todayFile = join(dataDir, `${today}.json`);
  if (existsSync(todayFile)) {
    console.log(`Today's data (${today}) already exists, skipping.`);
    return;
  }

  // Load seen links for dedup
  const seenLinks = loadSeenLinks();
  console.log(`Loaded ${seenLinks.size} seen links for dedup`);

  // 1. Fetch all feeds
  const allArticles = await fetchAllFeeds();

  // 2. Filter by recency + dedup
  const filtered = filterArticles(allArticles, seenLinks);
  console.log(`${filtered.length} articles after recency + dedup filter`);

  // 3. Rank candidates (more than we need, so we can skip unusable ones)
  const candidates = selectArticles(filtered);
  console.log(`${candidates.length} ranked candidates`);

  // 4. Walk candidates: extract full text, gate on length, summarize.
  //    Keep going until we have TARGET_COUNT usable articles, one per source.
  const output = [];
  const usedSources = new Set();
  for (const article of candidates) {
    if (output.length >= TARGET_COUNT) break;
    if (usedSources.has(article.sourceId)) continue;

    console.log(`Trying: [${article.sourceName}] ${article.title}`);
    const fullText = await extractArticle(article.link);

    // Quality gate: skip paywalled/broken pages that yield only a teaser.
    if (!fullText || fullText.length < MIN_CONTENT_CHARS) {
      console.warn(
        `  skipped — thin content (${fullText ? fullText.length : 0} chars < ${MIN_CONTENT_CHARS})`
      );
      continue;
    }

    const summary = await generateSummary(
      article.title,
      fullText,
      article.sourceName,
      article.lang
    );

    // If the API key is configured, a null summary means the call failed —
    // skip rather than publish a placeholder. Without a key (local dry runs),
    // fall back to a placeholder so the pipeline still produces output.
    if (!summary && process.env.AI_API_KEY) {
      console.warn('  skipped — summary generation failed');
      continue;
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
    usedSources.add(article.sourceId);
    console.log(`  kept (${output.length}/${TARGET_COUNT})`);
  }

  if (output.length < TARGET_COUNT) {
    console.warn(
      `Only ${output.length}/${TARGET_COUNT} articles passed the content gate today.`
    );
  }

  // Guard: never overwrite the live site with an empty day. If nothing passed
  // the gate (e.g. extraction service down), bail without writing so the
  // previous day's content stays up.
  if (output.length === 0) {
    console.error('No usable articles today — leaving existing data untouched.');
    process.exit(1);
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

// Global timeout: force exit after 8 minutes. Raised from 5min because we now
// may attempt extraction on extra candidates when some fail the content gate.
setTimeout(() => {
  console.error('Global timeout reached (8min), force exiting');
  process.exit(1);
}, 8 * 60 * 1000).unref();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
