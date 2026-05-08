// MarketExtension — Segment 3 (refactor): scatter/gather Kosmos search,
// with an LLM-first semantic-intent layer and local-extractor fallback.

const KOSMOS_SEARCH_URL = "https://api.kosmos.fyi/api/v2/search";
const MAX_KEYWORDS = 3;
const MIN_WORD_LEN = 2;

// --- LLM layer config -----------------------------------------------------
// Leave LLM_API_KEY blank to disable the LLM layer and use only the local
// extractKeywords() fallback. NOTE: any key embedded in extension JS is
// readable by anyone who installs the extension; for production, proxy
// through a backend you control instead.
const LLM_API_KEY = "";
const LLM_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// 70b chosen for intent-synthesis quality. Cheaper / faster fallbacks:
//   "llama-3.1-8b-instant"  — much faster, weaker world knowledge
//   "llama3-8b-8192"        — original; tends to extract surface words
const LLM_MODEL = "llama-3.3-70b-versatile";
// Intent Synthesis prompt: teaches the model to identify the underlying
// market/event/entity and emit prediction-market-shaped queries, rather than
// picking salient words out of the tweet text. The word "JSON" must appear
// somewhere in this prompt for Groq's response_format=json_object mode.
const LLM_SYSTEM_PROMPT = `You are an Intent Synthesis engine for a prediction-market search system. Your job is NOT to extract words from the tweet — it is to identify the underlying real-world ENTITY, EVENT, or MARKET being discussed, then output the search terms a trader would type into a prediction market like Kosmos to find related contracts.

The difference matters:
- EXTRACTION pulls salient words from the text. This produces noise like "bombshell", "insider", or "insane".
- SYNTHESIS identifies the topic (a person, country, asset, election, conflict, policy decision, price level) and outputs market-shaped queries.

EXAMPLES

Tweet: "Trump just dropped a bombshell about insider trading at the SEC."
Wrong (extraction): ["bombshell", "insider", "SEC"]
Right (synthesis):  ["Trump 2024", "Trump indictment", "SEC enforcement"]

Tweet: "BTC just broke 100K, this is insane."
Wrong: ["broke", "100K", "insane"]
Right: ["bitcoin price", "BTC 100k", "crypto market"]

Tweet: "Iran-Israel tensions rising after overnight airstrike on Tehran."
Wrong: ["tensions", "overnight", "Tehran"]
Right: ["Iran Israel war", "Middle East conflict", "Iran strike"]

Tweet: "Powell hints at a rate cut before year-end."
Wrong: ["hints", "year-end", "Powell"]
Right: ["Fed rate cut", "FOMC December", "interest rates"]

OUTPUT
Return ONLY a JSON object of the form:
{"keywords": ["term 1", "term 2", "term 3"]}

Keep search terms extremely short (1-2 words). Prioritize broad nouns like 'Bitcoin', 'Trump', or 'Fed'.
Each term should be 1-4 words, describe a market category / entity / event (not surface words from the tweet), and use natural casing. Output 1 to 3 terms total. No explanations, no extra fields.`;
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
 * LLM-first semantic intent extraction. Calls the Anthropic Messages API to
 * pick 1–3 prediction-market-relevant keywords from the tweet. Falls back to
 * the local heuristic `extractKeywords()` when:
 *   - LLM_API_KEY is blank (LLM layer disabled),
 *   - the network request fails,
 *   - the response status is non-2xx,
 *   - JSON parsing fails (envelope or model output),
 *   - the model returns something that isn't a non-empty array of strings.
 *
 * Always resolves to a string[]. Never throws.
 */
async function extractSemanticIntent(text) {
  // 1. Immediate fallback if no key
  if (!LLM_API_KEY) return extractKeywords(text);

  // Timeout so we don't hang the pipeline if Groq stalls. 70b is slower than
  // 8b but still typically <1.5s on Groq; 5s leaves ample headroom.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(LLM_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: LLM_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("empty model content");
    }
    const parsed = JSON.parse(content);

    // Accept either {"keywords": [...]} (preferred per prompt) or a bare array.
    const candidates = Array.isArray(parsed) ? parsed : (parsed?.keywords ?? []);
    const keywords = candidates
      .filter((s) => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, MAX_KEYWORDS);

    return keywords.length > 0 ? keywords : extractKeywords(text);
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(
      "[MarketExtension] LLM intent synthesis failed/timed out, falling back:",
      err.message
    );
    return extractKeywords(text);
  }
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
  console.log("[MarketExtension] tweet focused:", { text });

  // Run the async work without blocking the message channel.
  (async () => {
    // Layered parsing: LLM-first semantic intent, falls back to the local
    // heuristic on any failure (or when no LLM key is configured).
    const keywords = await extractSemanticIntent(text);
    // Joined string preserved for the side-panel status line; new consumers
    // can use the structured `keywords` array.
    const query = keywords.join(", ");

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
self.MarketExtension = {
  extractKeywords,
  extractSemanticIntent,
  searchOneKeyword,
  searchKosmos,
};
