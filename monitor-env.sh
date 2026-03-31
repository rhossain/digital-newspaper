#!/bin/bash
# Monitor .env file for unauthorized changes
# Usage: ./monitor-env.sh

ENV_FILE=".env"
CORRECT_SECRET="c307cd680eca6807532c5984b4b76d7462ea3900101ca189c53f7c3a5adf513e"
WRONG_URL="webhooks.hostinger.com"

echo "🔍 Monitoring $ENV_FILE for unauthorized changes..."
echo "✓ Correct secret: $CORRECT_SECRET"
echo "✗ Wrong pattern: $WRONG_URL"
echo ""
echo "Press Ctrl+C to stop"
echo ""

while true; do
  if [ -f "$ENV_FILE" ]; then
    # Check if wrong value appears
    if grep -q "$WRONG_URL" "$ENV_FILE"; then
      echo "⚠️  WRONG VALUE DETECTED! $(date)"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      
      # Show the wrong line
      echo "Wrong line:"
      grep "GITHUB_WEBHOOK_SECRET" "$ENV_FILE"
      echo ""
      
      # Show what processes have the file open
      echo "Processes with .env open:"
      lsof "$ENV_FILE" 2>/dev/null || echo "  (none detected)"
      echo ""
      
      # Show recent VS Code processes
      echo "VS Code processes:"
      ps aux | grep -i "[c]ode" | head -5 || echo "  (none running)"
      echo ""
      
      # Auto-fix
      echo "🔧 Auto-fixing..."
      cat > "$ENV_FILE" << 'EOF'
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
      echo "✓ Fixed with correct hash"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
    fi
  else
    echo "⚠️  .env file missing! $(date)"
    echo "Creating with correct values..."
    cat > "$ENV_FILE" << 'EOF'
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
    echo "✓ Created"
    echo ""
  fi
  
  sleep 3
done
