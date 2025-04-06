import mongoose from 'mongoose';

const imageSchema = new mongoose.Schema({
  serverKey: { type: String, required: true },
  imageUrl: { type: String, required: true },
  uploadDate: { type: Date, default: Date.now },
});

export default mongoose.model('Image', imageSchema);
