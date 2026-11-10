const fs = require('fs');
const dotenv = require('dotenv');
const path = require('path');

const envPath = path.join(__dirname, '.env');

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const mongoUri = process.env.MONGODB_URI;

if (!mongoUri || !mongoUri.trim()) {
    throw new Error('MONGODB_URI is required.');
}

const botName = process.env.BOT_NAME || 'SCANTY MD BOT';

module.exports = {
    MONGODB_URI: mongoUri.trim(),

    PREFIX: process.env.PREFIX || '.',

    OWNER_NUMBER: process.env.OWNER_NUMBER || '',

    BOT_NAME: botName,

    BOT_FOOTER: process.env.BOT_FOOTER || 'POWERED BY SCANTY MD BOT',

    OWNER_NAME: process.env.OWNER_NAME || 'SCANTY',

    WORK_TYPE: 'public',

    AUTO_LIKE_EMOJI: [
        '❤️', '🌹', '✨', '🥰', '💖',
        '😍', '💞', '💕', '☺️', '🤗'
    ],

    AUTO_STATUS_MSG:
        process.env.AUTO_STATUS_MSG ||
        `*SEEN YOUR STATUS BY ${botName}* 🤗`,

    GROUP_INVITE_CODE:
        process.env.GROUP_INVITE_CODE || '',

    REJECT_MSG:
        process.env.REJECT_MSG || '*CALL LATER PLEASE*',

    ALIVE_IMG:
        process.env.ALIVE_IMG || 'https://files.catbox.moe/7euvhs.jpg',

    LIVE_MSG:
        process.env.LIVE_MSG || 'I am active and running',

    MENU_IMAGE_URL:
        process.env.MENU_IMAGE_URL || 'https://files.catbox.moe/7euvhs.jpg',

    DESCRIPTION:
        process.env.DESCRIPTION || 'Public Multi-User WhatsApp Bot',

    REPO_URL:
        process.env.REPO_URL || 'https://github.com/g819480-ai/NOXFREEMINIBOT'
};
