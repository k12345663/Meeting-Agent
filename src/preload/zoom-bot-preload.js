const { ipcRenderer } = require('electron');

// We intercept the active speaker from the Zoom Web Client DOM
let currentSpeaker = 'Unknown';
let speakerInterval = null;

// This function attempts to find the active speaker in the Zoom Web Client DOM
function monitorActiveSpeaker() {
  speakerInterval = setInterval(() => {
    try {
      // Zoom Web Client DOM usually has video elements or active speaker indicators
      // Example selectors (these may change based on Zoom updates):
      // The active speaker view often has a class like .active-speaker or .speaker-active
      const activeSpeakerEl = document.querySelector('.active-speaker-container .participant-name') || 
                              document.querySelector('.speaker-active .name') ||
                              document.querySelector('.active-video-container .participant-name') ||
                              document.querySelector('.speaker-bar-container .participant-name');
                              
      let detectedSpeaker = activeSpeakerEl ? activeSpeakerEl.innerText.trim() : 'Unknown';
      
      // If we found a speaker and it's different from the last one
      if (detectedSpeaker && detectedSpeaker !== currentSpeaker && detectedSpeaker !== 'Unknown') {
        currentSpeaker = detectedSpeaker;
        ipcRenderer.send('bot-active-speaker', currentSpeaker);
      }
    } catch (e) {
      console.error('Error monitoring active speaker:', e);
    }
  }, 1000);
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
        return; // Wait for the next page to load
      }

      // 2. Look for the Name input field (on the /wc/join/ page)
      const allInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="password"]'));
      let nameInput = document.querySelector('input[name="inputname"]') || 
                      document.querySelector('input#input-for-name');
                      
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
        const joinBtn = document.querySelector('button.join-btn') || 
                        document.querySelector('button.preview-join-button') || 
                        document.querySelector('button[type="submit"]') ||
                        document.querySelector('#joinBtn');
        if (joinBtn && !joinBtn.disabled) {
          joinBtn.click();
          clearInterval(joinInterval); // Stop trying to join
          
          // Start monitoring the active speaker once joined
          setTimeout(monitorActiveSpeaker, 5000);
          return;
        }
      }
      
      // 3. Fallback: Sometimes it directly lands on "I Agree" or "Got it" for Audio/Video policies
      const agreeBtn = Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('I Agree') || el.textContent.includes('Got it'));
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
