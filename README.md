# Gemini Discord Bot (Node.js + discord.js + @google/genai)

Minimalny bot na Discorda z komendami `/gemini` i `/gemini-reset`, streamingiem odpowiedzi i prostą pamięcią kontekstu per kanał.

## Szybki start lokalnie
```bash
cp .env.example .env
# uzupełnij tokeny w .env
npm i
npm run deploy   # rejestracja komend (globalnie lub na GUILD_ID)
npm start
```

## Wymagania
- Node 20+
- Discord bot token + client id
- Klucz Gemini: `GEMINI_API_KEY` (lub `GOOGLE_API_KEY`)

## Modele
W `.env` ustaw `GEMINI_MODEL=gemini-2.5-flash` (szybszy) albo `gemini-2.5-pro` (dokładniejszy).

## Deployment (3 darmowe opcje)
- **Koyeb** (free web service, bez usypiania): użyj dołączonego Dockerfile, dodaj sekrety z `.env`.
- **Northflank** (Developer Sandbox): utwórz Service z Dockerfile, CMD `npm start`, dodaj sekrety.
- **Oracle Cloud Always Free** (VPS 24/7): skopiuj projekt do `/opt/gemini-discord-bot`, użyj `deploy/systemd/gemini-bot.service`:

```bash
sudo useradd -r -s /usr/sbin/nologin bot || true
sudo mkdir -p /opt/gemini-discord-bot
sudo chown -R bot:bot /opt/gemini-discord-bot
sudo cp -r * /opt/gemini-discord-bot/
sudo cp deploy/systemd/gemini-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gemini-bot
journalctl -u gemini-bot -f
```

## Przydatne
- Komendy rejestrujesz skryptem `npm run deploy`.
- Odpowiedzi >2000 znaków są cięte na kawałki i wysyłane w follow-upach.
- `GEMINI_STREAM=true` włącza streaming (domyślnie włączony).

Powodzenia ✨
