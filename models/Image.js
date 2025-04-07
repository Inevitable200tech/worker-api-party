// This file defines a Mongoose model for an image, including its schema and export statement.
export default (conn) => {
  const imageSchema = new conn.Schema({
    serverKey: { type: String, required: true },
    imageUrl: { type: String, required: true, unique: true },
    uploadDate: { type: Date, default: Date.now },
  });

  return conn.model('Image', imageSchema);
};
