const { app } = require('electron');
app.whenReady().then(() => {
  let u = new URL("https://us05web.zoom.us/j/12345");
  u.host = "app.zoom.us";
  u.pathname = "/wc/join/12345";
  console.log("ELECTRON URL:", u.toString());
  app.quit();
});
