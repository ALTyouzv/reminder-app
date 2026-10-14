// Reminders — Cloudflare Worker
// Serves the app, stores tasks in D1, sends Telegram reminders every minute.
import UI_HTML from './ui.html';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const REPEATS = ['none', 'daily', 'weekly'];
const LEADS = [0, 10, 30, 60, 1440]; // "remind me before" options, in minutes
const DAY = 86400000;

// Adds new columns to databases created by older versions (runs once per worker instance).
let migrated = false;
async function migrate(env) {
  if (migrated) return;
  // Create the tables on first run (so the "Deploy to Cloudflare" button needs no extra step).
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
      remind_at INTEGER, repeat TEXT NOT NULL DEFAULT 'none', lead_min INTEGER NOT NULL DEFAULT 0,
      early_sent INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (done, notified, remind_at)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
  ]);
  for (const sql of [
    'ALTER TABLE tasks ADD COLUMN lead_min INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN early_sent INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }
  }
  migrated = true;
}

export default {
  async fetch(request, env, ctx) {
    try {
      await migrate(env);
      return await route(request, env, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: 'Server error: ' + (err && err.message) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(migrate(env).then(async () => {
      await sendDueReminders(env);
      try { await maybeSendBrief(env); } catch (e) { console.error('morning plan failed', e); }
    }));
  },
};

// ---------------------------------------------------------------- routing
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return new Response(UI_HTML, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  if (method === 'GET' && path === '/manifest.webmanifest') return manifest();
  if (method === 'GET' && path === '/icon.svg') return icon();
  if (method === 'GET' && path === '/apple-touch-icon.png') return touchIcon();

  // Telegram webhook (secret path, no bearer token)
  if (path.startsWith('/telegram/')) {
    const secret = await hookSecret(env);
    if (method !== 'POST' || path !== '/telegram/' + secret) return new Response('Not found', { status: 404 });
    const update = await request.json().catch(() => null);
    if (update) ctx.waitUntil(handleTelegram(update, env));
    return new Response('ok');
  }

  if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
  if (!env.APP_KEY) return json({ error: 'APP_KEY secret is not set on the server.' }, 500);
  const auth = request.headers.get('authorization') || '';
  if (!(await safeEqual(auth, 'Bearer ' + env.APP_KEY))) return json({ error: 'Wrong password' }, 401);

  // tasks
  if (path === '/api/tasks' && method === 'GET') return json({ tasks: await listTasks(env), now: Date.now() });
  if (path === '/api/tasks' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if (!String(body.title || '').trim()) return json({ error: 'Title is required' }, 400);
    const task = await createTask(env, body);
    return json({ task }, 201);
  }
  const m = path.match(/^\/api\/tasks\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({}));
      const task = await updateTask(env, id, body);
      return task ? json({ task }) : json({ error: 'Not found' }, 404);
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }

  // AI: understand a naturally typed task
  if (path === '/api/parse' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return json({ error: 'Type something first' }, 400);
    const ai = await aiParse(env, text);
    if (ai) return json({ ai: true, parsed: ai });
    const q = parseQuickAdd(text, env.TZ || 'Asia/Riyadh');
    return json({ ai: false, parsed: { title: q.title || text, details: '', remind_at: q.remind_at, repeat: 'none', lead_min: 0 } });
  }

  // morning plan settings
  if (path === '/api/brief' && method === 'GET') return json(await briefSettings(env));
  if (path === '/api/brief' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    if ('enabled' in body) await setSetting(env, 'brief_enabled', body.enabled ? '1' : '0');
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time || ''))) {
      await setSetting(env, 'brief_time', body.time);
      // if the new time is later today, allow today's plan to go out at that time
      if (body.time > localNow(env).hm) await setSetting(env, 'brief_last', '');
    }
    return json(await briefSettings(env));
  }
  if (path === '/api/brief/test' && method === 'POST') {
    const chat = await getSetting(env, 'chat_id');
    if (!chat) return json({ error: 'Connect Telegram first.' }, 400);
    await sendBrief(env, chat);
    return json({ ok: true });
  }

  // telegram settings
  if (path === '/api/telegram' && method === 'GET') return json(await telegramStatus(env, url.origin));
  if (path === '/api/telegram/setup' && method === 'POST') return json(await telegramSetup(env, url.origin));
  if (path === '/api/telegram/test' && method === 'POST') {
    const chat = await getSetting(env, 'chat_id');
    if (!chat) return json({ error: 'Telegram is not connected yet.' }, 400);
    await tg(env, 'sendMessage', { chat_id: chat, text: '✅ Test from your Reminders app. Phone alerts are working.' });
    return json({ ok: true });
  }
  if (path === '/api/telegram/disconnect' && method === 'POST') {
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind('chat_id').run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

// ---------------------------------------------------------------- tasks
async function listTasks(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM tasks ORDER BY done ASC, remind_at IS NULL ASC, remind_at ASC, id DESC'
  ).all();
  return results.map(normalize);
}

