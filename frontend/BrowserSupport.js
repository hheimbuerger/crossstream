// BrowserSupport.js
// Centralized browser compatibility checks and diagnostics overlay.
// Exports a single function `verifyBrowserSupport()` which returns `true` if
// the current browser environment is capable of running CrossStream. When
// unsupported, it renders a blocking modal with detailed diagnostics.

export function verifyBrowserSupport() {
    const results = checkHLSCapabilities();

    // If everything looks good, no need to bother the user.
    if (results.overallSupport) {
        return true;
    }

    // Otherwise render diagnostics overlay and perform deeper logging.
    const overlay = createOverlay();
    const log = createLogger(overlay.logContainer);

    // Run detailed diagnostics.
    initBrowserInfo(log);
    testBrowserCapabilities(log);

    // Summarize HLS capability results.
    log('\n=== HLS CAPABILITY SUMMARY ===', 'info');
    Object.entries(results).forEach(([key, value]) => {
        if (key === 'codecs') return; // skip large blob for now
        log(`${key}: ${value}`, value ? 'success' : 'error');
    });

    // Show codec table
    log('\nSupported codecs:', 'info');
    Object.entries(results.codecs).forEach(([codec, detail]) => {
        log(`${codec}: playType=${detail.canPlay || 'No'} | mediaSource=${detail.mediaSourceSupported} | supported=${detail.supported}`,
            detail.supported ? 'success' : 'warning');
    });

    return false;
}

// ---------------- Helper functions ----------------

function createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'unsupported-modal';

    const heading = document.createElement('h2');
    heading.textContent = 'Browser Unsupported – Detailed Diagnostics';

    const browserInfo = document.createElement('div');
    browserInfo.id = 'browserInfo';

    const hlsSupport = document.createElement('div');
    hlsSupport.id = 'hlsSupport';

    const logContainer = document.createElement('pre');
    logContainer.className = 'diagnostics-log';

    overlay.appendChild(heading);
    overlay.appendChild(browserInfo);
    overlay.appendChild(hlsSupport);
    overlay.appendChild(logContainer);

    document.body.appendChild(overlay);
    return { overlay, logContainer };
}

function createLogger(container) {
    return (message, level = 'info') => {
        const line = document.createElement('div');
        line.textContent = message;
        line.className = `log-${level}`;
        container.appendChild(line);
        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    };
}

function initBrowserInfo(log) {
    const isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
    const isChromium = /Chrome/.test(navigator.userAgent) && !/Google Inc/.test(navigator.vendor);
    const browserName = isChrome ? 'Chrome' : (isChromium ? 'Chromium' : 'Other');

    const versionMatch = navigator.userAgent.match(/Chrome\/([0-9.]+)/);
    const version = versionMatch ? versionMatch[1] : 'Unknown';

    const browserInfoEl = document.getElementById('browserInfo');
    if (browserInfoEl)
        browserInfoEl.textContent = `${browserName} ${version}`;

    log('=== HLS.JS LOADING DIAGNOSTICS ===', 'info');
    log(`typeof Hls: ${typeof Hls}`, typeof Hls !== 'undefined' ? 'success' : 'error');

    if (typeof Hls !== 'undefined') {
        log(`Hls constructor exists: ${typeof Hls === 'function'}`, 'success');
        log(`Hls.isSupported exists: ${typeof Hls.isSupported === 'function'}`, 'success');

        if (typeof Hls.isSupported === 'function') {
            try {
                const supported = Hls.isSupported();
                log(`Hls.isSupported() result: ${supported}`, supported ? 'success' : 'error');

                // Check underlying MediaSource availability
                log(`MediaSource available: ${typeof MediaSource !== 'undefined'}`, 'info');
                log(`MediaSource.isTypeSupported exists: ${typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function'}`, 'info');

                if (typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function') {
                    const mp4Support = MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"');
                    log(`MediaSource MP4 support: ${mp4Support}`, mp4Support ? 'success' : 'error');
                }
            } catch (e) {
                log(`Error calling Hls.isSupported(): ${e.message}`, 'error');
            }
        } else {
            log('Hls.isSupported is not a function!', 'error');
        }
    } else {
        log('Hls is not defined - script may not have loaded', 'error');
        log('Checking script tag...', 'info');
        const scriptTags = document.querySelectorAll('script[src*="hls"]');
        log(`Found ${scriptTags.length} HLS script tags`, 'info');
        scriptTags.forEach((script, i) => {
            log(`Script ${i}: ${script.src}`, 'info');
        });
    }

    // Native vs Hls.js support quick summary
    const video = document.createElement('video');
    const nativeSupport = video.canPlayType('application/vnd.apple.mpegurl');
    const hlsJsSupport = typeof Hls !== 'undefined' && typeof Hls.isSupported === 'function' && Hls.isSupported();

    const hlsSupportEl = document.getElementById('hlsSupport');
    if (hlsSupportEl)
        hlsSupportEl.innerHTML = `Native: ${nativeSupport || 'No'}<br>HLS.js: ${hlsJsSupport ? 'Yes' : 'No'}`;

    log('=== END HLS.JS DIAGNOSTICS ===', 'info');
}

