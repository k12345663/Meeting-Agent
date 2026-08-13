const { app, BrowserWindow, ipcMain } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  ipcMain.on('audio-chunk', (event, msg) => {
    console.log("Received audio chunk:", msg);
  });

  win.loadURL(`data:text/html,<html><body><script>
    const { ipcRenderer } = require('electron');
    const originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(...args) {
      const destination = args[0];
      
      if (destination && destination.context && destination === destination.context.destination) {
        if (!destination.context._isCaptured) {
          destination.context._isCaptured = true;
          const streamDest = destination.context.createMediaStreamDestination();
          
          const scriptNode = destination.context.createScriptProcessor(4096, 1, 1);
          scriptNode.onaudioprocess = (event) => {
            ipcRenderer.send('audio-chunk', 'got chunk!');
          };
          
          const source = destination.context.createMediaStreamSource(streamDest.stream);
          originalConnect.call(source, scriptNode);
          originalConnect.call(scriptNode, destination.context.destination);
          console.log("Hooked AudioContext destination!");
          
          destination.context._captureStreamDest = streamDest;
        }
        
        // Also connect to our stream destination
        originalConnect.call(this, destination.context._captureStreamDest);
      }
      
      return originalConnect.apply(this, args);
    };

    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); app.quit(); }, 500);
  </script></body></html>`);
});
