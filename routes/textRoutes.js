import express from 'express';
import { buildKey, serverRegistry, clientToServerMessages, serverToClientMessages,clientRegistry } from '../utils/registries.js';

const router = express.Router();

// Client-side: Post a text (Client to Server)
router.post('/post-text', (req, res) => {
    const { server_ip, server_port, client_ip, client_port, text } = req.body;

    if (!server_ip || !server_port || !client_ip || !client_port || !text) {
        console.log('Missing required fields during /post-text');
        return res.status(400).json({ error: 'Server IP, port, client IP, port, and text are required' });
    }

    const serverKey = buildKey(server_ip, server_port);
    const clientKey = buildKey(client_ip, client_port);
    // if (!serverRegistry.has(serverKey)) {
    //     console.log(`Server not found or inactive: ${serverKey}`);
    //     return res.status(404).json({ error: 'Server not registered or inactive' });
    // }

    const textEntry = { text };

    if (!clientToServerMessages.has(clientKey)) {
        clientToServerMessages.set(clientKey, []);
    }

    clientToServerMessages.get(clientKey).push({ serverKey, ...textEntry });

    console.log(`Text posted by client ${clientKey} to server ${serverKey}`);
    res.json({ message: 'Text posted successfully', serverKey });
});

// Server posts a message to a client (Server to Client)
router.post('/send-message', (req, res) => {
    const { server_ip, server_port, client_ip, client_port, message } = req.body;

    if (!server_ip || !server_port || !client_ip || !client_port || !message) {
        console.log('Missing required fields during /send-message');
        return res.status(400).json({ error: 'Server IP, port, client IP, port, and message are required' });
    }

    const serverKey = buildKey(server_ip, server_port);
    const clientKey = buildKey(client_ip, client_port);

    if (!serverRegistry.has(serverKey)) {
        console.log(`Server not found or inactive: ${serverKey}`);
        return res.status(404).json({ error: 'Server not registered or inactive' });
    }

    if (!clientRegistry.has(clientKey) || clientRegistry.get(clientKey).serverKey !== serverKey) {
        console.log(`Client not found or not associated with server: ${serverKey}`);
        return res.status(404).json({ error: 'Client not registered or not associated with the server' });
    }

    const messageEntry = { message };

    if (!serverToClientMessages.has(serverKey)) {
        serverToClientMessages.set(serverKey, []);
    }

    serverToClientMessages.get(serverKey).push({ clientKey, ...messageEntry });

    console.log(`Message sent from server ${serverKey} to client ${clientKey}`);
    res.json({ message: 'Message sent successfully', clientKey, serverKey });
});

// Client fetches messages from a server (Server to Client)
router.get('/fetch-messages', (req, res) => {
    const { client_ip, client_port } = req.query;

    if (!client_ip || !client_port) {
        console.log('Missing client IP or port during /fetch-messages');
        return res.status(400).json({ error: 'Client IP and port are required' });
    }

    const clientKey = buildKey(client_ip, client_port);

    if (!clientRegistry.has(clientKey)) {
        console.log(`Client not found: ${clientKey}`);
        return res.status(404).json({ error: 'Client not registered' });
    }

    const clientMessages = [];
    // Collect messages sent to this client from any server
    serverToClientMessages.forEach((messages, serverKey) => {
        messages.forEach(({ clientKey: msgClientKey, message }) => {
            if (msgClientKey === clientKey) {
                clientMessages.push({ message });
            }
        });
    });

    if (clientMessages.length === 0) {
        console.log(`No messages for client ${clientKey}`);
        return res.status(404).json({ message: 'No messages found for this client' });
    }

    console.log(`Messages retrieved for client ${clientKey}:`, clientMessages);

    // Send the response before deleting messages
    res.json({ messages: clientMessages });

    // Now delete the messages after the response is sent
    setImmediate(() => {
        serverToClientMessages.forEach((messages, serverKey) => {
            const filteredMessages = messages.filter(({ clientKey: msgClientKey }) => msgClientKey === clientKey);
            // Remove the fetched messages for this client
            if (filteredMessages.length > 0) {
                serverToClientMessages.set(serverKey, messages.filter(({ clientKey: msgClientKey }) => msgClientKey !== clientKey));
            }
        });
    });
});

// Server fetches messages posted by clients (Client to Server)
router.get('/list-text', (req, res) => {
    const { server_ip, server_port } = req.query;

    if (!server_ip || !server_port) {
        console.log('Missing server IP or port during /fetch-client-messages');
        return res.status(400).json({ error: 'Server IP and port are required' });
    }

    const serverKey = buildKey(server_ip, server_port);

    if (!serverRegistry.has(serverKey)) {
        console.log(`Server not found or inactive: ${serverKey}`);
        return res.status(404).json({ error: 'Server not registered or inactive' });
    }

    const serverMessages = [];
    // Collect messages posted by clients to this server
    clientToServerMessages.forEach((messages, clientKey) => {
        messages.forEach(({ serverKey: msgServerKey, text }) => {
            if (msgServerKey === serverKey) {
                serverMessages.push({ text });
            }
        });
    });

    if (serverMessages.length === 0) {
        console.log(`No messages posted to server ${serverKey}`);
        return res.status(404).json({ message: 'No messages found for this server' });
    }

    console.log(`Messages retrieved for server ${serverKey}:`, serverMessages);

    // Send the response before deleting messages
    res.json({ texts: serverMessages });

    // Now delete the messages after the response is sent
    setImmediate(() => {
        clientToServerMessages.forEach((messages, clientKey) => {
            const filteredMessages = messages.filter(({ serverKey: msgServerKey }) => msgServerKey === serverKey);
            // Remove the fetched messages for this server
            if (filteredMessages.length > 0) {
                clientToServerMessages.set(clientKey, messages.filter(({ serverKey: msgServerKey }) => msgServerKey !== serverKey));
            }
        });
    });
});

export default router;
