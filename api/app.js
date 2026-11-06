// Stock Coach app: secure bridge between the app and your GitHub repo.
// Needs 3 Vercel settings: GITHUB_TOKEN, GITHUB_REPO (like "name/stock-agent"), APP_PIN.
const FILES = {
  latest: ["latest.json", {}],
  notifications: ["notifications.json", []],
  history: ["history.json", []],
  lessons: ["lessons.json", []],
  portfolio: ["portfolio.json", { trades: [] }],
  preferences: ["preferences.json", { interested: [], ignored: [] }],
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
  return { value: JSON.parse(Buffer.from(j.content, "base64").toString("utf8")), sha: j.sha };
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
      return res.status(200).json(out);
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const ticker = String(body.ticker || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
      const list = body.list;
      if (!ticker || !["interested", "ignored", "none"].includes(list)) {
        return res.status(400).json({ error: "Send a ticker and a list." });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const { value, sha } = await readFile("preferences.json", FILES.preferences[1]);
        const prefs = {
          interested: (value.interested || []).filter((t) => t !== ticker),
          ignored: (value.ignored || []).filter((t) => t !== ticker),
        };
        if (list !== "none") prefs[list].push(ticker);
        const r = await gh("data/preferences.json", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `App: ${ticker} set to ${list}`,
            content: Buffer.from(JSON.stringify(prefs, null, 2)).toString("base64"),
            ...(sha ? { sha } : {}),
          }),
        });
        if (r.ok) return res.status(200).json({ preferences: prefs });
        if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub said ${r.status} when saving.`);
      }
      throw new Error("Couldn't save right now. Try again in a moment.");
    }

    res.status(405).json({ error: "Not allowed." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
