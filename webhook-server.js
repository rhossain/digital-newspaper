const express = require('express');
const { exec } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.WEBHOOK_PORT || 3001;

// Load webhook secret from config
let WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

// Try to load from local config file if not in environment
if (!WEBHOOK_SECRET) {
  const configPath = path.join(__dirname, 'webhook.config.local.js');
  if (fs.existsSync(configPath)) {
    const config = require(configPath);
    WEBHOOK_SECRET = config.secret;
  }
}

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Webhook server is running' });
});

// Verify GitHub webhook signature
function verifySignature(req) {
  if (!WEBHOOK_SECRET) {
    console.warn('⚠️  No webhook secret configured - skipping signature verification');
    return true;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return false;
  }

  const payload = JSON.stringify(req.body);
  const hash = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  console.log('\n📡 Webhook received from GitHub');

  // Verify signature for security
  if (!verifySignature(req)) {
    console.error('❌ Invalid signature - rejecting webhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;

  console.log(`📦 Event: ${event}`);

  // Only process push events
  if (event !== 'push') {
    console.log('ℹ️  Ignoring non-push event');
    return res.json({ message: 'Event ignored' });
  }

  const branch = payload.ref.replace('refs/heads/', '');
  const repo = payload.repository.full_name;
  const pusher = payload.pusher.name;
  const commits = payload.commits.length;

  console.log(`🌿 Branch: ${branch}`);
  console.log(`📝 Commits: ${commits}`);
  console.log(`👤 Pusher: ${pusher}`);

  // Only deploy development branch
  if (branch !== 'development') {
    console.log(`ℹ️  Branch '${branch}' is not configured for auto-deployment`);
    return res.json({ message: `Branch '${branch}' ignored` });
  }

  // Respond immediately to GitHub
  res.json({ message: 'Deployment started', branch, commits });

  // Run deployment script asynchronously
  console.log('\n🚀 Starting deployment...\n');
  const deployScript = path.join(__dirname, 'auto-deploy.sh');
  
  // Set environment variable to indicate webhook deployment
  const env = { ...process.env, WEBHOOK_DEPLOY: 'true' };
  
  exec(`bash ${deployScript}`, { env }, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Deployment failed: ${error.message}`);
      console.error(stderr);
      return;
    }
    
    console.log(stdout);
    console.log('\n✅ Deployment completed successfully!\n');
  });
});

// Start server
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║     GitHub Webhook Server Running         ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`\n🌐 Port: ${PORT}`);
  console.log(`🔐 Secret: ${WEBHOOK_SECRET ? 'Configured ✓' : 'Not configured ⚠️'}`);
  console.log(`📍 Webhook URL: http://your-domain.com:${PORT}/webhook`);
  console.log(`💚 Health check: http://your-domain.com:${PORT}/health`);
  console.log('\n🎯 Listening for GitHub push events on "development" branch...\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down webhook server...');
  process.exit(0);
});
