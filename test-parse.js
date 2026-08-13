const fs = require('fs');
const url = "https://us05web.zoom.us/j/83392905707?pwd=38EgdeF2bLCbMjbKl48ja0nqAB8cZP.1";
let out = "Original: " + url + "\n";
try {
  let urlStr = url.trim();
  const urlObj = new URL(urlStr);
  const pathname = urlObj.pathname;
  out += "pathname: " + pathname + "\n";
  
  if (pathname.includes('/wc/join/')) {
     out += "already has wc/join\n";
  }
  
  const match = pathname.match(/\/j\/(\d+)/);
  if (match && match[1]) {
    const meetingId = match[1];
    urlObj.pathname = `/wc/join/${meetingId}`;
    out += "Match found! New URL: " + urlObj.toString() + "\n";
  } else {
    out += "No match!\n";
  }
} catch (e) {
  out += "Error: " + e.message + "\n";
}
fs.writeFileSync('test-parse.txt', out);
