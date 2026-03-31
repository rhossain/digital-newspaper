#!/usr/bin/env node
/**
 * Automated deployment script for digital-newspaper Angular app.
 * Usage: npm run deploy
 *
 * Branch behavior:
 *  - release: full clean deploy to HOSTINGER_REMOTE_PATH
 *  - development: incremental deploy (only dist files) preserving existing .htaccess
 *
 * Environment variables (define in .env or shell):
 *  HOSTINGER_HOST=ftp.yourdomain.com (or your FTP host)
 *  HOSTINGER_PORT=21 (FTP) or 22 (SFTP) optional
 *  HOSTINGER_USER=your_ftp_username
 *  HOSTINGER_PASS=your_ftp_password
 *  HOSTINGER_REMOTE_PATH=/public_html/diginews
 *  HOSTINGER_USE_SFTP=true (optional, use SFTP instead of FTP)
 *  DEPLOY_STRATEGY=incremental|full (override branch default)
 *
 * Optional:
 *  DEPLOY_DRY_RUN=true  -> list files only
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  yellow: '\x1b[33m'
};

function log(msg, color = colors.reset) {
  console.log(`${color}[deploy]${colors.reset} ${msg}`);
}

function fail(msg) {
  console.error(`\n${colors.red}[deploy:ERROR]${colors.reset} ${msg}`);
  process.exit(1);
}

// Validate env
const HOST = process.env.HOSTINGER_HOST;
const PORT = process.env.HOSTINGER_PORT ? parseInt(process.env.HOSTINGER_PORT, 10) : 21;
const USER = process.env.HOSTINGER_USER;
const PASS = process.env.HOSTINGER_PASS;
const REMOTE = process.env.HOSTINGER_REMOTE_PATH || '/public_html/diginews';
const USE_SFTP = process.env.HOSTINGER_USE_SFTP === 'true';

if (!HOST || !USER || !PASS) {
  fail('Missing required env HOSTINGER_HOST / HOSTINGER_USER / HOSTINGER_PASS\nCreate a .env file with these variables.');
}

// Determine branch
let branch = 'unknown';
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
} catch (e) {
  log('Warning: could not determine git branch; defaulting to unknown', colors.yellow);
}
log(`Current branch: ${branch}`, colors.blue);

// Build (always production for deployment)
log('Running production build...', colors.blue);
try {
  execSync('npm run build -- --configuration=production', { stdio: 'inherit' });
  log('✓ Build completed', colors.green);
} catch (error) {
  fail('Build failed');
}

// Dist path inference
const distDir = path.resolve(process.cwd(), 'dist/digital-newspaper');
if (!fs.existsSync(distDir)) {
  fail(`Dist directory not found: ${distDir}`);
}

// Create .htaccess
const htaccessPath = path.join(distDir, '.htaccess');
if (!fs.existsSync(htaccessPath)) {
  log('Creating .htaccess for Angular routing...', colors.blue);
  const htaccessContent = `<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>`;
  fs.writeFileSync(htaccessPath, htaccessContent);
  log('✓ .htaccess created', colors.green);
}

// Decide strategy
const isRelease = branch === 'release';
let strategy = process.env.DEPLOY_STRATEGY || (isRelease ? 'full' : 'incremental');
log(`Deployment strategy: ${strategy}`, colors.yellow);
const dryRun = process.env.DEPLOY_DRY_RUN === 'true';
if (dryRun) log('DRY RUN MODE - No files will be uploaded', colors.yellow);

// Collect local files
function walk(dir, base = dir) {
  return fs.readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return walk(full, base);
    return [{ full, rel }];
  });
}
const files = walk(distDir);
log(`Found ${files.length} build files.`, colors.blue);

async function deployWithSFTP() {
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  
  log(`Connecting to ${HOST} via SFTP...`, colors.blue);
  await sftp.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  log(`✓ Connected to ${HOST}`, colors.green);

  // Ensure remote path exists
  try { await sftp.mkdir(REMOTE, true); } catch(_) {}

  if (strategy === 'full') {
    log('Performing full clean (except .htaccess) ...', colors.yellow);
    const list = await sftp.list(REMOTE);
    for (const item of list) {
      if (item.name === '.htaccess') continue;
      const remoteItemPath = `${REMOTE}/${item.name}`;
      try {
        if (item.type === 'd') {
          await sftp.rmdir(remoteItemPath, true);
        } else {
          await sftp.delete(remoteItemPath);
        }
      } catch (e) {
        log(`Skip delete error ${remoteItemPath}: ${e.message}`, colors.yellow);
      }
    }
  }

  let uploaded = 0;
  for (const f of files) {
    const remoteFile = `${REMOTE}/${f.rel}`;
    const remoteDir = path.dirname(remoteFile).replace(/\\/g, '/');
    try { await sftp.mkdir(remoteDir, true); } catch(_) {}
    
    if (dryRun) {
      log(`[dry-run] Would upload ${f.rel}`);
      continue;
    }
    
    await sftp.fastPut(f.full, remoteFile);
    uploaded++;
    if (uploaded % 50 === 0) log(`Uploaded ${uploaded}/${files.length}`, colors.blue);
  }

  // Create a deployment marker
  if (!dryRun) {
    const markerContent = JSON.stringify({
      branch,
      date: new Date().toISOString(),
      strategy,
      files: files.length,
      host: HOST
    }, null, 2);
    await sftp.put(Buffer.from(markerContent), `${REMOTE}/deploy-info.json`);
  }

  await sftp.end();
  log(`✓ Deployment complete. Uploaded ${uploaded} files.`, colors.green);
}

async function deployWithFTP() {
  const FtpDeploy = require('ftp-deploy');
  const ftpDeploy = new FtpDeploy();

  const config = {
    host: HOST,
    port: PORT,
    user: USER,
    password: PASS,
    localRoot: distDir,
    remoteRoot: REMOTE,
    include: ['*', '**/*'],
    exclude: ['**/*.map', 'node_modules/**', '.git/**'],
    deleteRemote: strategy === 'full',
    forcePasv: true
  };

  log(`Connecting to ${HOST} via FTP...`, colors.blue);

  ftpDeploy.on('uploading', (data) => {
    const percentage = Math.round((data.transferredFileCount / data.totalFilesCount) * 100);
    process.stdout.write(`\r${colors.blue}Uploading: ${data.transferredFileCount}/${data.totalFilesCount} files (${percentage}%)${colors.reset}`);
  });

  ftpDeploy.on('uploaded', (data) => {
    console.log(); // New line
    log(`✓ Uploaded: ${data.filename}`, colors.green);
  });

  if (dryRun) {
    log('DRY RUN - Would deploy with FTP config:', colors.yellow);
    console.log(JSON.stringify({ ...config, password: '***' }, null, 2));
    return;
  }

  await ftpDeploy.deploy(config);
  log('✓ FTP deployment complete', colors.green);
}

