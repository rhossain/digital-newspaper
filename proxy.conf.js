module.exports = {
  '/wp/': {
    target: 'https://epaper.dailysangram.com',
    secure: true,
    changeOrigin: true,
    logLevel: 'debug',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      Referer: 'https://epaper.dailysangram.com/',
    },
    onProxyReq(proxyReq) {
      proxyReq.removeHeader('origin');
      proxyReq.setHeader('Accept', 'application/json, text/plain, */*');
      proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36');
      proxyReq.setHeader('Referer', 'https://epaper.dailysangram.com/');
    },
  },
};