import express from 'express';
import { buildKey, serverRegistry, clientRegistry, clientHeartbeatLog, heartbeatCounts } from '../utils/registries.js';

const router = express.Router();


// Function to update heartbeat counts for all serverKeys
function updateHeartbeatCounts() {
    // Clear existing counts
    heartbeatCounts.clear();

    // Count clientKeys per serverKey
    const serverKeyCounts = new Map();
    for (const [clientKey, { serverKey }] of clientHeartbeatLog) {
        if (!serverKeyCounts.has(serverKey)) {
            serverKeyCounts.set(serverKey, 0);
        }
        serverKeyCounts.set(serverKey, serverKeyCounts.get(serverKey) + 1);
    }

    // Update heartbeatCounts
    for (const [serverKey, count] of serverKeyCounts) {
        heartbeatCounts.set(serverKey, count);
        console.log(`Heartbeat client count for ${serverKey}: ${count}`);
    }
}

// Cleanup function to remove inactive client heartbeats and update counts
setInterval(() => {
    const now = Date.now();
    const threshold = 5 * 60 * 1000; // 5 minutes
    for (const [clientKey, { timestamp }] of clientHeartbeatLog) {
        if (now - timestamp > threshold) {
            clientHeartbeatLog.delete(clientKey);
            console.log(`Removed inactive client heartbeat: ${clientKey}`);
        }
    }
    updateHeartbeatCounts();
}, 60 * 1000); // Run every minute

// Middleware to log client heartbeats for /list-servers
router.use('/list-servers', (req, res, next) => {
    const { clientKey, serverKey } = req.body;
    if (clientKey && serverKey) {
        clientHeartbeatLog.set(clientKey, { timestamp: Date.now(), serverKey });
        console.log(`Client heartbeat recorded for ${clientKey} on ${serverKey}`);
        updateHeartbeatCounts(); // Update counts after each heartbeat
    }
    next();
});

// Register a server
router.post('/register', (req, res) => {
    const { ip, port } = req.body;

    if (!ip || !port) {
        console.log('Missing IP or Port during registration');
        return res.status(400).json({ error: 'IP and port are required for registration' });
    }

    const serverKey = buildKey(ip, port);
    serverRegistry.set(serverKey, { lastPing: Date.now() });

    console.log(`Server registered: ${serverKey}`);
    res.json({ message: 'Server registered successfully', serverKey });
});

// Server heartbeat
router.post('/heartbeat', (req, res) => {
    const { ip, port } = req.body;

    if (!ip || !port) {
        console.log('Missing IP or Port during heartbeat');
        return res.status(400).json({ error: 'IP and port are required for heartbeat' });
    }

    const serverKey = buildKey(ip, port);
    if (!serverRegistry.has(serverKey)) {
        console.log(`Server not found for heartbeat: ${serverKey}`);
        return res.status(404).json({ error: 'Server not registered' });
    }

    serverRegistry.get(serverKey).lastPing = Date.now();
    console.log(`Heartbeat received from ${serverKey}`);
    res.json({ message: 'Heartbeat acknowledged' });
});

// Check if a server is active and optionally whether a client is associated with it
router.post('/list-servers', (req, res) => {
    const { serverKey, clientKey } = req.body;

    if (!serverKey) {
        console.log('Missing serverKey during /list-servers');
        return res.status(400).json({ error: 'Server key (ip:port) is required' });
    }

    if (!serverRegistry.has(serverKey)) {
        console.log(`Server not found or inactive: ${serverKey}`);
        return res.status(404).json({ error: 'Server not found or inactive' });
    }

    if (clientKey) {
        const clientData = clientRegistry.get(clientKey);
        if (clientData && clientData.serverKey === serverKey) {
            return res.json({ message: 'Server Active and associated' });
        } else {
            return res.json({ message: 'Server Active but not associated' });
        }
    }
    else {
        return res.status(400).json({ error: 'Client Ip:port required' });
    }
});

// Exported function to get total heartbeat client count across all servers
export function getTotalHeartbeatClientCount() {
    return clientHeartbeatLog.size;
}

export default router;