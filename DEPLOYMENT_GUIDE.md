# 🚀 Deployment Guide - Digital Newspaper

This project supports multiple deployment methods with advanced features inspired by enterprise deployment practices.

## 📦 Deployment Methods

### 1. **npm run deploy** (Recommended for Manual Deployment)

One-command deployment from your local machine.

```bash
npm run deploy
```

**Features:**
- ✅ Builds production bundle
- ✅ Updates release branch
- ✅ Deploys via FTP/SFTP
- ✅ Branch-based strategy (incremental/full)
- ✅ Dry-run support
- ✅ Environment variable configuration

### 2. **Webhook Auto-Deployment** (Recommended for Server)

Automatic deployment triggered by GitHub push events.

```bash
# On your server
pm2 start webhook-server.js --name webhook-server
```

**Features:**
- ✅ Listens for GitHub webhooks
- ✅ Automatically pulls, builds, and deploys
- ✅ Secure signature verification
- ✅ PM2 process management
- ✅ Health check endpoint

### 3. **Manual Script** (Advanced)

Direct script execution for custom workflows.

```bash
bash auto-deploy.sh
```

## 🔧 Setup Instructions

### Step 1: Configure Environment Variables

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# FTP/SFTP Configuration
HOSTINGER_HOST=ftp.yourdomain.com
HOSTINGER_PORT=21
HOSTINGER_USER=your_username
HOSTINGER_PASS=your_password
HOSTINGER_REMOTE_PATH=/public_html/diginews

# Optional: Use SFTP instead of FTP (more secure)
HOSTINGER_USE_SFTP=true
HOSTINGER_PORT=22

# Deployment Strategy
DEPLOY_STRATEGY=incremental  # or 'full'

# GitHub Webhook (if using webhook deployment)
GITHUB_WEBHOOK_SECRET=your-webhook-secret
WEBHOOK_PORT=3001
```

### Step 2: Choose Your Deployment Method

#### Option A: Local Manual Deployment

```bash
# Deploy from your local machine
npm run deploy
```

#### Option B: Webhook Auto-Deployment

See [WEBHOOK_SETUP.md](WEBHOOK_SETUP.md) for complete instructions.

Quick setup:
1. Configure `.env` on your server
2. Start webhook server: `pm2 start webhook-server.js`
3. Add webhook to GitHub repository settings
4. Push to `development` branch → automatic deployment!

## 📋 Deployment Strategies

### Incremental Deploy (Default for development branch)

- Only uploads changed files
- Preserves existing `.htaccess`
- Faster deployment
- Recommended for frequent updates

```bash
DEPLOY_STRATEGY=incremental npm run deploy
```

### Full Clean Deploy (Default for release branch)

- Deletes all remote files (except `.htaccess`)
- Uploads all files fresh
- Ensures clean state
- Recommended for major releases

```bash
DEPLOY_STRATEGY=full npm run deploy
```

## 🔍 Advanced Features

### Dry Run Mode

Test deployment without actually uploading files:

```bash
DEPLOY_DRY_RUN=true npm run deploy
```

Output shows what would be uploaded without making changes.

### Branch-Based Deployment

The deployment strategy automatically adapts based on your current branch:

- **development branch** → incremental deployment
- **release branch** → full clean deployment
- Override with `DEPLOY_STRATEGY` env variable

### SFTP vs FTP

**FTP (Default):**
- Standard protocol
- Port 21
- Widely supported

**SFTP (Recommended):**
- Encrypted connection
- Port 22
- More secure

Enable SFTP:
```bash
HOSTINGER_USE_SFTP=true
HOSTINGER_PORT=22
```

## 📊 Deployment Info

After each deployment, a `deploy-info.json` or `deployment-info.json` file is created:

```json
{
  "deployedAt": "2026-02-09T10:30:00Z",
  "sourceBranch": "development",
  "strategy": "incremental",
  "files": 42,
  "node": "v20.19.3"
}
```

This helps track deployment history and debug issues.

## 🔄 Release Branch Workflow

Both deployment methods automatically manage the `release` branch:

```
development (source code)
    │
    ├─ Build production bundle
    ├─ Create .htaccess
    ├─ Switch to release branch
    ├─ Copy only dist files
    ├─ Commit & push
    └─ Return to development
```

The `release` branch contains **only** production build files:
- `index.html`
- JavaScript bundles
- Assets
- `.htaccess`
- `deployment-info.json`

No source code is included in the release branch.

## 🛠️ Troubleshooting

### "Missing required env variables"

Create `.env` file with required credentials:
```bash
cp .env.example .env
# Edit .env with your values
```

### "Build failed"

Check Angular build:
```bash
npm run build -- --configuration=production
```

### "Connection refused" / FTP errors

Verify credentials:
- Check FTP host, username, password in `.env`
- Test FTP connection with FileZilla or similar tool
- Ensure correct port (21 for FTP, 22 for SFTP)

### "Permission denied" on scripts

Make scripts executable:
```bash
chmod +x deploy.js auto-deploy.sh
```

### Webhook not triggering

1. Check webhook server is running: `pm2 status`
2. Test health endpoint: `curl http://localhost:3001/health`
3. Verify GitHub webhook secret matches
4. Check webhook delivery in GitHub settings

## 📚 Related Documentation

- [WEBHOOK_SETUP.md](WEBHOOK_SETUP.md) - Complete webhook deployment guide
- [DEPLOY_QUICK.md](DEPLOY_QUICK.md) - Quick start guide
- [DEPLOYMENT.md](DEPLOYMENT.md) - GitHub Actions CI/CD setup

## 🎯 Recommended Workflow

### For Development Team

```bash
# Daily workflow
git checkout development
# ... make changes ...
git add .
git commit -m "Feature: xyz"
git push origin development

# Webhook automatically deploys! ✨
```

### For Production Releases

```bash
# Manual deployment from local machine
git checkout development
git pull origin development
npm run deploy

# Or let webhook handle it after push
```

## 🔐 Security Notes

⚠️ **Never commit these files:**
- `.env`
- `.env.local`
- `deploy.config.local.js`
- `webhook.config.local.js`

They are in `.gitignore` to protect your credentials.

✅ **Safe to commit:**
- `.env.example` (template only)
- `deploy.config.js` (template only)
- `webhook.config.js` (template only)

## 💡 Tips

1. **Use SFTP** for better security
2. **Enable dry-run** before first deployment
3. **Monitor webhook logs** with `pm2 logs webhook-server`
4. **Test locally** before webhook deployment
5. **Keep .env updated** with latest credentials

## 🎉 Quick Commands Reference

```bash
# Manual deployment
npm run deploy

# Dry run (test without deploying)
DEPLOY_DRY_RUN=true npm run deploy

# Force full deployment
DEPLOY_STRATEGY=full npm run deploy

# Start webhook server
pm2 start webhook-server.js --name webhook-server

# View webhook logs
pm2 logs webhook-server

# Test webhook health
curl http://localhost:3001/health

# Manual script execution
bash auto-deploy.sh
```

---

Need help? Check the troubleshooting section or review the detailed guides in the documentation folder.
