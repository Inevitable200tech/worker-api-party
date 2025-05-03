// models/Zip.js
import mongoose from 'mongoose';

export default (conn) => {
  const zipSchema = new mongoose.Schema({
    serverKey: { type: String, required: true },
    originalName: { type: String, required: true },
    zipUrl: { type: String, required: true, unique: true },
    uploadDate: { type: Date, default: Date.now },
    sha256: { type: String, required: true }    // ← new
  });

  return conn.model('Zip', zipSchema);
};
