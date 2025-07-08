import express from 'express';
import cors from 'cors';
import serverRoutes from './routes/serverRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import imageRoutes from './routes/imageRoutes.js';
import textRoutes from './routes/textRoutes.js';
import { imageConnections } from './config/db.js';
import { getTotalHeartbeatClientCount } from './routes/serverRoutes.js';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MAX_DB_CAPACITY_MB = 512; // Each database max capacity

// Helper to determine status based on usage percentage
const determineOverallStatus = (usagePercent) => {
  if (usagePercent > 90) return 'very busy';
  if (usagePercent > 70) return 'busy';
  if (usagePercent > 50) return 'slightly busy';
  return 'idle';
};

// Health check
app.get('/health', async (req, res) => {
  try {
    const connectedDatabases = imageConnections.length;

    if (connectedDatabases === 0) {
      return res.status(500).json({ message: 'No database connections available' });
    }

    const storageSizes = await Promise.all(
      imageConnections.map(async (conn) => {
        const stats = await conn.db.command({ dbStats: 1 });
        const storageSizeMB = stats.storageSize / (1024 * 1024);
        return storageSizeMB;
      })
    );

    const totalUsedMB = storageSizes.reduce((sum, size) => sum + size, 0);
    const totalCapacityMB = connectedDatabases * MAX_DB_CAPACITY_MB;
    const usagePercent = (totalUsedMB / totalCapacityMB) * 100;

    const overallStatus = determineOverallStatus(usagePercent);

    // Check for critical warning
    let criticalWarning = null;
    if (usagePercent >= 90) {
      criticalWarning = 'Storage almost full! Add more databases or free space.';
    }

    const response = {
      message: 'I am alive',
      total_Used_MB: totalUsedMB.toFixed(2),
      total_Capacity_MB: totalCapacityMB,
      usage_Percent: usagePercent.toFixed(2),
      database_Status: overallStatus,
      total_Heartbeat_Client_Count: getTotalHeartbeatClientCount()
    };

    if (criticalWarning) {
      response.critical_Warning = criticalWarning;
    }

    res.json(response);
  } catch (error) {
    console.error('[HEALTH] Error checking database stats:', error);
    res.status(500).json({ message: 'Health check failed', error: error.message });
  }
});

// Mount routes
app.use(serverRoutes);
app.use(clientRoutes);
app.use(imageRoutes);
app.use(textRoutes);

export default app;
