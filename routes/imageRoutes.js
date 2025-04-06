import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import Image from '../models/Image.js';
import { serverRegistry } from '../utils/registries.js'; // Make sure the path is correct
const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });
const db = mongoose.connection; // Use active Mongoose connection


router.post('/upload-image', upload.single('image'), async (req, res) => {
    const { client_ip, client_port, server_ip, server_port } = req.body;
    if (!client_ip || !client_port || !server_ip || !server_port) {
        console.log('Missing client or server details during image upload');
        return res.status(400).json({ error: 'Client and server details are required' });
    }

    if (!req.file) {
        console.log('No image uploaded');
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const serverKey = buildKey(server_ip, server_port);
    console.log(`Uploading image for server: ${serverKey}`);

    try {
        const bucket = new GridFSBucket(db, { bucketName: 'images' });

        const uploadStream = bucket.openUploadStream(req.file.originalname, {
            contentType: 'image/png',
        });

        uploadStream.end(req.file.buffer);

        uploadStream.on('error', (error) => {
            console.error('Error uploading image:', error);
            res.status(500).json({ error: 'Failed to upload image' });
        });

        uploadStream.on('finish', async () => {
            const imageUrl = `images/${uploadStream.id}`;

            // Save image record to database
            const imageRecord = new Image({
                serverKey,
                imageUrl,
            });

            await imageRecord.save();
            console.log(`Image uploaded and saved: ${imageUrl}`);
            res.json({ message: 'Image uploaded successfully', imageUrl });
        });
    } catch (error) {
        console.error('Unexpected error:', error);
        res.status(500).json({ error: 'An unexpected error occurred' });
    }
});

router.get('/images/:imageId', async (req, res) => {
    const { imageId } = req.params;
    console.log(`Fetching image with ID: ${imageId}`);

    try {
        // Check if the file exists
        const bucket = new GridFSBucket(db, { bucketName: 'images' });
        const objectId = new mongoose.Types.ObjectId(imageId);

        const cursor = bucket.find({ _id: objectId });
        const files = await cursor.toArray();

        if (files.length === 0) {
            console.warn(`File not found in GridFS for ID: ${imageId}`);
            return res.status(404).json({ error: 'File not found' });
        }

        // Stream the file
        const downloadStream = bucket.openDownloadStream(objectId);
        downloadStream.pipe(res);

        downloadStream.on('error', (err) => {
            console.error('Error streaming file:', err);
            res.status(500).json({ error: 'Failed to stream file' });
        });

        downloadStream.on('end', async () => {
            console.log(`File streamed successfully for ID: ${imageId}`);

            // Delete the metadata
            const metadataDeleteResult = await Image.deleteOne({ imageUrl: `images/${imageId}` });
            if (metadataDeleteResult.deletedCount === 0) {
                console.warn(`Metadata for image ${imageId} not found.`);
            }

            // Delete the file
            bucket.delete(objectId, (err) => {
                if (err) {
                    if (err.message.includes('File not found')) {
                        console.warn(`File not found in GridFS for ID: ${imageId}, skipping deletion.`);
                    } else {
                        console.error('Error during file deletion:', err);
                    }
                } else {
                    console.log(`File deleted successfully for ID: ${imageId}`);
                }
            });
        });
    } catch (error) {
        console.error(`Error processing image ID ${imageId}:`, error);
        res.status(500).json({ error: 'An error occurred while processing the image' });
    }
});

router.post('/list-images', async (req, res) => {
    const { serverKey } = req.body;
    if (!serverKey) {
        console.log('Missing serverKey during /list-images');
        return res.status(400).json({ message: 'Server key is required' });
    }

    // Check if the server is active or exists
    if (!serverRegistry.has(serverKey)) {
        console.log(`Server not found or inactive: ${serverKey}`);
        return res.status(404).json({ message: 'Server not found or inactive' });
    }

    console.log(`Fetching images for server: ${serverKey}`);

    try {
        // Fetch images for the serverKey
        const images = await Image.find({ serverKey }).select('imageUrl -_id');

        if (images.length === 0) {
            console.log(`No images found for server: ${serverKey}`);
            return res.status(404).json({ message: 'No images found for this server' });
        }

        console.log(`Images found for server ${serverKey}:`, images);
        res.json(images); // Directly return the images array
    } catch (error) {
        console.error(`Error fetching images for server ${serverKey}:`, error);
        res.status(500).json({ message: 'An error occurred while listing images' });
    }
});

export default router;
