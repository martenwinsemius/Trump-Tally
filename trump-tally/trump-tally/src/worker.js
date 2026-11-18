// Cloudflare Worker: serves the static site from ./public and two API routes.
//   GET  /api/feed  -> the shared list of automatically found articles
//   POST /api/sync  -> searches the RSS feeds (rate-limited), stores new hits for everyone

const FEEDS = [
  { name: "NOS", url: "https://feeds.nos.nl/nosnieuwsalgemeen" },
  { name: "NOS", url: "https://feeds.nos.nl/nosnieuwsbuitenland" },
  { name: "NOS", url: "https://feeds.nos.nl/nosnieuwspolitiek" },
  { name: "NU.nl", url: "https://www.nu.nl/rss/Algemeen" },
  { name: "NU.nl", url: "https://www.nu.nl/rss/Buitenland" },
  { name: "NRC", url: "https://www.nrc.nl/rss/" },
];

// An article is a candidate when it mentions Trump AND one of these words.
const KEYWORDS = [
  "onwaar", "onjuist", "leugen", "liegt", "logen", "geen bewijs", "onbewezen",
  "ongefundeerd", "klopt niet", "kloppen niet", "factcheck", "gefactcheckt",
  "misleidend", "valse", "onwaarheden",
];

const COOLDOWN_MS = 15 * 60 * 1000; // one real search per 15 minutes, for everyone
const MAX_ITEMS = 60;
const KEY = "auto";
const EMPTY = { items: [], lastSync: 0 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();

const tag = (block, name) => {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decode(m[1]) : "";
};

function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let link = tag(b, "link");
    if (!link) {
      const h = b.match(/<link[^>]*href="([^"]+)"/i);
      link = h ? h[1] : "";
    }
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated");
    const t = new Date(date);
    return {
      t: tag(b, "title"),
      link,
      src: source,
      d: isNaN(t) ? new Date().toISOString().slice(0, 10) : t.toISOString().slice(0, 10),
    };
  });
}

const isCandidate = (it) => {
  if (!/^https?:\/\//i.test(it.link) || !it.t) return false;
  const x = it.t.toLowerCase();
  return x.includes("trump") && KEYWORDS.some((k) => x.includes(k));
};

async function readState(env) {
  const raw = await env.FEED.get(KEY, "json");
  return raw && Array.isArray(raw.items) ? raw : { ...EMPTY };
}

async function sync(env) {
  const state = await readState(env);
  const now = Date.now();
  if (now - state.lastSync < COOLDOWN_MS) {
    return { ...state, added: 0, cooldown: true, nextAt: state.lastSync + COOLDOWN_MS, errors: [] };
  }
  // Claim the slot first so simultaneous clicks don't all trigger a search.
  await env.FEED.put(KEY, JSON.stringify({ ...state, lastSync: now }));

  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const res = await fetch(f.url, {
        headers: { "user-agent": "trump-tally/1.0 (headline links with attribution)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(f.url + " -> HTTP " + res.status);
      return parseFeed(await res.text(), f.name);
    })
  );

  const errors = [];
  const found = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") found.push(...r.value.filter(isCandidate));
    else errors.push(FEEDS[i].url);
  });

  const known = new Set(state.items.map((i) => i.link));
  const fresh = [];
  for (const it of found) {
    if (!known.has(it.link)) {
      known.add(it.link);
      fresh.push({ ...it, found: new Date(now).toISOString() });
    }
  }
  const items = state.items.concat(fresh)
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
    .slice(0, MAX_ITEMS);
  const next = { items, lastSync: now };
  await env.FEED.put(KEY, JSON.stringify(next));
  return { ...next, added: fresh.length, cooldown: false, nextAt: now + COOLDOWN_MS, errors };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/feed") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return json(await readState(env));
    }

    if (url.pathname === "/api/sync") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "Forbidden" }, 403);
      try {
        return json(await sync(env));
      } catch (e) {
        return json({ error: "Sync failed" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