function testBrowserCapabilities(log) {
    log('=== BROWSER CAPABILITY TEST ===', 'info');

    const video = document.createElement('video');
    const codecs = [
        'video/mp4; codecs="avc1.42E01E"',
        'video/mp4; codecs="avc1.640028"',
        'video/mp4; codecs="hev1.1.6.L93.B0"',
        'video/mp4; codecs="hvc1.1.6.L93.B0"',
        'video/webm; codecs="vp9"',
        'video/webm; codecs="vp8"'
    ];

    codecs.forEach(codec => {
        const support = video.canPlayType(codec);
        log(`Codec ${codec}: ${support || 'No'}`, support ? 'success' : 'warning');
    });

    log(`MediaSource support: ${typeof MediaSource !== 'undefined' ? 'Yes' : 'No'}`, typeof MediaSource !== 'undefined' ? 'success' : 'error');
    log(`Fetch API support: ${typeof fetch !== 'undefined' ? 'Yes' : 'No'}`, typeof fetch !== 'undefined' ? 'success' : 'error');
    log('=== END CAPABILITY TEST ===', 'info');
}

function checkHLSCapabilities() {
    const results = {
        hlsJsLoaded: typeof Hls !== 'undefined',
        hlsJsSupported: false,
        nativeHLS: false,
        mediaSource: typeof MediaSource !== 'undefined',
        codecs: {},
        overallSupport: false
    };

    if (results.hlsJsLoaded) {
        results.hlsJsSupported = typeof Hls.isSupported === 'function' ? Hls.isSupported() : false;
    }

    const video = document.createElement('video');
    results.nativeHLS = !!video.canPlayType('application/vnd.apple.mpegurl');

    const codecsToTest = [
        'video/mp4; codecs="avc1.42E01E"',
        'video/mp4; codecs="avc1.640028"',
        'audio/mp4; codecs="mp4a.40.2"',
        'video/webm; codecs="vp9"',
        'audio/webm; codecs="opus"'
    ];

    codecsToTest.forEach(codec => {
        const canPlay = video.canPlayType(codec);
        const msSupported = results.mediaSource ? MediaSource.isTypeSupported(codec) : false;
        results.codecs[codec] = {
            canPlay,
            mediaSourceSupported: msSupported,
            supported: canPlay !== '' || msSupported
        };
    });

    const hasH264 = results.codecs['video/mp4; codecs="avc1.42E01E"'].supported ||
                    results.codecs['video/mp4; codecs="avc1.640028"'].supported;
    const hasAAC = results.codecs['audio/mp4; codecs="mp4a.40.2"'].supported;
    const hasVP9 = results.codecs['video/webm; codecs="vp9"'].supported;

    results.overallSupport = results.mediaSource &&
        (results.nativeHLS || results.hlsJsSupported) &&
        (hasH264 && hasAAC);

    return results;
}
