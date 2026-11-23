// Vercel CPU watch. The free plan shows per-project CPU only for the last
// 30 minutes, so this runs every 15 minutes, saves the per-minute rows to
// state/ (kept in the Actions cache, never in git or the logs), sends a daily
// Telegram report and warns when use jumps.
// Env: VERCEL_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VERCEL_SCOPE.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const SCOPE = process.env.VERCEL_SCOPE;
if (!SCOPE) throw new Error("VERCEL_SCOPE is not set");
const LIMIT_MIN = 240;          // Hobby: 4 h Fluid Active CPU a month
const DAY_ALERT_MIN = 12;       // warn when one day passes this (budget is 8/day)
const MONTH_ALERT_MIN = 180;    // warn when the 30-day estimate passes 75 %
const REPORT_HOUR_UTC = 6;      // daily report around 07:00 Swedish winter time
const DIR = "state", ROWS = `${DIR}/rows.json`, META = `${DIR}/meta.json`;
fs.mkdirSync(DIR, { recursive: true });
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const rows = load(ROWS, {});    // key "ts|kind|project|route" -> ms
const meta = load(META, { covered: {}, sent: {} }); // covered: minute ts -> 1

function query(metric, groupBy) {
  const args = ["-y", "vercel@65.2.0", "metrics", metric, "--all", "--aggregation", "sum", "--since", "29m", "--granularity", "1m", "--limit", "200", "--json", "--scope", SCOPE];
  if (process.env.VERCEL_TOKEN) args.push("--token", process.env.VERCEL_TOKEN);
  for (const g of groupBy) args.push("--group-by", g);
  const out = execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  const j = JSON.parse(out);
  if (j.error) throw new Error(`${metric}: ${j.error.code}`);
  return j;
}

let added = 0;
for (const [kind, metric, groupBy] of [
  ["fn", "vercel.function_invocation.function_cpu_time_ms", ["projectName", "route"]],
  ["mw", "vercel.middleware_invocation.function_cpu_time_ms", ["projectName"]],
]) {
  const j = query(metric, groupBy);
  const key = Object.keys(j.data?.[0] ?? {}).find((k) => k.endsWith("_sum"));
  for (const r of j.data ?? []) {
    const ms = r[key] ?? 0; if (!ms) continue;
    const k = `${r.timestamp}|${kind}|${r.projectName}|${r.route ?? "(middleware)"}`;
    if (rows[k] === undefined) added++;
    rows[k] = ms;
  }
  for (let t = Date.parse(j.query.startTime); t < Date.parse(j.query.endTime); t += 60000) meta.covered[new Date(t).toISOString()] = 1;
}

// Keep 40 days.
const cutoff = Date.now() - 40 * 864e5;
for (const k of Object.keys(rows)) if (Date.parse(k.split("|")[0]) < cutoff) delete rows[k];
for (const k of Object.keys(meta.covered)) if (Date.parse(k) < cutoff) delete meta.covered[k];

const day = (iso) => iso.slice(0, 10);
const dayTotals = {}, dayCover = {};
for (const [k, ms] of Object.entries(rows)) { const d = day(k); dayTotals[d] = (dayTotals[d] || 0) + ms; }
for (const k of Object.keys(meta.covered)) { const d = day(k); dayCover[d] = (dayCover[d] || 0) + 1; }
const min = (ms) => ms / 60000;
const fmt = (m) => m < 1 ? `${Math.round(m * 60)} s` : `${m.toFixed(1)} min`;
const top = (d, n = 5) => {
  const agg = {};
  for (const [k, ms] of Object.entries(rows)) { if (day(k) !== d) continue; const [, , p, r] = k.split("|"); agg[`${p} ${r}`] = (agg[`${p} ${r}`] || 0) + ms; }
  return Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, n).map(([n, ms]) => `• ${esc(n)}: ${fmt(min(ms))}`).join("\n") || "• nothing";
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Estimate per day scales up for minutes the tracker missed (GitHub delays).
const est = (d) => min(dayTotals[d] || 0) * (1440 / Math.max(dayCover[d] || 0, 60));
const fullDays = Object.keys(dayCover).filter((d) => d < day(new Date().toISOString())).sort().slice(-7);
const month = fullDays.length ? (fullDays.reduce((s, d) => s + est(d), 0) / fullDays.length) * 30 : null;

async function tg(text) {
  if (process.env.DRY_RUN) { console.log("--- would send:\n" + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}`);
}

const now = new Date(), today = day(now.toISOString());
const yest = day(new Date(now - 864e5).toISOString());
const monthLine = month === null ? "Month estimate: needs one full day of data." : `Month estimate: ${fmt(month)} of ${LIMIT_MIN} min (${Math.round((month / LIMIT_MIN) * 100)} %).`;

if (((now.getUTCHours() === REPORT_HOUR_UTC && meta.sent.daily !== today) || process.env.FORCE_REPORT) && (dayCover[yest] || process.env.FORCE_REPORT)) {
  await tg(`<b>Vercel CPU, ${yest}</b>\nUsed: ${fmt(est(yest))} (budget 8 min/day). Tracked ${Math.round((dayCover[yest] / 1440) * 100)} % of the day.\n${monthLine}\n\nTop:\n${top(yest)}`);
  meta.sent.daily = today;
}
if (est(today) > DAY_ALERT_MIN && (dayCover[today] || 0) >= 120 && meta.sent.dayAlert !== today) {
  await tg(`⚠️ <b>Vercel CPU high today</b>: about ${fmt(est(today))} so far (budget 8 min/day).\n\nTop:\n${top(today)}`);
  meta.sent.dayAlert = today;
}
if (month !== null && month > MONTH_ALERT_MIN && meta.sent.monthAlert !== today) {
  await tg(`⚠️ <b>Vercel CPU month estimate ${fmt(month)}</b>, over 75 % of the free 4 h. At 100 % Vercel pauses every project.\n\nTop yesterday:\n${top(yest)}`);
  meta.sent.monthAlert = today;
}

fs.writeFileSync(ROWS, JSON.stringify(rows));
fs.writeFileSync(META, JSON.stringify(meta));
console.log(`ok: +${added} rows, ${Object.keys(rows).length} kept`); // no usage data in public logs
