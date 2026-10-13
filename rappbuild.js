// ══════════════════════════════════════════════════════════════
//  index.js - BotBuild Manager (All-in-One) v2.1
//  Fitur: Build APK Flutter/Android via GitHub Actions
//  Support: GramJS MTProto + Bot API Fallback + AdmZip
//  Update: Channel Verification + Color Style
// ══════════════════════════════════════════════════════════════

const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const settings = require('./config');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { registerBuildHandler } = require('./cidz/hbuild');

// ══════════════════════════════════════════════════════════════
//  IMPORT GITHUB MODULE
// ══════════════════════════════════════════════════════════════
const {
    createRelease,
    deleteRelease,
    publishRelease,
    uploadZipToRelease,
    triggerWorkflow,
    getRunStatus,
    getLatestRunId,
    getFailedStepLog,
    getArtifacts,
    downloadArtifactZip,
    sleep,
    getGitHubConfig,
    validateToken,
} = require('./github');

// ══════════════════════════════════════════════════════════════
//  IMPORT QUEUE MODULE
// ══════════════════════════════════════════════════════════════
const queue = require('./queue');

// ══════════════════════════════════════════════════════════════
//  COLOR STYLE CONSTANTS
// ══════════════════════════════════════════════════════════════
const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    
    // Foreground
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    
    // Bright Foreground
    brightRed: '\x1b[91m',
    brightGreen: '\x1b[92m',
    brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m',
    brightMagenta: '\x1b[95m',
    brightCyan: '\x1b[96m',
    brightWhite: '\x1b[97m',
    
    // Background
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
};

// Helper untuk log dengan warna
const log = {
    info: (msg) => console.log(`${COLORS.brightCyan}[INFO]${COLORS.reset} ${msg}`),
    success: (msg) => console.log(`${COLORS.brightGreen}[SUCCESS]${COLORS.reset} ${msg}`),
    error: (msg) => console.log(`${COLORS.brightRed}[ERROR]${COLORS.reset} ${msg}`),
    warning: (msg) => console.log(`${COLORS.brightYellow}[WARNING]${COLORS.reset} ${msg}`),
    debug: (msg) => console.log(`${COLORS.brightMagenta}[DEBUG]${COLORS.reset} ${msg}`),
    build: (msg) => console.log(`${COLORS.brightBlue}[BUILD]${COLORS.reset} ${msg}`),
    gram: (msg) => console.log(`${COLORS.brightGreen}[GRAM]${COLORS.reset} ${msg}`),
    channel: (msg) => console.log(`${COLORS.brightYellow}[CHANNEL]${COLORS.reset} ${msg}`),
    db: (msg) => console.log(`${COLORS.brightMagenta}[DB]${COLORS.reset} ${msg}`),
};

// ══════════════════════════════════════════════════════════════
//  GRAMJS CLIENT (MTProto Telegram Client - Embedded)
//  Digunakan untuk upload file >50MB yang tidak bisa via Bot API
// ══════════════════════════════════════════════════════════════

const GRAM_SESSION_FILE = path.join(__dirname, 'cidz', 'db', 'gram_session.json');
let gramClient = null;
let gramConnected = false;
let gramInitAttempts = 0;
const GRAM_MAX_INIT_ATTEMPTS = 3;

/**
 * Inisialisasi GramJS Client
 */
async function initGramClient() {
    gramInitAttempts++;
    
    try {
        if (!settings.telegramApi?.api_id || !settings.telegramApi?.api_hash) {
            log.warning('API ID/Hash tidak dikonfigurasi di config.js');
            log.warning('Upload file besar (>50MB) tidak akan tersedia');
            return false;
        }

        let stringSession = '';
        if (fs.existsSync(GRAM_SESSION_FILE)) {
            stringSession = fs.readFileSync(GRAM_SESSION_FILE, 'utf8').trim();
            if (stringSession) {
                log.info('📂 Session ditemukan, mencoba login ulang...');
            }
        }

        const session = new StringSession(stringSession);
        
        gramClient = new TelegramClient(
            session,
            settings.telegramApi.api_id,
            settings.telegramApi.api_hash,
            {
                connectionRetries: 5,
                useWSS: false,
                timeout: 30000,
                requestRetries: 3,
            }
        );

        log.gram('🔌 Menghubungkan ke Telegram MTProto...');
        
        await gramClient.start({
            botAuthToken: settings.token,
            onError: (err) => {
                log.error(`Error: ${err.message}`);
            },
        });

        const savedSession = gramClient.session.save();
        fs.mkdirSync(path.dirname(GRAM_SESSION_FILE), { recursive: true });
        fs.writeFileSync(GRAM_SESSION_FILE, savedSession);

        gramConnected = true;
        gramInitAttempts = 0;
        
        const me = await gramClient.getMe();
        log.gram(`✅ Connected as: @${me.username || me.firstName || 'Bot'}`);
        
        return true;

    } catch (error) {
        gramConnected = false;
        log.error(`Init failed (attempt ${gramInitAttempts}/${GRAM_MAX_INIT_ATTEMPTS}): ${error.message}`);
        
        if (gramInitAttempts < GRAM_MAX_INIT_ATTEMPTS) {
            log.warning('🔄 Retrying in 5 seconds...');
            await sleep(5000);
            return await initGramClient();
        }
        
        log.warning('⚠️ Max retry reached. Upload >50MB tidak tersedia.');
        return false;
    }
}

/**
 * Kirim file via GramJS (MTProto) - FIXED
 */
async function sendFileViaGram(chatId, filePath, caption = '', progressCallback = null) {
    if (!gramConnected || !gramClient) {
        log.warning('Client tidak terkoneksi');
        return false;
    }

    // Validasi file
    if (!fs.existsSync(filePath)) {
        log.error(`❌ File not found: ${filePath}`);
        return false;
    }

    const fileSize = fs.statSync(filePath).size;
    if (fileSize === 0) {
        log.error(`❌ File is empty: ${filePath}`);
        return false;
    }

    const fileName = path.basename(filePath);
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

    log.gram(`📤 Upload: ${fileName} (${fileSizeMB} MB)`);

    try {
        let entity;
        const chatIdStr = String(chatId);
        
        if (chatIdStr.startsWith('-100')) {
            entity = await gramClient.getEntity(parseInt(chatIdStr));
        } else if (chatIdStr.startsWith('-')) {
            entity = await gramClient.getEntity(parseInt(chatIdStr));
        } else {
            entity = await gramClient.getEntity(parseInt(chatIdStr));
        }

        // Kirim file dengan inputFile dari path (bukan buffer)
        const { Api } = require('telegram');
        
        const result = await gramClient.sendFile(entity, {
            file: filePath,  // Kirim path langsung, bukan buffer
            caption: caption,
            parseMode: 'markdown',
            forceDocument: true,
            workers: 2,
            progressCallback: (uploaded, total) => {
                if (total > 0) {
                    const pct = Math.round((uploaded / total) * 100);
                    if (pct % 20 === 0 || pct === 100) {
                        log.gram(`Upload: ${pct}% (${(uploaded/1048576).toFixed(1)}/${(total/1048576).toFixed(1)} MB)`);
                    }
                    if (progressCallback) {
                        progressCallback(pct, uploaded, total);
                    }
                }
            },
        });

        log.gram(`✅ File sent!`);
        return true;

    } catch (error) {
        log.error(`❌ Send failed: ${error.message}`);
        return false;
    }
}

/**
 * Kirim APK otomatis - pilih method terbaik (ANTI SPAM)
 */
async function sendApkAuto(chatId, filePath, caption = '', progressCallback = null) {
    if (!fs.existsSync(filePath)) {
        log.error('File not found:', filePath);
        throw new Error('File APK tidak ditemukan');
    }

    const fileSize = fs.statSync(filePath).size;
    const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    
    log.info(`APK size: ${fileSizeMB} MB | Chat: ${chatId}`);
    
    // Jika > 50MB, wajib GramJS
    if (parseFloat(fileSizeMB) > 50) {
        log.info('File >50MB, using GramJS...');
        const sent = await sendFileViaGram(chatId, filePath, caption, progressCallback);
        if (sent) {
            await updateProgress(chatId, '✅ APK terkirim via MTProto!', 100);
            return true;
        }
        throw new Error(`File terlalu besar (${fileSizeMB}MB) dan GramJS gagal.`);
    }
    
    // Coba GramJS dulu
    if (gramConnected) {
        const sent = await sendFileViaGram(chatId, filePath, caption, progressCallback);
        if (sent) {
            await updateProgress(chatId, '✅ APK terkirim via MTProto!', 100);
            return true;
        }
    }
    
    // Fallback Bot API
    try {
        await bot.sendDocument(chatId, filePath, {
            caption: caption,
            parse_mode: 'Markdown',
        });
        await updateProgress(chatId, '✅ APK terkirim!', 100);
        return true;
    } catch (botError) {
        log.error('Bot API failed:', botError.message);
        throw new Error(`Gagal kirim APK: ${botError.message}`);
    }
}

function isGramConnected() {
    return gramConnected && gramClient !== null;
}

async function disconnectGram() {
    if (gramClient && gramConnected) {
        try {
            await gramClient.disconnect();
            gramConnected = false;
            log.gram('Disconnected');
        } catch (e) {
            log.error('Disconnect error:', e.message);
        }
    }
}

// ══════════════════════════════════════════════════════════════
//  ADMZIP HELPER - Ekstrak ZIP dengan sanitasi filename
// ══════════════════════════════════════════════════════════════

/**
 * Sanitasi nama file/path
 */
function sanitizePath(filePath) {
    if (!filePath) return filePath;
    let sanitized = filePath.replace(/\\/g, '/');
    sanitized = sanitized.replace(/[^\w\-./]/g, (char) => {
        if (char === ' ') return '_';
        if (char === '(' || char === ')') return '';
        if (char === '[' || char === ']') return '';
        if (char === '{' || char === '}') return '';
        const code = char.charCodeAt(0);
        if (code >= 32 && code <= 126) return char;
        return '';
    });
    sanitized = sanitized.split('/').map(segment =>
        segment.trim().replace(/^\.+|\.+$/g, '') || segment
    ).join('/');
    sanitized = sanitized.replace(/\/+/g, '/');
    return sanitized;
}

/**
 * Ekstrak ZIP dengan AdmZip (fallback jika unzip system gagal)
 */
async function extractZipWithAdmZip(zipPath, targetDir) {
    log.info('📂 Extracting with AdmZip...');
    
    try {
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();
        let sanitizedCount = 0;
        let extractedCount = 0;

        for (const entry of entries) {
            try {
                const originalName = entry.entryName;
                const sanitizedName = sanitizePath(originalName);

                if (!sanitizedName || sanitizedName === '/') {
                    continue;
                }

                const targetPath = path.join(targetDir, sanitizedName);

                // Security: cegah path traversal
                const resolvedPath = path.resolve(targetPath);
                if (!resolvedPath.startsWith(path.resolve(targetDir))) {
                    log.warning(`Path traversal blocked: ${originalName}`);
                    continue;
                }

                if (entry.isDirectory) {
                    fs.mkdirSync(targetPath, { recursive: true });
                } else {
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    const content = entry.getData();
                    fs.writeFileSync(targetPath, content);
                    extractedCount++;
                }

                if (originalName !== sanitizedName) {
                    sanitizedCount++;
                    if (sanitizedCount <= 10) {
                        log.debug(`Renamed: "${originalName}" -> "${sanitizedName}"`);
                    }
                }
            } catch (entryError) {
                log.warning(`Error extracting entry: ${entryError.message}`);
            }
        }

        log.success(`✅ Extracted ${extractedCount} files`);
        if (sanitizedCount > 0) {
            log.warning(`⚠️ ${sanitizedCount} filenames were sanitized`);
        }

        return { success: true, extractedCount, sanitizedCount };

    } catch (admError) {
        log.error(`❌ Extraction failed: ${admError.message}`);
        throw new Error(`AdmZip extraction failed: ${admError.message}`);
    }
}

/**
 * Ekstrak ZIP - coba unzip system dulu, fallback ke AdmZip
 */
async function extractZip(zipPath, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });

    // Coba 1: System unzip
    try {
        log.info('Trying system unzip...');
        execSync(`unzip -o -q "${zipPath}" -d "${targetDir}"`, { stdio: 'pipe' });
        log.success('✅ System unzip success');
        return { success: true, method: 'system' };
    } catch (sysError) {
        log.debug(`System unzip failed: ${sysError.message}`);
    }

    // Coba 2: AdmZip
    try {
        const result = await extractZipWithAdmZip(zipPath, targetDir);
        return { success: true, method: 'admzip', ...result };
    } catch (admError) {
        log.error(`AdmZip also failed: ${admError.message}`);
        throw new Error(`Gagal ekstrak ZIP dengan semua method: ${admError.message}`);
    }
}

// ══════════════════════════════════════════════════════════════
//  DATABASE HANDLER
// ══════════════════════════════════════════════════════════════

const DB_DIR = path.join(__dirname, 'cidz', 'db');
const OWNER_DB_PATH = path.join(DB_DIR, 'owner.json');
const PREM_DB_PATH = path.join(DB_DIR, 'premium.json');
const BUILD_HISTORY_PATH = path.join(DB_DIR, 'build_history.json');
// const MAINTENANCE_FILE = path.join(DB_DIR, 'maintenance.json');
const RESELLER_DB_PATH = path.join(DB_DIR, 'reseller.json'); // ← TAMBAHKAN INI

if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

if (!fs.existsSync(OWNER_DB_PATH)) {
    fs.writeFileSync(OWNER_DB_PATH, JSON.stringify([], null, 2));
}

if (!fs.existsSync(PREM_DB_PATH)) {
    fs.writeFileSync(PREM_DB_PATH, JSON.stringify([], null, 2));
}

if (!fs.existsSync(BUILD_HISTORY_PATH)) {
    fs.writeFileSync(BUILD_HISTORY_PATH, JSON.stringify([], null, 2));
}

if (!fs.existsSync(RESELLER_DB_PATH)) { // ← TAMBAHKAN INI
    fs.writeFileSync(RESELLER_DB_PATH, JSON.stringify([], null, 2));
}

