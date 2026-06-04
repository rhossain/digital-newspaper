// Development environment — call WordPress directly from the browser.
// Avoid the Angular CLI proxy here: shared-host bot protection can classify
// Node/server-to-server proxy traffic as automation and block valid admin saves.
export const environment = {
  production: false,
  wpBaseUrl: 'https://epaper.dailysangram.com/wp',
};
