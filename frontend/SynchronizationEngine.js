/**
 * Intent-driven SynchronizationEngine - Refactored for simplicity and maintainability
 * 
 * Core principle: All coordination is driven by a single "current intent" that represents
 * what operation is currently in progress. All state transitions and recovery logic
 * derive from completing or abandoning the current intent.
 */

import bus from './EventBus.js';

export class SynchronizationEngine {
    #PEERS_OUT_OF_SYNC_THRESHOLD_SECONDS = 0.5;

    /**
     * @param {Function} getDualVideoPlayer - () => DualVideoPlayer
     * @param {Function} getPeerConnection - () => PeerConnection | null
     */
    constructor(getDualVideoPlayer, getPeerConnection) {
        this.getDualVideoPlayer = getDualVideoPlayer;
        this.getPeerConnection = getPeerConnection;

        // SINGLE SOURCE OF TRUTH: Current Intent
        this.currentIntent = {
            type: null,           // 'play' | 'pause' | 'seek' | 'audio' | null
            initiator: null,      // 'local' | 'remote' | null
            playhead: null,       // target playhead for play/seek operations
            track: null,          // audio track for audio operations
            timestamp: 0,         // when this intent was created
            status: 'idle'        // 'idle' | 'coordinating' | 'waiting' | 'buffering' | 'complete'
        };

        // Derived state (computed from intent)
        this.syncState = 'paused'; // UI display state

        this.setupEventListeners();
    }

    setupEventListeners() {
        // LOCAL commands
        bus.on('localPlay', this.handleLocalPlay);
        bus.on('localPause', this.handleLocalPause);
        bus.on('localSeek', this.handleLocalSeek);
        bus.on('localSeekRelative', this.handleLocalSeekRelative);
        bus.on('localAudioChange', this.handleLocalAudioChange);

        // REMOTE commands
        bus.on('remotePlayIntent', this.handleRemotePlayIntent);
        bus.on('remotePlayReady', this.handleRemotePlayReady);
        bus.on('remotePlayNotReady', this.handleRemotePlayNotReady);
        bus.on('remotePauseIntent', this.handleRemotePauseIntent);
        bus.on('remoteSeekIntent', this.handleRemoteSeekIntent);
        bus.on('remoteSeekComplete', this.handleRemoteSeekComplete);
        bus.on('remoteAudioChange', this.handleRemoteAudioChange);

        // BUFFER monitoring
        bus.on('bufferingStarted', this.handleBufferingStarted);
        bus.on('bufferingComplete', this.handleBufferingComplete);
        bus.on('stateChange', this.handleDVPStateChange);

        // INITIALIZATION
        bus.on('playersInitialized', this.handlePlayersInitialized);
    }

    // ============================================================================
    // INTENT MANAGEMENT - Core logic for managing the current intent
    // ============================================================================

    /**
     * Start a new intent, replacing any existing one
     */
    startIntent(type, initiator, { playhead = null, track = null } = {}) {
        this.currentIntent = {
            type,
            initiator,
            playhead,
            track,
            timestamp: Date.now(),
            status: 'coordinating'
        };
        
        console.log(`[Intent] Started: ${type} by ${initiator}`, this.currentIntent);
        this.updateSyncState();
    }

    /**
     * Update the status of the current intent
     */
    updateIntentStatus(newStatus) {
        if (this.currentIntent.type) {
            this.currentIntent.status = newStatus;
            console.log(`[Intent] Status: ${this.currentIntent.type} -> ${newStatus}`);
            this.updateSyncState();
        }
    }

    /**
     * Complete the current intent and return to idle
     */
    completeIntent() {
        if (this.currentIntent.type) {
            console.log(`[Intent] Completed: ${this.currentIntent.type}`);
            this.currentIntent = {
                type: null,
                initiator: null,
                playhead: null,
                track: null,
                timestamp: 0,
                status: 'idle'
            };
            this.updateSyncState();
        }
    }

    /**
     * Check if a remote intent should override the current one (conflict resolution)
     */
    shouldAcceptRemoteIntent(remoteTimestamp) {
        // Accept if no current intent or remote intent is newer
        return !this.currentIntent.type || remoteTimestamp > this.currentIntent.timestamp;
    }