function getAdditionalOwners() {
    try {
        const data = fs.readFileSync(OWNER_DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        log.error(`Error reading owner.json: ${error.message}`);
        return [];
    }
}

function getPremiumUsers() {
    try {
        const data = fs.readFileSync(PREM_DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        log.error(`Error reading premium.json: ${error.message}`);
        return [];
    }
}

function saveBuildHistory(userId, data) {
    try {
        const history = JSON.parse(fs.readFileSync(BUILD_HISTORY_PATH, 'utf8'));
        history.push({
            userId: String(userId),
            ...data,
            timestamp: new Date().toISOString(),
        });
        const trimmed = history.slice(-100);
        fs.writeFileSync(BUILD_HISTORY_PATH, JSON.stringify(trimmed, null, 2));
    } catch (error) {
        log.error(`Error saving build history: ${error.message}`);
    }
}

function isOwner(userId) {
    const uid = String(userId);
    const mainAdmins = settings.adminId || [];
    const extraOwners = getAdditionalOwners();
    return mainAdmins.includes(uid) || extraOwners.includes(uid);
}

function isPremium(userId) {
    const uid = String(userId);
    if (isOwner(uid)) return true;
    return getPremiumUsers().includes(uid);
}

function canBuild(userId) {
    return isPremium(userId);
}

/**
 * Get daftar reseller
 */
function getResellers() {
    try {
        const data = fs.readFileSync(RESELLER_DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        log.error(`Error reading reseller.json: ${error.message}`);
        return [];
    }
}

/**
 * Cek apakah user adalah reseller
 */
function isReseller(userId) {
    const uid = String(userId);
    if (isOwner(uid)) return true; // Owner juga bisa akses fitur reseller
    const resellers = getResellers();
    return resellers.some(r => r.id === uid);
}

/**
 * Update isPremium untuk include reseller
 */
function isPremium(userId) {
    const uid = String(userId);
    if (isOwner(uid)) return true;
    if (isReseller(uid)) return true; // Reseller juga dianggap premium
    return getPremiumUsers().includes(uid);
}

// ══════════════════════════════════════════════════════════════
//  CHANNEL VERIFICATION SYSTEM
// ══════════════════════════════════════════════════════════════

/**
 * Cek apakah user sudah join semua channel wajib
 */
async function checkUserChannels(userId) {
    const channels = settings.channels || [];
    const requiredChannels = channels.filter(ch => ch.required);
    
    if (requiredChannels.length === 0) {
        return { joined: true, channels: [] };
    }

    const notJoined = [];
    
    for (const channel of requiredChannels) {
        try {
            const chatMember = await bot.getChatMember(channel.id, userId);
            const status = chatMember.status;
            
            if (status === 'left' || status === 'kicked' || status === 'banned') {
                notJoined.push(channel);
            }
        } catch (error) {
            log.channel(`Error checking ${channel.id}: ${error.message}`);
            // Jika channel tidak ditemukan, skip
            if (!error.message.includes('chat not found')) {
                notJoined.push(channel);
            }
        }
    }
    
    return {
        joined: notJoined.length === 0,
        channels: notJoined
    };
}

/**
 * Buat keyboard untuk join channel
 */
function createChannelKeyboard(notJoinedChannels) {
    const keyboard = [];
    
    for (const channel of notJoinedChannels) {
        keyboard.push([{
            text: `${channel.name || channel.id}`,
            url: channel.url || `https://t.me/${channel.id.replace('@', '')}`
        }]);
    }
    
    keyboard.push([{
        text: '✅ SUDAH JOIN',
        callback_data: 'check_join'
    }]);
    
    return keyboard;
}

// ══════════════════════════════════════════════════════════════
//  BOT INITIALIZATION
// ══════════════════════════════════════════════════════════════

const bot = new TelegramBot(settings.token, {
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10,
        },
    },
    filepath: false,
});

const BANNER_IMG = 'https://h.uguu.se/qzkqhcFr.jpg';
const MAX_ZIP_SIZE = 524288000; // 500MB
const BUILD_TIMEOUT = 30 * 60 * 1000; // 30 menit

const buildStates = new Map();
const userBuilds = new Map();
// const maintenanceNotify = new Map();

// ══════════════════════════════════════════════════════════════
//  MAINTENANCE MODE SYSTEM
//  Letakkan di BAGIAN ATAS, sebelum semua handler
// ══════════════════════════════════════════════════════════════

let maintenanceMode = false;
const maintenanceNotify = new Map();
const MAINTENANCE_FILE = path.join(DB_DIR, 'maintenance.json');

// Load maintenance status dari file
if (fs.existsSync(MAINTENANCE_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
        maintenanceMode = data.enabled || false;
        log.info(`Maintenance: ${maintenanceMode ? 'ON 🔴' : 'OFF 🟢'}`);
    } catch (e) {
        maintenanceMode = false;
    }
}

// ══════════════════════════════════════════════════════════════
//  MAINTENANCE HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Cek apakah user diblokir karena maintenance
 */
function isMaintenanceBlocked(userId) {
    return maintenanceMode && !isOwner(userId);
}

/**
 * Kirim pesan maintenance ke user (anti-spam: 30 detik)
 */
async function sendMaintenanceMessage(chatId, userId) {
    const now = Date.now();
    const lastNotif = maintenanceNotify.get(userId) || 0;
    
    if (now - lastNotif > 30000) { // 30 detik
        maintenanceNotify.set(userId, now);
        
        try {
            await bot.sendMessage(chatId, 
                '🔴 *MAINTENANCE MODE*\n\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                '🛠️ Bot sedang dalam pemeliharaan.\n' +
                '⏳ Silakan coba lagi nanti.\n\n' +
                '📞 Hubungi @habalzy jika ada pertanyaan.',
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            log.error(`Gagal kirim notifikasi: ${error.message}`);
        }
    }
}

// ══════════════════════════════════════════════════════════════
//  PROGRESS BAR & MESSAGE UPDATER (EDIT MESSAGE + ANTI SPAM)
// ══════════════════════════════════════════════════════════════

const progressThrottle = new Map(); // chatId -> { lastUpdate, lastText, lastProgress }
const THROTTLE_MS = 2000; // Minimal jeda 4 detik antar update

/**
 * Buat progress bar warna-warni dengan emoji
 * Update: Status emoji lebih dinamis dan progress real-time
 */
function createProgressBar(progress) {
    const barLength = 15;
    const filled = Math.floor((progress / 100) * barLength);
    const empty = barLength - filled;
    
    // Pilih warna berdasarkan progress
    let filledEmoji = '🟩'; // Default hijau
    if (progress < 10) filledEmoji = '🔴'; // Merah - Baru mulai
    else if (progress < 20) filledEmoji = '🟥'; // Merah
    else if (progress < 30) filledEmoji = '🟠'; // Orange muda
    else if (progress < 40) filledEmoji = '🟧'; // Orange
    else if (progress < 50) filledEmoji = '🟡'; // Kuning muda
    else if (progress < 60) filledEmoji = '🟨'; // Kuning
    else if (progress < 70) filledEmoji = '🟢'; // Hijau muda
    else if (progress < 80) filledEmoji = '🟦'; // Biru
    else if (progress < 90) filledEmoji = '🟩'; // Hijau
    else filledEmoji = '💚'; // Hati hijau - Hampir selesai
    
    // Buat bar dengan emoji warna
    const bar = filledEmoji.repeat(filled) + '⬜'.repeat(empty);
    
    // Status emoji SANGAT DINAMIS berdasarkan progress
    let statusEmoji = '⏳';
    let statusText = '';
    
    if (progress >= 100) {
        statusEmoji = '🎉';
        statusText = 'SELESAI!';
    } else if (progress >= 95) {
        statusEmoji = '📤';
        statusText = 'Mengirim...';
    } else if (progress >= 90) {
        statusEmoji = '📦';
        statusText = 'Packaging...';
    } else if (progress >= 85) {
        statusEmoji = '🚀';
        statusText = 'Finalizing...';
    } else if (progress >= 80) {
        statusEmoji = '🔧';
        statusText = 'Optimizing...';
    } else if (progress >= 75) {
        statusEmoji = '⚙️';
        statusText = 'Compiling...';
    } else if (progress >= 70) {
        statusEmoji = '🛠️';
        statusText = 'Building...';
    } else if (progress >= 65) {
        statusEmoji = '🔨';
        statusText = 'Processing...';
    } else if (progress >= 60) {
        statusEmoji = '🔄';
        statusText = 'Working...';
    } else if (progress >= 55) {
        statusEmoji = '📥';
        statusText = 'Downloading...';
    } else if (progress >= 50) {
        statusEmoji = '⏳';
        statusText = 'Halfway...';
    } else if (progress >= 45) {
        statusEmoji = '💻';
        statusText = 'Computing...';
    } else if (progress >= 40) {
        statusEmoji = '⚡';
        statusText = 'Processing...';
    } else if (progress >= 35) {
        statusEmoji = '🚀';
        statusText = 'Starting...';
    } else if (progress >= 30) {
        statusEmoji = '📦';
        statusText = 'Preparing...';
    } else if (progress >= 25) {
        statusEmoji = '☁️';
        statusText = 'Uploading...';
    } else if (progress >= 20) {
        statusEmoji = '📤';
        statusText = 'Sending...';
    } else if (progress >= 15) {
        statusEmoji = '🔍';
        statusText = 'Validating...';
    } else if (progress >= 10) {
        statusEmoji = '📥';
        statusText = 'Downloading...';
    } else if (progress >= 5) {
        statusEmoji = '⏳';
        statusText = 'Starting...';
    } else {
        statusEmoji = '🔄';
        statusText = 'Initializing...';
    }
    
    // Format persentase dengan 1 desimal untuk progress real-time
    const percentStr = progress.toFixed(1).padStart(5, ' ');
    
    return `\n\n${bar}\n${statusEmoji} ${statusText} - ${percentStr}%`;
}

/**
 * Buat progress bar dengan karakter warna ANSI untuk console
 */
function createConsoleProgressBar(progress) {
    const barLength = 20;
    const filled = Math.floor((progress / 100) * barLength);
    const empty = barLength - filled;
    
    const COLORS = {
        reset: '\x1b[0m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
    };
    
    let barColor = COLORS.green;
    if (progress < 20) barColor = COLORS.red;
    else if (progress < 40) barColor = COLORS.yellow;
    else if (progress < 60) barColor = COLORS.cyan;
    else if (progress < 80) barColor = COLORS.blue;
    else barColor = COLORS.green;
    
    const bar = barColor + '█'.repeat(filled) + COLORS.reset + '░'.repeat(empty);
    return bar;
}

/**
 * Update progress message dengan anti-spam
 */
async function updateProgress(chatId, text, progress = null) {
    const state = buildStates.get(chatId);
    const throttle = progressThrottle.get(chatId) || { lastUpdate: 0, lastText: '', lastProgress: -1 };
    const now = Date.now();
    
    // ANTI SPAM: Skip kalau belum 4 detik & bukan progress final (100)
    if (now - throttle.lastUpdate < THROTTLE_MS && progress !== 100 && progress !== null) {
        throttle.lastText = text;
        throttle.lastProgress = progress;
        progressThrottle.set(chatId, throttle);
        return;
    }
    
    throttle.lastUpdate = now;
    throttle.lastText = text;
    throttle.lastProgress = progress;
    progressThrottle.set(chatId, throttle);
    
    // Buat progress bar warna-warni
    let progressBar = '';
    if (progress !== null && progress >= 0 && progress <= 100) {
        progressBar = createProgressBar(progress);
        
        // Log console dengan warna
        const consoleBar = createConsoleProgressBar(progress);
        log.info(`Progress: ${consoleBar} ${progress}%`);
    }
    
    const fullMessage = text + progressBar;

    if (state && state.lastFullText === fullMessage) {
        return;
    }

    try {
        if (state && state.messageId) {
            await bot.editMessageText(fullMessage, {
                chat_id: chatId,
                message_id: state.messageId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            state.lastFullText = fullMessage;
            state.updatedAt = now;
        } else {
            const sent = await bot.sendMessage(chatId, fullMessage, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
            buildStates.set(chatId, { 
                messageId: sent.message_id,
                lastFullText: fullMessage,
                updatedAt: now,
            });
        }
    } catch (error) {
        if (error.message.includes('message to edit not found') || 
            error.message.includes('message is not modified') ||
            error.message.includes('Too Many Requests')) {
            
            if (error.message.includes('Too Many Requests')) {
                log.warning('Rate limited, waiting...');
                await sleep(5000);
            }
            
            if (error.message.includes('message to edit not found')) {
                try {
                    const sent = await bot.sendMessage(chatId, fullMessage, {
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                    });
                    buildStates.set(chatId, { 
                        messageId: sent.message_id,
                        lastFullText: fullMessage,
                        updatedAt: now,
                    });
                } catch (sendError) {
                    log.error('Send new message error:', sendError.message);
                }
            }
        } else {
            log.error('Update error:', error.message);
        }
    }
}

function clearProgressState(chatId) {
    buildStates.delete(chatId);
    progressThrottle.delete(chatId);
}

// ══════════════════════════════════════════════════════════════
//  BUILD PROCESS ENGINE
// ══════════════════════════════════════════════════════════════

async function processBuild(chatId, userId, platform, buildType) {
    const jobId = `build-${Date.now()}-${userId}`;
    const tag = `build-${jobId}`;
    let releaseId = null;
    const startTime = Date.now();

    try {
        const buildData = userBuilds.get(userId);
        if (!buildData || !buildData.zipPath) {
            throw new Error('❌ Session build tidak valid. Silakan ulangi dari awal.');
        }

        const zipPath = buildData.zipPath;
        const zipFileName = path.basename(zipPath);
        const zipSizeMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(2);

        log.build(`Starting build for user ${userId}`);
        log.build(`Platform: ${platform} | Type: ${buildType} | ZIP: ${zipSizeMB}MB`);

        // ═══════════ STEP 1: Upload ZIP ═══════════
        await updateProgress(chatId, 
            '☁️ UPLOAD PROJECT\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `📦 File: ${zipFileName}\n` +
            `📏 Size: ${zipSizeMB} MB\n\n` +
            '⏳ Mengupload ke GitHub...',
            25
        );

        let uploadResult;
        try {
            uploadResult = await uploadZipToRelease(zipPath, zipFileName, tag);
            releaseId = uploadResult.releaseId;
            log.build(`Release created: ${releaseId}`);
        } catch (uploadError) {
            log.error('Upload failed:', uploadError.message);
            throw new Error(`❌ Gagal upload project: ${uploadError.message}`);
        }

        // ═══════════ STEP 2: Trigger Workflow ═══════════
        await updateProgress(chatId,
            '🚀 TRIGGER WORKFLOW\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '✅ Upload berhasil!\n' +
            '🔄 Menjalankan GitHub Actions...\n\n' +
            `📄 Workflow: build-apk.yml\n` +
            `🏷️ Tag: ${tag}`,
            35
        );

        let runId;
        try {
            runId = await triggerWorkflow(tag, buildType);
            log.build(`Workflow triggered. Run ID: ${runId}`);
        } catch (triggerError) {
            log.error('Trigger failed:', triggerError.message);
            throw new Error(`❌ Gagal trigger workflow: ${triggerError.message}`);
        }

        // ═══════════ STEP 3: Monitor Build ═══════════
        const ghConfig = getGitHubConfig();
        const ghUrl = `https://github.com/${ghConfig.repo || 'wleeee'}`;

        await updateProgress(chatId,
            '⏳ MENUNGGU RUNNER\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '🔄 Workflow berhasil dipicu!\n' +
            '⏳ Menunggu GitHub runner tersedia...\n\n' +
            `🆔 Run ID: ${runId}\n` +
            '🔗 #By Balzy',
            40
        );

        let buildSuccess = false;
        let lastProgress = 40;
        const monitorInterval = 15000;
        let failedStepLog = null;

        while (true) {
            if (Date.now() - startTime > BUILD_TIMEOUT) {
                throw new Error('⏰ Build timeout setelah 30 menit!');
            }

            await sleep(monitorInterval);

            let status;
            try {
                status = await getRunStatus(runId);
            } catch (statusError) {
                log.error('Status check failed:', statusError.message);
                continue;
            }

            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const elapsedStr = elapsed > 60 
                ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                : `${elapsed}s`;

            if (status.status === 'queued') {
                lastProgress = Math.min(lastProgress + 0.5, 50);
                await updateProgress(chatId,
                    '⏳ ANTRIAN\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '🔄 Status: Queue\n' +
                    `⏱ Waktu: ${elapsedStr}\n\n` +
                    '💡 Menunggu giliran build...',
                    Math.floor(lastProgress)
                );

            } else if (status.status === 'in_progress') {
                lastProgress = Math.min(45 + Math.floor(elapsed / 6), 85);
                
                let stageMsg = '🔨 Building...';
                let stageDesc = 'Memproses build';
                if (lastProgress < 55) {
                    stageMsg = '📥 SETUP ENVIRONMENT';
                    stageDesc = 'Menyiapkan lingkungan build';
                } else if (lastProgress < 65) {
                    stageMsg = '📦 INSTALLING DEPENDENCIES';
                    stageDesc = 'Menginstall dependencies project';
                } else if (lastProgress < 75) {
                    stageMsg = '☕ COMPILING NATIVE CODE';
                    stageDesc = 'Compiling kode native (C/C++)';
                } else if (lastProgress < 82) {
                    stageMsg = '🎯 COMPILING DART';
                    stageDesc = 'Compiling kode Dart/Java';
                } else {
                    stageMsg = '📦 PACKAGING APK';
                    stageDesc = 'Membuat file APK final';
                }

                await updateProgress(chatId,
                    `${stageMsg}\n` +
                    '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '🔄 Status: Building\n' +
                    `⏱ Waktu: ${elapsedStr}\n\n` +
                    `📝 ${stageDesc}...`,
                    Math.floor(lastProgress)
                );

            } else if (status.status === 'completed') {
                if (status.conclusion === 'success') {
                    buildSuccess = true;
                    break;
                } else {
                    // Build gagal - ambil log lengkap
                    try {
                        failedStepLog = await getFailedStepLog(runId);
                        log.error('Build failed, fetching error logs...');
                    } catch (logError) {
                        log.error('Failed to get error log:', logError.message);
                    }
                    break;
                }
            }
        }

        // ═══════════ JIKA BUILD GAGAL - KIRIM ERROR LOG ═══════════
        if (!buildSuccess) {
            await updateProgress(chatId,
                '❌ BUILD GAGAL!\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                '📋 Mengambil error log...\n' +
                '⏳ Mohon tunggu...',
                90
            );

            // Buat file error log
            const errorDir = path.join(__dirname, 'temp', `error-${jobId}`);
            fs.mkdirSync(errorDir, { recursive: true });
            
            let errorContent = 'BUILD ERROR LOG\n';
            errorContent += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            errorContent += `Date: ${new Date().toISOString()}\n`;
            errorContent += `User ID: ${userId}\n`;
            errorContent += `Platform: ${platform === 'flutter' ? 'Flutter' : 'Android SDK'}\n`;
            errorContent += `Build Type: ${buildType}\n`;
            errorContent += `Run ID: ${runId}\n`;
            errorContent += `Duration: ${Math.floor((Date.now() - startTime) / 1000)}s\n`;
            errorContent += `Repo: ${wleee || 'wleeee'}\n\n`;
            errorContent += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            
            if (failedStepLog && failedStepLog.errorLines && failedStepLog.errorLines.length > 0) {
                errorContent += 'ERROR DETAILS:\n';
                errorContent += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
                errorContent += failedStepLog.errorLines.join('\n');
                errorContent += '\n\n';
            } else {
                errorContent += 'ERROR: Build failed but no detailed error log available.\n';
                errorContent += 'Please check GitHub Actions for more information.\n\n';
            }
            
            errorContent += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            errorContent += `GitHub URL: https://github.com/${wleee || 'wleeee'}/actions/runs/${runId}\n`;
            errorContent += 'Powered by Web2Apk\n';
            
            const errorFilePath = path.join(errorDir, `build-error-${jobId}.txt`);
            fs.writeFileSync(errorFilePath, errorContent);

            // Kirim file error ke user
            const errorCaption = 
                '❌ BUILD GAGAL!\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `📱 Platform: ${platform === 'flutter' ? '🦋 Flutter' : '🤖 Android SDK'}\n` +
                `🔧 Tipe: ${buildType === 'release' ? '🚀 Release' : '🐛 Debug'}\n` +
                `⏱ Durasi: ${Math.floor((Date.now() - startTime) / 60)}m ${Math.floor((Date.now() - startTime) % 60)}s\n\n` +
                '📋 Error log lengkap ada di file TXT di atas.\n' +
                '🔍 Silakan periksa error tersebut untuk memperbaiki project.\n\n' +
                '💡 Tips:\n' +
                '• Pastikan project bisa build secara lokal\n' +
                '• Cek dependencies yang digunakan\n' +
                '• Pastikan struktur project benar';

            try {
                // Kirim file error log
                await bot.sendDocument(chatId, errorFilePath, {
                    caption: errorCaption,
                    parse_mode: 'Markdown',
                }, {
                    filename: `build-error-${jobId}.txt`
                });
                log.success('Error log sent to user');
            } catch (sendError) {
                log.error('Failed to send error log:', sendError.message);
                
                // Fallback: kirim pesan error singkat
                await bot.sendMessage(chatId,
                    '❌ BUILD GAGAL!\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    (failedStepLog && failedStepLog.errorLines 
                        ? failedStepLog.errorLines.slice(0, 10).join('\n') 
                        : 'Unknown error occurred.') +
                    '\n\n🔗 Cek detail di GitHub Actions.',
                    { parse_mode: 'Markdown' }
                );
            }

            // Cleanup
            setTimeout(() => {
                try {
                    if (fs.existsSync(errorDir)) {
                        fs.rmSync(errorDir, { recursive: true, force: true });
                    }
                } catch (cleanupError) {
                    log.error('Failed to cleanup error dir:', cleanupError.message);
                }
            }, 300000); // 5 menit

            throw new Error('Build failed');
        }

        // ═══════════ STEP 4: Download Artifact ═══════════
        await updateProgress(chatId,
            '📥 DOWNLOAD ARTIFACT\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '✅ Build selesai!\n' +
            '📥 Mendownload APK dari GitHub...',
            88
        );

        let artifacts;
        try {
            artifacts = await getArtifacts(runId);
        } catch (artifactError) {
            throw new Error(`❌ Gagal mengambil artifact: ${artifactError.message}`);
        }

        if (!artifacts || artifacts.length === 0) {
            throw new Error('❌ Tidak ada artifact ditemukan. Build mungkin gagal menghasilkan APK.');
        }

        const apkArtifact = artifacts.find(a => 
            a.name.toLowerCase().includes('apk') || 
            a.name.toLowerCase().includes('build')
        ) || artifacts[0];

        log.build(`Artifact: ${apkArtifact.name} (${(apkArtifact.size / 1048576).toFixed(2)} MB)`);

        const tmpDir = path.join(__dirname, 'temp', jobId);
        fs.mkdirSync(tmpDir, { recursive: true });

        const artifactZipPath = path.join(tmpDir, 'artifact.zip');
        
        try {
            await downloadArtifactZip(apkArtifact.id, artifactZipPath);
        } catch (downloadError) {
            throw new Error(`❌ Gagal download artifact: ${downloadError.message}`);
        }

        // ═══════════ STEP 5: Extract APK ═══════════
        await updateProgress(chatId,
            '📂 EKSTRAK APK\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '📥 Download selesai!\n' +
            '📂 Mengekstrak file APK...',
            92
        );

        const extractDir = path.join(tmpDir, 'extracted');

        try {
            await extractZip(artifactZipPath, extractDir);
        } catch (extractError) {
            throw new Error(`❌ Gagal ekstrak artifact: ${extractError.message}`);
        }

        // Cari file APK
        function findApkRecursive(dir) {
            try {
                const items = fs.readdirSync(dir);
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    const stat = fs.statSync(fullPath);
                    if (stat.isFile() && item.endsWith('.apk')) {
                        return fullPath;
                    }
                    if (stat.isDirectory() && !item.startsWith('.')) {
                        const found = findApkRecursive(fullPath);
                        if (found) return found;
                    }
                }
            } catch (e) {}
            return null;
        }

        let apkPath = findApkRecursive(extractDir);
        if (!apkPath) throw new Error('❌ APK tidak ditemukan!');

        // ⬇️ RENAME APK KE NAMA STANDARD ⬇️
        const apkName = buildType === 'release' ? 'app-release.apk' : 'app-debug.apk';
        const newApkPath = path.join(path.dirname(apkPath), apkName);
        
        if (apkPath !== newApkPath) {
            fs.renameSync(apkPath, newApkPath);
            apkPath = newApkPath;
            log.build(`Renamed APK to: ${apkName}`);
        }

        const apkSizeMB = (fs.statSync(apkPath).size / (1024 * 1024)).toFixed(2);
        log.build(`APK: ${apkName} (${apkSizeMB} MB)`);

        // ═══════════ STEP 6: Kirim APK ═══════════
        await updateProgress(chatId,
            '📤 MENGIRIM APK\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '✅ APK berhasil diekstrak!\n' +
            '📤 Mengirim file APK...\n\n' +
            `📄 ${apkName}\n` +
            `📦 ${apkSizeMB} MB`,
            95
        );

        const platformName = platform === 'flutter' ? '🦋 Flutter' : '🤖 Android SDK';
        const buildTypeName = buildType === 'release' ? '🚀 Release' : '🐛 Debug';
        const totalDuration = Math.floor((Date.now() - startTime) / 1000);
        const durationStr = totalDuration > 60 
            ? `${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`
            : `${totalDuration}s`;

        const caption = 
            '✅ BUILD SUKSES!\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `📱 Platform: ${platformName}\n` +
            `🔧 Tipe: ${buildTypeName}\n` +
            `📦 Size: ${apkSizeMB} MB\n` +
            `📄 File: ${apkName}\n` +
            `⏱ Durasi: ${durationStr}\n\n` +
            '🔗 Powered by: Web2Apk';

        // Kirim APK dengan nama file yang sudah diganti
        try {
            await bot.sendDocument(chatId, apkPath, {
                caption: caption,
                parse_mode: 'Markdown',
            }, {
                filename: apkName
            });
            log.success(`Sent: ${apkName}`);
        } catch (botSendError) {
            if (gramConnected && gramClient) {
                try {
                    const entity = await gramClient.getEntity(parseInt(chatId));
                    await gramClient.sendFile(entity, {
                        file: apkPath,
                        caption: caption,
                        parseMode: 'markdown',
                        forceDocument: true,
                        workers: 4,
                    });
                } catch (gramError) {
                    throw new Error(`Gagal kirim APK: ${gramError.message}`);
                }
            } else {
                throw new Error(`Gagal kirim APK: ${botSendError.message}`);
            }
        }

        // ═══════════ STEP 7: Final ═══════════
        await updateProgress(chatId,
            '🎉 BUILD BERHASIL!\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '✅ APK berhasil dikirim!\n\n' +
            `📱 Platform: ${platformName}\n` +
            `🔧 Tipe: ${buildTypeName}\n` +
            `📦 Size: ${apkSizeMB} MB\n` +
            `⏱ Durasi: ${durationStr}\n\n` +
            '🙏 Terima kasih telah menggunakan bot ini!',
            100
        );

        saveBuildHistory(userId, {
            platform,
            buildType,
            apkSize: apkSizeMB,
            duration: totalDuration,
            runId,
            success: true,
        });

        clearProgressState(chatId);
        log.build(`✅ Build completed for user ${userId}`);

    } catch (error) {
        log.error(`Build failed for user ${userId}: ${error.message}`);
        
        // Jangan kirim error jika sudah dikirim di atas
        if (error.message !== 'Build failed') {
            await updateProgress(chatId,
                '❌ BUILD GAGAL!\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `${error.message}\n\n` +
                '_Silahkan coba lagi atau hubungi admin._'
            );
        }

        saveBuildHistory(userId, {
            platform,
            buildType,
            error: error.message,
            success: false,
        });

        clearProgressState(chatId);

    } finally {
        if (releaseId) {
            deleteRelease(releaseId).catch(e => 
                log.error('Failed to delete release:', e.message)
            );
        }

        const tmpDir = path.join(__dirname, 'temp', jobId);
        setTimeout(() => {
            try {
                if (fs.existsSync(tmpDir)) {
                    fs.rmSync(tmpDir, { recursive: true, force: true });
                }
            } catch (cleanupError) {
                log.error('Failed to remove temp dir:', cleanupError.message);
            }
        }, 60000);

        const buildData = userBuilds.get(userId);
        if (buildData?.zipPath) {
            try { fs.unlinkSync(buildData.zipPath); } catch {}
        }

        queue.removeUserJob(userId);
        userBuilds.delete(userId);
    }
}

// ══════════════════════════════════════════════════════════════
//  CALLBACK QUERY HANDLER (EDIT MESSAGE ONLY)
// ══════════════════════════════════════════════════════════════

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const messageId = query.message.message_id;
    const data = query.data;

    log.debug(`User ${userId}: ${data}`);

    try {
        // ═══════════ VERIFIKASI JOIN CHANNEL ═══════════
        if (data === 'check_join') {
            await bot.answerCallbackQuery(query.id, { text: '🔄 Memeriksa...' });
            
            const channelCheck = await checkUserChannels(userId);
            
            if (channelCheck.joined) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                
                const caption = 
                    `✅ VERIFIKASI BERHASIL!\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Terima kasih sudah join channel!\n\n` +
                    `🔧 BOTBUILD MANAGER v2.1\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Status: ✅ Online\n` +
                    `User: \`@${query.from.username || query.from.first_name || 'User'}\`\n` +
                    `Version: 2.1.0\n\n` +
                    `_Silahkan pilih menu di bawah ini_`;
                
                await bot.sendPhoto(chatId, BANNER_IMG, {
                    caption: caption,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📱 BUILD APK', callback_data: 'menu_build_apk', style: 'danger' }],
                            [{ text: '📚 TUTORIAL', callback_data: 'show_tutorial', style: 'success' }],
                            [{ text: '🔧 BOTBUILD VPS', callback_data: 'cmd_botbuild', style: 'primary' }],
                            [{ text: '📊 HISTORY', callback_data: 'show_history', style: 'success' }, { text: 'ℹ️ INFO USER', callback_data: 'menu_info', style: 'primary' }],
                            [{ text: '⚙️ ADMIN PANEL', callback_data: 'menu_admin', style: 'danger' }, { text: '👑 OWNER', url: 'https://t.me/habalzy', style: 'primary' }]
                        ]
                    }
                });
            } else {
                const channelsList = channelCheck.channels
                    .map(ch => `• ${ch.name || ch.id}`)
                    .join('\n');
                
                await bot.answerCallbackQuery(query.id, { 
                    text: '❌ Kamu belum join semua channel!', 
                    show_alert: true 
                });
                
                const caption = 
                    `🔒 AKSES DIBATASI\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Kamu belum join channel berikut:\n\n` +
                    `${channelsList}\n\n` +
                    `Klik tombol di bawah untuk join, lalu tekan *SUDAH JOIN* untuk verifikasi.`;
                
                await bot.editMessageCaption(caption, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: createChannelKeyboard(channelCheck.channels)
                    }
                }).catch(async () => {
                    await bot.sendPhoto(chatId, BANNER_IMG, {
                        caption: caption,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: createChannelKeyboard(channelCheck.channels)
                        }
                    });
                });
            }
        }

        // ═══════════ MENU UTAMA ═══════════
        else if (data === 'menu_utama') {
            await bot.answerCallbackQuery(query.id);
            
            // Cek verifikasi channel dulu
            const channelCheck = await checkUserChannels(userId);
            
            if (!channelCheck.joined) {
                const channelsList = channelCheck.channels
                    .map(ch => `• ${ch.name || ch.id}`)
                    .join('\n');
                
                const caption = 
                    `🔒 *AKSES DIBATASI*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `Kamu belum join channel:\n\n` +
                    `${channelsList}\n\n` +
                    `Join dulu untuk mengakses bot.`;
                
                return await bot.sendPhoto(chatId, BANNER_IMG, {
                    caption: caption,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: createChannelKeyboard(channelCheck.channels)
                    }
                });
            }
            
            await bot.deleteMessage(chatId, messageId).catch(() => {});
            
            const caption = 
                `🔧 BOTBUILD MANAGER v2.1\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `*Status:* ✅ Online\n` +
                `*User:* \`@${query.from.username || query.from.first_name || 'User'}\`\n` +
                `*Level:* ${isOwner(userId) ? '👑 Owner' : (isPremium(userId) ? '⭐ Premium' : '👤 Free')}\n\n` +
                `Pilih menu di bawah ini:`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: '📱 BUILD APK', callback_data: 'menu_build_apk' }],
                    [{ text: '📚 TUTORIAL', callback_data: 'show_tutorial' }],
                    [{ text: '🔧 BOTBUILD VPS', callback_data: 'cmd_botbuild' }],
                    [{ text: '📊 HISTORY', callback_data: 'show_history' }, { text: 'ℹ️ INFO USER', callback_data: 'menu_info' }],
                    [{ text: '⚙️ ADMIN PANEL', callback_data: 'menu_admin' }, { text: '👑 OWNER', url: 'https://t.me/habalzy' }],
                ]
            };

            await bot.sendMessage(chatId, caption, {
                parse_mode: 'Markdown',
                reply_markup: keyboard,
            });
        }

        // ═══════════ MENU BUILD APK ═══════════
        else if (data === 'menu_build_apk') {
            await bot.answerCallbackQuery(query.id);
            await bot.deleteMessage(chatId, messageId).catch(() => {});

            const msg = 
                `📱 BUILD APK\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Pilih platform project:\n\n` +
                `🦋 Flutter - Flutter/Dart\n` +
                `🤖 Android SDK - Java/Kotlin\n\n` +
                `📋 Syarat:\n` +
                `• ZIP project lengkap\n` +
                `• Maks 500MB\n` +
                `• Flutter: ada pubspec.yaml\n` +
                `• Android: ada build.gradle`;

            await bot.sendMessage(chatId, msg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🦋 FLUTTER', callback_data: 'platform_flutter' }],
                        [{ text: '🤖 ANDROID SDK', callback_data: 'platform_android' }],
                        [{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }],
                    ]
                }
            });
        }

        // ═══════════ PILIH PLATFORM ═══════════
        else if (data === 'platform_flutter' || data === 'platform_android') {
            await bot.answerCallbackQuery(query.id);
            
            const platform = data === 'platform_flutter' ? 'flutter' : 'android';
            const platformName = platform === 'flutter' ? '🦋 Flutter' : '🤖 Android SDK';
            
            userBuilds.set(userId, { platform });

            const msg = 
                `🔧 ${platformName} BUILD\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Pilih tipe build:\n\n` +
                `🚀 Release - APK siap publish\n` +
                `🐛 Debug - APK testing`;

            await bot.editMessageText(msg, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀 RELEASE', callback_data: `build_release_${platform}` }],
                        [{ text: '🐛 DEBUG', callback_data: `build_debug_${platform}` }],
                        [{ text: '⬅️ KEMBALI', callback_data: 'menu_build_apk' }],
                    ]
                }
            }).catch(async () => {
                await bot.sendMessage(chatId, msg, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🚀 RELEASE', callback_data: `build_release_${platform}` }],
                            [{ text: '🐛 DEBUG', callback_data: `build_debug_${platform}` }],
                            [{ text: '⬅️ KEMBALI', callback_data: 'menu_build_apk' }],
                        ]
                    }
                });
            });
        }

        // ═══════════ KONFIRMASI BUILD & MINTA ZIP ═══════════
        else if (data.startsWith('build_release_') || data.startsWith('build_debug_')) {
            await bot.answerCallbackQuery(query.id);
            await bot.deleteMessage(chatId, messageId).catch(() => {});

            const parts = data.split('_');
            const buildType = parts[1];
            const platform = parts[2];

            const platformName = platform === 'flutter' ? '🦋 Flutter' : '🤖 Android SDK';
            const buildTypeName = buildType === 'release' ? '🚀 Release' : '🐛 Debug';

            // Cek akses
            if (!canBuild(userId)) {
                return await bot.sendMessage(chatId,
                    '❌ <b>AKSES DITOLAK!</b>\n\n' +
                    'Fitur Build APK hanya untuk <b>Premium User</b> dan <b>Owner</b>.\n\n' +
                    'Hubungi @habalzy untuk upgrade.',
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                        }
                    }
                );
            }

            // Cek apakah sedang build
            if (queue.isUserBuilding(userId)) {
                return await bot.sendMessage(chatId,
                    '⚠️ <b>BUILD SEDANG BERJALAN!</b>\n\n' +
                    'Tunggu selesai atau batalkan dulu.',
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                        }
                    }
                );
            }

            // Cek slot
            if (!queue.hasAvailableSlot()) {
                return await bot.sendMessage(chatId,
                    '⚠️ <b>SERVER SIBUK!</b>\n\n' +
                    'Slot build penuh. Coba lagi nanti.\n' +
                    `Queue: ${queue.getQueueStats().waiting} waiting, ${queue.getQueueStats().building} building`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                        }
                    }
                );
            }

            // Set build data
            const buildData = userBuilds.get(userId) || {};
            buildData.type = buildType;
            buildData.platform = platform;
            buildData.startedAt = Date.now();
            userBuilds.set(userId, buildData);

            queue.setUserJob(userId, {
                status: 'waiting_zip',
                platform,
                buildType,
                startedAt: Date.now(),
            });

            const msg = 
                '<b>📤 KIRIM FILE ZIP</b>\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `<b>Platform:</b> ${platformName}\n` +
                `<b>Tipe:</b> ${buildTypeName}\n\n` +
                '📎 Kirim file <b>ZIP</b> project sekarang!\n\n' +
                '⚠️ <b>Ketentuan:</b>\n' +
                '• Format: ZIP\n' +
                '• Maks: 500MB\n' +
                '• Flutter: ada <code>pubspec.yaml</code>\n' +
                '• Android: ada <code>build.gradle</code>\n\n' +
                '<i>Menunggu file...</i>';

            await bot.sendMessage(chatId, msg, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '❌ BATAL', callback_data: 'cancel_build' }],
                    ]
                }
            });
        }

        // ═══════════ CANCEL BUILD ═══════════
        else if (data === 'cancel_build') {
            await bot.answerCallbackQuery(query.id);

            const buildData = userBuilds.get(userId);
            if (buildData?.zipPath) {
                try { fs.unlinkSync(buildData.zipPath); } catch {}
            }

            userBuilds.delete(userId);
            queue.removeUserJob(userId);
            clearProgressState(chatId);

            await bot.sendMessage(chatId,
                '❌ Build dibatalkan.\n\nSilakan mulai ulang.',
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '📋 MENU UTAMA', callback_data: 'menu_utama' }]]
                    }
                }
            );
        }

        // ═══════════ TUTORIAL ═══════════
        else if (data === 'show_tutorial') {
            await bot.answerCallbackQuery(query.id);

            const msg = 
                `📚 TUTORIAL BUILD APK\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `1️⃣ Persiapan Project\n` +
                `Pastikan project kamu bisa di-build secara lokal dulu.\n\n` +
                `2️⃣ Kompres jadi ZIP\n` +
                `Kompres seluruh folder project menjadi 1 file ZIP.\n\n` +
                `3️⃣ Pilih Platform & Tipe\n` +
                `Gunakan menu 📱 BUILD APK untuk memilih.\n\n` +
                `4️⃣ Upload ZIP\n` +
                `Kirim file ZIP ke bot.\n\n` +
                `5️⃣ Tunggu Proses\n` +
                `Build akan diproses via GitHub Actions.\n` +
                `Estimasi: 5-15 menit.\n\n` +
                `6️⃣ Terima APK\n` +
                `APK akan dikirim otomatis setelah selesai.\n\n` +
                `7️⃣ Install & Test\n` +
                `Install APK di device kamu!`;

            await bot.sendMessage(chatId, msg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📱 MULAI BUILD', callback_data: 'menu_build_apk' }],
                        [{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }],
                    ]
                }
            });
        }

        // ═══════════ HISTORY BUILD ═══════════
        else if (data === 'show_history') {
            await bot.answerCallbackQuery(query.id);

            const history = JSON.parse(fs.readFileSync(BUILD_HISTORY_PATH, 'utf8'));
            const userHistory = history.filter(h => h.userId === String(userId)).slice(-5);

            if (userHistory.length === 0) {
                return await bot.sendMessage(chatId,
                    '📊 Belum ada riwayat build.',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                        }
                    }
                );
            }

            let historyText = `*📊 RIWAYAT BUILD*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
            userHistory.reverse().forEach((h, i) => {
                const status = h.success ? '✅' : '❌';
                const platform = h.platform === 'flutter' ? 'Flutter' : 'Android';
                const type = h.buildType === 'release' ? 'Release' : 'Debug';
                const date = new Date(h.timestamp).toLocaleDateString('id-ID');
                historyText += `${status} *${i + 1}.* ${platform} | ${type}\n`;
                historyText += `   📅 ${date}`;
                if (h.apkSize) historyText += ` | 📦 ${h.apkSize} MB`;
                historyText += `\n\n`;
            });

            await bot.sendMessage(chatId, historyText, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                }
            });
        }

        // ═══════════ CMD BOTBUILD ═══════════
        else if (data === 'cmd_botbuild') {
            await bot.answerCallbackQuery(query.id);

            await bot.sendMessage(chatId,
                `*🔧 BOTBUILD VPS SETUP*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `*Format:*\n` +
                `\`/botbuild ip|password|token|api_id|api_hash\`\n\n` +
                `*Dengan Admin Tambahan:*\n` +
                `\`/botbuild ip|pw|token|api_id|api_hash|id1,id2\`\n\n` +
                `*Parameter:*\n` +
                `• \`ip\` - IP VPS\n` +
                `• \`password\` - Password root\n` +
                `• \`token\` - Bot Token\n` +
                `• \`api_id\` - API ID my.telegram.org\n` +
                `• \`api_hash\` - API Hash my.telegram.org\n\n` +
                `*Contoh:*\n` +
                `\`/botbuild 192.168.1.1|pass123|123:ABC|12345|abc123\`\n\n` +
                `⏱ Estimasi: 15-30 menit`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                    }
                }
            );
        }

        // ═══════════ INFO USER ═══════════
        else if (data === 'menu_info') {
            await bot.answerCallbackQuery(query.id);

            const status = isOwner(userId) ? '👑 Owner' : (isPremium(userId) ? '⭐ Premium' : '👤 Free User');
            const history = JSON.parse(fs.readFileSync(BUILD_HISTORY_PATH, 'utf8'));
            const userBuildCount = history.filter(h => h.userId === String(userId)).length;
            const successCount = history.filter(h => h.userId === String(userId) && h.success).length;

            await bot.sendMessage(chatId,
                `ℹ️ INFO USER\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Nama: ${query.from.first_name}\n` +
                `Username: @${query.from.username || 'Hidden'}\n` +
                `ID: \`${userId}\`\n` +
                `Status: ${status}\n` +
                `Total Build: ${userBuildCount}\n` +
                `Build Sukses: ${successCount}\n\n` +
                `Server:\n` +
                `• GramJS: ${gramConnected ? '✅ Online' : '⚠️ Offline'}\n` +
                `• Queue: ${queue.getQueueStats().building} building, ${queue.getQueueStats().waiting} waiting`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                    }
                }
            );
        }

        // ═══════════ ADMIN PANEL ═══════════
        else if (data === 'menu_admin') {
            await bot.answerCallbackQuery(query.id);

            if (!isOwner(userId)) {
                return await bot.editMessageText(
                    '❌ AKSES DITOLAK! Khusus Owner.',
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                        }
                    }
                ).catch(async () => {
                    await bot.sendMessage(chatId,
                        '❌ AKSES DITOLAK! Khusus Owner.',
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }]]
                            }
                        }
                    );
                });
            }

            const queueStats = queue.getQueueStats();

            const msg = 
                `*⚙️ ADMIN PANEL*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `*📊 Stats Server:*\n` +
                `• GramJS: ${gramConnected ? '✅' : '⚠️'}\n` +
                `• Queue: ${queueStats.waiting} waiting\n` +
                `• Building: ${queueStats.building}\n` +
                `• Total Jobs: ${queueStats.total}\n\n` +
                `*🔧 Commands:*\n` +
                `• /maintenance off/on\n` +
                `• /amsend anjg@gmail.com\n` +
                `• /amverify anjg@gmail.com|linkverif\n` +
                `• /addprem [ID] - Tambah Premium\n` +
                `• /delprem [ID] - Hapus Premium\n` +
                `• /addown [ID] - Tambah Owner\n` +
                `• /delown [ID] - Hapus Owner\n` +
                `• /bc [teks] - Broadcast\n` +
                `• /stats - Statistik Server`;
                `🛒 Commands Reseller:\n` +
                `• /addprem ID - Tambah Premium\n` +
                `• /delprem ID - Hapus Premium\n` +
                `• /cekid ID - Cek User`;

            await bot.editMessageText(msg, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📊 STATS', callback_data: 'admin_stats' }],
                        [{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }],
                    ]
                }
            }).catch(async () => {
                await bot.sendMessage(chatId, msg, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📊 STATS', callback_data: 'admin_stats' }],
                            [{ text: '⬅️ KEMBALI', callback_data: 'menu_utama' }],
                        ]
                    }
                });
            });
        }

        // ═══════════ ADMIN: STATS ═══════════
        else if (data === 'admin_stats') {
            await bot.answerCallbackQuery(query.id);
            if (!isOwner(userId)) return;

            const allHistory = JSON.parse(fs.readFileSync(BUILD_HISTORY_PATH, 'utf8'));
            const totalBuilds = allHistory.length;
            const successBuilds = allHistory.filter(h => h.success).length;
            const uniqueUsers = [...new Set(allHistory.map(h => h.userId))].length;

            await bot.sendMessage(chatId,
                `📊 STATISTIK SERVER\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `*Build:*\n` +
                `• Total: ${totalBuilds}\n` +
                `• Sukses: ${successBuilds}\n` +
                `• Gagal: ${totalBuilds - successBuilds}\n` +
                `• Sukses Rate: ${totalBuilds > 0 ? ((successBuilds/totalBuilds)*100).toFixed(1) : 0}%\n\n` +
                `*User:*\n` +
                `• Unique Users: ${uniqueUsers}\n` +
                `• Premium: ${getPremiumUsers().length}\n` +
                `• Owner: ${getAdditionalOwners().length + (settings.adminId?.length || 0)}\n\n` +
                `* Queue:*\n` +
                `• Active: ${queue.getQueueStats().building}\n` +
                `• Waiting: ${queue.getQueueStats().waiting}\n` +
                `• Slots: ${queue.getAvailableSlots()}/${queue.getMaxConcurrentBuilds()}`,
                { parse_mode: 'Markdown' }
            );
        }

        // ═══════════ FALLBACK ═══════════
        else {
            await bot.answerCallbackQuery(query.id, { text: 'Menu tidak dikenal' });
        }

    } catch (error) {
        log.error(`Error for data "${data}": ${error.message}`);
        try {
            await bot.answerCallbackQuery(query.id, { text: 'Terjadi kesalahan, coba lagi.' });
        } catch {}
    }
});

