import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import { buildKey, serverRegistry } from '../utils/registries.js';
import { getNextImageDB, connectToRecordDB } from '../config/db.js';
import getImageModel from '../models/Image.js';

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Bind Image model to record DB connection
const recordDb = await connectToRecordDB();
const Image = getImageModel(recordDb);

router.post('/upload-image', upload.single('image'), async (req, res) => {
    const { client_ip, client_port, server_ip, server_port } = req.body;

    if (!client_ip || !client_port || !server_ip || !server_port) {
        return res.status(400).json({ error: 'Client and server details are required' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const serverKey = buildKey(server_ip, server_port);
    const dbConn = getNextImageDB();
    const bucket = new GridFSBucket(dbConn.db, { bucketName: 'images' });

    try {
        const uploadStream = bucket.openUploadStream(req.file.originalname, {
            contentType: 'image/png',
        });

        uploadStream.end(req.file.buffer);

        uploadStream.on('error', (err) => {
            console.error('GridFS upload error:', err);
            res.status(500).json({ error: 'Failed to upload image' });
        });

        uploadStream.on('finish', async () => {
            const dbName = dbConn.name;
            const imageUrl = `${dbName}/images/${uploadStream.id}`;

            const imageRecord = new Image({ serverKey, imageUrl });
            await imageRecord.save();

            res.json({ message: 'Image uploaded successfully', imageUrl });
        });
    } catch (err) {
        console.error('Upload handler error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/images/:dbName/:imageId', async (req, res) => {
    const { dbName, imageId } = req.params;
    const objectId = new mongoose.Types.ObjectId(imageId);

    try {
        const dbConn = mongoose.connection.useDb(dbName);
        const bucket = new GridFSBucket(dbConn.db, { bucketName: 'images' });

        const files = await bucket.find({ _id: objectId }).toArray();
        if (files.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }

        const downloadStream = bucket.openDownloadStream(objectId);
        downloadStream.pipe(res);

        downloadStream.on('end', async () => {
            await Image.deleteOne({ imageUrl: `${dbName}/images/${imageId}` });
            bucket.delete(objectId, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        });

        downloadStream.on('error', (err) => {
            console.error('Stream error:', err);
            res.status(500).json({ error: 'Stream failed' });
        });
    } catch (err) {
        console.error('Retrieve handler error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/list-images', async (req, res) => {
    const { serverKey } = req.body;

    if (!serverKey) {
        return res.status(400).json({ message: 'Server key is required' });
    }

    if (!serverRegistry.has(serverKey)) {
        return res.status(404).json({ message: 'Server not found or inactive' });
    }

    try {
        const images = await Image.find({ serverKey }).select('imageUrl -_id');

        if (images.length === 0) {
            return res.status(404).json({ message: 'No images found' });
        }

        res.json(images);
    } catch (error) {
        console.error('List images error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;
export { router as imageRouter };
export { upload as imageUpload };
export { Image as imageModel };
export { serverRegistry as imageServerRegistry };