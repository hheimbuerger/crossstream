// Extracted JavaScript from player.html

// --- Utility functions ---
// Clamps a value between a minimum and maximum.
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// Returns true if the absolute difference between two values exceeds the threshold.
function differenceOverThreshold(val1, val2, threshold) {
    return Math.abs(val1 - val2) > (threshold || 1.0);
}

// --- Constants and globals ---
// Interval (ms) for polling the server for status updates.
const STATUS_POLL_INTERVAL = 250;   // in ms
// Threshold (s) for considering playhead movement significant.
const PLAYHEAD_THRESHOLD = 1.0;  // in s
// URL parameters for extracting peer ID and other info.
const urlParams = new URLSearchParams(window.location.search);
// Peer ID for P2P connection, defaults to 'cross-stream'.
const PEER_ID = urlParams.get('id') || 'cross-stream';
// PeerJS peer object for P2P connections.
var peer;
// Data connection to remote peer.
var connection;
// Configuration received from remote peer.
var remoteConfig;
// Global PlayerManager instance.
var pm;

// --- PlayerManager class (as in player.html) ---
// PlayerManager class handles video player synchronization, UI, and state management.

class PlayerManager {
    // Reference to the left video element.
    lv;

    // Reference to the right video element.
    rv;

    // Offset in seconds between right and left video timestamps.
    rightToLeftOffset = 0.0;

    // The player (left or right) currently leading playback.
    #leadPlayer = null;

    // Whether secondary video(s) have been loaded.
    #areSecondariesLoaded = false;

    // Boolean indicating if this client is the host.
    isHost;

    // Playback state: true if playing, false if paused.
    isPlaying = false;

    // Current playhead position in seconds.
    playhead = 0;

    // Which audio channel is active ('left', 'right', or 'all').
    audioChannel = 'all';

    // Function to call when all players are ready.
    allPlayersReadyEvent = undefined;

    // Tracks readiness of each video player.
    readyPlayers = {};

    // Local configuration object.
    config;

    // Remote configuration object.
    remoteConfig;

    // Used to serialize play/pause actions to avoid race conditions.
    #latestPlayPromise;

    /**
     * Constructs a PlayerManager instance, initializes video elements and event listeners.
     * @param {Object} config - Configuration object for the player.
     * @param {boolean} isHost - Whether this client is the host.
     */
    constructor(config, isHost) {
        this.config = config;
        this.isHost = isHost;
        this.lv = document.getElementById('left-video');
        this.rv = document.getElementById('right-video');
        this.#leadPlayer = this.lv;
        this.readyPlayers[this.lv.id] = false;
        this.readyPlayers[this.rv.id] = false;
        this.#registerEventListeners();
        this.allPlayersReadyEvent = () => {
            console.log('All video players ready.');
        };
        this.loadVideo(isHost ? 'left-video' : 'right-video', config.stream);
    }
    
    /**
     * Loads a video stream into a specified player element.
     * @param {string} playerId - DOM id of the video element.
     * @param {string} streamURL - URL of the video stream.
     */
    loadVideo(playerId, streamURL) {
        if(!Hls.isSupported()) {
            console.error('Hls.js not supported, probably HLS supported by browser!');
            return;
        }
        var player = document.getElementById(playerId);
        var hls = new Hls();
        hls.loadSource(streamURL);
        hls.attachMedia(player);
        hls.on(Hls.Events.MANIFEST_PARSED,function() {});
        if(playerId == 'right-video')
            this.#areSecondariesLoaded = true;
    }
    
    /**
     * Initializes remote configuration and loads the remote video.
     * @param {Object} data - Remote configuration object.
     */
    initRemote(data) {
        this.remoteConfig = data;
        const localVideoTimestamp = luxon.DateTime.fromISO(this.config.timestamp);
        const remoteVideoTimestamp = luxon.DateTime.fromISO(this.remoteConfig.timestamp);
        const rightToLeftOffset = (this.isHost ? 1 : -1) * (remoteVideoTimestamp.diff(localVideoTimestamp).milliseconds / 1000.0);
        this.loadVideo(this.isHost ? 'right-video' : 'left-video', this.remoteConfig.stream);
        this.initScrubber(rightToLeftOffset);
    }
    
