// Development environment — call WordPress through the Angular CLI dev-server
// proxy. The browser talks to localhost only, which avoids browser CORS issues
// when the WordPress host blocks or strips cross-origin REST headers.
export const environment = {
  production: false,
  wpBaseUrl: '/wp',
};
