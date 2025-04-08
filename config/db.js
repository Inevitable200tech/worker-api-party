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
    const uri = rawUri.trim().replace(/"/g, ''); // clean up any stray quotes
    const conn = await mongoose.createConnection(uri).asPromise();
    const urlObj = new URL(uri);
    let dbName = urlObj.pathname.slice(1); // might be empty if just "/"
    if (!dbName) {
      dbName = urlObj.searchParams.get('appName') || 'default';
    }
    conn.name = dbName;
    imageConnections.push(conn);
    console.log(`[INIT] Connected to image DB: ${dbName}`);
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

export { imageConnections };
