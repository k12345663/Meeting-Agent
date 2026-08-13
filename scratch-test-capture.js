const { app, BrowserWindow, desktopCapturer } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadURL('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  const captureWin = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  captureWin.loadURL('about:blank');

  setTimeout(() => {
    const sourceId = win.webContents.getMediaSourceId();
    captureWin.webContents.executeJavaScript(`
      navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: '${sourceId}'
          }
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: '${sourceId}'
          }
        }
      }).then(stream => {
        console.log('Got stream:', stream.getAudioTracks().length, 'audio tracks');
        require('electron').ipcRenderer.send('stream-success');
      }).catch(e => {
        console.error('Stream error:', e);
        require('electron').ipcRenderer.send('stream-error', e.message);
      });
    `);
  }, 3000);

  require('electron').ipcMain.on('stream-success', () => {
    console.log('SUCCESS: Captured webContents audio!');
    app.quit();
  });
  
  require('electron').ipcMain.on('stream-error', (e, msg) => {
    console.log('ERROR: Failed to capture -', msg);
    app.quit();
  });
});
