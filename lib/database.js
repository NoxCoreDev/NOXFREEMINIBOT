const mongoose = require('mongoose');
const config = require('../config');

const {
    BufferJSON,
    proto,
    initAuthCreds
} = require('@whiskeysockets/baileys');

const connectdb = async () => {
    if (!config.MONGODB_URI) {
        throw new Error('MONGODB_URI is missing');
    }

    mongoose.set('strictQuery', false);

    try {
        await mongoose.connect(config.MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 15000,
            socketTimeoutMS: 45000
        });

        console.log('✅ MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Failed:', error.message);
        throw error;
    }
};

const cleanNumber = number =>
    String(number || '').replace(/\D/g, '');

const serialize = data =>
    JSON.stringify(data, BufferJSON.replacer);

const deserialize = data =>
    JSON.parse(data, BufferJSON.reviver);

// =====================================
// DATABASE MODELS
// =====================================

const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true, index: true },
    credentials: { type: mongoose.Schema.Types.Mixed, default: null },
    credentialsData: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const sessionKeySchema = new mongoose.Schema({
    number: { type: String, required: true },
    type: { type: String, required: true },
    id: { type: String, required: true },
    data: { type: String, default: null }
});

sessionKeySchema.index(
    { number: 1, type: 1, id: 1 },
    { unique: true }
);

const userConfigSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true, index: true },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const otpSchema = new mongoose.Schema({
    number: { type: String, required: true, index: true },
    otp: { type: String, required: true },
    config: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 5 * 60000),
        index: { expires: '5m' }
    },
    createdAt: { type: Date, default: Date.now }
});

const activeNumberSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true, index: true },
    lastConnected: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    connectionInfo: { type: mongoose.Schema.Types.Mixed, default: {} }
});

const statsSchema = new mongoose.Schema({
    number: { type: String, required: true },
    date: { type: String, required: true },
    commandsUsed: { type: Number, default: 0 },
    messagesReceived: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
    groupsInteracted: { type: Number, default: 0 }
});

statsSchema.index({ number: 1, date: 1 }, { unique: true });

const Session = mongoose.models.Session ||
    mongoose.model('Session', sessionSchema);

const SessionKey = mongoose.models.SessionKey ||
    mongoose.model('SessionKey', sessionKeySchema);

const UserConfig = mongoose.models.UserConfig ||
    mongoose.model('UserConfig', userConfigSchema);

const OTP = mongoose.models.OTP ||
    mongoose.model('OTP', otpSchema);

const ActiveNumber = mongoose.models.ActiveNumber ||
    mongoose.model('ActiveNumber', activeNumberSchema);

const Stats = mongoose.models.Stats ||
    mongoose.model('Stats', statsSchema);

// =====================================
// WHATSAPP MONGODB AUTHENTICATION
// =====================================

async function saveSessionToMongoDB(number, credentials) {
    try {
        const n = cleanNumber(number);

        await Session.findOneAndUpdate(
            { number: n },
            {
                $set: {
                    credentials,
                    credentialsData: serialize(credentials),
                    updatedAt: new Date()
                },
                $setOnInsert: {
                    createdAt: new Date()
                }
            },
            { upsert: true, new: true }
        );

        console.log(`✅ WhatsApp credentials saved: ${n}`);
        return true;
    } catch (error) {
        console.error('Session save error:', error.message);
        return false;
    }
}

async function getSessionFromMongoDB(number) {
    try {
        const n = cleanNumber(number);
        const session = await Session.findOne({ number: n }).lean();

        if (!session) return null;

        if (session.credentialsData) {
            return deserialize(session.credentialsData);
        }

        return session.credentials || null;
    } catch (error) {
        console.error('Session restore error:', error.message);
        return null;
    }
}

function createMongoKeyStore(number) {
    const n = cleanNumber(number);

    return {
        async get(type, ids) {
            const result = {};

            if (!ids.length) return result;

            const records = await SessionKey.find({
                number: n,
                type,
                id: { $in: ids }
            }).lean();

            for (const record of records) {
                if (!record.data) continue;

                let value = deserialize(record.data);

                if (type === 'app-state-sync-key') {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }

                result[record.id] = value;
            }

            return result;
        },

        async set(data) {
            const operations = [];

            for (const [type, entries] of Object.entries(data)) {
                for (const [id, value] of Object.entries(entries)) {
                    if (value === null || value === undefined) {
                        operations.push({
                            deleteOne: {
                                filter: { number: n, type, id }
                            }
                        });
                    } else {
                        operations.push({
                            updateOne: {
                                filter: { number: n, type, id },
                                update: {
                                    $set: {
                                        data: serialize(value)
                                    },
                                    $setOnInsert: {
                                        number: n,
                                        type,
                                        id
                                    }
                                },
                                upsert: true
                            }
                        });
                    }
                }
            }

            if (operations.length) {
                await SessionKey.bulkWrite(operations, {
                    ordered: false
                });
            }
        }
    };
}

async function getMongoAuthState(number) {
    const n = cleanNumber(number);

    const savedCredentials = await getSessionFromMongoDB(n);

    return {
        creds: savedCredentials || initAuthCreds(),
        keys: createMongoKeyStore(n)
    };
}

