// Vercel Serverless Function: /api/etf?codes=009816,00955,009805,00713,00635U
// Data source (NAV + premium): MoneyDJ basic page (HTML -> text -> regex)
// Optional realtime price: TWSE mis.twse getStockInfo (best-effort)
//
// Notes:
// - Some sources may block server IPs. MoneyDJ usually OK.
// - TWSE realtime is best-effort; if fails, we keep MoneyDJ price.

module.exports = async (req, res) => {
  const codesRaw = (req.query.codes || "").toString().trim();
  const codes = codesRaw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!codes.length) {
    return res.status(400).json({ error: "missing codes. e.g. ?codes=00713,00635U" });
  }

  try {
    // 1) MoneyDJ: NAV + price + premium (if present)
    const items = await Promise.all(codes.map(fetchFromMoneyDJ));

    // 2) Optional: Replace price with TWSE realtime (if available)
    //    If TWSE call fails, we keep MoneyDJ price.
    try {
      const twsePriceMap = await fetchTwseRealtimePrices(codes);
      for (const it of items) {
        const rt = twsePriceMap[it.code];
        if (typeof rt === "number" && Number.isFinite(rt)) {
          it.price = rt;
          it.priceFrom = "TWSE realtime";
          if (typeof it.nav === "number" && Number.isFinite(it.nav) && it.nav !== 0) {
            it.premiumPct = round2(((it.price - it.nav) / it.nav) * 100);
            it.premiumFrom = "TWSE realtime price vs MoneyDJ NAV";
          }
        } else {
          it.priceFrom = it.priceFrom || "MoneyDJ";
        }
      }
    } catch (e) {
      for (const it of items) {
        it.priceFrom = it.priceFrom || "MoneyDJ";
        it.realtimePriceNote = "TWSE realtime price fetch failed; using MoneyDJ price.";
      }
    }

    const byCode = Object.fromEntries(items.map((x) => [x.code, x]));

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // cache at edge (Vercel) for 60s, allow stale for 5min
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

    return res.status(200).json({
      ok: true,
      updatedAt: new Date().toISOString(),
      items,
      byCode,
      source: "MoneyDJ (NAV/premium) + optional TWSE realtime price",
    });
  } catch (err) {
    return res.status(502).json({
      error: "upstream error",
      message: String(err?.message || err),
    });
  }
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function fetchFromMoneyDJ(code) {
  // Use .TW (uppercase) for stability
  const url = `https://www.moneydj.com/etf/x/basic/basic0004.xdjhtm?etfid=${encodeURIComponent(
    `${code}.TW`
  )}`;

  const html = await fetchText(url);

  // Convert HTML to searchable plain text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Price / NAV / Date / Premium patterns (loose)
  const mdPrice = pickNumber(text, /ETF\s*市\s*價\s*([0-9]+(?:\.[0-9]+)?)/i);
  const nav = pickNumber(text, /ETF\s*淨\s*值(?:\s*\(NAV\))?\s*([0-9]+(?:\.[0-9]+)?)/i);

  const navDate =
    pickText(
      text,
      /ETF\s*淨\s*值(?:\s*\(NAV\))?\s*[0-9]+(?:\.[0-9]+)?\s*[（(]([0-9]{2}\/[0-9]{2})[）)]/i
    ) || null;

  let premiumPct = pickNumber(text, /折\s*溢\s*價\s*\(%\)\s*([+-]?[0-9]+(?:\.[0-9]+)?)/i);

  // If premium not shown but we have price + nav, compute it
  if (premiumPct == null && typeof mdPrice === "number" && typeof nav === "number" && nav !== 0) {
    premiumPct = round2(((mdPrice - nav) / nav) * 100);
  }

  return {
    code,
    nav: typeof nav === "number" ? nav : null,
    navDate,
    price: typeof mdPrice === "number" ? mdPrice : null,
    priceFrom: typeof mdPrice === "number" ? "MoneyDJ" : null,
    premiumPct: typeof premiumPct === "number" ? premiumPct : null,
    premiumFrom: premiumPct == null ? null : "MoneyDJ (parsed)",
    moneydjUrl: url,
  };
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      Referer: "https://www.moneydj.com/etf/",
    },
  });

  if (!r.ok) {
    throw new Error(`MoneyDJ fetch failed: ${r.status} ${r.statusText}`);
  }
  return await r.text();
}

function pickNumber(text, re) {
  const m = text.match(re);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

function pickText(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

// TWSE realtime price (best-effort).
// ex_ch supports multiple symbols separated by "|", e.g. tse_00713.tw|tse_00955.tw
async function fetchTwseRealtimePrices(codes) {
  const exCh = codes.map((c) => `tse_${c}.tw`).join("|");
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(
    exCh
  )}&json=1&delay=0&_=${Date.now()}`;

  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: "https://mis.twse.com.tw/stock/fibest.jsp",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!r.ok) {
    throw new Error(`TWSE realtime fetch failed: ${r.status} ${r.statusText}`);
  }

  const j = await r.json();
  const map = {};
  const arr = Array.isArray(j?.msgArray) ? j.msgArray : [];

  for (const it of arr) {
    const code = (it?.c || "").toUpperCase();
    // z: last price; if "-" then use pz (prev close)
    const z = parseFloat(it?.z);
    const pz = parseFloat(it?.pz);
    const price = Number.isFinite(z) ? z : Number.isFinite(pz) ? pz : null;
    if (code && typeof price === "number") map[code] = price;
  }

  return map;
}