async function getTask(env, id) {
  const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  return row ? normalize(row) : null;
}

function normalize(r) {
  return {
    id: r.id,
    title: r.title,
    details: r.details || '',
    remind_at: r.remind_at == null ? null : Number(r.remind_at),
    repeat: r.repeat || 'none',
    lead_min: Number(r.lead_min || 0),
    done: !!r.done,
    notified: !!r.notified,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function clean(body) {
  const out = {};
  if ('title' in body) out.title = String(body.title || '').trim().slice(0, 300);
  if ('details' in body) out.details = String(body.details || '').slice(0, 5000);
  if ('remind_at' in body) {
    const v = body.remind_at;
    out.remind_at = v === null || v === '' || v === undefined ? null : Number(v);
    if (out.remind_at !== null && !Number.isFinite(out.remind_at)) out.remind_at = null;
  }
  if ('repeat' in body) out.repeat = REPEATS.includes(body.repeat) ? body.repeat : 'none';
  if ('lead_min' in body) { const l = Number(body.lead_min); out.lead_min = LEADS.includes(l) ? l : 0; }
  if ('done' in body) out.done = body.done ? 1 : 0;
  return out;
}

async function createTask(env, body) {
  const t = clean(body);
  if (!t.title) throw new Error('Title is required');
  const now = Date.now();
  const res = await env.DB.prepare(
    'INSERT INTO tasks (title, details, remind_at, repeat, lead_min, done, notified, early_sent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)'
  ).bind(t.title, t.details || '', t.remind_at ?? null, t.repeat || 'none', t.lead_min || 0, now, now).run();
  return getTask(env, res.meta.last_row_id);
}

async function updateTask(env, id, body) {
  const current = await getTask(env, id);
  if (!current) return null;
  const t = clean(body);
  if ('title' in t && !t.title) delete t.title;

  // Re-arm the reminder whenever its time or repeat changes.
  if ('remind_at' in t && t.remind_at !== current.remind_at) { t.notified = 0; t.early_sent = 0; }
  if ('repeat' in t && t.repeat !== current.repeat) t.notified = 0;
  if ('lead_min' in t && t.lead_min !== current.lead_min) t.early_sent = 0;

  // Completing a repeating task rolls it to the next occurrence instead.
  const repeat = t.repeat ?? current.repeat;
  const remindAt = 'remind_at' in t ? t.remind_at : current.remind_at;
  if (t.done === 1 && repeat !== 'none' && remindAt != null) {
    t.done = 0;
    t.remind_at = nextOccurrence(remindAt, repeat, Math.max(Date.now(), remindAt + 1));
    t.notified = 0;
    t.early_sent = 0;
  }
  if (t.done === 0 && current.done && !('remind_at' in t)) t.notified = current.remind_at != null && current.remind_at <= Date.now() ? 1 : 0;

  const keys = Object.keys(t);
  if (!keys.length) return current;
  const sets = keys.map((k) => k + ' = ?').join(', ');
  await env.DB.prepare('UPDATE tasks SET ' + sets + ', updated_at = ? WHERE id = ?')
    .bind(...keys.map((k) => t[k]), Date.now(), id).run();
  return getTask(env, id);
}

function nextOccurrence(ts, repeat, after) {
  const step = repeat === 'weekly' ? 7 * DAY : DAY;
  let next = ts;
  while (next < after) next += step;
  return next;
}

// ---------------------------------------------------------------- reminders (cron)
async function sendDueReminders(env) {
  const now = Date.now();
  const chat = await getSetting(env, 'chat_id');

  // 1) Early heads-ups ("remind me before")
  const early = (await env.DB.prepare(
    'SELECT * FROM tasks WHERE done = 0 AND early_sent = 0 AND lead_min > 0 AND remind_at IS NOT NULL AND remind_at > ? AND remind_at - lead_min * 60000 <= ? ORDER BY remind_at LIMIT 25'
  ).bind(now, now).all()).results;
  for (const row of early.map(normalize)) {
    if (chat && env.TELEGRAM_TOKEN) {
      try { await sendEarly(env, chat, row, now); } catch (e) { console.error('telegram early send failed', e); }
    }
    await env.DB.prepare('UPDATE tasks SET early_sent = 1 WHERE id = ?').bind(row.id).run();
  }

  // 2) On-time reminders
  const { results } = await env.DB.prepare(
    'SELECT * FROM tasks WHERE done = 0 AND notified = 0 AND remind_at IS NOT NULL AND remind_at <= ? ORDER BY remind_at LIMIT 25'
  ).bind(now).all();
  if (!results.length) return early.length;

  for (const row of results.map(normalize)) {
    if (chat && env.TELEGRAM_TOKEN) {
      try { await sendReminder(env, chat, row); } catch (e) { console.error('telegram send failed', e); }
    }
    if (row.repeat !== 'none') {
      const next = nextOccurrence(row.remind_at, row.repeat, now + 1);
      await env.DB.prepare('UPDATE tasks SET remind_at = ?, early_sent = 0, updated_at = ? WHERE id = ?').bind(next, now, row.id).run();
    } else {
      await env.DB.prepare('UPDATE tasks SET notified = 1, updated_at = ? WHERE id = ?').bind(now, row.id).run();
    }
  }
  return early.length + results.length;
}

function untilText(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + ' min';
  if (m < 1440) { const h = Math.round(m / 60); return h + (h === 1 ? ' hour' : ' hours'); }
  const d = Math.round(m / 1440); return d + (d === 1 ? ' day' : ' days');
}

async function sendEarly(env, chat, t, now) {
  let s = '🔔 <b>Coming up in ' + untilText(t.remind_at - now) + '</b>\n\n' + esc(t.title);
  if (t.details) s += '\n' + esc(t.details);
  s += '\n\n<i>' + fmtTime(env, t.remind_at) + '</i>';
  return tg(env, 'sendMessage', {
    chat_id: chat, text: s, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '✅ Done', callback_data: 'done:' + t.id }]] },
  });
}

