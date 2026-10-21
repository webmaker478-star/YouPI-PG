import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateQrSvg } from '@youpi/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../../..');

let BerryProtocolClass = null;
let qrcodeLib = null;

async function loadDependencies() {
  if (!BerryProtocolClass) {
    const candidates = [
      'berryprotocol',
      pathToFileURL(path.resolve(rootDir, 'node_modules/berryprotocol/dist/index.js')).href,
      pathToFileURL(path.resolve(rootDir, 'apps/payment-api/node_modules/berryprotocol/dist/index.js')).href,
      'file:///D:/WA-USERAUTH DEV/node_modules/berryprotocol/dist/index.js',
      'file:///D:/E-Commerce PKG/services/whatsapp-worker/node_modules/berryprotocol/dist/index.js',
      'file:///D:/ECOM AND YOUPI PG INTEGRATION/E-Commerce PACKAGE/services/whatsapp-worker/node_modules/berryprotocol/dist/index.js',
      'file:///D:/distribution/services/whatsapp-worker/node_modules/berryprotocol/dist/index.js'
    ];
    for (const p of candidates) {
      try {
        const mod = await import(p);
        BerryProtocolClass = mod.BerryProtocol || mod.default;
        if (BerryProtocolClass) {
          console.log(`[WhatsAppBerryService] Loaded BerryProtocol engine from: ${p}`);
          break;
        }
      } catch {}
    }
  }
  if (!qrcodeLib) {
    const qrCandidates = [
      'qrcode',
      pathToFileURL(path.resolve(rootDir, 'node_modules/qrcode/lib/index.js')).href,
      pathToFileURL(path.resolve(rootDir, 'apps/payment-api/node_modules/qrcode/lib/index.js')).href,
      'file:///D:/WA-USERAUTH DEV/node_modules/qrcode/lib/index.js',
      'file:///D:/E-Commerce PKG/services/whatsapp-worker/node_modules/qrcode/lib/index.js',
      'file:///D:/ECOM AND YOUPI PG INTEGRATION/E-Commerce PACKAGE/services/whatsapp-worker/node_modules/qrcode/lib/index.js',
      'file:///D:/distribution/services/whatsapp-worker/node_modules/qrcode/lib/index.js'
    ];
    for (const p of qrCandidates) {
      try {
        const qrMod = await import(p);
        qrcodeLib = qrMod.default || qrMod;
        if (qrcodeLib) break;
      } catch {}
    }
  }
  return { BerryProtocol: BerryProtocolClass, qrcode: qrcodeLib };
}

export async function formatQrDataUrl(rawText, qrcodeModule = null) {
  if (!rawText) return null;
  if (typeof rawText === 'string' && rawText.startsWith('data:image/')) {
    return rawText;
  }

  let text = typeof rawText === 'string' ? rawText : String(rawText);
  if (text.startsWith('2@') || text.startsWith('1@')) {
    text = `https://wa.me/settings/linked_devices#${text}`;
  }

  let qrEngine = qrcodeModule || qrcodeLib;
  if (!qrEngine) {
    const deps = await loadDependencies();
    qrEngine = deps.qrcode;
  }
  if (qrEngine && typeof qrEngine.toDataURL === 'function') {
    try {
      const dataUrl = await qrEngine.toDataURL(text, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#0f172a', light: '#ffffff' }
      });
      if (dataUrl && dataUrl.startsWith('data:image/')) {
        return dataUrl;
      }
    } catch (e) {}
  }
  try {
    const svg = generateQrSvg(text, 320, 'M');
    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  } catch (err) {
    return null;
  }
}

