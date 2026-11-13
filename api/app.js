// Stock Coach app: secure bridge between the app and your GitHub repo.
// Needs 3 Vercel settings: GITHUB_TOKEN, GITHUB_REPO (like "name/stock-agent"), APP_PIN.
const FILES = {
  latest: ["latest.json", {}],
  notifications: ["notifications.json", []],
  history: ["history.json", []],
  lessons: ["lessons.json", []],
  portfolio: ["portfolio.json", { trades: [] }],
  preferences: ["preferences.json", { interested: [], ignored: [] }],
  holdings: ["holdings.json", []],
  settings: ["settings.json", { starting_cash: 1000 }],
  push: ["push_subscriptions.json", []],
};

function gh(path, opts = {}) {
  return fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "stock-coach-app",
      ...(opts.headers || {}),
    },
  });
}

async function readFile(name, fallback) {
  const r = await gh(`data/${name}`);
  if (r.status === 404) return { value: fallback, sha: null };
  if (!r.ok) throw new Error(`GitHub said ${r.status} when reading ${name}. Check GITHUB_TOKEN and GITHUB_REPO in Vercel.`);
  const j = await r.json();
  const text = Buffer.from(j.content, "base64").toString("utf8").replace(/\bNaN\b|-?\bInfinity\b/g, "null");
  return { value: JSON.parse(text), sha: j.sha };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO || !process.env.APP_PIN) {
    return res.status(500).json({ error: "Vercel is missing GITHUB_TOKEN, GITHUB_REPO or APP_PIN." });
  }
  if (req.headers["x-pin"] !== process.env.APP_PIN) {
    return res.status(401).json({ error: "That PIN doesn't match." });
  }
  try {
    if (req.method === "GET") {
      const out = {};
      await Promise.all(Object.entries(FILES).map(async ([key, [file, fallback]]) => {
        out[key] = (await readFile(file, fallback)).value;
      }));
      out.portfolio = { trades: (out.portfolio.trades || []).slice(-30) };
      delete out.push;
      out.history = (out.history || []).filter((h) => typeof h.value === "number");
      return res.status(200).json(out);
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const clean = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
      const type = body.type || "list";
      let file, change;

      if (type === "list") {            // Follow / Ignore
        const ticker = clean(body.ticker), list = body.list;
        if (!ticker || !["interested", "ignored", "none"].includes(list)) return res.status(400).json({ error: "Send a ticker and a list." });
        file = "preferences.json";
        change = (v) => {
          const p = { interested: (v.interested || []).filter((t) => t !== ticker), ignored: (v.ignored || []).filter((t) => t !== ticker) };
          if (list !== "none") p[list].push(ticker);
          return p;
        };
      } else if (type === "holding") {  // your real stocks
        const ticker = clean(body.ticker), shares = Number(body.shares), avg = Number(body.avg_cost || 0);
        if (!ticker || !(shares >= 0) || !(avg >= 0)) return res.status(400).json({ error: "Enter a symbol, shares and price." });
        file = "holdings.json";
        change = (v) => {
          const list = (Array.isArray(v) ? v : []).filter((h) => h.ticker !== ticker);
          if (shares > 0) list.push({ ticker, shares, avg_cost: avg });
          return list;
        };
      } else if (type === "settings") { // practice budget
        const cash = Number(body.starting_cash);
        if (!(cash >= 100 && cash <= 10000000)) return res.status(400).json({ error: "Budget must be between $100 and $10,000,000." });
        file = "settings.json";
        change = (v) => ({ ...v, starting_cash: cash, ...(body.reset ? { reset_id: new Date().toISOString() } : {}) });
      } else if (type === "push") {     // phone notifications
        const sub = body.subscription || {};
        if (!/^https:\/\//.test(sub.endpoint || "") || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return res.status(400).json({ error: "That notification setup didn't look right." });
        }
        file = "push_subscriptions.json";
        change = (v) => [...(Array.isArray(v) ? v : []).filter((x) => x.endpoint !== sub.endpoint),
                         { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }].slice(-10);
      } else {
        return res.status(400).json({ error: "Unknown request." });
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const key = Object.keys(FILES).find((k) => FILES[k][0] === file);
        const { value, sha } = await readFile(file, FILES[key][1]);
        const updated = change(value);
        const r = await gh(`data/${file}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `App: update ${file}`,
            content: Buffer.from(JSON.stringify(updated, null, 2)).toString("base64"),
            ...(sha ? { sha } : {}),
          }),
        });
        if (r.ok) return res.status(200).json(key === "push" ? { push: "saved" } : { [key]: updated });
        if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub said ${r.status} when saving.`);
      }
      throw new Error("Couldn't save right now. Try again in a moment.");
    }

    res.status(405).json({ error: "Not allowed." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
// end of file
