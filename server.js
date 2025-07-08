import app from './app.js';
import { startCleanup } from './utils/registries.js';
import { connectToImageDBs } from './config/db.js';

await connectToImageDBs(); // make sure all connections are set up
const PORT = 5000;

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  startCleanup();
});
