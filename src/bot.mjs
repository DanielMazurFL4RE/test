import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

// prosta pamięć kontekstu per kanał
const memory = new Map(); // channelId -> [{ role: 'user'|'model', text }]
const SYS_PROMPT = `Jesteś pomocnym asystentem na Discordzie. Odpowiadaj zwięźle i jasno.`;

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

client.once(Events.ClientReady, (c) => {
  console.log(`Zalogowano jako ${c.user.tag}`);
});

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

client.login(process.env.DISCORD_TOKEN);
