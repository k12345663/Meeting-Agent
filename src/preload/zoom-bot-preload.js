const { ipcRenderer } = require('electron');

// Never let the bot transmit this machine's real microphone into the meeting.
// If the physical mic were used, it could pick up whatever this same device is
// playing out of its speakers (e.g. the user's own separate Zoom client in the
// same room) and echo it straight back into the call for every participant.
// The bot only needs to LISTEN (captured via the srcObject/AudioContext hooks
// below), so its outgoing audio track is always silent.
const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async function (constraints) {
  if (constraints && constraints.audio) {
    const silentCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = silentCtx.createMediaStreamDestination();
    const silentTrack = dest.stream.getAudioTracks()[0];
    silentTrack.enabled = false;
    return new MediaStream([silentTrack]);
  }
  return originalGetUserMedia(constraints);
};

// We intercept the active speaker from the Zoom Web Client DOM
let currentSpeaker = 'Unknown';
let speakerInterval = null;

/**
 * Work out who is speaking right now inside the Zoom web client.
 *
 * Note this reads the meeting UI, not audio devices — so it is unaffected by
 * whether the user has headphones plugged in, which output device is selected,
 * or whether this machine's speakers are muted. The bot receives each
 * participant's stream directly from Zoom and Zoom marks the active speaker in
 * the DOM, so attribution keeps working with headphones on.
 *
 * Zoom ships several layouts (speaker view, gallery view, the participants
 * panel) and renames classes between releases, so this tries the stable
 * structural signals in order rather than relying on one selector.
 */
