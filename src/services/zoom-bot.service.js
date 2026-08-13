const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('ZOOM-BOT');

class ZoomBotService {
  constructor() {
    this.botWindow = null;
    this.currentSpeaker = 'Unknown';
    this.isBotActive = false;
    
    // Listen for speaker updates from the bot preload script
    ipcMain.on('bot-active-speaker', (event, speakerName) => {
      if (speakerName !== this.currentSpeaker) {
        logger.info(`Active speaker changed: ${speakerName}`);
        this.currentSpeaker = speakerName;
        // The speech.service.js or session.manager.js can read this.currentSpeaker
      }
    });
  }

  getCurrentSpeaker() {
    return this.currentSpeaker;
  }

  parseZoomUrl(url) {
    try {
      if (!url) return url;
      url = url.trim();
      
      let parsedUrl = url;
      
      // Convert any regional zoom domain to app.zoom.us to prevent WAF redirects
      parsedUrl = parsedUrl.replace(/https:\/\/[a-zA-Z0-9-]+\.zoom\.us/, 'https://app.zoom.us');
      
      if (parsedUrl.includes('/wc/') && parsedUrl.includes('/start')) {
         parsedUrl = parsedUrl.replace('/start', '/join');
      } else if (parsedUrl.includes('/j/')) {
         parsedUrl = parsedUrl.replace(/\/j\/(\d+)/, '/wc/join/$1');
      }
      
      return parsedUrl;
    } catch (e) {
      logger.error('Failed to parse zoom URL', { url, e: e.message, stack: e.stack });
      return url;
    }
  }

  startBot(zoomUrl, botName) {
    require('fs').appendFileSync(require('path').join(require('os').homedir(), 'Desktop', 'zoombot_extreme_debug.txt'), `[startBot] Called with url: ${zoomUrl}\n`);
    
    if (this.botWindow) {
      this.stopBot();
    }

    const webClientUrl = this.parseZoomUrl(zoomUrl);
    require('fs').appendFileSync(require('path').join(require('os').homedir(), 'Desktop', 'zoombot_extreme_debug.txt'), `[startBot] Parsed webClientUrl: ${webClientUrl}\n`);
    logger.info('Starting Zoom Bot', { url: webClientUrl, botName });

    this.isBotActive = true;
    this.currentSpeaker = 'Unknown';

    this.botWindow = new BrowserWindow({
      width: 1024,
      height: 768,
      show: true,
      webPreferences: {
        partition: 'persist:zoom-bot',
        nodeIntegration: false,
        contextIsolation: false,
        preload: path.join(__dirname, '../preload/zoom-bot-preload.js')
      }
    });

    // Cloudflare/Zoom WAF aggressively blocks "Electron" in the User-Agent with ERR_FAILED.
    // We spoof a standard Chrome User-Agent across the entire session to survive 302 redirects.
    const customUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    
    this.botWindow.webContents.setUserAgent(customUA);
    this.botWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['User-Agent'] = customUA;
      callback({ cancel: false, requestHeaders: details.requestHeaders });
    });

    this.botWindow.loadURL(webClientUrl);

    this.botWindow.webContents.on('did-finish-load', () => {
      this.botWindow.webContents.send('start-bot-automation', { botName });
      
      // DEBUG: Capture a screenshot after 10 seconds to see where it gets stuck
      setTimeout(() => {
        if (this.botWindow && !this.botWindow.isDestroyed()) {
          this.botWindow.webContents.capturePage().then(image => {
            const fs = require('fs');
            const fsPath = path.join(require('os').homedir(), 'Desktop', 'zoom-bot-debug.png');
            fs.writeFileSync(fsPath, image.toPNG());
            logger.info('Saved debug screenshot to desktop: ' + fsPath);
          }).catch(e => logger.error('Failed to capture screenshot', e));
        }
      }, 10000);
    });

    this.botWindow.on('closed', () => {
      this.botWindow = null;
      this.isBotActive = false;
    });
  }

  stopBot() {
    if (this.botWindow) {
      this.botWindow.destroy();
      this.botWindow = null;
    }
    this.isBotActive = false;
  }
}

module.exports = new ZoomBotService();
