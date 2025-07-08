// Registries 
export const serverRegistry = new Map(); // { "ip:port": { lastPing: timestamp } }
export const clientRegistry = new Map(); // { "client_ip:client_port": { serverKey: "ip:port" } }
export const clientToServerMessages = new Map(); // { "clientKey": [{ serverKey, text, timestamp }] }
export const serverToClientMessages = new Map(); // { "serverKey": [{ clientKey, text, timestamp }] }
// Data structure to track client heartbeats: Map<clientKey, { timestamp: number, serverKey: string }>
export const clientHeartbeatLog = new Map();

// Data structure to store counts: Map<serverKey, number>
export const heartbeatCounts = new Map();

// Helper Functions
export const buildKey = (ip, port) => `${ip}:${port}`;

export const startCleanup = () => {
    const TIMEOUT = 40000;
    setInterval(() => {
      const now = Date.now();
      for (const [serverKey, data] of serverRegistry) {
        if (now - data.lastPing > TIMEOUT) {
          serverRegistry.delete(serverKey);
          clientRegistry.forEach((clientData, clientKey) => {
            if (clientData.serverKey === serverKey) {
              clientRegistry.delete(clientKey);
            }
          });
          console.log(`Inactive server removed: ${serverKey}`);
        }
      }
    }, TIMEOUT / 2);
  };