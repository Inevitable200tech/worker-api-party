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

    // if (!serverRegistry.has(serverKey)) {
    //     console.warn('[LIST] Server not found or inactive:', serverKey);
    //     return res.status(404).json({ message: 'Server not found or inactive' });
    // }

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

// —–– ZIP UPLOAD (with SHA‑256)
router.post('/upload-zip', upload.single('zip'), async (req, res) => {
    const { server_ip, server_port, filename } = req.body;
    if (!server_ip || !server_port || !filename) {
      return res.status(400).json({ error: 'Server IP, port, and filename are required' });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No .tar.xz file provided' });
    }
  
    // compute hash
    const sha256 = crypto.createHash('sha256')
                         .update(req.file.buffer)
                         .digest('hex');
  
    const finalFilename = `${filename}.tar.xz`;
    const serverKey     = buildKey(server_ip, server_port);
    const dbConn        = getNextImageDB();
    const bucket        = new GridFSBucket(dbConn.db, {
                             bucketName: 'zips',
                             chunkSizeBytes: 25 * 1024 * 1024
                          });
  
    const uploadStream = bucket.openUploadStream(finalFilename, {
      contentType: 'application/x-tar',
      metadata: { sha256 }
    });
    uploadStream.end(req.file.buffer);
  
    uploadStream.on('error', err => {
      console.error('[ZIP-UPLOAD] GridFS error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to upload .tar.xz file' });
    });
  
    uploadStream.on('finish', async () => {
      const dbName = dbConn.name;
      const zipUrl = `${dbName}/zips/${uploadStream.id}`;
  
      // save in Zip collection with hash
      await Zip.create({
        serverKey,
        originalName: finalFilename,
        zipUrl,
        uploadDate: new Date(),
        sha256
      });
  
      res.json({ message: 'ZIP uploaded successfully', zipUrl, sha256 });
    });
  });
  
  // —–– LIST ZIPS
  router.post('/list-zips', async (req, res) => {
    const { serverKey } = req.body;
    if (!serverKey) {
      return res.status(400).json({ message: 'Server key is required' });
    }
    const raw = await Zip.find({ serverKey }).select('zipUrl originalName -_id');
    if (raw.length === 0) {
      return res.status(404).json({ message: 'No zips found' });
    }
    const zips = raw.map(({ zipUrl, originalName }) => {
      const [dbName, , zipId] = zipUrl.split('/');
      return { zipUrl: `zip-file/${dbName}/${zipId}`, name: originalName };
    });
    res.json(zips);
  });
  
  // —–– ZIP DOWNLOAD with Range + safe delete
  router.get('/zip-file/:dbName/:zipId', async (req, res) => {
    const { dbName, zipId } = req.params;
    const objectId = new mongoose.Types.ObjectId(zipId);
    const dbConn   = imageConnections.find(c => c.name === dbName);
    if (!dbConn) return res.status(500).json({ error: 'Database connection error' });
  
    const bucket = new GridFSBucket(dbConn.db, { bucketName: 'zips' });
    const files  = await bucket.find({ _id: objectId }).toArray();
    if (files.length === 0) return res.status(404).json({ error: 'ZIP not found' });
  
    const file       = files[0];
    const totalLen   = file.length;
    const range      = req.headers.range;
    let start = 0, end = totalLen - 1, partial = false;
  
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d+)?/);
      if (m) {
        start   = parseInt(m[1],10);
        if (m[2]) end = parseInt(m[2],10);
        partial = true;
      }
    }
    end = Math.min(end, totalLen-1);
    const chunkSize = end - start + 1;
  
    const stream = bucket.openDownloadStream(objectId, { start, end: end+1 });
    res.status(partial?206:200)
       .set({
         'Content-Type': 'application/x-tar',
         'Accept-Ranges': 'bytes',
         'Content-Length': chunkSize,
         ...(partial && { 'Content-Range': `bytes ${start}-${end}/${totalLen}` })
       });
  
    let bytesSent = 0;
    stream.on('data', chunk => bytesSent += chunk.length);
    stream.pipe(res);
  
    res.on('close', async () => {
      // only delete if entire file was sent in one shot
      if (start===0 && bytesSent===totalLen) {
        await deleteZipFile(dbName, zipId);
      }
    });
  
    stream.on('error', err => {
      console.error('[ZIP-DOWNLOAD] Stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
    });
  });
  
  // —–– ZIP HASH from Zip collection
  router.get('/zip-hash/:dbName/:zipId', async (req, res) => {
    const { dbName, zipId } = req.params;
    const zipUrl = `${dbName}/zips/${zipId}`;
    try {
      const doc = await Zip.findOne({ zipUrl }).select('sha256 -_id');
      if (!doc) return res.status(404).json({ error: 'Not found' });
      res.json({ sha256: doc.sha256 });
    } catch (err) {
      console.error('[ZIP-HASH] Error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });
export default router;
export { router as imageRouter };
export { upload as imageUpload };
export { Image as imageModel };
export { serverRegistry as imageServerRegistry };
