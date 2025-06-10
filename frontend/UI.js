import { Scrubber } from './Scrubber.js';

/**
 * @typedef {Object} UIEvents
 * @property {Function} onPlayPause - Called when play/pause is triggered
 * @property {Function} onSeek - Called with a time in seconds to seek to
 * @property {Function} onSeekRelative - Called with seconds to seek relative to current time
 */

export class UI {
    /**
     * @param {UIEvents} events - Event handlers for UI interactions
     */
    constructor(events) {
        if (!events) throw new Error('UI events object is required');
        this.events = events;
        
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
        this.setupMediaSessionHandlers();
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
        if (!duration) return;
        
        const currentTime = playhead * duration;
        const currentTimeFormatted = this.formatTime(currentTime);
        const durationFormatted = this.formatTime(duration);
        this.elements.timeDisplay.textContent = `${currentTimeFormatted} / ${durationFormatted}`;
        
        // Update scrubber position (playhead is already 0-1)
        this.elements.scrubberThumb.style.left = `${playhead * 100}%`;
    }

    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    // --- Media Session API ---
    setupMediaSessionHandlers(onPlayPause, onSeekBackward, onSeekForward, onSeekTo) {
        navigator.mediaSession.setActionHandler('play', onPlayPause);
        navigator.mediaSession.setActionHandler('pause', onPlayPause);
        navigator.mediaSession.setActionHandler('seekbackward', onSeekBackward);
        navigator.mediaSession.setActionHandler('seekforward', onSeekForward);
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            onSeekTo(details.seekTime);
        });
    }

    updateMediaSessionMetadata(title, artist, artwork) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title || 'CrossStream',
            artist: artist || 'CrossStream',
            artwork: artwork || []
        });
    }

    // --- Scrubber Management ---
    /**
     * Initializes the scrubber component with the provided configurations
     * @param {Object} localConfig - Local video configuration
     * @param {Object} remoteConfig - Remote video configuration
     */
    setupScrubber(localConfig, remoteConfig) {
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
            onSeek: (position) => {
                // Forward seek events to the player
                if (this.events?.onSeek) {
                    this.events.onSeek(position);
                }
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
     * @param {number} playhead - Current playback position in the unified timeline (0-1)
     * @param {number} duration - Total duration in seconds
     */
    updateScrubberTime(playhead, duration) {
        if (!this.scrubber) return;
        
        // Update time display
        if (this.elements.timeDisplay) {
            const currentTime = playhead * duration;
            this.elements.timeDisplay.textContent = 
                `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
        }
        
        // Update scrubber position (playhead is already 0-1)
        this.elements.scrubberThumb.style.left = `${playhead * 100}%`;
    }
    
    /**
     * Helper to format time in MM:SS format
     * @private
     */
    formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '0:00';
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // --- Event Listeners ---
    setupEventListeners() {
        const { playPauseBtn, rewindBtn, forwardBtn, scrubber } = this.elements;
        
        // Play/Pause
        playPauseBtn.addEventListener('click', () => {
            this.events.onPlayPause();
        });

        // Seek backward
        rewindBtn.addEventListener('click', () => {
            this.events.onSeekRelative(-10); // 10 seconds back
        });

        // Seek forward
        forwardBtn.addEventListener('click', () => {
            this.events.onSeekRelative(10); // 10 seconds forward
        });

        // Scrubber interaction
        scrubber.addEventListener('click', this.handleScrubberClick.bind(this));
        scrubber.addEventListener('mousemove', this.handleScrubberHover.bind(this));
    }

    handleScrubberClick(event) {
        const rect = this.elements.scrubber.getBoundingClientRect();
        const pos = (event.clientX - rect.left) / rect.width;
        this.events.onSeek(pos);
    }

    handleScrubberHover(event) {
        // Update hover preview if needed
        const rect = this.elements.scrubber.getBoundingClientRect();
        const pos = (event.clientX - rect.left) / rect.width;
        this.elements.scrubberThumb.style.left = `${pos * 100}%`;
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
        
        // Clean up event listeners
        const { playPauseBtn, rewindBtn, forwardBtn, scrubber } = this.elements;
        playPauseBtn.replaceWith(playPauseBtn.cloneNode(true));
        rewindBtn.replaceWith(rewindBtn.cloneNode(true));
        forwardBtn.replaceWith(forwardBtn.cloneNode(true));
        scrubber.replaceWith(scrubber.cloneNode(true));
    }
}