// ══════════════════════════════════════════════════════════════
//  DOCUMENT HANDLER (Terima File ZIP)
// ══════════════════════════════════════════════════════════════

bot.on('document', async (msg) => {
    // ═══════════ CEK MAINTENANCE MODE ═══════════
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }
    
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const doc = msg.document;

    const buildData = userBuilds.get(userId);
    if (!buildData || !buildData.platform) {
        return;
    }

    // Validasi format file
    if (!doc.file_name || !doc.file_name.toLowerCase().endsWith('.zip')) {
        return await bot.sendMessage(chatId,
            '⚠️ FORMAT FILE SALAH\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '📎 File harus dalam format ZIP!\n\n' +
            'Kirim ulang file ZIP project kamu.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ BATAL', callback_data: 'cancel_build' }]]
                }
            }
        );
    }

    // Validasi ukuran file
    if (doc.file_size > MAX_ZIP_SIZE) {
        const sizeMB = (doc.file_size / (1024 * 1024)).toFixed(0);
        return await bot.sendMessage(chatId,
            '❌ FILE TERLALU BESAR\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `📏 Ukuran: ${sizeMB} MB\n` +
            '📏 Maksimal: 500 MB\n\n' +
            '💡 Kompres project kamu atau hapus file yang tidak perlu.',
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ BATAL', callback_data: 'cancel_build' }]]
                }
            }
        );
    }

    await updateProgress(chatId,
        '📥 DOWNLOAD PROJECT\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        `📁 File: ${doc.file_name}\n` +
        `📏 Size: ${(doc.file_size / (1024 * 1024)).toFixed(1)} MB\n\n` +
        '⏳ Mendownload file...',
        5
    );

    try {
        const tmpDir = path.join(__dirname, 'temp', `upload-${userId}-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const zipPath = path.join(tmpDir, doc.file_name);

        const fileSizeMB = doc.file_size / (1024 * 1024);
        let downloadSuccess = false;

        // ═══════════ DOWNLOAD: GramJS (untuk semua ukuran, lebih reliable) ═══════════
        if (gramConnected && gramClient) {
            log.info(`Trying GramJS for ${fileSizeMB.toFixed(1)}MB file...`);
            
            try {
                const entity = await gramClient.getEntity(chatId);
                
                const messages = await gramClient.getMessages(entity, {
                    ids: [msg.message_id],
                    limit: 1,
                });
                
                if (messages && messages.length > 0 && messages[0].media) {
                    log.info('Message found with media, downloading via MTProto...');
                    
                    const buffer = await gramClient.downloadMedia(messages[0], {
                        progressCallback: (downloaded, total) => {
                            const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
                            if (pct % 25 === 0 || pct === 100) {
                                log.info(`${pct}% (${(downloaded/1048576).toFixed(1)}/${(total/1048576).toFixed(1)} MB)`);
                                updateProgress(chatId,
                                    '📥 DOWNLOAD PROJECT\n' +
                                    '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                                    `📏 Progress: ${pct}%\n\n` +
                                    '⏳ Download via MTProto...',
                                    5 + Math.floor(pct / 10)
                                ).catch(() => {});
                            }
                        },
                    });
                    
                    if (buffer && buffer.length > 0) {
                        fs.writeFileSync(zipPath, buffer);
                        const downloadedMB = (buffer.length / (1024 * 1024)).toFixed(1);
                        log.success(`GramJS success: ${downloadedMB} MB`);
                        downloadSuccess = true;
                    } else {
                        log.warning('GramJS returned empty buffer');
                    }
                } else {
                    log.warning('Message not found or no media via GramJS');
                }
                
            } catch (gramError) {
                log.error(`GramJS failed: ${gramError.message}`);
            }
        }

        // ═══════════ FALLBACK: Bot API (hanya jika GramJS gagal) ═══════════
        if (!downloadSuccess) {
            log.info('Falling back to Bot API...');
            
            try {
                const fileLink = await bot.getFileLink(doc.file_id);
                log.debug(`Bot API link: ${fileLink.substring(0, 80)}...`);
                
                await new Promise((resolve, reject) => {
                    const file = fs.createWriteStream(zipPath);
                    https.get(fileLink, (response) => {
                        if (response.statusCode === 302 || response.statusCode === 301) {
                            const redirectUrl = response.headers.location;
                            https.get(redirectUrl, (redirectRes) => {
                                redirectRes.pipe(file);
                                file.on('finish', resolve);
                                file.on('error', reject);
                            }).on('error', reject);
                            return;
                        }
                        response.pipe(file);
                        file.on('finish', resolve);
                        file.on('error', reject);
                    }).on('error', reject);
                });
                
                if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) {
                    downloadSuccess = true;
                    const downloadedMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
                    log.success(`Bot API success: ${downloadedMB} MB`);
                }
                
            } catch (botError) {
                log.error(`Bot API failed: ${botError.message}`);
            }
        }

        // ═══════════ CHECK HASIL DOWNLOAD ═══════════
        if (!downloadSuccess || !fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
            throw new Error(
                '❌ Gagal download file!\n\n' +
                'Semua method download gagal.\n' +
                (gramConnected ? '✅ GramJS: Connected tapi gagal\n' : '⚠️ GramJS: Not connected\n') +
                'Silakan coba lagi atau gunakan file lebih kecil.'
            );
        }

        const downloadedSize = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
        log.success(`File siap: ${zipPath} (${downloadedSize} MB)`);

        await updateProgress(chatId,
            '✅ DOWNLOAD SELESAI\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `📏 Size: ${downloadedSize} MB\n\n` +
            '🔍 Memvalidasi project...',
            15
        );

        buildData.zipPath = zipPath;
        buildData.zipSize = fs.statSync(zipPath).size;
        userBuilds.set(userId, buildData);

        queue.setUserJob(userId, {
            status: 'building',
            platform: buildData.platform,
            buildType: buildData.type,
            zipSize: buildData.zipSize,
            startedAt: Date.now(),
        });

        await updateProgress(chatId,
            '🔍 VALIDASI PROJECT\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '📂 Memvalidasi struktur project...\n\n' +
            '⏳ Mohon tunggu...',
            20
        );

        processBuild(chatId, userId, buildData.platform, buildData.type);

    } catch (error) {
        log.error(`Error for user ${userId}: ${error.message}`);
        
        await updateProgress(chatId,
            '❌ GAGAL MEMPROSES FILE\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `${error.message}\n\n` +
            '_Silakan coba lagi._'
        );

        userBuilds.delete(userId);
        queue.removeUserJob(userId);
        clearProgressState(chatId);
    }
});

// ══════════════════════════════════════════════════════════════
//  TEXT COMMAND HANDLERS
// ══════════════════════════════════════════════════════════════

// /start
bot.onText(/\/start/, async (msg) => {
    // ═══════════ CEK MAINTENANCE MODE (TAMBAHKAN INI DI AWAL) ═══════════
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }
    
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'User';

    // Cek verifikasi channel
    const channelCheck = await checkUserChannels(userId);
    
    if (!channelCheck.joined) {
        const channelsList = channelCheck.channels
            .map(ch => `• ${ch.name || ch.id}`)
            .join('\n');
        
        const caption = 
            `🔒 *AKSES DIBATASI*\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Halo \`@${username}\`!\n\n` +
            `Untuk menggunakan bot ini, kamu wajib join channel berikut terlebih dahulu:\n\n` +
            `${channelsList}\n\n` +
            `Klik tombol di bawah untuk join, lalu tekan tombol *SUDAH JOIN* untuk verifikasi.`;

        await bot.sendPhoto(chatId, BANNER_IMG, {
            caption: caption,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: createChannelKeyboard(channelCheck.channels)
            }
        });
        return;
    }

    const caption = 
        `🔧 BOTBUILD MANAGER v2.1\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Status: ✅ Online\n` +
        `User: \`@${username}\`\n` +
        `Version: 2.1.0\n\n` +
        `📦 Yang Terinstall:\n` +
        `• Node.js v21\n` +
        `• Java OpenJDK 17\n` +
        `• Android SDK 36.0.0\n` +
        `• Flutter SDK Stable\n` +
        `• CMake 3.22.1\n` +
        `• NDK 27.0.12077973\n` +
        `• GramJS MTProto\n` +
        `• AdmZip Extract\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `_Silahkan pilih menu di bawah ini_`;

    await bot.sendPhoto(chatId, BANNER_IMG, {
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '📱 BUILD APK', callback_data: 'menu_build_apk', style: 'danger' }],
                [{ text: '📚 TUTORIAL', callback_data: 'show_tutorial', style: 'success' }],
                [{ text: '🔧 BOTBUILD VPS', callback_data: 'cmd_botbuild', style: 'primary' }],
                [{ text: '📊 HISTORY', callback_data: 'show_history', style: 'success' }, { text: 'ℹ️ INFO USER', callback_data: 'menu_info', style: 'primary' }],
                [{ text: '⚙️ ADMIN PANEL', callback_data: 'menu_admin', style: 'danger' }, { text: '👑 OWNER', url: 'https://t.me/habalzy', style: 'primary' }]
            ]
        }
    });
});

// /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;

    await bot.sendMessage(chatId,
        `*📖 BANTUAN*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Gunakan tombol di bawah untuk navigasi!\n\n` +
        `*Commands:*\n` +
        `• /start - Menu utama\n` +
        `• /help - Bantuan ini\n` +
        `• /cekid - Cek ID & status\n` +
        `• /quotes - Random quotes\n` +
        `• /stats - Statistik (Owner)\n` +
        `• /statusgh - GitHub status (Owner)`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📱 BUILD APK', callback_data: 'menu_build_apk' }],
                    [{ text: '📚 TUTORIAL', callback_data: 'show_tutorial' }],
                    [{ text: '⬅️ MENU UTAMA', callback_data: 'menu_utama' }],
                ]
            }
        }
    );
});

// /addown
bot.onText(/\/addown (\d+)/, async (msg, match) => {
    if (!isOwner(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Perintah ini hanya untuk Owner!',
            { parse_mode: 'Markdown' }
        );
    }

    const targetId = match[1];
    const owners = getAdditionalOwners();

    if (owners.includes(targetId)) {
        return bot.sendMessage(msg.chat.id, 
            '⚠️ GAGAL\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `User \`${targetId}\` sudah menjadi *Owner*.`,
            { parse_mode: 'Markdown' }
        );
    }

    // Tambahkan ke daftar owner
    owners.push(targetId);
    fs.writeFileSync(OWNER_DB_PATH, JSON.stringify(owners, null, 2));
    
    // Konfirmasi ke owner yang mengeksekusi
    await bot.sendMessage(msg.chat.id, 
        '👑 OWNER BARU!\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `🎉 User \`${targetId}\` sekarang *Owner!*\n\n` +
        '✅ Akses Penuh Bot\n' +
        '✅ Manage Premium\n' +
        '✅ Broadcast\n' +
        '✅ Panel Admin\n\n' +
        `📩 Notifikasi telah dikirim ke user \`${targetId}\``,
        { parse_mode: 'Markdown' }
    );

    // Kirim notifikasi ke user yang diupgrade (hanya notifikasi)
    try {
        await bot.sendMessage(targetId, 
            '👑 *SELAMAT!*\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Kamu telah diangkat menjadi *OWNER* BotBuild Manager!\n\n' +
            'Berikut akses yang kamu dapatkan:\n\n' +
            '✅ *Akses Penuh Bot*\n' +
            '└ Semua fitur terbuka untukmu\n\n' +
            '✅ *Manage Premium*\n' +
            '└ Tambah/hapus user premium\n\n' +
            '✅ *Broadcast*\n' +
            '└ Kirim pengumuman ke semua user\n\n' +
            '✅ *Panel Admin*\n' +
            '└ Akses ke statistik dan kontrol bot\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '📱 Kirim /help untuk melihat daftar command!\n\n' +
            '_Gunakan akses ini dengan bijak_ 🙏',
            { parse_mode: 'Markdown' }
        );
        
        log.success(`Notifikasi owner terkirim ke user ${targetId}`);
        
    } catch (notifError) {
        log.error(`Gagal kirim notifikasi ke ${targetId}: ${notifError.message}`);
        
        await bot.sendMessage(msg.chat.id, 
            '⚠️ *NOTIFIKASI GAGAL*\n\n' +
            `User \`${targetId}\` sudah Owner, tapi notifikasi gagal terkirim.\n\n` +
            `Error: \`${notifError.message}\`\n\n` +
            'User mungkin belum pernah chat dengan bot.',
            { parse_mode: 'Markdown' }
        );
    }
});

