// VideoPlayer.js - Handles local video playback and UI
export class VideoPlayer {
    /**
     * Creates a new VideoPlayer instance
     * @param {Object} config - Configuration object containing stream and UI element IDs
     * @param {boolean} isHost - Whether this player is the host
     */
    constructor(config, isHost) {
        // DOM Elements
        this.lv = document.getElementById('left-video');
        this.rv = document.getElementById('right-video');
        this.playPauseButton = document.getElementById('playPauseButton');
        this.timecodeElement = document.getElementById('timecode');
        this.playheadMarker = document.getElementById('playhead-marker');
        
        // Initialize videos as muted for autoplay
        if (this.lv) this.lv.muted = true;
        if (this.rv) this.rv.muted = true;
        
        // State
        this.config = config;
        this.isHost = isHost;
        this.isPlaying = false;
        this.audioChannel = 'all';
        this.currentTime = 0;
        
        // Initialize
        this.#setupPlayers();
        this.#setupEventListeners();
    }

    // Private methods
    #setupPlayers() {
        try {
            if (!this.config || typeof this.config !== 'object') {
                throw new Error('Invalid configuration: config is not an object');
            }
            
            const streamUrl = this.config.stream;
            if (!streamUrl) {
                throw new Error('No stream URL provided in configuration');
            }
            
            // Initialize the first video (host or client)
            const videoElementId = this.isHost ? 'left-video' : 'right-video';
            console.log(`Initializing ${videoElementId} with stream:`, streamUrl);
            this.loadVideo(videoElementId, streamUrl);
        } catch (error) {
            console.error('Error setting up players:', error);
            throw error; // Re-throw to be handled by the caller
        }
    }

    #setupEventListeners() {
        // Play/Pause button
        this.playPauseButton?.addEventListener('click', () => this.togglePlayPause());
        
        // Scrubber click
        document.querySelector('.scrubber')?.addEventListener('click', (e) => {
            const x = e.offsetX;
            const thumbnailIndex = x / this.config.thumbnailPixelWidth;
            this.seek(thumbnailIndex * this.config.thumbnailSeconds);
        });
    }

    // Playback control methods
    play() {
        const playPromises = [];
        
        if (this.audioChannel === 'left' || this.audioChannel === 'all') {
            playPromises.push(this.lv.play());
        }
        if (this.audioChannel === 'right' || this.audioChannel === 'all') {
            playPromises.push(this.rv.play());
        }
        
        Promise.all(playPromises)
            .then(() => {
                this.isPlaying = true;
                this.playPauseButton.textContent = '⏸';
            })
            .catch(error => console.error('Error during playback:', error));
    }
    
    pause() {
        this.lv.pause();
        this.rv.pause();
        this.isPlaying = false;
        this.playPauseButton.textContent = '▶';
    }
    
    togglePlayPause() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }
    
    seek(time, relative = false) {
        const targetTime = relative ? this.currentTime + time : time;
        this.currentTime = targetTime;
        
        if (this.audioChannel === 'left' || this.audioChannel === 'all') {
            this.lv.currentTime = targetTime;
        }
        if (this.audioChannel === 'right' || this.audioChannel === 'all') {
            this.rv.currentTime = targetTime;
        }
        
        this.updateTimecode();
    }
    
    switchAudio(channel) {
        this.audioChannel = channel;
        
        // Update audio volumes
        this.lv.volume = (channel === 'left' || channel === 'all') ? 1 : 0;
        this.rv.volume = (channel === 'right' || channel === 'all') ? 1 : 0;
        
        // Update UI
        document.querySelectorAll('.speaker-button').forEach(btn => {
            btn.classList.remove('active');
        });
        if (document.getElementById(`${channel}-audio-activate`)) {
            document.getElementById(`${channel}-audio-activate`).classList.add('active');
        }
    }
    
    updateTimecode() {
        if (!this.timecodeElement) return;
        
        const formatTime = (seconds) => {
            const date = new Date(seconds * 1000);
            return date.toISOString().substr(11, 8);
        };
        
        this.timecodeElement.textContent = formatTime(this.currentTime);
    }

    // Cleanup method to release resources
    destroy() {
        // Clean up HLS instances
        if (this.lvHls) {
            this.lvHls.destroy();
        }
        if (this.rvHls) {
            this.rvHls.destroy();
        }
        
        // Pause videos
        this.lv?.pause();
        this.rv?.pause();
        
        // Remove event listeners
        this.playPauseButton?.removeEventListener('click', this.togglePlayPause);
        const scrubber = document.querySelector('.scrubber');
        if (scrubber) {
            scrubber.removeEventListener('click', this.handleScrubberClick);
        }
    }

    // Public methods
    loadVideo(playerId, streamURL) {
        const videoElement = document.getElementById(playerId);
        if (!videoElement) {
            console.error(`Video element with ID ${playerId} not found`);
            return;
        }

        // Reset video element
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();

        if (Hls.isSupported()) {
            // For HLS streams
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 90
            });

            hls.loadSource(streamURL);
            hls.attachMedia(videoElement);
            
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                console.log('HLS manifest parsed, video ready');
                // Don't autoplay, keep video paused
                videoElement.pause();
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.error('Fatal network error, trying to recover...');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.error('Fatal media error, recovering...');
                            hls.recoverMediaError();
                            break;
                        default:
                            console.error('Fatal error, cannot recover');
                            hls.destroy();
                            break;
                    }
                }
            });

            // Store HLS instance for cleanup
            this[`${playerId}Hls`] = hls;
        } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
            // For Safari's native HLS support
            videoElement.src = streamURL;
            videoElement.addEventListener('loadedmetadata', () => {
                // Keep video paused on load
                videoElement.pause();
            });
        } else {
            console.error('HLS is not supported in this browser');
            return;
        }

        return videoElement;
    }

    play() {
        this.isPlaying = true;
        [this.lv, this.rv].forEach(v => v && !v.paused || v.play().catch(console.error));
        this.#updateUI();
    }

    pause() {
        this.isPlaying = false;
        [this.lv, this.rv].forEach(v => v && v.pause());
        this.#updateUI();
    }

    togglePlayPause() {
        this.isPlaying ? this.pause() : this.play();
    }

    seek(time) {
        this.currentTime = Math.max(0, Math.min(time, this.duration || Infinity));
        [this.lv, this.rv].forEach(v => {
            if (v) v.currentTime = this.currentTime;
        });
        this.#updateUI();
    }

    switchAudio(channel) {
        this.audioChannel = channel;
        if (this.lv) this.lv.muted = (channel === 'right');
        if (this.rv) this.rv.muted = (channel === 'left');
        this.#updateUI();
    }

    // UI Updates
    #updateUI() {
        // Update timecode
        if (this.timecodeElement) {
            const minutes = Math.floor(this.currentTime / 60);
            const seconds = Math.floor(this.currentTime % 60);
            const tenths = Math.floor((this.currentTime % 1) * 10);
            this.timecodeElement.textContent = 
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${tenths}`;
        }

        // Update play/pause button
        if (this.playPauseButton) {
            this.playPauseButton.innerHTML = this.isPlaying ? '⏸' : '▶';
        }

        // Update playhead position
        if (this.playheadMarker) {
            const pixelOffset = (this.currentTime / this.config.thumbnailSeconds) * this.config.thumbnailPixelWidth;
            this.playheadMarker.style.left = `${pixelOffset}px`;
        }
    }

    // Getters
    get duration() {
        return Math.max(
            this.lv?.duration || 0,
            this.rv?.duration || 0
        );
    }

    get state() {
        return {
            isPlaying: this.isPlaying,
            currentTime: this.currentTime,
            audioChannel: this.audioChannel
        };
    }

    set state({ isPlaying, currentTime, audioChannel }) {
        if (isPlaying !== undefined) this.isPlaying = isPlaying;
        if (currentTime !== undefined) this.currentTime = currentTime;
        if (audioChannel !== undefined) this.audioChannel = audioChannel;
        
        // Apply state
        if (this.isPlaying) this.play();
        else this.pause();
        
        this.seek(this.currentTime);
        this.switchAudio(this.audioChannel);
    }
}

// Export for ES modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = VideoPlayer;
}
