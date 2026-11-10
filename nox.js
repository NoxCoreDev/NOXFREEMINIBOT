const {
    default: makeWASocket,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType
} = require('@whiskeysockets/baileys');

const config = require('./config');
const { randomImage } = require('./lib/images');
const { fakevCard } = require('./lib/fakevCard');
const events = require('./nox');

const {
    Session,
    getMongoAuthState,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats
} = require('./lib/database');

const { sms } = require('./lib/msg');
const { handleAntidelete } = require('./lib/antidelete');
const { isSudo } = require('./lib/sudo');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');

const router = express.Router();
const prefix = config.PREFIX || '.';

const activeSockets = new Map();
const pendingSockets = new Map();
const socketCreationTime = new Map();

const pairingRequests = new Map();
const pendingCodes = new Map();

const logger = pino({ level: 'silent' });

/* =========================================================
   LOAD PLUGINS
========================================================= */

const pluginDir = path.join(__dirname, 'plugins');

if (fs.existsSync(pluginDir)) {
    for (const file of fs.readdirSync(pluginDir)) {
        if (!file.endsWith('.js')) continue;

        try {
            require(path.join(pluginDir, file));
            console.log(`✅ SCANTY plugin loaded: ${file}`);
        } catch (error) {
            console.error(
                `❌ Plugin failed: ${file}`,
                error.message
            );
        }
    }
}

/* =========================================================
   HELPERS
========================================================= */

function cleanNumber(number) {
    return String(number || '').replace(/\D/g, '');
}

function createSerial(size = 16) {
    return crypto
        .randomBytes(size)
        .toString('hex')
        .slice(0, size)
        .toUpperCase();
}

function noxLog(message, type = 'info') {
    const icons = {
        info: '📝',
        success: '✅',
        error: '❌',
        warning: '⚠️'
    };

    console.log(
        `${icons[type] || '📝'} [SCANTY MD BOT] ${new Date().toISOString()}: ${message}`
    );
}

function getConnectionStatus(number) {
    const n = cleanNumber(number);

    const started = socketCreationTime.get(n);

    return {
        isConnected: activeSockets.has(n),
        connectionTime: started
            ? new Date(started).toISOString()
            : null,
        uptime: started
            ? Math.floor((Date.now() - started) / 1000)
            : 0
    };
}

function clearPairingState(number) {
    const n = cleanNumber(number);

    pairingRequests.delete(n);
    pendingCodes.delete(n);
    pendingSockets.delete(n);
}

function closeSocketQuietly(socket) {
    try {
        if (socket && typeof socket.end === 'function') {
            socket.end();
        }
    } catch (_) {}
}

/* =========================================================
   MESSAGE STORE
========================================================= */

function createNoxStore() {
    const store = {
        messages: {},

        bind(ev) {
            ev.on('messages.upsert', ({ messages }) => {
                for (const msg of messages || []) {
                    const jid = msg.key?.remoteJid;

                    if (!jid) continue;

                    if (!store.messages[jid]) {
                        store.messages[jid] = [];
                    }

                    store.messages[jid].push(msg);

                    if (store.messages[jid].length > 200) {
                        store.messages[jid].shift();
                    }
                }
            });
        },

        async loadMessage(jid, id) {
            return (
                store.messages[jid]?.find(
                    msg => msg.key?.id === id
                ) || null
            );
        }
    };

    return store;
}

/* =========================================================
   GROUP HELPERS
========================================================= */

function getGroupAdmins(participants = []) {
    return participants
        .filter(participant => participant.admin)
        .map(participant => participant.id);
}

/* =========================================================
   ANTI CALL
========================================================= */

async function setupCallHandlers(socket, number) {
    socket.ev.on('call', async calls => {
        try {
            const userConfig =
                await getUserConfigFromMongoDB(number);

            if (
                String(userConfig.ANTI_CALL) !== 'true'
            ) {
                return;
            }

            for (const call of calls) {
                if (call.status !== 'offer') continue;

                try {
                    await socket.rejectCall(
                        call.id,
                        call.from
                    );
                } catch (_) {}

                try {
                    await socket.sendMessage(
                        call.from,
                        {
                            text:
                                userConfig.REJECT_MSG ||
                                config.REJECT_MSG ||
                                'Calls are not accepted.'
                        }
                    );
                } catch (_) {}
            }
        } catch (error) {
            noxLog(
                `Anti-call error: ${error.message}`,
                'error'
            );
        }
    });
}

/* =========================================================
   PAIRING
========================================================= */

