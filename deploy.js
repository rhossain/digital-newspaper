#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const FtpDeploy = require('ftp-deploy');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  yellow: '\x1b[33m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function exec(command, description) {
  log(`\n${description}...`, colors.blue);
  try {
    const output = execSync(command, { encoding: 'utf-8', stdio: 'pipe' });
    log(`✓ ${description} complete`, colors.green);
    return output;
  } catch (error) {
    log(`✗ ${description} failed: ${error.message}`, colors.red);
    throw error;
  }
}

async function deploy() {
  const startTime = Date.now();
  
  log('\n╔════════════════════════════════════════════╗', colors.bright);
  log('║   Digital Newspaper Deployment Script     ║', colors.bright);
  log('╚════════════════════════════════════════════╝\n', colors.bright);

  try {
    // Step 1: Get current branch
    const currentBranch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
    log(`Current branch: ${currentBranch}`, colors.yellow);

    // Step 2: Build Angular app
    exec('npm run build', 'Building Angular app (production mode)');

    // Step 3: Create .htaccess in dist
    log('\nCreating .htaccess file...', colors.blue);
    const htaccessContent = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>`;
    fs.writeFileSync(path.join(__dirname, 'dist/digital-newspaper/browser/.htaccess'), htaccessContent);
    log('✓ .htaccess created', colors.green);

    // Step 4: Git operations for release branch
    log('\nPreparing release branch...', colors.blue);
    
    // Check if release branch exists
    const branches = execSync('git branch -a', { encoding: 'utf-8' });
    const releaseExists = branches.includes('release');
    
    if (releaseExists) {
      exec('git checkout release', 'Switching to release branch');
      exec('git pull origin release', 'Pulling latest release');
    } else {
      exec('git checkout -b release', 'Creating release branch');
    }

    // Clean release branch (keep only .git and dist)
    log('\nCleaning release branch...', colors.blue);
    exec('git rm -rf . 2>/dev/null || true', 'Removing old files');
    
    // Copy dist files
    exec('cp -R dist/digital-newspaper/browser/* .', 'Copying build files');
    
    // Add and commit
    exec('git add -A', 'Staging files');
    const timestamp = new Date().toISOString();
    exec(`git commit -m "Deploy: ${timestamp}" || echo "No changes"`, 'Committing changes');
    exec('git push origin release', 'Pushing to release branch');

    // Step 5: Switch back to original branch
    exec(`git checkout ${currentBranch}`, `Switching back to ${currentBranch}`);

    // Step 6: FTP Deployment
    log('\n╔════════════════════════════════════════════╗', colors.bright);
    log('║          Starting FTP Deployment           ║', colors.bright);
    log('╚════════════════════════════════════════════╝\n', colors.bright);

    // Load FTP config
    let ftpConfig;
    const localConfigPath = path.join(__dirname, 'deploy.config.local.js');
    const defaultConfigPath = path.join(__dirname, 'deploy.config.js');
    
    if (fs.existsSync(localConfigPath)) {
      ftpConfig = require(localConfigPath);
      log('Using deploy.config.local.js', colors.yellow);
    } else {
      ftpConfig = require(defaultConfigPath);
      log('Using deploy.config.js (update with your credentials)', colors.yellow);
    }

    const ftpDeploy = new FtpDeploy();

    ftpDeploy.on('uploading', (data) => {
      const percentage = Math.round((data.transferredFileCount / data.totalFilesCount) * 100);
      process.stdout.write(`\rUploading: ${data.transferredFileCount}/${data.totalFilesCount} files (${percentage}%)`);
    });

    ftpDeploy.on('uploaded', (data) => {
      log(`\n✓ Uploaded: ${data.filename}`, colors.green);
    });

    await ftpDeploy.deploy(ftpConfig);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    log('\n╔════════════════════════════════════════════╗', colors.bright + colors.green);
    log('║        🎉 DEPLOYMENT SUCCESSFUL! 🎉        ║', colors.bright + colors.green);
    log('╚════════════════════════════════════════════╝', colors.bright + colors.green);
    log(`\n✓ Build completed`, colors.green);
    log(`✓ Release branch updated`, colors.green);
    log(`✓ Files deployed via FTP`, colors.green);
    log(`✓ Total time: ${duration}s\n`, colors.green);
    
  } catch (error) {
    log('\n╔════════════════════════════════════════════╗', colors.red);
    log('║          ✗ DEPLOYMENT FAILED ✗             ║', colors.red);
    log('╚════════════════════════════════════════════╝\n', colors.red);
    log(`Error: ${error.message}`, colors.red);
    process.exit(1);
  }
}

// Run deployment
deploy();
