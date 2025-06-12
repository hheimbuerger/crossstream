/**
 * VideoPlayerSynchronizer
 * 
 * Handles frame-accurate synchronization between two HLS video streams.
 * Manages playback state, seeking, and audio routing between the streams.
 */
import bus from './EventBus.js';

export class VideoPlayerSynchronizer {
    // State
    state = 'paused'; // 'paused' | 'ready' | 'playing'
    audioSource = 'none'; // 'none' | 'local' | 'remote'
    #playOnceReadyPromise = null; // Tracks the pending playOnceReady operation
    #syncInterval = null;
    
    // Video elements
    localVideo = null;
    remoteVideo = null;
    
    // HLS instances
    localHls = null;
    remoteHls = null;
    
    // Timeline and playhead management
    #timelineStart = 0;  // Start time of the unified timeline (ms since epoch)
    #timelineEnd = 0;    // End time of the unified timeline (ms since epoch)
    #localStartTime = 0;  // Local video start time (ms since epoch)
    #remoteStartTime = 0; // Remote video start time (ms since epoch)
    #totalDuration = 0;   // Total duration of the unified timeline (seconds)
    timeOffset = 0;       // Time offset between local and remote videos (seconds)
    #lastUpdateTime = 0;  // Timestamp of last playhead update (performance.now())
    #lastPlayhead = 0;    // Last calculated playhead (seconds)
    
    /**
     * Updates the unified timeline based on current video metadata
     * @private
     */
    #updateTimeline() {
        const localEndTime = this.#localStartTime + (this.localVideo.duration * 1000);
        const remoteEndTime = this.#remoteStartTime + (this.remoteVideo.duration * 1000);
        