async function deleteSessionFromMongoDB(number) {
    try {
        const n = cleanNumber(number);

        await Promise.all([
            Session.deleteOne({ number: n }),
            SessionKey.deleteMany({ number: n }),
            ActiveNumber.deleteOne({ number: n })
        ]);

        console.log(`🗑️ WhatsApp session deleted: ${n}`);
        return true;
    } catch (error) {
        console.error('Session deletion error:', error.message);
        return false;
    }
}

// =====================================
// USER CONFIGURATION
// =====================================

const DEFAULT_CONFIG = {
    AUTO_RECORDING: 'false',
    AUTO_TYPING: 'false',
    ANTI_CALL: 'false',
    REJECT_MSG: '*🔕 Your call was automatically rejected!*',
    READ_MESSAGE: 'false',
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_STATUS_REPLY: 'false',
    AUTO_STATUS_MSG: 'Hello 🤭',
    AUTO_LIKE_EMOJI: ['❤️', '👍', '😮', '😎'],
    AUTO_REACT: 'false',
    AUTO_REACT_EMOJI: ['❤️', '🔥', '💖', '✨'],
    PRIVATE_MODE: 'false'
};

async function getUserConfigFromMongoDB(number) {
    const n = cleanNumber(number);

    try {
        let record = await UserConfig.findOne({ number: n });

        if (!record) {
            record = await UserConfig.create({
                number: n,
                config: { ...DEFAULT_CONFIG }
            });
        }

        return {
            ...DEFAULT_CONFIG,
            ...(record.config || {})
        };
    } catch (error) {
        console.error('User config error:', error.message);
        return { ...DEFAULT_CONFIG };
    }
}

async function updateUserConfigInMongoDB(number, newConfig) {
    try {
        const n = cleanNumber(number);
        const current = await getUserConfigFromMongoDB(n);

        await UserConfig.findOneAndUpdate(
            { number: n },
            {
                $set: {
                    config: { ...current, ...newConfig },
                    updatedAt: new Date()
                }
            },
            { upsert: true, new: true }
        );

        return true;
    } catch (error) {
        console.error('Config update error:', error.message);
        return false;
    }
}

// =====================================
// OTP
// =====================================

async function saveOTPToMongoDB(number, otp, configData) {
    try {
        const n = cleanNumber(number);

        await OTP.deleteMany({ number: n });

        await OTP.create({
            number: n,
            otp: String(otp),
            config: configData
        });

        return true;
    } catch (error) {
        console.error('OTP save error:', error.message);
        return false;
    }
}

async function verifyOTPFromMongoDB(number, otp) {
    try {
        const n = cleanNumber(number);

        const record = await OTP.findOne({
            number: n,
            otp: String(otp),
            expiresAt: { $gt: new Date() }
        });

        if (!record) {
            return { valid: false, error: 'Invalid or expired OTP' };
        }

        await OTP.deleteOne({ _id: record._id });

        return {
            valid: true,
            config: record.config
        };
    } catch (error) {
        console.error('OTP verification error:', error.message);
        return { valid: false, error: 'Verification failed' };
    }
}

// =====================================
// ACTIVE NUMBERS
// =====================================

async function addNumberToMongoDB(number) {
    try {
        const n = cleanNumber(number);

        await ActiveNumber.findOneAndUpdate(
            { number: n },
            {
                $set: {
                    isActive: true,
                    lastConnected: new Date()
                }
            },
            { upsert: true, new: true }
        );

        return true;
    } catch (error) {
        console.error('Active number error:', error.message);
        return false;
    }
}

async function removeNumberFromMongoDB(number) {
    try {
        await ActiveNumber.deleteOne({
            number: cleanNumber(number)
        });

        return true;
    } catch (error) {
        console.error('Remove number error:', error.message);
        return false;
    }
}

async function getAllNumbersFromMongoDB() {
    try {
        const records = await ActiveNumber.find({
            isActive: true
        }).lean();

        return records.map(record => record.number);
    } catch (error) {
        console.error('Active numbers error:', error.message);
        return [];
    }
}

// =====================================
// STATISTICS
// =====================================

const allowedStats = [
    'commandsUsed',
    'messagesReceived',
    'messagesSent',
    'groupsInteracted'
];

async function incrementStats(number, field) {
    try {
        if (!allowedStats.includes(field)) return;

        const n = cleanNumber(number);
        const today = new Date().toISOString().slice(0, 10);

        await Stats.findOneAndUpdate(
            { number: n, date: today },
            { $inc: { [field]: 1 } },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('Stats update error:', error.message);
    }
}

async function getStatsForNumber(number) {
    try {
        return await Stats.find({
            number: cleanNumber(number)
        }).sort({ date: -1 }).limit(30).lean();
    } catch (error) {
        console.error('Stats read error:', error.message);
        return [];
    }
}

// =====================================
// EXPORTS
// =====================================

module.exports = {
    connectdb,

    Session,
    SessionKey,
    UserConfig,
    OTP,
    ActiveNumber,
    Stats,

    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,

    createMongoKeyStore,
    getMongoAuthState,

    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,

    saveOTPToMongoDB,
    verifyOTPFromMongoDB,

    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,

    incrementStats,
    getStatsForNumber,

    getUserConfig: getUserConfigFromMongoDB,
    updateUserConfig: updateUserConfigInMongoDB
};
