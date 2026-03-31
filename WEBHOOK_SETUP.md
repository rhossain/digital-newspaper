# GitHub Webhook Auto-Deployment Setup

Complete guide to set up automatic deployment triggered by GitHub webhooks.

## 🎯 How It Works

```
┌──────────┐         ┌──────────┐         ┌──────────┐
│  GitHub  │ push    │ Webhook  │ trigger │  Deploy  │
│  Repo    │────────>│  Server  │────────>│  Script  │
└──────────┘         └──────────┘         └──────────┘
                          │                      │
                          │                      ▼
                          │              ┌──────────────┐
                          │              │ Pull → Build │
                          └─────────────>│ → Update     │
                                         └──────────────┘
```

1. You push to `development` branch
2. GitHub sends webhook to your server
3. Webhook server verifies and triggers deployment
4. Deploy script: pulls, builds, and deploys automatically

## 📋 Prerequisites

- Hostinger hosting with SSH access
- Node.js installed on server
- Git configured on server
- Your repository cloned on server

## 🚀 Server Setup (One-Time)

### Step 1: Connect to Your Server

```bash
ssh your-username@your-server-ip
```

### Step 2: Clone Repository (if not already done)

```bash
cd /home/your-username
git clone https://github.com/rhossain/digital-newspaper.git
cd digital-newspaper
npm install
```

### Step 3: Generate Webhook Secret

```bash
openssl rand -hex 32
```

Copy the generated secret - you'll need it for both server and GitHub.

### Step 4: Configure Webhook Server

Edit `webhook.config.local.js`:

```javascript
module.exports = {
  secret: 'paste-your-generated-secret-here',
  port: 3001,
  branch: 'development',
  projectDir: '/home/your-username/digital-newspaper'  // Update this
};
```

### Step 5: Configure Deploy Script

Edit `auto-deploy.sh` and update:

```bash
PROJECT_DIR="/home/your-username/digital-newspaper"  # Line 12
```

Make it executable:

```bash
chmod +x auto-deploy.sh
```

### Step 6: Install PM2 (Process Manager)

```bash
npm install -g pm2
```

### Step 7: Start Webhook Server

```bash
pm2 start webhook-server.js --name webhook-server
pm2 save
pm2 startup
```

Verify it's running:

```bash
pm2 status
curl http://localhost:3001/health
```

### Step 8: Open Port (if needed)

Check if port 3001 is accessible. You may need to configure your firewall or use a reverse proxy with Nginx/Apache.

**Option A: Using Nginx Reverse Proxy** (Recommended)

Create Nginx config `/etc/nginx/sites-available/webhook`:

```nginx
server {
    listen 80;
    server_name webhook.rshossain.me;  # Or use your domain

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and restart:

```bash
sudo ln -s /etc/nginx/sites-available/webhook /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

**Option B: Direct Port Access**

If you have firewall control:

```bash
sudo ufw allow 3001
```

## 🔗 GitHub Configuration

### Step 1: Add Webhook to GitHub Repository

1. Go to your repository: https://github.com/rhossain/digital-newspaper
2. Click **Settings** → **Webhooks** → **Add webhook**

### Step 2: Configure Webhook

- **Payload URL**: 
  - If using Nginx: `http://webhook.rshossain.me/webhook`
  - If direct: `http://your-server-ip:3001/webhook`
  
- **Content type**: `application/json`

- **Secret**: Paste the secret you generated earlier

- **Which events**: Select **Just the push event**

- **Active**: ✅ Checked

- Click **Add webhook**

### Step 3: Test the Webhook

GitHub will send a test ping. Check:

1. GitHub webhook page should show ✅ green checkmark
2. On server, check logs: `pm2 logs webhook-server`

## 🧪 Testing Deployment

### Test 1: Make a Small Change

```bash
# On your local machine
echo "# Test" >> README.md
git add README.md
git commit -m "Test webhook deployment"
git push origin development
```

### Test 2: Monitor Deployment

On server:

```bash
pm2 logs webhook-server
```

You should see:
- 📡 Webhook received
- 🚀 Deployment started
- ✅ Deployment completed

### Test 3: Verify Website

Visit your website and verify changes are live.

## 📊 Monitoring & Management

### View Logs

```bash
# Webhook server logs
pm2 logs webhook-server

# Last 50 lines
pm2 logs webhook-server --lines 50

# Only errors
pm2 logs webhook-server --err
```

### Restart Server

```bash
pm2 restart webhook-server
```

### Stop Server

```bash
pm2 stop webhook-server
```

### Server Status

```bash
pm2 status
pm2 info webhook-server
```

