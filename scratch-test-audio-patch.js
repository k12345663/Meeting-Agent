const { app, BrowserWindow, ipcMain } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadURL('data:text/html,<html><body><script>
    // Monkey patch AudioNode.prototype.connect
    const originalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function(...args) {
      const dest = args[0];
      if (dest.constructor.name === "AudioDestinationNode" || dest === this.context.destination) {
        console.log("Connecting to destination!");
        // Create an intermediate ScriptProcessor to capture audio
        if (!this.context.__captureNode) {
          this.context.__captureNode = this.context.createScriptProcessor(4096, 2, 2);
          this.context.__captureNode.onaudioprocess = (e) => {
            console.log("Captured audio chunk!");
          };
          originalConnect.call(this.context.__captureNode, this.context.destination);
        }
        originalConnect.call(this, this.context.__captureNode);
        return dest;
      }
      return originalConnect.apply(this, args);
    };

    // Test it
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => osc.stop(), 500);
  </script></body></html>');
});
