/**
 * Scrubber component for video synchronization
 */

import bus from './EventBus.js';

export class Scrubber {
    /**
     * Creates a new Scrubber instance
     * @param {HTMLElement} domElement - Required DOM element
     * @param {Object} localConfig - Full local video config object
     * @param {Object} remoteConfig - Full remote video config object
     */
    constructor(domElement, localConfig, remoteConfig) {
        this.container = domElement;

        // Store config data
        this.localConfig = localConfig;
        this.remoteConfig = remoteConfig;
        
        // Calculate timeline properties
        this.thumbnailSeconds = localConfig.thumbnailSeconds;
        
        // Store thumbnail dimensions for both configs
        this.localThumbnailWidth = localConfig.thumbnailPixelWidth;
        this.localThumbnailHeight = localConfig.thumbnailPixelHeight;
        this.remoteThumbnailWidth = remoteConfig.thumbnailPixelWidth;
        this.remoteThumbnailHeight = remoteConfig.thumbnailPixelHeight;
        
        // Calculate video offsets based on timestamps
        this.calculateVideoOffsets();
        
        // Current state
        this.currentPlayhead = 0; // in seconds
        this.duration = Math.max(localConfig.duration, remoteConfig.duration);
        
        // DOM elements (will be created)
        this.scrubberElement = null;
        this.trackElement = null;
        this.playedElement = null;
        this.thumbElement = null;
        this.localThumbnail = null;
        this.remoteThumbnail = null;
        this.markers = [];
        this.markerLabel = null;
        
        this.initialize();
    }
    
    /**
     * Calculates the time offsets between local and remote videos
     * @private
     */
    calculateVideoOffsets() {
        // Parse timestamps
        const localStartTime = new Date(this.localConfig.timestamp);
        const remoteStartTime = new Date(this.remoteConfig.timestamp);
        
        // Calculate unified timeline start (earliest video)
        const timelineStart = Math.min(localStartTime.getTime(), remoteStartTime.getTime());
        
        // Calculate offsets in seconds from timeline start
        this.localOffsetSeconds = (localStartTime.getTime() - timelineStart) / 1000;
        this.remoteOffsetSeconds = (remoteStartTime.getTime() - timelineStart) / 1000;
        
        console.log('Video offsets calculated:', {
            localOffset: this.localOffsetSeconds,
            remoteOffset: this.remoteOffsetSeconds
        });
    }
    
    /**
     * Initializes the scrubber and sets up event listeners
     * @private
     */
    initialize() {
        this.createDOM();
        this.setupEventListeners();
        this.setupBusListeners();
    }
    
    /**
     * Creates the DOM structure for the scrubber
     * @private
     */
    createDOM() {
        // Use the container directly as the scrubber element
        this.scrubberElement = this.container;
        this.scrubberElement.className = 'scrubber';
        
        // Track (the line)
        this.trackElement = document.createElement('div');
        this.trackElement.className = 'scrubber-track';
        
        // Played portion (left of playhead)
        this.playedElement = document.createElement('div');
        this.playedElement.className = 'scrubber-played';
        
        // Playhead/thumb
        this.thumbElement = document.createElement('div');
        this.thumbElement.className = 'scrubber-thumb';
        
        // Thumbnail previews (initially hidden)
        this.localThumbnail = document.createElement('div');
        this.localThumbnail.className = 'scrubber-thumbnail scrubber-thumbnail-local';
        this.localThumbnail.style.width = this.localThumbnailWidth + 'px';
        this.localThumbnail.style.height = this.localThumbnailHeight + 'px';
        
        this.remoteThumbnail = document.createElement('div');
        this.remoteThumbnail.className = 'scrubber-thumbnail scrubber-thumbnail-remote';
        this.remoteThumbnail.style.width = this.remoteThumbnailWidth + 'px';
        this.remoteThumbnail.style.height = this.remoteThumbnailHeight + 'px';
        
        // Create markers
        this.createMarkers();
        
        // Create marker label (initially hidden)
        this.markerLabel = document.createElement('div');
        this.markerLabel.className = 'scrubber-marker-label';
        this.markerLabel.style.display = 'none';
        
        // Assemble DOM
        this.trackElement.appendChild(this.playedElement);
        this.scrubberElement.appendChild(this.trackElement);
        this.scrubberElement.appendChild(this.thumbElement);
        this.scrubberElement.appendChild(this.localThumbnail);
        this.scrubberElement.appendChild(this.remoteThumbnail);
        this.scrubberElement.appendChild(this.markerLabel);
    }
    
