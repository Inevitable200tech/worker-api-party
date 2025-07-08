import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import { buildKey, serverRegistry } from '../utils/registries.js';
import { getNextImageDB, connectToRecordDB, imageConnections } from '../config/db.js';
import getImageModel from '../models/Image.js';
import getZipModel from '../models/zip.js';
import { Readable } from 'stream';
import crypto from 'crypto';
import cron from 'node-cron';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ path: 'cert.env' });
const BASE_URL = process.env.BASE_URL; // Get BASE_URL from .env
const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Bind Image model to record DB connection
const recordDb = await connectToRecordDB();
const Image = getImageModel(recordDb);
const Zip = getZipModel(recordDb);

// In-memory storage for chunks
const zipChunkStorage = new Map();

scheduleDeletionLogger();

// Clean up old chunks (older than 15 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of zipChunkStorage.entries()) {
    const lastModified = value.lastModified || now;
    if (now - lastModified > 15 * 30 * 1000) {// 15 minutes
      zipChunkStorage.delete(key);
    }
  }
}, 15 * 60 * 1000); // Run every 15 minutes

async function deleteZipFile(dbName, zipId) {
  const objectId = new mongoose.Types.ObjectId(String(zipId));
  const dbConn = imageConnections.find(c => c.name === dbName);
  if (!dbConn) return console.error(`[ZIP-DELETE] No DB connection for ${dbName}`);

  const bucket = new GridFSBucket(dbConn.db, { bucketName: 'zips' });
  const zipUrl = `${dbName}/zips/${zipId}`;

  try {
    // 1) delete the GridFS chunks now
    await bucket.delete(objectId);
    console.log(`[ZIP-DELETE] Deleted GridFS file ${zipId}`);

    // 2) mark the metadata doc with a deletion timestamp
    await Zip.updateOne(
      { zipUrl },
      { $set: { deletedAt: new Date() } }
    );
    console.log(`[ZIP-DELETE] Marked metadata.deletedAt for ${zipUrl}`);
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
  if (!dbConn) {
    console.error('[UPLOAD] No database connection available');
    return res.status(500).json({ error: 'No database connection available' });
  }
  const bucket = new GridFSBucket(dbConn.db, { bucketName: 'images' });

  console.log(`[UPLOAD] Using DB: ${dbConn.name} for serverKey: ${serverKey}`);
  console.log(`[UPLOAD] Uploading file: ${req.file.originalname}, size: ${req.file.size} bytes`);

  let uploadStreamId = null;

  try {
    // Step 1: Upload the image to GridFS and verify it exists
    const imageUrl = await new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(req.file.originalname, {
        contentType: 'image/png',
      });

      uploadStreamId = uploadStream.id;

      uploadStream.on('error', (err) => {
        console.error('[UPLOAD] GridFS upload error:', err);
        reject(new Error('Failed to upload image to GridFS'));
      });

      uploadStream.on('finish', async () => {
        try {
          // Verify the file exists in GridFS
          const files = await bucket.find({ _id: new mongoose.Types.ObjectId(uploadStreamId) }).toArray();
          if (files.length === 0) {
            console.error('[UPLOAD] GridFS file not found after upload');
            throw new Error('GridFS file not found after upload');
          }
          console.log(`[UPLOAD] Successfully uploaded and verified GridFS file: ${uploadStreamId}`);
          const dbName = dbConn.name;
          const imageUrl = `${dbName}/images/${uploadStream.id}`;
          resolve(imageUrl);
        } catch (err) {
          reject(err);
        }
      });

      uploadStream.end(req.file.buffer);
    });

    // Step 2: Save metadata to recordDb only after successful GridFS upload
    try {
      const imageRecord = new Image({ serverKey, imageUrl });
      await imageRecord.save();
      console.log(`[UPLOAD] Successfully saved metadata to recordDb: ${imageUrl}`);
    } catch (err) {
      console.error('[UPLOAD] Failed to save metadata to recordDb:', err);
      // Clean up the GridFS file since metadata save failed
      try {
        await bucket.delete(new mongoose.Types.ObjectId(uploadStreamId));
        console.log(`[UPLOAD] Cleaned up GridFS file due to metadata save failure: ${uploadStreamId}`);
      } catch (deleteErr) {
        console.error('[UPLOAD] Failed to clean up GridFS file:', deleteErr);
      }
      throw new Error('Failed to save metadata to recordDb');
    }

    // Step 3: Send success response
    console.log(`[UPLOAD] Image uploaded successfully to ${imageUrl}`);
    res.json({ message: 'Image uploaded successfully', imageUrl });
  } catch (err) {
    console.error('[UPLOAD] Handler error:', err.message);
    // Clean up GridFS file if it exists but an error occurred
    if (uploadStreamId) {
      try {
        await bucket.delete(new mongoose.Types.ObjectId(uploadStreamId));
        console.log(`[UPLOAD] Cleaned up GridFS file due to error: ${uploadStreamId}`);
      } catch (deleteErr) {
        console.error('[UPLOAD] Failed to clean up GridFS file:', deleteErr);
      }
    }
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// GET endpoint to download image
router.get('/images/:dbName/:imageId', async (req, res) => {
  const { dbName, imageId } = req.params;
  console.log(`[DOWNLOAD] Request for image ${imageId} from DB: ${dbName}`);

  try {
    const objectId = new mongoose.Types.ObjectId(imageId);
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

    downloadStream.on('error', (err) => {
      console.error('[DOWNLOAD] Stream error:', err);
      res.status(500).json({ error: 'Stream failed' });
    });
  } catch (err) {
    console.error('[DOWNLOAD] Handler error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE endpoint to remove image
router.delete('/images/:dbName/:imageId', async (req, res) => {
  const { dbName, imageId } = req.params;
  console.log(`[DELETE] Request to delete image ${imageId} from DB: ${dbName}`);

  try {
    const objectId = new mongoose.Types.ObjectId(imageId);
    const dbConn = imageConnections.find(conn => conn.name === dbName);
    
    if (!dbConn) {
      console.error(`[DELETE] No DB connection found for name: ${dbName}`);
      return res.status(500).json({ error: 'Database connection error' });
    }
    
    const bucket = new GridFSBucket(dbConn.db, { bucketName: 'images' });
    const files = await bucket.find({ _id: objectId }).toArray();
    
    if (files.length === 0) {
      console.warn(`[DELETE] File ${imageId} not found in DB: ${dbName}`);
      return res.status(404).json({ error: 'File not found' });
    }

    const imageUrl = `${dbName}/images/${imageId}`;
    console.log(`[DELETE] Removing metadata for ${imageUrl}`);
    await Image.deleteOne({ imageUrl });

    await bucket.delete(objectId);
    console.log(`[DELETE] Deleted image ${imageId} from GridFS`);
    
    res.status(200).json({ message: 'Image deleted successfully' });
  } catch (err) {
    console.error('[DELETE] Handler error:', err);
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

  try {
    // Limit to 50 images
    const rawImages = await Image.find({ serverKey }).select('imageUrl -_id').limit(150);

    if (rawImages.length === 0) {
      console.log('[LIST] No images found for serverKey:', serverKey);
      return res.status(404).json({ message: 'No images found' });
    }

    const images = [];
    const deletedImageUrls = [];

    for (const { imageUrl } of rawImages) {
      const [dbName, , imageId] = imageUrl.split('/');
      try {
        const objectId = new mongoose.Types.ObjectId(imageId);
        const dbConn = imageConnections.find(conn => conn.name === dbName);

        if (!dbConn) {
          console.warn(`[LIST] No DB connection found for name: ${dbName}, deleting metadata for ${imageUrl}`);
          deletedImageUrls.push(imageUrl);
          continue;
        }

        const bucket = new GridFSBucket(dbConn.db, { bucketName: 'images' });
        const files = await bucket.find({ _id: objectId }).toArray();

        if (files.length === 0) {
          console.warn(`[LIST] File ${imageId} not found in DB: ${dbName}, deleting metadata for ${imageUrl}`);
          deletedImageUrls.push(imageUrl);
        } else {
          images.push({ imageUrl: `images/${dbName}/${imageId}` });
        }
      } catch (err) {
        console.warn(`[LIST] Invalid ObjectId or error checking ${imageUrl}: ${err.message}, deleting metadata`);
        deletedImageUrls.push(imageUrl);
      }
    }

    // Delete metadata for non-existent images
    if (deletedImageUrls.length > 0) {
      await Image.deleteMany({ imageUrl: { $in: deletedImageUrls } });
      console.log(`[LIST] Deleted metadata for ${deletedImageUrls.length} non-existent image(s):`, deletedImageUrls);
    }

    if (images.length === 0) {
      console.log('[LIST] No valid images found for serverKey:', serverKey);
      return res.status(404).json({ message: 'No valid images found' });
    }

    console.log(`[LIST] Found ${images.length} valid image(s) for ${serverKey}:`);
    images.forEach((img, idx) => {
      console.log(`  ${idx + 1}. ${img.imageUrl}`);
    });

    res.json(images);
  } catch (error) {
    console.error('[LIST] Error listing images:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Endpoint to upload a single chunk
router.post('/upload-zip-chunk', upload.single('chunk'), async (req, res) => {
  console.log('=== ZIP-CHUNK-UPLOAD START ===');
  const { server_ip, server_port, filename, chunkIndex, totalChunks } = req.body;

  if (!server_ip || !server_port || !filename || !chunkIndex || !totalChunks) {
    console.warn('[ZIP-CHUNK-UPLOAD] Missing parameters');
    return res.status(400).json({ error: 'Server IP, port, filename, chunkIndex, and totalChunks are required' });
  }

  if (!req.file) {
    console.warn('[ZIP-CHUNK-UPLOAD] No chunk provided');
    return res.status(400).json({ error: 'No chunk provided' });
  }

  const serverKey = buildKey(server_ip, server_port);
  const storageKey = `${serverKey}-${filename}`;

  if (!zipChunkStorage.has(storageKey)) {
    zipChunkStorage.set(storageKey, {
      chunks: new Array(parseInt(totalChunks)),
      totalChunks: parseInt(totalChunks),
      lastModified: Date.now()
    });
  }

  const storage = zipChunkStorage.get(storageKey);
  storage.chunks[parseInt(chunkIndex)] = req.file.buffer;
  storage.lastModified = Date.now();

  console.log('[ZIP-CHUNK-UPLOAD] Stored chunk', chunkIndex);
  res.status(200).json({ message: 'Chunk uploaded' });
});

router.post('/finalize-zip-upload', async (req, res) => {
  console.log('=== ZIP-FINALIZE-UPLOAD START ===');
  console.log('[ZIP-FINALIZE-UPLOAD] Content-Type:', req.get('Content-Type'));
  console.log('[ZIP-FINALIZE-UPLOAD] Request body:', req.body);

  const { server_ip, server_port, filename } = req.body;

  if (!server_ip || !server_port || filename === undefined) {
    console.warn('[ZIP-FINALIZE-UPLOAD] Missing parameters');
    console.warn('[ZIP-FINALIZE-UPLOAD] server_ip:', server_ip);
    console.warn('[ZIP-FINALIZE-UPLOAD] server_port:', server_port);
    console.warn('[ZIP-FINALIZE-UPLOAD] filename:', filename);
    return res.status(400).json({ error: 'Server IP, port, and filename are required' });
  }

  const serverKey = buildKey(server_ip, server_port);
  const storageKey = `${serverKey}-${filename}`;

  if (!zipChunkStorage.has(storageKey)) {
    console.warn('[ZIP-FINALIZE-UPLOAD] No chunks found');
    return res.status(400).json({ error: 'No chunks found for this upload' });
  }

  const storage = zipChunkStorage.get(storageKey);
  const { chunks, totalChunks } = storage;

  for (let i = 0; i < totalChunks; i++) {
    if (!chunks[i]) {
      console.warn('[ZIP-FINALIZE-UPLOAD] Missing chunk', i);
      return res.status(400).json({ error: `Missing chunk ${i}` });
    }
  }

  const buffer = Buffer.concat(chunks);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const finalFilename = `${filename}.tar.xz`;

  const dbConn = getNextImageDB();
  const bucket = new GridFSBucket(dbConn.db, {
    bucketName: 'zips',
    chunkSizeBytes: 15 * 1024 * 1024
  });

  const uploadStream = bucket.openUploadStream(finalFilename, {
    contentType: 'application/x-tar',
    metadata: { sha256 }
  });

  const bufferStream = Readable.from(buffer);
  bufferStream.pipe(uploadStream);

  uploadStream.on('error', (err) => {
    console.error('[ZIP-FINALIZE-UPLOAD] GridFS stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to upload .tar.xz file' });
  });

  uploadStream.on('finish', async () => {
    const dbName = dbConn.name;
    const zipUrl = `${dbName}/zips/${uploadStream.id}`;

    try {
      const record = await Zip.create({
        serverKey,
        originalName: finalFilename,
        zipUrl,
        uploadDate: new Date(),
        sha256
      });
      console.log('[ZIP-FINALIZE-UPLOAD] Zip created:', record);
      res.json({ message: 'ZIP uploaded successfully', zipUrl, sha256 });
    } catch (e) {
      console.error('[ZIP-FINALIZE-UPLOAD] Error saving Zip:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to save ZIP metadata' });
    } finally {
      zipChunkStorage.delete(storageKey);
    }
  });
});


// —–– LIST ZIPS
router.post('/list-zips', async (req, res) => {
  const { serverKey } = req.body;
  if (!serverKey) {
    return res.status(400).json({ message: 'Server key is required' });
  }
  const raw = await Zip.find({
    serverKey,
    deletedAt: { $exists: false }
  }).select('zipUrl originalName -_id');
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
  const dbConn = imageConnections.find(c => c.name === dbName);
  if (!dbConn) return res.status(500).json({ error: 'Database connection error' });

  const bucket = new GridFSBucket(dbConn.db, { bucketName: 'zips' });
  const files = await bucket.find({ _id: objectId }).toArray();
  if (files.length === 0) return res.status(404).json({ error: 'ZIP not found' });

  const file = files[0];
  const totalLen = file.length;
  const range = req.headers.range;
  let start = 0, end = totalLen - 1, partial = false;

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d+)?/);
    if (m) {
      start = parseInt(m[1], 10);
      if (m[2]) end = parseInt(m[2], 10);
      partial = true;
    }
  }
  end = Math.min(end, totalLen - 1);
  const chunkSize = end - start + 1;

  const stream = bucket.openDownloadStream(objectId, { start, end: end + 1 });
  res.status(partial ? 206 : 200)
    .set({
      'Content-Type': 'application/x-tar',
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      ...(partial && { 'Content-Range': `bytes ${start}-${end}/${totalLen}` })
    });

  let bytesSent = 0;
  stream.on('data', chunk => bytesSent += chunk.length);
  stream.pipe(res);

  res.on('finish', async () => {
    // only delete if entire file was sent in one shot
    if (start === 0 && bytesSent === totalLen) {
      await deleteZipFile(dbName, zipId);
    }
  });

  stream.on('error', err => {
    console.error('[ZIP-DOWNLOAD] Stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed' });
  });
});

// —–– ZIP HASH from Zip collection
// —–– ZIP HASH from Zip collection (with extra logging)
router.get('/zip-hash/:dbName/:zipId', async (req, res) => {
  const { dbName, zipId } = req.params;
  const zipUrl = `${dbName}/zips/${zipId}`;

  console.log('====================================');
  console.log('[ZIP-HASH] endpoint hit');
  console.log('[ZIP-HASH] params:', { dbName, zipId });
  console.log('[ZIP-HASH] constructed zipUrl:', zipUrl);

  try {
    // Show how many Zip documents exist at all
    const totalZips = await Zip.countDocuments();
    console.log('[ZIP-HASH] total Zip docs in collection:', totalZips);

    // Attempt to find
    const doc = await Zip.findOne({ zipUrl }).select('sha256 -_id').lean();
    console.log('[ZIP-HASH] findOne({ zipUrl }) returned:', doc);

    if (!doc) {
      console.warn('[ZIP-HASH] ⚠️ no document matched that zipUrl');
      return res.status(404).json({ error: 'Not found' });
    }

    console.log('[ZIP-HASH] ✅ returning sha256:', doc.sha256);
    res.json({ sha256: doc.sha256 });
  } catch (err) {
    console.error('[ZIP-HASH] 💥 error during lookup:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function scheduleDeletionLogger() {
  // cron expression: “every 30 seconds”
  cron.schedule('*/60 * * * * *', async () => {
    try {
      const now = Date.now();
      // find all docs that have been marked deleted
      const toDelete = await Zip.find({ deletedAt: { $exists: true } })
        .select('zipUrl deletedAt -_id')
        .lean();

      if (toDelete.length === 0) {
        console.log('[DELETION‑LOGGER] No metadata pending TTL‑deletion');
        return;
      }

      console.log(`\n[DELETION‑LOGGER] ${toDelete.length} ZIP(s) pending TTL removal:`);
      toDelete.forEach(doc => {
        const deletedMs = new Date(doc.deletedAt).getTime();
        const expireMs = deletedMs + 24 * 3600 * 1000;
        const msRemaining = expireMs - now;
        const secTotal = Math.max(0, Math.floor(msRemaining / 1000));

        // convert to hours, minutes, seconds
        const hours = Math.floor(secTotal / 3600);
        const minutes = Math.floor((secTotal % 3600) / 60);
        const seconds = secTotal % 60;

        console.log(` • ${doc.zipUrl}`);
        console.log(`     deletedAt:    ${doc.deletedAt}`);
        console.log(`     expires in:  ${hours}h ${minutes}m ${seconds}s`);
      });

    } catch (err) {
      console.error('[DELETION‑LOGGER] error fetching metadata:', err);
    }
  });
}


export default router;
export { router as imageRouter };
export { upload as imageUpload };
export { Image as imageModel };
export { serverRegistry as imageServerRegistry };
