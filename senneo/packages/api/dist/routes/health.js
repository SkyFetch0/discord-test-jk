"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRouter = healthRouter;
const express_1 = require("express");
async function checkScylla(scylla) {
    const t = Date.now();
    try {
        await scylla.execute('SELECT now() FROM system.local');
        return { ok: true, latencyMs: Date.now() - t };
    }
    catch (err) {
        return { ok: false, error: err?.message ?? 'unknown' };
    }
}
async function checkClickHouse(ch) {
    const t = Date.now();
    try {
        const r = await ch.query({ query: 'SELECT 1', format: 'JSONEachRow' });
        await r.json();
        return { ok: true, latencyMs: Date.now() - t };
    }
    catch (err) {
        return { ok: false, error: err?.message ?? 'unknown' };
    }
}
async function checkKafka(brokers) {
    const t = Date.now();
    try {
        const { Kafka } = await Promise.resolve().then(() => __importStar(require('kafkajs')));
        const kafka = new Kafka({ clientId: 'senneo-health', brokers, retry: { retries: 1 } });
        const admin = kafka.admin();
        await admin.connect();
        await admin.listTopics();
        await admin.disconnect();
        return { ok: true, latencyMs: Date.now() - t };
    }
    catch (err) {
        return { ok: false, error: err?.message ?? 'unknown' };
    }
}
function healthRouter(scylla, ch, brokers) {
    const router = (0, express_1.Router)();
    // GET /health � simple liveness (load balancer ping)
    router.get('/', (_req, res) => {
        res.json({ status: 'ok', ts: new Date().toISOString() });
    });
    // GET /health/all � deep check of all services
    router.get('/all', async (_req, res) => {
        const [scyllaH, chH, kafkaH] = await Promise.all([
            checkScylla(scylla),
            checkClickHouse(ch),
            checkKafka(brokers),
        ]);
        const allOk = scyllaH.ok && chH.ok && kafkaH.ok;
        res.status(allOk ? 200 : 503).json({
            API: { ok: true, latencyMs: 0 },
            ScyllaDB: scyllaH,
            ClickHouse: chH,
            Kafka: kafkaH,
        });
    });
    return router;
}
//# sourceMappingURL=health.js.map