'use strict';
/*
 * Бот записи «Бенефактор».
 * Ведёт человека по короткому сценарию (запрос, имя, возраст, город, контакт)
 * и присылает готовую заявку владельцу (OWNER_CHAT_ID) в личку.
 *
 * Токен и chat_id берутся ТОЛЬКО из переменных окружения (.env локально или
 * секреты хостинга) — в коде и репозитории их нет.
 */
try { require('dotenv').config(); } catch (_) {} // локально читает .env; на хостинге переменные берутся из дашборда
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;
const OWNER = process.env.OWNER_CHAT_ID; // твой chat_id (твинк) — узнать командой /myid

if (!TOKEN) {
  console.error('✗ Нет BOT_TOKEN. Создай бота в @BotFather, положи токен в .env (BOT_TOKEN=...).');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// сценарий вопросов (по порядку)
const STEPS = [
  { key: 'problem', q: 'С каким запросом или проблемой вы приходите? Опишите в двух-трёх словах.' },
  { key: 'name',    q: 'Как вас зовут?' },
  { key: 'age',     q: 'Сколько вам лет?' },
  { key: 'city',    q: 'Из какого вы города? (нужно, чтобы учесть часовой пояс)' },
  { key: 'contact', q: 'Как удобнее связаться? Оставьте номер телефона или @ник в Telegram.' }
];

const PKG = { diag: 'Диагностика', '8': 'Пакет 8 сессий', '15': 'Пакет 15 сессий', '25': 'Пакет 25 сессий' };
const sessions = new Map(); // chatId -> { step, answers, pkg, user }

// /start [param] — param приходит из ссылки t.me/бот?start=15
bot.onText(/^\/start(?:\s+(\S+))?/, (msg, m) => {
  const id = msg.chat.id;
  const pkg = PKG[(m[1] || '').trim()] || 'Диагностика';
  sessions.set(id, { step: 0, answers: {}, pkg, user: fromLabel(msg.from) });
  bot.sendMessage(id,
    'Здравствуйте! Это бот записи к Игорю Стрельникову — система «Бенефактор».\n' +
    'Задам 5 коротких вопросов и передам заявку лично Игорю.\n\n' +
    'Вы записываетесь на: *' + pkg + '*.',
    { parse_mode: 'Markdown' }
  ).then(() => ask(id));
});

// служебное: узнать свой chat_id (впиши его в OWNER_CHAT_ID)
bot.onText(/^\/myid/, (msg) => bot.sendMessage(msg.chat.id, 'Ваш chat_id: `' + msg.chat.id + '`', { parse_mode: 'Markdown' }));

bot.on('message', (msg) => {
  const id = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text || text.startsWith('/')) return;      // команды идут через onText
  const s = sessions.get(id);
  if (!s) return bot.sendMessage(id, 'Чтобы оставить заявку, напишите /start');
  s.answers[STEPS[s.step].key] = text;
  s.user = fromLabel(msg.from);
  s.step++;
  s.step >= STEPS.length ? finish(id) : ask(id);
});

function ask(id) {
  const s = sessions.get(id);
  if (s && s.step < STEPS.length) bot.sendMessage(id, STEPS[s.step].q);
}

function finish(id) {
  const s = sessions.get(id);
  if (!s) return;
  const a = s.answers;
  const summary =
    '🆕 *Новая заявка с сайта*\n\n' +
    '📦 Пакет: ' + s.pkg + '\n' +
    '🎯 Запрос: ' + (a.problem || '—') + '\n' +
    '👤 Имя: ' + (a.name || '—') + '\n' +
    '🎂 Возраст: ' + (a.age || '—') + '\n' +
    '🏙 Город: ' + (a.city || '—') + '\n' +
    '📞 Контакт: ' + (a.contact || '—') + '\n' +
    '💬 Профиль: ' + (s.user || '—');
  if (OWNER) {
    bot.sendMessage(OWNER, summary, { parse_mode: 'Markdown' })
       .catch((e) => console.error('Не смог отправить владельцу:', e.message));
  } else {
    console.log('OWNER_CHAT_ID не задан — заявка в консоль:\n' + summary);
  }
  bot.sendMessage(id, 'Спасибо! Заявка отправлена Игорю — он свяжется с вами лично. 🙌');
  sessions.delete(id);
}

function fromLabel(u) {
  if (!u) return '';
  return u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' ');
}

bot.on('polling_error', (e) => console.error('polling_error:', e.code || e.message));
console.log('✓ Бот запущен (long polling). Жду сообщения…' + (OWNER ? '' : '  [OWNER_CHAT_ID не задан — заявки в консоль]'));