function detectActiveSpeaker(doc) {
  const clean = (value) => {
    if (!value) return '';
    // Strip the suffixes Zoom appends in the participants list.
    return String(value)
      .replace(/\((Host|Co-host|Guest|me|Me)\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  };

  try {
    // 1. Explicit "X is speaking" accessibility labels — the most reliable
    //    signal, and present in current builds.
    const speakingAria = doc.querySelector('[aria-label*="is speaking" i], [aria-label*="talking" i]');
    if (speakingAria) {
      const label = speakingAria.getAttribute('aria-label') || '';
      const match = label.match(/^(.*?)\s+is\s+speaking/i) || label.match(/^(.*?)\s+is\s+talking/i);
      if (match && clean(match[1])) return clean(match[1]);
    }

    // 2. A video tile flagged as the active speaker; the name sits in the tile.
    const activeTile = doc.querySelector(
      '.speaker-active, .active-speaker, [class*="active-speaker"], [class*="speaker-active"], .video-avatar__avatar--active'
    );
    if (activeTile) {
      const nameEl = activeTile.querySelector(
        '.participant-name, .video-avatar__participant-name, [class*="participant-name"], [class*="display-name"]'
      );
      const name = clean(nameEl ? nameEl.textContent : activeTile.getAttribute('aria-label'));
      if (name) return name;
    }

    // 3. Participants panel: the row whose mic icon shows active audio.
    const speakingRow = doc.querySelector(
      '[class*="participants-item"] [class*="speaking"], [class*="participant"] [class*="audio-animation"], [class*="mic"][class*="speaking"]'
    );
    if (speakingRow) {
      const row = speakingRow.closest('[class*="participants-item"], [class*="participant"]') || speakingRow.parentElement;
      const nameEl = row && row.querySelector('[class*="participants-item__display-name"], [class*="display-name"], [class*="participant-name"]');
      const name = clean(nameEl ? nameEl.textContent : '');
      if (name) return name;
    }

    // 4. Legacy selectors from older web-client builds.
    const legacy = doc.querySelector('.active-speaker-container .participant-name') ||
                   doc.querySelector('.speaker-active .name') ||
                   doc.querySelector('.active-video-container .participant-name') ||
                   doc.querySelector('.speaker-bar-container .participant-name');
    if (legacy) {
      const name = clean(legacy.textContent);
      if (name) return name;
    }
  } catch (e) {
    console.error('Error detecting active speaker:', e);
  }

  return 'Unknown';
}

/**
 * Read the meeting roster so the app knows who is actually in the call, not
 * just who happens to be talking. Names come from the participants panel when
 * it's open and from the video tiles otherwise, so the list still fills in when
 * the user never opens the panel.
 */
function detectParticipants(doc) {
  const names = new Set();
  const clean = (value) => String(value || '')
    .replace(/\((Host|Co-host|Guest|me|Me)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    const nodes = doc.querySelectorAll(
      '[class*="participants-item__display-name"], [class*="participants-li__display-name"], ' +
      '[class*="video-avatar__participant-name"], [class*="participant-name"], [class*="display-name"]'
    );
    nodes.forEach((node) => {
      const name = clean(node.textContent);
      // Filter out obvious non-names (empty, numeric, absurdly long labels).
      if (name && name.length > 1 && name.length < 60) {
        names.add(name);
      }
    });
  } catch (e) {
    console.error('Error detecting participants:', e);
  }

  return Array.from(names);
}

// This function attempts to find the active speaker in the Zoom Web Client DOM
function monitorActiveSpeaker() {
  speakerInterval = setInterval(() => {
    try {
      // Zoom Web Client DOM usually has video elements or active speaker indicators
      // Example selectors (these may change based on Zoom updates):
      // The active speaker view often has a class like .active-speaker or .speaker-active
      // The in-meeting UI lives inside the same #webclient iframe as the join form.
      const doc = getWebclientDoc();
      const detectedSpeaker = detectActiveSpeaker(doc);

      // If we found a speaker and it's different from the last one
      if (detectedSpeaker && detectedSpeaker !== currentSpeaker && detectedSpeaker !== 'Unknown') {
        currentSpeaker = detectedSpeaker;
        ipcRenderer.send('bot-active-speaker', currentSpeaker);
      }

      const participants = detectParticipants(doc);
      if (participants.length) {
        ipcRenderer.send('bot-participants', participants);
      }
    } catch (e) {
      console.error('Error monitoring active speaker:', e);
    }
  }, 1000);
}

// Zoom's web client renders the actual join form (name field, join button)
// inside a same-origin <iframe id="webclient">, not in the top-level document.
// Querying `document` directly for those elements never finds them once the
// PWA wrapper takes over, so every step past "Join from browser" has to look
// inside the iframe's own document once it exists.
function getWebclientDoc() {
  const iframe = document.getElementById('webclient');
  if (iframe) {
    try {
      if (iframe.contentDocument && iframe.contentDocument.body) {
        return iframe.contentDocument;
      }
    } catch (e) {
      // Cross-origin or not yet accessible; fall back to top document.
    }
  }
  return document;
}

// Function to automate joining the meeting
function automateJoin(botName) {
  console.log('Automating Zoom Web Client Join...');

  // Wait for the DOM to load the join inputs
  const joinInterval = setInterval(() => {
    try {
      // 0. Handle Cookie Consent if it blocks the screen
      const cookieBtn = document.querySelector('#onetrust-accept-btn-handler') || document.querySelector('.onetrust-close-btn-handler');
      if (cookieBtn) {
        cookieBtn.click();
      }

      // 1. Look for the "Join from Your Browser" link (if on the standard invite page)
      const joinFromBrowserBtn = document.querySelector('a[role="button"][href*="/wc/join/"]') ||
                                 document.querySelector('button.zoom-button--secondary') ||
                                 Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('Join from browser') || el.textContent.includes('Join from Your Browser'));

      if (joinFromBrowserBtn) {
        joinFromBrowserBtn.click();
        return; // Wait for the next page (the webclient iframe) to load
      }

      const doc = getWebclientDoc();

      // 2. Look for the Name input field (inside the webclient iframe)
      const allInputs = Array.from(doc.querySelectorAll('input[type="text"], input[type="password"]'));
      let nameInput = doc.querySelector('input[name="inputname"]') ||
                      doc.querySelector('input#input-for-name');

      if (!nameInput && allInputs.length > 0) {
        // Search for placeholder or id containing "name"
        nameInput = allInputs.find(el =>
          (el.placeholder && el.placeholder.toLowerCase().includes('name')) ||
          (el.id && el.id.toLowerCase().includes('name'))
        );
        // Fallback: If there are multiple inputs, the passcode is usually first, name is second
        if (!nameInput) {
          nameInput = allInputs.length > 1 ? allInputs[1] : allInputs[0];
        }
      }

      if (nameInput && !nameInput.disabled) {
        if (nameInput.value !== (botName || 'Meeting Assistant')) {
           nameInput.value = botName || 'Meeting Assistant';
           // Dispatch input event so React/Angular registers the change
           nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Also check if there is a passcode field that needs filling, but we don't have the password.
        // If the Join button is clicked without a password, it will fail.

        // Find and click the Join button
        const joinBtn = doc.querySelector('button.join-btn') ||
                        doc.querySelector('button.preview-join-button') ||
                        doc.querySelector('button[type="submit"]') ||
                        doc.querySelector('#joinBtn');
        if (joinBtn && !joinBtn.disabled) {
          joinBtn.click();
          clearInterval(joinInterval); // Stop trying to join

          // Start monitoring the active speaker once joined
          setTimeout(monitorActiveSpeaker, 5000);
          return;
        }
      }

      // 3. Fallback: Sometimes it directly lands on "I Agree" or "Got it" for Audio/Video policies
      const agreeBtn = Array.from(doc.querySelectorAll('button')).find(el => el.textContent.includes('I Agree') || el.textContent.includes('Got it'));
      if (agreeBtn) {
         agreeBtn.click();
      }

    } catch (e) {
      console.error('Error automating join:', e);
    }
  }, 2000);
}

// Listen for the start command from the main process
ipcRenderer.on('start-bot-automation', (event, { botName }) => {
  automateJoin(botName);
});

// Intercept HTMLMediaElement srcObject to capture audio from the Zoom meeting (Legacy/Mic fallback)
const originalSetSrcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject').set;
Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
  set(stream) {
    if (stream && !stream._captured) {
      stream._captured = true;
      try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(stream);
        const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
        
        scriptNode.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(inputData.length);
          let hasAudio = false;
          for (let i = 0; i < inputData.length; i++) {
            if (inputData[i] !== 0) hasAudio = true;
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          if (hasAudio) {
            ipcRenderer.send('zoom-bot-audio-chunk', Buffer.from(pcm16.buffer));
          }
        };
        
        const mute = audioContext.createGain();
        mute.gain.value = 0;
        source.connect(scriptNode);
        scriptNode.connect(mute);
        mute.connect(audioContext.destination);
        console.log('Successfully hooked audio stream (srcObject) for Zoom Bot');
      } catch (e) { 
        console.error('Error capturing stream:', e); 
      }
    }
    return originalSetSrcObject.call(this, stream);
  }
});

