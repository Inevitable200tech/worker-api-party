import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: 'cert.env' });

console.log('🔍 Loaded MONGODB_URI:', process.env.MONGODB_URI); // add this for debug

export const ensureDatabaseConnection = async (req, res, next) => {
  if (mongoose.connection.readyState === 0) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
    } catch (err) {
      console.error('MongoDB connection error:', err.message);
      return res.status(500).send('Database connection error');
    }
  }
  next();
};
