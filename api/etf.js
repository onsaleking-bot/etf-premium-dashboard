// Vercel Serverless Function: /api/etf?codes=009816,00955,...
module.exports = async (req, res) => {
  try {
    const codesRaw = (req.query.codes || '').toString().trim();
    const codes = codesRaw.split(',').map(s => s.trim()).filter(Boolean);

    if (!codes.length) {
      return res.status(400).json({ error: 'missing codes. e.g. ?codes=009816,00955' });
    }

    // WantGoo 這頁會直接呈現表格列（代碼/名稱/淨值/市價/折溢價%...）:contentReference[oaicite:2]{index=2}
    const url = 'https://www.wantgoo.com/stock/etf/net-value';

    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (ETF Dashboard; +https://vercel.app)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({ error: `upstream error ${upstream.status} ${upstream.statusText}` });
    }

    const html = await upstream.text();

    // 抓表格日期（頁面上有 YYYY/MM/DD）:contentReference[oaicite:3]{index=3}
    const dateMatch = html.match(/\b(20\d{2}\/\d{2}\/\d{2})\b/);
    const tableDate = dateMatch ? dateMatch[1] : null;

    // 把 HTML 轉成「一列一行」的純文字
    const textWithLines = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/(td|th|p|div|li|br)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&');

    const lines = textWithLines
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    // 建一個 map：code -> line
    const lineMap = new Map();
    for (const line of lines) {
      // 代碼通常會出現在行首（或很前面）
      // 找到第一個像 4~6 位數字的 token 當候選
      const tokens = line.split(' ');
      if (!tokens.length) continue;
      const first = tokens[0];
      if (/^\d{4,6}[A-Z]?$/.test(first)) {
        // ex: 00635U
        if (!lineMap.has(first)) lineMap.set(first, line);
      }
    }

    function isPureNumber(t) {
      return /^-?\d+(?:\.\d+)?$/.test(t);
    }

    function parsePct(t) {
      if (!t || t === '--') return null;
      const m = t.match(/^(-?\d+(?:\.\d+)?)%$/);
      return m ? Number(m[1]) : null;
    }

    function parseRow(code, line) {
      // 典型格式：
      // 009816 凱基台灣TOP50 10.79 1.70% 10.84 2.07% 0.05 0.46% 336,435 ...
      const tokens = line.split(' ');
      const idx = tokens.indexOf(code);
      if (idx === -1) return null;

      let i = idx + 1;
      const nameParts = [];
      while (i < tokens.length && !isPureNumber(tokens[i])) {
        nameParts.push(tokens[i]);
        i++;
      }
      const name = nameParts.join(' ').trim() || null;

      const nav = i < tokens.length && isPureNumber(tokens[i]) ? Number(tokens[i++]) : null;
      const navChgPct = i < tokens.length ? parsePct(tokens[i++]) : null;

      const price = i < tokens.length && isPureNumber(tokens[i]) ? Number(tokens[i++]) : null;
      const priceChgPct = i < tokens.length ? parsePct(tokens[i++]) : null;

      const diff = i < tokens.length && isPureNumber(tokens[i]) ? Number(tokens[i++]) : null;
      const premiumPct = i < tokens.length ? parsePct(tokens[i++]) : null;

      // volume token 可能含逗號
      let volume = null;
      if (i < tokens.length) {
        const v = tokens[i].replace(/,/g, '');
        if (/^\d+$/.test(v)) volume = Number(v);
      }

      return { code, name, nav, navChgPct, price, priceChgPct, diff, premiumPct, volume };
    }

    const items = codes.map(code => {
      const line = lineMap.get(code);
      if (!line) return { code, nav: null, price: null, premiumPct: null, error: 'not found' };

      const row = parseRow(code, line);
      if (!row) return { code, nav: null, price: null, premiumPct: null, error: 'parse failed' };

      // 你前台用 nav/price 自己算折溢價即可；這裡也把 wantgoo 的 premiumPct 一併回傳
      return {
        code: row.code,
        name: row.name,
        nav: row.nav,
        price: row.price,
        premiumPct: row.premiumPct,
        tableDate,
        volume: row.volume
      };
    });

    // 快取：盤中 120 秒刷新，你的 API 也配合 120 秒 s-maxage
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    return res.status(200).json({
      asOf: new Date().toISOString(),
      source: 'wantgoo_net_value',
      tableDate,
      items
    });

  } catch (e) {
    return res.status(500).json({ error: 'server error', detail: String(e?.message || e) });
  }
};
