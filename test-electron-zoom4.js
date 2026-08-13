const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = 'TEST';
    callback({ requestHeaders: details.requestHeaders });
  });
  console.log("Registered both!");
  setTimeout(() => app.quit(), 1000);
});
