import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import { buildKey, serverRegistry } from '../utils/registries.js';
import { getNextImageDB, connectToRecordDB, imageConnections } from '../config/db.js';
import getImageModel from '../models/Image.js';
import getZipModel from '../models/zip.js';
import crypto from 'crypto';

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Bind Image model to record DB connection
const recordDb = await connectToRecordDB();
const Image = getImageModel(recordDb);
const Zip = getZipModel(recordDb);

async function deleteZipFile(dbName, zipId) {
    const objectId = new mongoose.Types.ObjectId(String(zipId));
    const dbConn = imageConnections.find(conn => conn.name === dbName);
    if (!dbConn) {
        console.error(`[ZIP-DELETE] No DB connection for ${dbName}`);
        return;
    }

    const bucket = new GridFSBucket(dbConn.db, { bucketName: 'zips' });
    const zipUrl = `${dbName}/zips/${zipId}`;

    try {
        await Zip.deleteOne({ zipUrl });
        await bucket.delete(objectId);
        console.log(`[ZIP-DELETE] Deleted ZIP ${zipId}`);
    } catch (err) {
        console.error('[ZIP-DELETE] Error during deletion:', err);
    }
}


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
        const dbConn = imageConnections.find(conn => conn.name === dbName);
        if (!dbConn) {
            console.error(`[DOWNLOAD] No DB connection found for name: ${dbName}`);
            return res.status(500).json({ error: 'Database connection error' });
        }
        const bucket = new GridFSBucket(dbConn.db, { bucketName: 'images' });

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

        console.log(`[LIST] Found ${images.length} image(s) for ${serverKey}:`);
        images.forEach((img, idx) => {
            console.log(`  ${idx + 1}. ${img.imageUrl}`);
        });

        res.json(images);
    } catch (error) {
        console.error('[LIST] Error listing images:', error);
        res.status(500).json({ message: 'Server error' });
    }

});