    /**
     * Creates timeline markers
     * @private
     */
    createMarkers() {
        const allChapters = [...this.localConfig.chapters, ...this.remoteConfig.chapters];
        allChapters.sort((a, b) => a - b).forEach((timeInSeconds, index) => {
            const marker = document.createElement('div');
            marker.className = 'scrubber-marker';
            marker.dataset.time = timeInSeconds;
            marker.dataset.label = this.formatTime(timeInSeconds);
            
            // Position marker based on timeline
            if (this.duration > 0) {
                const percentage = (timeInSeconds / this.duration) * 100;
                marker.style.left = percentage + '%';
            }
            
            this.markers.push(marker);
            this.scrubberElement.appendChild(marker);
        });
    }
    
    /**
     * Formats time in seconds to MM:SS format
     * @param {number} seconds - Time in seconds
     * @returns {string} Formatted time string
     * @private
     */
    formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
    
    /**
     * Sets up DOM event listeners
     * @private
     */
    setupEventListeners() {
        // Click to seek
        this.scrubberElement.addEventListener('click', (e) => this.handleClick(e));
        
        // Hover for thumbnails
        this.scrubberElement.addEventListener('mouseenter', (e) => this.handleMouseEnter(e));
        this.scrubberElement.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.scrubberElement.addEventListener('mouseleave', (e) => this.handleMouseLeave(e));
    }
    
    /**
     * Sets up EventBus listeners
     * @private
     */
    setupBusListeners() {
        // Listen for timeline updates
        bus.on('timeUpdate', (playhead, duration) => {
            this.updatePlayhead(playhead);
            if (duration && duration !== this.duration) {
                this.duration = duration;
            }
        });
        
        // Listen for state changes
        bus.on('stateChange', ({ playhead, duration }) => {
            if (playhead !== undefined) {
                this.updatePlayhead(playhead);
            }
            if (duration && duration !== this.duration) {
                this.duration = duration;
            }
        });
    }
    
    /**
     * Handles click on the scrubber to seek to a specific position
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    handleClick(e) {
        if (!this.duration) return;
        
        const rect = this.scrubberElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const seekTime = percentage * this.duration;
        
        // Emit pause first, then seek (as per architecture)
        bus.emit('localPause');
        bus.emit('localSeek', Math.max(0, Math.min(seekTime, this.duration)));
    }
    
    /**
     * Handles mouse enter for thumbnail display
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    handleMouseEnter(e) {
        this.showThumbnails();
    }
    
    /**
     * Handles mouse move for thumbnail positioning
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    handleMouseMove(e) {
        this.updateThumbnailPosition(e);
        this.updateMarkerLabels(e);
    }
    
    /**
     * Handles mouse leave to hide thumbnails
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    handleMouseLeave(e) {
        this.hideThumbnails();
        this.markerLabel.style.display = 'none';
    }
    
    /**
     * Shows the thumbnail previews
     * @private
     */
    showThumbnails() {
        this.localThumbnail.style.display = 'block';
        this.remoteThumbnail.style.display = 'block';
    }
    
    /**
     * Hides the thumbnail previews
     * @private
     */
    hideThumbnails() {
        this.localThumbnail.style.display = 'none';
        this.remoteThumbnail.style.display = 'none';
    }
    
