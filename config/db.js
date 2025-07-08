import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config({ path: 'cert.env' });

const imageDbURIs = process.env.IMAGE_DB_URIS?.split(',') || [];
const recordDbURI = process.env.RECORD_DB_URI;

const imageConnections = [];
let roundRobinIndex = 0;

console.log('Loaded IMAGE_DB_URIS:', imageDbURIs);
console.log('Loaded RECORD_DB_URI:', recordDbURI);

export const connectToImageDBs = async () => {
  for (const rawUri of imageDbURIs) {
    // Clean up the URI by trimming and removing stray quotes
    const uri = rawUri.trim().replace(/"/g, '');
    try {
      const conn = await mongoose.createConnection(uri).asPromise();
      const urlObj = new URL(uri);

      // Extract the db name from the pathname; if empty use 'appName' query parameter or 'default'
      let dbName = urlObj.pathname.slice(1);
      if (!dbName) {
        dbName = urlObj.searchParams.get('appName') || 'default';
      }

      conn.name = dbName;
      imageConnections.push(conn);
      console.log(`[INIT] Connected to image DB: ${dbName} from URI: ${uri}`);
    } catch (error) {
      console.error(`[INIT] Failed to connect using URI "${uri}":`, error);
    }
  }
};


export const getNextImageDB = () => {
  if (!imageConnections.length) {
    console.error("No image DB connections available.");
    return null;
  }
  const conn = imageConnections[roundRobinIndex];
  roundRobinIndex = (roundRobinIndex + 1) % imageConnections.length;
  return conn;
};

export const connectToRecordDB = async () => {
  return mongoose.createConnection(recordDbURI).asPromise();
};
// Connect to image databases
export { imageConnections };
