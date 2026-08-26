const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('ZOOM-BOT');

class ZoomBotService {
  constructor() {
    this.botWindow = null;
    this.currentSpeaker = 'Unknown';
    this.isBotActive = false;
    // Everyone seen in the meeting, in the order they were first observed.
    this.participants = new Set();
    // Who spoke, and roughly how much, for the minutes' attendee list.
    this.speakerTurns = new Map();

    // Listen for speaker updates from the bot preload script
    ipcMain.on('bot-active-speaker', (event, speakerName) => {
      if (speakerName !== this.currentSpeaker) {
        logger.info(`Active speaker changed: ${speakerName}`);
        this.currentSpeaker = speakerName;
        if (speakerName && speakerName !== 'Unknown') {
          this.participants.add(speakerName);
          this.speakerTurns.set(speakerName, (this.speakerTurns.get(speakerName) || 0) + 1);
        }
        // The speech.service.js or session.manager.js can read this.currentSpeaker
      }
    });

    // Roster updates: who is in the meeting, regardless of who is talking.
    ipcMain.on('bot-participants', (event, names) => {
      if (!Array.isArray(names)) return;
      let added = false;
      names.forEach((name) => {
        if (name && !this.participants.has(name)) {
          this.participants.add(name);
          added = true;
        }
      });
      if (added) {
        logger.info('Meeting roster updated', { participants: Array.from(this.participants) });
      }
    });
  }

  getCurrentSpeaker() {
    return this.currentSpeaker;
  }

  /** Everyone observed in the meeting. */
  getParticipants() {
    return Array.from(this.participants);
  }

  /** Participants who actually spoke, most active first. */
  getSpeakers() {
    return Array.from(this.speakerTurns.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
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
         // Zoom's web client expects /wc/<id>/join, not /wc/join/<id>. The old
         // pattern still 302-redirects to the right place, but that redirect
         // drops the pwd= query param, so passcode-protected meetings landed
         // on "This meeting link is invalid (3,001)". Building the current
         // pattern directly keeps pwd intact.
         parsedUrl = parsedUrl.replace(/\/j\/(\d+)/, '/wc/$1/join');
      }
      
      return parsedUrl;
    } catch (e) {
      logger.error('Failed to parse zoom URL', { url, e: e.message, stack: e.stack });
      return url;
    }
  }

  startBot(zoomUrl, botName) {
    if (this.botWindow) {
      this.stopBot();
    }

    const webClientUrl = this.parseZoomUrl(zoomUrl);
    logger.info('Starting Zoom Bot', { url: zoomUrl, parsedUrl: webClientUrl, botName });

    this.isBotActive = true;
    this.currentSpeaker = 'Unknown';
    this.participants = new Set();
    this.speakerTurns = new Map();

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

    // Mute the window so audio doesn't play out of the laptop speakers.
    // The Web Audio API interception in the preload script will still capture the audio chunks.
    this.botWindow.webContents.setAudioMuted(true);

    this.botWindow.loadURL(webClientUrl);

    this.botWindow.webContents.on('did-finish-load', () => {
      this.botWindow.webContents.send('start-bot-automation', { botName });
    });

    this.botWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      logger.error('Zoom Bot failed to load meeting page', {
        errorCode,
        errorDescription,
        url: validatedURL
      });
    });

    this.botWindow.on('closed', () => {
      this.botWindow = null;
      this.isBotActive = false;
    });
  }

  /**
   * Capture what the bot is currently looking at inside the meeting — shared
   * screens, slides, whiteboards, participant video — as a base64 PNG.
   * This is the bot's "eyes": unlike a desktop screenshot it sees the meeting
   * itself, so it keeps working even when the user is on another app or the
   * meeting is only open in the bot's own hidden window.
   * Returns null when the bot isn't in a meeting or the frame is unavailable.
   */
  async captureMeetingFrame() {
    if (!this.isBotActive || !this.botWindow || this.botWindow.isDestroyed()) {
      return null;
    }
    try {
      const image = await this.botWindow.webContents.capturePage();
      if (!image || image.isEmpty()) {
        return null;
      }
      return image.toPNG().toString('base64');
    } catch (error) {
      logger.error('Failed to capture meeting frame', { error: error.message });
      return null;
    }
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
