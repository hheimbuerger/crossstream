// --- Imports ---
import { DualVideoPlayer } from './DualVideoPlayer.js';
import { PeerConnection } from './PeerConnection.js';
import { SynchronizationEngine } from './SynchronizationEngine.js';
import { verifyBrowserSupport } from './BrowserSupport.js';
import { UI } from './UI.js';
import bus from './EventBus.js';

// --- Constants ---
// const SESSION_ID = 'crossstream-dev'; // Fixed session ID for now
const urlParams = new URLSearchParams(window.location.search);
const SESSION_ID = urlParams.get('session') || 'crossstream-dev';

// --- State ---
let peerConnection = null;
let dualVideoPlayer = null;
let ui = null;
let syncEngine = null;

// --- PeerConnection Setup ---
function setupPeerConnection(localConfig) {
    ui.showLoading('Connecting to peer...');

    // Clean up any existing instances
    if (peerConnection) {
        peerConnection.disconnect();
        peerConnection = null;
    }

    // Instantiate without callbacks (event bus will be used)
    peerConnection = new PeerConnection(SESSION_ID, localConfig);

    // --- PeerConnection Bus Listeners ---
    const onPeerConfig = (remoteConfig) => {
        ui.hideLoading();
        setupDualVideoPlayer(localConfig, remoteConfig);
    };

    // Handle ungraceful disconnects/errors
    const onPeerTerminated = (error) => {
        ui.showError('Connection lost unexpectedly: ' + error.message);
        ui.hideLoading();
        cleanup();
    };

    // Handle graceful disconnects
    const onPeerDisconnected = () => {
        ui.showError('Connection to peer closed. Waiting for reconnection...');
        cleanup();
    };

    bus.on('peerConfig', onPeerConfig);
    bus.on('peerTerminated', onPeerTerminated);
    bus.on('peerDisconnected', onPeerDisconnected);

    // Cleanup listeners when peerConnection disconnects / app cleans up
    const cleanupRemoteBus = () => {
        bus.off('peerConfig', onPeerConfig);
        bus.off('peerDisconnected', onPeerDisconnected);
    };

    // Store cleanup function
    const originalDisconnect = peerConnection.disconnect.bind(peerConnection);
    peerConnection.disconnect = () => {
        cleanupRemoteBus();
        originalDisconnect();
    };
}

// --- DualVideoPlayer Setup ---
function setupDualVideoPlayer(localConfig, remoteConfig) {
    ui.showLoading('Initializing video player...');

    // Clean up existing synchronizer if any
    dualVideoPlayer?.destroy();

    try {
        // Initialize the DualVideoPlayer with video elements and configs
        dualVideoPlayer = new DualVideoPlayer(
            ui.elements.localVideo,
            localConfig,
            ui.elements.remoteVideo,
            remoteConfig
        );

        // Hide loading indicator now that setup is complete
        ui.hideLoading();

        // Initialize UI with initial state
        ui.updatePlayPauseButton(false);

    } catch (error) {
        console.error('Failed to initialize dual video player:', error);
        ui.showError('Failed to initialize video playback: ' + error.message);
        ui.hideLoading();
    }
}

// --- Initialization ---
function loadConfig() {
    // Load configuration from the server or use default
    return fetch('/config')
        .then(response => response.json())
        .catch(error => {
            console.error('Failed to load config:', error);
            ui.showError('Failed to load configuration: ' + error.message);
            throw error;
        });
}

async function initializeApp() {
    if (!verifyBrowserSupport()) {
        return; // Unsupported: modal already shown by BrowserSupport module.
    }

    try {
        // Initialize UI (event handling uses central EventBus now)
        ui = new UI();

        // set up SynchronizationEngine
        syncEngine = new SynchronizationEngine(() => dualVideoPlayer, () => peerConnection);

        // Load configuration and initialize peer connection
        const localConfig = await loadConfig();
        setupPeerConnection(localConfig);

        // Set up beforeunload handler
        window.addEventListener('beforeunload', () => {
            if (peerConnection) peerConnection.disconnect();
        });
        window.addEventListener('unload', () => {
            if (peerConnection) peerConnection.disconnect();
        });

    } catch (error) {
        console.error('Failed to initialize app:', error);
        if (ui) {
            ui.showError('Failed to initialize application: ' + error.message);
        }
    }
}

// --- Cleanup Functions ---
function cleanup() {
    // Clean up dual video player
    dualVideoPlayer.destroy();
    dualVideoPlayer = null;

    // Clean up peer connection
    peerConnection.disconnect();
    peerConnection = null;

    // Clean up UI (includes scrubber cleanup)
    ui.cleanup();
    ui = null;
}

// Start the application
document.addEventListener('DOMContentLoaded', initializeApp);
