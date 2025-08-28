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
const SYS_PROMPT = `Jesteś asystentem na Discordzie. Odpowiadaj obrazliwie i z przeklenstwami jak w CHlopakach z Barakow. Jak postać Rick, ale odpisuj max jednym zdaniem. Czasem staraj się być pomocny.`

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
    await interaction.reply({ cont
