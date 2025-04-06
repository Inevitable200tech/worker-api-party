import express from 'express';
import { buildKey, clientRegistry, serverRegistry } from '../utils/registries.js';
const router = express.Router();

// Register a client and associate with a server
router.post('/register-client', (req, res) => {
    const { client_ip, client_port, server_ip, server_port } = req.body;

    if (!client_ip || !client_port || !server_ip || !server_port) {
        console.log('Missing client or server details');
        return res.status(400).json({ error: 'All fields are required' });
    }

    const clientKey = buildKey(client_ip, client_port);
    const serverKey = buildKey(server_ip, server_port);

    if (!serverRegistry.has(serverKey)) {
        console.log(`Server not found for client registration: ${serverKey}`);
        return res.status(404).json({ error: 'Associated server not found' });
    }

    clientRegistry.set(clientKey, { serverKey });
    console.log(`Client registered: ${clientKey} associated with ${serverKey}`);
    res.json({ message: 'Client registered successfully', clientKey, serverKey });
});

// Get associated clients for a server
router.post('/associated-clients', (req, res) => {
    const { serverKey } = req.body;

    if (!serverKey) {
        console.log('Missing serverKey during /associated-clients');
        return res.status(400).json({ error: 'Server key is required' });
    }

    const associatedClients = Array.from(clientRegistry.entries())
        .filter(([_, data]) => data.serverKey === serverKey)
        .map(([clientKey]) => clientKey);
    if (associatedClients.length === 0) {
        console.log(`No clients available for server: ${serverKey}`);
        return res.status(404).json({ message: 'No clients available for this server' });
    }

    console.log(`Associated clients for ${serverKey}:`, associatedClients);
    res.json({ associatedClients });
});

export default router;
