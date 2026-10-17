import { ScrollViewStyleReset } from 'expo-router/html';
import { type PropsWithChildren } from 'react';

/** Shown until the app has painted, so a blank page is not mistaken for a freeze. */
const boot = `
html, body { height: 100%; margin: 0; background: #f8fafc; }
#boot-loader {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: #f8fafc; color: #6b7280; font: 500 13px system-ui, sans-serif;
}
#boot-loader .ring {
  width: 28px; height: 28px; border-radius: 50%;
  border: 3px solid #dbeafe; border-top-color: #1e3a8a;
  animation: mycroscope-spin 0.8s linear infinite;
}
@keyframes mycroscope-spin { to { transform: rotate(360deg); } }
`;

const hideBoot = `
(function () {
  function ready() {
    var root = document.getElementById('root');
    return !!(root && root.childElementCount > 0);
  }
  function hide() {
    var el = document.getElementById('boot-loader');
    if (el) el.remove();
  }
  var timer = setInterval(function () {
    if (ready()) { clearInterval(timer); hide(); }
  }, 40);
})();
`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: boot }} />
      </head>
      <body>
        <div id="boot-loader">
          <div className="ring" />
          Loading
        </div>
        {children}
        <script dangerouslySetInnerHTML={{ __html: hideBoot }} />
      </body>
    </html>
  );
}