async function updateReleaseBranch() {
  log('\nUpdating release branch...', colors.blue);
  
  const currentBranch = branch;
  
  try {
    // Check if release branch exists
    const branches = execSync('git branch -a', { encoding: 'utf-8' });
    const releaseExists = branches.includes('release');
    
    if (releaseExists) {
      execSync('git checkout release', { stdio: 'inherit' });
    } else {
      execSync('git checkout -b release', { stdio: 'inherit' });
    }

    // Clean release branch
    log('Cleaning release branch...', colors.blue);
    execSync('git rm -rf . 2>/dev/null || true', { stdio: 'pipe' });
    
    // Copy dist files using shell with maxBuffer
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      exec(`cp -R ${distDir}/* . && cp -R ${distDir}/.[^.]* . 2>/dev/null || true`, 
        { maxBuffer: 50 * 1024 * 1024 }, // 50MB buffer
        (error) => {
          if (error && !error.message.includes('No such file')) reject(error);
          else resolve();
        }
      );
    });
    log('✓ Files copied', colors.green);
    
    // Create deployment info
    const deployInfo = {
      deployedAt: new Date().toISOString(),
      sourceBranch: currentBranch,
      strategy,
      buildDir: distDir,
      node: process.version
    };
    fs.writeFileSync('deployment-info.json', JSON.stringify(deployInfo, null, 2));
    
    // Commit and push
    execSync('git add -A', { stdio: 'inherit' });
    
    try {
      const commitMsg = `Deploy: ${new Date().toISOString()} from ${currentBranch}`;
      execSync(`git commit -m "${commitMsg}"`, { stdio: 'inherit' });
      execSync('git push origin release', { stdio: 'inherit' });
      log('✓ Release branch updated', colors.green);
    } catch (e) {
      log('No changes to commit or push failed', colors.yellow);
    }
    
    // Return to original branch
    execSync(`git checkout ${currentBranch}`, { stdio: 'pipe' });
    log(`✓ Returned to ${currentBranch}`, colors.green);
    
  } catch (error) {
    // CRITICAL: Always try to return to original branch even on error
    try {
      execSync(`git checkout ${currentBranch}`, { stdio: 'pipe' });
      log(`Returned to ${currentBranch} after error`, colors.yellow);
    } catch (e) {
      log(`WARNING: Could not switch back to ${currentBranch}. Run: git checkout ${currentBranch}`, colors.red);
    }
    fail(`Failed to update release branch: ${error.message}`);
  }
}

async function deploy() {
  const startTime = Date.now();
  
  console.log(`\n${colors.bright}╔════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}║   Digital Newspaper Deployment Script     ║${colors.reset}`);
  console.log(`${colors.bright}╚════════════════════════════════════════════╝${colors.reset}\n`);

  try {
    // Step 1: Upload files
    if (USE_SFTP) {
      await deployWithSFTP();
    } else {
      await deployWithFTP();
    }

    // Step 2: Update release branch
    if (!dryRun) {
      await updateReleaseBranch();
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`\n${colors.bright}${colors.green}╔════════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.bright}${colors.green}║        🎉 DEPLOYMENT SUCCESSFUL! 🎉        ║${colors.reset}`);
    console.log(`${colors.bright}${colors.green}╚════════════════════════════════════════════╝${colors.reset}`);
    log(`✓ Build completed`, colors.green);
    log(`✓ Release branch updated`, colors.green);
    log(`✓ Files deployed via ${USE_SFTP ? 'SFTP' : 'FTP'}`, colors.green);
    log(`✓ Total time: ${duration}s\n`, colors.green);
    
  } catch (error) {
    console.log(`\n${colors.red}╔════════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.red}║          ✗ DEPLOYMENT FAILED ✗             ║${colors.reset}`);
    console.log(`${colors.red}╚════════════════════════════════════════════╝${colors.reset}\n`);
    fail(error.message);
  }
}

// Run deployment
deploy();
