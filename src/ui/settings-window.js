document.addEventListener('DOMContentLoaded', () => {
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const monitoringToggle = document.getElementById('continuousMonitoringToggle');
    const signOutButton = document.getElementById('signOutButton');

    const api = window.electronAPI;

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                if (api && api.quit) {
                    api.quit();
                }
                setTimeout(() => {
                    window.close();
                }, 500);
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Continuous Monitoring — this is the same Auto-watch feature the main
    // window's toolbar button controls (see unified-window.js), not a
    // separate setting. Reusing it here keeps a single source of truth for
    // whether monitoring is on, instead of two toggles that could disagree.
    if (monitoringToggle && api) {
        if (api.getScreenMonitorStatus) {
            api.getScreenMonitorStatus()
                .then((s) => { monitoringToggle.checked = !!(s && s.active); })
                .catch(() => {});
        }

        monitoringToggle.addEventListener('change', async () => {
            const desired = monitoringToggle.checked;
            if (!api.toggleScreenMonitor) return;
            try {
                const result = await api.toggleScreenMonitor();
                const active = !!(result && result.active);
                monitoringToggle.checked = active;
                if (result && result.error && active !== desired) {
                    // Admin has this feature disabled — revert and let the
                    // main window's own messaging explain why, rather than
                    // duplicating that copy here.
                    console.warn('[Settings] Could not toggle monitoring:', result.error);
                }
            } catch (e) {
                console.error('[Settings] Failed to toggle monitoring:', e);
                monitoringToggle.checked = !desired;
            }
        });
    }

    // Sign out of the admin panel account. Relaunches the app (see main.js's
    // account-sign-out handler) so it comes back up through the normal
    // sign-in gate, exactly like a fresh install would.
    if (signOutButton && api && api.signOutAccount) {
        signOutButton.addEventListener('click', () => {
            const confirmed = window.confirm(
                'Sign out of this account? The app will restart and ask you to sign in again.'
            );
            if (!confirmed) return;
            signOutButton.disabled = true;
            signOutButton.textContent = 'Signing out…';
            api.signOutAccount().catch((error) => {
                console.error('[Settings] Sign out failed:', error);
                signOutButton.disabled = false;
                signOutButton.textContent = 'Sign out of this account';
            });
        });
    }

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
});
