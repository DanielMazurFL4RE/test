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

// === Preflight ENV checks (czytelne błędy zamiast TokenInvalid) ===
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

// === Model i SDK Gemini ===
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// === Definicje slash-commands (rejestrowane automatycznie) ===
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

// === Klient Discord ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// prosta pamięć kontekstu per kanał
const memory = new Map(); // channelId -> [{ role: 'user'|'model', text }]
const SYS_PROMPT = `Jesteś wrednym asystentem na Discordzie. Odpowiadaj zwięźle i jasno w stylu serialu Chłopaki z Baraków.`;

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

// === Auto-rejestracja komend po starcie (dla wszystkich gildii, w których bot już jest) ===
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

// === Auto-rejestracja komend przy dołączeniu do nowej gildii ===
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

// === Obsługa komend ===
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

    // ephemeral trzeba ustawić już przy deferReply
    await interaction.deferReply({ ephemeral });

    try {
      pushTurn(channelId, 'user', userPrompt);

      const contents = toGeminiContents(channelId);
      const useStream = String(process.env.GEMINI_STREAM || 'true').toLowerCase() === 'true';

      // konfiguracja: system instruction + temperatura
      const config = {
        systemInstruction: SYS_PROMPT,
        temperature: 0.5
      };

      if (useStream) {
        const response = await ai.models.generateContentStream({
          model: MODEL,
          contents,
          config
        });

        let accum = '';
        let lastEdit = Date.now();

        for await (const chunk of response) {
          accum += (chunk.text ?? '');
          const now = Date.now();
          if (now - lastEdit > 600) {
            const toShow = accum.slice(0, 1900);
            await interaction.editReply(toShow || '⏳ …');
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
        const response = await ai.models.generateContent({
          model: MODEL,
          contents,
          config
        });

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

// === Start ===
client.login(DISCORD_TOKEN);
