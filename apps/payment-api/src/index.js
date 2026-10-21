import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentStatus } from '@youpi/common';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

// Ensure environment variables from .env are loaded reliably in production
if (!process.env.BASE_CHECKOUT_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(rootDir, '.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

import {
  getDatabase,
  ensureDatabaseInitialized,
  runMigrations,
  MerchantRepository,
  ReceivingAccountRepository,
  CustomerRepository,
  CustomerSessionRepository,
  PaymentSessionRepository,
  ObservationRepository,
  SupportTicketRepository,
  AuditLogRepository,
  DeviceRepository
} from '@youpi/db';

import {
  QueueEngine,
  TimingEngine,
  AttributionEngine,
  RecoveryEngine,
  WebhookEngine,
  PaymentVerificationPipeline
} from '@youpi/core';

import { HttpServer } from './server.js';
import { authGuard } from './auth-guard.js';
import { registerPaymentRoutes } from './routes/payments.routes.js';
import { registerCheckoutRoutes } from './routes/checkout.routes.js';
import { registerPollerRoutes } from './routes/pollers.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerCustomerRoutes } from './routes/customer.routes.js';
import { registerDeviceRoutes } from './routes/device.routes.js';
import { getWhatsAppBerryService, WhatsAppBerryService } from './services/whatsapp-berry.service.js';
import { ObserverPollerService } from './services/observer-poller.service.js';

export function createPaymentApp(customDb = null, options = {}) {
  const db = customDb || getDatabase();
  ensureDatabaseInitialized(db);
  const { defaultMerchant } = runMigrations(db);
  const isCustom = !!customDb;

  const whatsappBerryService = options.whatsappBerryService || (isCustom ? new WhatsAppBerryService({
    sessionId: 'test_berry_session',
    sessionPath: path.resolve(rootDir, 'data/test_berry_auth'),
    databasePath: path.resolve(rootDir, 'data/test_berry_store.db'),
    metaFile: path.resolve(rootDir, 'data/test_whatsapp_session.json')
  }) : getWhatsAppBerryService());

  const merchantRepo = new MerchantRepository(db);
  const accountRepo = new ReceivingAccountRepository(db);
  const customerRepo = new CustomerRepository(db);
  const customerSessionRepo = new CustomerSessionRepository(db, customerRepo);
  const sessionRepo = new PaymentSessionRepository(db);
  const obsRepo = new ObservationRepository(db);
  const ticketRepo = new SupportTicketRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const deviceRepo = new DeviceRepository(db);

  const eventEmitter = new EventEmitter();

  const queueEngine = new QueueEngine({
    sessionRepo,
    accountRepo,
    eventEmitter,
    auditRepo
  });

  const timingEngine = new TimingEngine({
    sessionRepo,
    queueEngine,
    eventEmitter,
    auditRepo,
    activeDurationMs: Number(process.env.PAYMENT_ACTIVE_WINDOW_MS || 300000),
    processingDurationMs: Number(process.env.PAYMENT_PROCESSING_WINDOW_MS || 30000)
  });

  const attributionEngine = new AttributionEngine({
    sessionRepo,
    obsRepo,
    ticketRepo,
    auditRepo,
    eventEmitter
  });

  const recoveryEngine = new RecoveryEngine({
    db,
    sessionRepo,
    accountRepo,
    queueEngine,
    timingEngine,
    auditRepo
  });

  const webhookEngine = new WebhookEngine({
    db,
    merchantRepo,
    maxRetries: Number(process.env.WEBHOOK_MAX_RETRIES || 5)
  });

  const server = new HttpServer();
  server.use(authGuard);

  let checkoutBaseUrl = process.env.BASE_CHECKOUT_URL || 'http://localhost:7000';
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      const raw = fs.readFileSync(rootEnv, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('BASE_CHECKOUT_URL=')) {
          const val = trimmed.split('=')[1]?.trim();
          if (val) checkoutBaseUrl = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {}

  // Bulletproof Queue Promotion Handler
  function handleSlotFreedAndPromote(receivingAccountId) {
    if (!receivingAccountId) return null;
    const promoted = queueEngine.promoteNext(receivingAccountId);
    if (promoted) {
      if (promoted.expiresAt) {
        timingEngine.startActiveTimer(promoted.id, promoted.expiresAt);
      }
      server.broadcastSse(promoted.id, 'status_change', {
        status: PaymentStatus.ACTIVE,
        queuePosition: 0,
        expiresAt: promoted.expiresAt
      });
      server.broadcastSse(`queue_${receivingAccountId}`, 'queue_update', {
        promotedId: promoted.id
      });
    }
    return promoted;
  }

  // Event Listeners for Payment States
  eventEmitter.on('PAYMENT.SUCCESS', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', {
        status: PaymentStatus.SUCCESS,
        verificationLevel: data.verificationLevel || session.verificationLevel || 1,
        verificationTag: data.verificationTag || session.verificationTag,
        sources: data.sources || session.verificationSources
      });
      webhookEngine.dispatch('SUCCESS', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.LEVEL1_VERIFIED', (data) => {
    server.broadcastSse(data.paymentId, 'status_change', {
      status: 'VERIFYING',
      verificationLevel: 1,
      verificationTag: data.verificationTag,
      message: 'Payment detected! Verifying secondary channel...'
    });
  });

  eventEmitter.on('PAYMENT.FAILED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      webhookEngine.dispatch('FAILED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.EXPIRED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.EXPIRED });
      webhookEngine.dispatch('EXPIRED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.CANCELLED', (data) => {
    const session = sessionRepo.findById(data.paymentId);
    if (session) {
      server.broadcastSse(session.id, 'status_change', { status: PaymentStatus.CANCELLED });
      webhookEngine.dispatch('CANCELLED', session).catch(() => {});
      handleSlotFreedAndPromote(session.receivingAccountId);
    }
  });

  eventEmitter.on('PAYMENT.FRAUD_BLOCKED', (data) => {
    if (data.sessionId) {
      server.broadcastSse(data.sessionId, 'status_change', {
        status: 'BLOCKED',
        isBanned: true,
        fraudDetected: true,
        orderId: data.orderId,
        reason: data.reason || 'FRAUDULENT_PAYMENT_INJECTION',
        blockedNotice: {
          title: 'FRAUDULENT ACTIVITY DETECTED',
          subtitle: 'Payment Session Terminated & Account Suspended',
          message: 'Our automated verification engine detected fraudulent payment activity associated with this account.',
          investigating: true
        }
      });
    }
  });

  // Background Daemons & Services
  const queueSyncDaemon = setInterval(() => {
    try {
      const nowIso = new Date().toISOString();
      const expiredActive = db.query(`SELECT id, receiving_account_id FROM payment_sessions WHERE status = 'ACTIVE' AND expires_at <= ?`, [nowIso]);
      for (const row of expiredActive) {
        sessionRepo.transitionToTerminal(row.id, PaymentStatus.EXPIRED);
        server.broadcastSse(row.id, 'status_change', { status: PaymentStatus.EXPIRED });
        handleSlotFreedAndPromote(row.receiving_account_id);
      }
    } catch {}
  }, 1000);
  if (queueSyncDaemon.unref) queueSyncDaemon.unref();

  const observerPollerService = new ObserverPollerService({
    db, sessionRepo, obsRepo, attributionEngine, eventEmitter,
    pollIntervalMs: Number(process.env.OBSERVER_POLL_INTERVAL_MS || 1500),
    minSweepCooldownMs: Number(process.env.OBSERVER_SWEEP_COOLDOWN_MS || 2000),
    smsPort: Number(process.env.SMS_OBSERVER_PORT || 6002),
    gmailPort: Number(process.env.GMAIL_OBSERVER_PORT || 6003)
  });

  const recoveryStats = recoveryEngine.recover();

  // Health check routes
  const healthHandler = (req, res) => {
    HttpServer.json(res, 200, {
      status: 'UP',
      service: 'payment-api',
      timestamp: new Date().toISOString(),
      recoveryStats
    });
  };
  server.get('/health', healthHandler);
  server.get('/api/v1/health', healthHandler);

  // =========================================================================
  // MERCHANT ADMIN DASHBOARD ROUTE (Serves admin.html UI securely)
  // =========================================================================
  const serveAdminDashboard = async (req, res) => {
    try {
      const possiblePaths = [
        path.resolve(rootDir, 'apps/merchant-admin/src/views/admin.html'),
        path.resolve(__dirname, '../../merchant-admin/src/views/admin.html'),
        path.resolve(rootDir, 'merchant-admin/src/views/admin.html')
      ];

      let adminHtmlPath = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          adminHtmlPath = p;
          break;
        }
      }

      if (adminHtmlPath) {
        let html = fs.readFileSync(adminHtmlPath, 'utf8');
        const apiBaseUrl = process.env.PUBLIC_API_URL || 'https://youpi-pg-4n2w.onrender.com';
        html = html.replace(/\{\{API_BASE_URL\}\}/g, apiBaseUrl)
                   .replace(/\{\{APP_NAME\}\}/g, 'YouPI PG Admin');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Admin dashboard view file not found on server.');
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Admin Panel Error: ${err.message}`);
    }
  };

  server.get('/admin', serveAdminDashboard);
  server.get('/admin.html', serveAdminDashboard);

  const pipeline = new PaymentVerificationPipeline({
    db, sessionRepo, obsRepo, customerRepo, attributionEngine, auditRepo, merchantRepo, server, eventEmitter
  });

  const context = {
    db, merchantRepo, accountRepo, customerRepo, customerSessionRepo, sessionRepo, deviceRepo,
    obsRepo, ticketRepo, auditRepo, queueEngine, timingEngine, attributionEngine, pipeline,
    recoveryEngine, eventEmitter, defaultMerchant, checkoutBaseUrl, whatsappBerryService,
    webhookEngine, observerPollerService, otpCooldownMs: options.otpCooldownMs
  };

  // Register Core System Routes
  registerPaymentRoutes(server, context);
  registerCheckoutRoutes(server, context);
  registerPollerRoutes(server, context);
  registerAdminRoutes(server, context);
  registerCustomerRoutes(server, context);
  registerDeviceRoutes(server, context);

  // WhatsApp Pairing Endpoints
  server.post('/api/v1/whatsapp/pair', async (req, res) => {
    try {
      const phoneNumber = req.body?.phoneNumber || '7852846992';
      const result = await whatsappBerryService.requestPairingCode(phoneNumber);
      HttpServer.json(res, 200, { success: true, pairingCode: result.pairingCode, phoneNumber: result.phoneNumber });
    } catch (err) {
      HttpServer.json(res, 500, { success: false, error: err.message });
    }
  });

  server.post('/api/pair-whatsapp', async (req, res) => {
    try {
      const phoneNumber = req.body?.phoneNumber || '7852846992';
      const result = await whatsappBerryService.requestPairingCode(phoneNumber);
      HttpServer.json(res, 200, { success: true, pairingCode: result.pairingCode, phoneNumber: result.phoneNumber });
    } catch (err) {
      HttpServer.json(res, 500, { success: false, error: err.message });
    }
  });

  function destroy() {
    clearInterval(queueSyncDaemon);
    observerPollerService.destroy();
    timingEngine.destroy();
    if (typeof attributionEngine.destroy === 'function') attributionEngine.destroy();
  }

  return { server, context, destroy, rawServer: server.createServer() };
}

export function startServer(port = null, customDb = null) {
  const finalPort = port || Number(process.env.PAYMENT_API_PORT || 6100);
  const app = createPaymentApp(customDb);

  return new Promise(resolve => {
    const bindHost = process.env.YOUPI_BIND_HOST || '127.0.0.1';
    const instance = app.rawServer.listen(finalPort, bindHost, () => {
      console.log(`[Payment API] Server listening on port ${finalPort}`);
      resolve({
        app,
        port: finalPort,
        close: () => new Promise(cb => { app.destroy(); instance.close(cb); })
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
