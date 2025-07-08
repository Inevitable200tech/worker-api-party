import mongoose from 'mongoose';

export default (conn) => {
  const imageSchema = new mongoose.Schema({
    serverKey: { type: String, required: true },
    imageUrl: { type: String, required: true, unique: true },
    uploadDate: { type: Date, default: Date.now },
  });

  return conn.model('Image', imageSchema);
};