    /**
     * Initializes the video scrubber UI with the correct thumbnail offsets.
     * @param {number} rightToLeftOffset - Offset between right and left video in seconds.
     */
    initScrubber(rightToLeftOffset) {
        this.rightToLeftOffset = rightToLeftOffset;
        const scrubberLeft = document.getElementById('scrubber-left');
        const scrubberRight = document.getElementById('scrubber-right');
        const offsetThumbnails = Math.ceil(this.rightToLeftOffset / this.config.thumbnailSeconds);
        scrubberLeft.src = this.isHost ? this.config.thumbnailSprite : this.remoteConfig.thumbnailSprite;
        scrubberLeft.style.setProperty('padding-left', `calc(${Math.max(0, -offsetThumbnails)} * ${this.config.thumbnailPixelWidth}px)`);
        scrubberLeft.style.setProperty('padding-right', `calc(${Math.max(0, +offsetThumbnails)} * ${this.config.thumbnailPixelWidth}px)`);
        scrubberRight.src = this.isHost ? this.remoteConfig.thumbnailSprite : this.config.thumbnailSprite;
        scrubberRight.style.setProperty('padding-left', `calc(${Math.max(0, +offsetThumbnails)} * ${this.remoteConfig.thumbnailPixelWidth}px)`);
        scrubberRight.style.setProperty('padding-right', `calc(${Math.max(0, -offsetThumbnails)} * ${this.remoteConfig.thumbnailPixelWidth}px)`);
    }
    
