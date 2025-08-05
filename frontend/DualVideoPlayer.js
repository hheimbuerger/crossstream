/**
 * DualVideoPlayer
 *
 * Handles frame-accurate synchronization between two HLS video streams.
 * Manages playback state, seeking, and audio routing between the streams.
 */
import bus from './EventBus.js';

export class DualVideoPlayer {
    /**
     * Timeout in milliseconds to wait for videos to be ready for playback
    */
     #PLAY_READY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    /**
     * Buffer lookahead requirement in seconds for smooth playback
     */
    #BUFFER_LOOKAHEAD_SECONDS = 2;

    // State
    state = 'paused'; // 'paused' | 'ready' | 'playing'
    audioSource = 'none'; // 'none' | 'local' | 'remote'
    #playOnceReadyPromise = null; // Tracks the pending playOnceReady operation
    #syncInterval = null;
    #timeUpdateRaf = null;
    #lastEmittedSecond = null;

    // Buffer monitoring
    #bufferMonitorInterval = null;
    #lastBufferCheck = { local: true, remote: true }; // Track buffer state changes

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
     * Gets the position of the first shared frame in the unified timeline
     * @returns {number} Position of first shared frame in the unified timeline
     * @private
     */
    getFirstSharedFramePosition() {
        const firstSharedTime = Math.max(this.#localStartTime, this.#remoteStartTime);
        return (firstSharedTime - this.#timelineStart) / 1000;
    }

    /**
     * Gets the current playhead (seconds) in the unified timeline
     * @returns {number} Playhead in seconds
     */
    getPlayhead() {
        return this.getUnifiedTimeFromVideo(this.localVideo.currentTime, 'local');
    }

    /**
     * Seeks to a specific playhead (seconds) in the unified timeline
     * @param {number} playhead - Playhead in seconds
     */
    seek(playhead) {
        playhead = Math.max(0, Math.min(this.#totalDuration, playhead));

        // Any seek implicitly pauses playback to avoid drift
        if (this.state === 'playing') {
            this.pause(); // pause() already emits state change
        }

        // Translate unified playhead → individual video currentTime values
        const localTime = this.getVideoTimeForUnified(playhead, 'local');
        const remoteTime = this.getVideoTimeForUnified(playhead, 'remote');

        if (localTime <= this.localVideo.duration) {
            this.localVideo.currentTime = localTime;
        }

        if (remoteTime <= this.remoteVideo.duration) {
            this.remoteVideo.currentTime = remoteTime;
        }

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

            // Let the SynchronizationEngine handle seeking to the first shared frame
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

    /**
     * Checks if a video element has sufficient buffer for current playback position
     * @param {HTMLVideoElement} video - Video element to check
     * @returns {boolean} True if video is sufficiently buffered
     * @private
     */
    #isVideoBuffered(video) {
        // Check if video has sufficient readyState
        if (video.readyState < 3) return false;

        // Check buffered ranges for current position
        const currentTime = video.currentTime;
        const buffered = video.buffered;

        for (let i = 0; i < buffered.length; i++) {
            const start = buffered.start(i);
            const end = buffered.end(i);

            // If current position is within a buffered range with some lookahead
            if (currentTime >= start && currentTime + this.#BUFFER_LOOKAHEAD_SECONDS <= end) {
                return true;
            }
        }

        return false;
    }

    /**
     * Monitors buffer state during playback and emits events when buffer runs out
     * @private
     */
    #monitorBufferDuringPlayback() {
        if (this.state !== 'playing') return;

        const localBuffered = this.#isVideoBuffered(this.localVideo);
        const remoteBuffered = this.#isVideoBuffered(this.remoteVideo);

        // If either video runs out of buffer during playback, emit buffering events
        const localBufferingStarted = !localBuffered && this.#lastBufferCheck.local;
        const remoteBufferingStarted = !remoteBuffered && this.#lastBufferCheck.remote;

        if (localBufferingStarted || remoteBufferingStarted) {
            const bufferingVideos = [];
            if (localBufferingStarted) bufferingVideos.push('local');
            if (remoteBufferingStarted) bufferingVideos.push('remote');

            console.log(`[DVP] Video buffer depleted during playback: ${bufferingVideos.join(', ')}`);
            bus.emit('bufferingStarted', { videos: bufferingVideos });
        }

        // If both videos have restored buffer, emit buffering complete
        const localBufferingComplete = localBuffered && !this.#lastBufferCheck.local;
        const remoteBufferingComplete = remoteBuffered && !this.#lastBufferCheck.remote;

        if ((localBufferingComplete || remoteBufferingComplete) && localBuffered && remoteBuffered) {
            console.log('[DVP] Video buffer restored, ready to resume playback');
            bus.emit('bufferingComplete');
        }

        // Update last known buffer state
        this.#lastBufferCheck.local = localBuffered;
        this.#lastBufferCheck.remote = remoteBuffered;
    }

    #setupEventListeners() {
        const updateReadyState = () => {
            // console.log('updateReadyState', this.state, this.localVideo.readyState, this.remoteVideo.readyState);
            if (this.state === 'paused' &&
                this.localVideo.readyState >= 3 &&
                this.remoteVideo.readyState >= 3) {
                this.state = 'ready';
                this.#emitState();
            }
        };

        // Enhanced readiness detection - monitor buffer state changes
        const checkBufferState = () => {
            const localBuffered = this.#isVideoBuffered(this.localVideo);
            const remoteBuffered = this.#isVideoBuffered(this.remoteVideo);

            // Update buffer state tracking
            this.#lastBufferCheck.local = localBuffered;
            this.#lastBufferCheck.remote = remoteBuffered;

            // Update overall readiness
            updateReadyState();
        };

        // Add event listeners for video ready state and buffer changes
        const events = ['canplay', 'seeked', 'waiting', 'canplaythrough', 'stalled'];
        this._videoEventHandlers = events.map(event => {
            const handler = checkBufferState.bind(this);
            this.localVideo.addEventListener(event, handler);
            this.remoteVideo.addEventListener(event, handler);
            return { event, handler };
        });
    }

    #emitTimeUpdate() {
        const playhead = this.getPlayhead();
        // Emit via central event bus
        bus.emit('timeUpdate', {playhead: playhead, duration: this.#totalDuration});
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
        if (this.state === 'playing') {
            return;
        }

        if (this.#playOnceReadyPromise) {
            return this.#playOnceReadyPromise;
        }

        if (this.state === 'ready') {
            return this.play();
        }

        this.#playOnceReadyPromise = new Promise((resolve, reject) => {
            const onStateChange = (state) => {
                if (state.state === 'ready') {
                    cleanup();
                    this.play().then(resolve).catch(reject);
                    this.#playOnceReadyPromise = null;
                }
            };

            // Timeout after configured duration
            const timeout = setTimeout(() => {
                cleanup();
                this.#playOnceReadyPromise = null;
                reject(new Error('Timed out waiting for videos to be ready'));
            }, this.#PLAY_READY_TIMEOUT_MS);

            const cleanup = () => {
                clearTimeout(timeout);
                bus.off('stateChange', onStateChange);
            };

            // Listen for future state changes
            bus.on('stateChange', onStateChange);

            // Edge-case: if the videos became ready before the listener was attached,
            // check immediately and resolve without waiting for another event.
            if (this.state === 'ready') {
                onStateChange({ state: 'ready' });
            }
        });

        return this.#playOnceReadyPromise;
    }

    /**
     * Play the videos
     * @returns {Promise<void>}
     */
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
                this.#checkVideoSynchronization();
            }, 1000);