        // Unified timeline spans from earliest start to latest end
        this.#timelineStart = Math.min(this.#localStartTime, this.#remoteStartTime);
        this.#timelineEnd = Math.max(localEndTime, remoteEndTime);
        this.#totalDuration = (this.#timelineEnd - this.#timelineStart) / 1000;
    }
    
    /**
     * Gets the position of the first shared frame in the unified timeline (0-1)
     * @returns {number} Position of first shared frame in the unified timeline
     * @private
     */
    #getFirstSharedFramePosition() {
        const firstSharedTime = Math.max(this.#localStartTime, this.#remoteStartTime);
        return (firstSharedTime - this.#timelineStart) / (this.#timelineEnd - this.#timelineStart);
    }
    
    /**
     * Gets the current playhead (seconds) in the unified timeline
     * @returns {number} Playhead in seconds
     */
    getPlayhead() {
        // When paused or buffering, rely on video currentTime => unified timeline
        if (this.state !== 'playing') {
            return this.getUnifiedTimeFromVideo(this.localVideo.currentTime, 'local');
        }
        
        // While playing, estimate by elapsed wall-clock time for smoother updates
        const now = performance.now();
        if (this.#lastUpdateTime) {
            const elapsed = (now - this.#lastUpdateTime) / 1000; // seconds elapsed since last capture
            const candidate = this.#lastPlayhead + elapsed;
            if (candidate <= this.#totalDuration) {
                return candidate;
            }
        }
        return this.#lastPlayhead;
    }
    
    /**
     * Seeks to a specific playhead (seconds) in the unified timeline
     * @param {number} playhead - Playhead in seconds
     */
    seek(playhead) {
        playhead = Math.max(0, Math.min(this.#totalDuration, playhead));
        
        // Translate unified playhead → individual video currentTime values
        const localTime = this.getVideoTimeForUnified(playhead, 'local');
        const remoteTime = this.getVideoTimeForUnified(playhead, 'remote');
        
        if (localTime <= this.localVideo.duration) {
            this.localVideo.currentTime = localTime;
        }
        
        if (remoteTime <= this.remoteVideo.duration) {
            this.remoteVideo.currentTime = remoteTime;
        }
        
        // Cache last playhead
        this.#lastPlayhead = playhead;
        this.#lastUpdateTime = performance.now();
        
        this.#emitState();
    }
    
    /**
     * Converts a video's current time to a unified timeline time
     * @param {number} currentTime - Current time of the video in seconds
     * @param {'local'|'remote'} source - Which video the time is from
     * @returns {number} Unified timeline time in seconds
     * @private
     */
    getUnifiedTimeFromVideo(currentTime, source) {
        const startTime = source === 'local' ? this.#localStartTime : this.#remoteStartTime;
        const timelineMs = startTime + (currentTime * 1000);
        return (timelineMs - this.#timelineStart) / 1000;
    }
    
    /**
     * Converts a unified timeline time to a specific video's time
     * @param {number} unifiedTime - Unified timeline time in seconds
     * @param {'local'|'remote'} target - Which video to get time for
     * @returns {number} Time in seconds for the target video
     * @private
     */
    getVideoTimeForUnified(unifiedTime, target) {
        const timelineMs = this.#timelineStart + (unifiedTime * 1000);
        const startTime = target === 'local' ? this.#localStartTime : this.#remoteStartTime;
        return (timelineMs - startTime) / 1000;
    }
    
    /**
     * @param {HTMLVideoElement} localVideo - Video element for the local stream
     * @param {Object} localConfig - Configuration for the local video stream
     * @param {string} localConfig.stream - HLS stream URL for local video
     * @param {string} localConfig.timestamp - ISO 8601 timestamp when recording started
     * @param {HTMLVideoElement} remoteVideo - Video element for the remote stream
     * @param {Object} remoteConfig - Configuration for the remote video stream
     * @param {string} remoteConfig.stream - HLS stream URL for remote video
     * @param {string} remoteConfig.timestamp - ISO 8601 timestamp when recording started
     */
    constructor(localVideo, localConfig, remoteVideo, remoteConfig) {
        if (!(localVideo instanceof HTMLVideoElement) || !(remoteVideo instanceof HTMLVideoElement)) {
            throw new Error('Both local and remote video elements are required');
        }
        if (!localConfig?.stream || !remoteConfig?.stream) {
            throw new Error('Both local and remote configs with stream URLs are required');
        }
        
        // Store video elements and configurations
        this.localVideo = localVideo;
        this.remoteVideo = remoteVideo;
        
        // Parse start times from ISO timestamps
        this.#localStartTime = new Date(localConfig.timestamp).getTime();
        this.#remoteStartTime = new Date(remoteConfig.timestamp).getTime();
        
        // Initialize video elements (muted by default)
        this.localVideo.muted = true;
        this.remoteVideo.muted = true;
        
        // Calculate time offset (in seconds)
        this.timeOffset = this.#calculateTimeOffset(localConfig.timestamp, remoteConfig.timestamp);
        
        // Initialize players with configs
        this.#initializePlayers(localConfig, remoteConfig);
        
        // Set up event listeners for state management
        this.#setupEventListeners();
        
        // Bind methods
        this.play = this.play.bind(this);
        this.pause = this.pause.bind(this);
        this.switchAudio = this.switchAudio.bind(this);
        this.seek = this.seek.bind(this);
        this.destroy = this.destroy.bind(this);
    }

    // Private methods
    #calculateTimeOffset(localTimestamp, remoteTimestamp) {
        const localStart = new Date(localTimestamp);
        const remoteStart = new Date(remoteTimestamp);
        
        if (isNaN(localStart.getTime()) || isNaN(remoteStart.getTime())) {
            throw new Error('Invalid timestamp format. Must be valid ISO 8601 strings');
        }
        
        return (remoteStart - localStart) / 1000; // Convert ms to seconds
    }

    async #initializePlayers(localConfig, remoteConfig) {
        try {
            // Initialize local video
            await this.#initializeHlsPlayer(localConfig.stream, this.localVideo, 'local');
            
            // Initialize remote video
            await this.#initializeHlsPlayer(remoteConfig.stream, this.remoteVideo, 'remote');
            
            // Wait for both videos to have metadata loaded
            await Promise.all([
                new Promise(resolve => {
                    if (this.localVideo.readyState >= 1) resolve();
                    else this.localVideo.addEventListener('loadedmetadata', resolve, { once: true });
                }),
                new Promise(resolve => {
                    if (this.remoteVideo.readyState >= 1) resolve();
                    else this.remoteVideo.addEventListener('loadedmetadata', resolve, { once: true });
                })
            ]);

            this.#updateTimeline();
            
            // Seek to the first shared frame
            const firstSharedFramePos = this.#getFirstSharedFramePosition();
            await this.seek(this.getUnifiedTimeFromVideo(firstSharedFramePos, 'local'));
            
            // Allow the part of the UI that requires video player information to initialize
            bus.emit('playersInitialized', {
                playhead: this.getPlayhead(),
                duration: this.#totalDuration,
                localConfig: localConfig,
                remoteConfig: remoteConfig
            });
        } catch (error) {
            console.error('Failed to initialize players:', error);
            throw error;
        }
    }

    #initializeHlsPlayer(streamUrl, videoElement, playerType) {
        return new Promise((resolve, reject) => {
            if (!Hls.isSupported()) {
                reject(new Error('HLS is not supported in this browser'));
                return;
            }

            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 90
            });

            hls.loadSource(streamUrl);
            hls.attachMedia(videoElement);

            // Store HLS instance
            if (playerType === 'local') {
                this.localHls = hls;
            } else {
                this.remoteHls = hls;
            }

            // Wait for manifest to be parsed
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                videoElement.pause(); // Start in paused state
                resolve();
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    reject(new Error(`HLS ${playerType} player error: ${data.type}`));
                }
            });
        });
    }

    #checkVideoSynchronization() {
        if (this.state !== 'playing') return;
        
        const localTime = this.localVideo.currentTime;
        const remoteTime = this.remoteVideo.currentTime + this.timeOffset;
        const diff = Math.abs(localTime - remoteTime);
        
        if (diff > 0.1) { // 100ms threshold
            console.warn(`Videos out of sync by ${diff.toFixed(3)}s`);
        }
        
        // Log timeline information for debugging
        console.debug('Timeline:', {
            start: new Date(this.#timelineStart).toISOString(),
            end: new Date(this.#timelineEnd).toISOString(),
            duration: this.#totalDuration,
            localStart: new Date(this.#localStartTime).toISOString(),
            remoteStart: new Date(this.#remoteStartTime).toISOString()
        });
    }

    #setupEventListeners() {
        const updateReadyState = () => {
            if (this.state === 'paused' && 
                this.localVideo.readyState >= 3 && 
                this.remoteVideo.readyState >= 3) {
                this.state = 'ready';
            }
        };

        // Add event listeners for video ready state
        const events = ['canplay'];
        this._videoEventHandlers = events.map(event => {
            const handler = updateReadyState.bind(this);
            this.localVideo.addEventListener(event, handler);
            this.remoteVideo.addEventListener(event, handler);
            return { event, handler };
        });
    }

    #emitTimeUpdate() {
        const playhead = this.getPlayhead();
        // Emit via central event bus
        bus.emit('timeUpdate', playhead, this.#totalDuration);
    }

    #emitState() {
        const playhead = this.getPlayhead();
        const state = {
            state: this.state,
            playhead,
            duration: this.#totalDuration,
            audioSource: this.audioSource,
            timeOffset: this.timeOffset
        };

        this.#lastPlayhead = playhead;
        this.#lastUpdateTime = performance.now();

        // Emit via central event bus
        bus.emit('stateChange', state);
        // Emit a timeUpdate alongside state change to refresh UI components
        this.#emitTimeUpdate();
    }

    /**
     * Play the videos if they're ready, otherwise queue the play operation
     * @returns {Promise<void>}
     */
    async playOnceReady() {
        // If already playing, do nothing
        if (this.state === 'playing') {
            return;
        }
        
        // If a playOnceReady is already in progress, return that promise
        if (this.#playOnceReadyPromise) {
            return this.#playOnceReadyPromise;
        }
        
        // If ready, play immediately
        if (this.state === 'ready') {
            return this.play();
        }
        
        // Otherwise, wait for ready state
        this.#playOnceReadyPromise = new Promise((resolve, reject) => {
            const onStateChange = (state) => {
                if (state.state === 'ready') {
                    bus.off('stateChange', onStateChange);
                    this.play().then(resolve).catch(reject);
                    this.#playOnceReadyPromise = null;
                }
            };
            
            // Set a timeout to clean up if we never reach ready state
            const timeout = setTimeout(() => {
                bus.off('stateChange', onStateChange);
                this.#playOnceReadyPromise = null;
                reject(new Error('Timed out waiting for videos to be ready'));
            }, 30000); // 30 second timeout
            
            // Listen for state changes via EventBus
            bus.on('stateChange', onStateChange);
            
            // Clean up on promise resolution
            this.#playOnceReadyPromise.finally(() => {
                clearTimeout(timeout);
                bus.off('stateChange', onStateChange);
            });
        });
        
        return this.#playOnceReadyPromise;
    }
    
    async play() {
        if (this.state === 'playing') return;
        
        if (this.state !== 'ready') {
            throw new Error('Cannot play: One or both videos are not ready for playback');
        }

        try {
            // Start both videos in parallel
            const localPlay = this.localVideo.play();
            const remotePlay = this.remoteVideo.play();
            
            // Wait for both to start playing
            await Promise.all([localPlay, remotePlay]);
            
            this.state = 'playing';
            
            // Set up sync monitoring
            this.#syncInterval = setInterval(() => {
                this.#emitTimeUpdate();
                this.#checkVideoSynchronization();
            }, 1000);
            
            // Emit state update
            this.#emitState();
            
        } catch (error) {
            console.error('Playback failed:', error);
            this.pause();
            throw error;
        }
    }
    
    pause() {
        if (this.state === 'paused') return;
        
        // Clear any pending playOnceReady
        if (this.#playOnceReadyPromise) {
            this.#playOnceReadyPromise = null;
        }
        
        clearInterval(this.#syncInterval);
        this.localVideo.pause();
        this.remoteVideo.pause();
        
        this.state = 'paused';
        this.#emitState();
    }

    switchAudio(source) {
        if (source !== 'local' && source !== 'remote') {
            throw new Error("Audio source must be either 'local' or 'remote'");
        }
        
        this.audioSource = source;
        this.localVideo.muted = (source !== 'local');
        this.remoteVideo.muted = (source !== 'remote');
    }

    destroy() {
        // Clear sync interval
        if (this.#syncInterval) {
            clearInterval(this.#syncInterval);
            this.#syncInterval = null;
        }
        const handlers = {
            play: () => this.play(),
            pause: () => this.pause(),
            seekto: (details) => {
                if (details.seekTime !== undefined) {
                    this.seek(details.seekTime);
                }
            }
        };
    }
    
    // Get current state
    getState() {
        const playhead = this.getPlayhead();
        return {
            state: this.state,
            playhead: playhead,
            duration: this.#totalDuration,
            audioSource: this.audioSource,
            timeOffset: this.timeOffset
        };
    }
}
