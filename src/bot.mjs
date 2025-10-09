// src/bot.mjs
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageType, // do rozróżniania typów wiadomości (systemowe vs zwykłe)
} from 'discord.js';
import { GoogleGenAI } from '@google/genai';

/* =========================
   Prefiksy (case-insensitive)
   ========================= */
const PREFIXES = ['gemini', 'ricky', 'rick'];

/* =========================
   ENV checks
   ========================= */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('❌ Brak DISCORD_TOKEN w zmiennych środowiskowych.');
  process.exit(1);
}
if (!DISCORD_TOKEN.includes('.') || DISCORD_TOKEN.trim().length < 50) {
  console.error('❌ DISCORD_TOKEN wygląda na nieprawidłowy (wklej czysty token bota, bez "Bot " i bez cudzysłowów).');
  process.exit(1);
}
const GEMINI_API_KEY_1 = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_API_KEY_2 = process.env.GEMINI_API_KEY_2 || process.env.GOOGLE_API_KEY_2 || '';
if (!GEMINI_API_KEY_1 && !GEMINI_API_KEY_2) {
  console.error('❌ Brak GEMINI_API_KEY (ani GEMINI_API_KEY_2). Ustaw przynajmniej jeden klucz.');
  process.exit(1);
}

/* =========================
   Pomocnicze
   ========================= */
