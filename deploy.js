#!/usr/bin/env node
/**
 * Production-ready deployment script for digital-newspaper
 * Uses a clean orphan release branch strategy
 * Preserves .env and other gitignored files during branch switches
 */
const { execSync, exec } = require('child_process');
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

// Get current branch
let branch = 'unknown';
try {
  branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
} catch (e) {
  log('Warning: could not determine git branch; defaulting to unknown', colors.yellow);
}
log(`Current branch: ${branch}`, colors.blue);

// Save .env and other ignored files before any operations
const SAVED_FILES_DIR = path.join(process.cwd(), '.deploy-backup');
function backupIgnoredFiles() {
  log('Backing up .env and config files...', colors.blue);
  if (fs.existsSync(SAVED_FILES_DIR)) {
    fs.rmSync(SAVED_FILES_DIR, { recursive: true });
  }
  fs.mkdirSync(SAVED_FILES_DIR, { recursive: true });
  
  const filesToBackup = ['.env', 'webhook.config.local.js', 'deploy.config.local.js'];
  filesToBackup.forEach(file => {
    const source = path.join(process.cwd(), file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(SAVED_FILES_DIR, file));
      log(`✓ Backed up ${file}`, colors.green);
    }
  });
}

function restoreIgnoredFiles() {
  log('Restoring .env and config files...', colors.blue);
  if (!fs.existsSync(SAVED_FILES_DIR)) return;
  
  const files = fs.readdirSync(SAVED_FILES_DIR);
  files.forEach(file => {
    const source = path.join(SAVED_FILES_DIR, file);
    const dest = path.join(process.cwd(), file);
    fs.copyFileSync(source, dest);
    log(`✓ Restored ${file}`, colors.green);
  });
  
  // Cleanup
  fs.rmSync(SAVED_FILES_DIR, { recursive: true });
}

// Build
log('Running production build...', colors.blue);
try {
  execSync('npm run build -- --configuration=production', { stdio: 'inherit' });
  log('✓ Build completed', colors.green);
} catch (error) {
  fail('Build failed. Fix build errors before deploying.');
}

// Find dist directory
const distDir = path.resolve(process.cwd(), 'dist/digital-newspaper');
if (!fs.existsSync(distDir)) {
  fail(`Dist directory not found: ${distDir}\nBuild may have failed - check the output above.`);
}

// Verify dist has content
const distContents = fs.readdirSync(distDir);
if (distContents.length === 0) {
  fail(`Dist directory is empty: ${distDir}\nBuild produced no output.`);
}
log(`✓ Build directory validated: ${distContents.length} items`, colors.green);

// Create .htaccess
const htaccessPath = path.join(distDir, '.htaccess');
if (!fs.existsSync(htaccessPath)) {
  log('Creating .htaccess...', colors.blue);
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

// Deployment strategy
const isRelease = branch === 'release';
let strategy = process.env.DEPLOY_STRATEGY || (isRelease ? 'full' : 'incremental');
log(`Deployment strategy: ${strategy}`, colors.yellow);
const dryRun = process.env.DEPLOY_DRY_RUN === 'true';

// Collect files
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
  
  log(`Connecting via SFTP to ${HOST}...`, colors.blue);
  await sftp.connect({ host: HOST, port: PORT, username: USER, password: PASS });
  log(`✓ Connected`, colors.green);

  try { await sftp.mkdir(REMOTE, true); } catch(_) {}

  if (strategy === 'full') {
    log('Performing full clean...', colors.yellow);
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
        log(`Skip ${remoteItemPath}: ${e.message}`, colors.yellow);
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

  if (!dryRun) {
    const markerContent = JSON.stringify({
      branch,
      date: new Date().toISOString(),
      strategy,
      files: files.length
    }, null, 2);
    await sftp.put(Buffer.from(markerContent), `${REMOTE}/deploy-info.json`);
  }

  await sftp.end();
  log(`✓ Upload complete: ${uploaded} files`, colors.green);
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
    exclude: ['**/*.map'],
    deleteRemote: strategy === 'full',
    forcePasv: true
  };

  log(`Connecting via FTP to ${HOST}...`, colors.blue);

  ftpDeploy.on('uploading', (data) => {
    const pct = Math.round((data.transferredFileCount / data.totalFilesCount) * 100);
    process.stdout.write(`\r${colors.blue}Uploading: ${data.transferredFileCount}/${data.totalFilesCount} (${pct}%)${colors.reset}`);
  });

  if (dryRun) {
    log('DRY RUN - Would deploy with FTP', colors.yellow);
    return;
  }

  await ftpDeploy.deploy(config);
  console.log(); // newline
  log('✓ FTP deployment complete', colors.green);
}