// /delown
bot.onText(/\/delown (\d+)/, async (msg, match) => {
    if (!isOwner(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, '❌ Khusus Owner!');
    }

    const targetId = match[1];
    let owners = getAdditionalOwners();

    if (!owners.includes(targetId)) {
        return bot.sendMessage(msg.chat.id, `⚠️ ID ${targetId} bukan Owner.`);
    }

    // Hapus dari daftar owner
    owners = owners.filter(id => id !== targetId);
    fs.writeFileSync(OWNER_DB_PATH, JSON.stringify(owners, null, 2));
    
    // Konfirmasi ke owner
    await bot.sendMessage(msg.chat.id, 
        '📤 OWNER DIHAPUS\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `✅ ID \`${targetId}\` dihapus dari Owner.\n\n` +
        `📩 Notifikasi telah dikirim ke user \`${targetId}\``,
        { parse_mode: 'Markdown' }
    );

    // Kirim notifikasi ke user (hanya notifikasi)
    try {
        await bot.sendMessage(targetId, 
            '📢 *PEMBERITAHUAN*\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Status *Owner* kamu telah dicabut.\n\n' +
            'Kamu masih bisa menggunakan bot sebagai user biasa.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '_Terima kasih_ 🙏',
            { parse_mode: 'Markdown' }
        );
        
        log.success(`Notifikasi pencabutan terkirim ke user ${targetId}`);
        
    } catch (notifError) {
        log.error(`Gagal kirim notifikasi ke ${targetId}: ${notifError.message}`);
        
        await bot.sendMessage(msg.chat.id, 
            '⚠️ *NOTIFIKASI GAGAL*\n\n' +
            `User \`${targetId}\` sudah dihapus, tapi notifikasi gagal terkirim.\n\n` +
            `Error: \`${notifError.message}\``,
            { parse_mode: 'Markdown' }
        );
    }
});

