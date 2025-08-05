/**
 * High-level orchestration of playback state between local video players, local UI and remote peers.
 *
 * Listens for local UI events and forwards them to the DualVideoPlayer and remote peers.
 * Handles remote commands by updating local playback state and resolving conflicts
 * using vector clock comparison when concurrent commands are received.
 */

import bus from './EventBus.js';

export class SynchronizationEngine {
    /**
     * @param {Function} getDualVideoPlayer - () => DualVideoPlayer
     * @param {Function} getPeerConnection - () => PeerConnection | null
     */
    constructor(getDualVideoPlayer, getPeerConnection) {
        this.getDualVideoPlayer = getDualVideoPlayer;
        this.getPeerConnection = getPeerConnection;

        // Local synchronization state
        this.syncState = 'paused'; // 'paused' | 'buffering' | 'pendingPlay' | 'playing' | 'pendingSeek'
        this.pendingPlayhead = null; // Target playhead for pending operations
        this.lastSeekComplete = null; // Track the last seek complete we've processed

        // Register LOCAL commands
        bus.on('localPlay', this.handleLocalPlay);
        bus.on('localPause', this.handleLocalPause);
        bus.on('localSeek', this.handleLocalSeek);
        bus.on('localSeekRelative', this.handleLocalSeekRelative);
        bus.on('localAudioChange', this.handleLocalAudioChange);

        // Register REMOTE commands - new synchronization events
        bus.on('remotePlayIntent', this.handleRemotePlayIntent);
        bus.on('remotePlayReady', this.handleRemotePlayReady);
        bus.on('remotePlayNotReady', this.handleRemotePlayNotReady);
        bus.on('remotePauseIntent', this.handleRemotePauseIntent);
        bus.on('remoteSeekIntent', this.handleRemoteSeekIntent);
        bus.on('remoteSeekComplete', this.handleRemoteSeekComplete);
        bus.on('remoteBufferingStarted', this.handleRemoteBufferingStarted);
        bus.on('remotePlayReady', this.handleRemotePlayReady);
        bus.on('remoteAudioChange', this.handleRemoteAudioChange);

        // Register buffer monitoring events from DualVideoPlayer
        bus.on('bufferingStarted', this.handleBufferingStarted);
        bus.on('bufferingComplete', this.handleBufferingComplete);
        bus.on('stateChange', this.handleDVPStateChange);

        // Handle player initialization
        bus.on('playersInitialized', this.handlePlayersInitialized);
    }

    /**
     * Clean up event listeners and resources
     */
    destroy() {
        // Remove LOCAL command listeners
        bus.off('localPlay', this.handleLocalPlay);
        bus.off('localPause', this.handleLocalPause);
        bus.off('localSeek', this.handleLocalSeek);
        bus.off('localSeekRelative', this.handleLocalSeekRelative);
        bus.off('localAudioChange', this.handleLocalAudioChange);

        // Remove REMOTE command listeners
        bus.off('remotePlayIntent', this.handleRemotePlayIntent);
        bus.off('remotePlayReady', this.handleRemotePlayReady);
        bus.off('remotePlayNotReady', this.handleRemotePlayNotReady);
        bus.off('remotePauseIntent', this.handleRemotePauseIntent);
        bus.off('remoteSeekIntent', this.handleRemoteSeekIntent);
        bus.off('remoteSeekComplete', this.handleRemoteSeekComplete);
        bus.off('remoteBufferingStarted', this.handleRemoteBufferingStarted);
        bus.off('remotePlayReady', this.handleRemotePlayReady);
        bus.off('remoteAudioChange', this.handleRemoteAudioChange);

        // Remove buffer monitoring listeners
        bus.off('bufferingStarted', this.handleBufferingStarted);
        bus.off('bufferingComplete', this.handleBufferingComplete);

        // Remove player initialization listener
        bus.off('playersInitialized', this.handlePlayersInitialized);
        bus.off('stateChange', this.handleDVPStateChange);
    }

    handleDVPStateChange = (newState) => {
        // When the player becomes ready after a seek, send seekComplete
        if (newState.state === 'ready' && this.syncState === 'pendingSeek' && this.pendingPlayhead !== null) {
            const currentTime = newState.playhead;
            if (Math.abs(currentTime - this.pendingPlayhead) < 0.1) {
                console.log(`[Seek] Local seek to ${this.pendingPlayhead} complete, notifying remote`);
                this.getPeerConnection()?.sendCommand({ 
                    type: 'seekComplete', 
                    playhead: this.pendingPlayhead 
                });
            }
        }
    };

