import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ensureDatabaseConnection } from './middleware/dbMiddleware.js';
import serverRoutes from './routes/serverRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import imageRoutes from './routes/imageRoutes.js';
import textRoutes from './routes/textRoutes.js';

dotenv.config({ path: 'cert.env' });

const app = express();

app.use(cors());
app.use(express.json());
app.use(ensureDatabaseConnection);

// Health check
app.get('/health', (req, res) => res.json({ message: 'I am alive' }));

// Mount routes
app.use(serverRoutes);
app.use(clientRoutes);
app.use(imageRoutes);
app.use(textRoutes);

export default app;
