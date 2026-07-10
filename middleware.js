export const config = {
  matcher: '/((?!api|css|js|images|favicon.ico).*)',
};

export default function middleware(request) {
  var url = new URL(request.url);

  fetch('https://ntfy.sh/fleetmagnify-pings-x7k2p9', {
    method: 'POST',
    body: 'Page view: ' + url.pathname,
  }).catch(function () {});
}
