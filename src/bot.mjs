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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('❌ Brak GEMINI_API_KEY (lub GOOGLE_API_KEY) w zmiennych środowiskowych.');
  process.exit(1);
}

/* =========================
   Flagi & nicki
   ========================= */
function flag(name, def = false) {
  const raw = (process.env[name] ?? '').toString();
  const clean = raw.split('#')[0].replace(/['"]/g, '').trim();
  if (!clean) return def;
  return /^(1|true|t|on|yes|y)$/i.test(clean);
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

/* =========================
   Gemini
   ========================= */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function buildToolsFromEnv() {
  const tools = [];
  if (flag('GEMINI_SEARCH')) tools.push({ googleSearch: {} });
  if (flag('GEMINI_URL_CONTEXT')) tools.push({ urlContext: {} });
  return tools;
}

/* Styl/zasady — możesz dostroić pod siebie */
const SYS_PROMPT = `Jesteś asystentem na Discordzie. Odpowiadaj obrazliwie i z przeklenstwami jak w CHlopakach z Barakow. Jak postać Rick, ale odpisuj max jednym zdaniem. Czasem staraj się być pomocny. Odpowiadaj krótko (1-2 zdania). Nie myl rozmówców: zawsze kojarz wypowiedzi z właściwymi nickami.
Masz dwie warstwy pamięci: prywatną (bieżący użytkownik) i wspólną dla kanału (ostatnie wypowiedzi różnych osób).`;

function buildConfig(userNick, participantsHint) {
  const tools = buildToolsFromEnv();
  const systemInstruction =
    `${SYS_PROMPT}\nAktualny rozmówca: ${userNick}\n` +
    (participantsHint ? `W kanale obecni (ostatnio): ${participantsHint}` : '');
  return {
    systemInstruction,
    temperature: 0.5,
    ...(tools.length ? { tools } : {})
  };
}

/* =========================
   Komendy (auto-register)
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

/* =========================
   Discord client
   ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

/* =========================
   Pamięć: prywatna + wspólna
   ========================= */
const MAX_TURNS_PRIVATE = parseInt(process.env.MEM_TURNS_PRIVATE || '12', 10);
const MAX_TURNS_SHARED  = parseInt(process.env.MEM_TURNS_SHARED  || '10', 10);

// Prywatna per (kanał + user)
const userMemory = new Map(); // `${channelId}:${userId}` -> [{role:'user'|'model', text}]
const skFromInteraction = (i) => `${i.channelId}:${i.user.id}`;
const skFromMessage     = (m) => `${m.channelId}:${m.author.id}`;
function getUserHist(sk) {
  if (!userMemory.has(sk)) userMemory.set(sk, []);
  return userMemory.get(sk);
}
function pushUserTurn(sk, role, text) {
  const h = getUserHist(sk);
  h.push({ role, text });
  userMemory.set(sk, h.slice(-MAX_TURNS_PRIVATE));
}

// Wspólna per kanał – z metadanymi mówcy
const sharedMemory = new Map(); // channelId -> [{speaker, text}]
function getSharedHist(channelId) {
  if (!sharedMemory.has(channelId)) sharedMemory.set(channelId, []);
  return sharedMemory.get(channelId);
}
function pushSharedTurn(channelId, speaker, text) {
  const h = getSharedHist(channelId);
  h.push({ speaker, text });
  sharedMemory.set(channelId, h.slice(-MAX_TURNS_SHARED));
}

// Zbuduj treść dla Gemini: prywatna rozmowa + zwięzły kontekst kanału
function toGeminiContents(sk, channelId, myNick) {
  const priv = getUserHist(sk);
  const shared = getSharedHist(channelId);

  const contents = priv.map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));

  if (shared.length) {
    const ctxLines = shared
      .map(t => `[@${t.speaker}]: ${t.text}`)
      .join('\n')
      .slice(-3000); // bezpieczne ograniczenie długości
    contents.push({
      role: 'user',
      parts: [{ text: `Kontekst kanału (ostatnie wypowiedzi różnych osób):\n${ctxLines}\nMój nick: ${myNick}. Nie myl mówców.` }]
    });
  }
  return contents;
}

function chunkForDiscord(text, limit = 2000) {
  if ((text || '').length <= limit) return [text || ''];
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

/* =========================
   Auto-rejestracja + nick
   ========================= */
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
   Slash commands
   ========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const sk = skFromInteraction(interaction);
  const channelId = interaction.channelId;

  if (interaction.commandName === 'gemini-reset') {
    userMemory.delete(sk);
    await interaction.reply({ content: '🧹 Twój kontekst w tym kanale wyczyszczony.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'gemini') {
    const userPrompt = interaction.options.getString('prompt', true);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
    await interaction.deferReply({ ephemeral });

    try {
      const nick = userNickFromInteraction(interaction);
      // zapis do obu pamięci
      pushUserTurn(sk, 'user', userPrompt);
      pushSharedTurn(channelId, nick, userPrompt);

      const participantsHint = [...new Set(getSharedHist(channelId).map(t => t.speaker))].join(', ');
      const contents = toGeminiContents(sk, channelId, nick);
      const config = buildConfig(nick, participantsHint);
      const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';

      if (useStream) {
        const stream = await ai.models.generateContentStream({ model: MODEL, contents, config });
        let accum = '';
        let lastEdit = Date.now();

        for await (const chunk of stream) {
          accum += (chunk.text ?? '');
          if (Date.now() - lastEdit > 600) {
            await interaction.editReply(accum.slice(0, 1900) || '⏳ …');
            lastEdit = Date.now();
          }
        }
        if (!accum) accum = '∅';

        // zapisz odpowiedź bota
        pushUserTurn(sk, 'model', accum);
        pushSharedTurn(channelId, 'Ricky', accum); // opcjonalnie: w kanale też widać, co powiedział bot

        const chunks = chunkForDiscord(accum);
        if (chunks.length === 1) await interaction.editReply(chunks[0]);
        else {
          await interaction.editReply(chunks[0] + '\n\n*(odpowiedź była długa — wysyłam resztę w kolejnych wiadomościach)*');
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], ephemeral });
          }
        }
      } else {
        const res = await ai.models.generateContent({ model: MODEL, contents, config });
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
   Wiadomości tekstowe (prefiksy + @mention)
   ========================= */
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return;
    if (!client.user) return;

    const raw = (msg.content || '').trim();
    if (!raw) return;

    const mention = new RegExp(`^<@!?${client.user.id}>`);
    const startsWithMention = mention.test(raw);
    const lower = raw.toLowerCase();
    const matchedPrefix = PREFIXES.find(p => lower.startsWith(p));
    if (!startsWithMention && !matchedPrefix) return;

    let prompt = raw;
    if (matchedPrefix) prompt = raw.slice(matchedPrefix.length);
    else if (startsWithMention) prompt = raw.replace(mention, '');
    prompt = prompt.replace(/^[:\-–—,.\s]+/, '').trim();
    if (!prompt) {
      await msg.reply('Podaj treść po prefiksie (gemini/ricky/rick) lub po wzmiance.');
      return;
    }

    await msg.channel.sendTyping();

    const sk = skFromMessage(msg);
    const channelId = msg.channelId;
    const nick = userNickFromMessage(msg);

    // zapis do obu pamięci
    pushUserTurn(sk, 'user', prompt);
    pushSharedTurn(channelId, nick, prompt);

    const participantsHint = [...new Set(getSharedHist(channelId).map(t => t.speaker))].join(', ');
    const contents = toGeminiContents(sk, channelId, nick);
    const config = buildConfig(nick, participantsHint);
    const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';

    if (useStream) {
      const stream = await ai.models.generateContentStream({ model: MODEL, contents, config });
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
      if (!accum) accum = '∅';

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
      const res = await ai.models.generateContent({ model: MODEL, contents, config });
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
