# Troubleshooting Guide

## .env File Corruption Issue

### Problem
The `GITHUB_WEBHOOK_SECRET` in `.env` keeps changing from the correct hash value to a Hostinger URL:
```
# WRONG (keeps appearing):
GITHUB_WEBHOOK_SECRET=https://webhooks.hostinger.com/deploy/7ceb978299e6db3b1437227533ed7e21

# CORRECT (should be):
GITHUB_WEBHOOK_SECRET=c307cd680eca6807532c5984b4b76d7462ea3900101ca189c53f7c3a5adf513e
```

### Why This Happens
**These are two completely different webhook systems:**

1. **Hostinger Auto-Deploy** (https://webhooks.hostinger.com/...)
   - Hostinger's built-in deployment feature
   - Configured in Hostinger control panel
   - NOT used in this project

2. **GitHub Webhook + Custom webhook-server.js** (our implementation)
   - Our custom webhook server running on port 3001
   - Requires HMAC-SHA256 signature verification
   - Needs a secret **hash** (not a URL)

### Possible Causes of Auto-Modification

1. **VS Code Extensions**
   - Check for extensions that manage .env files
   - Extensions like "DotENV" or "Env File Manager" might have auto-complete features
   - Disable extensions one by one to identify the culprit

2. **VS Code Auto-Complete**
   - When typing in .env, VS Code might suggest values from history
   - Accidentally accepting suggestions overwrites the correct value

3. **Copy-Paste Errors**
   - Copying the wrong value from browser/documentation
   - Multiple browser tabs with different webhook URLs

4. **Git Restore**
   - If .env was ever committed to git with wrong value
   - Branch switching might restore old versions
   - **Solution**: Ensure `.env` is in `.gitignore` (already done)

5. **Backup/Restore Scripts**
   - Deploy script backs up and restores .env
   - If backup contains wrong value, it gets restored

### Solutions

#### Solution 1: Validation in deploy.js (IMPLEMENTED)
The deploy script now validates the webhook secret format:
```javascript
if (WEBHOOK_SECRET && WEBHOOK_SECRET.includes('://')) {
  fail('GITHUB_WEBHOOK_SECRET should be a hash (hex string), not a URL!');
}
```

This prevents deployment with the wrong value.

#### Solution 2: Use Environment Variables Instead
Instead of using `.env` file, export variables in your shell profile:

**Add to `~/.zshrc` or `~/.bash_profile`:**
```bash
export HOSTINGER_HOST=217.21.91.251
export HOSTINGER_PORT=21
export HOSTINGER_USER=u594404148
export HOSTINGER_PASS=saRobin@007
export HOSTINGER_REMOTE_PATH=/public_html/diginews
export GITHUB_WEBHOOK_SECRET=c307cd680eca6807532c5984b4b76d7462ea3900101ca189c53f7c3a5adf513e
export WEBHOOK_PORT=3001
```

Then reload: `source ~/.zshrc`

**Pros:**
- Can't be accidentally modified
- Not in project directory
- Persists across sessions

**Cons:**
- Less portable
- Harder to change
- Not isolated per project

#### Solution 3: Make .env Read-Only
```bash
chmod 444 .env
```

**Note**: This might cause issues if deploy script needs to modify it.

#### Solution 4: File Monitoring
Monitor .env for changes:
```bash
# Watch .env file
fswatch -0 .env | xargs -0 -n1 sh -c 'echo "File changed at $(date)" && cat .env | grep GITHUB_WEBHOOK_SECRET'
```

This will alert you when the file changes so you can identify what's modifying it.

#### Solution 5: Lock File with chattr (Linux only)
```bash
# Make file immutable (requires sudo)
sudo chattr +i .env

# To unlock later:
sudo chattr -i .env
```

**Not available on macOS** - macOS uses different file flags.

### Quick Fix Commands

**Recreate .env with correct values:**
```bash
cat > .env << 'EOF'
# Environment variables for deployment
HOSTINGER_HOST=217.21.91.251
HOSTINGER_PORT=21
HOSTINGER_USER=u594404148
HOSTINGER_PASS=saRobin@007
HOSTINGER_REMOTE_PATH=/public_html/diginews
HOSTINGER_USE_SFTP=false
DEPLOY_STRATEGY=incremental
DEPLOY_DRY_RUN=false
GITHUB_WEBHOOK_SECRET=c307cd680eca6807532c5984b4b76d7462ea3900101ca189c53f7c3a5adf513e
WEBHOOK_PORT=3001
EOF
```

**Verify correct value:**
```bash
cat .env | grep GITHUB_WEBHOOK_SECRET
```

**Expected output:**
```
GITHUB_WEBHOOK_SECRET=c307cd680eca6807532c5984b4b76d7462ea3900101ca189c53f7c3a5adf513e
```

### Prevention Checklist

- [ ] Ensure `.env` is in `.gitignore`
- [ ] Run `git ls-files .env` to confirm it's not tracked (should return empty)
- [ ] Review VS Code extensions related to environment files
- [ ] Clear VS Code auto-complete history: `Cmd+Shift+P` > "Clear Editor History"
- [ ] Use `.env.template` as reference, not `.env` directly
- [ ] Consider using environment variables in shell profile instead
- [ ] Run deployment with validation: `npm run deploy` (will fail if wrong secret)

### Monitoring for Root Cause

**Monitor file changes in real-time:**
```bash
# Terminal 1: Watch .env
while true; do
  if grep -q "webhooks.hostinger.com" .env 2>/dev/null; then
    echo "⚠️ WRONG VALUE DETECTED at $(date)"
    ps aux | grep -i code  # Show VS Code processes
    lsof .env 2>/dev/null  # Show what has .env open
  fi
  sleep 2
done
```

**Check file access logs (macOS):**
```bash
# Show processes that accessed .env recently
sudo fs_usage | grep ".env"
```

**Check VS Code extensions:**
```bash
code --list-extensions | grep -i env
```

### Additional Notes

- The deploy script now has validation built-in
- If wrong value is detected, deployment will fail with clear error message
- The .env.template file contains detailed instructions
- Hostinger webhook URL is for their auto-deploy feature, NOT for our GitHub webhooks
- Our webhook-server.js needs the hash for HMAC-SHA256 signature verification

## Common Deployment Errors

### Error: "Cannot find module 'dotenv'"
**Solution:**
```bash
npm install dotenv ftp-deploy ssh2-sftp-client --save-dev
```

### Error: "ENOBUFS: No buffer space available"
**Status**: Fixed in deploy.js (using `stdio:'ignore'`)

### Error: "dist directory not found after branch switch"
**Status**: Fixed in deploy.js (copies dist to system temp before branch operations)

### Error: "node_modules deleted during deployment"
**Status**: Fixed in deploy.js (protected from cleanup)

### Error: CSS budget exceeded
**Status**: Fixed in angular.json (increased to 20kb/50kb)

### Webhook Signature Verification Fails
**Cause**: Wrong GITHUB_WEBHOOK_SECRET (URL instead of hash)
**Solution**: Use the hash value, not the Hostinger URL

## Testing Deployment

### Dry Run
Test without uploading:
```bash
DEPLOY_DRY_RUN=true npm run deploy
```

### Incremental Deploy
Only upload changed files:
```bash
DEPLOY_STRATEGY=incremental npm run deploy
```

### Full Deploy
Clean deploy (deletes remote files first):
```bash
DEPLOY_STRATEGY=full npm run deploy
```

## Webhook Testing

### Test Webhook Server Locally
```bash
# Start webhook server
pm2 start webhook-server.js --name webhook-server

# Check status
pm2 status

# View logs
pm2 logs webhook-server

# Test health endpoint
curl http://localhost:3001/health
```

### Simulate GitHub Webhook
```bash
# Generate signature
SECRET="c307cd680eca6807532c5984b4b76d7462ea3900101ca189c53f7c3a5adf513e"
PAYLOAD='{"ref":"refs/heads/development","repository":{"name":"digital-newspaper"}}'
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

# Send test webhook
curl -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$SIGNATURE" \
  -H "X-GitHub-Event: push" \
  -d "$PAYLOAD"
```

## Emergency Rollback

If deployment fails, rollback to previous release:

```bash
# Switch to release branch
git checkout release

# View deployment history
git log --oneline

# Rollback to previous commit
git reset --hard HEAD~1
git push origin release --force

# Return to development
git checkout development
```

## Contact & Support

For persistent issues:
1. Check PM2 logs: `pm2 logs webhook-server`
2. Check deploy script output: `npm run deploy`
3. Verify .env values: `cat .env | grep GITHUB_WEBHOOK_SECRET`
4. Test webhook signature verification manually
