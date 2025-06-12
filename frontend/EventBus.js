// EventBus.js - Centralized event bus using mitt loaded from a CDN.
// mitt is included globally via a <script> tag in player.html, so we access it
// from the global scope. If mitt is exposed as an ES module default export we
// fall back to window.mitt.

// Create a singleton event bus
const emitterFactory = (window.mitt || (typeof mitt !== 'undefined' ? mitt : null));
if (!emitterFactory) {
    throw new Error('mitt library is not loaded. Make sure the <script src="https://unpkg.com/mitt/dist/mitt.umd.js"></script> tag is included before loading the application scripts.');
}

const bus = emitterFactory();

export default bus;