async function noxPair(number, res = null) {
    const n = cleanNumber(number);

    if (!n || n.length < 7 || n.length > 15) {
        if (res && !res.headersSent) {
            return res.status(400).json({
                error: 'Invalid phone number'
            });
        }

        return;
    }

    if (activeSockets.has(n)) {
        const status = getConnectionStatus(n);

        if (res && !res.headersSent) {
            return res.json({
                status: 'already_connected',
                connectionTime: status.connectionTime,
                uptime: status.uptime
            });
        }

        return;
    }

    if (pairingRequests.has(n)) {
        if (res && !res.headersSent) {
            return res.json({
                status: 'connection_in_progress'
            });
        }

        return;
    }

    pairingRequests.set(n, {
        startedAt: Date.now()
    });

    let conn = null;
    let restartAttempts = 0;
    let connectedMessageSent = false;
    let closing = false;

    try {
        const authState =
            await getMongoAuthState(n);

        connectedMessageSent =
            authState.creds.registered === true;

        const noxStore =
            createNoxStore();

        conn = makeWASocket({
            auth: {
                creds: authState.creds,

                keys: makeCacheableSignalKeyStore(
                    authState.keys,
                    logger
                )
            },

            printQRInTerminal: false,

            logger,

            connectTimeoutMs: 60000,

            defaultQueryTimeoutMs: 60000,

            keepAliveIntervalMs: 15000,

            emitOwnEvents: false,

            fireInitQueries: true,

            generateHighQualityLinkPreview: true,

            syncFullHistory: false,

            markOnlineOnConnect: true,

            browser: Browsers.macOS('Safari'),

            getMessage: async key => {
                const msg =
                    await noxStore.loadMessage(
                        key.remoteJid,
                        key.id
                    );

                return msg?.message ||
                    undefined;
            }
        });

        pendingSockets.set(n, conn);

        noxStore.bind(conn.ev);

        await setupCallHandlers(
            conn,
            n
        );

        conn.decodeJid = jid => {
            if (!jid) return jid;

            if (/:\\d+@/gi.test(jid)) {
                const decoded =
                    jidDecode(jid) || {};

                return (
                    decoded.user &&
                    decoded.server &&
                    `${decoded.user}@${decoded.server}`
                ) || jid;
            }

            return jid;
        };

        conn.downloadAndSaveMediaMessage =
            async (
                message,
                filename,
                attachExtension = true
            ) => {
                const quoted =
                    message.msg ||
                    message;

                const mime =
                    (message.msg ||
                        message).mimetype ||
                    '';

                const messageType =
                    message.mtype
                        ? message.mtype
                            .replace(
                                /Message/gi,
                                ''
                            )
                        : mime.split('/')[0];

                const stream =
                    await downloadContentFromMessage(
                        quoted,
                        messageType
                    );

                let buffer =
                    Buffer.alloc(0);

                for await (
                    const chunk of stream
                ) {
                    buffer =
                        Buffer.concat([
                            buffer,
                            chunk
                        ]);
                }

                const {
                    fileTypeFromBuffer
                } = await import(
                    'file-type'
                );

                const type =
                    await fileTypeFromBuffer(
                        buffer
                    );

                if (!type?.ext) {
                    throw new Error(
                        'Unable to determine media file type'
                    );
                }

                const output =
                    attachExtension
                        ? `${filename}.${type.ext}`
                        : filename;

                await fs.writeFile(
                    output,
                    buffer
                );

                return output;
            };

        /* =================================================
           SAVE CREDENTIALS DIRECTLY TO MONGODB
        ================================================= */

        conn.ev.on(
            'creds.update',
            async () => {
                try {
                    await saveSessionToMongoDB(
                        n,
                        authState.creds
                    );
                } catch (error) {
                    noxLog(
                        `Credential save failed for ${n}: ${error.message}`,
                        'error'
                    );
                }
            }
        );

        /* =================================================
           CONNECTION HANDLER
        ================================================= */

        const handleConnectionUpdate =
            async update => {
                const {
                    connection,
                    lastDisconnect
                } = update;

                if (connection === 'open') {
                    activeSockets.set(
                        n,
                        conn
                    );

                    pendingSockets.delete(n);

                    socketCreationTime.set(
                        n,
                        Date.now()
                    );

                    pairingRequests.delete(n);

                    pendingCodes.delete(n);

                    restartAttempts = 0;

                    noxLog(
                        `WhatsApp connected: ${n}`,
                        'success'
                    );

                    await addNumberToMongoDB(
                        n
                    );

                    const userJid =
                        jidNormalizedUser(
                            conn.user.id
                        );

                    if (
                        !connectedMessageSent
                    ) {
                        connectedMessageSent =
                            true;

                        try {
                            await conn.sendMessage(
                                userJid,
                                {
                                    image: {
                                        url:
                                            randomImage()
                                    },

                                    caption:
                                        `*╭── SCANTY MD BOT ──╮*\n` +
                                        `│ WhatsApp connected successfully ✅\n` +
                                        `│ Type ${prefix}menu to see commands\n` +
                                        `│ Prefix: ${prefix}\n` +
                                        `│ Mode: PUBLIC\n` +
                                        `*╰────────────────╯*`
                                },
                                {
                                    quoted:
                                        fakevCard
                                }
                            );
                        } catch (error) {
                            noxLog(
                                `Welcome message error: ${error.message}`,
                                'error'
                            );
                        }

                        const ownerNumber =
                            cleanNumber(
                                config.OWNER_NUMBER
                            );

                        if (
                            ownerNumber &&
                            ownerNumber !== n
                        ) {
                            try {
                                await conn.sendMessage(
                                    `${ownerNumber}@s.whatsapp.net`,
                                    {
                                        text:
                                            `*SCANTY MD BOT — NEW CONNECTION*\n\n` +
                                            `A WhatsApp account has connected successfully.\n` +
                                            `Number: ${n}`
                                    }
                                );
                            } catch (error) {
                                noxLog(
                                    `Owner notification failed: ${error.message}`,
                                    'error'
                                );
                            }
                        }
                    }

                    return;
                }

                if (
                    connection !== 'close'
                ) {
                    return;
                }

                if (closing) {
                    return;
                }

                const error =
                    lastDisconnect?.error;

                const statusCode =
                    error?.output?.statusCode;

                const errorMessage =
                    error?.message ||
                    '';

                const isLoggedOut =
                    statusCode ===
                        DisconnectReason.loggedOut ||
                    statusCode === 401;

                const isPairingExpired =
                    !authState.creds.registered &&
                    (
                        statusCode === 408 ||
                        errorMessage.includes(
                            'QR refs attempts ended'
                        )
                    );

                if (
                    activeSockets.get(n) === conn
                ) {
                    activeSockets.delete(n);
                    socketCreationTime.delete(n);
                }

                if (
                    pendingSockets.get(n) === conn
                ) {
                    pendingSockets.delete(n);
                }

                /* LOGGED OUT */

                if (isLoggedOut) {
                    noxLog(
                        `WhatsApp session logged out: ${n}`,
                        'warning'
                    );

                    clearPairingState(
                        n
                    );

                    await deleteSessionFromMongoDB(
                        n
                    );

                    await removeNumberFromMongoDB(
                        n
                    );

                    closing = true;

                    return;
                }

                /* PAIRING EXPIRED */

                if (
                    isPairingExpired
                ) {
                    noxLog(
                        `Pairing expired for ${n}`,
                        'warning'
                    );

                    pairingRequests.delete(
                        n
                    );

                    pendingSockets.delete(
                        n
                    );

                    pendingCodes.set(
                        n,
                        {
                            error:
                                'Pairing expired. Start a new pairing request.'
                        }
                    );

                    closing = true;

                    return;
                }

                /* NORMAL CONNECTION FAILURE */

                noxLog(
                    `Connection closed for ${n}; code ${statusCode || 'unknown'}`,
                    'warning'
                );

                if (
                    restartAttempts >= 3
                ) {
                    pairingRequests.delete(
                        n
                    );

                    pendingSockets.delete(
                        n
                    );

                    noxLog(
                        `Reconnect limit reached for ${n}`,
                        'error'
                    );

                    closing = true;

                    return;
                }

                restartAttempts++;

                await delay(
                    10000
                );

                if (
                    !activeSockets.has(n) &&
                    !pendingSockets.has(n)
                ) {
                    pairingRequests.delete(
                        n
                    );

                    try {
                        await noxPair(
                            n
                        );
                    } catch (reconnectError) {
                        noxLog(
                            `Reconnect failed for ${n}: ${reconnectError.message}`,
                            'error'
                        );
                    }
                }
            };

        /*
         * IMPORTANT:
         * This listener stays attached BEFORE pairing code
         * generation. No early listener is removed.
         */
        conn.ev.on(
            'connection.update',
            handleConnectionUpdate
        );

        /* =================================================
           ANTI DELETE
        ================================================= */

        conn.ev.on(
            'messages.update',
            async updates => {
                try {
                    await handleAntidelete(
                        conn,
                        updates,
                        noxStore
                    );
                } catch (error) {
                    noxLog(
                        `Antidelete error: ${error.message}`,
                        'error'
                    );
                }
            }
        );

        /* =================================================
           PAIRING CODE
        ================================================= */

        if (
            !authState.creds.registered
        ) {
            try {
                /*
                 * Give the WhatsApp socket enough time
                 * to establish its websocket before requesting
                 * the pairing code.
                 */
                await delay(
                    3000
                );

                if (
                    closing ||
                    !pairingRequests.has(n)
                ) {
                    return;
                }

                const code =
                    await conn.requestPairingCode(
                        n
                    );

                if (
                    closing ||
                    !pairingRequests.has(n)
                ) {
                    return;
                }

                pendingCodes.set(
                    n,
                    {
                        code,
                        generatedAt:
                            Date.now()
                    }
                );

                noxLog(
                    `Pairing code generated for ${n}`,
                    'success'
                );

                if (
                    res &&
                    !res.headersSent
                ) {
                    res.json({
                        code,
                        status:
                            'new_pairing'
                    });
                }
            } catch (error) {
                noxLog(
                    `Pairing code failed for ${n}: ${error.message}`,
                    'error'
                );

                pendingCodes.set(
                    n,
                    {
                        error:
                            error.message ||
                            'Pairing failed'
                    }
                );

                pairingRequests.delete(
                    n
                );

                pendingSockets.delete(
                    n
                );

                closeSocketQuietly(
                    conn
                );

                if (
                    res &&
                    !res.headersSent
                ) {
                    res.status(500)
                        .json({
                            error:
                                'Failed to generate pairing code'
                        });
                }

                return;
            }
        } else {
            if (
                res &&
                !res.headersSent
            ) {
                res.json({
                    status:
                        'reconnecting',
                    message:
                        'Restoring saved WhatsApp session'
                });
            }
        }

        /* =================================================
           MESSAGE HANDLER
        ================================================= */

        conn.ev.on(
            'messages.upsert',
            async ({
                messages
            }) => {
                for (
                    const mek of
                    messages || []
                ) {
                    try {
                        if (
                            !mek.message ||
                            !mek.key?.remoteJid
                        ) {
                            continue;
                        }

                        const userConfig =
                            await getUserConfigFromMongoDB(
                                n
                            );

                        /* STATUS */

                        if (
                            mek.key.remoteJid ===
                            'status@broadcast'
                        ) {
                            const statusPoster =
                                mek.key.participant ||
                                mek.participant;

                            if (
                                String(
                                    userConfig.AUTO_VIEW_STATUS
                                ) === 'true'
                            ) {
                                try {
                                    await conn.readMessages(
                                        [mek.key]
                                    );
                                } catch (_) {}
                            }

                            if (
                                String(
                                    userConfig.AUTO_LIKE_STATUS
                                ) === 'true'
                            ) {
                                try {
                                    const emojis =
                                        userConfig.AUTO_LIKE_EMOJI?.length
                                            ? userConfig.AUTO_LIKE_EMOJI
                                            : config.AUTO_LIKE_EMOJI ||
                                              ['❤️'];

                                    const emoji =
                                        emojis[
                                            Math.floor(
                                                Math.random() *
                                                emojis.length
                                            )
                                        ];

                                    await conn.sendMessage(
                                        'status@broadcast',
                                        {
                                            react: {
                                                text:
                                                    emoji,
                                                key:
                                                    mek.key
                                            }
                                        },
                                        {
                                            statusJidList:
                                                [
                                                    statusPoster,
                                                    conn.user?.id
                                                ].filter(
                                                    Boolean
                                                )
                                        }
                                    );
                                } catch (_) {}
                            }

                            if (
                                String(
                                    userConfig.AUTO_STATUS_REPLY
                                ) === 'true' &&
                                statusPoster
                            ) {
                                try {
                                    await conn.sendMessage(
                                        statusPoster,
                                        {
                                            text:
                                                userConfig.AUTO_STATUS_MSG ||
                                                config.AUTO_STATUS_MSG ||
                                                ''
                                        },
                                        {
                                            quoted:
                                                mek
                                        }
                                    );
                                } catch (_) {}
                            }

                            continue;
                        }

                        if (
                            getContentType(
                                mek.message
                            ) ===
                            'ephemeralMessage'
                        ) {
                            mek.message =
                                mek.message
                                    .ephemeralMessage
                                    .message;
                        }

                        if (
                            String(
                                userConfig.READ_MESSAGE
                            ) === 'true'
                        ) {
                            try {
                                await conn.readMessages(
                                    [mek.key]
                                );
                            } catch (_) {}
                        }

                        const m =
                            sms(
                                conn,
                                mek
                            );

                        const type =
                            getContentType(
                                mek.message
                            );

                        const from =
                            mek.key.remoteJid;

                        const body =
                            type ===
                            'conversation'
                                ? mek.message.conversation
                                : type ===
                                  'extendedTextMessage'
                                    ? mek.message
                                        .extendedTextMessage
                                        .text
                                    : '';

                        const isCmd =
                            body.startsWith(
                                prefix
                            );

                        const command =
                            isCmd
                                ? body
                                    .slice(
                                        prefix.length
                                    )
                                    .trim()
                                    .split(
                                        /\s+/
                                    )[0]
                                    .toLowerCase()
                                : '';

                        const args =
                            body
                                .trim()
                                .split(
                                    /\s+/
                                )
                                .slice(1);

                        const q =
                            args.join(
                                ' '
                            );

                        const text =
                            q;

                        const isGroup =
                            from.endsWith(
                                '@g.us'
                            );

                        const sender =
                            mek.key.fromMe
                                ? `${conn.user.id.split(':')[0]}@s.whatsapp.net`
                                : mek.key.participant ||
                                  mek.key.remoteJid;

                        const senderNumber =
                            cleanNumber(
                                sender.split(
                                    '@'
                                )[0]
                            );

                        const botNumber =
                            cleanNumber(
                                conn.user.id.split(
                                    ':'
                                )[0]
                            );

                        const botNumber2 =
                            jidNormalizedUser(
                                conn.user.id
                            );

                        const pushname =
                            mek.pushName ||
                            'User';

                        const isMe =
                            senderNumber ===
                            botNumber;

                        const isOwner =
                            isMe ||
                            isSudo(
                                senderNumber
                            );

                        const isCreator =
                            isOwner;

                        let groupMetadata =
                            null;

                        let groupName =
                            null;

                        let participants =
                            null;

                        let groupAdmins =
                            null;

                        let isBotAdmins =
                            null;

                        let isAdmins =
                            null;

                        if (
                            isGroup
                        ) {
                            try {
                                groupMetadata =
                                    await conn.groupMetadata(
                                        from
                                    );

                                groupName =
                                    groupMetadata.subject;

                                participants =
                                    groupMetadata.participants;

                                groupAdmins =
                                    getGroupAdmins(
                                        participants
                                    );

                                isBotAdmins =
                                    groupAdmins.some(
                                        admin =>
                                            cleanNumber(
                                                admin.split(
                                                    '@'
                                                )[0]
                                            ) ===
                                            botNumber
                                    );

                                isAdmins =
                                    groupAdmins.some(
                                        admin =>
                                            cleanNumber(
                                                admin.split(
                                                    '@'
                                                )[0]
                                            ) ===
                                            senderNumber
                                    );
                            } catch (_) {}
                        }

                        if (
                            String(
                                userConfig.AUTO_TYPING
                            ) === 'true'
                        ) {
                            try {
                                await conn.sendPresenceUpdate(
                                    'composing',
                                    from
                                );
                            } catch (_) {}
                        }

                        if (
                            String(
                                userConfig.AUTO_RECORDING
                            ) === 'true'
                        ) {
                            try {
                                await conn.sendPresenceUpdate(
                                    'recording',
                                    from
                                );
                            } catch (_) {}
                        }

                        const ownerNumber =
                            cleanNumber(
                                config.OWNER_NUMBER
                            );

                        const myquoted = {
                            key: {
                                remoteJid:
                                    'status@broadcast',

                                participant:
                                    ownerNumber
                                        ? `${ownerNumber}@s.whatsapp.net`
                                        : '0@s.whatsapp.net',

                                fromMe:
                                    false,

                                id:
                                    createSerial()
                            },

                            message: {
                                contactMessage: {
                                    displayName:
                                        'SCANTY MD BOT',

                                    vcard:
                                        `BEGIN:VCARD\n` +
                                        `VERSION:3.0\n` +
                                        `FN:SCANTY MD BOT OWNER\n` +
                                        `ORG:SCANTY MD BOT\n` +
                                        `TEL;type=CELL;type=VOICE;waid=${ownerNumber}:${ownerNumber}\n` +
                                        `END:VCARD`
                                }
                            },

                            messageTimestamp:
                                Math.floor(
                                    Date.now() /
                                    1000
                                ),

                            status: 1
                        };

                        const reply =
                            (
                                message,
                                extra = {}
                            ) =>
                                conn.sendMessage(
                                    from,
                                    {
                                        text:
                                            String(
                                                message
                                            ),
                                        ...extra
                                    },
                                    {
                                        quoted:
                                            myquoted
                                    }
                                );

                        const l =
                            reply;

                        /* PRIVATE */

                        if (
                            isCmd &&
                            command ===
                                'private'
                        ) {
                            if (!isMe) {
                                await reply(
                                    'Only the connected WhatsApp account can change private mode.'
                                );

                                continue;
                            }

                            const setting =
                                (
                                    args[0] ||
                                    ''
                                ).toLowerCase();

                            if (
                                ![
                                    'on',
                                    'off'
                                ].includes(
                                    setting
                                )
                            ) {
                                await reply(
                                    `Private mode: ${
                                        String(
                                            userConfig.PRIVATE_MODE
                                        ) === 'true'
                                            ? 'ON'
                                            : 'OFF'
                                    }\nUse ${prefix}private on or ${prefix}private off`
                                );

                                continue;
                            }

                            await updateUserConfigInMongoDB(
                                n,
                                {
                                    PRIVATE_MODE:
                                        setting ===
                                        'on'
                                }
                            );

                            await reply(
                                `Private mode ${
                                    setting ===
                                    'on'
                                        ? 'enabled 🔒'
                                        : 'disabled 🌍'
                                }`
                            );

                            continue;
                        }

                        /* COMMANDS */

                        if (
                            isCmd
                        ) {
                            await incrementStats(
                                n,
                                'commandsUsed'
                            );

                            const cmd =
                                events.commands.find(
                                    c =>
                                        c.pattern ===
                                        command
                                ) ||
                                events.commands.find(
                                    c =>
                                        c.alias &&
                                        c.alias.includes(
                                            command
                                        )
                                );

                            if (
                                cmd
                            ) {
                                if (
                                    String(
                                        userConfig.PRIVATE_MODE
                                    ) === 'true' &&
                                    !isOwner
                                ) {
                                    continue;
                                }

                                if (
                                    cmd.react
                                ) {
                                    conn.sendMessage(
                                        from,
                                        {
                                            react: {
                                                text:
                                                    cmd.react,
                                                key:
                                                    mek.key
                                            }
                                        }
                                    ).catch(
                                        () => {}
                                    );
                                }

                                try {
                                    await cmd.function(
                                        conn,
                                        mek,
                                        m,
                                        {
                                            from,
                                            quoted:
                                                mek,
                                            body,
                                            isCmd,
                                            command,
                                            args,
                                            q,
                                            text,
                                            isGroup,
                                            sender,
                                            senderNumber,
                                            botNumber2,
                                            botNumber,
                                            pushname,
                                            isMe,
                                            isOwner,
                                            isCreator,
                                            groupMetadata,
                                            groupName,
                                            participants,
                                            groupAdmins,
                                            isBotAdmins,
                                            isAdmins,
                                            reply,
                                            config,
                                            myquoted
                                        }
                                    );
                                } catch (
                                    error
                                ) {
                                    noxLog(
                                        `Command ${command} error: ${error.message}`,
                                        'error'
                                    );
                                }
                            }
                        }

                        await incrementStats(
                            n,
                            'messagesReceived'
                        );

                        if (
                            isGroup
                        ) {
                            await incrementStats(
                                n,
                                'groupsInteracted'
                            );
                        }

                        /* EVENT PLUGINS */

                        for (
                            const evCmd of
                            events.commands
                        ) {
                            const ctx =
                                {
                                    from,
                                    l,
                                    quoted:
                                        mek,
                                    body,
                                    isCmd,
                                    command,
                                    args,
                                    q,
                                    text,
                                    isGroup,
                                    sender,
                                    senderNumber,
                                    botNumber2,
                                    botNumber,
                                    pushname,
                                    isMe,
                                    isOwner,
                                    isCreator,
                                    groupMetadata,
                                    groupName,
                                    participants,
                                    groupAdmins,
                                    isBotAdmins,
                                    isAdmins,
                                    reply,
                                    config,
                                    myquoted
                                };

                            try {
                                if (
                                    body &&
                                    evCmd.on ===
                                        'body'
                                ) {
                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );
                                } else if (
                                    mek.q &&
                                    evCmd.on ===
                                        'text'
                                ) {
                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );
                                } else if (
                                    [
                                        'image',
                                        'photo'
                                    ].includes(
                                        evCmd.on
                                    ) &&
                                    m.mtype ===
                                        'imageMessage'
                                ) {
                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );
                                } else if (
                                    evCmd.on ===
                                        'sticker' &&
                                    m.mtype ===
                                        'stickerMessage'
                                ) {
                                    await evCmd.function(
                                        conn,
                                        mek,
                                        m,
                                        ctx
                                    );
                                }
                            } catch (
                                error
                            ) {
                                noxLog(
                                    `Plugin handler error: ${error.message}`,
                                    'error'
                                );
                            }
                        }
                    } catch (
                        error
                    ) {
                        noxLog(
                            `Message handler error: ${error.message}`,
                            'error'
                        );
                    }
                }
            }
        });

    } catch (error) {
        clearPairingState(
            n
        );

        noxLog(
            `Pairing error for ${n}: ${error.message}`,
            'error'
        );

        if (
            res &&
            !res.headersSent
        ) {
            res.status(500)
                .json({
                    error:
                        'Pairing failed',
                    message:
                        error.message
                });
        }
    }
}

