// Production environment — update wpBaseUrl below to match your WordPress installation.
// When the Angular app is served from the same hostname as WordPress, all /wp/ paths
// are same-origin and the browser never triggers CORS. The absolute URL is needed here
// because Angular's HttpClient resolves the URL against the page's base URI.
export const environment = {
  production: true,
  wpBaseUrl: 'https://epaper.dailysangram.com/wp',
  demo: false,
};
