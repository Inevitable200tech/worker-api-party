import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: 'cert.env' });

const imageDbURIs = process.env.IMAGE_DB_URIS.split(','); // comma-separated
const recordDbURI = process.env.RECORD_DB_URI;

let dbIndex = 0;
const dbConnections = {};

// connect to all image DBs and record DB
imageDbURIs.forEach((uri, i) => {
  dbConnections[`imgDb${i}`] = mongoose.createConnection(uri.trim(), {});
});

const recordDb = mongoose.createConnection(recordDbURI.trim(), {});
dbConnections.recordDb = recordDb;

export const getNextImageDb = () => {
  const key = `imgDb${dbIndex}`;
  dbIndex = (dbIndex + 1) % imageDbURIs.length;
  return dbConnections[key];
};

export const getRecordDb = () => {
  return dbConnections.recordDb;
};