    // --- Local Event Handlers ---------------------------------------------------

    handleLocalPlay = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();

        // Check if videos are ready for playback
        if (state.state === 'ready') {
            this.syncState = 'pendingPlay';
            this.pendingPlayhead = state.playhead;
            // Send play intent to remote peer
            this.getPeerConnection()?.sendCommand({ type: 'playIntent', playhead: state.playhead });
            // Update UI to show pending state
            bus.emit('syncStateChanged', { state: this.syncState, playhead: this.pendingPlayhead });
        } else {
            // Videos not ready, enter buffering state
            this.syncState = 'buffering';
            bus.emit('syncStateChanged', { state: this.syncState });
        }
    };

    handleLocalPause = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();

        // Pause locally
        if (state.state === 'playing') {
            dvp.pause();
        }

        // Update sync state and notify remote peer
        this.syncState = 'paused';
        this.pendingPlayhead = null;
        this.getPeerConnection()?.sendCommand({ type: 'pauseIntent', playhead: state.playhead });
        bus.emit('syncStateChanged', { state: this.syncState });
    };

    handleLocalSeek = (playhead) => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();
        const safePlayhead = Math.max(0, Math.min(state.duration, playhead));

        console.log(`[Seek] Local seek to ${safePlayhead}, current state: ${this.syncState}`);

        // Update sync state
        this.syncState = 'pendingSeek';
        this.pendingPlayhead = safePlayhead;
        bus.emit('syncStateChanged', { state: this.syncState, playhead: this.pendingPlayhead });
        
        // Notify remote peer
        console.log(`[Seek] Sending seekIntent to remote peer, playhead: ${safePlayhead}`);
        this.getPeerConnection()?.sendCommand({ type: 'seekIntent', playhead: safePlayhead });
        
        // Perform the seek - this will trigger a stateChange event when complete
        dvp.seek(safePlayhead);
    };

    handleLocalSeekRelative = (seconds) => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();
        const newPlayhead = Math.max(0, Math.min(state.duration, state.playhead + seconds));
        this.handleLocalSeek(newPlayhead);
    };

    handleLocalAudioChange = (track) => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        if (!['local', 'remote', 'none'].includes(track)) {
            console.error('Invalid audio track', track);
            return;
        }
        dvp.switchAudio(track);
        this.getPeerConnection()?.sendCommand({ type: 'audioChange', track });
    };

    // --- Player Initialization Handler -----------------------------------------

    handlePlayersInitialized = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;

        // Get the first shared frame position and seek to it
        const firstSharedFramePos = dvp.getFirstSharedFramePosition();
        dvp.seek(firstSharedFramePos);

        // Notify remote peer to seek to the same position
        this.syncState = 'pendingSeek';
        this.pendingPlayhead = firstSharedFramePos;
        this.getPeerConnection()?.sendCommand({
            type: 'seekIntent',
            playhead: firstSharedFramePos
        });
        bus.emit('syncStateChanged', { state: this.syncState, playhead: this.pendingPlayhead });
    };

    // --- Remote Event Handlers --------------------------------------------------

    handleRemotePlayIntent = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remotePlayIntent: missing playhead');
        }
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();

        // Check if we're ready to play at the requested position
        if (state.state === 'ready') {
            // We're ready, send confirmation and start playing
            this.getPeerConnection()?.sendCommand({ type: 'playReady', playhead: command.playhead });
            this.syncState = 'playing';
            dvp.play();
            bus.emit('syncStateChanged', { state: this.syncState });
        } else {
            // Not ready, send not ready response
            this.getPeerConnection()?.sendCommand({ type: 'playNotReady', playhead: command.playhead });
            this.syncState = 'buffering';
            bus.emit('syncStateChanged', { state: this.syncState });
        }

        // Pulse play/pause button
        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemotePlayReady = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remotePlayReady: missing playhead');
        }

        // Remote peer is ready, start playing if we're in pendingPlay state
        if (this.syncState === 'pendingPlay') {
            const dvp = this.getDualVideoPlayer();
            if (dvp) {
                this.syncState = 'playing';
                dvp.play();
                bus.emit('syncStateChanged', { state: this.syncState });
            }
        }

        // Pulse play/pause button
        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemotePlayNotReady = (command) => {
        // Remote peer is not ready, stay in pendingPlay state
        // UI will show waiting indicator
        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemotePauseIntent = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remotePauseIntent: missing playhead');
        }
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;

        // Pause locally
        dvp.pause();
        this.syncState = 'paused';
        this.pendingPlayhead = null;
        bus.emit('syncStateChanged', { state: this.syncState });

        // Pulse play/pause button
        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemoteSeekIntent = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remoteSeekIntent: missing playhead');
        }
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;

        console.log(`[Seek] Received seekIntent from remote, seeking to ${command.playhead}`);

        // Seek locally and enter pendingSeek state
        this.syncState = 'pendingSeek';
        this.pendingPlayhead = command.playhead;
        bus.emit('syncStateChanged', { state: this.syncState, playhead: this.pendingPlayhead });
        
        // Perform the seek - this will trigger a stateChange event when complete
        dvp.seek(command.playhead);

        // Pulse scrubber and time display
        bus.emit('uiPulse', { elementId: 'timecode' });
    };

    handleRemoteSeekComplete = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remoteSeekComplete: missing playhead');
        }

        console.log(`[Seek] Remote peer completed seek to ${command.playhead}, current state: ${this.syncState}`);

        // If we're in pendingSeek state and the playhead matches, we can transition to paused
        if (this.syncState === 'pendingSeek' && Math.abs((this.pendingPlayhead || 0) - command.playhead) < 0.1) {
            console.log(`[Seek] Both peers completed seek to ${command.playhead}, transitioning to paused`);
            this.syncState = 'paused';
            this.pendingPlayhead = null;
            bus.emit('syncStateChanged', { state: this.syncState });
        }
    };

    handleRemoteBufferingStarted = (command) => {
        // Remote peer started buffering, pause locally and wait
        const dvp = this.getDualVideoPlayer();
        if (dvp && this.syncState === 'playing') {
            dvp.pause();
            this.syncState = 'paused';
            bus.emit('syncStateChanged', { state: this.syncState });
        }

        // Show buffering indicator
        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemotePlayReady = (command) => {
        console.log('[Init] Remote peer is ready, checking if we can start playing');
        
        // If we're also ready (in pendingPlay), both peers can start playing
        if (this.syncState === 'pendingPlay') {
            console.log('[Init] Both peers ready, starting playback');
            this.syncState = 'playing';
            const dvp = this.getDualVideoPlayer();
            if (dvp) {
                dvp.play();
                bus.emit('syncStateChanged', { state: this.syncState });
            }
        }

        // Pulse play/pause button to indicate remote readiness
        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemoteAudioChange = (command) => {
        const { track } = command;
        if (!track) {
            throw new Error('Invalid remoteAudioChange: missing track');
        }
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        let localTrack;
        let elementId;
        if (track === 'local') {
            localTrack = 'remote';
            elementId = 'right-audio-activate';
        } else if (track === 'remote') {
            localTrack = 'local';
            elementId = 'left-audio-activate';
        } else {
            localTrack = 'none';
            // Could pulse both, or neither; here, pulse both
            bus.emit('uiPulse', { elementId: 'left-audio-activate' });
            bus.emit('uiPulse', { elementId: 'right-audio-activate' });
        }
        dvp.switchAudio(localTrack);
        if (elementId) {
            bus.emit('uiPulse', { elementId });
        }
    };

    // --- Buffer Monitoring Handlers ---------------------------------------------

    handleBufferingStarted = (event) => {
        // Local videos started buffering during playback
        this.syncState = 'buffering';

        // Notify remote peer
        this.getPeerConnection()?.sendCommand({ type: 'bufferingStarted' });

        // Update UI state
        bus.emit('syncStateChanged', { state: this.syncState, bufferingVideos: event.videos });
    };

    handleBufferingComplete = () => {
        // Local videos finished buffering
        if (this.syncState === 'buffering') {
            console.log('[Init] Local buffering complete, notifying remote peer');
            this.syncState = 'pendingPlay';

            // Notify remote peer we're ready
            this.getPeerConnection()?.sendCommand({ type: 'playReady' });

            // Update UI state
            bus.emit('syncStateChanged', { state: this.syncState });
        }
    };

    // --- Initialization Handler ------------------------------------------------

    handlePlayersInitialized = ({ playhead, duration, localConfig, remoteConfig }) => {
        console.log('[Init] Players initialized, starting in buffering state');
        
        // Start in buffering state - both peers will buffer independently
        this.syncState = 'buffering';
        bus.emit('syncStateChanged', { state: this.syncState });
        
        // The DualVideoPlayer will emit bufferingComplete when ready
        // No need for initial seek handshake - both peers calculate the same start position
    };
}
