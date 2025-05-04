// models/Zip.js
import mongoose from 'mongoose';

export default (conn) => {
  const zipSchema = new mongoose.Schema({
    serverKey: { type: String, required: true },
    originalName: { type: String, required: true },
    zipUrl: { type: String, required: true, unique: true },
    uploadDate: { type: Date, default: Date.now },
    sha256: { type: String, required: true },
    deletedAt: { type: Date }               // ← new
  });

  zipSchema.index({ deletedAt: 1 }, { expireAfterSeconds: 86400 });
  // This will automatically delete documents after 1 day (86400 seconds)

  return conn.model('Zip', zipSchema);
};
