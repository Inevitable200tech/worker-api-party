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

    console.log('[UPLOAD] Received request from client:', { client_ip, client_port, server_ip, server_port });

    if (!client_ip || !client_port || !server_ip || !server_port) {
        console.warn('[UPLOAD] Missing required client/server details');
        return res.status(400).json({ error: 'Client and server details are required' });
    }

    if (!req.file) {
        console.warn('[UPLOAD] No file received in request');
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const serverKey = buildKey(server_ip, server_port);
    const dbConn = getNextImageDB();
    const bucket = new GridFSBucket(dbConn.db, { bucketName: 'images' });

    console.log(`[UPLOAD] Using DB: ${dbConn.name} for serverKey: ${serverKey}`);
    console.log(`[UPLOAD] Uploading file: ${req.file.originalname}, size: ${req.file.size} bytes`);

    try {
        const uploadStream = bucket.openUploadStream(req.file.originalname, {
            contentType: 'image/png',
        });

        uploadStream.end(req.file.buffer);

        uploadStream.on('error', (err) => {
            console.error('[UPLOAD] GridFS error:', err);
            res.status(500).json({ error: 'Failed to upload image' });
        });

        uploadStream.on('finish', async () => {
            const dbName = dbConn.name;
            const imageUrl = `${dbName}/images/${uploadStream.id}`;

            const imageRecord = new Image({ serverKey, imageUrl });
            await imageRecord.save();

            console.log(`[UPLOAD] Successfully uploaded image to ${imageUrl}`);
            res.json({ message: 'Image uploaded successfully', imageUrl });
        });
    } catch (err) {
        console.error('[UPLOAD] Handler error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/images/:dbName/:imageId', async (req, res) => {
    const { dbName, imageId } = req.params;
    console.log(`[DOWNLOAD] Request for image ${imageId} from DB: ${dbName}`);

    const objectId = new mongoose.Types.ObjectId(imageId);

    try {
        const client = mongoose.connection.getClient(); // get native MongoClient
        const db = client.db(dbName); // get specific DB by name
        const bucket = new GridFSBucket(db, { bucketName: 'images' });


        const files = await bucket.find({ _id: objectId }).toArray();
        if (files.length === 0) {
            console.warn(`[DOWNLOAD] File ${imageId} not found in DB: ${dbName}`);
            return res.status(404).json({ error: 'File not found' });
        }

        const downloadStream = bucket.openDownloadStream(objectId);
        downloadStream.pipe(res);

        downloadStream.on('end', async () => {
            console.log(`[DOWNLOAD] Completed streaming ${imageId}, now deleting from DB`);
            const imageUrl = `${dbName}/images/${imageId}`;
            console.log(`[DOWNLOAD] Removing metadata for ${imageUrl}`);
            await Image.deleteOne({ imageUrl });

            bucket.delete(objectId, (err) => {
                if (err) console.error('[DOWNLOAD] Error deleting file:', err);
                else console.log(`[DOWNLOAD] Deleted image ${imageId} from GridFS`);
            });
        });

        downloadStream.on('error', (err) => {
            console.error('[DOWNLOAD] Stream error:', err);
            res.status(500).json({ error: 'Stream failed' });
        });
    } catch (err) {
        console.error('[DOWNLOAD] Handler error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/list-images', async (req, res) => {
    const { serverKey } = req.body;
    console.log('[LIST] Listing images for serverKey:', serverKey);

    if (!serverKey) {
        console.warn('[LIST] Missing serverKey');
        return res.status(400).json({ message: 'Server key is required' });
    }

    if (!serverRegistry.has(serverKey)) {
        console.warn('[LIST] Server not found or inactive:', serverKey);
        return res.status(404).json({ message: 'Server not found or inactive' });
    }

    try {
        const rawImages = await Image.find({ serverKey }).select('imageUrl -_id');

        if (rawImages.length === 0) {
            console.log('[LIST] No images found for serverKey:', serverKey);
            return res.status(404).json({ message: 'No images found' });
        }

        const images = rawImages.map(({ imageUrl }) => {
            const [dbName, , imageId] = imageUrl.split('/');
            return { imageUrl: `images/${dbName}/${imageId}` };
        });

        console.log(`[LIST] Found ${images.length} image(s) for ${serverKey}`);
        res.json(images);

    } catch (error) {
        console.error('[LIST] Error listing images:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;
export { router as imageRouter };
export { upload as imageUpload };
export { Image as imageModel };
export { serverRegistry as imageServerRegistry };
