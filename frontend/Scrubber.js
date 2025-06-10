/**
 * @typedef {Object} ScrubberElements
 * @property {HTMLElement} scrubber - The main scrubber element
 * @property {HTMLElement} scrubberThumb - The playhead marker
 * @property {HTMLElement} leftScrubber - Left video preview element
 * @property {HTMLElement} rightScrubber - Right video preview element
 * @property {HTMLElement} [timeDisplay] - Optional time display element
 * 
 * @typedef {Object} ScrubberOptions
 * @property {Function} onSeek - Callback when user seeks to a position (0-1)
 * @property {number} [seekDelay=0] - Delay in ms before triggering seek (for performance)
 */

export class Scrubber {
    /**
     * Creates a new Scrubber instance
     * @param {ScrubberElements} elements - Required DOM elements
     * @param {ScrubberOptions} options - Configuration options
     */
    constructor(elements, { onSeek, seekDelay = 0, localOffset = 0, remoteOffset = 0 } = {}) {
        if (!elements || !elements.scrubber) {
            throw new Error('Scrubber requires a valid scrubber element');
        }
        
        this.elements = elements;
        this.onSeek = onSeek || (() => {});
        this.seekDelay = seekDelay;
        this.isDragging = false;
        this.lastSeekTime = 0;
        this.seekTimeout = null;
        
        // Bind methods
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleTouchStart = this.handleTouchStart.bind(this);
        this.handleTouchMove = this.handleTouchMove.bind(this);
        this.handleTouchEnd = this.handleTouchEnd.bind(this);
        
        this.initialize();
    }
    
    /**
     * Initializes the scrubber and sets up event listeners
     * @private
     */
    initialize() {
        const { scrubber } = this.elements;
        
        // Mouse events
        scrubber.addEventListener('mousedown', this.handleMouseDown);
        
        // Touch events
        scrubber.addEventListener('touchstart', this.handleTouchStart, { passive: false });
        
        // Prevent default touch behavior to avoid page scrolling
        scrubber.addEventListener('touchmove', this.handleTouchMove, { passive: false });
        
        // Clean up any existing listeners to prevent duplicates
        this.cleanup();
    }
    
    /**
     * Handles mousedown event on the scrubber
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    handleMouseDown(e) {
        e.preventDefault();
        this.startDrag(e.clientX);
        document.addEventListener('mousemove', this.handleMouseMove);
        document.addEventListener('mouseup', this.handleMouseUp, { once: true });
    }
    
    /**
     * Handles touchstart event on the scrubber
     * @param {TouchEvent} e - Touch event
     * @private
     */
    handleTouchStart(e) {
        e.preventDefault();
        const touch = e.touches[0];
        this.startDrag(touch.clientX);
    }
    
    /**
     * Handles touchmove event on the scrubber
     * @param {TouchEvent} e - Touch event
     * @private
     */
    handleTouchMove(e) {
        if (!this.isDragging) return;
        e.preventDefault();
        const touch = e.touches[0];
        this.handleDragMove(touch.clientX);
    }
    
    /**
     * Handles touchend event on the scrubber
     * @private
     */
    handleTouchEnd() {
        this.endDrag();
    }
    
    /**
     * Handles mousemove during drag
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    handleMouseMove(e) {
        if (!this.isDragging) return;
        e.preventDefault();
        this.handleDragMove(e.clientX);
    }
    
    /**
     * Handles mouseup to end drag
     * @private
     */
    handleMouseUp() {
        this.endDrag();
    }
    
    /**
     * Starts the drag operation
     * @param {number} clientX - Initial X position
     * @private
     */
    startDrag(clientX) {
        this.isDragging = true;
        this.updatePosition(clientX, true);
    }
    
    /**
     * Handles movement during drag
     * @param {number} clientX - Current X position
     * @private
     */
    handleDragMove(clientX) {
        if (!this.isDragging) return;
        this.updatePosition(clientX, false);
    }
    
    /**
     * Ends the drag operation
     * @private
     */
    endDrag() {
        if (!this.isDragging) return;
        this.isDragging = false;
        
        // Clear any pending seek
        if (this.seekTimeout) {
            clearTimeout(this.seekTimeout);
            this.seekTimeout = null;
        }
        
        // Trigger final seek
        this.triggerSeek(this.lastPosition);
        
        // Remove global event listeners
        document.removeEventListener('mousemove', this.handleMouseMove);
    }
    