// Intercept AudioContext for Zoom Web Client's main WebAssembly audio engine
const originalConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function(...args) {
  const destination = args[0];
  
  if (destination && destination.context && destination === destination.context.destination) {
    // OfflineAudioContext has no createMediaStreamDestination; calling it threw
    // and — because _isCaptured was set before the try — permanently disabled
    // capture for that context. Skip contexts that can't be tapped, and only
    // mark a context captured once the hook is actually in place.
    if (!destination.context._isCaptured &&
        typeof destination.context.createMediaStreamDestination === 'function') {
      try {
        const streamDest = destination.context.createMediaStreamDestination();
        destination.context._captureStreamDest = streamDest;

        const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(streamDest.stream);
        const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
        
        scriptNode.onaudioprocess = (event) => {
          const inputData = event.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(inputData.length);
          let hasAudio = false;
          for (let i = 0; i < inputData.length; i++) {
            if (inputData[i] !== 0) hasAudio = true;
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          if (hasAudio) {
            ipcRenderer.send('zoom-bot-audio-chunk', Buffer.from(pcm16.buffer));
          }
        };
        
        // A ScriptProcessor only fires onaudioprocess while connected to a sink,
        // but routing it to the speakers would play the meeting out loud on this
        // machine. A zero-gain node keeps the graph pulling audio silently.
        const mute = audioContext.createGain();
        mute.gain.value = 0;
        source.connect(scriptNode);
        scriptNode.connect(mute);
        mute.connect(audioContext.destination);

        destination.context._isCaptured = true;
        console.log("Successfully hooked AudioContext for Zoom Bot (Remote Audio)");
      } catch (e) {
        console.error("Error setting up AudioContext capture:", e);
      }
    }
    
    if (destination.context._captureStreamDest) {
      originalConnect.call(this, destination.context._captureStreamDest);
    }
  }
  
  return originalConnect.apply(this, args);
};
