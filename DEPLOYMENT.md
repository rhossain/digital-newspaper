# Automated Deployment Guide

## Overview
This project uses GitHub Actions to automatically deploy to Hostinger when you push to the `development` branch.

## Workflow
1. Push code to `development` branch
2. GitHub Actions automatically:
   - Builds the Angular app
   - Creates/updates `release` branch with only build files
   - Deploys to Hostinger via FTP
   - Returns to `development` branch

## Setup Instructions

### 1. GitHub Configuration

#### Create development branch
```bash
git checkout -b development
git push -u origin development
```

#### Add GitHub Secrets
Go to your GitHub repository → Settings → Secrets and variables → Actions → New repository secret

Add these secrets:
- **FTP_SERVER**: Your Hostinger FTP hostname (e.g., `ftp.yourdomain.com` or `ftpupload.net`)
- **FTP_USERNAME**: Your FTP username (usually same as cPanel username)
- **FTP_PASSWORD**: Your FTP password

### 2. Hostinger Configuration

#### A. Create Subdomain
1. Login to Hostinger → hPanel
2. Go to **Domains** → **Subdomains**
3. Create subdomain: `diginews.rshossain.me`
4. Note the document root (e.g., `/public_html/diginews`)

#### B. Get FTP Credentials
1. In hPanel, go to **Files** → **FTP Accounts**
2. Either use existing FTP account or create new one
3. Note down:
   - FTP Server/Hostname
   - Username
   - Password
   - Port (usually 21)

#### C. Configure Document Root
The deployment is set to `/public_html/` by default. Update the workflow file if your subdomain has a different path:
```yaml
server-dir: /public_html/diginews/  # Update this path
```

#### D. Enable Node.js (Optional - for backend)
If you need the Express server on Hostinger:
1. Go to **Advanced** → **Node.js**
2. Select Node.js version 20.x
3. Set entry point to `server.js`
4. Add environment variables if needed

### 3. DNS Configuration

#### Point Subdomain to Hostinger
1. Go to your domain registrar (where rshossain.me is registered)
2. Add A record or update subdomain DNS:
   - **Type**: A
   - **Name**: diginews
   - **Value**: Hostinger IP (find in hPanel → Domain → DNS)
   - **TTL**: 3600

Or use Hostinger nameservers:
- ns1.dns-parking.com
- ns2.dns-parking.com

### 4. Test Deployment

#### Push to development branch
```bash
git checkout development
git add .
git commit -m "Test deployment"
git push origin development
```

#### Monitor deployment
- Go to GitHub repository → Actions tab
- Watch the workflow run
- Check logs if any errors occur

#### Verify deployment
Visit: https://diginews.rshossain.me

### 5. Workflow Customization

#### Update server directory
Edit `.github/workflows/deploy.yml`:
```yaml
server-dir: /public_html/your-subdomain-folder/
```

#### Change deployment trigger
To deploy only on tags:
```yaml
on:
  push:
    tags:
      - 'v*'
```

#### Add backend server deployment
If deploying Express server, add:
```yaml
- name: Copy server files
  run: |
    cp server.js release/
    cp package.json release/
    cp -r node_modules release/
```

### 6. Troubleshooting

#### FTP Connection Failed
- Verify FTP credentials in GitHub Secrets
- Check if FTP port 21 is open (Hostinger usually allows)
- Try passive mode FTP

#### Build Failed
- Check Node.js version compatibility
- Verify all dependencies are in package.json
- Check build logs in GitHub Actions

#### Site Shows 404 on Refresh
- Ensure .htaccess file is created and uploaded
- Enable mod_rewrite in Hostinger (usually enabled by default)

#### Backend API Not Working
- Deploy backend separately or use serverless functions
- Update API URLs in Angular environment files
- Set up CORS properly

### 7. Local Development

```bash
# Work on development branch
git checkout development

# Make changes
git add .
git commit -m "Your changes"

# Push to trigger deployment
git push origin development
```

### 8. Rollback

If you need to rollback:
```bash
# From development branch
git revert HEAD
git push origin development
```

Or manually checkout previous commit in release branch:
```bash
git checkout release
git reset --hard <previous-commit-hash>
git push origin release --force
```

## Architecture

```
[Local Development]
       ↓ git push
[GitHub: development branch]
       ↓ GitHub Actions
[Build Angular App]
       ↓
[GitHub: release branch] (only dist files)
       ↓ FTP Deploy
[Hostinger: diginews.rshossain.me]
```

## Notes

- The `release` branch contains ONLY the built files (no source code)
- Never manually commit to `release` branch - it's auto-generated
- Always work on `development` branch
- Production builds are optimized and minified
- Assets in `src/assets/cropped/` will be included in deployment
