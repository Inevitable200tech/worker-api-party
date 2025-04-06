import app from './app.js';
import { startCleanup } from './utils/registries.js';

const PORT = 5000;

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  startCleanup();
});
