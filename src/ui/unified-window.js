/**
 * Renderer for the unified (Cluely-style) window.
 *
 * This single window replaces what used to be three separate floating windows —
 * the icon sidebar, the LLM response overlay, and the chat window — so answers,
 * transcript, and input all land in one place instead of popping up around the
 * user's screen.
 */
(function () {
  const api = window.electronAPI || {};

  const el = {
    panel: document.getElementById('panel'),
    feed: document.getElementById('feed'),
    empty: document.getElementById('empty'),
    input: document.getElementById('input'),
    sendBtn: document.getElementById('sendBtn'),
    micBtn: document.getElementById('micBtn'),
    micMeter: document.getElementById('micMeter'),
    micMeterFill: document.getElementById('micMeterFill'),
    micMeterPct: document.getElementById('micMeterPct'),
    askBtn: document.getElementById('askBtn'),
    autoBtn: document.getElementById('autoBtn'),
    shotBtn: document.getElementById('shotBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    momBtn: document.getElementById('momBtn'),
    endBtn: document.getElementById('endBtn'),
    clearBtn: document.getElementById('clearBtn'),
    togglePanelBtn: document.getElementById('togglePanelBtn'),
    toggleIcon: document.getElementById('toggleIcon'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    skillBadge: document.getElementById('skillBadge'),
    autoBadge: document.getElementById('autoBadge')
  };

  let listening = false;
  let autoWatching = false;
  let panelOpen = true;
  let mediaStream = null;
  let audioContext = null;
  let scriptNode = null;
  // Streaming answers arrive as start → many chunks → final, keyed by messageId.
  const streaming = new Map();

  // ---------- rendering ----------

  // marked handles GitHub-flavoured lists/tables correctly; configure it once.
  if (typeof marked !== 'undefined' && marked.setOptions) {
    marked.setOptions({ gfm: true, breaks: true });
  }

  function renderMarkdown(text) {
    const raw = String(text == null ? '' : text);
    try {
      if (typeof marked !== 'undefined') {
        return marked.parse ? marked.parse(raw) : marked(raw);
      }
      if (typeof markdown !== 'undefined' && markdown.toHTML) {
        return markdown.toHTML(raw);
      }
    } catch (e) {
      console.error('[unified] markdown render failed', e);
    }
    const div = document.createElement('div');
    div.textContent = raw;
    return div.innerHTML;
  }

  function hideEmpty() {
    if (el.empty) el.empty.style.display = 'none';
  }

  function atBottom() {
    return el.feed.scrollHeight - el.feed.scrollTop - el.feed.clientHeight < 60;
  }

  function scrollDown(force) {
    if (force || atBottom()) {
      el.feed.scrollTop = el.feed.scrollHeight;
    }
  }

  function addMessage(kind, html, tag) {
    hideEmpty();
    const wasAtBottom = atBottom();
    const node = document.createElement('div');
    node.className = 'msg ' + kind;
    if (tag) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = '<span class="tag ' + (tag.kind || '') + '">' + tag.label + '</span>';
      node.appendChild(meta);
      const body = document.createElement('div');
      body.innerHTML = html;
      node.appendChild(body);
    } else {
      node.innerHTML = html;
    }
    el.feed.appendChild(node);
    scrollDown(wasAtBottom);
    return node;
  }

  function typingBubble(tag) {
    const node = addMessage('ai', '<span class="typing"><i></i><i></i><i></i></span>', tag);
    return node;
  }

  function bodyOf(node) {
    // When a tag is present the text lives in the second child.
    return node.children.length > 1 ? node.children[1] : node;
  }

  function renderMath(node) {
    try {
      if (typeof window.renderMathInElement === 'function') {
        window.renderMathInElement(node);
      }
    } catch (e) {
      /* math rendering is best-effort */
    }
  }

  // ---------- panel / status ----------

  function setPanel(open) {
    panelOpen = open;
    el.panel.classList.toggle('hidden', !open);
    el.toggleIcon.className = open ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
    if (api.resizeWindow) {
      api.resizeWindow(720, open ? 560 : 52);
    }
    if (open) scrollDown(true);
  }

  function setStatus(text, live) {
    el.statusText.textContent = text;
    el.statusDot.classList.toggle('live', !!live);
  }

  let micWatchdogTimer = null;
  let silentAudioWatchdogTimer = null;
  let sawMicLevel = false;
  let peakLevelPct = 0;

  function setListening(on) {
    listening = on;
    el.micBtn.classList.toggle('active', on);
    el.micBtn.querySelector('span').textContent = on ? 'Listening' : 'Listen';
    setStatus(on ? 'Listening' : 'Idle', on);
    el.micMeter.classList.toggle('show', on);
    el.micMeterFill.style.width = '0%';
    el.micMeterPct.textContent = '0%';

    if (micWatchdogTimer) {
      clearTimeout(micWatchdogTimer);
      micWatchdogTimer = null;
    }
    if (silentAudioWatchdogTimer) {
      clearTimeout(silentAudioWatchdogTimer);
      silentAudioWatchdogTimer = null;
    }

    if (on) {
      sawMicLevel = false;
      peakLevelPct = 0;
      startRendererAudioCapture();

      // Case 1: no bytes ever arrive — capture itself never started (denied
      // permission, no input device, getUserMedia threw).
      micWatchdogTimer = setTimeout(() => {
        if (listening && !sawMicLevel) {
          addMessage(
            'system',
            'No microphone audio detected yet. Check macOS System Settings → Privacy & Security → Microphone ' +
            '(this app must be enabled), and System Settings → Sound → Input (make sure the mic you\'re actually ' +
            'speaking into is selected — e.g. AirPods vs. the built-in mic).'
          );
        }
      }, 4000);

      // Case 2: bytes ARE arriving (capture works) but the level never rises
      // above near-silence even while you'd expect speech — the captured
      // audio itself is effectively empty. This is a different problem than
      // case 1 (wrong/muted input device, or aggressive OS noise
      // suppression flattening the signal), so it gets a different message.
      silentAudioWatchdogTimer = setTimeout(() => {
        if (listening && sawMicLevel && peakLevelPct < 3) {
          addMessage(
            'system',
            'Audio is reaching the app, but the input level is staying near silent even during speech — the ' +
            'meter next to Listen should be moving when you talk. This usually means the wrong input device is ' +
            'selected (check System Settings → Sound → Input — especially if you\'re on headphones/AirPods, ' +
            'confirm THAT mic is default), the mic is muted/very low, or you\'re too far from it.'
          );
        }
      }, 8000);
    } else {
      stopRendererAudioCapture();
    }
  }

  /**
   * On Windows and macOS the main process has no bundled way to open the mic
   * (Windows lacks sox/rec/arecord; macOS would need an unbundled Homebrew
   * `sox`), so Whisper capture happens here via the Web Audio API and chunks
   * stream to the main process over IPC. Linux uses the native recorder there
   * instead. This must match the main process's own platform gate in
   * speech.service.js, and previously lived only in the old sidebar window's
   * script — moving to the unified window without porting it silently broke
   * "Listen" on macOS/Windows (the toggle flipped state but no audio ever
   * arrived, so nothing was ever transcribed).
   */
  function needsRendererCapture() {
    const platform = (
      (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform || ''
    ).toLowerCase();
    return platform.includes('win') || platform.includes('mac');
  }

  async function startRendererAudioCapture() {
    if (!needsRendererCapture() || !api.sendAudioChunk) return;
    stopRendererAudioCapture();
    try {
      // This exact configuration (constraints, forced 16000 context rate,
      // direct connection to destination) is byte-for-byte what the old
      // sidebar window used and is confirmed to have worked. Earlier
      // attempts to "improve" this — disabling the DSP constraints, forcing
      // native-rate capture with manual downsampling — were solving a
      // problem this config didn't actually have, and never fixed the real
      // symptom. Do not change this without re-confirming against real
      // speech first.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 16000 }
        }
      });
      mediaStream = stream;

      const track = stream.getAudioTracks()[0];
      if (track) {
        const settings = track.getSettings ? track.getSettings() : {};
        console.log('[unified] mic track', track.label, settings);
        addMessage('system', 'Mic: ' + (track.label || 'unknown device') +
          (settings.sampleRate ? ` · ${settings.sampleRate}Hz` : '') +
          (settings.channelCount ? ` · ${settings.channelCount}ch` : ''));
      }

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

      scriptNode.onaudioprocess = (event) => {
        if (!listening) return;
        const inputData = event.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        api.sendAudioChunk(pcm16.buffer);
      };

      // The old sidebar connected straight to destination, which plays the
      // mic out loud — a real echo risk. Rather than insert a gain(0) node
      // in the graph (which is a known Chromium footgun: audio graphs judged
      // to produce no audible output can get processing shortcuts applied,
      // silently degrading the very buffers onaudioprocess receives — the
      // most likely explanation for chunks arriving with near-zero content
      // despite confirmed-good hardware input), mute at the WINDOW level
      // instead via webContents.setAudioMuted() in window.manager.js. That
      // leaves this audio graph identical to the proven-working original.
      source.connect(scriptNode);
      scriptNode.connect(audioContext.destination);
    } catch (e) {
      console.error('[unified] mic capture failed', e);
      addMessage('system', 'Could not access the microphone: ' + e.message);
      if (api.stopSpeechRecognition) api.stopSpeechRecognition();
    }
  }

  function stopRendererAudioCapture() {
    try {
      if (scriptNode) {
        scriptNode.disconnect();
        scriptNode.onaudioprocess = null;
        scriptNode = null;
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
      }
    } catch (e) {
      console.error('[unified] error stopping mic capture', e);
    }
  }

  function setAuto(on) {
    autoWatching = on;
    el.autoBtn.classList.toggle('active', on);
    el.autoBadge.style.display = on ? '' : 'none';
  }

  // ---------- controls ----------

  el.togglePanelBtn.addEventListener('click', () => setPanel(!panelOpen));

  el.micBtn.addEventListener('click', async () => {
    try {
      if (listening) {
        await api.stopSpeechRecognition();
      } else {
        await api.startSpeechRecognition();
      }
    } catch (e) {
      console.error('[unified] mic toggle failed', e);
    }
  });

  el.askBtn.addEventListener('click', async () => {
    if (!panelOpen) setPanel(true);
    try {
      await api.askAiHelp();
    } catch (e) {
      console.error('[unified] ask failed', e);
    }
  });

  el.autoBtn.addEventListener('click', async () => {
    if (!api.toggleScreenMonitor) return;
    try {
      const result = await api.toggleScreenMonitor();
      setAuto(!!(result && result.active));
      addMessage(
        'system',
        result && result.active
          ? 'Auto-watch on — I\'ll review the screen every few seconds and speak up when something needs an answer.'
          : 'Auto-watch off.'
      );
    } catch (e) {
      console.error('[unified] auto toggle failed', e);
    }
  });

  el.shotBtn.addEventListener('click', () => {
    if (!panelOpen) setPanel(true);
    if (api.takeScreenshot) api.takeScreenshot();
  });

  el.settingsBtn.addEventListener('click', () => api.showSettings && api.showSettings());

  /**
   * Render the minutes with the actions the user needs: save a copy anywhere,
   * open the auto-saved file, or start a new session.
   */
  function showMinutes(data) {
    if (!panelOpen) setPanel(true);

    if (!data || (!data.content && data.error)) {
      addMessage('system', (data && data.error) || 'Could not generate minutes.');
      return;
    }
    if (!data.content) {
      addMessage('system', 'No minutes were generated.');
      return;
    }

    hideEmpty();
    const node = document.createElement('div');
    // 'ai' brings the markdown typography (lists, tables, code); 'mom' adds the
    // accent border that marks it as the session's deliverable.
    node.className = 'msg ai mom';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = '<span class="tag">Minutes of Meeting</span>';
    node.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'mom-body';
    body.innerHTML = renderMarkdown(data.content);
    node.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'mom-actions';

    const download = document.createElement('button');
    download.className = 'btn primary';
    download.innerHTML = '<i class="fas fa-download"></i><span>Download</span>';
    download.addEventListener('click', async () => {
      if (!api.saveMomAs) return;
      const result = await api.saveMomAs();
      if (result && result.success) {
        addMessage('system', 'Minutes saved to ' + result.filePath);
      } else if (result && result.error) {
        addMessage('system', 'Could not save: ' + result.error);
      }
    });
    actions.appendChild(download);

    if (data.filepath) {
      const reveal = document.createElement('button');
      reveal.className = 'btn';
      reveal.innerHTML = '<i class="fas fa-folder-open"></i><span>Show file</span>';
      reveal.addEventListener('click', () => api.revealFile && api.revealFile(data.filepath));
      actions.appendChild(reveal);
    }

    if (data.isSessionEnd) {
      const restart = document.createElement('button');
      restart.className = 'btn';
      restart.innerHTML = '<i class="fas fa-rotate-right"></i><span>New session</span>';
      restart.addEventListener('click', () => api.showStartup && api.showStartup());
      actions.appendChild(restart);
    }

    node.appendChild(actions);
    el.feed.appendChild(node);
    renderMath(node);
    scrollDown(true);
  }

  el.momBtn.addEventListener('click', async () => {
    if (!api.generateMom) return;
    if (!panelOpen) setPanel(true);
    const pending = addMessage('system', 'Generating minutes…');
    try {
      const result = await api.generateMom();
      pending.remove();
      showMinutes(result);
    } catch (e) {
      pending.remove();
      addMessage('system', 'Failed to generate minutes.');
    }
  });

  el.endBtn.addEventListener('click', async () => {
    if (!api.endSession) return;
    if (!panelOpen) setPanel(true);
    const pending = addMessage('system', 'Ending session and writing up the minutes…');
    try {
      await api.endSession();
    } catch (e) {
      addMessage('system', 'Failed to end session cleanly.');
    } finally {
      pending.remove();
    }
  });

  el.clearBtn.addEventListener('click', () => {
    el.feed.innerHTML = '';
    if (el.empty) {
      el.feed.appendChild(el.empty);
      el.empty.style.display = '';
    }
    streaming.clear();
    if (api.clearSessionMemory) api.clearSessionMemory();
  });

  function send() {
    const text = el.input.value.trim();
    if (!text) return;
    el.input.value = '';
    if (!panelOpen) setPanel(true);
    addMessage('user', renderMarkdown(text));
    if (api.sendChatMessage) {
      api.sendChatMessage(text).catch((e) => {
        console.error('[unified] send failed', e);
        addMessage('system', 'Failed to send message.');
      });
    }
  }

  el.sendBtn.addEventListener('click', send);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ---------- incoming events ----------

  if (api.onRecordingStarted) api.onRecordingStarted(() => setListening(true));
  if (api.onRecordingStopped) api.onRecordingStopped(() => setListening(false));

  if (api.onSpeechStatus) {
    api.onSpeechStatus((_e, data) => {
      if (data && data.status && !listening) setStatus(String(data.status).slice(0, 40), false);
    });
  }

  if (api.onSpeechError) {
    api.onSpeechError((_e, data) => {
      addMessage('system', 'Speech error: ' + ((data && (data.error || data.message)) || 'unknown'));
    });
  }

  // What the meeting said — shown inline so the user can follow the transcript
  // in the same place as the answers.
  if (api.onTranscriptionReceived) {
    api.onTranscriptionReceived((_e, data) => {
      const text = data && data.text;
      if (text) addMessage('heard', renderMarkdown(text));
    });
  }

  if (api.onShowLoading) {
    api.onShowLoading(() => {
      if (!panelOpen) setPanel(true);
    });
  }

  // Streaming answer lifecycle
  if (api.onTranscriptionLlmResponseStart) {
    api.onTranscriptionLlmResponseStart((_e, data) => {
      if (!data || !data.messageId) return;
      if (!panelOpen) setPanel(true);
      const node = typingBubble({ label: data.skill || 'Assistant' });
      streaming.set(data.messageId, { node, text: '' });
    });
  }

  if (api.onTranscriptionLlmResponseChunk) {
    api.onTranscriptionLlmResponseChunk((_e, data) => {
      if (!data || !data.messageId) return;
      const entry = streaming.get(data.messageId);
      if (!entry) return;
      entry.text += data.delta || '';
      const wasAtBottom = atBottom();
      bodyOf(entry.node).innerHTML = renderMarkdown(entry.text);
      scrollDown(wasAtBottom);
    });
  }

  if (api.receive) {
    api.receive('transcription-llm-response-final', (_e, data) => {
      if (!data) return;
      const entry = data.messageId && streaming.get(data.messageId);
      if (entry) {
        bodyOf(entry.node).innerHTML = renderMarkdown(data.content || entry.text);
        renderMath(entry.node);
        streaming.delete(data.messageId);
        scrollDown(false);
      } else if (data.content) {
        const node = addMessage('ai', renderMarkdown(data.content), { label: data.skill || 'Assistant' });
        renderMath(node);
      }
    });

    // Auto-watch answers arrive on their own channel so they can be labelled.
    api.receive('screen-monitor-answer', (_e, data) => {
      if (!data || !data.content) return;
      if (!panelOpen) setPanel(true);
      if (data.isWarning) {
        addMessage('system', data.content);
        return;
      }
      const node = addMessage('ai', renderMarkdown(data.content), { label: 'Screen', kind: 'screen' });
      renderMath(node);
    });

    api.receive('screen-monitor-state', (_e, data) => setAuto(!!(data && data.active)));

    // Live proof audio is actually arriving, independent of whether Whisper
    // has produced words yet — a quiet room legitimately shows a low level.
    api.receive('mic-level', (_e, data) => {
      sawMicLevel = true;
      if (micWatchdogTimer) {
        clearTimeout(micWatchdogTimer);
        micWatchdogTimer = null;
      }
      const level = Math.min(1, (data && data.level) || 0);
      // RMS for speech rarely exceeds ~0.3; scale so normal talking reads mid-meter.
      const pct = Math.min(100, Math.round(level * 260));
      peakLevelPct = Math.max(peakLevelPct, pct);
      el.micMeterFill.style.width = pct + '%';
      el.micMeterFill.classList.toggle('hot', pct > 70);
      el.micMeterPct.textContent = pct + '%';
    });

    // Session ended — the minutes are ready to read and download.
    api.receive('mom-ready', (_e, data) => {
      setListening(false);
      setAuto(false);
      setStatus('Session ended', false);
      showMinutes(Object.assign({ isSessionEnd: true }, data || {}));
    });
  }

  // One-shot responses (Ask AI, screenshot analysis) that aren't streamed.
  if (api.onDisplayLlmResponse) {
    api.onDisplayLlmResponse((_e, data) => {
      if (!data || !data.content) return;
      const source = data.metadata && data.metadata.source;
      if (source === 'system') return; // interim "analyzing…" notices
      if (!panelOpen) setPanel(true);
      const node = addMessage('ai', renderMarkdown(data.content), { label: 'Assistant' });
      renderMath(node);
    });
  }

  if (api.onLlmError) {
    api.onLlmError((_e, data) => {
      addMessage('system', 'Error: ' + ((data && (data.error || data.message)) || 'request failed'));
    });
  }

  if (api.onSkillChanged) {
    api.onSkillChanged((_e, data) => {
      const skill = data && (data.skill || data.activeSkill);
      if (skill) el.skillBadge.textContent = String(skill);
    });
  }

  if (api.onSessionCleared) {
    api.onSessionCleared(() => {
      el.feed.innerHTML = '';
      if (el.empty) {
        el.feed.appendChild(el.empty);
        el.empty.style.display = '';
      }
      streaming.clear();
    });
  }

  // ---------- init ----------

  setPanel(true);
  setListening(false);

  if (api.getScreenMonitorStatus) {
    api.getScreenMonitorStatus()
      .then((s) => setAuto(!!(s && s.active)))
      .catch(() => {});
  }

  if (api.notifyMainWindowReady) api.notifyMainWindowReady();
})();
