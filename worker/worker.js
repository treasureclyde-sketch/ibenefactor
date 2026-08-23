/*
 * Бот записи «Бенефактор» на Cloudflare Workers (webhook).
 *
 * Сайт зовёт POST /lead {name, tg, pkg} → получает короткий код.
 * Кнопка на сайте открывает t.me/<бот>?start=<код>.
 * Бот здоровается по имени, задаёт вопросы и в конце предлагает выбрать
 * удобный способ связи (кнопки: телефон / почта / Telegram), затем шлёт
 * владельцу готовую сводку.
 *
 * Секреты/переменные (задаются в Cloudflare, НЕ в коде):
 *   BOT_TOKEN       — токен из @BotFather (секрет)
 *   OWNER_CHAT_ID   — твой chat_id, куда падают заявки
 *   WEBHOOK_SECRET  — (необязательно) секрет вебхука
 * Биндинг KV: KV — хранилище сессий и заявок.
 */

const QUESTIONS = [
  'Какой у вас запрос или проблема? Опишите в двух-трёх словах.',
  'Сколько вам лет?',
  'Из какого вы города? (чтобы учесть часовой пояс)',
  'Как давно вы с этим живёте?'
];
const KEYS = ['problem', 'age', 'city', 'duration'];
const PKG = { diag: 'Диагностика', '8': 'Пакет 8 сессий', '15': 'Пакет 15 сессий', '25': 'Пакет 25 сессий' };

// Тексты под каждый способ связи
const METHOD = {
  phone: { label: 'Телефон',  ask: 'Напишите ваш номер телефона:' },
  email: { label: 'Почта',    ask: 'Напишите вашу почту (email):' },
  tg:    { label: 'Telegram', ask: 'Напишите ваш @username в Telegram:' }
};

// Куда слать заявки. Если переменная OWNER_CHAT_ID из Cloudflare не подхватывается —
// впиши id аккаунта-получателя ПРЯМО СЮДА (это не секрет, обычный номер чата).
// Этот аккаунт должен один раз нажать Start у бота.
const OWNER_ID_FALLBACK = '8857726398';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // Сайт регистрирует заявку → возвращаем короткий код для deep-link
    if (url.pathname === '/lead' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || '').slice(0, 60);
      const tg = String(body.tg || '').slice(0, 60);
      const pkg = String(body.pkg || '');
      const code = rand();
      await env.KV.put('lead:' + code, JSON.stringify({ name, tg, pkg }), { expirationTtl: 86400 });
      return cors(json({ code }));
    }

    // Вебхук Telegram
    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json().catch(() => null);
      if (update) ctx.waitUntil(handleUpdate(update, env));
      return new Response('ok');
    }

    return new Response('Benefactor bot worker is running');
  }
};

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith('/start')) {
    const param = text.split(/\s+/)[1] || '';
    let name = '', tg = '', pkg = 'Диагностика';
    if (param) {
      const raw = await env.KV.get('lead:' + param);
      if (raw) { const l = JSON.parse(raw); name = l.name || ''; tg = l.tg || ''; pkg = PKG[l.pkg] || pkg; }
    }
    const session = { step: 0, phase: 'qa', answers: {}, name, tg, pkg, user: fromLabel(msg.from) };
    await save(env, chatId, session);
    const greet = name ? `${name}, здравствуйте!` : 'Здравствуйте!';
    await send(env, chatId, `${greet} Это бот записи к Игорю Стрельникову — система «Бенефактор». Задам несколько коротких вопросов и передам заявку лично Игорю.`);
    await send(env, chatId, QUESTIONS[0]);
    return;
  }

  const raw = await env.KV.get('sess:' + chatId);
  if (!raw) { await send(env, chatId, 'Чтобы оставить заявку, начните с сайта или напишите /start'); return; }
  const s = JSON.parse(raw);
  s.user = fromLabel(msg.from);

  // ждём контакт (человек выбрал способ связи или пишет его вручную)
  if (s.phase === 'awaitContact' || s.phase === 'awaitMethod') {
    s.contact = text;
    if (!s.contactMethod) s.contactMethod = 'Контакт';
    await finish(s, chatId, env);
    return;
  }

  // блок вопросов
  s.answers[KEYS[s.step]] = text;
  s.step++;
  if (s.step < QUESTIONS.length) {
    await save(env, chatId, s);
    await send(env, chatId, QUESTIONS[s.step]);
  } else {
    s.phase = 'awaitMethod';
    await save(env, chatId, s);
    await sendContactChoice(env, chatId);
  }
}

async function handleCallback(cq, env) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || '';
  await answerCallback(env, cq.id);
  if (!chatId) return;

  const raw = await env.KV.get('sess:' + chatId);
  if (!raw) return;
  const s = JSON.parse(raw);
  if (s.phase !== 'awaitMethod') return;

  const key = data.startsWith('m:') ? data.slice(2) : '';
  const m = METHOD[key];
  if (!m) return;
  s.contactMethod = m.label;

  // Telegram: если у человека есть @username — берём автоматически и завершаем
  if (key === 'tg') {
    const uname = cq.from && cq.from.username ? '@' + cq.from.username : '';
    if (uname) { s.contact = uname; await finish(s, chatId, env); return; }
  }

  s.phase = 'awaitContact';
  await save(env, chatId, s);
  await send(env, chatId, m.ask);
}

async function finish(s, chatId, env) {
  await env.KV.delete('sess:' + chatId);
  const a = s.answers || {};
  const summary =
    '🆕 Новая заявка с сайта\n\n' +
    '📦 Пакет: ' + s.pkg + '\n' +
    '👤 Имя: ' + (s.name || '—') + '\n' +
    '🎯 Запрос: ' + (a.problem || '—') + '\n' +
    '🎂 Возраст: ' + (a.age || '—') + '\n' +
    '🏙 Город: ' + (a.city || '—') + '\n' +
    '⏳ Давность: ' + (a.duration || '—') + '\n' +
    '📞 Связь (' + (s.contactMethod || '—') + '): ' + (s.contact || '—') + '\n' +
    '💬 Профиль: ' + (s.user || s.tg || '—');
  const owner = env.OWNER_CHAT_ID || OWNER_ID_FALLBACK;
  if (owner) await send(env, owner, summary);
  await send(env, chatId, 'Спасибо! Заявка передана Игорю — он свяжется с вами лично. 🙌');
}

function sendContactChoice(env, chatId) {
  return fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: 'Последний шаг. Как вам удобнее, чтобы с вами связались? Выберите вариант:',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📞 Телефон', callback_data: 'm:phone' }],
          [{ text: '✉️ Почта', callback_data: 'm:email' }],
          [{ text: '✈️ Telegram', callback_data: 'm:tg' }]
        ]
      }
    })
  });
}

function answerCallback(env, id) {
  return fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/answerCallbackQuery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id })
  });
}

function save(env, chatId, session) {
  return env.KV.put('sess:' + chatId, JSON.stringify(session), { expirationTtl: 86400 });
}

function send(env, chatId, text) {
  return fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

function fromLabel(u) {
  if (!u) return '';
  return u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ');
}
function rand() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }
function json(o) { return new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } }); }
function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'content-type');
  return res;
}
