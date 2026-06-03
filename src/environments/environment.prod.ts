// Production environment — the Angular app is served from the same hostname as
// WordPress (https://epaper.dailysangram.com), so all /wp/ paths are same-origin
// and the browser never triggers CORS. The absolute URL is needed here because
// Angular's HttpClient resolves the URL against the page's base URI.
export const environment = {
  production: true,
  wpBaseUrl: 'https://nepaper.dailysangram.com/wp',
};
