import mongoose from 'mongoose';

export const connectToMongo = async (uri) => {
  return mongoose.connect(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
};