    /**
     * Update the UI sync state based on current intent
     */
    updateSyncState() {
        let newSyncState;
        
        switch (this.currentIntent.status) {
            case 'idle':
                newSyncState = this.currentIntent.type === 'play' ? 'playing' : 'paused';
                break;
            case 'coordinating':
                if (this.currentIntent.type === 'play') {
                    newSyncState = 'pendingPlay';
                } else if (this.currentIntent.type === 'seek') {
                    newSyncState = 'pendingSeek';
                } else {
                    newSyncState = 'paused';
                }
                break;
            case 'waiting':
                newSyncState = this.currentIntent.type === 'play' ? 'pendingPlay' : 'pendingSeek';
                break;
            case 'buffering':
                newSyncState = 'buffering';
                break;
            case 'complete':
                newSyncState = this.currentIntent.type === 'play' ? 'playing' : 'paused';
                break;
            default:
                newSyncState = 'paused';
        }

        if (newSyncState !== this.syncState) {
            this.syncState = newSyncState;
            bus.emit('syncStateChanged', { 
                state: this.syncState, 
                playhead: this.currentIntent.playhead 
            });
        }
    }

    /**
     * Clean up event listeners and resources
     */
    destroy() {
        // Remove all listeners (same as before)
        bus.off('localPlay', this.handleLocalPlay);
        bus.off('localPause', this.handleLocalPause);
        bus.off('localSeek', this.handleLocalSeek);
        bus.off('localSeekRelative', this.handleLocalSeekRelative);
        bus.off('localAudioChange', this.handleLocalAudioChange);
        bus.off('remotePlayIntent', this.handleRemotePlayIntent);
        bus.off('remotePlayReady', this.handleRemotePlayReady);
        bus.off('remotePlayNotReady', this.handleRemotePlayNotReady);
        bus.off('remotePauseIntent', this.handleRemotePauseIntent);
        bus.off('remoteSeekIntent', this.handleRemoteSeekIntent);
        bus.off('remoteSeekComplete', this.handleRemoteSeekComplete);
        bus.off('remoteAudioChange', this.handleRemoteAudioChange);
        bus.off('bufferingStarted', this.handleBufferingStarted);
        bus.off('bufferingComplete', this.handleBufferingComplete);
        bus.off('stateChange', this.handleDVPStateChange);
        bus.off('playersInitialized', this.handlePlayersInitialized);
    }

    // ============================================================================
    // LOCAL EVENT HANDLERS - Simplified using intent-driven approach
    // ============================================================================

    handleLocalPlay = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        
        const state = dvp.getState();
        this.startIntent('play', 'local', { playhead: state.playhead });

