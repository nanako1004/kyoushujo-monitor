// 認証情報は環境変数から読む（GitHub Secrets / start.bat で設定）
const CONFIG = {
  schoolCd:             process.env.SCHOOL_CD,
  studentId:            process.env.STUDENT_ID,
  password:             process.env.PASSWORD,
  discordWebhook:       process.env.DISCORD_WEBHOOK,
  discordBotToken:      process.env.DISCORD_BOT_TOKEN,
  discordTargetChannel: process.env.DISCORD_TARGET_CHANNEL,
  intervalMinutes:      5,
};

["SCHOOL_CD","STUDENT_ID","PASSWORD","DISCORD_WEBHOOK","DISCORD_BOT_TOKEN","DISCORD_TARGET_CHANNEL"].forEach(k => {
  if (!process.env[k]) { console.error(`環境変数 ${k} が設定されていません`); process.exit(1); }
});

const BASE      = "https://www.e-license.jp";
const LOGIN_URL = `${BASE}/el31/pc/login`;
const LOGIN_TOP = `${BASE}/el31/vdgAMGOVXFE-brGQYS-1OA==`;
const UA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0";
const RUN_ONCE  = process.argv.includes("--once");

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

// ─── ボットがチャンネルにメッセージを送る ─────────────────────────────
async function botSend(channelId, content) {
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method:  "POST",
    headers: {
      Authorization:  `Bot ${CONFIG.discordBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}

// ─── Discordの「予約設定」チャンネルから監視コマを読み取る ────────────
// チャンネルの最新メッセージを読んでパースする
// 書き方例（チャンネルに投稿するメッセージ）：
//   5/19 10:10
//   5/23 14:00
//   5/23 15:00
async function loadTargetsFromDiscord() {
  const res = await fetch(
    `https://discord.com/api/v10/channels/${CONFIG.discordTargetChannel}/messages?limit=5`,
    { headers: { Authorization: `Bot ${CONFIG.discordBotToken}` } }
  );
  if (!res.ok) throw new Error(`Discord API エラー: ${res.status}`);
  const messages = await res.json();

  // ボット以外の一番最新のメッセージを使う
  const msg = messages.find(m => !m.author?.bot);
  if (!msg) return { targets: [], msgId: null, isNew: false };

  const targets = msg.content
    .split("\n")
    .map(l => l.replace(/#.*$/, "").trim())
    .filter(l => /^\d+\/\d+\s+\d+:\d+$/.test(l))
    .map(l => {
      const [datePart, time] = l.split(/\s+/);
      const [mo, d] = datePart.split("/");
      return { date: `${parseInt(mo)}月${parseInt(d)}日`, time };
    });

  // メッセージが10分以内なら「新着」と判定して確認メッセージを送る
  const ageMs = Date.now() - new Date(msg.timestamp).getTime();
  const isNew = ageMs < 10 * 60 * 1000;

  return { targets, msgId: msg.id, isNew };
}

// ─── Discord 通知（Webhook経由）────────────────────────────────────────
async function sendDiscord(message) {
  const res = await fetch(CONFIG.discordWebhook, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ content: message }),
  });
  if (!res.ok) console.error("Discord通知失敗:", res.status);
}

// ─── 1回分のチェック ────────────────────────────────────────────────────
let prevNotifyKey      = null;
let prevConfirmedMsgId = null;

async function checkOnce() {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  try {
    const [html, { targets, msgId, isNew }] = await Promise.all([
      loginAndGetHtml(),
      loadTargetsFromDiscord(),
    ]);
    const slots = parseSlots(html);

    const notifySlots = targets.length === 0
      ? slots
      : slots.filter(s => targets.some(t => t.date === s.date && t.time === s.time));

    const notifyKey = notifySlots.map(s => `${s.date}|${s.time}`).sort().join("|");

    console.log(`[${now}] 監視コマ: ${targets.length}件 / 空き: ${notifySlots.length}件`);

    // 新しいメッセージを検出したら #予約設定 に確認を返す
    if (isNew && msgId !== prevConfirmedMsgId) {
      if (targets.length > 0) {
        const list = targets.map(t => `　${t.date} ${t.time}`).join("\n");
        await botSend(CONFIG.discordTargetChannel,
          `✅ **監視コマを更新しました！**（以前の設定はリセット）\n${list}\n\n空きが出たら通知します。複数コマを監視したい場合は1つのメッセージにまとめて送ってください。`);
      } else {
        await botSend(CONFIG.discordTargetChannel,
          `⚠️ コマの形式が正しくありません。\n1つのメッセージにまとめて送ってください↓\n\`\`\`\n5/19 10:10\n5/23 14:00\n5/23 15:00\n\`\`\``);
      }
      prevConfirmedMsgId = msgId;
    }

    if (targets.length === 0) console.log("  ※ 予約設定チャンネルにコマを投稿してください");

    // 空きが新たに出たときだけ通知（毎回は通知しない）
    if (notifyKey !== prevNotifyKey && notifySlots.length > 0) {
      let msg = `@everyone\n🚨 **【三郷自動車教習所】指定コマの予約が取れます！**\n`;
      notifySlots.forEach(s => { msg += `　${s.date}${s.week} ${s.time}\n`; });
      msg += `\n急いで予約してください！\n${LOGIN_TOP}`;
      await sendDiscord(msg);
      console.log("  → 通知送信！");
    } else if (notifyKey !== prevNotifyKey && prevNotifyKey !== null && notifySlots.length === 0) {
      // 空きがなくなったときも一言
      await sendDiscord(`✅ 指定コマの空きがなくなりました（${now}）`);
    }

    prevNotifyKey = notifyKey;
  } catch (err) {
    console.error(`[${now}] エラー: ${err.message}`);
    await sendDiscord(`⚠️ **監視エラー** (${now})\n${err.message}`).catch(() => {});
  }
}

// ─── メイン ─────────────────────────────────────────────────────────────
console.log("三郷自動車教習所 技能予約監視ツール 起動");
console.log(RUN_ONCE ? "モード: 1回実行\n" : `モード: ${CONFIG.intervalMinutes}分ごと\n`);

if (RUN_ONCE) {
  checkOnce().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  checkOnce();
  setInterval(checkOnce, CONFIG.intervalMinutes * 60 * 1000);
}