function reminderText(env, t) {
  let s = '⏰ <b>' + esc(t.title) + '</b>';
  if (t.details) s += '\n\n' + esc(t.details);
  s += '\n\n<i>' + fmtTime(env, t.remind_at);
  if (t.repeat !== 'none') s += ' · repeats ' + t.repeat;
  s += '</i>';
  return s;
}

function reminderButtons(t) {
  return {
    inline_keyboard: [[
      { text: '✅ Done', callback_data: 'done:' + t.id },
      { text: '10 min', callback_data: 'snooze:' + t.id + ':10' },
      { text: '1 hour', callback_data: 'snooze:' + t.id + ':60' },
    ]],
  };
}

async function sendReminder(env, chat, t) {
  return tg(env, 'sendMessage', {
    chat_id: chat, text: reminderText(env, t), parse_mode: 'HTML', reply_markup: reminderButtons(t),
  });
}

// ---------------------------------------------------------------- telegram
async function tg(env, method, payload) {
  if (!env.TELEGRAM_TOKEN) throw new Error('TELEGRAM_TOKEN secret is not set.');
  const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_TOKEN + '/' + method, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error('Telegram ' + method + ': ' + (data.description || res.status));
  return data.result;
}

async function telegramStatus(env, origin) {
  const out = { configured: !!env.TELEGRAM_TOKEN, connected: !!(await getSetting(env, 'chat_id')) };
  if (!out.configured) return out;
  let username = await getSetting(env, 'bot_username');
  if (!username) {
    try { username = (await tg(env, 'getMe', {})).username; await setSetting(env, 'bot_username', username); } catch (e) { out.error = e.message; }
  }
  out.bot = username || null;
  if (username) out.link = 'https://t.me/' + username + '?start=' + (await linkCode(env));
  out.webhook = (await getSetting(env, 'webhook_url')) === origin + '/telegram/' + (await hookSecret(env));
  return out;
}

