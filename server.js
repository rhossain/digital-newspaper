const express = require('express');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'src/assets/newspaper-data.json');
const CROPPED_IMAGES_DIR = path.join(__dirname, 'src/assets/cropped');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'digital-newspaper';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const supabase = USE_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

console.log(`🔧 Storage mode: ${USE_SUPABASE ? 'Supabase' : 'Local FS (ephemeral)'}`);
if (USE_SUPABASE) {
  console.log(`🗄️  Supabase bucket: ${SUPABASE_BUCKET}`);
} else {
  console.log('⚠️  Supabase not configured. Data will not persist on Render restarts.');
}

// Middleware
app.use(cors());
app.use(compression()); // Enable gzip compression
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 images
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// In-memory cache for newspaper data
let dataCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 60000; // 1 minute

// Ensure cropped images directory exists (local fallback only)
if (!USE_SUPABASE) {
  (async () => {
    try {
      await fs.mkdir(CROPPED_IMAGES_DIR, { recursive: true });
    } catch (error) {
      console.error('Error creating cropped images directory:', error);
    }
  })();
}

async function readData() {
  if (USE_SUPABASE) {
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download('data/newspaper-data.json');
    if (error) {
      // If missing, return default structure
      return { settings: { defaultDateMode: 'current', socialLinks: {} }, editions: [] };
    }
    const buffer = Buffer.from(await data.arrayBuffer());
    return JSON.parse(buffer.toString('utf8'));
  }

  const data = await fs.readFile(DATA_FILE, 'utf8');
  return JSON.parse(data);
}

async function writeData(payload) {
  if (USE_SUPABASE) {
    const jsonBuffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const { error } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload('data/newspaper-data.json', jsonBuffer, { upsert: true, contentType: 'application/json' });
    if (error) throw error;
    return;
  }

  const data = JSON.stringify(payload, null, 2);
  await fs.writeFile(DATA_FILE, data, 'utf8');
}

function getPublicUrl(pathInBucket) {
  if (!SUPABASE_URL) return pathInBucket;
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${pathInBucket}`;
}

// API Routes
app.get('/api/newspaper-data', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached data if available and fresh
    if (dataCache && (now - cacheTimestamp) < CACHE_DURATION) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(dataCache);
    }
    
    // Read fresh data
    const data = await readData();
    
    // Update cache
    dataCache = data;
    cacheTimestamp = now;
    
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (error) {
    console.error('Error reading data:', error);
    res.status(500).json({ error: 'Failed to read data' });
  }
});

app.post('/api/newspaper-data', async (req, res) => {
  try {
    await writeData(req.body);
    
    // Invalidate cache
    dataCache = req.body;
    cacheTimestamp = Date.now();
    
    res.json({ success: true, message: 'Data saved successfully' });
  } catch (error) {
    console.error('Error saving data:', error);
    res.status(500).json({ error: 'Failed to save data' });
  }
});

app.post('/api/upload-image', async (req, res) => {
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
    
    // Generate unique filename
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const finalFileName = `${safeName}_${timestamp}.${extension}`;
    if (USE_SUPABASE) {
      const storagePath = `images/${finalFileName}`;
      const { error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(storagePath, buffer, { upsert: true, contentType: `image/${extension}` });
      if (error) throw error;

      res.json({
        success: true,
        path: getPublicUrl(storagePath),
        message: 'Image uploaded successfully'
      });
      return;
    }

    const filePath = path.join(CROPPED_IMAGES_DIR, finalFileName);
    await fs.writeFile(filePath, buffer);
    const relativePath = `assets/cropped/${finalFileName}`;
    res.json({ success: true, path: relativePath, message: 'Image uploaded successfully' });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

app.post('/api/upload-cropped-image', async (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    
    if (!imageData || !fileName) {
      return res.status(400).json({ error: 'Missing imageData or fileName' });
    }
    
    // Remove data:image/jpeg;base64, prefix
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Generate unique filename
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const finalFileName = `${safeName}_${timestamp}.jpg`;
    if (USE_SUPABASE) {
      const storagePath = `cropped/${finalFileName}`;
      const { error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(storagePath, buffer, { upsert: true, contentType: 'image/jpeg' });
      if (error) throw error;

      res.json({
        success: true,
        path: getPublicUrl(storagePath),
        message: 'Image saved successfully'
      });
      return;
    }

    const filePath = path.join(CROPPED_IMAGES_DIR, finalFileName);
    await fs.writeFile(filePath, buffer);
    const relativePath = `assets/cropped/${finalFileName}`;
    res.json({ success: true, path: relativePath, message: 'Image saved successfully' });
  } catch (error) {
    console.error('Error saving cropped image:', error);
    res.status(500).json({ error: 'Failed to save cropped image' });
  }
});

app.get('/api/proxy-image', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    if (!imageUrl) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch image' });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
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