    /**
     * Updates the scrubber position and optionally triggers seek
     * @param {number} clientX - Current X position in viewport coordinates
     * @param {boolean} immediate - Whether to seek immediately
     * @private
     */
    updatePosition(clientX, immediate = false) {
        const { scrubber } = this.elements;
        const rect = scrubber.getBoundingClientRect();
        
        // Convert mouse position to normalized timeline position (0-1)
        let position = (clientX - rect.left) / rect.width;
        position = Math.max(0, Math.min(1, position)); // Clamp between 0 and 1
        
        // Update thumb position
        if (this.elements.scrubberThumb) {
            this.elements.scrubberThumb.style.left = `${position * 100}%`;
        }
        
        this.lastPosition = position;
        
        // Throttle seek events during drag
        if (immediate || !this.isDragging) {
            this.triggerSeek(position);
        } else if (this.seekDelay > 0) {
            // Debounce seek events during drag
            if (this.seekTimeout) {
                clearTimeout(this.seekTimeout);
            }
            this.seekTimeout = setTimeout(() => {
                this.triggerSeek(position);
                this.seekTimeout = null;
            }, this.seekDelay);
        } else {
            this.triggerSeek(position);
        }
    }
    
    /**
     * Triggers the seek callback with rate limiting
     * @param {number} position - Seek position (0-1)
     * @private
     */
    triggerSeek(position) {
        const now = Date.now();
        if (now - this.lastSeekTime > 50) { // Limit to 20fps for seek updates
            this.onSeek(position);
            this.lastSeekTime = now;
        }
    }
    
    /**
     * Handles click on the scrubber to seek to a specific position
     * @param {MouseEvent} e - Mouse event
     * @private
     */
    handleScrubberClick(e) {
        const rect = this.elements.scrubber.getBoundingClientRect();
        const position = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        this.onSeek(position);
    }
    
    /**
     * Updates the thumbnail images for the scrubber with proper offsets
     * @param {string} localThumbnail - URL for local video thumbnail sprite
     * @param {string} remoteThumbnail - URL for remote video thumbnail sprite
     * @param {number} offsetThumbnails - Offset in thumbnail units (positive if remote started first)
     * @param {number} thumbnailPixelWidth - Width of each thumbnail in pixels
     * @throws {Error} If elements or parameters are missing
     */
    updateThumbnails(localThumbnail, remoteThumbnail, offsetThumbnails, thumbnailPixelWidth) {
        const { leftScrubber, rightScrubber } = this.elements;

        // Apply local video thumbnail with padding-based offset
        if (leftScrubber && localThumbnail) {
            leftScrubber.src = localThumbnail;
            leftScrubber.style.paddingLeft = `calc(${Math.max(0, -offsetThumbnails)} * ${thumbnailPixelWidth}px)`;
            leftScrubber.style.paddingRight = `calc(${Math.max(0, +offsetThumbnails)} * ${thumbnailPixelWidth}px)`;
        }
        
        // Apply remote video thumbnail with padding-based offset
        if (rightScrubber && remoteThumbnail) {
            rightScrubber.src = remoteThumbnail;
            rightScrubber.style.paddingLeft = `calc(${Math.max(0, +offsetThumbnails)} * ${thumbnailPixelWidth}px)`;
            rightScrubber.style.paddingRight = `calc(${Math.max(0, -offsetThumbnails)} * ${thumbnailPixelWidth}px)`;
        }
    }

    /**
     * Updates the scrubber position and time display
     * @param {number} playhead - Current playback position in unified timeline (0-1)
     * @param {number} duration - Total duration of the unified timeline in seconds
     */
    updateTime(playhead, duration) {
        if (duration <= 0 || playhead < 0 || playhead > 1) return;
        
        // Update scrubber thumb position (playhead is 0-1)
        this.elements.scrubberThumb.style.left = `${playhead * 100}%`;
        
        // Update time display if available
        if (this.elements.timeDisplay) {
            const currentTime = playhead * duration;
            this.elements.timeDisplay.textContent = this.formatTime(currentTime);
        }
    }
    
    /**
     * Cleans up event listeners and resources
     */
    cleanup() {
        const { scrubber } = this.elements;
        
        // Clear any pending seek
        if (this.seekTimeout) {
            clearTimeout(this.seekTimeout);
            this.seekTimeout = null;
        }
        
        // Remove event listeners
        if (scrubber) {
            scrubber.removeEventListener('mousedown', this.handleMouseDown);
            scrubber.removeEventListener('touchstart', this.handleTouchStart);
            scrubber.removeEventListener('touchmove', this.handleTouchMove);
            scrubber.removeEventListener('touchend', this.handleTouchEnd);
        }
        
        // Remove global event listeners
        document.removeEventListener('mousemove', this.handleMouseMove);
        document.removeEventListener('mouseup', this.handleMouseUp);
        
        // Reset state
        this.isDragging = false;
    }
}
