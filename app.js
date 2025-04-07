import express from 'express';
import cors from 'cors';
import serverRoutes from './routes/serverRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import imageRoutes from './routes/imageRoutes.js';
import textRoutes from './routes/textRoutes.js';


const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ message: 'I am alive' }));

// Mount routes
app.use(serverRoutes);
app.use(clientRoutes);
app.use(imageRoutes);
app.use(textRoutes);

export default app;
