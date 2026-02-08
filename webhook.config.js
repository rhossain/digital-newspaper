// Webhook Configuration Template
// Copy this file to webhook.config.local.js and add your secret
// webhook.config.local.js is in .gitignore for security

module.exports = {
  // Generate a strong secret: openssl rand -hex 32
  secret: process.env.GITHUB_WEBHOOK_SECRET || 'your-webhook-secret-here',
  port: process.env.WEBHOOK_PORT || 3001,
  branch: 'development',  // Branch to trigger deployment
  projectDir: '/home/your-username/digital-newspaper'  // Update this path
};