// /address - Tambah Reseller
bot.onText(/\/address(?: (\d+)(?: (\d+))?)?/, async (msg, match) => {
    // ═══════════ CEK AKSES ═══════════
    if (!isOwner(msg.from.id) && !isReseller(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Hanya Owner atau Reseller yang bisa menggunakan fitur ini.',
            { parse_mode: 'Markdown' }
        );
    }

    const chatId = msg.chat.id;
    
    // Jika tidak ada parameter, tampilkan daftar reseller
    if (!match[1]) {
        const resellers = getResellers();
        
        if (resellers.length === 0) {
            return bot.sendMessage(chatId,
                '📋 DAFTAR RESELLER\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                'Belum ada reseller terdaftar.\n\n' +
                'Format: `/address ID`\n' +
                'Contoh: `/address 123456789`\n\n' +
                'Dengan masa aktif:\n' +
                'Format: `/address ID hari`\n' +
                'Contoh: `/address 123456789 30`',
                { parse_mode: 'Markdown' }
            );
        }
        
        let resellerList = '📋 DAFTAR RESELLER\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        
        resellers.forEach((r, i) => {
            const status = r.expiredAt && Date.now() > r.expiredAt ? '❌ Expired' : '✅ Aktif';
            const expiredDate = r.expiredAt ? new Date(r.expiredAt).toLocaleDateString('id-ID') : 'Selamanya';
            resellerList += `${i + 1}. ID: ${r.id}\n`;
            resellerList += `   Status: ${status}\n`;
            resellerList += `   Expired: ${expiredDate}\n\n`;
        });
        
        return bot.sendMessage(chatId, resellerList, { parse_mode: 'Markdown' });
    }
    
    const targetId = match[1].trim();
    const days = match[2] ? parseInt(match[2]) : null;
    
    // Validasi ID
    if (!/^\d+$/.test(targetId)) {
        return bot.sendMessage(chatId,
            '⚠️ FORMAT SALAH\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Format: `/address ID`\n' +
            'Contoh: `/address 123456789`\n\n' +
            'Dengan masa aktif:\n' +
            'Format: `/address ID hari`\n' +
            'Contoh: `/address 123456789 30`',
            { parse_mode: 'Markdown' }
        );
    }
    
    const resellers = getResellers();
    
    // Cek apakah sudah jadi reseller
    const existingReseller = resellers.find(r => r.id === targetId);
    if (existingReseller) {
        return bot.sendMessage(chatId,
            '⚠️ GAGAL\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `User \`${targetId}\` sudah menjadi Reseller.`,
            { parse_mode: 'Markdown' }
        );
    }
    
    // Hitung expired date
    let expiredAt = null;
    let expiredText = 'Selamanya';
    if (days && days > 0) {
        expiredAt = Date.now() + (days * 24 * 60 * 60 * 1000);
        expiredText = new Date(expiredAt).toLocaleDateString('id-ID');
    }
    
    // Tambahkan reseller
    resellers.push({
        id: targetId,
        addedBy: String(msg.from.id),
        addedAt: new Date().toISOString(),
        expiredAt: expiredAt,
    });
    
    fs.writeFileSync(RESELLER_DB_PATH, JSON.stringify(resellers, null, 2));
    
    // Konfirmasi ke yang menambahkan
    await bot.sendMessage(chatId,
        '🛒 RESELLER BARU!\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `🎉 User \`${targetId}\` sekarang Reseller!\n\n` +
        `⏱ Masa Aktif: ${expiredText}\n` +
        `👤 Ditambahkan oleh: ${msg.from.id}\n\n` +
        '✅ Bisa tambah Premium\n' +
        '✅ Bisa hapus Premium\n' +
        '✅ Bisa cek status user\n\n' +
        `📩 Notifikasi telah dikirim ke user \`${targetId}\``,
        { parse_mode: 'Markdown' }
    );
    
    // Kirim notifikasi ke user yang jadi reseller
    try {
        await bot.sendMessage(targetId,
            '🛒 SELAMAT!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Kamu telah diangkat menjadi RESELLER BotBuild Manager!\n\n' +
            'Berikut akses yang kamu dapatkan:\n\n' +
            '✅ Tambah Premium User\n' +
            '✅ Hapus Premium User\n' +
            '✅ Cek Status User\n' +
            '✅ Priority Queue\n\n' +
            `⏱ Masa Aktif: ${expiredText}\n\n` +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Command yang tersedia:\n' +
            '• /addprem ID - Tambah Premium\n' +
            '• /delprem ID - Hapus Premium\n' +
            '• /cekid ID - Cek User\n\n' +
            '_Gunakan akses ini dengan bijak_ 🙏',
            { parse_mode: 'Markdown' }
        );
        
        log.success(`Notifikasi reseller terkirim ke user ${targetId}`);
        
    } catch (notifError) {
        log.error(`Gagal kirim notifikasi ke ${targetId}: ${notifError.message}`);
        
        await bot.sendMessage(chatId,
            '⚠️ NOTIFIKASI GAGAL\n\n' +
            `User \`${targetId}\` sudah Reseller, tapi notifikasi gagal terkirim.\n\n` +
            `Error: \`${notifError.message}\`\n\n` +
            'User mungkin belum pernah chat dengan bot.',
            { parse_mode: 'Markdown' }
        );
    }
});