export class WhatsAppBerryService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || 'youpi_berry_session';
    this.sessionPath = options.sessionPath || path.resolve(rootDir, 'data/berry_auth');
    this.databasePath = options.databasePath || path.resolve(rootDir, 'data/berry_store.db');
    this.metaFile = options.metaFile || path.resolve(rootDir, 'data/whatsapp_session.json');

    this.status = 'DISCONNECTED';
    this.phoneNumber = null;
    this.qrCode = null;
    this.pairingCode = null;
    this.pairingPhone = null;
    this.client = null;
    this.isInitializing = false;
    this.shouldKeepPairingAlive = true;
    this.reconnectTimer = null;
    this.isSimulatedMode = false;

    this.restoreSessionMeta();
  }

  restoreSessionMeta() {
    try {
      if (fs.existsSync(this.sessionPath)) {
        const entries = fs.readdirSync(this.sessionPath);
        for (const entry of entries) {
          const subCreds = path.join(this.sessionPath, entry, 'creds.json');
          if (fs.existsSync(subCreds)) {
            this.sessionId = entry;
            break;
          }
        }
      }

      if (fs.existsSync(this.metaFile)) {
        const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
        if (meta.sessionId) {
          this.sessionId = meta.sessionId;
        }

        const credsFile1 = path.join(this.sessionPath, 'creds.json');
        const credsFile2 = path.join(this.sessionPath, this.sessionId, 'creds.json');
        const hasCreds = fs.existsSync(credsFile1) || fs.existsSync(credsFile2);

        if (meta.status === 'CONNECTED' && meta.phoneNumber && hasCreds) {
          this.phoneNumber = meta.phoneNumber;
          this.status = 'CONNECTED';
          if (process.env.NODE_ENV !== 'test') {
            setImmediate(() => {
              if (!this.client && !this.isInitializing) {
                this.initialize().catch(() => {});
              }
            });
          }
        }
      }
    } catch (e) {}
  }

  ensureDirectories() {
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }
    const dbDir = path.dirname(this.databasePath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  cleanPhoneNumber(raw) {
    if (!raw) return null;
    let clean = String(raw).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);
    return clean ? '+' + clean : null;
  }

  formatJid(to) {
    if (!to) return '';
    let clean = String(to).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);
    return `${clean}@s.whatsapp.net`;
  }

  cleanSessionFiles() {
    console.log('[WhatsAppBerryService] Purging old session files for clean pairing state...');
    try {
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, { recursive: true, force: true });
      }
      fs.mkdirSync(this.sessionPath, { recursive: true });
    } catch (e) {}

    try {
      if (fs.existsSync(this.metaFile)) {
        fs.rmSync(this.metaFile, { force: true });
      }
    } catch {}

    for (const df of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      try {
        if (fs.existsSync(df)) fs.rmSync(df, { force: true });
      } catch {}
    }

    this.status = 'DISCONNECTED';
    this.phoneNumber = null;
    this.qrCode = null;
    this.pairingCode = null;
    this.pairingPhone = null;
    this.sessionId = `youpi_berry_${Date.now()}`;
    this.isInitializing = false;
  }

  async initialize() {
    this.shouldKeepPairingAlive = true;
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      this.ensureDirectories();
      const { BerryProtocol, qrcode } = await loadDependencies();
      if (!BerryProtocol) return;

      if (this.client) {
        try {
          if (typeof this.client.removeAllListeners === 'function') this.client.removeAllListeners();
          await this.client.disconnect();
        } catch {}
        this.client = null;
      }

      this.status = 'CONNECTING';
      this.emit('status', this.status);

      // FIXED: Added standard WhatsApp Web browser config to prevent rejections
      this.client = new BerryProtocol({
        sessionId: this.sessionId,
        authFolder: this.sessionPath,
        databasePath: this.databasePath,
        printQrInTerminal: false,
        reconnectDelayMs: 3000,
        reconnectMaxAttempts: 15,
        browser: ['Chrome (Linux)', 'Chrome', '122.0.6261.128']
      });

      this.setupListeners(qrcode);
      this.client.connectWithQr().catch(() => {});
    } catch (err) {
      this.status = 'DISCONNECTED';
      this.emit('status', this.status);
    } finally {
      this.isInitializing = false;
    }
  }

  setupListeners(qrcodeLib = null) {
    if (!this.client) return;

    this.client.on('auth.pairing_code', ({ code, phoneNumber }) => {
      this.pairingCode = code;
      this.pairingPhone = phoneNumber;
      this.status = 'PAIRING_CODE_READY';
      console.log(`[WhatsAppBerryService] SUCCESS! 8-digit pairing code generated: ${code} for ${phoneNumber}`);
      this.emit('pairing_code', { code, phoneNumber });
      this.emit('status', this.status);
    });

    this.client.on('connection.open', () => {
      this.status = 'CONNECTED';
      this.qrCode = null;
      this.pairingCode = null;
      this.pairingPhone = null;

      let phone = null;
      try {
        const rawUser = this.client.socket?.sock?.user?.id || this.client.socket?.sock?.user?.jid;
        if (rawUser) {
          phone = this.cleanPhoneNumber(rawUser.split(':')[0].split('@')[0]);
        }
      } catch {}

      if (phone) this.phoneNumber = phone;

      try {
        fs.writeFileSync(this.metaFile, JSON.stringify({
          status: 'CONNECTED',
          phoneNumber: this.phoneNumber,
          sessionId: this.sessionId,
          updatedAt: new Date().toISOString()
        }, null, 2));
      } catch {}

      console.log(`[WhatsAppBerryService] WhatsApp Device CONNECTED successfully as ${this.phoneNumber || 'Linked Device'}!`);
      this.emit('ready', { phoneNumber: this.phoneNumber, sessionId: this.sessionId });
      this.emit('status', this.status);
    });

    this.client.on('connection.close', ({ reason, statusCode }) => {
      const isManual = reason === 'manual_logout' || statusCode === 401;
      if (isManual) {
        this.cleanSessionFiles();
        this.emit('disconnected', { reason: 'logged_out' });
      } else {
        this.status = 'DISCONNECTED';
        this.emit('disconnected', { reason, statusCode });
        if (this.shouldKeepPairingAlive !== false && this.phoneNumber) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.initialize().catch(() => {});
          }, 3000);
        }
      }
      this.emit('status', this.status);
    });
  }

  getStatus() { return this.status; }
  getQrCode() { return this.qrCode; }
  getClientInfo() {
    return {
      phoneNumber: this.phoneNumber,
      sessionId: this.sessionId,
      status: this.status,
      isConnected: this.status === 'CONNECTED',
      pairingCode: this.pairingCode,
      pairingPhone: this.pairingPhone
    };
  }
  getPairingCode() { return { code: this.pairingCode, phoneNumber: this.pairingPhone }; }

  async disconnect(options = { cleanSession: true }) {
    this.shouldKeepPairingAlive = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.isInitializing = false;

    if (this.client) {
      try {
        if (typeof this.client.removeAllListeners === 'function') this.client.removeAllListeners();
        await this.client.disconnect();
      } catch {}
      this.client = null;
    }

    if (options.cleanSession !== false) {
      this.cleanSessionFiles();
    } else {
      this.status = 'DISCONNECTED';
      this.phoneNumber = null;
      this.qrCode = null;
      this.pairingCode = null;
      this.pairingPhone = null;
    }
    this.emit('status', this.status);
  }

  async requestPairingCode(phoneNumber) {
    if (!phoneNumber) throw new Error('Phone number is required.');
    
    let clean = String(phoneNumber).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);

    // CRITICAL: Always clean previous corrupted session before requesting a fresh pairing code
    await this.disconnect({ cleanSession: true });
    this.ensureDirectories();

    const { BerryProtocol, qrcode } = await loadDependencies();
    if (!BerryProtocol) throw new Error('BerryProtocol engine is not available.');

    this.status = 'CONNECTING';
    this.pairingCode = null;
    this.pairingPhone = clean;
    this.sessionId = `youpi_berry_${Date.now()}`;

    this.client = new BerryProtocol({
      sessionId: this.sessionId,
      authFolder: this.sessionPath,
      databasePath: this.databasePath,
      printQrInTerminal: false,
      reconnectDelayMs: 3000,
      reconnectMaxAttempts: 15,
      browser: ['Chrome (Linux)', 'Chrome', '122.0.6261.128']
    });

    this.setupListeners(qrcode);

    // Call pairing code generator with clean international number
    this.client.connectWithPairingCode(clean).catch(err => {
      console.warn(`[WhatsAppBerryService] connectWithPairingCode notice: ${err.message}`);
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pairingCode) {
          resolve({ success: true, pairingCode: this.pairingCode, phoneNumber: clean });
        } else {
          reject(new Error('Timed out waiting for WhatsApp pairing code from WhatsApp servers.'));
        }
      }, 15000);

      const onCode = (data) => {
        clearTimeout(timer);
        this.removeListener('pairing_code', onCode);
        resolve({ success: true, pairingCode: data.code, phoneNumber: clean });
      };

      this.once('pairing_code', onCode);
    });
  }

  async sendOtp(to, otpCode, customerName = '') {
    const greeting = customerName ? `Hello *${customerName}*!` : 'Hello!';
    const message =
      `🔐 *YOUPI PG Verification Code*\n\n` +
      `${greeting} Your one-time login OTP is: *${otpCode}*\n\n` +
      `⏱ _Valid for 5 minutes. Do not share this code with anyone._\n\n` +
      `— *YOUPI PG Secure Payments*`;

    return this.sendMessage(to, message);
  }

  async sendMessage(to, message) {
    const cleanTo = String(to || '').replace(/[^0-9]/g, '');
    if (this.status !== 'CONNECTED' || !this.client) {
      return { success: false, delivered: false, error: `WhatsApp is not connected (Status: ${this.status})` };
    }

    const jid = this.formatJid(to);
    if (!jid) return { success: false, delivered: false, error: 'Invalid recipient' };

    try {
      let result;
      if (typeof this.client.sendText === 'function') {
        result = await this.client.sendText(jid, message);
      } else if (typeof this.client.sendMessage === 'function') {
        result = await this.client.sendMessage(jid, { text: message });
      } else if (this.client.socket?.sendMessage) {
        result = await this.client.socket.sendMessage(jid, { text: message });
      } else {
        throw new Error('No compatible message sending method');
      }
      return { success: true, delivered: true, id: result?.id || `msg_${Date.now()}` };
    } catch (err) {
      return { success: false, delivered: false, error: err.message };
    }
  }
}

let serviceInstance = null;
export function getWhatsAppBerryService(options = {}) {
  if (!serviceInstance) {
    serviceInstance = new WhatsAppBerryService(options);
  }
  return serviceInstance;
}