async function telegramSetup(env, origin) {
  const hook = origin + '/telegram/' + (await hookSecret(env));
  await tg(env, 'setWebhook', { url: hook, allowed_updates: ['message', 'callback_query'] });
  await setSetting(env, 'webhook_url', hook);
  try {
    await tg(env, 'setMyCommands', { commands: [
      { command: 'plan', description: "Today's plan" },
      { command: 'list', description: 'Show open tasks' },
      { command: 'add', description: 'Add a task, e.g. /add Call mom at 18:30' },
      { command: 'done', description: 'Complete a task by number, e.g. /done 12' },
      { command: 'help', description: 'How to use this bot' },
    ] });
  } catch (_) { /* optional */ }
  return telegramStatus(env, origin);
}

const HELP = [
  '<b>Reminders bot</b>',
  '',
  'Just type what you need to remember, the way you would say it:',
  '• <code>Submit stats assignment Thursday 10pm, remind me an hour before</code>',
  '• <code>Call mom tomorrow evening</code>',
  '• <code>Gym every Sunday at 6pm</code>',
  '• <code>اتصل على الدكتور بكرة الساعة ١٠</code>',
  '',
  '/plan — today\'s plan right now',
  '/list — open tasks',
  '/done 12 — complete task #12',
].join('\n');

async function handleTelegram(update, env) {
  const owner = await getSetting(env, 'chat_id');

  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = String(q.message?.chat?.id || '');
    if (!owner || chatId !== owner) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
    const [action, idStr, minStr] = String(q.data || '').split(':');
    const id = Number(idStr);
    const task = await getTask(env, id);
    let note = 'Task not found';
    if (action === 'undo') {
      if (task) await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
      await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: task ? 'Removed' : 'Already gone' });
      await tg(env, 'editMessageText', {
        chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML',
        text: '↩️ <s>' + esc(task ? task.title : 'Task') + '</s>\n<i>Removed</i>',
      }).catch(() => {});
      return;
    }
    if (task && action === 'done') {
      const updated = await updateTask(env, id, { done: true });
      note = updated.done ? 'Marked done' : 'Done — next: ' + fmtTime(env, updated.remind_at);
    } else if (task && action === 'snooze') {
      const when = Date.now() + Number(minStr || 10) * 60000;
      await updateTask(env, id, { remind_at: when, done: false });
      await env.DB.prepare('UPDATE tasks SET early_sent = 1 WHERE id = ?').bind(id).run(); // no extra heads-up for a snooze
      note = 'Snoozed until ' + fmtClock(env, when);
    }
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: note });
    if (task) {
      await tg(env, 'editMessageText', {
        chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML',
        text: '⏰ <b>' + esc(task.title) + '</b>\n\n<i>' + esc(note) + '</i>',
      }).catch(() => {});
    }
    return;
  }

  const msg = update.message;
  if (!msg || typeof msg.text !== 'string') return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const reply = (t) => tg(env, 'sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML' });

  // Linking: only the deep link from the app (with the secret code) can claim the bot.
  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1] || '';
    if (code && code === (await linkCode(env))) {
      await setSetting(env, 'chat_id', chatId);
      return reply('🔗 Connected! Reminders will arrive here.\n\n' + HELP);
    }
    if (owner === chatId) return reply(HELP);
    return reply('This bot is private. Open the Reminders app → Settings → Connect Telegram.');
  }
  if (owner !== chatId) return; // ignore strangers silently

  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  const arg = rest.join(' ').trim();

  if (cmd === '/help') return reply(HELP);
  if (cmd === '/list') {
    const open = (await listTasks(env)).filter((t) => !t.done);
    if (!open.length) return reply('Nothing on your list. 🎉');
    return reply(open.slice(0, 40).map((t) =>
      '<b>#' + t.id + '</b> ' + esc(t.title) + (t.remind_at ? '\n     <i>' + fmtTime(env, t.remind_at) + (t.repeat !== 'none' ? ' · ' + t.repeat : '') + '</i>' : '')
    ).join('\n'));
  }
  if (cmd === '/done') {
    const id = Number(arg.replace('#', ''));
    const task = id && (await getTask(env, id));
    if (!task) return reply('Send the task number from /list, e.g. <code>/done 12</code>');
    const updated = await updateTask(env, id, { done: true });
    return reply(updated.done ? '✅ Done: ' + esc(task.title) : '✅ Done for now. Next: ' + fmtTime(env, updated.remind_at));
  }
  if (cmd === '/plan') { await sendBrief(env, chatId); return; }
  const body = cmd === '/add' ? arg : cmd.startsWith('/') ? '' : text;
  if (!body) return reply(HELP);
  let parsed = await aiParse(env, body);
  if (!parsed) {
    const q = parseQuickAdd(body, env.TZ || 'Asia/Riyadh');
    parsed = { title: q.title, remind_at: q.remind_at, repeat: 'none', lead_min: 0, details: '' };
  }
  if (!parsed.title) return reply('What should I remind you about?');
  const task = await createTask(env, parsed);
  let s = '➕ Added <b>#' + task.id + '</b> ' + esc(task.title);
  if (task.remind_at) s += '\n⏰ ' + fmtTime(env, task.remind_at);
  if (task.lead_min) s += '\n🔔 ' + untilText(task.lead_min * 60000) + ' before';
  if (task.repeat !== 'none') s += '\n↻ Every ' + (task.repeat === 'daily' ? 'day' : 'week');
  if (task.details) s += '\n<i>' + esc(task.details) + '</i>';
  return tg(env, 'sendMessage', {
    chat_id: chatId, text: s, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '↩️ Undo', callback_data: 'undo:' + task.id }]] },
  });
}