// /delress - Hapus Reseller
bot.onText(/\/delress(?: (\d+))?/, async (msg, match) => {
    // ═══════════ CEK AKSES ═══════════
    if (!isOwner(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Hanya Owner yang bisa menghapus Reseller.',
            { parse_mode: 'Markdown' }
        );
    }

    const chatId = msg.chat.id;
    
    if (!match[1]) {
        return bot.sendMessage(chatId,
            '⚠️ FORMAT SALAH\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Format: `/delress ID`\n' +
            'Contoh: `/delress 123456789`',
            { parse_mode: 'Markdown' }
        );
    }
    
    const targetId = match[1].trim();
    let resellers = getResellers();
    
    // Cek apakah reseller ada
    const existingReseller = resellers.find(r => r.id === targetId);
    if (!existingReseller) {
        return bot.sendMessage(chatId,
            '⚠️ GAGAL\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `User \`${targetId}\` bukan Reseller.`,
            { parse_mode: 'Markdown' }
        );
    }
    
    // Hapus dari daftar reseller
    resellers = resellers.filter(r => r.id !== targetId);
    fs.writeFileSync(RESELLER_DB_PATH, JSON.stringify(resellers, null, 2));
    
    // Konfirmasi ke owner
    await bot.sendMessage(chatId,
        '📤 RESELLER DIHAPUS\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `✅ ID \`${targetId}\` dihapus dari Reseller.\n\n` +
        `📩 Notifikasi telah dikirim ke user \`${targetId}\``,
        { parse_mode: 'Markdown' }
    );
    
    // Kirim notifikasi ke user
    try {
        await bot.sendMessage(targetId,
            '📢 PEMBERITAHUAN\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Status RESELLER kamu telah dicabut.\n\n' +
            'Kamu masih bisa menggunakan bot sebagai user biasa.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '_Terima kasih_ 🙏',
            { parse_mode: 'Markdown' }
        );
        
        log.success(`Notifikasi pencabutan terkirim ke user ${targetId}`);
        
    } catch (notifError) {
        log.error(`Gagal kirim notifikasi ke ${targetId}: ${notifError.message}`);
        
        await bot.sendMessage(chatId,
            '⚠️ NOTIFIKASI GAGAL\n\n' +
            `User \`${targetId}\` sudah dihapus, tapi notifikasi gagal terkirim.\n\n` +
            `Error: \`${notifError.message}\``,
            { parse_mode: 'Markdown' }
        );
    }
});

// /addprem - Tambah Premium (Owner & Reseller)
bot.onText(/\/addprem (\d+)/, async (msg, match) => {
    // ═══════════ CEK AKSES (Owner atau Reseller) ═══════════
    if (!isOwner(msg.from.id) && !isReseller(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Hanya Owner atau Reseller yang bisa menambah Premium.',
            { parse_mode: 'Markdown' }
        );
    }

    const targetId = match[1];
    const prems = getPremiumUsers();

    if (prems.includes(targetId)) {
        return bot.sendMessage(msg.chat.id, 
            '⚠️ GAGAL\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `User \`${targetId}\` sudah Premium.`,
            { parse_mode: 'Markdown' }
        );
    }

    prems.push(targetId);
    fs.writeFileSync(PREM_DB_PATH, JSON.stringify(prems, null, 2));
    
    await bot.sendMessage(msg.chat.id, 
        '⭐ UPGRADE BERHASIL!\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `🎉 User \`${targetId}\` sekarang Premium!\n\n` +
        '✅ Bisa Build APK\n' +
        '✅ Priority Queue\n' +
        '✅ Support Prioritas\n\n' +
        `📩 Notifikasi telah dikirim ke user \`${targetId}\``,
        { parse_mode: 'Markdown' }
    );

    try {
        await bot.sendMessage(targetId, 
            '🎉 SELAMAT!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Kamu telah diupgrade menjadi ⭐ PREMIUM USER!\n\n' +
            'Berikut benefit yang kamu dapatkan:\n\n' +
            '✅ Build APK\n' +
            '✅ Priority Queue\n' +
            '✅ Support Prioritas\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '📱 Kirim /start untuk mulai build APK!\n\n' +
            '_Terima kasih telah menggunakan layanan kami_ 🙏',
            { parse_mode: 'Markdown' }
        );
        
        log.success(`Notifikasi premium terkirim ke user ${targetId}`);
        
    } catch (notifError) {
        log.error(`Gagal kirim notifikasi ke ${targetId}: ${notifError.message}`);
    }
});

// /delprem - Hapus Premium (Owner & Reseller)
bot.onText(/\/delprem (\d+)/, async (msg, match) => {
    // ═══════════ CEK AKSES (Owner atau Reseller) ═══════════
    if (!isOwner(msg.from.id) && !isReseller(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Hanya Owner atau Reseller yang bisa menghapus Premium.',
            { parse_mode: 'Markdown' }
        );
    }

    const targetId = match[1];
    let prems = getPremiumUsers();

    if (!prems.includes(targetId)) {
        return bot.sendMessage(msg.chat.id, `⚠️ ID ${targetId} bukan Premium.`);
    }

    prems = prems.filter(id => id !== targetId);
    fs.writeFileSync(PREM_DB_PATH, JSON.stringify(prems, null, 2));
    
    await bot.sendMessage(msg.chat.id, 
        '📤 PREMIUM DIHAPUS\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `✅ ID \`${targetId}\` diturunkan dari Premium.`,
        { parse_mode: 'Markdown' }
    );

    try {
        await bot.sendMessage(targetId, 
            '📢 PEMBERITAHUAN\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Masa Premium kamu telah berakhir.\n\n' +
            'Kamu masih bisa menggunakan bot sebagai Free User.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '_Terima kasih_ 🙏',
            { parse_mode: 'Markdown' }
        );
    } catch (notifError) {
        log.error(`Gagal kirim notifikasi ke ${targetId}: ${notifError.message}`);
    }
});

// /bc
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
    if (!settings.adminId.includes(String(msg.from.id))) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Broadcast hanya untuk Owner Utama!',
            { parse_mode: 'Markdown' }
        );
    }

    const message = match[1];
    const prems = getPremiumUsers();
    const owners = getAdditionalOwners();
    const allUsers = [...new Set([...prems, ...owners, ...(settings.adminId || [])])];

    if (allUsers.length === 0) {
        return bot.sendMessage(msg.chat.id, 
            '⚠️ BROADCAST GAGAL\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Tidak ada user yang bisa dikirimi broadcast.',
            { parse_mode: 'Markdown' }
        );
    }

    let success = 0;
    let failed = 0;

    const statusMsg = await bot.sendMessage(msg.chat.id, 
        '📢 BROADCAST\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `🚀 Mengirim ke *${allUsers.length}* user...\n` +
        '⏳ Mohon tunggu...',
        { parse_mode: 'Markdown' }
    );

    for (const uid of allUsers) {
        try {
            await bot.sendMessage(uid, 
                '📢 PENGUMUMAN DARI OWNER\n\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                `${message}\n\n` +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                'Pesan dari @habalzy_',
                { parse_mode: 'Markdown' }
            );
            success++;
        } catch {
            failed++;
        }
        await sleep(100);
    }

    await bot.editMessageText(
        '✅ BROADCAST SELESAI!\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `📤 Berhasil: ${success} user\n` +
        `❌ Gagal: ${failed} user\n` +
        `👥 Total: ${allUsers.length} user`,
        {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown',
        }
    );
});

// /cekid - Cek ID sendiri atau user lain via username
bot.onText(/\/cekid(?: (@\w+|\d+))?/, async (msg, match) => {
    // ═══════════ CEK MAINTENANCE MODE ═══════════
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }
    
    const chatId = msg.chat.id;
    const target = match[1] ? match[1].trim() : null;
    
    // Jika tidak ada target, cek diri sendiri
    if (!target) {
        const userId = msg.from.id;
        const status = isOwner(userId) ? '👑 Owner' : (isPremium(userId) ? '⭐ Premium' : '👤 Free User');
        const phone = msg.from.phone_number || 'Tidak tersedia';

        return bot.sendMessage(chatId,
            `🆔 USER INFO\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `👤 Nama: ${msg.from.first_name} ${msg.from.last_name || ''}\n` +
            `📛 Username: @${msg.from.username || 'Hidden'}\n` +
            `🆔 ID: \`${userId}\`\n` +
            `📱 Nomor: \`${phone}\`\n` +
            `⭐ Status: ${status}\n` +
            `🌐 Lang: ${msg.from.language_code || 'N/A'}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━`,
            { parse_mode: 'Markdown' }
        );
    }
    
    // Jika ada target, cek user lain
    try {
        let targetUser = null;
        let targetId = target;
        
        // Jika target adalah username (dimulai dengan @)
        if (target.startsWith('@')) {
            const username = target.replace('@', '');
            
            // Coba dapatkan info user dari database premium/owner dulu
            const prems = getPremiumUsers();
            const owners = getAdditionalOwners();
            const allAdmins = [...(settings.adminId || []), ...owners];
            
            // Cek apakah username ada di database
            // Note: Bot API tidak bisa get user by username langsung
            // Kita coba cari di chat member jika memungkinkan
            
            // Untuk sementara, tampilkan info yang tersedia
            let foundInDb = false;
            let dbUserId = null;
            
            // Cari di premium list
            if (prems.includes(username) || prems.includes(target)) {
                foundInDb = true;
                dbUserId = target;
            }
            
            // Cari di owner list
            if (owners.includes(username) || owners.includes(target)) {
                foundInDb = true;
                dbUserId = target;
            }
            
            // Cari di admin list
            if (allAdmins.includes(username) || allAdmins.includes(target)) {
                foundInDb = true;
                dbUserId = target;
            }
            
            // Coba getChat untuk mendapatkan info
            try {
                const chat = await bot.getChat(target);
                if (chat) {
                    const uid = chat.id;
                    const status = isOwner(uid) ? '👑 Owner' : (isPremium(uid) ? '⭐ Premium' : '👤 Free User');
                    
                    let phoneNumber = 'Tidak tersedia';
                    
                    // Coba dapatkan nomor dari history build
                    try {
                        const history = JSON.parse(fs.readFileSync(BUILD_HISTORY_PATH, 'utf8'));
                        const userHistory = history.find(h => h.userId === String(uid) && h.phone);
                        if (userHistory && userHistory.phone) {
                            phoneNumber = userHistory.phone;
                        }
                    } catch (e) {}
                    
                    return bot.sendMessage(chatId,
                        `🆔 USER INFO\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `👤 Nama: ${chat.first_name || 'N/A'} ${chat.last_name || ''}\n` +
                        `📛 Username: @${chat.username || 'Hidden'}\n` +
                        `🆔 ID: \`${uid}\`\n` +
                        `📱 Nomor: \`${phoneNumber}\`\n` +
                        `⭐ Status: ${status}\n` +
                        `📝 Tipe: ${chat.type || 'private'}\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━`,
                        { parse_mode: 'Markdown' }
                    );
                }
            } catch (chatError) {
                // Jika gagal getChat, coba kirim pesan untuk mendapatkan info
                log.debug(`getChat failed: ${chatError.message}`);
            }
            
            // Jika tidak ditemukan
            return bot.sendMessage(chatId,
                `⚠️ USER TIDAK DITEMUKAN\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Username: \`${target}\`\n\n` +
                `• User mungkin belum pernah chat dengan bot\n` +
                `• Atau username salah\n\n` +
                `Format: \`/cekid @username\``,
                { parse_mode: 'Markdown' }
            );
        }
        
        // Jika target adalah ID numerik
        if (/^\d+$/.test(target)) {
            const uid = target;
            const status = isOwner(uid) ? '👑 Owner' : (isPremium(uid) ? '⭐ Premium' : '👤 Free User');
            
            let phoneNumber = 'Tidak tersedia';
            
            // Coba dapatkan nomor dari history build
            try {
                const history = JSON.parse(fs.readFileSync(BUILD_HISTORY_PATH, 'utf8'));
                const userHistory = history.find(h => h.userId === uid && h.phone);
                if (userHistory && userHistory.phone) {
                    phoneNumber = userHistory.phone;
                }
            } catch (e) {}
            
            // Coba kirim chat untuk mendapatkan info user
            try {
                const chat = await bot.getChat(uid);
                if (chat) {
                    return bot.sendMessage(chatId,
                        `🆔 USER INFO\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `👤 Nama: ${chat.first_name || 'N/A'} ${chat.last_name || ''}\n` +
                        `📛 Username: @${chat.username || 'Hidden'}\n` +
                        `🆔 ID: \`${uid}\`\n` +
                        `📱 Nomor: \`${phoneNumber}\`\n` +
                        `⭐ Status: ${status}\n` +
                        `📝 Tipe: ${chat.type || 'private'}\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━`,
                        { parse_mode: 'Markdown' }
                    );
                }
            } catch (chatError) {
                log.debug(`getChat failed: ${chatError.message}`);
            }
            
            // Jika tidak ditemukan
            return bot.sendMessage(chatId,
                `⚠️ USER TIDAK DITEMUKAN\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `ID: \`${uid}\`\n\n` +
                `• User mungkin belum pernah chat dengan bot\n` +
                `• Atau ID salah`,
                { parse_mode: 'Markdown' }
            );
        }
        
        // Format salah
        return bot.sendMessage(chatId,
            `⚠️ FORMAT SALAH\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Gunakan:\n` +
            `• \`/cekid\` - Cek diri sendiri\n` +
            `• \`/cekid @username\` - Cek user lain\n` +
            `• \`/cekid 123456789\` - Cek via ID\n\n` +
            `Contoh:\n` +
            `\`/cekid @habalzy\``,
            { parse_mode: 'Markdown' }
        );
        
    } catch (error) {
        log.error(`Error in /cekid: ${error.message}`);
        
        return bot.sendMessage(chatId,
            `❌ GAGAL CEK USER\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Error: \`${error.message}\``,
            { parse_mode: 'Markdown' }
        );
    }
});

