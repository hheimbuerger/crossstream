// SynchronizationEngine - High-level orchestration of local playback actions
// and propagation to remote peer. It encapsulates the "handle*" helpers that
// previously lived in player.js so that player.js focuses on wiring/UI.
//
// NOTE: This module currently preserves the existing imperative logic. It will
// be refined later as the Synchronization Engine evolves.

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
        const vs = this.getDualVideoPlayer();
        if (!vs) return;
        const state = vs.getState();
        // Locally play when ready (handles buffering)
        vs.playOnceReady().catch(console.error);
        this.getPeerConnection()?.sendCommand({ type: 'play', playhead: state.playhead });
    };

    handleLocalPause = () => {
        const vs = this.getDualVideoPlayer();
        if (!vs) return;
        const state = vs.getState();
        if (state.state === 'playing') {
            vs.pause();
        }
        this._sendPauseSeek(state.playhead);
    };

    handleLocalSeek = (playhead) => {
        const videoSynchronizer = this.getDualVideoPlayer();
        if (!videoSynchronizer) return;
        const state = videoSynchronizer.getState();
        const safePlayhead = Math.max(0, Math.min(state.duration, playhead));
        videoSynchronizer.seek(safePlayhead);
        this._sendPauseSeek(safePlayhead);
    };

    handleLocalSeekRelative = (seconds) => {
        const videoSynchronizer = this.getDualVideoPlayer();
        if (!videoSynchronizer) return;
        const state = videoSynchronizer.getState();
        const newPlayhead = Math.max(0, Math.min(state.duration, state.playhead + seconds));
        videoSynchronizer.seek(newPlayhead);
        this._sendPauseSeek(newPlayhead);
    };

    handleLocalAudioChange = (track) => {
        const vs = this.getDualVideoPlayer();
        if (!vs) return;
        if (!['local', 'remote', 'none'].includes(track)) {
            console.error('Invalid audio track', track);
            return;
        }
        vs.switchAudio(track);
        this.getPeerConnection()?.sendCommand({ type: 'audioChange', track });
    };

    // helper
    _sendPauseSeek(playhead) {
        this.getPeerConnection()?.sendCommand({ type: 'pauseSeek', playhead });
    }

    // --- Player Initialization Handler -----------------------------------------

    handlePlayersInitialized = async () => {
        const vs = this.getDualVideoPlayer();
        if (!vs) return;
        
        // Get the first shared frame position and seek to it
        const firstSharedFramePos = vs.getFirstSharedFramePosition();
        await vs.seek(firstSharedFramePos);
        
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
        const videoSynchronizer = this.getDualVideoPlayer();
        if (!videoSynchronizer) return;
        videoSynchronizer.playOnceReady().catch(console.error);
    };

    handleRemotePauseSeek = (command) => {
        if (command.playhead === undefined) {
            throw new Error('Invalid remotePauseSeek: missing playhead');
        }
        const videoSynchronizer = this.getDualVideoPlayer();
        if (!videoSynchronizer) return;
        videoSynchronizer.seek(command.playhead); // seek pauses internally
    };

    handleRemoteAudioChange = (command) => {
        const { track } = command;
        if (!track) {
            throw new Error('Invalid remoteAudioChange: missing track');
        }
        const vs = this.getDualVideoPlayer();
        if (!vs) return;
        let localTrack;
        if (track === 'local') localTrack = 'remote';
        else if (track === 'remote') localTrack = 'local';
        else localTrack = 'none';
        vs.switchAudio(localTrack);
    };
}
