const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600, show: true });
  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.log("FAILED TO LOAD", code, desc, url);
  });
  win.webContents.on('did-finish-load', () => {
    console.log("SUCCESS");
  });
  win.loadURL('https://app.zoom.us/wc/join/85160395835?pwd=QzyJZF7bmYQfC5kasbMuxJk5NZEn8b.1');
  setTimeout(() => app.quit(), 5000);
});
