// index.js
import { chromium } from "playwright";

const SPEC_PAGE = "https://freshforex.com/traders/trading/specification-forex/";
const API_URL = "https://freshforex.com/api/specification-param/";

// GitHub Secrets:
// - N8N_WEBHOOK_URL  (Production webhook URL)
// - N8N_TOKEN        (например MY_SECRET_123)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const N8N_TOKEN = process.env.N8N_TOKEN;

if (!N8N_WEBHOOK_URL) throw new Error("Missing env N8N_WEBHOOK_URL");
if (!N8N_TOKEN) throw new Error("Missing env N8N_TOKEN");

const BASE_FORM = {
  symbol_group: "1",
  currency: "USD",
  leverage: "2000",
  lot: "1",
};

const ACCOUNTS = [
  { type_account: "1", account_type: "Classic" },
  { type_account: "2", account_type: "Market Pro" },
  { type_account: "3", account_type: "ECN" },
];

function toForm(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

async function fetchApiFromBrowser(page, formBody) {
  const res = await page.evaluate(async ({ url, body }) => {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        accept: "application/json, text/javascript, */*; q=0.01",
      },
      body,
    });

    const text = await r.text();
    return { status: r.status, text };
  }, { url: API_URL, body: formBody });

  if (res.status !== 200) {
    throw new Error(`API status ${res.status}: ${res.text.slice(0, 300)}`);
  }
  if (res.text.trim().startsWith("<")) {
    throw new Error(`API returned HTML (Cloudflare): ${res.text.slice(0, 300)}`);
  }

  return JSON.parse(res.text);
}

async function main() {
  const fetched_at = new Date().toISOString();
  const allRecords = [];

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();

  // Зайдём на страницу, чтобы пройти CF в браузерном контексте
  await page.goto(SPEC_PAGE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);

  for (const acc of ACCOUNTS) {
    const body = toForm({ ...BASE_FORM, type_account: acc.type_account });
    const data = await fetchApiFromBrowser(page, body);

    for (const [symbol, v] of Object.entries(data)) {
      if (!v || typeof v !== "object") continue;
      if (v.spread === undefined || v.swap_long === undefined || v.swap_short === undefined) continue;

      allRecords.push({
        key: `${acc.account_type}||${symbol}`,
        fetched_at,
        account_type: acc.account_type,
        symbol,
        spread: v.spread,
        swap_long: v.swap_long,
        swap_short: v.swap_short,
        source: `${API_URL} (type_account=${acc.type_account})`,
      });
    }
  }

  await browser.close();

  // ВАЖНО: токен кладём в BODY, чтобы n8n точно увидел его в $json.token
  const payload = {
    token: N8N_TOKEN,
    fetched_at,
    records: allRecords,
  };

  const resp = await fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Webhook error ${resp.status}: ${text.slice(0, 300)}`);
  }

  console.log(`OK: sent ${allRecords.length} records to n8n. Response: ${text.slice(0, 200)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
