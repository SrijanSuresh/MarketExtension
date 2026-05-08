// MarketExtension — Segment 3 (refactor): scatter/gather Kosmos search.

const KOSMOS_SEARCH_URL = "https://api.kosmos.fyi/api/v2/search";
const MAX_KEYWORDS = 3;
const MIN_WORD_LEN = 2;

// Compact stop-word set: common English filler + the examples called out in the spec.
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "else", "of", "in", "on", "at",
  "to", "for", "with", "by", "from", "as", "is", "am", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "should", "could", "may", "might", "must", "shall", "can", "this",
  "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "me",
  "him", "her", "us", "them", "my", "your", "his", "its", "our", "their",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "now", "up", "down", "out", "off", "over", "under", "again", "then",
  "once", "here", "there", "about", "above", "below", "before", "after",
  "into", "through", "during", "until", "while", "against", "between",
  "because", "sometimes", "true", "false", "rt", "via",
]);

/**
 * Returns up to MAX_KEYWORDS high-value keyword strings extracted from `text`.
 *
 * Strategy:
 *   1. Strip URLs, @ / # markers, and punctuation.
 *   2. Split into sentences (on . ! ? and newlines) so we can identify which
 *      capitalized words are *mid-sentence* (= likely proper nouns) vs.
 *      sentence-initial (= ambiguous; could just be sentence capitalization).
 *   3. Prefer mid-sentence capitalized words ("named entities") in document
 *      order. If that gives us fewer than MAX_KEYWORDS, fill the remaining
 *      slots with the longest leftover words (more specific terms).
 *   4. Case-insensitive dedup across the whole result.
 */
function extractKeywords(text) {
  if (typeof text !== "string" || !text) return [];

  const stripped = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[@#]/g, " ");

  const sentences = stripped.split(/[.!?\n]+/);

  const namedEntities = [];
  const fallbackPool = [];
  const seen = new Set();

  for (const sentence of sentences) {
    const tokens = sentence.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const w = tokens[i];
      if (w.length < MIN_WORD_LEN) continue;
      const lower = w.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);

      const startsWithUpper = /^\p{Lu}/u.test(w);
      const isMidSentence = i > 0;
      if (startsWithUpper && isMidSentence) {
        namedEntities.push(w);
      } else {
        fallbackPool.push(w);
      }
    }
  }

  // Longest first — longer tokens tend to be more specific.
  fallbackPool.sort((a, b) => b.length - a.length);

  return [...namedEntities, ...fallbackPool].slice(0, MAX_KEYWORDS);
}

/**
 * Single-keyword search. Always resolves — never throws — so it can be safely
 * used inside a Promise.all() without one bad request killing the batch.
 * Returns { signals: [...], markets: [...], error? }.
 */
async function searchOneKeyword(keyword) {
  const empty = { signals: [], markets: [], keyword };
  if (!keyword) return { ...empty, error: "empty_query" };

  const url = `${KOSMOS_SEARCH_URL}?q=${encodeURIComponent(keyword)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    console.warn("[MarketExtension] network error for", keyword, err);
    return { ...empty, error: "network_error" };
  }

  if (res.status === 503) {
    console.warn("[MarketExtension] 503 for", keyword);
    return { ...empty, error: "service_unavailable" };
  }
  if (!res.ok) {
    console.warn("[MarketExtension] HTTP", res.status, "for", keyword);
    return { ...empty, error: `http_${res.status}` };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.warn("[MarketExtension] JSON parse failed for", keyword, err);
    return { ...empty, error: "bad_json" };
  }

  if (json?.error) {
    console.warn("[MarketExtension] envelope error for", keyword, json.error);
    return { ...empty, error: json.error?.code ?? "envelope_error" };
  }

  const data = json?.data ?? {};
  return {
    keyword,
    signals: Array.isArray(data.signals) ? data.signals : [],
    markets: Array.isArray(data.markets) ? data.markets : [],
  };
}

/**
 * Scatter/gather across an array of keywords:
 *   - One parallel fetch per keyword (Promise.all).
 *   - Per-request errors are isolated; one failed keyword cannot abort the
 *     batch.
 *   - Merged results are deduplicated by `id`.
 *
 * Returns { signals, markets, error? }. The aggregate `error` is only set
 * when *every* request failed and nothing came back.
 */
async function searchKosmos(keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) {
    return { signals: [], markets: [], error: "empty_query" };
  }

  const results = await Promise.all(keywords.map(searchOneKeyword));

  const seenSignals = new Set();
  const seenMarkets = new Set();
  const signals = [];
  const markets = [];
  const errors = [];

  for (const r of results) {
    if (r.error) errors.push(r.error);

    for (const s of r.signals) {
      const id = s?.id;
      if (id) {
        if (seenSignals.has(id)) continue;
        seenSignals.add(id);
      }
      signals.push(s);
    }

    for (const m of r.markets) {
      const id = m?.id;
      if (id) {
        if (seenMarkets.has(id)) continue;
        seenMarkets.add(id);
      }
      markets.push(m);
    }
  }

  const out = { signals, markets };
  // Only surface an error if literally nothing came back from any keyword.
  if (
    signals.length === 0 &&
    markets.length === 0 &&
    errors.length === results.length &&
    errors.length > 0
  ) {
    out.error = errors[0];
  }
  return out;
}

// --- Lifecycle / side panel ---

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[MarketExtension] sidePanel setup failed:", err));

chrome.runtime.onInstalled.addListener(() => {
  console.log("[MarketExtension] installed");
});

// --- Message router ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TWEET_FOCUSED") {
    sendResponse({ ok: true });
    return false;
  }

  const text = message.payload?.text ?? "";
  const keywords = extractKeywords(text);
  // Joined string preserved for the side-panel status line; new consumers can
  // use the structured `keywords` array.
  const query = keywords.join(", ");
  console.log("[MarketExtension] tweet focused:", { text, keywords });

  // Run the async work without blocking the message channel.
  (async () => {
    const result = await searchKosmos(keywords);
    const payload = {
      query,
      keywords,
      tweet: message.payload,
      signals: result.signals,
      markets: result.markets,
      ...(result.error ? { error: result.error } : {}),
    };

    chrome.runtime
      .sendMessage({ type: "API_RESULTS", payload })
      .catch(() => {
        // Side panel may be closed — that's fine, it'll pick up the next one.
      });
  })();

  sendResponse({ ok: true });
  return false;
});

// Surfaced for devtools inspection / future tests.
self.MarketExtension = { extractKeywords, searchOneKeyword, searchKosmos };
