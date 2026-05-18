// 認証情報は環境変数から読む（GitHub Secrets / start.bat で設定）
const CONFIG = {
  schoolCd:        process.env.SCHOOL_CD,
  studentId:       process.env.STUDENT_ID,
  password:        process.env.PASSWORD,
  discordWebhook:  process.env.DISCORD_WEBHOOK,
  intervalMinutes: 5,
};

// 必須項目チェック
["SCHOOL_CD","STUDENT_ID","PASSWORD","DISCORD_WEBHOOK"].forEach(k => {
  if (!process.env[k]) { console.error(`環境変数 ${k} が設定されていません`); process.exit(1); }
});

const BASE      = "https://www.e-license.jp";
const LOGIN_URL = `${BASE}/el31/pc/login`;
const LOGIN_TOP = `${BASE}/el31/vdgAMGOVXFE-brGQYS-1OA==`;
const UA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0";

// GitHub Actionsでは --once フラグで1回実行して終了
const RUN_ONCE = process.argv.includes("--once");

// ─── CookieJar ────────────────────────────────────────────────────────
class CookieJar {
  constructor() { this.store = {}; }
  absorb(headers) {
    for (const raw of (headers.getSetCookie?.() ?? [])) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      this.store[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  toString() {
    return Object.entries(this.store).map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// ─── リダイレクトを追いながらCookieを蓄積 ─────────────────────────────
async function cookieFetch(jar, url, options = {}, depth = 0) {
  if (depth > 8) throw new Error("リダイレクトが多すぎます");
  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.5",
      Cookie: jar.toString(),
      ...options.headers,
    },
    redirect: "manual",
  });
  jar.absorb(res.headers);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") ?? "";
    const next = loc.startsWith("http") ? loc : `${BASE}${loc}`;
    return cookieFetch(jar, next, {}, depth + 1);
  }
  return res;
}

// ─── ログイン → 予約ページHTMLを直接取得 ─────────────────────────────
async function loginAndGetHtml() {
  const jar = new CookieJar();
  await cookieFetch(jar, LOGIN_TOP, {});
  const res = await cookieFetch(jar, LOGIN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      schoolCd:  CONFIG.schoolCd,
      studentId: CONFIG.studentId,
      password:  CONFIG.password,
    }).toString(),
  });
  const html = await res.text();
  if (!html.includes("ログアウト")) throw new Error("ログイン失敗");
  return html;
}

// ─── HTMLから予約可能コマを抽出 ────────────────────────────────────────
function parseSlots(html) {
  const seen = new Set();
  const slots = [];
  const tdRe = /<td[^>]+class="status[12][^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = tdRe.exec(html)) !== null) {
    const inner = m[1];
    const date  = (inner.match(/data-date="([^"]+)"/) || [])[1];
    const week  = (inner.match(/data-week="([^"]+)"/) || [])[1] ?? "";
    const time  = (inner.match(/data-time="([^"]+)"/) || [])[1];
    if (date && time) {
      const key = `${date}|${time}`;
      if (!seen.has(key)) { seen.add(key); slots.push({ date, week, time }); }
    }
  }
  return slots;
}

// ─── targets.txt を読み込む ────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

function loadTargets() {
  const file = path.join(__dirname, "targets.txt");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(l => l)
    .map(l => {
      const [datePart, time] = l.split(/\s+/);
      if (!datePart || !time) return null;
      const [mo, d] = datePart.split("/");
      if (!mo || !d) return null;
      return { date: `${parseInt(mo)}月${parseInt(d)}日`, time };
    })
    .filter(Boolean);
}

// ─── Discord 通知 ─────────────────────────────────────────────────────
async function sendDiscord(message) {
  const res = await fetch(CONFIG.discordWebhook, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ content: message }),
  });
  if (!res.ok) console.error("Discord通知失敗:", res.status);
}

// ─── 1回分のチェック ────────────────────────────────────────────────────
let prevNotifyKey = null;

async function checkOnce() {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  try {
    const html    = await loginAndGetHtml();
    const slots   = parseSlots(html);
    const targets = loadTargets();

    // 監視対象コマだけ絞り込む
    const notifySlots = targets.length === 0
      ? slots
      : slots.filter(s => targets.some(t => t.date === s.date && t.time === s.time));

    const notifyKey = notifySlots.map(s => `${s.date}|${s.time}`).sort().join("|");

    console.log(`[${now}] 全体の空き: ${slots.length}件 / 指定コマ: ${notifySlots.length}件`);

    // ── Discordへのステータス投稿（毎回）──
    let statusMsg = `🕐 **${now} チェック完了**\n`;
    if (notifySlots.length > 0) {
      statusMsg += `✅ **指定コマに空きあり！**\n`;
      notifySlots.forEach(s => { statusMsg += `　${s.date}${s.week} ${s.time}\n`; });
    } else if (targets.length > 0) {
      statusMsg += `❌ 指定コマはまだ空き無し\n`;
      targets.forEach(t => { statusMsg += `　${t.date} ${t.time}\n`; });
    } else {
      statusMsg += slots.length > 0
        ? `✅ ${slots.length}件の空きあり\n` + slots.map(s => `　${s.date}${s.week} ${s.time}`).join("\n")
        : `❌ 空き無し`;
    }
    await sendDiscord(statusMsg);

    // ── 指定コマが新たに空いたら追加で大きく通知 ──
    if (notifyKey !== prevNotifyKey && notifySlots.length > 0) {
      let alertMsg = `@everyone\n🚨 **【三郷自動車教習所】指定コマの予約が取れます！**\n`;
      notifySlots.forEach(s => { alertMsg += `　${s.date}${s.week} ${s.time}\n`; });
      alertMsg += `\n急いで予約してください！\n${LOGIN_TOP}`;
      await sendDiscord(alertMsg);
      console.log("  → 緊急通知送信");
    }

    prevNotifyKey = notifyKey;

  } catch (err) {
    console.error(`[${now}] エラー: ${err.message}`);
    await sendDiscord(`⚠️ **監視エラー** (${now})\n${err.message}`).catch(() => {});
  }
}

// ─── メイン ─────────────────────────────────────────────────────────────
const initTargets = loadTargets();
console.log("三郷自動車教習所 技能予約監視ツール 起動");
if (initTargets.length > 0) {
  console.log(`監視コマ: ${initTargets.map(t => `${t.date} ${t.time}`).join(" / ")}`);
} else {
  console.log("監視コマ: 全コマ");
}
console.log(RUN_ONCE ? "モード: 1回実行\n" : `モード: ${CONFIG.intervalMinutes}分ごと\n`);

if (RUN_ONCE) {
  // GitHub Actions用：1回実行して終了
  checkOnce().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  // ローカル用：定期実行
  checkOnce();
  setInterval(checkOnce, CONFIG.intervalMinutes * 60 * 1000);
}
