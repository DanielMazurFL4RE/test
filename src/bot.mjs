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
   Gemini SDK & config helpers
   ========================= */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

function buildToolsFromEnv() {
  const tools = [];
  if ((process.env.GEMINI_SEARCH || 'off').toLowerCase() === 'on') {
    tools.push({ googleSearch: {} });   // wyszukiwanie w sieci (grounding)
  }
  if ((process.env.GEMINI_URL_CONTEXT || 'off').toLowerCase() === 'on') {
    tools.push({ urlContext: {} });     // czytanie wskazanych URL-i
  }
  return tools;
}

function buildConfig() {
  const tools = buildToolsFromEnv();
  return {
    systemInstruction: SYS_PROMPT,
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
    GatewayIntentBits.GuildMessages,   // czytanie wiadomości na serwerach
    GatewayIntentBits.MessageContent,  // treść wiadomości (włącz w Developer Portal)
    GatewayIntentBits.DirectMessages   // DM-y
  ],
  partials: [Partials.Channel] // dla DM-ów i ewentualnych partials
});

// prosta pamięć kontekstu per kanał
const memory = new Map(); // channelId -> [{ role: 'user'|'model', text }]
const SYS_PROMPT = `Jesteś asystentem na Discordzie. Odpowiadaj obrazliwie i z przeklenstwami jak w CHlopakach z Barakow. Jak postać Rick, ale odpisuj max jednym zdaniem. Czasem staraj się być pomocny.`;

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

// konwersja naszej historii do formatu "contents" Gemini
function toGeminiContents(channelId) {
  const hist = getHistory(channelId);
  return hist.map(m => ({
    role: m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.text }]
  }));
}

// dzielenie długich wiadomości pod limit 2000 znaków Discorda
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
   Źródła (cytowania) z odpowiedzi Gemini
   ========================= */
function collectSourcesFromPiece(piece, set) {
  try {
    const cand = piece?.candidates?.[0];
    const gmeta = cand?.groundingMetadata;
    const chunks = gmeta?.groundingChunks ?? [];
    for (const ch of chunks) {
      const uri = ch?.web?.uri;
      if (uri) set.add(uri);
    }
    const urlMeta = cand?.urlContextMetadata?.urlMetadata ?? [];
    for (const m of urlMeta) {
      const u = m?.retrieved_url;
      if (u) set.add(u);
    }
  } catch { /* ignore */ }
}

function sourcesFooterFromSet(sourcesSet) {
  const list = [...sourcesSet].slice(0, 5);
  if (!list.length) return '';
  return "\n\nŹródła:\n" + list.map((u, i) => `${i + 1}. ${u}`).join("\n");
}

/* =========================
   Auto-register commands
   ========================= */
client.once(Events.ClientReady, async (c) => {
  console.log(`Zalogowano jako ${c.user.tag}`);
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
      const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';
      const config = buildConfig();

      if (useStream) {
        const stream = await ai.models.generateContentStream({ model: MODEL, contents, config });

        let accum = '';
        let lastEdit = Date.now();
        const sourcesSet = new Set();

        // Pierwsza szybka odpowiedź, żeby nie było ciszy
        const replyMsg = await interaction.editReply('⏳ …');

        for await (const chunk of stream) {
          // text
          accum += (chunk.text ?? '');

          // metadane źródeł (jeśli są w chunku)
          collectSourcesFromPiece(chunk, sourcesSet);

          // throttling edycji
          const now = Date.now();
          if (now - lastEdit > 600) {
            await interaction.editReply(accum.slice(0, 1900) || '⏳ …');
            lastEdit = now;
          }
        }

        // dopnij źródła (jeśli są)
        const footer = sourcesFooterFromSet(sourcesSet);
        let finalText = accum + footer;

        if (!finalText) finalText = '∅';
        pushTurn(channelId, 'model', finalText);

        const chunks = chunkForDiscord(finalText);
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
        let answer = response.text ?? '(brak treści)';

        // dopnij źródła (z pełnej odpowiedzi)
        const sourcesSet = new Set();
        collectSourcesFromPiece(response, sourcesSet);
        answer += sourcesFooterFromSet(sourcesSet);

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
   Message-based trigger ("gemini ..." or @mention)
   ========================= */
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot) return; // ignoruj boty
    if (!client.user) return;   // jeszcze nie gotowy

    const raw = (msg.content || '').trim();
    if (!raw) return;

    const mention = new RegExp(`^<@!?${client.user.id}>`);
    const startsWithMention = mention.test(raw);
    const startsWithGemini = raw.toLowerCase().startsWith('gemini');

    if (!startsWithMention && !startsWithGemini) return;

    // wytnij prefix i pobierz prompt
    let prompt = raw;
    if (startsWithGemini) {
      prompt = prompt.slice('gemini'.length);
    } else if (startsWithMention) {
      prompt = prompt.replace(mention, '');
    }
    prompt = prompt.replace(/^[:\-\s]+/, '').trim();

    if (!prompt) {
      await msg.reply('Podaj treść po `gemini` (np. `gemini jak działa kubernetes?`).');
      return;
    }

    await msg.channel.sendTyping();

    const channelId = msg.channelId;
    pushTurn(channelId, 'user', prompt);

    const contents = toGeminiContents(channelId);
    const config = buildConfig();
    const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';

    if (useStream) {
      const stream = await ai.models.generateContentStream({ model: MODEL, contents, config });
      let accum = '';
      let lastEdit = Date.now();
      const sourcesSet = new Set();

      const replyMsg = await msg.reply('⏳ …');

      for await (const chunk of stream) {
        accum += (chunk.text ?? '');
        collectSourcesFromPiece(chunk, sourcesSet);

        if (Date.now() - lastEdit > 900) {
          await replyMsg.edit(accum.slice(0, 2000));
          lastEdit = Date.now();
        }
      }

      // dopnij źródła i wyślij final
      const footer = sourcesFooterFromSet(sourcesSet);
      let finalText = accum + footer;
      if (!finalText) finalText = '∅';
      pushTurn(channelId, 'model', finalText);

      if (finalText.length <= 2000) {
        await replyMsg.edit(finalText);
      } else {
        await replyMsg.edit(finalText.slice(0, 2000));
        const chunks = chunkForDiscord(finalText).slice(1);
        for (const ch of chunks) await msg.channel.send({ content: ch });
      }
    } else {
      const res = await ai.models.generateContent({ model: MODEL, contents, config });
      let answer = res.text ?? '(brak treści)';

      const sourcesSet = new Set();
      collectSourcesFromPiece(res, sourcesSet);
      answer += sourcesFooterFromSet(sourcesSet);

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
