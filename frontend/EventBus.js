// EventBus.js - Centralized event bus using mitt loaded from a CDN.
// mitt is included globally via a <script> tag in player.html, so we access it
// from the global scope. If mitt is exposed as an ES module default export we
// fall back to window.mitt.

// Create a singleton event bus
const emitterFactory = (window.mitt || (typeof mitt !== 'undefined' ? mitt : null));
if (!emitterFactory) {
    throw new Error('mitt library is not loaded. Make sure the <script src="https://unpkg.com/mitt/dist/mitt.umd.js"></script> tag is included before loading the application scripts.');
}

// Create the base emitter
const emitter = emitterFactory();

// Create a proxy to intercept all event emissions
const bus = new Proxy(emitter, {
    get(target, prop) {
        // Intercept 'on' and 'off' to log subscriptions
        if (prop === 'on' || prop === 'off') {
            return function(event, handler) {
                console.debug(`[EventBus] ${prop.toUpperCase()} '${event}'`, { handler: handler?.name || 'anonymous' });
                return target[prop](event, handler);
            };
        }
        // Intercept 'emit' to log all events
        if (prop === 'emit') {
            return function(event, ...args) {
                if (event === 'error') {
                    console.error('[EventBus] ERROR', ...args);
                } else {
                    console.debug(`[EventBus] EMIT '${event}'`, ...args);
                }
                return target.emit(event, ...args);
            };
        }
        // Pass through other methods and properties
        return target[prop];
    }
});

export default bus;
