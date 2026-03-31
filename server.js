const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs').promises;
const path = require('path');
const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'src/assets/newspaper-data.json');
const CROPPED_IMAGES_DIR = path.join(__dirname, 'src/assets/cropped');

console.log('🔧 Storage mode: Local FS');

// Trust Cloudflare proxy — required for correct IP in rate limiting
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow images to be loaded cross-origin
}));

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 300,             // 300 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 20,              // 20 uploads per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload rate limit exceeded.' },
});

// Middleware
app.use(cors());
app.use(compression()); // Enable gzip compression
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/api', generalLimiter);

// Ensure cropped images directory exists
(async () => {
  try {
    await fs.mkdir(CROPPED_IMAGES_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating cropped images directory:', error);
  }
})();

let dataCache = null;

async function readData() {
  if (dataCache) return dataCache;
  const data = await fs.readFile(DATA_FILE, 'utf8');
  dataCache = JSON.parse(data);
  return dataCache;
}

async function writeData(payload) {
  const data = JSON.stringify(payload, null, 2);
  await fs.writeFile(DATA_FILE, data, 'utf8');
  dataCache = payload; // update cache on write
}

// API Routes
app.get('/api/newspaper-data', async (req, res) => {
  try {
    const data = await readData();
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(data);
  } catch (error) {
    console.error('Error reading data:', error);
    res.status(500).json({ error: 'Failed to read data' });
  }
});

app.post('/api/newspaper-data', async (req, res) => {
  try {
    await writeData(req.body);
    res.json({ success: true, message: 'Data saved successfully' });
  } catch (error) {
    console.error('Error saving data:', error);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

app.post('/api/upload-image', uploadLimiter, async (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    
    if (!imageData || !fileName) {
      return res.status(400).json({ error: 'Missing imageData or fileName' });
    }
    
    // Remove data:image/xxx;base64, prefix
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Detect image format from data URL
    const formatMatch = imageData.match(/^data:image\/(\w+);base64,/);
    const format = formatMatch ? formatMatch[1] : 'jpg';
    const extension = format === 'jpeg' ? 'jpg' : format;
    
    // Organise into YYYY/MM subfolders to support 50k+ images without FS slowdown
    const now = new Date();
    const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const uploadDir = path.join(CROPPED_IMAGES_DIR, subDir);
    await fs.mkdir(uploadDir, { recursive: true });
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const finalFileName = `${safeName}_${timestamp}.${extension}`;
    const filePath = path.join(uploadDir, finalFileName);
    await fs.writeFile(filePath, buffer);
    const relativePath = `assets/cropped/${subDir}/${finalFileName}`;
    res.json({ success: true, path: relativePath, message: 'Image uploaded successfully' });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

app.post('/api/upload-cropped-image', uploadLimiter, async (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    
    if (!imageData || !fileName) {
      return res.status(400).json({ error: 'Missing imageData or fileName' });
    }
    
    // Remove data:image/jpeg;base64, prefix
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Organise into YYYY/MM subfolders to support 50k+ images without FS slowdown
    const now = new Date();
    const subDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const uploadDir = path.join(CROPPED_IMAGES_DIR, subDir);
    await fs.mkdir(uploadDir, { recursive: true });
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const finalFileName = `${safeName}_${timestamp}.jpg`;
    const filePath = path.join(uploadDir, finalFileName);
    await fs.writeFile(filePath, buffer);
    const relativePath = `assets/cropped/${subDir}/${finalFileName}`;
    res.json({ success: true, path: relativePath, message: 'Image saved successfully' });
  } catch (error) {
    console.error('Error saving cropped image:', error);
    res.status(500).json({ error: 'Failed to save cropped image' });
  }
});

// SSRF protection helper — only allow public HTTP/HTTPS URLs
function isSafeUrl(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  // Block private/loopback ranges
  if (
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === '0.0.0.0' ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) return false;
  return true;
}

app.get('/api/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }
    if (!isSafeUrl(imageUrl)) {
      return res.status(400).json({ error: 'Invalid or disallowed URL' });
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch image' });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'URL does not point to an image' });
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.send(buffer);
  } catch (error) {
    console.error('Error proxying image:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Backend server running on http://localhost:${PORT}`);
  console.log(`📊 API endpoint: http://localhost:${PORT}/api/newspaper-data`);
});
