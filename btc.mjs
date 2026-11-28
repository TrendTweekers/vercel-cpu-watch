// Bitcoin payment watch. Runs with the CPU watch every 15 minutes, asks the
// public mempool.space API for payments to one address, and sends Telegram
// messages: once when a payment is seen, once when it has 1 confirmation.
// Watch-only: no keys, no wallet. The address is a secret (BTC_ADDRESS) so it
// never appears in this public repo or its logs.
// Env: BTC_ADDRESS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// DRY_RUN=1 prints instead of sending. TEST_LAST=1 announces the newest past
// payment once (marked as a test), to prove the chain works end to end.
import fs from "node:fs";

const ADDR = process.env.BTC_ADDRESS;
if (!ADDR) { console.log("btc: BTC_ADDRESS not set, skipping"); process.exit(0); }
const FILE = "state/btc.json";
fs.mkdirSync("state", { recursive: true });
let st; try { st = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { st = null; }
const first = !st;
st ??= { seen: {} }; // txid -> "pending" | "confirmed"

const get = async (u) => { const r = await fetch(u, { headers: { "user-agent": "btc-watch" } }); if (!r.ok) throw new Error(`${u.split("/api")[1]} ${r.status}`); return r.json(); };
const txs = await get(`https://mempool.space/api/address/${ADDR}/txs`);
let price = {}; try { price = await get("https://mempool.space/api/v1/prices"); } catch {}

const short = `${ADDR.slice(0, 6)}…${ADDR.slice(-4)}`;
const fmtBtc = (sat) => (sat / 1e8).toFixed(8);
const fiat = (sat) => [price.USD && `$${((sat / 1e8) * price.USD).toFixed(2)}`, price.EUR && `€${((sat / 1e8) * price.EUR).toFixed(2)}`].filter(Boolean).join(" / ");

async function tg(text) {
  if (process.env.DRY_RUN) { console.log("--- would send:\n" + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}`);
}

// Net amount this address received in the transaction (outputs to it minus
// inputs from it). Only payments IN are announced.
const received = (tx) =>
  tx.vout.filter((o) => o.scriptpubkey_address === ADDR).reduce((s, o) => s + o.value, 0) -
  tx.vin.filter((i) => i.prevout?.scriptpubkey_address === ADDR).reduce((s, i) => s + i.prevout.value, 0);

let sent = 0;
for (const tx of [...txs].reverse()) { // oldest first
  const amt = received(tx);
  if (amt <= 0) continue;
  const state = tx.status.confirmed ? "confirmed" : "pending";
  const was = st.seen[tx.txid];
  if (first) { st.seen[tx.txid] = state; continue; } // learn history silently
  const link = `https://mempool.space/tx/${tx.txid}`;
  if (!was) {
    await tg(`₿ <b>Payment received</b>: ${fmtBtc(amt)} BTC (${fiat(amt)}) to ${short}.\n${state === "confirmed" ? "Already confirmed." : "Unconfirmed. I will tell you when it is confirmed."}\n${link}`);
    sent++;
  } else if (was === "pending" && state === "confirmed") {
    await tg(`✅ <b>Confirmed</b>: ${fmtBtc(amt)} BTC to ${short} is now final (block ${tx.status.block_height}).\n${link}`);
    sent++;
  }
  st.seen[tx.txid] = state;
}

if (process.env.TEST_LAST) {
  const last = txs.find((t) => received(t) > 0);
  if (last) { const a = received(last); await tg(`🧪 <b>Test of the Bitcoin watch</b> (an old payment, not a new one): ${fmtBtc(a)} BTC (${fiat(a)}) to ${short}, ${last.status.confirmed ? "confirmed" : "unconfirmed"}. New payments will look like this.`); sent++; }
}

fs.writeFileSync(FILE, JSON.stringify(st));
console.log(`btc: ok, ${first ? "first run, history learned" : `${sent} message(s)`}`); // no address or amounts in public logs
