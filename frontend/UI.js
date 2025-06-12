import { Scrubber } from './Scrubber.js';
import bus from './EventBus.js';

export class UI {
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
            scrubberThumb: document.getElementById('playhead-marker'),
            leftScrubber: document.getElementById('scrubber-left'),
            rightScrubber: document.getElementById('scrubber-right')
        };
        
        this.scrubber = null;
        this.setupEventListeners();
    }

    // --- Error and Loading States ---
    showError(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        
        // Remove any existing error messages
        const existingError = document.querySelector('.error-message');
        existingError.remove();
        
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
    updatePlayPauseButton(isPlaying) {
        this.elements.playPauseBtn.textContent = isPlaying ? '⏸' : '▶';
    }

    updateTimeDisplay(playhead, duration) {
        if (!Number.isFinite(duration) || duration <= 0) return;

        const currentTimeFormatted = this.formatTime(playhead);
        const durationFormatted = this.formatTime(duration);
        this.elements.timeDisplay.textContent = `${currentTimeFormatted} / ${durationFormatted}`;

        const ratio = playhead / duration;
        this.elements.scrubberThumb.style.left = `${ratio * 100}%`;
    }

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
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
            this.scrubber.cleanup();
        }

        // Calculate timeline offsets in seconds
        const localStartTime = localConfig?.timestamp ? new Date(localConfig.timestamp).getTime() : 0;
        const remoteStartTime = remoteConfig?.timestamp ? new Date(remoteConfig.timestamp).getTime() : 0;
        
        // Calculate the time difference between the two videos in seconds
        const timeDiffMs = remoteStartTime - localStartTime;
        const timeDiffSec = timeDiffMs / 1000;
        
        // Calculate the offset in thumbnail units (number of thumbnails to shift)
        const thumbnailSeconds = localConfig?.thumbnailSeconds || remoteConfig?.thumbnailSeconds || 5.0;
        const offsetThumbnails = timeDiffSec / thumbnailSeconds;
        
        // Local video is always the reference (offset 0), remote video is offset by the time difference
        const localOffset = 0;  // Local video is the reference
        const remoteOffset = offsetThumbnails;  // Remote video is offset by the time difference in thumbnail units

        // Create new scrubber instance with options
        this.scrubber = new Scrubber(this.elements, {
            duration: totalDuration,
            onSeek: (playheadSeconds) => {
                bus.emit('seek', playheadSeconds);
            },
            seekDelay: 50, // Debounce seek events during drag for better performance
            localOffset: -localOffset, // Negative because we want to shift the thumbnail left
            remoteOffset: -remoteOffset // Negative because we want to shift the thumbnail left
        });
        
        // Set initial thumbnails if available
        if (localConfig?.thumbnailSprite || remoteConfig?.thumbnailSprite) {
            // Use the thumbnail pixel width from the config (should be present in both local and remote configs)
            const thumbnailPixelWidth = localConfig?.thumbnailPixelWidth || remoteConfig?.thumbnailPixelWidth || 160;
            
            this.scrubber.updateThumbnails(
                localConfig?.thumbnailSprite || '',
                remoteConfig?.thumbnailSprite || '',
                offsetThumbnails,
                thumbnailPixelWidth
            );
        }
        
        return this.scrubber;
    }
    
    /**
     * Updates the scrubber's time display
     * @param {number} playhead - Current playback position in seconds
     * @param {number} duration - Total duration in seconds
     */
    updateScrubberTime(playhead, duration) {
        if (!this.scrubber || duration <= 0) return;

        // Inform scrubber of new time
        this.scrubber.updateTime(playhead);
    }
    
    // --- Event Listeners ---
    setupEventListeners() {
        const { playPauseBtn, rewindBtn, forwardBtn, scrubber } = this.elements;
        
        // Play/Pause
        playPauseBtn.addEventListener('click', () => {
            bus.emit('playPause');
        });

        // Seek backward
        rewindBtn.addEventListener('click', () => {
            bus.emit('seekRelative', -10); // 10 seconds back
        });

        // Seek forward
        forwardBtn.addEventListener('click', () => {
            bus.emit('seekRelative', 10); // 10 seconds forward
        });

        // Scrubber hover delegation (thumb highlight only)
        scrubber.addEventListener('mousemove', (e) => {
            if (this.scrubber) {
                this.scrubber.handleHover(e.clientX);
            }
        });

        // Click -> seek
        scrubber.addEventListener('click', (e) => {
            if (this.scrubber) {
                this.scrubber.handleScrubberClick(e);
            }
        });
    
        // Listen for players initialized event
        bus.on('playersInitialized', ({ playhead, duration, localConfig, remoteConfig }) => {
            if (!this.scrubber && duration > 0) {
                // Initialize scrubber with the known duration
                this.setupScrubber(localConfig, remoteConfig, duration);
                this.updateTimeDisplay(playhead, duration);
            }
        });
    }

    // --- Cleanup ---
    cleanup() {
        this.hideLoading();
        
        // Clean up scrubber
        if (this.scrubber) {
            this.scrubber.cleanup();
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