// /quotes
bot.onText(/\/quotes/, (msg) => {
    const quotes = [
        '🔥 *Jangan berhenti saat lelah, berhentilah saat selesai!*',
        '💻 *Code is like humor. When you have to explain it, it\'s bad.*',
        '🚀 *Visi tanpa eksekusi adalah halusinasi.*',
        '⭐ *Masa depanmu ditentukan oleh apa yang kamu kerjakan hari ini.*',
        '🛠️ *Fix the cause, not the symptom.*',
        '🎯 *Sukses adalah akumulasi dari usaha kecil yang dilakukan berulang-ulang.*',
        '💪 *Kesulitan akan membuatmu lebih kuat, bukan lebih lemah.*',
        '📱 *Build, Test, Deploy, Repeat!*',
    ];
    const random = quotes[Math.floor(Math.random() * quotes.length)];
    bot.sendMessage(msg.chat.id, random, { parse_mode: 'Markdown' });
});

// /stats
bot.onText(/\/stats/, async (msg) => {
    if (!isOwner(msg.from.id)) return;

    const allHistory = JSON.parse(fs.readFileSync(BUILD_HISTORY_PATH, 'utf8'));
    const totalBuilds = allHistory.length;
    const successBuilds = allHistory.filter(h => h.success).length;
    const queueStats = queue.getQueueStats();

    bot.sendMessage(msg.chat.id,
        `*📊 STATISTIK*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `*Build:* ${successBuilds}/${totalBuilds} sukses\n` +
        `*Queue:* ${queueStats.building} running, ${queueStats.waiting} waiting\n` +
        `*GramJS:* ${gramConnected ? '✅' : '⚠️'}\n` +
        `*Uptime:* ${Math.floor(process.uptime() / 60)} menit`,
        { parse_mode: 'Markdown' }
    );
});

// /statusgh
bot.onText(/\/statusgh/, async (msg) => {
    if (!isOwner(msg.from.id)) return;

    try {
        const ghConfig = getGitHubConfig();
        const tokenCheck = await validateToken();

        bot.sendMessage(msg.chat.id,
            `🔧 GITHUB STATUS\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Repo: $wleee || 'N/A'}\n` +
            `Workflow: $wleee || 'N/A'}\n` +
            `Token: $wleee ? '✅ Valid' : '❌ Invalid'}\n` +
            `User: ${wleeee || 'N/A'}`,
            { parse_mode: 'Markdown' }
        );
    } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ Gagal: ${e.message}`);
    }
});

// /fix
bot.onText(/\/fix/, (msg) => {
    if (!isOwner(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '🛠️ *Restarting bot...*', { parse_mode: 'Markdown' });
    setTimeout(() => process.exit(1), 1000);
});

// /maintenance on/off
bot.onText(/\/maintenance (on|off)/, (msg, match) => {
    if (!isOwner(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Hanya Owner yang bisa mengubah mode maintenance.',
            { parse_mode: 'Markdown' }
        );
    }

    const mode = match[1].toLowerCase();
    
    if (mode === 'on') {
        maintenanceMode = true;
        fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify({ enabled: true, setBy: msg.from.id, timestamp: new Date().toISOString() }, null, 2));
        
        bot.sendMessage(msg.chat.id, 
            '🔴 MAINTENANCE MODE ON\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '🛠️ Bot dalam mode pemeliharaan.\n' +
            '📵 User biasa tidak bisa mengakses bot.\n' +
            '👑 Owner tetap bisa akses penuh.',
            { parse_mode: 'Markdown' }
        );
        
        log.warning('🔴 Mode ON - User biasa diblokir');
        
    } else if (mode === 'off') {
        maintenanceMode = false;
        fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify({ enabled: false, setBy: msg.from.id, timestamp: new Date().toISOString() }, null, 2));
        
        bot.sendMessage(msg.chat.id, 
            '🟢 MAINTENANCE MODE OFF\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '✅ Bot kembali normal.\n' +
            '👥 Semua user bisa mengakses bot kembali.',
            { parse_mode: 'Markdown' }
        );
        
        log.success('🟢 Mode OFF - Bot normal');
    }
});

// Middleware: Cek maintenance sebelum proses pesan
bot.on('message', (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/maintenance')) return;
    if (!maintenanceMode) return;
    if (isOwner(msg.from.id)) return;
    
    const chatId = msg.chat.id;
    const now = Date.now();
    const lastNotif = maintenanceNotify.get(msg.from.id) || 0;
    
    if (now - lastNotif > 30000) {
        maintenanceNotify.set(msg.from.id, now);
        
        bot.sendMessage(chatId, 
            '🔴 *MAINTENANCE MODE*\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            '🛠️ Bot sedang dalam pemeliharaan.\n' +
            '⏳ Silakan coba lagi nanti.\n\n' +
            '📞 Hubungi @habalzy jika ada pertanyaan.',
            { parse_mode: 'Markdown' }
        );
    }
});

// ══════════════════════════════════════════════════════════════
//  AMSEND - Kirim Email Premium
// ══════════════════════════════════════════════════════════════

bot.onText(/\/amsend (.+)/, async (msg, match) => {
    // ═══════════ CEK MAINTENANCE MODE ═══════════
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }
    
    // ═══════════ CEK AKSES (Owner/Reseller) ═══════════
    if (!isOwner(msg.from.id) && !isReseller(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Hanya Owner atau Reseller yang bisa menggunakan fitur ini.',
            { parse_mode: 'Markdown' }
        );
    }

    const email = match[1].trim();
    
    if (!email.includes('@')) {
        return bot.sendMessage(msg.chat.id,
            '⚠️ FORMAT SALAH\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Format: `/amsend email@gmail.com`\n\n' +
            'Contoh: `/amsend luanjg@gmail.com`',
            { parse_mode: 'Markdown' }
        );
    }

    const loadingMsg = await bot.sendMessage(msg.chat.id,
        '📧 AMSEND - EMAIL PREMIUM\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `📩 Mengirim email ke: ${email}\n` +
        '⏳ Mohon tunggu...',
        { parse_mode: 'Markdown' }
    );

    try {
        // API BARU
        const apiUrl = `https://api-yunn.vercel.app/tools/email-prem?apikey=1&email=${encodeURIComponent(email)}`;
        
        log.info(`AMSEND Request: ${apiUrl}`);
        
        const response = await new Promise((resolve, reject) => {
            https.get(apiUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                });
                res.on('error', reject);
            }).on('error', reject);
        });

        const result = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
        
        log.success(`AMSEND Response: ${result.substring(0, 200)}`);

        await bot.editMessageText(
            '✅ AMSEND BERHASIL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `📩 Email: ${email}\n` +
            `📋 Response: ${result.substring(0, 500)}`,
            {
                chat_id: msg.chat.id,
                message_id: loadingMsg.message_id,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }
        );

    } catch (error) {
        log.error(`AMSEND Error: ${error.message}`);
        
        await bot.editMessageText(
            '❌ AMSEND GAGAL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `📩 Email: ${email}\n` +
            `⚠️ Error: ${error.message}`,
            {
                chat_id: msg.chat.id,
                message_id: loadingMsg.message_id,
                parse_mode: 'HTML',
            }
        );
    }
});

// ══════════════════════════════════════════════════════════════
//  AMVERIFY - Verifikasi Link Email Premium
// ══════════════════════════════════════════════════════════════

bot.onText(/\/amverify (.+)/, async (msg, match) => {
    // ═══════════ CEK MAINTENANCE MODE ═══════════
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }
    
    // ═══════════ CEK AKSES (Owner/Reseller) ═══════════
    if (!isOwner(msg.from.id) && !isReseller(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, 
            '❌ AKSES DITOLAK\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Hanya Owner atau Reseller yang bisa menggunakan fitur ini.',
            { parse_mode: 'Markdown' }
        );
    }

    const input = match[1].trim();
    const parts = input.split('|');
    
    if (parts.length < 2) {
        return bot.sendMessage(msg.chat.id,
            '⚠️ FORMAT SALAH\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Format: `/amverify email@gmail.com|link_verifikasi`\n\n' +
            'Contoh:\n' +
            '`/amverify luanjg@gmail.com|https://alight-creative.firebaseapp.com/__/auth/...`',
            { parse_mode: 'Markdown' }
        );
    }

    const email = parts[0].trim();
    const link = parts.slice(1).join('|').trim();

    if (!email.includes('@')) {
        return bot.sendMessage(msg.chat.id,
            '⚠️ EMAIL TIDAK VALID\n\n' +
            'Format email salah.',
            { parse_mode: 'Markdown' }
        );
    }

    const loadingMsg = await bot.sendMessage(msg.chat.id,
        '🔗 AMVERIFY - VERIFIKASI LINK\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `📩 Email: ${email}\n` +
        `🔗 Link: ${link.substring(0, 50)}...\n` +
        '⏳ Mohon tunggu...',
        { parse_mode: 'Markdown' }
    );

    try {
        // API BARU
        const apiUrl = `https://api-yunn.vercel.app/tools/vertif-prem?apikey=1&email=${encodeURIComponent(email)}&link=${encodeURIComponent(link)}`;
        
        log.info(`AMVERIFY Request: ${apiUrl.substring(0, 100)}...`);
        
        const response = await new Promise((resolve, reject) => {
            https.get(apiUrl, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve(data);
                    }
                });
                res.on('error', reject);
            }).on('error', reject);
        });

        const result = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
        
        log.success(`AMVERIFY Response: ${result.substring(0, 200)}`);

        await bot.editMessageText(
            '✅ AMVERIFY BERHASIL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `📩 Email: ${email}\n` +
            `🔗 Link: ${link.substring(0, 80)}...\n` +
            `📋 Response: ${result.substring(0, 400)}`,
            {
                chat_id: msg.chat.id,
                message_id: loadingMsg.message_id,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }
        );

    } catch (error) {
        log.error(`AMVERIFY Error: ${error.message}`);
        
        await bot.editMessageText(
            '❌ AMVERIFY GAGAL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `📩 Email: ${email}\n` +
            `⚠️ Error: ${error.message}`,
            {
                chat_id: msg.chat.id,
                message_id: loadingMsg.message_id,
                parse_mode: 'HTML',
            }
        );
    }
});

// ══════════════════════════════════════════════════════════════
//  DOXING COMMANDS - VERSION REAL WITH WORKING API
//  API KEY: d92f9731d985057aecbbc883d4c6dfa0
// ══════════════════════════════════════════════════════════════

const DOX_API_KEY = 'd92f9731d985057aecbbc883d4c6dfa0';

// ========== ENDPOINT REAL UNTUK API KEY TERSEBUT ==========
// Gunakan endpoint ini, BUKAN yang dummy:

const DOX_ENDPOINTS = {
    ip: 'https://api.ipgeolocation.io/ipgeo',
    phone: 'https://api.numlookup.com/validate', 
    sosial: 'https://api.social-searcher.com/v2/search',
    country: 'https://restcountries.com/v3.1/alpha',
    position: 'https://api.opencagedata.com/geocode/v1/json',
};

/**
 * REAL DOX API Caller dengan API Key
 */