    /**
     * Updates thumbnail position and content based on mouse position
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    updateThumbnailPosition(e) {
        if (!this.duration) return;
        
        const rect = this.scrubberElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const hoverTime = percentage * this.duration;
        
        // Calculate thumbnail indices for each video, accounting for offsets
        const localVideoTime = hoverTime - this.localOffsetSeconds;
        const remoteVideoTime = hoverTime - this.remoteOffsetSeconds;
        
        // Calculate maximum thumbnail indices based on video durations
        const localMaxThumbnailIndex = Math.floor((this.localConfig.duration) / this.thumbnailSeconds);
        const remoteMaxThumbnailIndex = Math.floor((this.remoteConfig.duration) / this.thumbnailSeconds);
        
        // Calculate thumbnail indices with edge case handling
        let localThumbnailIndex, localIsOutOfRange;
        if (localVideoTime < 0) {
            // Before video starts - show first thumbnail grayed
            localThumbnailIndex = 0;
            localIsOutOfRange = true;
        } else if (localVideoTime >= (this.localConfig.duration)) {
            // After video ends - show last thumbnail grayed
            localThumbnailIndex = Math.max(0, localMaxThumbnailIndex - 1);
            localIsOutOfRange = true;
        } else {
            // Within video range - show normal thumbnail
            localThumbnailIndex = Math.floor(localVideoTime / this.thumbnailSeconds);
            localIsOutOfRange = false;
        }
        
        let remoteThumbnailIndex, remoteIsOutOfRange;
        if (remoteVideoTime < 0) {
            // Before video starts - show first thumbnail grayed
            remoteThumbnailIndex = 0;
            remoteIsOutOfRange = true;
        } else if (remoteVideoTime >= (this.remoteConfig.duration)) {
            // After video ends - show last thumbnail grayed
            remoteThumbnailIndex = Math.max(0, remoteMaxThumbnailIndex - 1);
            remoteIsOutOfRange = true;
        } else {
            // Within video range - show normal thumbnail
            remoteThumbnailIndex = Math.floor(remoteVideoTime / this.thumbnailSeconds);
            remoteIsOutOfRange = false;
        }
        
        // Position thumbnails vertically locked to scrubber
        const hoverX = e.clientX;
        const scrubberY = rect.top;
        
        // Calculate base positions (diagonal from hover point)
        let localX = hoverX - 10;
        let remoteX = hoverX + 10;
        
        // Prevent viewport overflow on both sides
        const viewportMargin = 25; // Minimum distance from viewport edge
        const localThumbnailWidth = this.localThumbnailWidth;
        const remoteThumbnailWidth = this.remoteThumbnailWidth;
        
        // Calculate actual thumbnail edges (accounting for transform: translateX(-100%) for local)
        const localLeftEdge = localX - localThumbnailWidth; // Local uses translateX(-100%)

        // Check for left viewport overflow
        if (localLeftEdge < viewportMargin) {
            // Push both thumbnails inward
            const pushAmount = viewportMargin - localLeftEdge;
            localX += pushAmount;
            remoteX += pushAmount;
        }
        
        // Check for right viewport overflow (after potential left adjustment)
        const adjustedRemoteRightEdge = remoteX + remoteThumbnailWidth;
        const viewportWidth = window.innerWidth;
        if (adjustedRemoteRightEdge > viewportWidth - viewportMargin) {
            // Push both thumbnails leftward
            const pushAmount = adjustedRemoteRightEdge - (viewportWidth - viewportMargin);
            localX -= pushAmount;
            remoteX -= pushAmount;
        }
        
        // Position thumbnails
        this.localThumbnail.style.left = localX + 'px';
        this.localThumbnail.style.top = (scrubberY - this.localThumbnailHeight) + 'px';
        
        this.remoteThumbnail.style.left = remoteX + 'px';
        this.remoteThumbnail.style.top = (scrubberY - this.remoteThumbnailHeight) + 'px';
        
        // Update thumbnail sprites with edge case handling
        this.updateThumbnailSprite(this.localThumbnail, this.localConfig.thumbnailSprite, localThumbnailIndex, this.localThumbnailWidth);
        this.localThumbnail.style.opacity = localIsOutOfRange ? '0.3' : '1';
        
        this.updateThumbnailSprite(this.remoteThumbnail, this.remoteConfig.thumbnailSprite, remoteThumbnailIndex, this.remoteThumbnailWidth);
        this.remoteThumbnail.style.opacity = remoteIsOutOfRange ? '0.3' : '1';
    }
    
    /**
     * Updates marker labels based on mouse position (magnetic hover)
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    updateMarkerLabels(e) {
        if (!this.duration) return;
        
        const rect = this.scrubberElement.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const magneticRange = 20; // pixels
        
        let closestMarker = null;
        let closestDistance = Infinity;
        
        // Find the closest marker within magnetic range
        this.markers.forEach(marker => {
            const markerRect = marker.getBoundingClientRect();
            const markerX = markerRect.left + markerRect.width / 2 - rect.left;
            const distance = Math.abs(mouseX - markerX);
            
            if (distance < magneticRange && distance < closestDistance) {
                closestMarker = marker;
                closestDistance = distance;
            }
        });
        
        if (closestMarker) {
            // Show label for closest marker
            this.markerLabel.textContent = closestMarker.dataset.label;
            this.markerLabel.style.display = 'block';
            
            // Position label below the marker
            const markerRect = closestMarker.getBoundingClientRect();
            const markerCenterX = markerRect.left + markerRect.width / 2;
            
            this.markerLabel.style.left = markerCenterX + 'px';
            this.markerLabel.style.top = (rect.bottom + 5) + 'px';
        } else {
            // Hide label when not near any marker
            this.markerLabel.style.display = 'none';
        }
    }
    
    /**
     * Updates a thumbnail element with the correct sprite clip
     * @param {HTMLElement} thumbnailElement - The thumbnail element to update
     * @param {string} spriteUrl - URL of the sprite image
     * @param {number} thumbnailIndex - Index of the thumbnail to show
     * @param {number} thumbnailWidth - Width of individual thumbnails in the sprite
     * @private
     */
    updateThumbnailSprite(thumbnailElement, spriteUrl, thumbnailIndex, thumbnailWidth) {
        // Calculate exact offset for stepped selection (no smooth interpolation)
        const offsetX = thumbnailIndex * thumbnailWidth;
        
        thumbnailElement.style.backgroundImage = `url(${spriteUrl})`;
        thumbnailElement.style.backgroundPosition = `-${offsetX}px 0`;
        thumbnailElement.style.backgroundSize = 'auto 100%';
        // Dimensions are now set in createDOM() based on config values
    }
    
    /**
     * Updates the playhead position
     * @param {number} playhead - Current playhead position in seconds
     */
    updatePlayhead(playhead) {
        this.currentPlayhead = playhead;
        
        if (!this.duration) return;
        
        const percentage = (playhead / this.duration) * 100;
        
        // Update thumb position
        this.thumbElement.style.left = percentage + '%';
        
        // Update played region
        this.playedElement.style.width = percentage + '%';
        
        // Update marker positions if duration changed
        this.updateMarkerPositions();
    }
    
    /**
     * Updates marker positions based on current duration
     * @private
     */
    updateMarkerPositions() {
        if (!this.duration) return;
        
        this.markers.forEach(marker => {
            const timeInSeconds = parseInt(marker.dataset.time);
            const percentage = (timeInSeconds / this.duration) * 100;
            marker.style.left = percentage + '%';
        });
    }
    
    /**
     * Cleanup method to remove event listeners
     */
    destroy() {
        bus.off('timeUpdate');
        bus.off('stateChange');
        
        if (this.scrubberElement && this.scrubberElement.parentNode) {
            this.scrubberElement.parentNode.removeChild(this.scrubberElement);
        }
    }
}
