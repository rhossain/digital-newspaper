// Demo / Showcase Mode environment.
// Build with: npm run build:demo   (ng build --configuration demo)
// Serve with: npm run serve:demo   (ng serve --configuration demo)
//
// Point wpBaseUrl at the ISOLATED demo WordPress install (never production).
// The demo WP install must have "Demo / Showcase Mode" enabled in the plugin
// settings. With demo:true the app bootstraps a per-tab session token and the
// wp-api interceptor attaches the X-DN-Demo-Session header so every edit lands
// in a private, ephemeral server-side overlay. See DEMO_MODE_TODO.md.
export const environment = {
  production: true,
  wpBaseUrl: 'https://diginews.rshossain.me/wp',
  demo: true,
};
