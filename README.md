<div align="center">
  <img src="https://files.catbox.moe/7euvhs.jpg" alt="NOX FREE MINI BOT" width="180">

  # NOX FREE MINI BOT

  [![Version](https://img.shields.io/badge/Version-1.0.0-green?style=for-the-badge)](https://github.com/NoxCoreDev/NOXFREEMINIBOT)
  [![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)
  [![Node.js](https://img.shields.io/badge/Node.js-24.x-green?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-brightgreen?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/atlas)
  [![Baileys](https://img.shields.io/badge/WhatsApp-Baileys-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
  [![Render](https://img.shields.io/badge/Render-Node%20guide-46E3B7?style=for-the-badge&logo=render&logoColor=white)](https://render.com/docs/deploy-node-express-app)
  [![Railway](https://img.shields.io/badge/Railway-Node%20guide-0B0D0E?style=for-the-badge&logo=railway&logoColor=white)](https://docs.railway.com/quick-start)
  [![Koyeb](https://img.shields.io/badge/Koyeb-Node%20guide-121212?style=for-the-badge)](https://www.koyeb.com/docs/deploy/express)
  [![Fork this repository](https://img.shields.io/badge/Fork_this_repository-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/NoxCoreDev/NOXFREEMINIBOT/fork)

  <p><strong>An open-source WhatsApp multi-device bot built with Node.js and Baileys, featuring pairing-code setup, MongoDB-backed sessions, a web pairing page, and a modular plugin system for messaging, media, and group tools. Created by @NoxCoreDev.</strong></p>
</div>

## About

NOX FREE MINI BOT is a multi-device WhatsApp bot built with [Baileys](https://github.com/WhiskeySockets/Baileys). The project includes a web pairing page, an Express HTTP server, and MongoDB storage for sessions and related data.

### Main features

- Pair a WhatsApp account with a code from the bot's web page.
- Restore sessions stored in MongoDB after a restart.
- Information and status commands, including `menu`, `ping`, `alive`, and `info`.
- Media tools and downloads, stickers, profile information, and utilities.
- Group and moderation tools, including anti-link, anti-delete, and administrative actions.
- Customize the bot name, message footer, and selected messages.

> Available commands can change with the repository's plugins. Send `menu` to the bot to see the current command list.

## Quick links

| Resource | Link |
| --- | --- |
| Source code | [GitHub — NOXFREEMINIBOT](https://github.com/NoxCoreDev/NOXFREEMINIBOT) |
| Fork this repository | [Create your own fork](https://github.com/NoxCoreDev/NOXFREEMINIBOT/fork) |
| WhatsApp library | [Baileys — WhiskeySockets](https://github.com/WhiskeySockets/Baileys) |
| Node.js 24.x | [Node.js downloads](https://nodejs.org/) |
| Database | [MongoDB Atlas](https://www.mongodb.com/atlas) |
| Render deployment guide | [Deploy a Node/Express app](https://render.com/docs/deploy-node-express-app) |
| Railway deployment guide | [Deploy from GitHub](https://docs.railway.com/quick-start) |
| Koyeb deployment guide | [Deploy an Express app](https://www.koyeb.com/docs/deploy/express) |
| MongoDB connection guide | [Connect to an Atlas cluster](https://www.mongodb.com/docs/atlas/connect-to-database-deployment/) |

## Requirements

- **Node.js 24.x** and npm, as declared in `package.json`.
- A MongoDB database reachable from the host. MongoDB Atlas is one option; database plans and quotas are separate from hosting.
- A Linux server or Node.js hosting service that can run `npm start`, provide a `PORT` environment variable, and keep a long-running process alive.
- Outbound network access to WhatsApp and MongoDB.
- A WhatsApp account whose owner is authorized to pair it with the bot.

The application serves its pairing page at `/` and its health response at `/ping`. It listens on `process.env.PORT`, falling back to port `8000` when `PORT` is not set.

## Local installation

```bash
git clone https://github.com/NoxCoreDev/NOXFREEMINIBOT.git
cd NOXFREEMINIBOT
npm install
cp .env.example .env
```

Edit `.env` locally and set at least `MONGODB_URI`. Never put a real database URI in this README, an issue, or a log, and never commit your local `.env` file.

```env
MONGODB_URI=
BOT_NAME="NOX FREE MINI BOT"
OWNER_NAME="NOX"
```

Start the server:

```bash
npm start
```

## Environment variables

Set values in a local `.env` file or in your hosting provider's environment-variable/secret settings. **Do not publish private values.**

| Variable | Required? | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | Yes | MongoDB connection URI. The application refuses to start when this value is missing or blank. |
| `BOT_NAME` | No | Name shown by the bot and pairing page. Default: `NOX FREE MINI BOT`. |
| `OWNER_NAME` | No | Owner label shown in bot information. Default: `NOX`. |
| `OWNER_NUMBER` | No, recommended | Owner's WhatsApp number in international format, used by owner-only features. Set the intended value in the host's secret settings; do not publish a personal number. |
| `WORK_TYPE` | No | Operating mode: `public`, `private`, `group`, or `inbox`. Default: `public`. |
| `GROUP_INVITE_CODE` | No | Used by the automatic group-join feature. The source currently contains a fallback invite value: review or replace it privately before deployment. Never publish the invite code. |
| `BOT_FOOTER` | No | Footer text used in bot messages. |
| `AUTO_STATUS_MSG` | No | Text used for automatic status handling. |
| `REJECT_MSG` | No | Reply used when the anti-call setting rejects a call. |
| `ALIVE_IMG` | No | Image URL used by the status command. |
| `LIVE_MSG` | No | Status text shown by the bot. |
| `MENU_IMAGE_URL` | No | Image URL used by the menu. |
| `DESCRIPTION` | No | Short description shown in the menu. |
| `REPO_URL` | No | Link shown by the `repo` command. The current source default points to this repository; change it only if you want another link. |
| `PORT` | Usually provided by the host | HTTP listening port. Local fallback: `8000`. |
| `NODE_ENV` | No | Set to `production` on a hosted service to use the production logging level. |

The command prefix is currently hard-coded as `.` (for example, `.menu`). The runtime does not read a `PREFIX` environment variable.

## Deployment options

This is a standard Node.js application: use a host that supports **Node.js 24.x**, installs the dependencies from `package.json`, runs `npm start`, supplies `PORT`, and allows the process to remain active. Select a **native Node.js/buildpack** option where available. This repository currently has **no `Dockerfile`**; do not select Docker/container deployment unless you add and maintain a Dockerfile separately. The provider-specific `app.json` file is not required for the deployment options below.

### Linux VPS or your own server

This is the most direct option when you have a Linux VM or an always-on server. Install Node.js 24.x, clone the repository, follow the local installation steps, and keep `.env` private. To keep the bot running after closing your terminal or after a reboot, use a process manager such as PM2:

```bash
npm install --global pm2
pm2 start index.js --name nox-free-mini-bot
pm2 startup
```

Run the startup command printed by PM2, then save the process list:

```bash
pm2 save
```

A `systemd` service is another option. Protect the environment file (for example, `chmod 600 .env`), use a dedicated non-root account, and monitor the process and logs. Uptime and cost depend on your server, network, and provider; a VPS is not automatically free.

### Render

Create a **Web Service** from the GitHub repository. Use `npm install` as the build command and `npm start` as the start command. Set `MONGODB_URI` and any other required values in the service's secret environment settings. See the [Render Node/Express guide](https://render.com/docs/deploy-node-express-app).

**Free-tier limitation:** Render says Free Web Services spin down after 15 minutes without inbound traffic, including existing WebSocket messages. The bot needs a persistent WhatsApp connection, so a free instance may sleep or disconnect and should not be treated as a reliable 24/7 bot host. Render also states that Free instances have other limitations and are intended for testing or hobby projects; check the [current Free plan terms](https://render.com/docs/free).

### Railway

Create a project from the GitHub repository, use the Node.js build process, and set the start command to `npm start`. Add `MONGODB_URI` and other private settings in the service's variables/secrets. See the [Railway Quick Start](https://docs.railway.com/quick-start).

**Free-tier limitation:** Railway currently lists a 30-day trial with `$5` in credits, followed by `$1` per month in included usage; the Free plan lists up to `0.5 GB` of RAM per service after the trial. This is a limited usage allowance, not unlimited free hosting or a promise of 24/7 uptime. Review [current Railway pricing](https://railway.com/pricing) and monitor usage.

### Koyeb

Create a **Web Service** from the GitHub repository and select the native Node.js buildpack rather than Docker. Use `npm start` and configure the required environment variables. The project has an HTTP server, so use a Web Service configuration. See Koyeb's [Express deployment guide](https://www.koyeb.com/docs/deploy/express).

**Free-tier limitation:** Koyeb documents one Free Instance with `512 MB` RAM and `0.1 vCPU`; it is for Web Services only, cannot be used as a Worker Service, and scales to zero after one hour without traffic. Because this bot needs a persistent WhatsApp connection, that free instance is not suitable for dependable 24/7 operation. Check [Koyeb's current instance terms](https://www.koyeb.com/docs/reference/instances).

### Other Node.js hosts

The same app can be deployed to another Node.js host if it supports Node.js 24.x, `npm install`, `npm start`, runtime environment variables, an externally reachable HTTP port, outbound connections to WhatsApp/MongoDB, and a long-running process. Use the provider's native Node.js runtime; a serverless function or an instance that routinely sleeps may disconnect the bot.

Free plans, included credits, resource limits, and uptime policies change. **Do not assume this bot will be free or continuously available on every host.** The provider notes above were checked against their linked official documentation on **October 12, 2026**; confirm current terms before deploying.

## Pair WhatsApp

1. Open the public URL of your deployed service in a browser.
2. Enter the WhatsApp number using the international format requested by the page, then start pairing.
3. On the phone, open WhatsApp → **Linked devices** → **Link a device** → choose the option to link with a phone number.
4. Enter the pairing code displayed by the page.
5. After connecting, send `.menu` to the bot to see the available commands.

A pairing code and session provide access to the associated WhatsApp account. Do not share or publish them.

## Health checks and troubleshooting

- Check the service at `https://<YOUR-SERVICE-URL>/ping`.
- If the server does not start, confirm `MONGODB_URI` is set and the database allows connections from the host.
- If the page opens but no pairing code is generated, check the international phone-number format, outbound network access, and deployment logs.
- After a restart, confirm MongoDB is reachable; the bot restores saved sessions from the database.

## Security

- Keep `.env`, `MONGODB_URI`, administrator credentials, pairing codes, and WhatsApp invite codes out of the repository and public screenshots.
- Give the MongoDB account only the permissions it needs and restrict network access where the host allows it.
- Deploy the bot only for a WhatsApp account and number you are authorized to manage.
- Group and moderation features can affect groups where the bot has the necessary permissions. Configure and use them only with the consent of the relevant group administrators.

## Developer links

[![Telegram](https://img.shields.io/badge/Telegram-@noxprimeeeinc-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)](https://t.me/nox_chh)
[![Instagram](https://img.shields.io/badge/Instagram-@noxprimeeeinc-E4405F?style=for-the-badge&logo=instagram&logoColor=white)](https://instagram.com/noxprimeeeinc)
[![Twitter/X](https://img.shields.io/badge/Twitter-@noxprimeeeinc-000000?style=for-the-badge&logo=x&logoColor=white)](https://twitter.com/noxprimeeeinc)
[![YouTube](https://img.shields.io/badge/YouTube-@noxprimeeeinc-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtube.com/@noxprimeeeinc)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Channel-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://whatsapp.com/channel/0029VbDIn9u47Xe6gf8JxP3c)
[![GitHub](https://img.shields.io/badge/GitHub-Nox--Primeee-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/NoxCoreDev)

---

<div align="center">
  <sub>© 2026 NOX PRIMEEE — NOX FREE MINI BOT</sub>
</div>
