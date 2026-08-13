const url = "https://us05web.zoom.us/j/83392905707";
function parseZoomUrl(u) {
  try {
    if (!u) return u;
    u = u.trim();
    const urlObj = new URL(u);
    urlObj.host = 'app.zoom.us';
    if (urlObj.pathname.includes('/wc/') && urlObj.pathname.includes('/start')) {
       urlObj.pathname = urlObj.pathname.replace('/start', '/join');
    } else if (urlObj.pathname.includes('/j/')) {
       const match = urlObj.pathname.match(/\/j\/(\d+)/);
       if (match) {
          urlObj.pathname = `/wc/join/${match[1]}`;
       }
    }
    return urlObj.toString();
  } catch (e) {
    return u;
  }
}
console.log("Parsed:", parseZoomUrl(url));
