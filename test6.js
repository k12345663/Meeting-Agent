const { app } = require('electron');
app.whenReady().then(() => {
  const zoomBotService = require('./src/services/zoom-bot.service');
  zoomBotService.startBot("https://us05web.zoom.us/j/83392905707", "psbot");
  setTimeout(() => app.quit(), 3000);
});