// ---------------------------------------------------------------- AI (Cloudflare Workers AI)
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

function localNow(env, ts = Date.now()) {
  const tz = env.TZ || 'Asia/Riyadh';
  const p = zonedParts(ts, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return { ...p, date: p.year + '-' + pad(p.month) + '-' + pad(p.day), hm: pad(p.hour) + ':' + pad(p.minute) };
}

async function runAI(env, messages, maxTokens, schema) {
  if (!env.AI) return null;
  const opts = { messages, max_tokens: maxTokens, temperature: 0.1 };
  let out;
  try {
    out = await env.AI.run(AI_MODEL, schema ? { ...opts, response_format: { type: 'json_schema', json_schema: schema } } : opts);
  } catch (e) {
    if (!schema) throw e;
    out = await env.AI.run(AI_MODEL, opts); // retry without JSON mode
  }
  const r = out && out.response;
  return typeof r === 'string' ? r : r != null ? JSON.stringify(r) : null;
}

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    details: { type: 'string' },
    date: { type: 'string' },
    time: { type: 'string' },
    repeat: { type: 'string', enum: ['none', 'daily', 'weekly'] },
    early_minutes: { type: 'integer' },
  },
  required: ['title', 'date', 'time', 'repeat', 'early_minutes'],
};

// Turns "submit stats Thursday 10pm remind me an hour before" into task fields. Returns null if AI is unavailable.
async function aiParse(env, text) {
  if (!env.AI) return null;
  const tz = env.TZ || 'Asia/Riyadh', now = Date.now(), n = localNow(env, now);
  const days = [];
  for (let i = 0; i < 8; i++) {
    const d = localNow(env, now + i * DAY);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(new Date(now + i * DAY));
    days.push(wd + ' = ' + d.date + (i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''));
  }
  const system = [
    'You turn a quick note into a reminder. The note may be English, Arabic, or mixed.',
    'Now: ' + n.date + ' ' + n.hm + ' (24h, local time). The week starts on Sunday.',
    'Upcoming dates: ' + days.join('; ') + '.',
    'Return JSON only, with these fields:',
    '- title: the task itself, short, in the same language as the note, with all time/date/repeat/early-reminder words removed. Capitalise the first letter.',
    '- details: any extra context that is not part of the title, or "".',
    '- date: YYYY-MM-DD, or "" if no day is mentioned.',
    '- time: HH:MM in 24h, or "" if no time is mentioned. "morning"=09:00, "noon"=12:00, "afternoon"=15:00, "evening"=19:00, "tonight"=21:00. "in 2 hours" means now plus 2 hours (set the date too).',
    '- repeat: "daily" for every day, "weekly" for every week or every <weekday>, otherwise "none".',
    '- early_minutes: if the note asks for an earlier heads-up ("remind me 30 min before", "a day before"), the minutes (10, 30, 60 or 1440), otherwise 0.',
    'A weekday name means the next upcoming one (today counts only if the time is still ahead). Never invent dates the note does not imply.',
  ].join('\n');
  let raw;
  try {
    raw = await runAI(env, [{ role: 'system', content: system }, { role: 'user', content: text }], 220, PARSE_SCHEMA);
  } catch (e) { console.error('AI parse failed', e); return null; }
  if (!raw) return null;
  let o;
  try { o = JSON.parse(raw); } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/); if (!m) return null;
    try { o = JSON.parse(m[0]); } catch (_) { return null; }
  }
  const title = String(o.title || '').trim().slice(0, 300) || text.slice(0, 300);
  let date = /^\d{4}-\d{2}-\d{2}$/.test(o.date || '') ? o.date : '';
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(o.time || '') ? o.time.padStart(5, '0') : '';
  let remind_at = null;
  if (date || time) {
    const [hh, mm] = (time || '09:00').split(':').map(Number);
    const [y, mo, d] = (date || n.date).split('-').map(Number);
    remind_at = zonedToUtc(y, mo, d, hh, mm, tz);
    if (!date && remind_at <= now) remind_at += DAY; // a time with no day = the next time it comes round
  }
  const repeat = REPEATS.includes(o.repeat) ? o.repeat : 'none';
  const em = Number(o.early_minutes) || 0;
  const lead_min = em <= 0 || remind_at == null ? 0 : LEADS.slice(1).reduce((a, b) => (Math.abs(b - em) < Math.abs(a - em) ? b : a));
  return { title, details: String(o.details || '').trim().slice(0, 2000), remind_at, repeat, lead_min };
}

