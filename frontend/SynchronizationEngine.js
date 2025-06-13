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

        // Register LOCAL commands
        bus.on('localPlay', this.handleLocalPlay);
        bus.on('localPause', this.handleLocalPause);
        bus.on('localSeek', this.handleLocalSeek);
        bus.on('localSeekRelative', this.handleLocalSeekRelative);
        bus.on('localAudioChange', this.handleLocalAudioChange);

        // Register REMOTE commands
        bus.on('remotePlay', this.handleRemotePlay);
        bus.on('remotePauseSeek', this.handleRemotePauseSeek);
        bus.on('remoteAudioChange', this.handleRemoteAudioChange);
        
        // Handle player initialization
        bus.on('playersInitialized', this.handlePlayersInitialized);
    }

    // --- Local Event Handlers ---------------------------------------------------

    handleLocalPlay = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();
        // Locally play when ready (handles buffering)
        dvp.playOnceReady();
        this.getPeerConnection()?.sendCommand({ type: 'play', playhead: state.playhead });
    };

    handleLocalPause = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();
        if (state.state === 'playing') {
            dvp.pause();
        }
        this._sendPauseSeek(state.playhead);
    };

    handleLocalSeek = (playhead) => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();
        const safePlayhead = Math.max(0, Math.min(state.duration, playhead));
        dvp.seek(safePlayhead);
        this._sendPauseSeek(safePlayhead);
    };

    handleLocalSeekRelative = (seconds) => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        const state = dvp.getState();
        const newPlayhead = Math.max(0, Math.min(state.duration, state.playhead + seconds));
        dvp.seek(newPlayhead);
        this._sendPauseSeek(newPlayhead);
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

    // helper
    _sendPauseSeek(playhead) {
        this.getPeerConnection()?.sendCommand({ type: 'pauseSeek', playhead });
    }

    // --- Player Initialization Handler -----------------------------------------

    handlePlayersInitialized = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        
        // Get the first shared frame position and seek to it
        const firstSharedFramePos = dvp.getFirstSharedFramePosition();
        dvp.seek(firstSharedFramePos);
        
        // Notify remote peer to seek to the same position
        this.getPeerConnection()?.sendCommand({
            type: 'pauseSeek',
            playhead: firstSharedFramePos
        });
    };

    // --- Remote Command Handlers ----------------------------------------------

    handleRemotePlay = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remotePlay: missing playhead');
        }
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        dvp.playOnceReady();
    };

    handleRemotePauseSeek = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remotePauseSeek: missing playhead');
        }
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        dvp.seek(command.playhead); // seek pauses internally
    };

    handleRemoteAudioChange = (command) => {
        const { track } = command;
        if (!track) {
            throw new Error('Invalid remoteAudioChange: missing track');
        }
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        let localTrack;
        if (track === 'local') localTrack = 'remote';
        else if (track === 'remote') localTrack = 'local';
        else localTrack = 'none';
        dvp.switchAudio(localTrack);
    };
}
