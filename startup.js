document.addEventListener('DOMContentLoaded', () => {
    let filePaths = [];

    const fileInput = document.getElementById('fileInput');
    const fileList = document.getElementById('fileList');
    const startBtn = document.getElementById('startBtn');
    const meetingPrompt = document.getElementById('meetingPrompt');
    const useBotToggle = document.getElementById('useBotToggle');
    const botSettingsGroup = document.getElementById('botSettingsGroup');
    const zoomUrlInput = document.getElementById('zoomUrl');
    const botNameInput = document.getElementById('botName');

    // Handle bot toggle
    useBotToggle.addEventListener('change', (e) => {
        botSettingsGroup.style.display = e.target.checked ? 'block' : 'none';
    });

    // Handle file selection
    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        filePaths = files.map(file => file.path); // Electron provides absolute path

        if (files.length > 0) {
            fileList.innerHTML = files.map(f => `<div><i class="fas fa-check-circle"></i> ${f.name}</div>`).join('');
        } else {
            fileList.innerHTML = '';
        }
    });

    // Handle Start button — always meeting mode
    startBtn.addEventListener('click', () => {
        startBtn.disabled = true;
        startBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>&nbsp; Starting...';

        const prompt = meetingPrompt ? meetingPrompt.value.trim() : '';
        const useBot = useBotToggle ? useBotToggle.checked : false;
        const zoomUrl = zoomUrlInput ? zoomUrlInput.value.trim() : '';
        const botName = botNameInput ? botNameInput.value.trim() || 'Meeting Assistant' : 'Meeting Assistant';

        if (useBot && !zoomUrl) {
            alert('Please enter a Zoom Meeting Link');
            startBtn.disabled = false;
            startBtn.innerHTML = '<i class="fas fa-play"></i>&nbsp; Start Meeting';
            return;
        }

        if (window.electronAPI && window.electronAPI.startupComplete) {
            window.electronAPI.startupComplete({
                mode: 'meeting',
                referenceFiles: filePaths,
                meetingPrompt: prompt,
                useBot: useBot,
                zoomUrl: zoomUrl,
                botName: botName
            });
        }
    });
});
