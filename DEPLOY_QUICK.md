# One-Command Deployment

## Quick Start

1. **Update FTP credentials** in `deploy.config.local.js`:
   ```javascript
   module.exports = {
     host: 'ftp.yourdomain.com',
     user: 'your-username',
     password: 'your-password',
     remoteRoot: '/public_html/diginews/'
   };
   ```

2. **Run deployment**:
   ```bash
   npm run deploy
   ```

That's it! The script will:
- ✅ Build your Angular app (production mode)
- ✅ Create `.htaccess` for routing
- ✅ Switch to `release` branch
- ✅ Copy only build files
- ✅ Commit and push to GitHub
- ✅ Deploy via FTP to Hostinger
- ✅ Switch back to your working branch

## What Happens

```
npm run deploy
    │
    ├─► Build Angular app (ng build)
    ├─► Create .htaccess
    ├─► Switch to release branch
    ├─► Clean and copy dist files
    ├─► Commit: "Deploy: 2026-02-08T..."
    ├─► Push to GitHub
    ├─► Upload to Hostinger via FTP
    └─► Return to development branch
```

## Configuration Files

- **`deploy.config.js`**: Template (committed to git)
- **`deploy.config.local.js`**: Your credentials (ignored by git) ⭐

## Getting FTP Credentials

### Hostinger Panel:
1. Login to hPanel
2. Go to **Files → FTP Accounts**
3. Note: Hostname, Username, Password
4. Check your subdomain path (likely `/public_html/diginews/`)

## Environment Variables (Optional)

Instead of `deploy.config.local.js`, you can use environment variables:

```bash
export FTP_HOST=ftp.yourdomain.com
export FTP_USER=your-username
export FTP_PASSWORD=your-password
npm run deploy
```

Or create `.env` file:
```bash
FTP_HOST=ftp.yourdomain.com
FTP_USER=your-username
FTP_PASSWORD=your-password
```

## Troubleshooting

### "Login incorrect"
- Double-check FTP credentials
- Ensure FTP account is active in Hostinger

### "Directory not found"
- Update `remoteRoot` in config file
- Check subdomain path in Hostinger

### "Connection timeout"
- Try `forcePasv: false` in config
- Check firewall settings

### Files not updating
- Clear browser cache
- Check FTP upload completed successfully
- Verify file permissions on server

## First-Time Setup Checklist

- [ ] Copy `deploy.config.js` → `deploy.config.local.js`
- [ ] Update FTP credentials in `deploy.config.local.js`
- [ ] Verify subdomain exists: `diginews.rshossain.me`
- [ ] Check remote path matches Hostinger structure
- [ ] Run: `npm run deploy`
- [ ] Visit: https://diginews.rshossain.me

## Security Notes

⚠️ **Never commit `deploy.config.local.js`** - it's in `.gitignore` for security
✅ Safe to commit: `deploy.config.js` (template only)
✅ GitHub Actions workflow still available if you prefer CI/CD

## Backend Deployment

Note: The Express backend (`server.js`) needs to be deployed separately. The npm script only deploys the frontend Angular app. For the backend:

1. SSH to your server
2. Clone the repository
3. Run `npm install` and `node server.js`
4. Or use a process manager like PM2

## Need Help?

Check the full documentation in `DEPLOYMENT.md` for detailed GitHub Actions setup and advanced configurations.
