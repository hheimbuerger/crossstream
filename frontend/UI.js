import { Scrubber } from './Scrubber.js';
import bus from './EventBus.js';

export class UI {
    // Constants
    static SEEK_STEP = 10; // seconds for forward/backward seek

    constructor() {
        // Initialize DOM elements
        this.elements = {
            localVideo: document.getElementById('local-video'),
            remoteVideo: document.getElementById('remote-video'),
            playPauseBtn: document.getElementById('playPauseButton'),
            rewindBtn: document.getElementById('rewindButton'),
            forwardBtn: document.getElementById('forwardButton'),
            timeDisplay: document.getElementById('timecode'),
            scrubber: document.getElementById('scrubber'),
            audioLocalBtn: document.getElementById('left-audio-activate'),
            audioRemoteBtn: document.getElementById('right-audio-activate'),
        };

        this.scrubber = null;
        this.isPlaying = false; // track current play state for event emission
        this.currentSyncState = 'paused'; // track sync state for hourglass mode detection
        this.setupEventListeners();
    }

    // --- Error and Loading States ---
    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;

        // Remove any existing error messages
        const existingError = document.querySelector('.error-message');
        if (existingError) existingError.remove();

        document.body.appendChild(errorDiv);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            errorDiv.remove();
        }, 5000);
    }

    showLoading(message) {
        this.hideLoading();

        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading-indicator';

        const spinner = document.createElement('div');
        spinner.className = 'loading-spinner';

        const text = document.createElement('div');
        text.textContent = message;

        loadingDiv.appendChild(spinner);
        loadingDiv.appendChild(text);
        loadingDiv.id = 'loading-indicator';

        document.body.appendChild(loadingDiv);
    }

    hideLoading() {
        const existingLoader = document.getElementById('loading-indicator');
        if (existingLoader) {
            existingLoader.remove();
        }
    }

    // --- UI Update Methods ---
    // NOTE: This method is now only used by sync state, not DVP state
    // The play button reflects cross-peer sync state, not local DVP state
    updatePlayPauseButton(isPlaying) {
        const btn = this.elements.playPauseBtn;
        this.isPlaying = isPlaying;
        btn.textContent = isPlaying ? '⏸️' : '▶️';
        btn.title = isPlaying ? 'Pause' : 'Play';
        btn.classList.remove('loading');
    }

    updateSyncState(syncState) {
        const btn = this.elements.playPauseBtn;
        if (!btn) return;

        // Track current sync state for hourglass mode detection
        this.currentSyncState = syncState.state;

        // Debug logging
        if (syncState.state) {
            const stateTitles = {
                'paused': '⏸️ Paused',
                'playing': '▶️ Playing',
                'buffering': '⏳ Buffering',
                'pendingPlay': '⏳ Waiting for peer...',
                'pendingSeek': '⏳ Seeking...'
            };
            // console.log(`[DVP State] ${stateTitles[syncState.state] || syncState.state}${syncState.playhead ? ` @${syncState.playhead.toFixed(2)}s` : ''}`);
        }

        switch (syncState.state) {
            case 'paused':
                btn.textContent = '▶️';
                btn.title = 'Play';
                btn.classList.remove('loading');
                this.isPlaying = false; // Fix: sync internal state
                this.hideRemoteReadinessIndicator();
                break;

            case 'playing':
                btn.textContent = '⏸️';
                btn.title = 'Pause';
                btn.classList.remove('loading');
                this.isPlaying = true; // Fix: sync internal state
                this.hideRemoteReadinessIndicator();
                break;

            case 'buffering':
            case 'pendingPlay':
            case 'pendingSeek':
                btn.textContent = '⏳';
                btn.title = this.getSyncStateTitle(syncState.state);
                btn.classList.add('loading');

                // Show remote readiness indicator for pendingPlay
                if (syncState.state === 'pendingPlay') {
                    this.showRemoteReadinessIndicator();
                } else {
                    this.hideRemoteReadinessIndicator();
                }
                break;
        }

        // Show buffering videos info if available
        if (syncState.bufferingVideos) {
            this.showBufferingInfo(syncState.bufferingVideos);
        }
    }

    getSyncStateTitle(state) {
        switch (state) {
            case 'buffering': return 'Buffering...';
            case 'pendingPlay': return 'Waiting for remote peer...';
            case 'pendingSeek': return 'Seeking...';
            default: return 'Loading...';
        }
    }

    showRemoteReadinessIndicator() {
        // Show subtle indicator that we're waiting for remote peer
        const indicator = document.getElementById('remote-readiness-indicator');
        if (indicator) {
            indicator.style.display = 'block';
            indicator.textContent = 'Waiting for peer...';
        }
    }

    hideRemoteReadinessIndicator() {
        const indicator = document.getElementById('remote-readiness-indicator');
        if (indicator) {
            indicator.style.display = 'none';
        }
    }

    showBufferingInfo(bufferingVideos) {
        // Show which videos are buffering (for debugging/info)
        // console.log(`[DVP] Buffering: ${bufferingVideos.join(', ')} video(s)`);
    }

    updateTimeDisplay(playhead, duration) {
        // console.log('updateTimeDisplay', playhead, duration);
        const currentTimeFormatted = this.formatTime(playhead);
        const durationFormatted = this.formatTime(duration);
        this.elements.timeDisplay.textContent = `${currentTimeFormatted} / ${durationFormatted}`;
    }

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    /**
     * Pulse a UI element with a bluish aura for 0.5s
     * @param {string} elementId - DOM id of the element to pulse
     */
    pulse(elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.classList.add('pulse-remote');
        setTimeout(() => {
            el.classList.remove('pulse-remote');
        }, 500);
    }

    // --- Scrubber Management ---
    /**
     * Initializes the scrubber component with the provided configurations
     * @param {Object} localConfig - Local video configuration
     * @param {Object} remoteConfig - Remote video configuration
     * @param {number} totalDuration - Total duration of the video
     */
    setupScrubber(localConfig, remoteConfig, totalDuration) {
        // Clean up existing scrubber if any
        if (this.scrubber) {
            this.scrubber.destroy();
        }

        // Initialize scrubber
        this.scrubber = new Scrubber(
            this.elements.scrubber,
            localConfig,
            remoteConfig
        );

        return this.scrubber;
    }

    // --- Event Listeners ---
    setupEventListeners() {
        const { playPauseBtn, rewindBtn, forwardBtn, scrubber, audioLocalBtn, audioRemoteBtn, audioMuteBtn } = this.elements;

        // Play / Pause toggle emits dedicated events
        playPauseBtn.addEventListener('click', () => {
            // If in hourglass mode (buffering/waiting states), force pause to abort the operation
            const isHourglassMode = ['buffering', 'pendingPlay', 'pendingSeek'].includes(this.currentSyncState);
            
            if (isHourglassMode) {
                console.log(`[UI] Hourglass mode detected (${this.currentSyncState}), forcing pause`);
                bus.emit('localPause');
            } else if (this.isPlaying) {
                bus.emit('localPause');
            } else {
                bus.emit('localPlay');
            }
        });

        // Seek backward
        rewindBtn.addEventListener('click', () => {
            bus.emit('localSeekRelative', -UI.SEEK_STEP);
        });

        // Seek forward
        forwardBtn.addEventListener('click', () => {
            bus.emit('localSeekRelative', UI.SEEK_STEP);
        });

        // Audio source toggles
        audioLocalBtn?.addEventListener('click', () => {
            // If already active, mute
            if (audioLocalBtn.classList.contains('active')) {
                bus.emit('localAudioChange', 'none');
                this.#updateAudioButtons('none');
            } else {
                bus.emit('localAudioChange', 'local');
                this.#updateAudioButtons('local');
            }
        });

        audioRemoteBtn?.addEventListener('click', () => {
            // If already active, mute
            if (audioRemoteBtn.classList.contains('active')) {
                bus.emit('localAudioChange', 'none');
                this.#updateAudioButtons('none');
            } else {
                bus.emit('localAudioChange', 'remote');
                this.#updateAudioButtons('remote');
            }
        });

        // Listen for players initialized event
        bus.on('playersInitialized', ({ playhead, duration, localConfig, remoteConfig }) => {
            this.setupScrubber(localConfig, remoteConfig, duration);
            this.updateTimeDisplay(playhead, duration);
        });

        // Listen for UI pulse events (remote)
        bus.on('uiPulse', ({ elementId }) => {
            this.pulse(elementId);
        });

        // Reflect state changes coming from DVP (data only, not control state)
        bus.on('stateChange', (state) => {
            // console.log('[DVP]', state.state);
            this.#updateAudioButtons(state.audioSource);
            // NOTE: Play button state is controlled by syncStateChanged, not DVP state
            this.updateTimeDisplay(state.playhead, state.duration);
            if (this.scrubber)   // this actually requires a check because it might be emitted as part of the initial seek, in parallel to scrubber initialization
                this.scrubber.updatePlayhead(state.playhead);
        });

        // Handle synchronization state changes
        bus.on('syncStateChanged', (syncState) => {
            console.log('[SyncState]', syncState.state);
            this.updateSyncState(syncState);
        });

        // Handle time updates during playback
        bus.on('timeUpdate', ({playhead, duration}) => {
            this.updateTimeDisplay(playhead, duration);
            if (this.scrubber)
                this.scrubber.updatePlayhead(playhead);
        });

        // Handle remote audio changes to ensure UI stays in sync
        bus.on('remoteAudioChange', (command) => {
            if (command.track) {
                // Map remote track to local audio source
                const audioSource = command.track === 'local' ? 'remote' :
                                  command.track === 'remote' ? 'local' : 'none';
                this.#updateAudioButtons(audioSource);
            }
        });
    }

    // --- Private Helpers ---
    #updateAudioButtons(active) {
        const { audioLocalBtn, audioRemoteBtn } = this.elements;
        const btns = [audioLocalBtn, audioRemoteBtn];
        btns.forEach(btn => btn.classList.remove('active'));

        if (active === 'local') {
            audioLocalBtn.classList.add('active');
        } else if (active === 'remote') {
            audioRemoteBtn.classList.add('active');
        }
    }

    // --- Cleanup ---
    cleanup() {
        this.hideLoading();

        // Clean up scrubber
        if (this.scrubber) {
            this.scrubber.destroy();
            this.scrubber = null;
        }

        // Clean up error messages
        const errorMessages = document.querySelectorAll('.error-message');
        errorMessages.forEach(el => el.remove());

        // Clean up event listeners by cloning nodes
        const { playPauseBtn, rewindBtn, forwardBtn, scrubber } = this.elements;
        playPauseBtn.replaceWith(playPauseBtn.cloneNode(true));
        rewindBtn.replaceWith(rewindBtn.cloneNode(true));
        forwardBtn.replaceWith(forwardBtn.cloneNode(true));
        scrubber.replaceWith(scrubber.cloneNode(true));
    }
}
