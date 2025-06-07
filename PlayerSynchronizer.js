// PlayerSynchronizer.js - Handles synchronization between local video players
export class PlayerSynchronizer {
    /**
     * Creates a new PlayerSynchronizer instance
     * @param {VideoPlayer} videoPlayer - The VideoPlayer instance to synchronize
     * @param {Object} config - Configuration object
     */
    constructor(videoPlayer, config) {
        this.videoPlayer = videoPlayer;
        this.config = config;
        this.rightToLeftOffset = 0.0;
        this.leadPlayer = null;
        this.syncInterval = null;
        this.syncThreshold = 1.0; // seconds
    }

    /**
     * Sets the time offset between right and left videos
     * @param {number} offset - Time offset in seconds
     */
    setRightToLeftOffset(offset) {
        this.rightToLeftOffset = offset;
        this.#updateScrubberUI();
    }

    /**
     * Starts the synchronization process
     * @param {number} interval - Sync interval in milliseconds
     */
    startSync(interval = 100) {
        if (this.syncInterval) return;
        
        this.syncInterval = setInterval(() => this.#sync(), interval);
    }

    /**
     * Stops the synchronization process
     */
    stopSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }

    /**
     * Gets the current synchronization state
     * @returns {Object} Current sync state
     */
    getSyncState() {
        return {
            ...this.videoPlayer.state,
            rightToLeftOffset: this.rightToLeftOffset
        };
    }

    /**
     * Applies a new sync state
     * @param {Object} state - The state to apply
     */
    applySyncState(state) {
        if (state.currentTime !== undefined) {
            // Adjust time based on which video is leading
            const adjustedTime = this.videoPlayer.isHost 
                ? state.currentTime 
                : state.currentTime + this.rightToLeftOffset;
            
            this.videoPlayer.state = {
                ...state,
                currentTime: adjustedTime
            };
        } else {
            this.videoPlayer.state = state;
        }
    }

    // Private methods
    #sync() {
        const leftTime = this.videoPlayer.lv?.currentTime || 0;
        const rightTime = this.videoPlayer.rv?.currentTime || 0;
        
        // If we don't have both videos, nothing to sync
        if (!this.videoPlayer.lv || !this.videoPlayer.rv) {
            this.videoPlayer.currentTime = leftTime || rightTime;
            return;
        }

        // Determine which player is leading
        const timeDiff = leftTime - (rightTime + this.rightToLeftOffset);
        
        // Only adjust if difference is significant
        if (Math.abs(timeDiff) > this.syncThreshold) {
            if (Math.abs(timeDiff) > this.syncThreshold * 2) {
                // Large difference, jump directly
                if (this.leadPlayer === 'left') {
                    this.videoPlayer.rv.currentTime = leftTime - this.rightToLeftOffset;
                } else {
                    this.videoPlayer.lv.currentTime = rightTime + this.rightToLeftOffset;
                }
            } else {
                // Small difference, adjust gradually
                if (this.leadPlayer === 'left') {
                    this.videoPlayer.rv.playbackRate = timeDiff > 0 ? 1.01 : 0.99;
                } else {
                    this.videoPlayer.lv.playbackRate = timeDiff < 0 ? 1.01 : 0.99;
                }
                
                // Reset playback rate after a short delay
                setTimeout(() => {
                    if (this.videoPlayer.rv) this.videoPlayer.rv.playbackRate = 1.0;
                    if (this.videoPlayer.lv) this.videoPlayer.lv.playbackRate = 1.0;
                }, 100);
            }
        }
        
        // Update current time (average of both players)
        this.videoPlayer.currentTime = (leftTime + (rightTime + this.rightToLeftOffset)) / 2;
    }

    #updateScrubberUI() {
        const scrubberLeft = document.getElementById('scrubber-left');
        const scrubberRight = document.getElementById('scrubber-right');
        
        if (!scrubberLeft || !scrubberRight) return;
        
        const offsetThumbnails = Math.ceil(this.rightToLeftOffset / this.config.thumbnailSeconds);
        
        // Update left scrubber
        scrubberLeft.src = this.videoPlayer.isHost 
            ? this.config.thumbnailSprite 
            : this.config.remoteThumbnailSprite;
            
        scrubberLeft.style.setProperty('padding-left', `calc(${Math.max(0, -offsetThumbnails)} * ${this.config.thumbnailPixelWidth}px)`);
        scrubberLeft.style.setProperty('padding-right', `calc(${Math.max(0, +offsetThumbnails)} * ${this.config.thumbnailPixelWidth}px)`);
        
        // Update right scrubber
        scrubberRight.src = this.videoPlayer.isHost 
            ? this.config.remoteThumbnailSprite 
            : this.config.thumbnailSprite;
            
        scrubberRight.style.setProperty('padding-left', `calc(${Math.max(0, +offsetThumbnails)} * ${this.config.thumbnailPixelWidth}px)`);
        scrubberRight.style.setProperty('padding-right', `calc(${Math.max(0, -offsetThumbnails)} * ${this.config.thumbnailPixelWidth}px)`);
    }
}

// Export for ES modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlayerSynchronizer;
}