router.post('/upload-zip', upload.single('zip'), async (req, res) => {
    const { server_ip, server_port, filename } = req.body;
  
    console.log(`[ZIP-UPLOAD] Received upload from ${server_ip}:${server_port}`);
  
    if (!server_ip || !server_port || !filename) {
      return res.status(400).json({ error: 'Server IP, port, and filename are required' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No .tar.xz file provided' });
    }
  
    // 1) compute SHA‑256 of the buffer
    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  
    const finalFilename = `${filename}.tar.xz`;
    const serverKey = buildKey(server_ip, server_port);
  
    // 2) pick a DB via round‑robin
    const dbConn = getNextImageDB();
    const bucket = new GridFSBucket(dbConn.db, {
      bucketName: 'zips',
      chunkSizeBytes: 25 * 1024 * 1024
    });
  
    console.log(
      `[ZIP-UPLOAD] Uploading to DB: ${dbConn.name}, ` +
      `Filename: ${finalFilename}, Size: ${req.file.size} bytes, SHA256: ${sha256}`
    );
  
    try {
      // 3) open upload stream with metadata
      const uploadStream = bucket.openUploadStream(finalFilename, {
        contentType: 'application/x-tar',
        metadata: { sha256 }
      });
  
      // write the buffer and end
      uploadStream.end(req.file.buffer);
  
      uploadStream.on('error', err => {
        console.error('[ZIP-UPLOAD] GridFS error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to upload .tar.xz file' });
      });
  
      uploadStream.on('finish', async () => {
        // 4) store a record in your Zip collection
        const dbName = dbConn.name;
        const zipUrl = `${dbName}/zips/${uploadStream.id}`;
  
        const zipRecord = new Zip({
          serverKey,
          originalName: finalFilename,
          zipUrl,
          uploadDate: new Date()
        });
  
        await zipRecord.save();
  
        console.log(`[ZIP-UPLOAD] Stored ZIP at ${zipUrl} with SHA256 ${sha256}`);
        res.json({ message: 'ZIP uploaded successfully', zipUrl, sha256 });
      });
    } catch (err) {
      console.error('[ZIP-UPLOAD] Handler error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });
  
router.post('/list-zips', async (req, res) => {
    const { serverKey } = req.body;
    console.log('[ZIP-LIST] Listing ZIPs for serverKey:', serverKey);

    if (!serverKey) {
        console.warn('[ZIP-LIST] Missing serverKey');
        return res.status(400).json({ message: 'Server key is required' });
    }

    // if (!serverRegistry.has(serverKey)) {
    //     console.warn('[ZIP-LIST] Server not found or inactive:', serverKey);
    //     return res.status(404).json({ message: 'Server not found or inactive' });
    // }

    try {
        const rawZips = await Zip.find({ serverKey }).select('zipUrl originalName -_id');

        if (rawZips.length === 0) {
            console.log('[ZIP-LIST] No zips found for serverKey:', serverKey);
            return res.status(404).json({ message: 'No zips found' });
        }

        const zips = rawZips.map(({ zipUrl, originalName }) => {
            const [dbName, , zipId] = zipUrl.split('/');
            return { zipUrl: `zip-file/${dbName}/${zipId}`, name: originalName };
        });

        console.log(`[ZIP-LIST] Found ${zips.length} zip(s) for ${serverKey}:`);
        zips.forEach((zip, idx) => console.log(`  ${idx + 1}. ${zip.name} (${zip.zipUrl})`));

        res.json(zips);
    } catch (err) {
        console.error('[ZIP-LIST] Error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/zip-file/:dbName/:zipId', async (req, res) => {
    const { dbName, zipId } = req.params;
    console.log(`[ZIP-DOWNLOAD] Request for ZIP ${zipId} from DB: ${dbName}`);

    try {
        const objectId = new mongoose.Types.ObjectId(zipId);
        const dbConn = imageConnections.find(conn => conn.name === dbName);
        if (!dbConn) return res.status(500).json({ error: 'Database connection error' });

        const bucket = new GridFSBucket(dbConn.db, { bucketName: 'zips' });
        const files = await bucket.find({ _id: objectId }).toArray();
        if (files.length === 0) return res.status(404).json({ error: 'ZIP not found' });

        const file = files[0];
        const totalLength = file.length;
        const range = req.headers.range;

        let start = 0;
        let end = totalLength - 1;
        let partial = false;

        if (range) {
            const match = range.match(/bytes=(\d+)-(\d+)?/);
            if (match) {
                start = parseInt(match[1], 10);
                if (match[2]) end = parseInt(match[2], 10);
                partial = true;
            }
        }

        const chunkSize = end - start + 1;
        const downloadStream = bucket.openDownloadStream(objectId, { start, end: end + 1 });

        res.status(partial ? 206 : 200);
        res.set({
            'Content-Type': 'application/x-tar',
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            ...(partial && { 'Content-Range': `bytes ${start}-${end}/${totalLength}` }),
        });

        let bytesSent = 0;

        downloadStream.on('data', (chunk) => {
            bytesSent += chunk.length;
        });

        downloadStream.pipe(res);

        res.on('close', async () => {
            const fullyDownloaded = (start === 0) && (bytesSent === totalLength);
            if (fullyDownloaded) {
                console.log(`[ZIP-DOWNLOAD] Fully downloaded ${zipId}, deleting...`);
                await deleteZipFile(dbName, zipId);
            } else {
                console.warn(`[ZIP-DOWNLOAD] Partial/incomplete download of ${zipId}, not deleting.`);
            }
        });

        downloadStream.on('error', (err) => {
            console.error('[ZIP-DOWNLOAD] Stream error:', err);
            if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
        });

    } catch (err) {
        console.error('[ZIP-DOWNLOAD] Handler error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
});

// after your download route
router.get('/zip-hash/:dbName/:zipId', async (req, res) => {
    const { dbName, zipId } = req.params;
    const objectId = new mongoose.Types.ObjectId(zipId);
    const dbConn = imageConnections.find(c => c.name === dbName);
    if (!dbConn) return res.status(500).json({ error: 'DB error' });
  
    const bucket = new GridFSBucket(dbConn.db, { bucketName: 'zips' });
    const file = await bucket.find({ _id: objectId }).next();
    if (!file) return res.status(404).json({ error: 'Not found' });
  
    const sha256 = file.metadata?.sha256;
    if (!sha256) return res.status(404).json({ error: 'No hash stored' });
    res.json({ sha256 });
  });
  

export default router;
export { router as imageRouter };
export { upload as imageUpload };
export { Image as imageModel };
export { serverRegistry as imageServerRegistry };
