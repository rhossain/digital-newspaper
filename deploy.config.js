// FTP Deployment Configuration
// Copy this file to deploy.config.local.js and add your credentials
// deploy.config.local.js is in .gitignore for security

module.exports = {
  host: process.env.FTP_HOST || 'ftp://217.21.91.251',
  user: process.env.FTP_USER || 'u594404148',
  password: process.env.FTP_PASSWORD || 'saRobin@007',
  port: process.env.FTP_PORT || 21,
  localRoot: './dist/digital-newspaper/browser',
  remoteRoot: '/public_html/diginews/',
  include: ['*', '**/*'],
  exclude: ['**/*.map', 'node_modules/**', '.git/**'],
  deleteRemote: false,
  forcePasv: true
};
