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
   Prefiksy i utilsy
   ========================= */
// reaguj na te prefiksy (case-insensitive)
const PREFIXES = ['gemini', 'ricky', 'rick'];

/* =========================
   Preflight ENV checks
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
   Helpers (flagi, nicki)
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
   Gemini SDK & config
   ========================= */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function buildToolsFromEnv() {
  const tools = [];
  if (flag('GEMINI_SEARCH')) tools.push({ googleSearch: {} }); // włącz wyszukiwarkę
  if (flag('GEMINI_URL_CONTEXT')) tools.push({ urlContext: {} }); // czytanie URL-i
  return tools;
}

const SYS_PROMPT = `Jesteś asystentem na Discordzie. Odpowiadaj obrazliwie i z przeklenstwami jak w CHlopakach z Barakow. Jak postać Rick, ale odpisuj max jednym zdaniem. Czasem staraj się być pomocny. Nie myl nickow (imion) rozmowcow, pamietaj kontekst rozmowcy`
function buildConfig(userNick) {
  const tools = buildToolsFromEnv();
  const systemInstruction = `${SYS_PROMPT}\nRozmawiasz teraz z : ${userNick}`;
  return {
    systemInstruction,
    temperature: 0.5,
    ...(tools.length ? { tools } : {})
  };
}

/* =========================
   Slash commands (auto-register)
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
    .setDescription('Wyczyść kontekst rozmowy w tym kanale')
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

/* =========================
   Discord client
   ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,   // czytanie wiadomości
    GatewayIntentBits.MessageContent,  // treść wiadomości (włącz w Developer Portal)
    GatewayIntentBits.DirectMessages   // DM-y
  ],
  partials: [Partials.Channel]
});

// prosta pamięć kontekstu per kanał
const memory = new Map(); // channelId -> [{ role: 'user'|'model', text }]
function getHistory(channelId) {
  if (!memory.has(channelId)) memory.set(channelId, []);
  return memory.get(channelId);
}
function pushTurn(channelId, role, text, maxTurns = 12) {
  const hist = getHistory(channelId);
  hist.push({ role, text });
  const tail = hist.slice(-maxTurns);
  memory.set(channelId, tail);
}
function toGeminiContents(channelId) {
  const hist = getHistory(channelId);
  return hist.map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));
}
function chunkForDiscord(text, limit = 2000) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + limit));
    i += limit;
  }
  return chunks;
}

/* =========================
   Auto-register + ustawianie nicku "Ricky"
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
  console.log(`[cfg] model=${MODEL} search=${flag('GEMINI_SEARCH')} urlContext=${flag('GEMINI_URL_CONTEXT')}`);

  try {
    await c.application?.fetch();
    const appId = c.application.id;

    for (const [, guild] of c.guilds.cache) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(appId, guild.id),
          { body: commands }
        );
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
    await rest.put(
      Routes.applicationGuildCommands(client.application.id, guild.id),
      { body: commands }
    );
    console.log(`✨ Komendy dodane po zaproszeniu: ${guild.name} (${guild.id})`);
  } catch (e) {
    console.error('❌ Rejestracja komend po join:', e);
  }
  await setBotNicknameInGuild(guild);
});

/* =========================
   Slash commands handling
   ========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const channelId = interaction.channelId;

  if (interaction.commandName === 'gemini-reset') {
    memory.delete(channelId);
    await interaction.reply({ content: '🧹 Kontekst w tym kanale wyczyszczony.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'gemini') {
    const userPrompt = interaction.options.getString('prompt', true);
    const ephemeral = interaction.options.getBoolean('ephemeral') ?? false;
    await interaction.deferReply({ ephemeral });

    try {
      pushTurn(channelId, 'user', userPrompt);

      const contents = toGeminiContents(channelId);
      const userNick = userNickFromInteraction(interaction);
      const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';
      const config = buildConfig(userNick);

      if (useStream) {
        const stream = await ai.models.generateContentStream({ model: MODEL, contents, config });

        let accum = '';
        let lastEdit = Date.now();

        for await (const chunk of stream) {
          accum += (chunk.text ?? '');
          const now = Date.now();
          if (now - lastEdit > 600) {
            await interaction.editReply(accum.slice(0, 1900) || '⏳ …');
            lastEdit = now;
          }
        }

        if (!accum) accum = '∅';
        pushTurn(channelId, 'model', accum);

        const chunks = chunkForDiscord(accum);
        if (chunks.length === 1) {
          await interaction.editReply(chunks[0]);
        } else {
          await interaction.editReply(chunks[0] + '\n\n*(odpowiedź była długa — wysyłam resztę w kolejnych wiadomościach)*');
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], ephemeral });
          }
        }
      } else {
        const response = await ai.models.generateContent({ model: MODEL, contents, config });
        const answer = response.text ?? '(brak treści)';
        pushTurn(channelId, 'model', answer);

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
   Message-based trigger (prefiksy + @mention)
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

    // wytnij znaleziony prefiks albo wzmiankę i przygotuj prompt
    let prompt = raw;
    if (matchedPrefix) {
      prompt = raw.slice(matchedPrefix.length);
    } else if (startsWithMention) {
      prompt = raw.replace(mention, '');
    }
    // usuń interpunkcję/spacje po prefiksie/zmianie
    prompt = prompt.replace(/^[:\-–—,.\s]+/, '').trim();

    if (!prompt) {
      await msg.reply('Podaj treść po prefiksie (gemini/ricky/rick) lub po wzmiance, np. `ricky co to jest vector DB?`');
      return;
    }

    await msg.channel.sendTyping();

    const channelId = msg.channelId;
    pushTurn(channelId, 'user', prompt);

    const contents = toGeminiContents(channelId);
    const userNick = userNickFromMessage(msg);
    const config = buildConfig(userNick);
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
      pushTurn(channelId, 'model', accum);

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
      pushTurn(channelId, 'model', answer);

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
