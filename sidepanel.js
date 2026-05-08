// MarketExtension — Segment 4: render API_RESULTS into the side panel.

const MAX_ITEMS = 3;

const els = {
  status: document.getElementById("status"),
  tweet: document.getElementById("tweet-text"),
  markets: document.getElementById("markets"),
  signals: document.getElementById("signals"),
};

els.status.textContent = "ready";

// --- formatters -----------------------------------------------------------

function formatVolume(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

function formatSeverity(s) {
  if (typeof s !== "number" || !isFinite(s)) return "—";
  return `${Math.round(s * 100)}`;
}

// --- DOM helpers ----------------------------------------------------------

function clearList(ul) {
  while (ul.firstChild) ul.removeChild(ul.firstChild);
}

function emptyState(ul, message) {
  clearList(ul);
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = message;
  ul.appendChild(li);
}

function setStatus(text) {
  els.status.textContent = text;
}

function renderMarket(market) {
  const li = document.createElement("li");

  const left = document.createElement("span");
  left.className = "item-title";
  left.textContent = market?.title ?? "(untitled market)";

  const right = document.createElement("span");
  right.className = "item-meta";
  right.textContent = formatVolume(market?.volume_24h);

  li.appendChild(left);
  li.appendChild(right);
  return li;
}

function renderSignal(signal) {
  const li = document.createElement("li");

  const left = document.createElement("div");
  left.className = "item-title";

  const title = document.createElement("div");
  title.textContent = signal?.title ?? "(untitled signal)";
  left.appendChild(title);

  if (signal?.category) {
    const cat = document.createElement("div");
    cat.className = "item-sub";
    cat.textContent = signal.category;
    left.appendChild(cat);
  }

  const right = document.createElement("span");
  right.className = "item-meta";
  right.textContent = formatSeverity(signal?.severity);

  li.appendChild(left);
  li.appendChild(right);
  return li;
}

function renderList(ul, items, renderer, emptyMessage) {
  clearList(ul);
  if (!Array.isArray(items) || items.length === 0) {
    emptyState(ul, emptyMessage);
    return;
  }
  const slice = items.slice(0, MAX_ITEMS);
  for (const item of slice) {
    ul.appendChild(renderer(item));
  }
}

// --- message handling -----------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "TWEET_FOCUSED") {
    // Optimistically clear stale data and show a searching state while the
    // background script is fetching from Kosmos.
    const text = message.payload?.text ?? "";
    els.tweet.textContent = text || "(image-only tweet)";
    setStatus("searching…");
    emptyState(els.markets, "Searching…");
    emptyState(els.signals, "Searching…");
    return;
  }

  if (message?.type === "API_RESULTS") {
    const { query, signals, markets, error } = message.payload ?? {};

    if (error) {
      setStatus(`error: ${error}`);
    } else {
      setStatus(query ? `q: ${query}` : "ready");
    }

    renderList(els.markets, markets, renderMarket, "No relevant markets found");
    renderList(els.signals, signals, renderSignal, "No relevant signals found");
  }
});