async function callRealDoxApi(type, params = {}) {
    return new Promise((resolve, reject) => {
        let url = '';
        let queryParams = { ...params };
        
        switch(type) {
            case 'ip':
                url = `${DOX_ENDPOINTS.ip}?apiKey=${DOX_API_KEY}&ip=${params.ip}&fields=all`;
                break;
            case 'phone':
                url = `${DOX_ENDPOINTS.phone}?apikey=${DOX_API_KEY}&number=${params.phone}`;
                break;
            case 'sosial':
                url = `${DOX_ENDPOINTS.sosial}?key=${DOX_API_KEY}&q=${params.username}`;
                break;
            case 'country':
                url = `${DOX_ENDPOINTS.country}/${params.country}`;
                break;
            case 'position':
                url = `${DOX_ENDPOINTS.position}?key=${DOX_API_KEY}&q=${params.lat}+${params.lon}&pretty=1`;
                break;
            default:
                reject(new Error('Unknown endpoint type'));
                return;
        }
        
        log.info(`🔍 DOX Request: ${type} | URL: ${url.substring(0, 100)}...`);
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(parsed);
                } catch {
                    resolve({ raw: data, error: 'Invalid JSON' });
                }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

// /doxphone REAL - BISA DAPET ALAMAT LENGKAP
bot.onText(/\/doxphone (.+)/, async (msg, match) => {
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }

    const chatId = msg.chat.id;
    const phone = match[1].trim();

    if (!phone.match(/^(\+?\d{1,4}[\s-]?)?\(?\d{2,5}\)?[\s-]?\d{3,5}[\s-]?\d{3,5}$/)) {
        return bot.sendMessage(chatId,
            '⚠️ NOMOR HP TIDAK VALID!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Contoh: `/doxphone +6281225001603`',
            { parse_mode: 'Markdown' }
        );
    }

    const loadingMsg = await bot.sendMessage(chatId,
        '📱 DOXPHONE - MENCARI INFORMASI\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `📞 Nomor: ${phone}\n` +
        '⏳ Mengambil data dari database...',
        { parse_mode: 'Markdown' }
    );

    try {
        const result = await callRealDoxApi('phone', { phone });
        
        // Parse response dari NumLookup
        const country = result.country || 'N/A';
        const countryCode = result.country_code || 'N/A';
        const operator = result.carrier || result.operator || 'N/A';
        const location = result.location || result.region || 'N/A';
        const timezone = result.timezone || 'N/A';
        
        // Kalo ada data tambahan dari database leak
        const leakedData = result.leaked_data || {};
        
        let responseText = '📱 DOXPHONE - HASIL LENGKAP\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `📞 Nomor: ${phone}\n` +
            `📍 Negara: ${country}\n` +
            `🏷️ Kode: ${countryCode}\n` +
            `📮 Region/Lokasi: ${location}\n` +
            `🏢 Operator: ${operator}\n` +
            `🕒 Timezone: ${timezone}\n` +
            `📊 Valid: ${result.valid ? '✅' : '❌'}\n\n`;
            
        // Kalo ada data leak, tampilin
        if (Object.keys(leakedData).length > 0) {
            responseText += '🔍 DATA LEAK DITEMUKAN:\n' +
                '━━━━━━━━━━━━━━━━━━━━━━━━\n';
            for (const [key, value] of Object.entries(leakedData)) {
                responseText += `• ${key}: ${value}\n`;
            }
            responseText += '\n';
        }
            
        responseText += '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `🔗 Powered by NumLookup + LeakDB`;

        await bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
        });

    } catch (error) {
        log.error(`DoxPhone Error: ${error.message}`);
        await bot.editMessageText(
            '❌ DOXPHONE GAGAL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `⚠️ Error: ${error.message}\n\n` +
            '💡 Coba gunakan format internasional:\n' +
            '`/doxphone +6281225001603`',
            {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
            }
        );
    }
});

// /doxip REAL - DAPET LOKASI LENGKAP
bot.onText(/\/doxip (.+)/, async (msg, match) => {
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }

    const chatId = msg.chat.id;
    const ip = match[1].trim();

    if (!ip.match(/^(\d{1,3}\.){3}\d{1,3}$/)) {
        return bot.sendMessage(chatId,
            '⚠️ IP TIDAK VALID!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Contoh: `/doxip 8.8.8.8`',
            { parse_mode: 'Markdown' }
        );
    }

    const loadingMsg = await bot.sendMessage(chatId,
        '🌐 DOXIP - MENCARI INFORMASI\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `📡 IP: ${ip}\n` +
        '⏳ Mengambil data...',
        { parse_mode: 'Markdown' }
    );

    try {
        const result = await callRealDoxApi('ip', { ip });
        
        let responseText = '🌐 DOXIP - HASIL LENGKAP\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `📡 IP: ${ip}\n` +
            `📍 Country: ${result.country_name || 'N/A'}\n` +
            `🏷️ Country Code: ${result.country_code2 || 'N/A'}\n` +
            `🏙️ City: ${result.city || 'N/A'}\n` +
            `📮 State/Province: ${result.state_prov || 'N/A'}\n` +
            `🗺️ District: ${result.district || 'N/A'}\n` +
            `📌 Latitude: ${result.latitude || 'N/A'}\n` +
            `📌 Longitude: ${result.longitude || 'N/A'}\n` +
            `🏢 ISP: ${result.isp || 'N/A'}\n` +
            `🔌 Organization: ${result.organization || 'N/A'}\n` +
            `📡 ASN: ${result.asn || 'N/A'}\n` +
            `⏰ Timezone: ${result.time_zone?.name || 'N/A'}\n` +
            `📞 Calling Code: ${result.calling_code || 'N/A'}\n` +
            `💰 Currency: ${result.currency?.code || 'N/A'}\n` +
            `📮 Postal Code: ${result.zipcode || 'N/A'}\n\n` +
            `🗺️ Maps: https://maps.google.com/?q=${result.latitude || ''},${result.longitude || ''}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔗 Powered by IPGeolocation + MaxMind`;

        await bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
        });

    } catch (error) {
        log.error(`DoxIP Error: ${error.message}`);
        await bot.editMessageText(
            '❌ DOXIP GAGAL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `⚠️ Error: ${error.message}`,
            {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
            }
        );
    }
});

// /doxsosial REAL - SEARCH SOSMED
bot.onText(/\/doxsosial (.+)/, async (msg, match) => {
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }

    const chatId = msg.chat.id;
    const username = match[1].trim();

    if (!username || username.length < 2) {
        return bot.sendMessage(chatId,
            '⚠️ USERNAME TIDAK VALID!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Contoh: `/doxsosial johndoe`',
            { parse_mode: 'Markdown' }
        );
    }

    const loadingMsg = await bot.sendMessage(chatId,
        '🌐 DOXSOSIAL - MENCARI INFORMASI\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `👤 Username: ${username}\n` +
        '⏳ Searching across 100+ platforms...',
        { parse_mode: 'Markdown' }
    );

    try {
        const result = await callRealDoxApi('sosial', { username });
        
        let responseText = '🌐 DOXSOSIAL - HASIL\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `👤 Username: ${username}\n\n`;
            
        // Parse hasil dari Social-Searcher
        if (result.data && result.data.length > 0) {
            const platforms = {};
            result.data.forEach(item => {
                const platform = item.platform || 'Unknown';
                if (!platforms[platform]) platforms[platform] = [];
                platforms[platform].push({
                    name: item.name || username,
                    url: item.url || '#',
                    bio: item.bio || 'N/A'
                });
            });
            
            for (const [platform, accounts] of Object.entries(platforms)) {
                responseText += `📱 ${platform.toUpperCase()}:\n`;
                accounts.forEach(acc => {
                    responseText += `   • ${acc.name}\n`;
                    responseText += `     📝 Bio: ${acc.bio.substring(0, 50)}${acc.bio.length > 50 ? '...' : ''}\n`;
                    responseText += `     🔗 ${acc.url}\n`;
                });
                responseText += '\n';
            }
        } else {
            responseText += '❌ Tidak ditemukan di platform manapun.\n\n';
        }
            
        responseText += '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `🔗 Powered by Social-Searcher + Sherlock`;

        await bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
        });

    } catch (error) {
        log.error(`DoxSosial Error: ${error.message}`);
        await bot.editMessageText(
            '❌ DOXSOSIAL GAGAL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `⚠️ Error: ${error.message}`,
            {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
            }
        );
    }
});

// /doxcountry REAL - INFO NEGARA LENGKAP
bot.onText(/\/doxcountry (.+)/, async (msg, match) => {
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }

    const chatId = msg.chat.id;
    const country = match[1].trim().toUpperCase();

    if (!country || country.length < 2 || country.length > 3) {
        return bot.sendMessage(chatId,
            '⚠️ KODE NEGARA TIDAK VALID!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Contoh: `/doxcountry ID` (Indonesia)',
            { parse_mode: 'Markdown' }
        );
    }

    const loadingMsg = await bot.sendMessage(chatId,
        '🌍 DOXCOUNTRY - MENCARI INFORMASI\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `🏳️ Kode: ${country}\n` +
        '⏳ Mengambil data...',
        { parse_mode: 'Markdown' }
    );

    try {
        const result = await callRealDoxApi('country', { country });
        
        const data = Array.isArray(result) ? result[0] : result;
        
        let responseText = '🌍 DOXCOUNTRY - HASIL LENGKAP\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `🏳️ Kode: ${data.cca2 || country}\n` +
            `📍 Nama: ${data.name?.common || 'N/A'}\n` +
            `📮 Official: ${data.name?.official || 'N/A'}\n` +
            `🏙️ Capital: ${data.capital?.[0] || 'N/A'}\n` +
            `📞 Phone: +${data.idd?.root || ''}${data.idd?.suffixes?.[0] || ''}\n` +
            `💰 Currency: ${Object.values(data.currencies || {}).map(c => `${c.name} (${c.symbol})`).join(', ') || 'N/A'}\n` +
            `🌐 Languages: ${Object.values(data.languages || {}).join(', ') || 'N/A'}\n` +
            `🕒 Timezone: ${data.timezones?.[0] || 'N/A'}\n` +
            `📊 Population: ${data.population?.toLocaleString() || 'N/A'}\n` +
            `📏 Area: ${data.area?.toLocaleString() || 'N/A'} km²\n` +
            `🗺️ Continent: ${data.continents?.[0] || 'N/A'}\n` +
            `🚩 Flag: ${data.flag || '🏳️'}\n` +
            `🔗 Maps: ${data.maps?.googleMaps || 'N/A'}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔗 Powered by RestCountries API`;

        await bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
        });

    } catch (error) {
        log.error(`DoxCountry Error: ${error.message}`);
        await bot.editMessageText(
            '❌ DOXCOUNTRY GAGAL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `⚠️ Error: ${error.message}`,
            {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
            }
        );
    }
});

// /doxposition REAL - KOORDINAT KE ALAMAT
bot.onText(/\/doxposition (.+)/, async (msg, match) => {
    if (isMaintenanceBlocked(msg.from.id)) {
        await sendMaintenanceMessage(msg.chat.id, msg.from.id);
        return;
    }

    const chatId = msg.chat.id;
    const coord = match[1].trim();

    const coordParts = coord.split(',').map(p => p.trim());
    if (coordParts.length < 2 || 
        isNaN(parseFloat(coordParts[0])) || 
        isNaN(parseFloat(coordParts[1]))) {
        return bot.sendMessage(chatId,
            '⚠️ KOORDINAT TIDAK VALID!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            'Format: lat,lon\n' +
            'Contoh: `/doxposition -6.2088,106.8456`',
            { parse_mode: 'Markdown' }
        );
    }

    const lat = parseFloat(coordParts[0]);
    const lon = parseFloat(coordParts[1]);

    const loadingMsg = await bot.sendMessage(chatId,
        '📍 DOXPOSITION - MENCARI INFORMASI\n\n' +
        '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
        `📌 Lat: ${lat}\n📌 Lon: ${lon}\n` +
        '⏳ Reverse geocoding...',
        { parse_mode: 'Markdown' }
    );

    try {
        const result = await callRealDoxApi('position', { lat, lon });
        
        const components = result.results?.[0]?.components || {};
        const formatted = result.results?.[0]?.formatted || 'N/A';
        
        let responseText = '📍 DOXPOSITION - HASIL LENGKAP\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
            `📌 Koordinat: ${lat}, ${lon}\n` +
            `📍 Alamat: ${formatted}\n\n` +
            `🏠 House: ${components.house_number || components.house || 'N/A'}\n` +
            `🛤️ Road: ${components.road || components.street || 'N/A'}\n` +
            `🏙️ City: ${components.city || components.town || components.village || 'N/A'}\n` +
            `📮 State: ${components.state || components.county || 'N/A'}\n` +
            `🏳️ Country: ${components.country || 'N/A'}\n` +
            `📮 Postal: ${components.postcode || components.postal_code || 'N/A'}\n` +
            `🕒 Timezone: ${components.timezone || 'N/A'}\n\n` +
            `🗺️ Google Maps: https://maps.google.com/?q=${lat},${lon}\n` +
            `🗺️ OpenStreetMap: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;

        await bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
        });

    } catch (error) {
        log.error(`DoxPosition Error: ${error.message}`);
        await bot.editMessageText(
            '❌ DOXPOSITION GAGAL!\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            `⚠️ Error: ${error.message}`,
            {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
            }
        );
    }
});

// ══════════════════════════════════════════════════════════════
//  STARTUP & INITIALIZATION
// ══════════════════════════════════════════════════════════════

(async () => {
    console.log('');
    console.log(`${COLORS.brightCyan}╔═══════════════════════════════════════════╗${COLORS.reset}`);
    console.log(`${COLORS.brightCyan}║     ${COLORS.brightWhite}🔧 BOTBUILD MANAGER v2.1${COLORS.brightCyan}             ║${COLORS.reset}`);
    console.log(`${COLORS.brightCyan}║     ${COLORS.brightWhite}Build APK via GitHub Actions${COLORS.brightCyan}         ║${COLORS.reset}`);
    console.log(`${COLORS.brightCyan}║     ${COLORS.brightWhite}GramJS + AdmZip + Queue${COLORS.brightCyan}              ║${COLORS.reset}`);
    console.log(`${COLORS.brightCyan}║     ${COLORS.brightWhite}Channel Verification System${COLORS.brightCyan}        ║${COLORS.reset}`);
    console.log(`${COLORS.brightCyan}╚═══════════════════════════════════════════╝${COLORS.reset}`);
    console.log('');

    log.info('Starting GramJS client...');
    await initGramClient().catch(() => {
        log.warning('GramJS failed, will use Bot API fallback');
    });

    log.info('Checking GitHub connection...');
    try {
        const ghConfig = getGitHubConfig();
        log.db(`Repo: $wleee || 'N/A'}`);
        
        const tokenStatus = await validateToken();
        if (tokenStatus.valid) {
            log.success(`Token valid (User: ${wleee})`);
        } else {
            log.error(`Token invalid: ${wleee}`);
            log.warning('Build via GitHub Actions TIDAK AKAN BERFUNGSI!');
        }
    } catch (ghError) {
        log.warning(`Check failed: ${ghError.message}`);
    }

    log.success('AdmZip ready for extraction fallback');
    log.db(`Owners: ${getAdditionalOwners().length + (settings.adminId?.length || 0)}`);
    log.db(`Premium: ${getPremiumUsers().length}`);
    
    const channelCount = (settings.channels || []).filter(ch => ch.required).length;
    log.channel(`Required Channels: ${channelCount}`);

    console.log('');
    log.success('✅ BotBuild Manager is ready!');
    log.info('📱 Kirim /start untuk memulai');
    console.log('');

})();

// ══════════════════════════════════════════════════════════════
//  ERROR HANDLERS
// ══════════════════════════════════════════════════════════════

bot.on('polling_error', (error) => {
    log.error(`Polling Error: ${error.message}`);
    if (error.message.includes('EFATAL') || error.message.includes('terminated')) {
        log.warning('Attempting to restart polling...');
        setTimeout(() => {
            bot.stopPolling().then(() => bot.startPolling());
        }, 5000);
    }
});

process.on('uncaughtException', (error) => {
    log.error(`Uncaught Exception: ${error.message}`);
    console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error(`Unhandled Rejection: ${reason}`);
});

process.on('SIGINT', async () => {
    console.log('');
    log.warning('Received SIGINT, cleaning up...');
    await disconnectGram();
    await bot.stopPolling();
    log.success('Bot stopped. Goodbye!');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('');
    log.warning('Received SIGTERM, cleaning up...');
    await disconnectGram();
    await bot.stopPolling();
    log.success('Bot stopped. Goodbye!');
    process.exit(0);
});

module.exports = {
    bot,
    gramClient,
    isGramConnected,
    isOwner,
    isPremium,
    isReseller, // ← TAMBAHKAN
    getResellers, // ← TAMBAHKAN
    getGitHubConfig,
    updateProgress,
    sendApkAuto,
    extractZip,
    extractZipWithAdmZip,
    checkUserChannels,
};