    /**
     * Returns an array of all video player elements.
     * @returns {Array} Array of video elements.
     */
    #getAllPlayers() {
        if(this.#areSecondariesLoaded) {
            return [this.lv, this.rv];
        } else {
            return [this.lv];
        }
    }
    
    /**
     * Updates the UI elements (timecode, playhead marker, play/pause button).
     */
    #refreshUI() {
        var timecode = `${Math.floor(this.playhead / 60).toString().padStart(2, '0')}:${Math.floor((this.playhead % 60)).toString().padStart(2, '0')}.${Math.floor((this.playhead % 1) * 10).toString().padStart(1, '0')}`;
        document.getElementById('timecode').textContent = timecode;
        const pixelOffset = this.playhead / this.config.thumbnailSeconds * this.config.thumbnailPixelWidth;
        document.getElementById('playhead-marker').style.setProperty('left', pixelOffset + 'px');
        document.getElementById('playPauseButton').innerHTML = this.isPlaying ? '&#x23F8;' : '&#x23F5';
    }
    
    /**
     * Updates the playhead position based on the player that triggered the event.
     * @param {HTMLVideoElement} movedPlayer - The player whose playhead moved.
     */
    #updatePlayhead(movedPlayer) {
        if(movedPlayer == this.#leadPlayer) {
            this.playhead = movedPlayer.currentTime;
        } else if(this.#leadPlayer.paused) {
            this.playhead = movedPlayer.currentTime + this.rightToLeftOffset;
        }
        if(this.lv.currentTime === this.lv.duration && this.rv.currentTime === this.rv.duration) {
            this.changeState({isPlaying: false});
        }
        this.#refreshUI();
    }
    
    /**
     * Registers all necessary event listeners for player elements and UI controls.
     */
    #registerEventListeners() {
        this.lv.addEventListener('durationchange', (event) => {
            if(!window.initialDurationTimerFired) {
                console.timeEnd('left-video-initial-duration');
                window.initialDurationTimerFired = true;
            }
        });
        this.lv.addEventListener('canplay', (event) => {
            if(!window.initialCanplayTimerFired) {
                console.timeEnd('left-video-initial-canplay');
                window.initialCanplayTimerFired = true;
            }
        });
        document.getElementsByClassName('scrubber')[0].addEventListener('click', (event) => {
            const x = event.offsetX;
            const thumbnailIndex = x / this.config.thumbnailPixelWidth;
            this.seek(thumbnailIndex * this.config.thumbnailSeconds);
        });
        for(const player of this.#getAllPlayers()) {
            player.addEventListener('timeupdate', (event) => {
                this.#updatePlayhead(event.target);
            });
            player.addEventListener('durationchange', (event) => {
                this.readyPlayers[event.target.id] = true;
                var foundUnready = false;
                for(const [domId, isReady] of Object.entries(this.readyPlayers)) {
                    if(!isReady) {
                        foundUnready = true;
                        break;
                    }
                }
                if(!foundUnready) {
                    if(this.allPlayersReadyEvent)
                        this.allPlayersReadyEvent();
                    this.allPlayersReadyEvent = undefined;
                }
            });
        }
    }
    
    /**
     * Sends a message to the remote peer if connected.
     * @param {Object} message - State object to send.
     */
    #syncRemotely(message) {
        if(connection) {
            connection.send(message);
        }
    }
    
    /**
     * Manages play/pause state transitions for a player.
     * @param {HTMLVideoElement} player - The video player element.
     * @param {string} newState - 'play' or 'pause'.
     */
    #managePlayState(player, newState) {
        var action = newState === 'play' ? () => {player.play()} : () => {player.pause()};
        if(this.#latestPlayPromise) {
            this.#latestPlayPromise = this.#latestPlayPromise.then(action);
        } else {
            this.#latestPlayPromise = action();
        }
    }
    
    /**
     * Synchronizes the playhead and play/pause state of all video players.
     */
    #synchronizePlayers() {
        const players = this.#getAllPlayers();
        const positions = [this.playhead, this.playhead - this.rightToLeftOffset];
        for(var i = 0; i < players.length; i++) {
            const player = players[i];
            const desiredVirtualPosition = positions[i];
            const duration = player.duration;
            const realPosition = clamp(desiredVirtualPosition, 0.0, duration);
            if(desiredVirtualPosition == realPosition) {
                if(differenceOverThreshold(player.currentTime, realPosition, 1.0)) {
                    console.log(`Seeking ${player.id} to ${realPosition}`);
                    player.currentTime = realPosition;
                }
                if(this.isPlaying && player.paused)
                    this.#managePlayState(player, 'play');
                else if(!this.isPlaying && !player.paused) {
                    this.#managePlayState(player, 'pause');
                }
            } else {
                this.#managePlayState(player, 'pause');
                console.log(`Seeking ${player.id} to ${realPosition}`);
                player.currentTime = realPosition;
            }
        }
        if((this.audioChannel == 'left' && (this.lv.muted || !this.rv.muted)) ||
           (this.audioChannel == 'right' && (this.rv.muted || !this.lv.muted))) {
            this.lv.muted = (this.audioChannel != 'left');
            this.rv.muted = (this.audioChannel == 'left');
            document.getElementById('left-audio-activate').innerHTML = (this.audioChannel !== 'left') ? '&#x1F507' : '&#128362';
            document.getElementById('right-audio-activate').innerHTML = (this.audioChannel === 'left') ? '&#x1F507' : '&#128362';
        }
    }
    
    /**
     * Applies a partial state update and synchronizes players if needed.
     * @param {Object} newPartialState - Partial state to apply.
     */
    changeState(newPartialState) {
        var hasChangesDetected = false;
        const newPlayingState = newPartialState.isPlaying;
        if(newPlayingState != undefined) {
            if(newPlayingState != this.isPlaying) {
                this.isPlaying = newPlayingState;
                hasChangesDetected = true;
            }
        }
        const newPlayhead = newPartialState.playhead;
        if(newPlayhead != undefined) {
            if(differenceOverThreshold(newPlayhead, this.playhead, PLAYHEAD_THRESHOLD)) {
                this.playhead = newPlayhead;
                hasChangesDetected = true;
            }
        }
        const newAudioChannel = newPartialState.audioChannel;
        if(newAudioChannel != undefined) {
            if(newAudioChannel != this.audioChannel) {
                this.audioChannel = newAudioChannel;
                hasChangesDetected = true;
            }
        }
        if(hasChangesDetected) {
            const newState = {isPlaying: this.isPlaying, playhead: this.playhead, audioChannel: this.audioChannel};
            if(newPartialState.remote) {
                console.log('remote changes received', newState);
            } else {
                console.log(newState);
                this.#syncRemotely(newState);
            }
            this.#synchronizePlayers();
        }
    }
    
    /**
     * Starts playback on all players.
     */
    play() { this.changeState({isPlaying: true}); }
    
    /**
     * Pauses playback on all players.
     */
    pause() { this.changeState({isPlaying: false}); }
    
    /**
     * Toggles between play and pause states.
     */
    togglePlayPause() { this.changeState({isPlaying: !this.isPlaying}); }
    
    /**
     * Seeks to a specific position in the video.
     * @param {number} position - The position to seek to.
     * @param {boolean} relative - If true, position is relative to current playhead.
     */
    seek(position, relative) { this.changeState({playhead: relative ? this.playhead + position : position}); }
    
    /**
     * Switches the active audio channel.
     * @param {string} playerSide - 'left', 'right', or 'all'.
     */
    switchAudio(playerSide) { this.changeState({audioChannel: playerSide}); }
}


