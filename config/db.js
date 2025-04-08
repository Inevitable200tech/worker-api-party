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
  for (const uri of imageDbURIs) {
    const conn = await mongoose.createConnection(uri).asPromise();
    imageConnections.push(conn);
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

export {imageConnections};