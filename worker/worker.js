/*
 * Бот записи «Бенефактор» на Cloudflare Workers (webhook).
 *
 * Сайт зовёт POST /lead {name, tg, pkg} → получает короткий код.
 * Кнопка на сайте открывает t.me/<бот>?start=<код>.
 * Бот здоровается по имени, задаёт 5 вопросов и шлёт владельцу сводку.
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
  'Как давно вы с этим живёте?',
  'Когда удобно созвониться? Оставьте номер или @ник для связи.'
];
const KEYS = ['problem', 'age', 'city', 'duration', 'contact'];
const PKG = { diag: 'Диагностика', '8': 'Пакет 8 сессий', '15': 'Пакет 15 сессий', '25': 'Пакет 25 сессий' };

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
    const session = { step: 0, answers: {}, name, tg, pkg, user: fromLabel(msg.from) };
    await env.KV.put('sess:' + chatId, JSON.stringify(session), { expirationTtl: 86400 });
    const greet = name ? `${name}, здравствуйте!` : 'Здравствуйте!';
    await send(env, chatId, `${greet} Это бот записи к Игорю Стрельникову — система «Бенефактор». Задам 5 коротких вопросов и передам заявку лично Игорю.`);
    await send(env, chatId, QUESTIONS[0]);
    return;
  }

  const raw = await env.KV.get('sess:' + chatId);
  if (!raw) { await send(env, chatId, 'Чтобы оставить заявку, начните с сайта или напишите /start'); return; }
  const s = JSON.parse(raw);
  s.answers[KEYS[s.step]] = text;
  s.user = fromLabel(msg.from);
  s.step++;

  if (s.step < QUESTIONS.length) {
    await env.KV.put('sess:' + chatId, JSON.stringify(s), { expirationTtl: 86400 });
    await send(env, chatId, QUESTIONS[s.step]);
  } else {
    await env.KV.delete('sess:' + chatId);
    const a = s.answers;
    const summary =
      '🆕 Новая заявка с сайта\n\n' +
      '📦 Пакет: ' + s.pkg + '\n' +
      '👤 Имя: ' + (s.name || '—') + '\n' +
      '🎯 Запрос: ' + (a.problem || '—') + '\n' +
      '🎂 Возраст: ' + (a.age || '—') + '\n' +
      '🏙 Город: ' + (a.city || '—') + '\n' +
      '⏳ Давность: ' + (a.duration || '—') + '\n' +
      '📞 Связь: ' + (a.contact || '—') + '\n' +
      '💬 Профиль: ' + (s.user || s.tg || '—');
    if (env.OWNER_CHAT_ID) await send(env, env.OWNER_CHAT_ID, summary);
    await send(env, chatId, 'Спасибо! Заявка передана Игорю — он свяжется с вами лично. 🙌');
  }
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
