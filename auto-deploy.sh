#!/bin/bash
set -euo pipefail

# Auto-deployment script for digital-newspaper (branch-switch method)
# Triggered by GitHub webhook or run manually

SUBDIRECTORY="diginews"
RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[1;33m"; BLUE="\033[0;34m"; RESET="\033[0m"

echo -e "${BLUE}🚀 Deploying digital-newspaper Angular app (branch-switch method) ...${RESET}"

# Validate we're in project root
if [ ! -f package.json ] || [ ! -f angular.json ]; then
  echo -e "${RED}❌ Must run from project root containing package.json & angular.json${RESET}"
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current || echo "unknown")
echo -e "${BLUE}📋 Current branch:${RESET} ${CURRENT_BRANCH}"

if [ "${CURRENT_BRANCH}" != "development" ]; then
  echo -e "${YELLOW}⚠️  Recommended to deploy from 'development' branch (continuing)${RESET}"
fi

# Fetch latest changes if on server
if [ -n "${WEBHOOK_DEPLOY:-}" ]; then
  echo -e "${BLUE}🔄 Fetching latest changes from GitHub...${RESET}"
  git fetch origin "${CURRENT_BRANCH}"
  
  CURRENT_COMMIT=$(git rev-parse HEAD)
  REMOTE_COMMIT=$(git rev-parse origin/${CURRENT_BRANCH})
  
  if [ "${CURRENT_COMMIT}" == "${REMOTE_COMMIT}" ]; then
    echo -e "${YELLOW}⚠️  Already up to date. No deployment needed.${RESET}"
    exit 0
  fi
  
  echo -e "${BLUE}📥 Pulling changes...${RESET}"
  git pull origin "${CURRENT_BRANCH}"
  
  # Show what changed
  echo -e "${BLUE}📝 Changes in this deployment:${RESET}"
  git log --oneline ${CURRENT_COMMIT}..${REMOTE_COMMIT}
  
  # Update dependencies if package.json changed
  if git diff --name-only ${CURRENT_COMMIT} ${REMOTE_COMMIT} | grep -q "package.json"; then
    echo -e "${BLUE}📦 package.json changed - updating dependencies...${RESET}"
    npm install
  fi
fi

echo -e "${BLUE}🧹 Cleaning previous dist ...${RESET}"
rm -rf dist/

echo -e "${BLUE}🔨 Building production with base href / ...${RESET}"
npm run build -- --configuration=production --base-href="/"

# Find the build directory
INDEX_FILE=$(find dist -name index.html -type f | head -1 || true)
if [ -z "${INDEX_FILE}" ]; then
  echo -e "${RED}❌ Build failed: index.html not found${RESET}"
  exit 1
fi
BUILD_DIR=$(dirname "${INDEX_FILE}")
echo -e "${GREEN}✅ Build dir:${RESET} ${BUILD_DIR}"

# Create temp directory for staging
TEMP_DIR=$(mktemp -d)
echo -e "${BLUE}📦 Temp dir:${RESET} ${TEMP_DIR}"
cp -R "${BUILD_DIR}"/* "${TEMP_DIR}"/
cp -R "${BUILD_DIR}"/.[^.]* "${TEMP_DIR}"/ 2>/dev/null || true

if [ ! -f "${TEMP_DIR}/index.html" ]; then
  echo -e "${RED}❌ Copy to temp failed${RESET}"
  exit 1
fi

# Switch to release branch
echo -e "${BLUE}🔄 Switching to release branch ...${RESET}"
if git rev-parse --verify release >/dev/null 2>&1; then
  git checkout release
else
  git checkout --orphan release
fi

# Clean release branch working tree
echo -e "${BLUE}🧹 Cleaning release branch working tree ...${RESET}"
find . -mindepth 1 -maxdepth 1 ! -name '.git' ! -name '.gitignore' -exec rm -rf {} + 2>/dev/null || true

# Copy build files into release branch
echo -e "${BLUE}📁 Copying build files into release branch ...${RESET}"
cp -R "${TEMP_DIR}"/* .
cp -R "${TEMP_DIR}"/.[^.]* . 2>/dev/null || true
rm -rf "${TEMP_DIR}"

if [ ! -f index.html ]; then
  echo -e "${RED}❌ Missing index.html after copy${RESET}"
  git checkout "${CURRENT_BRANCH}"
  exit 1
fi

# Create .htaccess for Angular SPA routing
echo -e "${BLUE}⚙️  Writing .htaccess for Angular SPA routing ...${RESET}"
cat > .htaccess <<EOF
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\\.html$ - [L]
  # Compatibility redirects: if anyone hits root-level WP paths, forward to /wp.
  RewriteRule ^wp-admin/?$ /wp/wp-admin/ [R=302,L,NC]
  RewriteRule ^wp-login\\.php$ /wp/wp-login.php [R=302,L,NC]
  RewriteRule ^xmlrpc\\.php$ /wp/xmlrpc.php [R=302,L,NC]
  # Never route WordPress/admin/auth URLs through the Angular SPA.
  RewriteRule ^wp(?:/|$) - [L,NC]
  RewriteRule ^wp-admin(?:/|$) - [L,NC]
  RewriteRule ^wp-login\\.php$ - [L,NC]
  RewriteRule ^xmlrpc\\.php$ - [L,NC]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteCond %{REQUEST_URI} !^/(wp|wp-admin)(?:/|$) [NC]
  RewriteCond %{REQUEST_URI} !^/wp-login\\.php$ [NC]
  RewriteCond %{REQUEST_URI} !^/xmlrpc\\.php$ [NC]
  RewriteRule . /index.html [L]
</IfModule>
EOF

# Create deployment info
echo -e "${BLUE}📝 Writing deployment-info.json ...${RESET}"
cat > deployment-info.json <<EOF
{
  "deployedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "sourceBranch": "${CURRENT_BRANCH}",
  "subdomain": "diginews.rshossain.me",
  "baseHref": "/",
  "buildDir": "${BUILD_DIR}",
  "node": "$(node --version 2>/dev/null || echo unknown)",
  "user": "$(whoami)@$(hostname)",
  "method": "${WEBHOOK_DEPLOY:-manual}"
}
EOF

# Stage files
echo -e "${BLUE}💾 Staging files ...${RESET}"
git add .

if git diff --cached --quiet; then
  echo -e "${YELLOW}⚠️  No changes to deploy (release unchanged)${RESET}"
  git checkout "${CURRENT_BRANCH}"
  echo -e "${GREEN}✨ Done${RESET}"
  exit 0
fi

# Commit changes
COMMIT_MSG="Deploy to diginews.rshossain.me $(date '+%Y-%m-%d %H:%M:%S') from ${CURRENT_BRANCH}"
echo -e "${BLUE}💾 Committing: ${RESET}${COMMIT_MSG}"
git commit -m "${COMMIT_MSG}"

# Push to release branch
echo -e "${BLUE}⬆️  Pushing release ...${RESET}"
if ! git push origin release; then
  echo -e "${YELLOW}⚠️  Push reported an issue, verifying commit sync...${RESET}"
  git fetch origin release --quiet || true
fi

# Verify sync
LOCAL=$(git rev-parse release)
REMOTE=$(git rev-parse origin/release 2>/dev/null || echo "none")

# Return to original branch
echo -e "${BLUE}🔄 Returning to ${CURRENT_BRANCH} ...${RESET}"
git checkout "${CURRENT_BRANCH}" || echo -e "${YELLOW}⚠️  Could not return automatically${RESET}"

# Check deployment status
if [ "${LOCAL}" = "${REMOTE}" ]; then
  echo ""
  echo -e "${GREEN}╔════════════════════════════════════════════╗${RESET}"
  echo -e "${GREEN}║      🎉 Deployment Successful! 🎉          ║${RESET}"
  echo -e "${GREEN}╚════════════════════════════════════════════╝${RESET}"
  echo -e "${GREEN}🌐 Release branch updated and pushed${RESET}"
  echo -e "${GREEN}📍 Commit: ${LOCAL:0:7}${RESET}"
  echo -e "${GREEN}⏰ Time: $(date '+%Y-%m-%d %H:%M:%S')${RESET}"
  
  if [ -n "${WEBHOOK_DEPLOY:-}" ]; then
    echo -e "${GREEN}🎯 Hostinger should auto-deploy if configured for 'release' branch${RESET}"
  fi
  echo ""
else
  echo -e "${RED}❌ Deployment may have failed (remote commit mismatch).${RESET}"
  exit 1
fi

echo -e "${GREEN}✅ Finished.${RESET}"