function flag(name, def = false) {
  const raw = (process.env[name] ?? '').toString();
  const clean = raw.split('#')[0].replace(/['"]/g, '').trim();
  if (!clean) return def;
  return /^(1|true|t|on|yes|y)$/i.test(clean);
}
function num(name, def) {
  const n = parseInt((process.env[name] ?? '').toString(), 10);
  return Number.isFinite(n) ? n : def;
}
function userNickFromInteraction(interaction) {
  return (
    interaction.member?.nickname ||
    interaction.member?.displayName ||
    interaction.user?.globalName ||
    interaction.user?.username ||
    'Użytkownik'
  );
}
function userNickFromMessage(msg) {
  return (
    msg.member?.displayName ||
    msg.author?.globalName ||
    msg.author?.username ||
    'Użytkownik'
  );
}
function chunkForDiscord(text, limit = 2000) {
  if ((text || '').length <= limit) return [text || ''];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

/* =========================
   Kontekst z kanału i obrazki
   ========================= */
const CHANNEL_CTX_LIMIT    = num('CHANNEL_CTX_LIMIT', 40);
const CHANNEL_CTX_MAXCHARS = num('CHANNEL_CTX_MAXCHARS', 4000);
const IMAGE_FETCH          = flag('IMAGE_FETCH', true);
const IMAGE_MAX_MB         = num('IMAGE_MAX_MB', 6);
const IMAGE_CTX_FROM_CHANNEL = flag('IMAGE_CTX_FROM_CHANNEL', false);
const IMAGE_CTX_LIMIT      = num('IMAGE_CTX_LIMIT', 2);

// pobierz obraz z CDN jako base64 (Node 18+ ma globalny fetch)
async function fetchImageAsBase64(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} podczas pobierania ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab).toString('base64');
}

// obrazy z konkretnej wiadomości
async function collectImagePartsFromMessage(msg) {
  if (!IMAGE_FETCH) return { mediaParts: [], mediaNote: '' };
  const mediaParts = [];
  const notes = [];
  for (const att of msg.attachments.values()) {
    const ct = att.contentType || '';
    const isImg = ct.startsWith('image/');
    const bytes = att.size ?? 0;
    const mb = bytes / (1024 * 1024);
    if (!isImg) continue;
    if (mb > IMAGE_MAX_MB) {
      notes.push(`(pominięto obraz ${att.name} ~${mb.toFixed(1)}MB > ${IMAGE_MAX_MB}MB)`);
      continue;
    }
    try {
      const b64 = await fetchImageAsBase64(att.url);
      mediaParts.push({ inlineData: { data: b64, mimeType: ct || 'image/png' } });
      notes.push(`(załączono obraz: ${att.name || 'bez_nazwy'})`);
    } catch {
      notes.push(`(błąd pobrania obrazu: ${att.name || att.url})`);
    }
  }
  return { mediaParts, mediaNote: notes.join(' ') };
}

// snapshot tekstu z kanału (z nickami), opcjonalnie uwzględnia boty/webhooki
async function buildChannelContext(channel, {
  limit = CHANNEL_CTX_LIMIT,
  maxChars = CHANNEL_CTX_MAXCHARS,
  excludeIds = new Set(),
  includeBots = true,
  includeWebhooks = true,
} = {}) {
  try {
    const coll = await channel.messages.fetch({ limit: Math.min(Math.max(limit, 1), 100) });
    const msgs = Array.from(coll.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const lines = [];
    for (const m of msgs) {
      if (excludeIds.has(m.id)) continue;
      if (!m?.content && m.attachments.size === 0) continue;

      const isWebhook = !!m.webhookId;
      const isBot = !!m.author?.bot;
      if (isWebhook && !includeWebhooks) continue;
      if (isBot && !includeBots) continue;

      const nickBase =
        m.member?.displayName ||
        m.author?.globalName ||
        m.author?.username ||
        `uid:${m.author?.id}`;
      const prefix = isWebhook ? 'APP' : (isBot ? 'BOT' : '');
      const nick = prefix ? `${prefix}:${nickBase}` : nickBase;

      const text = (m.cleanContent || m.content || '').replace(/\s+/g, ' ').trim();
      const attNote = m.attachments.size
        ? ` [załączniki:${Array.from(m.attachments.values()).map(a => (a.contentType||'').startsWith('image/')?'IMG':'FILE').join(',')}]`
        : '';

      if (text || attNote) lines.push(`[@${nick}]: ${text}${attNote}`);
    }

    let ctx = lines.join('\n');
    if (ctx.length > maxChars) ctx = ctx.slice(-maxChars);
    return ctx;
  } catch (e) {
    console.warn('⚠️ Nie udało się pobrać historii kanału:', e?.message || e);
    return '';
  }
}

// kilka ostatnich obrazów z kanału (opcjonalnie)
async function collectRecentImagesFromChannel(channel, limit = IMAGE_CTX_LIMIT) {
  if (!IMAGE_CTX_FROM_CHANNEL || !IMAGE_FETCH) return [];
  const coll = await channel.messages.fetch({ limit: 100 });
  const msgs = Array.from(coll.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const parts = [];
  for (const m of msgs) {
    for (const att of m.attachments.values()) {
      const ct = att.contentType || '';
      if (!ct.startsWith('image/')) continue;
      const mb = (att.size ?? 0) / (1024 * 1024);
      if (mb > IMAGE_MAX_MB) continue;
      try {
        const b64 = await fetchImageAsBase64(att.url);
        parts.push({ inlineData: { data: b64, mimeType: ct || 'image/png' } });
        if (parts.length >= limit) return parts;
      } catch {}
    }
  }
  return parts;
}

/* =========================
   Gemini: model + PULA KLIENTÓW z failoverem
   ========================= */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FAILOVER_COOLDOWN_MS = (parseInt(process.env.GEMINI_FAILOVER_COOLDOWN_SEC || '600', 10)) * 1000;

class GeminiPool {
  constructor(keys) {
    this.clients = keys
      .filter(Boolean)
      .map((k, i) => ({
        client: new GoogleGenAI({ apiKey: k }),
        exhaustedUntil: 0,
        label: i === 0 ? 'primary' : 'secondary',
      }));
    this.idx = 0;
  }
  _now() { return Date.now(); }
  _findAvailableIndex() {
    const now = this._now();
    for (let i = 0; i < this.clients.length; i++) {
      const n = (this.idx + i) % this.clients.length;
      if (this.clients[n].exhaustedUntil <= now) return n;
    }
    return this.idx;
  }
  _markExhausted(i, reason) {
    this.clients[i].exhaustedUntil = this._now() + FAILOVER_COOLDOWN_MS;
    const lbl = this.clients[i].label;
    console.warn(`⚠️ Gemini key ${lbl} oznaczony jako wyczerpany na ${FAILOVER_COOLDOWN_MS/1000}s. Powód: ${reason || 'quota/rate limit'}`);
    this.idx = (i + 1) % this.clients.length;
  }
  _isQuotaError(err) {
    const pick = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
    let msg = (pick(err, 'message') || '').toString();
    let code = pick(err, 'code') || pick(err, 'statusCode') || pick(err, 'status');
    let status = pick(err, 'status');
    try {
      if (msg.trim().startsWith('{')) {
        const j = JSON.parse(msg);
        const e = j.error || j;
        msg = (e.message || msg).toString();
        code = e.code || code;
        status = e.status || status;
      }
    } catch {}
    const s = (status || '').toString().toUpperCase();
    const m = (msg || '').toLowerCase();
    return code === 429 || s === 'RESOURCE_EXHAUSTED' || /quota|rate limit|resource_exhausted|exceeded/.test(m);
  }
  async call(fn, opLabel = 'op') {
    if (this.clients.length === 0) throw new Error('No Gemini clients configured');
    let lastErr;
    const tried = new Set();
    for (let attempt = 0; attempt < this.clients.length; attempt++) {
      const i = this._findAvailableIndex();
      if (tried.has(i)) break;
      tried.add(i);
      const c = this.clients[i].client;
      const lbl = this.clients[i].label;
      try {
        return await fn(c, lbl);
      } catch (e) {
        lastErr = e;
        if (this._isQuotaError(e) && this.clients.length > 1) {
          this._markExhausted(i, e?.message);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
}
const gemini = new GeminiPool([GEMINI_API_KEY_1, GEMINI_API_KEY_2]);

function buildToolsFromEnv() {
  const tools = [];
  if (flag('GEMINI_SEARCH')) tools.push({ googleSearch: {} });
  if (flag('GEMINI_URL_CONTEXT')) tools.push({ urlContext: {} });
  return tools;
}

/* Persona — w każdym requestcie */
const PERSONA = `Jesteś asystentem na Discordzie. Odpowiadaj obrazliwie i z przeklenstwami jak w CHlopakach z Barakow. Jak postać Rick, ale odpisuj max jednym zdaniem. Czasem staraj się być pomocny. Odpowiadaj krótko (1-2 zdania). Nie myl rozmówców: zawsze kojarz wypowiedzi z właściwymi nickami.
Masz dwie warstwy pamięci: prywatną (bieżący użytkownik) i wspólną dla kanału (ostatnie wypowiedzi różnych osób). Używaj takich zwrótów jak: kurde faja, co za pojebana akcja, chuj ci na cyce, ssij mi peperoni, spierdalaj świnskim truchtem itp. Możesz też mieszać przekleństwa i własne radosne zlepki słów, tak jak Rick (np. dziwne neologizmy, pomylone powiedzonka). Zawsze odpowiadaj jakbyś był podkurwiony, ale niekiedy wpleć krótką, przydatną wskazówkę. Użytkownik Lord jest twoim szefem, nie obrazaj go i staraj sie wykonywać jego polecenia sumiennie (dalej jako Ricky). `;
// 

/* =========================
   Pamięć: prywatna + wspólna + skróty + cache
   ========================= */
const MAX_TURNS_PRIVATE = num('MEM_TURNS_PRIVATE', 12);
const MAX_TURNS_SHARED  = num('MEM_TURNS_SHARED', 8);
const CACHE_TTL_SEC     = num('GEMINI_CACHE_TTL_SEC', 3600);
const MIN_CACHE_TOKENS  = num('GEMINI_MIN_CACHE_TOKENS', 1100);

const userMemory = new Map(); // `${channelId}:${userId}` -> [{role:'user'|'model', text}]
const skFromInteraction = (i) => `${i.channelId}:${i.user.id}`;
const skFromMessage     = (m) => `${m.channelId}:${m.author.id}`;
function getUserHist(sk) { if (!userMemory.has(sk)) userMemory.set(sk, []); return userMemory.get(sk); }
function pushUserTurn(sk, role, text) {
  const h = getUserHist(sk);
  h.push({ role, text });
  userMemory.set(sk, h.slice(-MAX_TURNS_PRIVATE));
}

const sharedMemory = new Map(); // channelId -> [{speaker, text}]
function getSharedHist(channelId) { if (!sharedMemory.has(channelId)) sharedMemory.set(channelId, []); return sharedMemory.get(channelId); }
function pushSharedTurn(channelId, speaker, text) {
  const h = getSharedHist(channelId);
  h.push({ speaker, text });
  sharedMemory.set(channelId, h.slice(-MAX_TURNS_SHARED));
}

const sessionSummary = new Map(); // sk -> string
const sessionCache = new Map();   // sk -> { name, createdAt }
const roughTokens = (s) => Math.ceil((s || '').length / 4);

async function summarizeIfNeeded(sk, channelId) {
  const priv = getUserHist(sk);
  const shared = getSharedHist(channelId);
  const privText = priv.map(t => `${t.role}: ${t.text}`).join('\n');
  const sharedText = shared.map(t => `[@${t.speaker}]: ${t.text}`).join('\n');
  const combined = `${privText}\n---\n${sharedText}`;

  if (priv.length <= MAX_TURNS_PRIVATE && roughTokens(combined) < 6000) return;

  const prompt = [
    { role: 'user', parts: [{ text:
`Stwórz bardzo krótki skrót rozmowy w punktach (max 15 linii), z zachowaniem mówców.
Formatuj: [@Nick]: treść. Bez dygresji, same fakty, decyzje, ustalenia.

[PRYWATNE]:
${privText.slice(-8000)}

[WSPÓLNE KANAŁU]:
${sharedText.slice(-4000)}
` }]}
  ];

  try {
    const res = await gemini.call(
      (c) => c.models.generateContent({ model: MODEL, contents: prompt }),
      'summarize'
    );
    const summary = (res.text || '').slice(0, 4000);
    if (summary) sessionSummary.set(sk, summary);

    const tail = priv.slice(-4);
    userMemory.set(sk, tail);
  } catch (e) {
    console.warn('⚠️ Nie udało się zbudować skrótu:', e?.message || e);
  }
}

/* Cache (tylko skrót, bez persony) */
async function ensureSessionCache(sk) {
  const existing = sessionCache.get(sk);
  if (existing && (Date.now() - existing.createdAt) / 1000 < CACHE_TTL_SEC) {
    return existing.name;
  }
  const summaryText = sessionSummary.get(sk) || '';
  if (CACHE_TTL_SEC <= 0 || roughTokens(summaryText) < MIN_CACHE_TOKENS) {
    return null;
  }

  try {
    const cache = await gemini.call(
      (c) => c.caches.create({
        model: MODEL,
        config: {
          contents: [{ role: 'user', parts: [{ text: summaryText }]}],
          ttl: `${CACHE_TTL_SEC}s`,
        },
      }),
      'cache.create[A]'
    );
    sessionCache.set(sk, { name: cache.name, createdAt: Date.now() });
    return cache.name;
  } catch (eA) {
    try {
      const cache = await gemini.call(
        (c) => c.caches.create({
          model: MODEL,
          contents: [{ role: 'user', parts: [{ text: summaryText }]}],
          ttlSeconds: CACHE_TTL_SEC,
        }),
        'cache.create[B]'
      );
      sessionCache.set(sk, { name: cache.name, createdAt: Date.now() });
      return cache.name;
    } catch (eB) {
      console.warn('⚠️ Cache niedostępny – lecimy bez cache.', eB?.message || eB);
      return null;
    }
  }
}

/* Składanie wejścia do modelu — okno + wspólna + snapshot + obrazy */
function toWindowedContents(sk, channelId, myNick, {
  channelSnapshot = '',
  extraImageParts = [],
} = {}) {
  const priv = getUserHist(sk).slice(-6).map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));

  const shared = getSharedHist(channelId).slice(-5);
  const sharedBlock = shared.length
    ? [{
        role: 'user',
        parts: [{ text: `Kontekst pamięci kanału (ostatnie wypowiedzi):\n${
          shared.map(t => `[@${t.speaker}]: ${t.text}`).join('\n')
        }\nNie myl mówców; mój nick: ${myNick}.` }]
      }]
    : [];

  const header = [{
    role: 'user',
    parts: [{ text: `Aktualny rozmówca: ${myNick}. Odpowiadaj zwięźle.` }]
  }];

  const channelBlock = channelSnapshot
    ? [{ role: 'user', parts: [{ text: `Kontekst z historii kanału:\n${channelSnapshot}` }] }]
    : [];

  const mediaBlock = extraImageParts.length
    ? [{ role: 'user', parts: [{ text: 'Dodatkowe obrazy:' }, ...extraImageParts] }]
    : [];

  return [...header, ...priv, ...sharedBlock, ...channelBlock, ...mediaBlock];
}

/* =========================
   Auto-rejestracja + nick
   ========================= */
const commands = [
  new SlashCommandBuilder()
    .setName('gemini')
    .setDescription('Porozmawiaj z Gemini')
    .addStringOption(o =>
      o.setName('prompt')
        .setDescription('Twoja wiadomość do Gemini')
        .setRequired(true)
    )
    .addBooleanOption(o =>
      o.setName('ephemeral')
        .setDescription('Pokaż odpowiedź tylko Tobie (domyślnie: nie)')
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('gemini-reset')
    .setDescription('Wyczyść twój kontekst w tym kanale')
    .toJSON()
];
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

async function setBotNicknameInGuild(guild) {
  try {
    await guild.members.fetchMe();
    await guild.members.me.setNickname('Ricky');
    console.log(`📝 Ustawiono nick "Ricky" w ${guild.name} (${guild.id})`);
  } catch (e) {
    console.warn(`⚠️ Nie udało się ustawić nicku w ${guild.name} (${guild.id}):`, e?.message || e);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Zalogowano jako ${c.user.tag}`);
  try {
    await c.application?.fetch();
    const appId = c.application.id;
    for (const [, guild] of c.guilds.cache) {
      try {
        await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: commands });
        console.log(`✅ Komendy zarejestrowane w ${guild.name} (${guild.id})`);
      } catch (e) {
        console.error(`❌ Rejestracja komend w ${guild?.name || guild?.id}:`, e);
      }
      await setBotNicknameInGuild(guild);
    }
  } catch (e) {
    console.error('❌ Nie udało się pobrać aplikacji / zarejestrować komend:', e);
  }
});

client.on('guildCreate', async (guild) => {
  try {
    await client.application?.fetch();
    await rest.put(Routes.applicationGuildCommands(client.application.id, guild.id), { body: commands });
    console.log(`✨ Komendy dodane po zaproszeniu: ${guild.name} (${guild.id})`);
  } catch (e) {
    console.error('❌ Rejestracja komend po join:', e);
  }
  await setBotNicknameInGuild(guild);
});

/* =========================
   Przełącznik: reagowanie na boty/aplikacje/webhooki (niesystemowe)
   ========================= */
const REACT_TO_NONUSER = flag('REACT_TO_NONUSER_MESSAGES', false);

/* =========================
   Obsługa komend
   ========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const sk = `${interaction.channelId}:${interaction.user.id}`;
  const channelId = interaction.channelId;

  if (interaction.commandName === 'gemini-reset') {
    userMemory.delete(sk);
    sessionSummary.delete(sk);
    sessionCache.delete(sk);
    await interaction.reply({ content: '🧹 Twój kontekst w tym kanale wyczyszczony.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'gemini') {
    const userPrompt = interaction.options.getString('prompt', true);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
    await interaction.deferReply({ ephemeral });

    try {
      const nick = userNickFromInteraction(interaction);

      pushUserTurn(sk, 'user', userPrompt);
      pushSharedTurn(channelId, nick, userPrompt);

      const channelCtx = await buildChannelContext(interaction.channel, { includeBots: true, includeWebhooks: true });
      const recentImages = await collectRecentImagesFromChannel(interaction.channel);

      await summarizeIfNeeded(sk, channelId);
      const cacheName = await ensureSessionCache(sk);

      const contents = toWindowedContents(sk, channelId, nick, {
        channelSnapshot: channelCtx,
        extraImageParts: recentImages
      });

      const tools = buildToolsFromEnv();
      const genCfg = {
        ...(cacheName ? { cachedContent: cacheName } : {}),
        ...(tools.length ? { tools } : {}),
        systemInstruction: PERSONA,
        system_instruction: PERSONA,
      };

      const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';

      if (useStream) {
        const stream = await gemini.call(
          (c) => c.models.generateContentStream({ model: MODEL, contents, config: genCfg }),
          'generateContentStream'
        );
        let accum = '';
        let lastEdit = Date.now();

        for await (const chunk of stream) {
          accum += (chunk.text ?? '');
          if (Date.now() - lastEdit > 600) {
            await interaction.editReply(accum.slice(0, 1900) || '⏳ …');
            lastEdit = Date.now();
          }
        }
        if (!accum) accum = '***ricky śpi najebany***';

        pushUserTurn(sk, 'model', accum);
        pushSharedTurn(channelId, 'Ricky', accum);

        const chunks = chunkForDiscord(accum);
        if (chunks.length === 1) await interaction.editReply(chunks[0]);
        else {
          await interaction.editReply(chunks[0] + '\n\n*(odpowiedź była długa — wysyłam resztę w kolejnych wiadomościach)*');
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], ephemeral });
          }
        }
      } else {
        const res = await gemini.call(
          (c) => c.models.generateContent({ model: MODEL, contents, config: genCfg }),
          'generateContent'
        );
        const answer = res.text ?? '(brak treści)';

        pushUserTurn(sk, 'model', answer);
        pushSharedTurn(channelId, 'Ricky', answer);

        const chunks = chunkForDiscord(answer);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral });
        }
      }
    } catch (err) {
      console.error(err);
      await interaction.editReply(`❌ Błąd: ${String(err.message || err)}`);
    }
  }
});

/* =========================
   Wiadomości (prefiksy/@wzmianka) z opcją reagowania na nie-userów
   ========================= */
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (!client.user) return;

    // Klasyfikacja: systemowe vs zwykłe
    const isFromBot   = Boolean(msg.author?.bot);
    const isWebhook   = Boolean(msg.webhookId);
    const isFromApp   = Boolean(msg.applicationId || msg.interaction?.applicationId);
    const isSystemish = ![MessageType.Default, MessageType.Reply].includes(msg.type);
    if (isSystemish) return; // NIGDY nie reagujemy na systemowe

    // Gdy flaga OFF (domyślnie) — ignoruj boty/aplikacje/webhooki jako trigger
    if (!REACT_TO_NONUSER && (isFromBot || isWebhook || isFromApp)) return;

    const raw = (msg.content || '').trim();
    if (!raw && msg.attachments.size === 0) return;

    // Wymagaj prefiksu/@wzmianki poza DM
    const mention = new RegExp(`^<@!?${client.user.id}>`);
    const startsWithMention = mention.test(raw);
    const lower = raw.toLowerCase();
    const matchedPrefix = PREFIXES.find(p => lower.startsWith(p));
    const isDM = (msg.channel?.type === 1);
    if (!isDM && !startsWithMention && !matchedPrefix) return;

    let prompt = raw || '';
    if (matchedPrefix) prompt = raw.slice(matchedPrefix.length);
    else if (startsWithMention) prompt = raw.replace(mention, '');
    prompt = prompt.replace(/^[:\-–—,.\s]+/, '').trim();

    await msg.channel.sendTyping();

    const sk = `${msg.channelId}:${msg.author.id}`;
    const channelId = msg.channelId;
    const nick = userNickFromMessage(msg);

    const { mediaParts, mediaNote } = await collectImagePartsFromMessage(msg);

    const promptWithNote = mediaNote ? `${prompt}\n\n${mediaNote}` : prompt;
    pushUserTurn(sk, 'user', promptWithNote);
    pushSharedTurn(channelId, nick, promptWithNote);

    const channelCtx = await buildChannelContext(msg.channel, {
      includeBots: true,
      includeWebhooks: true,
      excludeIds: new Set([msg.id]),
    });

    const recentImages = await collectRecentImagesFromChannel(msg.channel);

    await summarizeIfNeeded(sk, channelId);
    const cacheName = await ensureSessionCache(sk);

    const contents = toWindowedContents(sk, channelId, nick, {
      channelSnapshot: channelCtx,
      extraImageParts: [...mediaParts, ...recentImages],
    });

    const tools = buildToolsFromEnv();
    const genCfg = {
      ...(cacheName ? { cachedContent: cacheName } : {}),
      ...(tools.length ? { tools } : {}),
      systemInstruction: PERSONA,
      system_instruction: PERSONA,
    };

    const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';
    if (useStream) {
      const stream = await gemini.call(
        (c) => c.models.generateContentStream({ model: MODEL, contents, config: genCfg }),
        'generateContentStream'
      );
      let accum = '';
      let lastEdit = Date.now();
      const replyMsg = await msg.reply('⏳ …');

      for await (const chunk of stream) {
        accum += (chunk.text ?? '');
        if (Date.now() - lastEdit > 900) {
          await replyMsg.edit(accum.slice(0, 2000));
          lastEdit = Date.now();
        }
      }
	 if (!accum) accum = '***ricky śpi najebany***';

      pushUserTurn(sk, 'model', accum);
      pushSharedTurn(channelId, 'Ricky', accum);

      if (accum.length <= 2000) {
        await replyMsg.edit(accum);
      } else {
        await replyMsg.edit(accum.slice(0, 2000));
        const chunks = chunkForDiscord(accum).slice(1);
        for (const ch of chunks) await msg.channel.send({ content: ch });
      }
    } else {
      const res = await gemini.call(
        (c) => c.models.generateContent({ model: MODEL, contents, config: genCfg }),
        'generateContent'
      );
      const answer = res.text ?? '(brak treści)';

      pushUserTurn(sk, 'model', answer);
      pushSharedTurn(channelId, 'Ricky', answer);

      const chunks = chunkForDiscord(answer);
      await msg.reply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await msg.channel.send({ content: chunks[i] });
      }
    }
  } catch (e) {
    console.error(e);
    try { await msg.reply('❌ Błąd: ' + (e.message || e)); } catch {}
  }
});

/* =========================
   Start
   ========================= */
client.login(DISCORD_TOKEN);