async function updateReleaseBranch() {
  log('\nUpdating release branch...', colors.blue);
  
  const currentBranch = branch;
  backupIgnoredFiles();
  
  try {
    // Stash current changes
    try {
      execSync('git stash push -m "deploy-temp-stash"', { stdio: 'ignore' });
      log('Stashed local changes', colors.yellow);
    } catch (e) {
      // Nothing to stash
    }
    
    // Check if release exists
    let releaseExists = false;
    try {
      execSync('git rev-parse --verify release', { stdio: 'ignore' });
      releaseExists = true;
    } catch (e) {
      releaseExists = false;
    }
    
    if (releaseExists) {
      execSync('git checkout release', { stdio: 'ignore' });
      log('Switched to release branch', colors.blue);
    } else {
      // Create orphan release branch (no shared history)
      execSync('git checkout --orphan release', { stdio: 'ignore' });
      log('Created orphan release branch', colors.blue);
    }

    // Clean everything (ignore output to avoid buffer issues)
    try {
      execSync('git rm -rf . 2>&1', { stdio: 'ignore' });
    } catch(e) { /* ignore errors */ }
    
    try {
      const entries = fs.readdirSync('.');
      for (const entry of entries) {
        if (entry === '.git') continue;
        const fullPath = path.join(process.cwd(), entry);
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch(e) { /* ignore errors */ }
    
    // Copy dist files using fs (no shell buffer limits)
    log('Copying build files...', colors.blue);
    const distEntries = fs.readdirSync(distDir);
    for (const entry of distEntries) {
      const src = path.join(distDir, entry);
      const dest = path.join(process.cwd(), entry);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
    }
    log('✓ Build files copied', colors.green);
    
    // Create deployment info
    const deployInfo = {
      deployedAt: new Date().toISOString(),
      sourceBranch: currentBranch,
      strategy,
      node: process.version
    };
    fs.writeFileSync('deployment-info.json', JSON.stringify(deployInfo, null, 2));
    
    // Commit
    execSync('git add -A', { stdio: 'ignore' });
    
    try {
      const commitMsg = `Deploy: ${new Date().toISOString()} from ${currentBranch}`;
      execSync(`git commit -m "${commitMsg}"`, { stdio: 'ignore' });
      execSync('git push origin release --force', { stdio: 'ignore' });
      log('✓ Release branch updated and pushed', colors.green);
    } catch (e) {
      log('No changes to commit', colors.yellow);
    }
    
    // Return to original branch
    execSync(`git checkout ${currentBranch}`, { stdio: 'ignore' });
    log(`✓ Returned to ${currentBranch}`, colors.green);
    
    // Restore stash if any
    try {
      const stashList = execSync('git stash list', { encoding: 'utf-8', stdio: 'pipe' });
      if (stashList.includes('deploy-temp-stash')) {
        execSync('git stash pop', { stdio: 'ignore' });
        log('Restored stashed changes', colors.yellow);
      }
    } catch (e) {
      // No stash to restore
    }
    
  } catch (error) {
    // CRITICAL: Always return to original branch
    log(`Error during release update: ${error.message}`, colors.red);
    try {
      execSync(`git checkout ${currentBranch}`, { stdio: 'ignore' });
      log(`Emergency: Returned to ${currentBranch}`, colors.yellow);
      
      // Try to restore stash
      try {
        execSync('git stash pop', { stdio: 'ignore' });
      } catch (e) {}
    } catch (e) {
      log(`CRITICAL: Could not return to ${currentBranch}!`, colors.red);
      log(`Run manually: git checkout ${currentBranch}`, colors.red);
    }
    
    restoreIgnoredFiles();
    fail(error.message);
  }
  
  restoreIgnoredFiles();
}

async function deploy() {
  const startTime = Date.now();
  
  console.log(`\n${colors.bright}╔════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}║   Digital Newspaper Deployment Script     ║${colors.reset}`);
  console.log(`${colors.bright}╚════════════════════════════════════════════╝${colors.reset}\n`);

  try {
    // Upload files
    if (USE_SFTP) {
      await deployWithSFTP();
    } else {
      await deployWithFTP();
    }

    // Update release branch
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

deploy();
