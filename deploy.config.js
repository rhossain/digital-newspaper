// FTP Deployment Configuration
// Copy this file to deploy.config.local.js and add your credentials
// deploy.config.local.js is in .gitignore for security

module.exports = {
  host: process.env.HOSTINGER_HOST || '',
  user: process.env.HOSTINGER_USER || '',
  password: process.env.HOSTINGER_PASS || '',
  port: process.env.HOSTINGER_PORT || 21,
  localRoot: './dist/digital-newspaper',
  remoteRoot: process.env.HOSTINGER_REMOTE_PATH || '/public_html/diginews',
  useSftp: process.env.HOSTINGER_USE_SFTP === 'true',
  include: ['*', '**/*'],
  exclude: ['**/*.map', 'node_modules/**', '.git/**'],
  deleteRemote: false,
  forcePasv: true
};