            // Set up buffer monitoring during playback
            this.#bufferMonitorInterval = setInterval(() => {
                this.#monitorBufferDuringPlayback();
            }, 500); // Check buffer every 500ms during playback

            // Start per-frame timeUpdate emission
            this.#lastEmittedSecond = null;
            const emitTimeUpdateLoop = () => {
                if (this.state !== 'playing') return;
                const playhead = this.getPlayhead();
                const currentSecond = Math.floor(playhead);
                if (this.#lastEmittedSecond !== currentSecond && currentSecond >= 0 && currentSecond <= this.#totalDuration) {
                    this.#lastEmittedSecond = currentSecond;
                    this.#emitTimeUpdate();
                }
                this.#timeUpdateRaf = requestAnimationFrame(emitTimeUpdateLoop);
            };
            this.#timeUpdateRaf = requestAnimationFrame(emitTimeUpdateLoop);

            // Emit state update
            this.#emitState();

        } catch (error) {
            console.error('Playback failed:', error);
            this.pause();
            throw error;
        }
    }

    pause() {
        if (this.#timeUpdateRaf) {
            cancelAnimationFrame(this.#timeUpdateRaf);
            this.#timeUpdateRaf = null;
        }
        this.#lastEmittedSecond = null;
        if (this.state === 'paused' || this.state === 'ready') return;

        // Clear any pending playOnceReady
        if (this.#playOnceReadyPromise) {
            this.#playOnceReadyPromise = null;
        }

        clearInterval(this.#syncInterval);
        if (this.#bufferMonitorInterval) {
            clearInterval(this.#bufferMonitorInterval);
            this.#bufferMonitorInterval = null;
        }
        this.localVideo.pause();
        this.remoteVideo.pause();

        // If videos are still ready, go to 'ready' state, otherwise 'paused'
        if (this.localVideo.readyState >= 3 && this.remoteVideo.readyState >= 3) {
            this.state = 'ready';
        } else {
            this.state = 'paused';
        }
        this.#emitState();
    }

    switchAudio(source) {
        if (source !== 'local' && source !== 'remote' && source !== 'none') {
            throw new Error("Audio source must be 'local', 'remote', or 'none'");
        }

        this.audioSource = source;
        this.localVideo.muted = (source !== 'local');
        this.remoteVideo.muted = (source !== 'remote');

        // Emit state change to update UI
        this.#emitState();
    }

    destroy() {
        // Clear sync interval
        if (this.#syncInterval) {
            clearInterval(this.#syncInterval);
            this.#syncInterval = null;
        }
        if (this.#bufferMonitorInterval) {
            clearInterval(this.#bufferMonitorInterval);
            this.#bufferMonitorInterval = null;
        }
        if (this.#timeUpdateRaf) {
            cancelAnimationFrame(this.#timeUpdateRaf);
            this.#timeUpdateRaf = null;
        }
        this.#lastEmittedSecond = null;
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
