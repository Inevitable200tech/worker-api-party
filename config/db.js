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
    const uri = rawUri.trim().replace(/"/g, ''); // remove extra quotes and whitespace
    const conn = await mongoose.createConnection(uri).asPromise();
    const dbName = new URL(uri).pathname.slice(1); // should now properly be "test" or whatever it is
    conn.name = dbName;
    imageConnections.push(conn);
    console.log(`[INIT] Connected to image DB: ${dbName}`);
  }
};


export const getNextImageDB = () => {
  const conn = imageConnections[roundRobinIndex];
  roundRobinIndex = (roundRobinIndex + 1) % imageConnections.length;
  return conn;
};

export const connectToRecordDB = async () => {
  return mongoose.createConnection(recordDbURI).asPromise();
};

export { imageConnections };