/* =========================================================
   PAIRING PAGE
========================================================= */

function sendNoxPairPage(
    req,
    res
) {
    const botName =
        String(
            config.BOT_NAME ||
            'SCANTY MD BOT'
        ).replace(
            /[&<>"']/g,
            char =>
                ({
                    '&':
                        '&amp;',
                    '<':
                        '&lt;',
                    '>':
                        '&gt;',
                    '"':
                        '&quot;',
                    "'":
                        '&#39;'
                })[
                    char
                ]
        );

    const html =
        fs.readFileSync(
            path.join(
                __dirname,
                'pair.html'
            ),
            'utf8'
        )
        .replace(
            /\{\{BOT_NAME\}\}/g,
            botName
        )
        .replace(
            /NOX FREE MINI BOT/gi,
            botName
        );

    return res
        .type('html')
        .send(html);
}

router.get(
    '/',
    sendNoxPairPage
);

router.get(
    '/pair.html',
    sendNoxPairPage
);

router.get(
    '/pair-page',
    sendNoxPairPage
);

/* =========================================================
   OLD PAIR ENDPOINT
========================================================= */

router.get(
    '/code',
    async (
        req,
        res
    ) => {
        const number =
            cleanNumber(
                req.query.number
            );

        if (!number) {
            return res.status(400)
                .json({
                    error:
                        'Number required'
                });
        }

        await noxPair(
            number,
            res
        );
    }
);

/* =========================================================
   API PAIR
========================================================= */

router.post(
    '/api/pair',
    async (
        req,
        res
    ) => {
        const number =
            cleanNumber(
                req.body?.number
            );

        if (!number) {
            return res.status(400)
                .json({
                    error:
                        'Number required'
                });
        }

        await noxPair(
            number,
            res
        );
    }
);

/* =========================================================
   START PAIR
========================================================= */

router.post(
    '/start-pair',
    async (
        req,
        res
    ) => {
        const number =
            cleanNumber(
                req.body?.number
            );

        if (!number) {
            return res.status(400)
                .json({
                    ok: false,
                    error:
                        'Number required'
                });
        }

        if (
            activeSockets.has(
                number
            )
        ) {
            return res.json({
                ok: false,
                status:
                    'already_connected'
            });
        }

        if (
            pairingRequests.has(
                number
            )
        ) {
            return res.json({
                ok: true,
                status:
                    'pairing_in_progress'
            });
        }

        pendingCodes.delete(
            number
        );

        noxPair(
            number
        ).catch(
            error => {
                pendingCodes.set(
                    number,
                    {
                        error:
                            error.message
                    }
                );

                pairingRequests.delete(
                    number
                );
            }
        );

        return res.json({
            ok: true,
            status:
                'pairing_started'
        });
    }
);

/* =========================================================
   GET PAIRING CODE
========================================================= */

router.get(
    '/get-code',
    (
        req,
        res
    ) => {
        const number =
            cleanNumber(
                req.query.number
            );

        if (!number) {
            return res.status(400)
                .json({
                    ok: false,
                    error:
                        'Number required'
                });
        }

        if (
            activeSockets.has(
                number
            )
        ) {
            return res.json({
                ok: false,
                status:
                    'already_connected'
            });
        }

        const entry =
            pendingCodes.get(
                number
            );

        if (!entry) {
            return res.json({
                ok: false,
                status:
                    pairingRequests.has(
                        number
                    )
                        ? 'pairing_in_progress'
                        : 'ready'
            });
        }

        if (
            entry.error
        ) {
            return res.json({
                ok: false,
                error:
                    entry.error
            });
        }

        if (
            entry.code
        ) {
            return res.json({
                ok: true,
                code:
                    entry.code,
                status:
                    'code_generated'
            });
        }

        return res.json({
            ok: false,
            status:
                'pairing_in_progress'
        });
    }
);

/* =========================================================
   STATUS
========================================================= */

router.get(
    '/status',
    (
        req,
        res
    ) => {
        const number =
            cleanNumber(
                req.query.number
            );

        if (!number) {
            return res.json({
                status:
                    'active',
                totalActive:
                    activeSockets.size
            });
        }

        const status =
            getConnectionStatus(
                number
            );

        return res.json({
            isConnected:
                status.isConnected,
            connectionTime:
                status.connectionTime,
            uptime:
                status.uptime
        });
    }
);

/* =========================================================
   DISCONNECT
========================================================= */

router.get(
    '/disconnect',
    (
        req,
        res
    ) => {
        return res.status(403)
            .json({
                error:
                    'Disconnect requires verified account ownership.'
            });
    }
);

/* =========================================================
   ACTIVE COUNT ONLY
========================================================= */

router.get(
    '/active',
    (
        req,
        res
    ) => {
        return res.json({
            count:
                activeSockets.size
        });
    }
);

/* =========================================================
   PING
========================================================= */

router.get(
    '/ping',
    (
        req,
        res
    ) => {
        return res.json({
            status:
                'active',
            message:
                'SCANTY MD BOT is running',
            activeSessions:
                activeSockets.size
        });
    }
);

/* =========================================================
   CONNECT ALL DISABLED
========================================================= */

router.get(
    '/connect-all',
    (
        req,
        res
    ) => {
        return res.status(403)
            .json({
                error:
                    'This endpoint is disabled.'
            });
    }
);

/* =========================================================
   CONFIG OTP
========================================================= */

router.get(
    '/update-config',
    async (
        req,
        res
    ) => {
        const number =
            cleanNumber(
                req.query.number
            );

        const configString =
            req.query.config;

        if (
            !number ||
            !configString
        ) {
            return res.status(400)
                .json({
                    error:
                        'Number and config required'
                });
        }

        let newConfig;

        try {
            newConfig =
                JSON.parse(
                    configString
                );
        } catch (_) {
            return res.status(400)
                .json({
                    error:
                        'Invalid config'
                });
        }

        const socket =
            activeSockets.get(
                number
            );

        if (!socket) {
            return res.status(404)
                .json({
                    error:
                        'No active session'
                });
        }

        const otp =
            crypto.randomInt(
                100000,
                1000000
            ).toString();

        await saveOTPToMongoDB(
            number,
            otp,
            newConfig
        );

        try {
            await socket.sendMessage(
                jidNormalizedUser(
                    socket.user.id
                ),
                {
                    text:
                        `*SCANTY MD BOT — CONFIG VERIFICATION*\n\n` +
                        `OTP: *${otp}*\n` +
                        `Valid for 5 minutes.`
                }
            );

            return res.json({
                status:
                    'otp_sent'
            });
        } catch (error) {
            return res.status(500)
                .json({
                    error:
                        'Failed to send OTP'
                });
        }
    }
);

/* =========================================================
   VERIFY OTP
========================================================= */

router.get(
    '/verify-otp',
    async (
        req,
        res
    ) => {
        const number =
            cleanNumber(
                req.query.number
            );

        const otp =
            String(
                req.query.otp ||
                ''
            );

        if (
            !number ||
            !otp
        ) {
            return res.status(400)
                .json({
                    error:
                        'Number and OTP required'
                });
        }

        const verification =
            await verifyOTPFromMongoDB(
                number,
                otp
            );

        if (
            !verification.valid
        ) {
            return res.status(400)
                .json({
                    error:
                        verification.error ||
                        'Invalid OTP'
                });
        }

        await updateUserConfigInMongoDB(
            number,
            verification.config
        );

        const socket =
            activeSockets.get(
                number
            );

        if (
            socket
        ) {
            try {
                await socket.sendMessage(
                    jidNormalizedUser(
                        socket.user.id
                    ),
                    {
                        text:
                            '*✅ SCANTY MD BOT CONFIG UPDATED*'
                    }
                );
            } catch (_) {}
        }

        return res.json({
            status:
                'success'
        });
    }
);

/* =========================================================
   STATS PROTECTED
========================================================= */

router.get(
    '/stats',
    (
        req,
        res
    ) => {
        return res.status(403)
            .json({
                error:
                    'Statistics require verified account ownership.'
            });
    }
);

/* =========================================================
   RESTORE MONGODB SESSIONS
========================================================= */

async function autoReconnectFromMongoDB() {
    try {
        noxLog(
            'Restoring saved WhatsApp sessions...',
            'info'
        );

        const records =
            await Session.find({
                $or: [
                    {
                        credentialsData:
                            {
                                $ne:
                                    null
                            }
                    },
                    {
                        credentials:
                            {
                                $ne:
                                    null
                            }
                    }
                ]
            })
            .select(
                'number'
            )
            .lean();

        const numbers = [
            ...new Set(
                records
                    .map(
                        record =>
                            cleanNumber(
                                record.number
                            )
                    )
                    .filter(
                        Boolean
                    )
            )
        ];

        if (
            !numbers.length
        ) {
            noxLog(
                'No saved sessions found.',
                'info'
            );

            return;
        }

        for (
            const number of
            numbers
        ) {
            if (
                activeSockets.has(
                    number
                ) ||
                pairingRequests.has(
                    number
                )
            ) {
                continue;
            }

            const credentials =
                await getSessionFromMongoDB(
                    number
                );

            if (
                !credentials?.registered
            ) {
                continue;
            }

            await noxPair(
                number
            );

            await delay(
                3000
            );
        }

        noxLog(
            `Restoration started for ${numbers.length} saved account(s).`,
            'success'
        );
    } catch (error) {
        noxLog(
            `Session restoration error: ${error.message}`,
            'error'
        );
    }
}

setTimeout(
    autoReconnectFromMongoDB,
    3000
);

/* =========================================================
   PROCESS SAFETY
========================================================= */

process.on(
    'uncaughtException',
    error => {
        noxLog(
            `Uncaught exception: ${error.message}`,
            'error'
        );
    }
);

process.on(
    'unhandledRejection',
    reason => {
        const message =
            reason?.message ||
            String(reason);

        if (
            message.includes(
                'SessionError'
            ) ||
            message.includes(
                'into the future'
            ) ||
            message.includes(
                'decryptWithSessions'
            )
        ) {
            return;
        }

        noxLog(
            `Unhandled rejection: ${message}`,
            'error'
        );
    }
);

module.exports = router;