// ---------------------------------------------------------------- morning plan
async function briefSettings(env) {
  return {
    enabled: (await getSetting(env, 'brief_enabled')) !== '0',
    time: (await getSetting(env, 'brief_time')) || '11:00',
    connected: !!(await getSetting(env, 'chat_id')),
    ai: !!env.AI,
  };
}

async function maybeSendBrief(env) {
  const s = await briefSettings(env);
  if (!s.enabled || !s.connected || !env.TELEGRAM_TOKEN) return;
  const n = localNow(env);
  const mins = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const late = mins(n.hm) - mins(s.time);
  if (late < 0 || late > 180) return; // only within 3 hours after the chosen time (no surprise plan at night)
  if ((await getSetting(env, 'brief_last')) === n.date) return;
  await setSetting(env, 'brief_last', n.date); // mark first so it never sends twice
  await sendBrief(env, await getSetting(env, 'chat_id'));
}

async function sendBrief(env, chat) {
  const tz = env.TZ || 'Asia/Riyadh', now = Date.now(), n = localNow(env, now);
  const dayStart = zonedToUtc(n.year, n.month, n.day, 0, 0, tz), dayEnd = dayStart + DAY;
  const all = await listTasks(env);
  const open = all.filter((t) => !t.done);
  const overdue = open.filter((t) => t.remind_at != null && t.remind_at < now);
  const today = open.filter((t) => t.remind_at != null && t.remind_at >= now && t.remind_at < dayEnd);
  const doneToday = all.filter((t) => t.done && t.remind_at != null && t.remind_at >= dayStart && t.remind_at < dayEnd);
  const tomorrow = open.filter((t) => t.remind_at != null && t.remind_at >= dayEnd && t.remind_at < dayEnd + DAY);

  const line = (t) => '• ' + fmtClock(env, t.remind_at) + '  ' + esc(t.title);
  const dateLabel = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now));
  let s = '☀️ <b>Your plan for ' + dateLabel + '</b>\n';
  if (today.length) s += '\n<b>Today</b>\n' + today.map(line).join('\n') + '\n';
  if (doneToday.length) s += '\n<i>Already done: ' + doneToday.map((t) => esc(t.title)).join(', ') + '</i>\n';
  if (overdue.length) s += '\n<b>Overdue</b>\n' + overdue.slice(0, 10).map((t) => '• ' + esc(t.title) + '  <i>(' + fmtTime(env, t.remind_at) + ')</i>').join('\n') + '\n';
  if (!today.length && !overdue.length) s += '\nNothing scheduled for the rest of today. 🎉\n';
  if (tomorrow.length) s += '\n<i>Tomorrow: ' + tomorrow.length + ' task' + (tomorrow.length > 1 ? 's' : '') + '</i>\n';

  // a short, friendly suggestion from the AI (skipped quietly if AI is unavailable)
  if (today.length || overdue.length) {
    try {
      const facts = 'Now ' + n.hm + '. Today: ' + (today.map((t) => fmtClock(env, t.remind_at) + ' ' + t.title + (t.details ? ' (' + t.details.slice(0, 80) + ')' : '')).join('; ') || 'none') +
        '. Overdue: ' + (overdue.map((t) => t.title).join('; ') || 'none') + '. Tomorrow: ' + (tomorrow.map((t) => t.title).join('; ') || 'none') + '.';
      const tip = await runAI(env, [
        { role: 'system', content: 'You are a friendly, brief planning assistant for a busy person. In English, write 1 or 2 short sentences: which task to tackle first and why, plus a light encouraging touch. Only mention tasks from the list. No greeting, no lists, no emojis, no markdown.' },
        { role: 'user', content: facts },
      ], 120);
      if (tip && tip.trim()) s += '\n💡 ' + esc(tip.trim().replace(/^["']|["']$/g, '')) + '\n';
    } catch (e) { console.error('AI tip failed', e); }
  }
  return tg(env, 'sendMessage', { chat_id: chat, text: s.trim(), parse_mode: 'HTML' });
}

// "Call mom at 18:30" | "report tomorrow 9am" | "oven in 20m"
export function parseQuickAdd(input, tz, now = Date.now()) {
  let text = input.trim();
  let remind_at = null;

  const rel = text.match(/\s+in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (rel) {
    const n = parseFloat(rel[1]);
    const u = rel[2][0].toLowerCase();
    remind_at = now + n * (u === 'm' ? 60000 : u === 'h' ? 3600000 : DAY);
    text = text.slice(0, rel.index);
  } else {
    const abs = text.match(/\s+(?:(?:at|@)\s+)?(today|tomorrow|tmrw)?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    const hasMarker = abs && (abs[1] || abs[3] || abs[4] || /\s(at|@)\s/i.test(abs[0]));
    if (abs && hasMarker) {
      let h = Number(abs[2]);
      const mi = Number(abs[3] || 0);
      const ap = (abs[4] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      if (h <= 23 && mi <= 59) {
        const p = zonedParts(now, tz);
        let ts = zonedToUtc(p.year, p.month, p.day, h, mi, tz);
        const day = (abs[1] || '').toLowerCase();
        if (day.startsWith('t') && day !== 'today') ts += DAY;
        else if (!day && ts <= now) ts += DAY;
        remind_at = ts;
        text = text.slice(0, abs.index);
      }
    } else {
      const dayOnly = text.match(/\s+(tomorrow|tmrw)$/i);
      if (dayOnly) {
        const p = zonedParts(now + DAY, tz);
        remind_at = zonedToUtc(p.year, p.month, p.day, 9, 0, tz);
        text = text.slice(0, dayOnly.index);
      }
    }
  }
  return { title: text.trim(), remind_at };
}

// ---------------------------------------------------------------- time helpers
function zonedParts(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = zonedParts(guess, tz);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
  return guess - offset;
}
function fmtTime(env, ts) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: env.TZ || 'Asia/Riyadh', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ts));
}
function fmtClock(env, ts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: env.TZ || 'Asia/Riyadh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
}

// ---------------------------------------------------------------- misc helpers
async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value)).run();
}
async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function linkCode(env) { return (await sha('link:' + env.APP_KEY + ':' + env.TELEGRAM_TOKEN)).slice(0, 24); }
async function hookSecret(env) { return (await sha('hook:' + env.APP_KEY + ':' + env.TELEGRAM_TOKEN)).slice(0, 40); }
async function safeEqual(a, b) { return (await sha(a)) === (await sha(b)); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS }); }

function manifest() {
  return json({
    name: 'Reminders', short_name: 'Reminders', start_url: '/', display: 'standalone',
    background_color: '#111315', theme_color: '#111315',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }, { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  });
}
function icon() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#1f7a5a"/>' +
    '<path d="M256 112c-62 0-104 46-104 106v62l-34 52h276l-34-52v-62c0-60-42-106-104-106z" fill="#fff"/>' +
    '<circle cx="256" cy="376" r="36" fill="#fff"/></svg>';
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
}

// 180x180 PNG for the iPhone home-screen icon (iOS ignores SVG icons)
const TOUCH_ICON_B64 = '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';
function touchIcon() {
  const bin = atob(TOUCH_ICON_B64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}