// Periodically polls the server for status updates and syncs the player state.
function beginStatusPoll() {
    setInterval(() => {
        fetch('/status')
            .then((response) => response.json())
            .then((data) => {
                if(Object.keys(data).length !== 0) {
                    pm.changeState({remote: true, ...data});
                }
            });
    }, STATUS_POLL_INTERVAL);
}

// Initializes a PeerJS peer and sets up event handlers for P2P communication.
function initP2P(id, callback) {
    peer = new Peer(id, {debug: 0});
    peer.on('open', function(id) {
        console.log('My peer ID is ' + id);
        if(callback) callback(peer);
    });
    peer.on('error', function(err) {
        console.log('My', err.type, 'error is:', err);
    });
}

// Switches the UI from menu to player view.
function switchUI() {
    var elems = document.getElementsByClassName('hidden');
    Array.from(elems).forEach(elem => {
        elem.classList.remove('hidden');
    });
    for(var elem of document.getElementsByClassName('menu')) {
        elem.classList.add('hidden');
    }
}

// Begins a new session by fetching config and initializing PlayerManager and P2P.
function beginSession(isHost) {
    switchUI();
    fetch('/config')
        .then((response) => response.json())
        .then((configuration) => {
            window.pm = new PlayerManager(configuration, isHost);
            if(isHost) {
                initP2P(PEER_ID, (peer) => {
                    peer.on('connection', (conn) => {
                        conn.on('open', () => {
                            initialize(conn);
                        });
                    });
                });
            } else {
                initP2P(undefined, (peer) => {
                    conn = peer.connect(PEER_ID);
                    conn.on('open', () => {
                        initialize(conn);
                    });
                });
            }
        });
}

// Initializes the data connection and sends local config to the remote peer.
function initialize(conn) {
    connection = conn;
    console.log('My connection is ', connection);
    connection.on('data', receive);
    connection.send(pm.config);
}

// Handles data received from the remote peer (either config or state update).
function receive(data) {
    if(!pm.remoteConfig) {
        console.log('Received remote config', data);
        pm.initRemote(data);
    } else {
        pm.changeState({remote: true, ...data});
    }
}
// Media Session API handlers
navigator.mediaSession.setActionHandler('play', function() {
    console.log('Media Key Play pressed');
    pm.play();
});
navigator.mediaSession.setActionHandler('pause', function() {
    console.log('Media Key Pause pressed');
    pm.pause();
});
navigator.mediaSession.setActionHandler('seekbackward', function() {
    console.log('Media Key SeekBackward pressed');
    pm.seek(-10.0, true);
});
navigator.mediaSession.setActionHandler('previoustrack', function() {
    console.log('Media Key PreviousTrack pressed');
    pm.seek(-10.0, true);
});
navigator.mediaSession.setActionHandler('seekforward', function() {
    console.log('Media Key SeekForward pressed');
    pm.seek(+10.0, true);
});
navigator.mediaSession.setActionHandler('nexttrack', function() {
    console.log('Media Key NextTrack pressed');
    pm.seek(+10.0, true);
});