        if (state.state === 'ready') {
            // Send play intent to remote peer
            this.getPeerConnection()?.sendCommand({ 
                type: 'playIntent', 
                playhead: state.playhead,
                timestamp: this.currentIntent.timestamp
            });
        } else {
            // Not ready, enter buffering
            this.updateIntentStatus('buffering');
            this.getPeerConnection()?.sendCommand({ type: 'playNotReady' });
        }
    };

    handleLocalPause = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        
        const state = dvp.getState();
        
        // Pause locally immediately
        if (state.state === 'playing') {
            dvp.pause();
        }

        // Start pause intent and notify remote
        this.startIntent('pause', 'local', { playhead: state.playhead });
        this.getPeerConnection()?.sendCommand({ 
            type: 'pauseIntent', 
            playhead: state.playhead,
            timestamp: this.currentIntent.timestamp
        });
        
        // Pause completes immediately
        this.completeIntent();
    };

    handleLocalSeek = (playhead) => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        
        const state = dvp.getState();
        const safePlayhead = Math.max(0, Math.min(state.duration, playhead));

        this.startIntent('seek', 'local', { playhead: safePlayhead });
        
        // Notify remote peer
        this.getPeerConnection()?.sendCommand({ 
            type: 'seekIntent', 
            playhead: safePlayhead,
            timestamp: this.currentIntent.timestamp
        });
        
        // Perform local seek
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
        
        this.startIntent('audio', 'local', { track });
        dvp.switchAudio(track);
        
        this.getPeerConnection()?.sendCommand({ 
            type: 'audioChange', 
            track,
            timestamp: this.currentIntent.timestamp
        });
        
        // Audio change completes immediately
        this.completeIntent();
    };

    // ============================================================================
    // REMOTE EVENT HANDLERS - Simplified conflict resolution
    // ============================================================================

    handleRemotePlayIntent = (command) => {
        const { playhead, timestamp = 0 } = command;
        
        // Check if we should accept this remote intent
        if (!this.shouldAcceptRemoteIntent(timestamp)) {
            console.log('[Intent] Ignoring stale remote play intent');
            return;
        }

        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;
        
        this.startIntent('play', 'remote', { playhead });
        this.currentIntent.timestamp = timestamp; // Use remote timestamp
        
        const state = dvp.getState();
        if (state.state === 'ready') {
            // Ready to play - send confirmation and start
            this.getPeerConnection()?.sendCommand({ type: 'playReady', playhead });
            dvp.play();
            this.updateIntentStatus('complete');
        } else {
            // Not ready - enter buffering
            this.getPeerConnection()?.sendCommand({ type: 'playNotReady', playhead });
            this.updateIntentStatus('buffering');
        }

        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemotePlayReady = (command) => {
        // Only relevant if we have a local play intent waiting
        if (this.currentIntent.type === 'play' && 
            this.currentIntent.initiator === 'local' && 
            this.currentIntent.status === 'coordinating') {
            
            const dvp = this.getDualVideoPlayer();
            if (dvp) {
                dvp.play();
                this.updateIntentStatus('complete');
            }
        }

        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemotePlayNotReady = (command) => {
        // Only relevant if we have a local play intent
        if (this.currentIntent.type === 'play' && 
            this.currentIntent.initiator === 'local') {
            this.updateIntentStatus('waiting');
        }

        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemotePauseIntent = (command) => {
        const { playhead, timestamp = 0 } = command;
        
        if (!this.shouldAcceptRemoteIntent(timestamp)) {
            return;
        }

        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;

        // Pause locally
        dvp.pause();

        // Check for drift and correct if needed
        const state = dvp.getState();
        const drift = Math.abs(state.playhead - playhead);
        if (drift > this.#PEERS_OUT_OF_SYNC_THRESHOLD_SECONDS) {
            console.warn(`[Sync] Drift ${drift.toFixed(3)}s detected, re-seeking`);
            dvp.seek(playhead);
        }

        this.startIntent('pause', 'remote', { playhead });
        this.currentIntent.timestamp = timestamp;
        this.completeIntent(); // Pause completes immediately

        bus.emit('uiPulse', { elementId: 'playPauseButton' });
    };

    handleRemoteSeekIntent = (command) => {
        const { playhead, timestamp = 0 } = command;
        
        if (!this.shouldAcceptRemoteIntent(timestamp)) {
            return;
        }

        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;

        this.startIntent('seek', 'remote', { playhead });
        this.currentIntent.timestamp = timestamp;
        
        dvp.seek(playhead);
        bus.emit('uiPulse', { elementId: 'timecode' });
    };

    handleRemoteSeekComplete = (command) => {
        const { playhead } = command;
        
        // Only relevant if we have a seek intent in progress
        if (this.currentIntent.type === 'seek' && 
            Math.abs((this.currentIntent.playhead || 0) - playhead) < 0.1) {
            
            // Both peers have completed seek
            this.completeIntent();
        }
    };

    handleRemoteAudioChange = (command) => {
        const { track, timestamp = 0 } = command;
        
        if (!this.shouldAcceptRemoteIntent(timestamp)) {
            return;
        }

        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;

        this.startIntent('audio', 'remote', { track });
        this.currentIntent.timestamp = timestamp;

        // Map remote track to local track (opposite)
        const localTrack = track === 'local' ? 'remote' : 
                          track === 'remote' ? 'local' : 'none';
        
        dvp.switchAudio(localTrack);
        this.completeIntent();

        // Pulse appropriate UI elements
        const elementMap = { 'local': 'right-audio-activate', 'remote': 'left-audio-activate' };
        if (elementMap[track]) {
            bus.emit('uiPulse', { elementId: elementMap[track] });
        }
    };

    // ============================================================================
    // BUFFERING HANDLERS - Dramatically simplified
    // ============================================================================

    handleBufferingStarted = (event) => {
        // If we have an active intent, mark it as buffering
        if (this.currentIntent.type) {
            this.updateIntentStatus('buffering');
            
            // Notify remote we're not ready
            this.getPeerConnection()?.sendCommand({ type: 'playNotReady' });
        }
    };

    handleBufferingComplete = () => {
        // If we have a buffering intent, try to complete it
        if (this.currentIntent.status === 'buffering') {
            const dvp = this.getDualVideoPlayer();
            if (!dvp) return;

            if (this.currentIntent.type === 'play') {
                if (this.currentIntent.initiator === 'remote') {
                    // Respond to remote play intent
                    this.getPeerConnection()?.sendCommand({ 
                        type: 'playReady', 
                        playhead: this.currentIntent.playhead 
                    });
                    dvp.play();
                    this.updateIntentStatus('complete');
                } else {
                    // Resume local play intent
                    this.getPeerConnection()?.sendCommand({ 
                        type: 'playIntent', 
                        playhead: this.currentIntent.playhead,
                        timestamp: this.currentIntent.timestamp
                    });
                    this.updateIntentStatus('coordinating');
                }
            } else {
                // For non-play intents, just complete
                this.completeIntent();
            }
        }
    };

    // ============================================================================
    // DVP STATE CHANGE HANDLER - Simplified seek completion
    // ============================================================================

    handleDVPStateChange = (newState) => {
        console.log(`[DVP] State change: ${newState.state}, playhead: ${newState.playhead?.toFixed(3)}`);
        console.log(`[DVP] Current intent:`, this.currentIntent);
        
        // Handle seek completion
        if (newState.state === 'ready' && 
            this.currentIntent.type === 'seek' && 
            this.currentIntent.playhead !== null) {
            
            console.log(`[DVP] Seek completion conditions met`);
            const currentTime = newState.playhead;
            const drift = Math.abs(currentTime - this.currentIntent.playhead);
            console.log(`[DVP] Playhead drift: ${drift.toFixed(3)}s (target: ${this.currentIntent.playhead.toFixed(3)}, actual: ${currentTime.toFixed(3)})`);
            
            if (drift < 0.1) {
                const dvp = this.getDualVideoPlayer();
                const isActuallyReady = dvp && dvp.isActuallyReady();
                console.log(`[DVP] DVP actually ready: ${isActuallyReady}`);
                
                if (isActuallyReady) {
                    console.log(`[Sync] Local seek complete, notifying remote (initiator: ${this.currentIntent.initiator})`);
                    this.getPeerConnection()?.sendCommand({ 
                        type: 'seekComplete', 
                        playhead: this.currentIntent.playhead 
                    });
                    
                    // If this was a local seek, wait for remote completion
                    // If this was a remote seek, we're done
                    if (this.currentIntent.initiator === 'remote') {
                        console.log(`[Sync] Remote seek complete, finishing intent`);
                        this.completeIntent();
                    } else {
                        console.log(`[Sync] Local seek complete, waiting for remote`);
                    }
                } else {
                    console.log(`[DVP] Videos not actually ready yet, waiting...`);
                }
            } else {
                console.log(`[DVP] Playhead drift too large (${drift.toFixed(3)}s), not sending seekComplete`);
            }
        } else {
            console.log(`[DVP] Seek completion conditions not met:`);
            console.log(`  - State ready: ${newState.state === 'ready'}`);
            console.log(`  - Intent is seek: ${this.currentIntent.type === 'seek'}`);
            console.log(`  - Has playhead: ${this.currentIntent.playhead !== null}`);
        }
    };

    // ============================================================================
    // INITIALIZATION HANDLER
    // ============================================================================

    handlePlayersInitialized = () => {
        const dvp = this.getDualVideoPlayer();
        if (!dvp) return;

        const firstSharedFramePos = dvp.getFirstSharedFramePosition();
        this.startIntent('seek', 'local', { playhead: firstSharedFramePos });
        
        this.getPeerConnection()?.sendCommand({
            type: 'seekIntent',
            playhead: firstSharedFramePos,
            timestamp: this.currentIntent.timestamp
        });
        
        dvp.seek(firstSharedFramePos);
    };
}