## 🔒 Security Best Practices

1. **Always use webhook secret** - Prevents unauthorized deployments
2. **Use HTTPS** - Configure SSL certificate for webhook endpoint
3. **Limit IP access** - Restrict to GitHub webhook IPs if possible
4. **Monitor logs** - Regularly check for suspicious activity
5. **Keep secret private** - Never commit `webhook.config.local.js`

### GitHub Webhook IPs

You can restrict access to GitHub's webhook IPs:

```bash
# Get current GitHub webhook IPs
curl https://api.github.com/meta | jq .hooks
```

## 🐛 Troubleshooting

### Webhook Not Triggering

1. Check GitHub webhook delivery status (Settings → Webhooks → Recent Deliveries)
2. Verify server is running: `pm2 status`
3. Check logs: `pm2 logs webhook-server`
4. Test health endpoint: `curl http://localhost:3001/health`

### "Invalid Signature" Error

- Verify secret matches in both `webhook.config.local.js` and GitHub webhook settings
- Regenerate secret and update both places

### Deployment Fails

1. Check deploy script logs: `pm2 logs webhook-server`
2. Test script manually: `bash auto-deploy.sh`
3. Verify Git SSH keys are set up on server
4. Check file permissions: `ls -la auto-deploy.sh`

### Port Not Accessible

- Check firewall: `sudo ufw status`
- Verify port binding: `netstat -tulpn | grep 3001`
- Check Nginx/Apache configuration
- Contact Hostinger support for port access

### Build Fails on Server

- Check Node.js version: `node --version` (should be 20.x)
- Verify dependencies: `npm install`
- Check disk space: `df -h`
- Review build logs in deployment output

## 🔄 Workflow Comparison

### Before (Manual)

```bash
git add .
git commit -m "Update"
git push origin development
npm run deploy  # Manual step required
```

### After (Automatic)

```bash
git add .
git commit -m "Update"
git push origin development
# ✨ Automatically deploys!
```

## 🎛️ Configuration Options

### Change Deployment Branch

Edit `webhook-server.js` and `webhook.config.local.js`:

```javascript
branch: 'main'  // Instead of 'development'
```

### Change Port

Edit `webhook.config.local.js`:

```javascript
port: 8080  // Your preferred port
```

Update PM2:

```bash
pm2 delete webhook-server
pm2 start webhook-server.js --name webhook-server
pm2 save
```

### Add Slack/Discord Notifications

Edit `auto-deploy.sh` and add at the end:

```bash
# Slack notification
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Deployment successful!"}' \
  YOUR_SLACK_WEBHOOK_URL

# Discord notification
curl -X POST -H 'Content-type: application/json' \
  --data '{"content":"Deployment successful!"}' \
  YOUR_DISCORD_WEBHOOK_URL
```

## 📦 Additional Setup

### Deploy Backend Server Too

Add to `auto-deploy.sh` after the build step:

```bash
# Restart Express backend
log "Restarting backend server..."
pm2 restart newspaper-backend || pm2 start server.js --name newspaper-backend
success "Backend restarted"
```

### Database Migrations

Add to `auto-deploy.sh` if you have database migrations:

```bash
# Run database migrations
log "Running database migrations..."
npm run migrate || warning "Migration failed"
```

### Run Tests Before Deploy

Add to `auto-deploy.sh` before build:

```bash
# Run tests
log "Running tests..."
npm test || { error "Tests failed - aborting deployment"; exit 1; }
success "All tests passed"
```

## 🆘 Need Help?

### Quick Diagnostics

Run this diagnostic script on your server:

```bash
#!/bin/bash
echo "=== Webhook Server Diagnostics ==="
echo "Server status:"
pm2 status webhook-server
echo -e "\nHealth check:"
curl -s http://localhost:3001/health | jq .
echo -e "\nPort listening:"
netstat -tulpn | grep 3001
echo -e "\nRecent logs:"
pm2 logs webhook-server --lines 20 --nostream
```

### Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Port 3001 in use | Change port in config or kill existing process |
| Permission denied | Run `chmod +x auto-deploy.sh` |
| Git authentication | Set up SSH keys: `ssh-keygen` then add to GitHub |
| Build out of memory | Increase Node memory: `NODE_OPTIONS=--max-old-space-size=4096 npm run build` |
| PM2 not found | Install globally: `npm install -g pm2` |

## 🎉 You're All Set!

Now every push to `development` branch will automatically:
- ✅ Pull latest code
- ✅ Install dependencies (if needed)
- ✅ Build production app
- ✅ Update release branch
- ✅ Deploy to your website

Just code, commit, and push - everything else is automatic!
