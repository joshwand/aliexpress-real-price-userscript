// ==UserScript==
// @name         AliExpress Real Price
// @namespace    https://github.com/joshwand/aliexpress-real-price-userscript
// @version      1.0.0
// @description  Shows true prices including shipping and variants on AliExpress, since sellers often misleadingly put accessory variants as the primary price, not the advertised item. 
// @author       Josh Wand
// @license      GPL-3.0-or-later
// @copyright    2025 Josh Wand
// @match        *://*.aliexpress.com/*
// @match        *://*.aliexpress.us/*
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.cookie
// @connect      aliexpress.us
// @connect      aliexpress.com
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // --- Global Cache Disable Flag ---
    let isCacheDisabled = false;

    // Debug logging utility
    const DEBUG = true;
    const log = (...args) => {
        if (DEBUG) {
            const productId = args.find(arg => typeof arg === 'object' && arg?.productId)?.productId || '';
            console.log(`[AliExpress Real Price${productId ? ` - ID:${productId}` : ''}]`, ...args);
        }
    };

    // Rate limiter for API calls
    class RateLimiter {
        constructor(maxRequests = 2, timeWindow = 1000) {
            this.maxRequests = maxRequests;
            this.timeWindow = timeWindow;
            this.requests = [];
            this.backoffTime = 1000; // Start with 1 second backoff
            this.maxBackoffTime = 32000; // Max backoff of 32 seconds
        }

        async waitForSlot() {
            // Remove old requests outside the time window
            const now = Date.now();
            this.requests = this.requests.filter(time => now - time < this.timeWindow);

            // If we have capacity, add the request
            if (this.requests.length < this.maxRequests) {
                this.requests.push(now);
                return;
            }

            // Wait for the oldest request to expire
            const oldestRequest = this.requests[0];
            const waitTime = this.timeWindow - (now - oldestRequest);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.waitForSlot();
        }

        async executeWithBackoff(fn) {
            while (true) {
                try {
                    await this.waitForSlot();
                    const result = await fn();
                    this.backoffTime = 1000; // Reset backoff on success
                    return result;
                } catch (error) {
                    if (error.message?.includes('FAIL_SYS_ILLEGAL_ACCESS')) {
                        log(`Rate limit exceeded, backing off for ${this.backoffTime}ms`);
                        await new Promise(resolve => setTimeout(resolve, this.backoffTime));
                        this.backoffTime = Math.min(this.backoffTime * 2, this.maxBackoffTime);
                        continue;
                    }
                    throw error;
                }
            }
        }
    }

    // Loading Manager for global progress
    class LoadingManager {
        constructor() {
            this.totalItems = 0;
            this.completedItems = 0;
            this.createElements();
            this.addStyles(); // Add styles for the elements
        }

        createElements() {
            // Create main container for status text and clear button
            this.container = document.createElement('div');
            this.container.className = 'ali-real-price-status-container';
            // this.container.title = 'AliExpress Real Price UserScript';

            // Create icon container for collapsed state
            this.iconContainer = document.createElement('div');
            this.iconContainer.className = 'ali-real-price-icon';
            this.iconContainer.innerHTML = '🐟'; // Fish icon - because the prices are fishy
            this.iconContainer.title = 'Hmm, something is fishy here...';
            this.container.appendChild(this.iconContainer);

            // Create expandable content container
            this.expandableContent = document.createElement('div');
            this.expandableContent.className = 'ali-real-price-expandable-content';

            // Create status text
            this.statusText = document.createElement('div');
            this.statusText.className = 'ali-real-price-status';
            this.expandableContent.appendChild(this.statusText);

            // Create settings container with disclosure arrow
            this.settingsContainer = document.createElement('div');
            this.settingsContainer.className = 'ali-real-price-settings-container';

            // Add disclosure arrow
            this.disclosureArrow = document.createElement('span');
            this.disclosureArrow.className = 'ali-real-price-disclosure-arrow collapsed';
            
            // Create a separate text node for the arrow symbol
            this.arrowSymbol = document.createTextNode('▶');
            this.disclosureArrow.appendChild(this.arrowSymbol);
            this.disclosureArrow.title = 'Advanced Options';

            // Create custom tooltip
            this.tooltip = document.createElement('div');
            this.tooltip.className = 'ali-real-price-tooltip';
            this.tooltip.textContent = 'Advanced Options';
            this.disclosureArrow.appendChild(this.tooltip);

            // Restore click handler
            this.disclosureArrow.onclick = () => {
                const container = this.settingsContainer;
                const isExpanding = !container.classList.contains('expanded');
                container.classList.toggle('expanded');
                this.disclosureArrow.classList.toggle('collapsed');
                this.arrowSymbol.nodeValue = isExpanding ? '▼' : '▶';
            };

            // Remove default title to prevent both tooltips
            this.disclosureArrow.removeAttribute('title');

            this.expandableContent.appendChild(this.disclosureArrow);

            // Settings content (initially hidden)
            this.settingsContent = document.createElement('div');
            this.settingsContent.className = 'ali-real-price-settings-content';

            // --- Create Clear Cache button ---
            this.clearCacheButton = document.createElement('span');
            this.clearCacheButton.className = 'ali-real-price-clear-cache';
            this.clearCacheButton.textContent = 'Clear Cache';
            this.clearCacheButton.onclick = async () => {
                await clearCacheAndReload();
            };
            this.settingsContent.appendChild(this.clearCacheButton);

            // --- Create Disable Cache Checkbox --- 
            this.disableCacheContainer = document.createElement('div');
            this.disableCacheContainer.className = 'ali-real-price-disable-cache-container';

            this.disableCacheCheckbox = document.createElement('input');
            this.disableCacheCheckbox.type = 'checkbox';
            this.disableCacheCheckbox.id = 'ali-real-price-disable-cache-checkbox';
            this.disableCacheCheckbox.className = 'ali-real-price-disable-cache-checkbox';
            log(`[LoadingManager.createElements] Setting checkbox state based on isCacheDisabled: ${isCacheDisabled}`);
            this.disableCacheCheckbox.checked = isCacheDisabled;
            this.disableCacheCheckbox.addEventListener('change', handleDisableCacheChange);

            this.disableCacheLabel = document.createElement('label');
            this.disableCacheLabel.htmlFor = 'ali-real-price-disable-cache-checkbox';
            this.disableCacheLabel.textContent = 'Disable Cache';
            this.disableCacheLabel.className = 'ali-real-price-disable-cache-label';

            this.disableCacheContainer.appendChild(this.disableCacheCheckbox);
            this.disableCacheContainer.appendChild(this.disableCacheLabel);
            this.settingsContent.appendChild(this.disableCacheContainer);

            // Add settings content to settings container
            this.settingsContainer.appendChild(this.settingsContent);
            this.expandableContent.appendChild(this.settingsContainer);

            // Add expandable content to main container
            this.container.appendChild(this.expandableContent);

            document.body.appendChild(this.container);

            // Add hover behavior
            this.container.addEventListener('mouseenter', () => {
                this.container.classList.add('expanded');
            });

            this.container.addEventListener('mouseleave', () => {
                // Only collapse if we're done loading AND the mouse isn't in the container
                if (this.completedItems >= this.totalItems && !this.container.matches(':hover')) {
                    this.container.classList.remove('expanded');
                    // Also collapse settings if expanded
                    this.settingsContainer.classList.remove('expanded');
                    this.disclosureArrow.classList.add('collapsed');
                    this.arrowSymbol.nodeValue = '▶';
                }
            });
        }

        // Add CSS styles
        addStyles() {
            const existingStyle = document.getElementById('ali-real-price-styles');
            if (existingStyle) {
                existingStyle.remove();
            }

            const styleElement = document.createElement('style');
            styleElement.id = 'ali-real-price-styles';
            styleElement.textContent = `
                .ali-real-price-status-container {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    z-index: 99999;
                    background-color: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 8px;
                    border-radius: 4px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                    transition: all 0.3s ease;
                    cursor: pointer;
                    display: flex; /* Use flexbox by default */
                    align-items: flex-start; /* Align items to top */
                    gap: 8px; /* Space between icon and content */
                    visibility: hidden; /* Use visibility instead of display: none */
                    opacity: 0;
                }

                .ali-real-price-status-container.visible {
                    visibility: visible;
                    opacity: 1;
                }

                .ali-real-price-icon {
                    font-size: 16px;
                    flex-shrink: 0; /* Prevent icon from shrinking */
                }

                .ali-real-price-expandable-content {
                    display: none;
                    flex-grow: 1; /* Allow content to grow */
                    min-width: 0; /* Allow content to shrink if needed */
                }

                .ali-real-price-status-container.expanded .ali-real-price-expandable-content {
                    display: block;
                }

                .ali-real-price-status {
                    font-size: 12px;
                    margin-right: 10px;
                    display: inline-block;
                }

                .ali-real-price-disclosure-arrow {
                    font-size: 10px;
                    margin-left: 5px;
                    cursor: pointer;
                    color: #666;
                    position: relative;
                }

                .ali-real-price-tooltip {
                    position: absolute;
                    background: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 11px;
                    white-space: nowrap;
                    pointer-events: none;
                    opacity: 0;
                    transition: opacity 0.15s;
                    top: 100%;
                    margin-top: 4px;
                    right: 0;
                }

                /* Show tooltip on hover when collapsed (default state) */
                .ali-real-price-disclosure-arrow.collapsed:hover .ali-real-price-tooltip {
                    opacity: 1;
                }

                /* Hide tooltip when expanded */
                .ali-real-price-disclosure-arrow:hover .ali-real-price-tooltip {
                    opacity: 0;
                }

                /* Add a small arrow at the bottom of the tooltip */
                .ali-real-price-tooltip:after {
                    content: '';
                    position: absolute;
                    top: -4px;
                    right: 2px;
                    border-width: 0 4px 4px 4px;
                    border-style: solid;
                    border-color: transparent transparent rgba(0, 0, 0, 0.8) transparent;
                }

                .ali-real-price-settings-container {
                    margin-top: 5px;
                }

                .ali-real-price-settings-content {
                    display: none;
                    margin-top: 5px;
                    padding-top: 5px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                }

                .ali-real-price-settings-container.expanded .ali-real-price-settings-content {
                    display: block;
                }

                .ali-real-price-clear-cache {
                    color: #ffc107;
                    font-size: 11px;
                    cursor: pointer;
                    text-decoration: underline;
                    display: block;
                    margin-bottom: 5px;
                }

                .ali-real-price-clear-cache:hover {
                    color: #ffa000;
                }

                .ali-real-price-disable-cache-container {
                    display: flex;
                    align-items: center;
                    margin-top: 5px;
                }

                .ali-real-price-disable-cache-checkbox {
                    margin: 0 5px 0 0;
                    cursor: pointer;
                }

                .ali-real-price-disable-cache-label {
                    font-size: 11px;
                    color: #ccc;
                    cursor: pointer;
                    user-select: none;
                }
            `;
            document.head.appendChild(styleElement);
        }

        startLoading(totalItems) {
            this.totalItems = totalItems;
            this.updateProgress();
            this.container.classList.add('visible');
            this.container.classList.remove('expanded');
        }

        itemComplete() {
            log(`[itemComplete] Before increment: completed=${this.completedItems}, total=${this.totalItems}`);
            this.completedItems++;
            // If completedItems exceeds totalItems, update totalItems
            if (this.completedItems > this.totalItems) {
                this.totalItems = this.completedItems;
            }
            log(`[itemComplete] After increment: completed=${this.completedItems}, total=${this.totalItems}`);
            this.updateProgress();

            if (this.completedItems >= this.totalItems) {
                // When complete, only collapse if mouse isn't in the container
                if (!this.container.matches(':hover')) {
                    this.container.classList.remove('expanded');
                }
            }
        }

        updateProgress() {
            log(`[updateProgress] Updating text: completed=${this.completedItems}, total=${this.totalItems}`);
            this.statusText.textContent = `Loading prices: ${this.completedItems}/${this.totalItems}`;
            // Show expanded state while loading
            if (this.completedItems < this.totalItems) {
                this.container.classList.add('expanded');
            }
        }
    }

    // Global loading manager instance
    const loadingManager = new LoadingManager();

    // Global rate limiter instance
    const rateLimiter = new RateLimiter();

    // Global cache instance
    let globalCache;

    // Function to clear cache and reload
    async function clearCacheAndReload() {
        try {
            if (globalCache) {
                log('Clearing cache...');
                await globalCache.clear();
                alert('AliExpress Real Price cache cleared. Reloading page.');
                window.location.reload();
            } else {
                log('Cache instance not found');
                alert('Cache instance not found.');
            }
        } catch (error) {
            log('Error clearing cache:', error);
            alert('Error clearing cache. See console for details.');
        }
    }

    log('Script starting...');

    // MD5 implementation for sign generation
    function md5(string) {
        function cmn(q, a, b, x, s, t) {
            a = add32(add32(a, q), add32(x, t));
            return add32((a << s) | (a >>> (32 - s)), b);
        }

        function ff(a, b, c, d, x, s, t) {
            return cmn((b & c) | ((~b) & d), a, b, x, s, t);
        }

        function gg(a, b, c, d, x, s, t) {
            return cmn((b & d) | (c & (~d)), a, b, x, s, t);
        }

        function hh(a, b, c, d, x, s, t) {
            return cmn(b ^ c ^ d, a, b, x, s, t);
        }

        function ii(a, b, c, d, x, s, t) {
            return cmn(c ^ (b | (~d)), a, b, x, s, t);
        }

        function md5cycle(x, k) {
            let a = x[0], b = x[1], c = x[2], d = x[3];

            a = ff(a, b, c, d, k[0], 7, -680876936);
            d = ff(d, a, b, c, k[1], 12, -389564586);
            c = ff(c, d, a, b, k[2], 17, 606105819);
            b = ff(b, c, d, a, k[3], 22, -1044525330);
            a = ff(a, b, c, d, k[4], 7, -176418897);
            d = ff(d, a, b, c, k[5], 12, 1200080426);
            c = ff(c, d, a, b, k[6], 17, -1473231341);
            b = ff(b, c, d, a, k[7], 22, -45705983);
            a = ff(a, b, c, d, k[8], 7, 1770035416);
            d = ff(d, a, b, c, k[9], 12, -1958414417);
            c = ff(c, d, a, b, k[10], 17, -42063);
            b = ff(b, c, d, a, k[11], 22, -1990404162);
            a = ff(a, b, c, d, k[12], 7, 1804603682);
            d = ff(d, a, b, c, k[13], 12, -40341101);
            c = ff(c, d, a, b, k[14], 17, -1502002290);
            b = ff(b, c, d, a, k[15], 22, 1236535329);

            a = gg(a, b, c, d, k[1], 5, -165796510);
            d = gg(d, a, b, c, k[6], 9, -1069501632);
            c = gg(c, d, a, b, k[11], 14, 643717713);
            b = gg(b, c, d, a, k[0], 20, -373897302);
            a = gg(a, b, c, d, k[5], 5, -701558691);
            d = gg(d, a, b, c, k[10], 9, 38016083);
            c = gg(c, d, a, b, k[15], 14, -660478335);
            b = gg(b, c, d, a, k[4], 20, -405537848);
            a = gg(a, b, c, d, k[9], 5, 568446438);
            d = gg(d, a, b, c, k[14], 9, -1019803690);
            c = gg(c, d, a, b, k[3], 14, -187363961);
            b = gg(b, c, d, a, k[8], 20, 1163531501);
            a = gg(a, b, c, d, k[13], 5, -1444681467);
            d = gg(d, a, b, c, k[2], 9, -51403784);
            c = gg(c, d, a, b, k[7], 14, 1735328473);
            b = gg(b, c, d, a, k[12], 20, -1926607734);

            a = hh(a, b, c, d, k[5], 4, -378558);
            d = hh(d, a, b, c, k[8], 11, -2022574463);
            c = hh(c, d, a, b, k[11], 16, 1839030562);
            b = hh(b, c, d, a, k[14], 23, -35309556);
            a = hh(a, b, c, d, k[1], 4, -1530992060);
            d = hh(d, a, b, c, k[4], 11, 1272893353);
            c = hh(c, d, a, b, k[7], 16, -155497632);
            b = hh(b, c, d, a, k[10], 23, -1094730640);
            a = hh(a, b, c, d, k[13], 4, 681279174);
            d = hh(d, a, b, c, k[0], 11, -358537222);
            c = hh(c, d, a, b, k[3], 16, -722521979);
            b = hh(b, c, d, a, k[6], 23, 76029189);
            a = hh(a, b, c, d, k[9], 4, -640364487);
            d = hh(d, a, b, c, k[12], 11, -421815835);
            c = hh(c, d, a, b, k[15], 16, 530742520);
            b = hh(b, c, d, a, k[2], 23, -995338651);

            a = ii(a, b, c, d, k[0], 6, -198630844);
            d = ii(d, a, b, c, k[7], 10, 1126891415);
            c = ii(c, d, a, b, k[14], 15, -1416354905);
            b = ii(b, c, d, a, k[5], 21, -57434055);
            a = ii(a, b, c, d, k[12], 6, 1700485571);
            d = ii(d, a, b, c, k[3], 10, -1894986606);
            c = ii(c, d, a, b, k[10], 15, -1051523);
            b = ii(b, c, d, a, k[1], 21, -2054922799);
            a = ii(a, b, c, d, k[8], 6, 1873313359);
            d = ii(d, a, b, c, k[15], 10, -30611744);
            c = ii(c, d, a, b, k[6], 15, -1560198380);
            b = ii(b, c, d, a, k[13], 21, 1309151649);
            a = ii(a, b, c, d, k[4], 6, -145523070);
            d = ii(d, a, b, c, k[11], 10, -1120210379);
            c = ii(c, d, a, b, k[2], 15, 718787259);
            b = ii(b, c, d, a, k[9], 21, -343485551);

            x[0] = add32(a, x[0]);
            x[1] = add32(b, x[1]);
            x[2] = add32(c, x[2]);
            x[3] = add32(d, x[3]);
        }

        function md5blk(s) {
            let i, md5blks = [];
            for (i = 0; i < 64; i += 4) {
                md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
            }
            return md5blks;
        }

        function md5blk_array(a) {
            let i, md5blks = [];
            for (i = 0; i < 64; i += 4) {
                md5blks[i >> 2] = a[i] + (a[i + 1] << 8) + (a[i + 2] << 16) + (a[i + 3] << 24);
            }
            return md5blks;
        }

        function md51(s) {
            let n = s.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
            for (i = 64; i <= s.length; i += 64) {
                md5cycle(state, md5blk(s.substring(i - 64, i)));
            }
            s = s.substring(i - 64);
            let tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (i = 0; i < s.length; i++) {
                tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
            }
            tail[i >> 2] |= 0x80 << ((i % 4) << 3);
            if (i > 55) {
                md5cycle(state, tail);
                for (i = 0; i < 16; i++) tail[i] = 0;
            }
            tail[14] = n * 8;
            md5cycle(state, tail);
            return state;
        }

        function md51_array(a) {
            let n = a.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
            for (i = 64; i <= a.length; i += 64) {
                md5cycle(state, md5blk_array(a.subarray(i - 64, i)));
            }
            a = (i - 64) < a.length ? a.subarray(i - 64) : new Uint8Array(0);
            let tail = new Uint8Array(64), len = a.length;
            for (i = 0; i < len; i++) {
                tail[i] = a[i];
            }
            tail[len] = 0x80;
            if (len > 55) {
                md5cycle(state, tail.subarray(0, 64));
                for (i = 0; i < 64; i++) tail[i] = 0;
            }
            for (i = 0; i < 8; i++) tail[56 + i] = (n * 8) >>> (i * 8) & 0xff;
            md5cycle(state, tail);
            return state;
        }

        function hex_chr(n) {
            return '0123456789abcdef'.charAt(n);
        }

        function rhex(n) {
            let s = '', j = 0;
            for (; j < 4; j++) {
                s += hex_chr((n >> (j * 8 + 4)) & 0x0F) + hex_chr((n >> (j * 8)) & 0x0F);
            }
            return s;
        }

        function hex(x) {
            for (let i = 0; i < x.length; i++) {
                x[i] = rhex(x[i]);
            }
            return x.join('');
        }

        function add32(a, b) {
            return (a + b) & 0xFFFFFFFF;
        }

        if (typeof string !== 'string') string = '';
        let result;
        if (/[\x80-\xFF]/.test(string)) {
            result = hex(md51(unescape(encodeURIComponent(string))));
        } else {
            result = hex(md51(string));
        }
        return result;
    }

    // CSS Styles
    const STYLES = `
        .ali-real-price-range {
            font-weight: bold;
            color: #333;
        }

        .ali-real-price-global-loading {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            background: #2196F3;
            height: 3px;
            z-index: 10000;
            transition: width 0.3s ease-out;
        }

        .ali-real-price-global-status {
            position: fixed;
            top: 3px;
            right: 10px;
            background: rgba(33, 150, 243, 0.9);
            color: white;
            padding: 8px 12px;
            border-radius: 0 0 4px 4px;
            font-size: 12px;
            z-index: 10000;
            transition: opacity 0.3s ease-out;
        }

        .ali-real-price-median-indicator {
            color: #2196F3;
            margin-left: 4px;
        }

        .ali-real-price-distribution {
            height: 4px;
            background: #eee;
            margin: 2px 0;
            position: relative;
        }

        .ali-real-price-distribution-marker {
            position: absolute;
            width: 2px;
            height: 8px;
            background: #2196F3;
            top: -2px;
        }

        .ali-real-price-popup {
            position: absolute;
            z-index: 1000;
            background: white;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            padding: 12px;
            width: 280px;
            font-size: 12px;
            line-height: 1.5;
        }

        .ali-real-price-popup ul {
            list-style: none;
            padding: 0;
            margin: 0 0 10px 0;
        }

        .ali-real-price-popup li {
            padding: 4px 0;
            border-bottom: 1px solid #f5f5f5;
        }

        .ali-real-price-popup li.median-match {
            font-weight: bold;
            color: #2196F3;
        }

        .ali-real-price-popup .free-shipping-threshold {
            font-style: italic;
            color: #4CAF50;
            margin-top: 8px;
        }
    `;

    // Cache configuration
    const CACHE_CONFIG = {
        variants: { duration: 86400000, maxEntries: 100 },  // 24 hours
        shipping: { duration: 86400000, maxEntries: 100 },  // 24 hours
        context: { duration: 86400000, maxEntries: 10 }      // 24 hours
    };

    // DOM Selectors
    const SELECTORS = {
        productCard: [
            '.search-card-item',         // Main search results
            '.lq_b.io_it',              // Alternative class combination
            '.comet-v2-list-item',      // Keep some old selectors as fallback
            '.comet-v2-product-card',
            'div[class*="ProductItem"]',
            'div[class*="product-card"]',
            'div[class*="card-out-wrapper"]'
        ].join(','),
        price: [
            '.lq_j3',                   // Main price container
            '.lq_et',                   // Price wrapper
            '.l5_k6',
            '.U-S0j',
            'div[class*="price-current"]',
            'div[class*="PriceText"]',
            'div[class*="productPrice"]',
            'div[class*="price"]',      // More generic fallbacks
            'span[class*="price"]',
            '[data-price]',             // Data attribute
            '[data-product-price]'
        ].join(','),
        title: [
            '.lq_jl',                   // Product title
            '.lq_ae h3'                 // Title wrapper
        ].join(','),
        shipping: [
            '.lq_lv',                   // Shipping info
            '.mi_l6[title*="shipping"]' // Shipping text
        ].join(','),
        discount: [
            '.lq_eu',                   // Discount percentage
            '.lq_j4'                    // Original price
        ].join(','),
        relatedItems: [
            '.pdp-recommend-item',
            '.recommend-item',
            '.bundle-item',
            'div[class*="RecommendItem"]'
        ].join(','),
        variants: [
            '.sku-property-item',
            '.sku-property-text',
            '.sku-property-image',
            'div[class*="SkuItem"]'
        ].join(',')
    };

    // Utility functions
    const utils = {
        extractProductId(element) {
            // Try multiple methods to find the product ID
            const methods = [
                // Method 1: New URL pattern (from your example)
                () => {
                    const link = element.getAttribute('href');
                    if (!link) return null;
                    const match = link.match(/item\/(\d+)\.html/);
                    return match ? match[1] : null;
                },
                // Method 2: Legacy pattern
                () => {
                    const link = element.querySelector('a[href*="/item/"]');
                    if (!link) return null;
                    const match = link.href.match(/\/(\d+)\.html/);
                    return match ? match[1] : null;
                },
                // Method 3: Data attribute
                () => {
                    return element.getAttribute('data-product-id') || 
                           element.getAttribute('data-item-id') ||
                           element.getAttribute('data-id');
                }
            ];

            // Try each method until we find a product ID
            for (const method of methods) {
                const id = method();
                if (id) {
                    log('Found product ID:', id, { productId: id });
                    return id;
                }
            }

            log('Could not find product ID for element:', element);
            return null;
        },

        formatPrice(value, currency = 'USD') {
            return new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: currency
            }).format(value);
        },

        delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        // Get cookie by name
        getCookie(name) {
            const cookies = document.cookie.split(';');
            for (let i = 0; i < cookies.length; i++) {
                const cookie = cookies[i].trim();
                if (cookie.startsWith(name + '=')) {
                    return cookie.substring(name.length + 1);
                }
            }
            return '';
        },

        // Generate sign for API requests
        generateSign(token, timestamp, appKey, data) {
            const signStr = `${token}&${timestamp}&${appKey}&${data}`;
            return md5(signStr);
        }
    };

    // Cache Manager
    class CacheManager {
        constructor() {
            this.cache = new Map();
            // Load immediately, respecting the flag set during init
            this.loadFromStorage();
        }

        async loadFromStorage() {
            if (isCacheDisabled) {
                log('Cache is disabled, skipping load from storage.');
                this.cache.clear();
                return;
            }
            try {
                const storedCache = await GM.getValue('aliexpress_cache', null);
                if (storedCache) {
                    const parsed = JSON.parse(storedCache);
                    // Only load non-expired entries
                    Object.entries(parsed).forEach(([key, entry]) => {
                        if (Date.now() <= entry.expiresAt) {
                            this.cache.set(key, entry);
                        }
                    });
                    log('Loaded cache from storage:', this.cache.size, 'entries');
                }
            } catch (error) {
                log('Error loading cache from storage:', error);
            }
        }

        async saveToStorage() {
            if (isCacheDisabled) {
                // log('Cache is disabled, skipping save to storage.'); // Maybe too noisy
                return; // Don't save if cache is disabled
            }
            try {
                // Convert Map to object for storage
                const cacheObj = {};
                this.cache.forEach((value, key) => {
                    cacheObj[key] = value;
                });
                await GM.setValue('aliexpress_cache', JSON.stringify(cacheObj));
                log('Saved cache to storage:', Object.keys(cacheObj).length, 'entries');
            } catch (error) {
                log('Error saving cache to storage:', error);
            }
        }

        async get(key) {
            if (isCacheDisabled) return null; // Bypass cache if disabled
            const entry = this.cache.get(key);
            if (!entry) return null;

            if (Date.now() > entry.expiresAt) {
                this.cache.delete(key);
                await this.saveToStorage();
                return null;
            }

            return entry.data;
        }

        async set(key, data, config) {
            if (isCacheDisabled) return; // Bypass cache if disabled

            // Check if config is provided, otherwise use a default or skip
            if (!config || !config.maxEntries || !config.duration) {
                log('Cache config missing for key:', key, ' Using default or skipping.');
                // Define a default config or return if you don't want to cache without specific config
                config = CACHE_CONFIG.variants; // Example: Default to variants config
                // Or simply return if caching requires explicit config
                // return;
            }

            if (this.cache.size >= config.maxEntries) {
                const oldestKey = this.cache.keys().next().value;
                this.cache.delete(oldestKey);
            }

            this.cache.set(key, {
                data,
                timestamp: Date.now(),
                expiresAt: Date.now() + config.duration
            });

            await this.saveToStorage();
        }

        async clear() {
            this.cache.clear();
            // Always allow clearing storage, even if cache is currently disabled
            await GM.setValue('aliexpress_cache', '{}');
            log('Cache cleared');
        }
    }

    // Data Manager
    class DataManager {
        constructor() {
            this.cache = new CacheManager();
            this.tokenInitialized = false;
        }

        // Initialize token by making a simple request to AliExpress
        async initializeToken() {
            if (this.tokenInitialized) {
                return;
            }

            log('Initializing token...');
            
            // Check if token already exists
            const token = utils.getCookie('_m_h5_tk');
            if (token) {
                log('Token already exists:', token.split('_')[0]);
                this.tokenInitialized = true;
                return;
            }

            // Make a request to the AliExpress homepage to get the token
            try {
                log('Making request to initialize token...');
                return new Promise((resolve, reject) => {
                    GM.xmlHttpRequest({
                        method: 'GET',
                        url: 'https://www.aliexpress.us/',
                        headers: {
                            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                            'accept-language': 'en-US,en;q=0.9',
                            'cache-control': 'no-cache',
                            'pragma': 'no-cache',
                            'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
                            'sec-ch-ua-mobile': '?0',
                            'sec-ch-ua-platform': '"macOS"',
                            'sec-fetch-dest': 'document',
                            'sec-fetch-mode': 'navigate',
                            'sec-fetch-site': 'none',
                            'sec-fetch-user': '?1',
                            'upgrade-insecure-requests': '1',
                            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
                        },
                        onload: (response) => {
                            // Check if token was set in cookies
                            const newToken = utils.getCookie('_m_h5_tk');
                            if (newToken) {
                                log('Token initialized successfully:', newToken.split('_')[0]);
                                this.tokenInitialized = true;
                                resolve();
                            } else {
                                log('Failed to initialize token');
                                // Continue anyway
                                resolve();
                            }
                        },
                        onerror: (error) => {
                            log('Error initializing token:', error);
                            // Continue anyway
                            resolve();
                        }
                    });
                });
            } catch (error) {
                log('Error in token initialization:', error);
                // Continue anyway
            }
        }

        async fetchProductData(productId) {
            log('Fetching product data for ID:', productId, { productId });
            const cacheKey = `product_${productId}`;
            const cachedData = await this.cache.get(cacheKey);
            if (cachedData) {
                log(`[ARP_EnhanceFlow] [fetchProductData] Found cached data for product: ${productId}. Returning it.`, { productId });
                return cachedData;
            }

            try {
                // First get quick data from card
                const card = document.querySelector(`a[href*="${productId}"]`);
                let productData = null;
                
                if (card) {
                    log('Found product card, extracting basic info');
                    const title = card.querySelector(SELECTORS.title)?.textContent?.trim() || '';
                    const priceContainer = card.querySelector(SELECTORS.price);
                    const priceInfo = this.extractPriceFromElement(priceContainer);
                    const shippingElement = card.querySelector(SELECTORS.shipping);
                    const shippingInfo = this.extractShippingFromElement(shippingElement);
                    const discountElement = card.querySelector(SELECTORS.discount);
                    const discountInfo = this.extractDiscountFromElement(discountElement);

                    productData = {
                        productId,
                        title,
                        variants: [{
                            id: 'default',
                            name: 'Default',
                            price: {
                                value: priceInfo.original || priceInfo.current,
                                formattedPrice: utils.formatPrice(priceInfo.original || priceInfo.current),
                                discountedValue: priceInfo.current,
                                discountedFormattedPrice: utils.formatPrice(priceInfo.current),
                                discount: discountInfo.percentage || ''
                            },
                            shipping: {
                                cost: shippingInfo.cost || 0,
                                formattedPrice: utils.formatPrice(shippingInfo.cost || 0),
                                freeThreshold: shippingInfo.freeThreshold
                            },
                            stock: 999,
                            isMainProduct: true
                        }]
                    };
                }

                // // Try to fetch full product data using the direct Taobao API
                // try {
                //     log('Trying direct Aliexpress API call');
                //     const apiData = await this.fetchDirectAliExpressAPI(productId);
                //     if (apiData) {
                //         log('Successfully fetched data from direct Aliexpress API', { apiData});
                //         await this.cache.set(cacheKey, apiData, CACHE_CONFIG.variants);
                //         return apiData;
                //     }
                // } catch (directApiError) {
                //     log(`Direct Taobao API call failed for productId ${productId}:`, directApiError);
                // }

                // Try to fetch full product data using the API
                try {
                    // Get token from cookies
                    const token = utils.getCookie('_m_h5_tk')?.split('_')[0];
                    if (!token) {
                        log(`No token found in cookies, trying to fetch product page data for productId ${productId}`);
                        const pageData = await this.fetchDataFromProductPage(productId);
                        if (pageData) {
                            await this.cache.set(cacheKey, pageData, CACHE_CONFIG.variants);
                            return pageData;
                        }
                        
                        if (productData) {
                            await this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                            return productData;
                        }
                        throw new Error('No token found and no fallback data available');
                    }
                    
                    log('Found token:', token);
                    
                    // Prepare API request
                    const timestamp = Date.now();
                    const appKey = '12574478';
                    const apiVersion = '1.0';
                    
                    // Construct the request data object
                    const requestData = {
                        productId,
                        _lang: 'en_US',
                        _currency: 'USD',
                        country: 'US',
                        province: '922867650000000000',
                        city: '922867656497000000',
                        channel: '',
                        pdp_ext_f: '{"order":"10","eval":"1"}',
                        sourceType: '',
                        clientType: 'pc',
                        ext: JSON.stringify({
                            site: 'usa',
                            crawler: false,
                            'x-m-biz-bx-region': '',
                            signedIn: true,
                            host: 'www.aliexpress.us'
                        })
                    };
                    
                    // Convert request data to JSON string
                    const dataStr = JSON.stringify(requestData);
                    
                    // Generate sign
                    const sign = utils.generateSign(token, timestamp, appKey, dataStr);
                    log('Generated sign:', sign);
                    
                    // Construct the API URL with all parameters
                    const baseUrl = 'https://acs.aliexpress.us/h5/mtop.aliexpress.pdp.pc.query/1.0/';
                    const params = new URLSearchParams({
                        jsv: '2.5.1',
                        appKey,
                        t: timestamp,
                        sign,
                        api: 'mtop.aliexpress.pdp.pc.query',
                        type: 'originaljsonp',
                        v: apiVersion,
                        timeout: '15000',
                        dataType: 'originaljsonp',
                        callback: 'mtopjsonp1',
                        data: dataStr
                    });

                    const apiUrl = `${baseUrl}?${params.toString()}`;
                    log('Fetching from API URL:', apiUrl);

                    return new Promise((resolve, reject) => {
                        GM.xmlHttpRequest({
                            method: 'GET',
                            url: apiUrl,
                            headers: {
                                'accept': '*/*',
                                'accept-language': 'en-US,en;q=0.9',
                                'cache-control': 'no-cache',
                                'pragma': 'no-cache',
                                'referer': 'https://www.aliexpress.us/',
                                'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
                                'sec-ch-ua-mobile': '?0',
                                'sec-ch-ua-platform': '"macOS"',
                                'sec-fetch-dest': 'script',
                                'sec-fetch-mode': 'no-cors',
                                'sec-fetch-site': 'same-site',
                                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
                            },
                            withCredentials: true, // Important: send cookies with the request
                            onload: (response) => {
                                try {
                                    // log(`Received raw API response: ${response.responseText}`);
                                    
                                    // Extract JSON from JSONP response
                                    const jsonMatch = response.responseText.match(/mtopjsonp1\((.*)\)/);
                                    if (!jsonMatch) {
                                        throw new Error('Invalid JSONP response format');
                                    }

                                    const apiResponseData = JSON.parse(jsonMatch[1]);
                                    log('Parsed API response:', {productId, apiResponseData});

                                    if (apiResponseData.ret && apiResponseData.ret[0]?.startsWith('FAIL_')) {
                                        log('API returned error:', apiResponseData.ret[0]);
                                        if (apiResponseData.ret[0].includes('FAIL_SYS_ILLEGAL_ACCESS')) {
                                            throw new Error(apiResponseData.ret[0]); // This will trigger backoff
                                        }
                                        // Try to fetch product page data as fallback
                                        this.fetchDataFromProductPage(productId).then(pageData => {
                                            if (pageData) {
                                                this.cache.set(cacheKey, pageData, CACHE_CONFIG.variants);
                                                resolve(pageData);
                                                return;
                                            }
                                            
                                            if (productData) {
                                                this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                                                resolve(productData);
                                            } else {
                                                reject(new Error(`API Error: ${apiResponseData.ret[0]}`));
                                            }
                                        }).catch(err => {
                                            log('Error fetching product page data:', err);
                                            if (productData) {
                                                this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                                                resolve(productData);
                                            } else {
                                                reject(new Error(`API Error: ${apiResponseData.ret[0]}`));
                                            }
                                        });
                                        return;
                                    }

                                    const fullProductData = this.parseProductData(apiResponseData);
                                    
                                    if (productData) {
                                        fullProductData.variants = fullProductData.variants.length > 0 
                                            ? fullProductData.variants 
                                            : productData.variants;
                                        
                                        fullProductData.title = fullProductData.title || productData.title;
                                    }

                                    this.cache.set(cacheKey, fullProductData, CACHE_CONFIG.variants);
                                    resolve(fullProductData);

                                } catch (error) {
                                    log('Error processing API response:', error);
                                    // Try to fetch product page data as fallback
                                    this.fetchDataFromProductPage(productId).then(pageData => {
                                        if (pageData) {
                                            this.cache.set(cacheKey, pageData, CACHE_CONFIG.variants);
                                            resolve(pageData);
                                            return;
                                        }
                                        
                                        if (productData) {
                                            this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                                            resolve(productData);
                                        } else {
                                            reject(error);
                                        }
                                    }).catch(err => {
                                        log('Error fetching product page data:', err);
                                        if (productData) {
                                            this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                                            resolve(productData);
                                        } else {
                                            reject(error);
                                        }
                                    });
                                }
                            },
                            onerror: (error) => {
                                log('Error fetching API data:', error);
                                // Try to fetch product page data as fallback
                                this.fetchDataFromProductPage(productId).then(pageData => {
                                    if (pageData) {
                                        this.cache.set(cacheKey, pageData, CACHE_CONFIG.variants);
                                        resolve(pageData);
                                        return;
                                    }
                                    
                                    if (productData) {
                                        this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                                        resolve(productData);
                                    } else {
                                        reject(error);
                                    }
                                }).catch(err => {
                                    log('Error fetching product page data:', err);
                                    if (productData) {
                                        this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                                        resolve(productData);
                                    } else {
                                        reject(error);
                                    }
                                });
                            }
                        });
                    });
                } catch (apiError) {
                    log('API request failed, trying to fetch product page data:', apiError);
                    try {
                        const pageData = await this.fetchDataFromProductPage(productId);
                        if (pageData) {
                            this.cache.set(cacheKey, pageData, CACHE_CONFIG.variants);
                            return pageData;
                        }
                    } catch (pageError) {
                        log('Error fetching product page data:', pageError);
                    }
                    
                    if (productData) {
                        this.cache.set(cacheKey, productData, CACHE_CONFIG.variants);
                        return productData;
                    }
                    throw apiError;
                }
            } catch (error) {
                log('Error in fetchProductData:', error);
                throw error;
            }
        }

        // Direct Taobao API call based on the shared resources
        async fetchDirectAliExpressAPI(productId) {
            log('Making direct Taobao API call for product ID:', productId);
            
            try {
                // Based on the shared resources, we'll use a different approach
                // This is based on the GitHub repo and blog post you shared
                
                // Prepare API request
                const timestamp = Date.now();
                const appKey = '12574478';
                
                // Construct the request data object
                const requestData = {
                    itemId: productId,
                    language: 'en',
                    currency: 'USD',
                    region: 'US',
                    locale: 'en_US',
                    site: 'usa'
                };
                
                // Convert request data to JSON string
                const dataStr = JSON.stringify(requestData);
                
                // Construct the API URL
                const apiUrl = `https://www.aliexpress.us/aer-api/v1/product/detail?productId=${productId}`;
                log('Fetching from direct API URL:', apiUrl);
                
                return new Promise((resolve, reject) => {
                    GM.xmlHttpRequest({
                        method: 'GET',
                        url: apiUrl,
                        headers: {
                            'accept': 'application/json, text/plain, */*',
                            'accept-language': 'en-US,en;q=0.9',
                            'cache-control': 'no-cache',
                            'pragma': 'no-cache',
                            'referer': `https://www.aliexpress.us/item/${productId}.html`,
                            'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
                            'sec-ch-ua-mobile': '?0',
                            'sec-ch-ua-platform': '"macOS"',
                            'sec-fetch-dest': 'empty',
                            'sec-fetch-mode': 'cors',
                            'sec-fetch-site': 'same-origin',
                            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
                        },
                        withCredentials: true,
                        onload: (response) => {
                            try {
                                log('Received direct API response');
                                
                                // if url is 404.html, we didn't find the product
                                if (response.finalUrl.includes('404.html')) {
                                    log(`product ${productId} not found`);
                                    resolve(null);
                                    return;
                                }

                                

                                // Parse JSON response
                                const data = JSON.parse(response.responseText);
                                log('Parsed direct API response:', data);
                                
                                if (!data.data || data.code !== 200) {
                                    log('Direct API returned error:', data.message || 'Unknown error');
                                    resolve(null);
                                    return;
                                }
                                
                                // Parse the product data
                                const productData = this.parseDirectAPIResponse(data, productId);
                                
                                if (productData) {
                                    log('Successfully parsed direct API response');
                                    resolve(productData);
                                } else {
                                    log('Failed to parse direct API response');
                                    resolve(null);
                                }
                            } catch (error) {
                                log('Error processing direct API response:', error);
                                resolve(null);
                            }
                        },
                        onerror: (error) => {
                            log('Error fetching direct API data:', error);
                            resolve(null);
                        }
                    });
                });
            } catch (error) {
                log('Error in fetchDirectTaobaoAPI:', error);
                return null;
            }
        }

        // Parse the direct API response
        parseDirectAPIResponse(data, productId) {
            try {
                log('Parsing direct API response', { productId });
                
                const productDetail = data.data || {};
                
                // Extract title
                const title = productDetail.productTitle || productDetail.title || '';
                
                // Extract variants
                let variants = [];
                
                // Try to extract variants from skuModule
                const skuModule = productDetail.skuModule || {};
                const skuPriceModule = productDetail.priceModule || {};
                const shippingModule = productDetail.shippingModule || {};
                
                if (skuModule.skuPriceList || skuModule.skuList) {
                    const skuList = skuModule.skuPriceList || skuModule.skuList || [];
                    
                    variants = skuList.map(sku => {
                        const skuId = sku.skuId || sku.id;
                        const skuName = this.extractSkuName(sku, skuModule) || 'Default';
                        const priceInfo = sku.skuVal || sku;
                        
                        // Extract shipping info
                        const shippingInfo = this.extractShippingInfoFromModule(shippingModule, productId);
                        
                        return {
                            id: skuId,
                            name: skuName,
                            price: {
                                value: priceInfo.skuAmount?.value || priceInfo.skuPrice || 0,
                                formattedPrice: utils.formatPrice(priceInfo.skuAmount?.value || priceInfo.skuPrice || 0),
                                discountedValue: priceInfo.skuActivityAmount?.value || priceInfo.actSkuPrice || priceInfo.skuPrice || 0,
                                discountedFormattedPrice: utils.formatPrice(priceInfo.skuActivityAmount?.value || priceInfo.actSkuPrice || priceInfo.skuPrice || 0),
                                discount: priceInfo.discount || ''
                            },
                            shipping: shippingInfo,
                            stock: sku.skuVal?.availQuantity || sku.inventory || 999,
                            isMainProduct: this.isMainProductBySku(sku)
                        };
                    });
                }
                
                // If no variants found, create a default one
                if (variants.length === 0) {
                    const priceInfo = skuPriceModule.formatedActivityPrice || skuPriceModule.formatedPrice || '';
                    const priceValue = parseFloat(priceInfo.replace(/[^\d.]/g, '')) || 0;
                    
                    // Extract shipping info
                    const shippingInfo = this.extractShippingInfoFromModule(shippingModule, productId);
                    
                    variants = [{
                        id: 'default',
                        name: 'Default',
                        price: {
                            value: priceValue,
                            formattedPrice: utils.formatPrice(priceValue),
                            discountedValue: priceValue,
                            discountedFormattedPrice: utils.formatPrice(priceValue),
                            discount: skuPriceModule.discount || ''
                        },
                        shipping: shippingInfo,
                        stock: 999,
                        isMainProduct: true
                    }];
                }
                
                return {
                    productId,
                    title,
                    variants
                };
            } catch (error) {
                log('Error parsing direct API response:', error, { productId });
                return null;
            }
        }

        // Extract SKU name from SKU object
        extractSkuName(sku, skuModule) {
            try {
                // Try to extract name from skuAttr (format: "14:350685#1m")
                if (sku.skuAttr) {
                    const parts = sku.skuAttr.split('#');
                    if (parts.length > 1) {
                        return parts[1];
                    }
                }
                
                // Try to extract name from propPath
                if (sku.propPath) {
                    const propIds = sku.propPath.split(';').map(p => p.split(':')[1]);
                    
                    // Find property values
                    const propNames = [];
                    const props = skuModule.props || [];
                    
                    for (const prop of props) {
                        const values = prop.values || [];
                        for (const value of values) {
                            if (propIds.includes(value.id)) {
                                propNames.push(value.name);
                            }
                        }
                    }
                    
                    if (propNames.length > 0) {
                        return propNames.join(' ');
                    }
                }
                
                return 'Default';
            } catch (error) {
                log('Error extracting SKU name:', error);
                return 'Default';
            }
        }

        // Extract shipping info from shipping module
        extractShippingInfoFromModule(shippingModule, productId) {
            try {
                log('Raw shipping module data:', shippingModule, { productId });
                const defaultShipping = {
                    cost: 0,
                    formattedPrice: '$0.00',
                    freeThreshold: null
                };
                
                if (!shippingModule) {
                    return defaultShipping;
                }
                
                // Find shipping cost
                const shippingOptions = shippingModule.freightCalculateInfo?.freight || [];
                if (shippingOptions.length === 0) {
                    return defaultShipping;
                }
                
                // Get the cheapest shipping option
                const cheapestOption = shippingOptions.reduce((min, option) => {
                    const cost = option.freightAmount?.value || 0;
                    return cost < min.cost ? { cost, option } : min;
                }, { cost: Infinity, option: null });
                
                if (cheapestOption.option) {
                    const cost = cheapestOption.cost;
                    
                    // Check for free shipping threshold
                    let freeThreshold = null;
                    if (shippingModule.freightCalculateInfo?.freeShippingText) {
                        const thresholdMatch = shippingModule.freightCalculateInfo.freeShippingText.match(/\$(\d+(\.\d{2})?)/);
                        if (thresholdMatch) {
                            freeThreshold = parseFloat(thresholdMatch[1]);
                        }
                    }
                    
                    return {
                        cost,
                        formattedPrice: utils.formatPrice(cost),
                        freeThreshold
                    };
                }
                
                return defaultShipping;
            } catch (error) {
                log('Error extracting shipping info:', error);
                return {
                    cost: 0,
                    formattedPrice: '$0.00',
                    freeThreshold: null
                };
            }
        }

        extractPriceFromElement(element) {
            if (!element) return { current: 0, original: 0 };

            try {
                // Extract current price
                const currentPriceText = element.textContent.match(/\$[\d,.]+/)?.[0] || '0';
                const currentPrice = parseFloat(currentPriceText.replace(/[$,]/g, ''));

                // Extract original price if available (crossed out price)
                const originalPriceElement = element.querySelector('.lq_j4');
                const originalPriceText = originalPriceElement?.textContent.match(/\$[\d,.]+/)?.[0] || currentPriceText;
                const originalPrice = parseFloat(originalPriceText.replace(/[$,]/g, ''));

                return {
                    current: currentPrice,
                    original: originalPrice
                };
            } catch (error) {
                log('Error extracting price:', error);
                return { current: 0, original: 0 };
            }
        }

        extractShippingFromElement(element) {
            if (!element) return { cost: 0, freeThreshold: null };

            try {
                const text = element.textContent;
                const freeThresholdMatch = text.match(/Free shipping over \$(\d+(\.\d{2})?)/i);
                const shippingCostMatch = text.match(/Shipping: \$(\d+(\.\d{2})?)/i);

                return {
                    cost: shippingCostMatch ? parseFloat(shippingCostMatch[1]) : 0,
                    freeThreshold: freeThresholdMatch ? parseFloat(freeThresholdMatch[1]) : null
                };
            } catch (error) {
                log('Error extracting shipping:', error);
                return { cost: 0, freeThreshold: null };
            }
        }

        extractDiscountFromElement(element) {
            if (!element) return { percentage: '' };

            try {
                const text = element.textContent;
                const percentageMatch = text.match(/-(\d+)%/);

                return {
                    percentage: percentageMatch ? `-${percentageMatch[1]}%` : ''
                };
            } catch (error) {
                log('Error extracting discount:', error);
                return { percentage: '' };
            }
        }

        createSingleVariant(result, productId) {
            // Extract price from the page data
            const priceInfo = result.priceComponent || result.price || {};
            // Extract shipping from the new path
            const shippingData = result.SHIPPING || {};
            const deliveryLayout = shippingData.deliveryLayoutInfo?.[0] || {};
            const shippingBizData = deliveryLayout.bizData || {};
            
            // Get the price values
            const originalPrice = this.extractDefaultPrice(result);
            const discountedPrice = priceInfo.activityPrice || priceInfo.discountPrice || originalPrice;
            
            // Extract base shipping info
            const baseShippingInfo = this.extractShippingInfo(shippingBizData, productId);

            return [{ // Return as an array containing the single variant object
                id: 'default',
                name: 'Default',
                price: {
                    value: originalPrice,
                    formattedPrice: utils.formatPrice(originalPrice),
                    discountedValue: discountedPrice,
                    discountedFormattedPrice: utils.formatPrice(discountedPrice),
                    discount: priceInfo.discount || ''
                },
                shipping: baseShippingInfo, // Use the extracted base info
                stock: 999,
                isMainProduct: true
            }];
        }

        parseProductData(data) {
            log('Parsing data:', data);
            const productId = data.data?.result?.productId || ''; // Extract productId for logging

            // Handle different API response structures
            const result = data.data?.result || data.data || {};
            log('Result object:', result, { productId });

            // Handle error responses
            if (data.ret && data.ret[0]?.startsWith('FAIL_')) {
                log('API returned error:', data.ret[0], { productId });
                return {
                    productId: productId,
                    title: result.title || '',
                    variants: [this.createDefaultVariant(result)]
                };
            }

            // Extract basic product info
            const productInfo = {
                productId: productId,
                title: result.title || '',
            };

            // Extract variants
            let variants = [];
            
            try {
                // Get SKU and price data from the correct paths
                const skuPaths = result.SKU?.skuPaths || [];
                const priceMap = result.PRICE?.skuIdStrPriceInfoMap || {};
                // Extract shipping info from the new path
                const shippingData = result.SHIPPING || {};
                const deliveryLayout = shippingData.deliveryLayoutInfo?.[0] || {};
                const shippingBizData = deliveryLayout.bizData || {};
                const deliveryGuarantee = shippingData.DELIVERY_GUARANTEE_SERVICE || {};
                // Note: Free shipping text info might be nested differently, adjust if needed
                const freeShippingTextInfo = {}; // Placeholder

                if (skuPaths.length > 0) {
                    variants = skuPaths.map(sku => {
                        const skuId = sku.skuIdStr || sku.skuId;
                        const priceInfo = priceMap[skuId] || {};
                        
                        // Base variant data without shipping
                        return {
                            id: skuId,
                            name: this.getSkuName(sku),
                            price: {
                                value: priceInfo.originalPrice?.value || 0,
                                formattedPrice: priceInfo.originalPrice?.formatedAmount || '$0.00',
                                discountedValue: this.extractPriceValue(priceInfo.salePriceString) || priceInfo.originalPrice?.value || 0,
                                discountedFormattedPrice: priceInfo.salePriceString || priceInfo.originalPrice?.formatedAmount || '$0.00',
                                discount: priceInfo.discount || ''
                            },
                            stock: sku.skuStock || sku.availQuantity || 999,
                            isMainProduct: this.isMainProductBySku(sku)
                        };
                    });
                } else {
                    // Single variant case
                    // Pass productId to createSingleVariant
                    variants = [this.createSingleVariant(result, productId)];
                }

                // Extract base shipping info ONCE
                const baseShippingInfo = this.extractShippingInfo(shippingBizData, productId);

                // Add shipping info (cost, guarantee, etc.) to all variants
                variants = this.addShippingInfo(variants, baseShippingInfo, deliveryGuarantee, freeShippingTextInfo, productId);

            } catch (error) {
                log('Error parsing variants:', error, { productId });
                variants = [this.createDefaultVariant(result)];
            }

            return {
                ...productInfo,
                variants: variants.length > 0 ? variants : [this.createDefaultVariant(result, productId)]
            };
        }

        getSkuName(sku) {
            // Extract name from skuAttr (format: "14:350685#1m")
            const skuAttr = sku.skuAttr || '';
            const parts = skuAttr.split('#');
            return parts[1] || 'Default';
        }

        isMainProductBySku(sku) {
            const name = (sku.skuAttr || '').toLowerCase();
            return !this.isAccessory(name);
        }

        extractPriceValue(priceString) {
            if (!priceString) return 0;
            const match = priceString.match(/[\d,.]+/);
            return match ? parseFloat(match[0].replace(/,/g, '')) : 0;
        }

        createDefaultVariant(result, productId) {
            // Create a default variant when no variant info is available
            const defaultPrice = this.extractDefaultPrice(result);
            return {
                id: 'default',
                name: 'Default',
                price: {
                    value: defaultPrice,
                    formattedPrice: utils.formatPrice(defaultPrice),
                    discountedValue: defaultPrice,
                    discountedFormattedPrice: utils.formatPrice(defaultPrice),
                    discount: ''
                },
                shipping: {
                    cost: 0,
                    formattedPrice: '$0.00',
                    freeThreshold: null
                },
                stock: 999,
                isMainProduct: true
            };
        }

        extractDefaultPrice(result) {
            // Try various paths to find the price
            const productId = result?.productId || ''; // Get productId if available
            const paths = [
                result.priceComponent?.originalPrice,
                result.price?.originalPrice?.value,
                result.price?.minPrice,
                result.PRICE?.originalPrice?.value,
                result.PRICE?.minPrice
            ];

            for (const price of paths) {
                if (typeof price === 'number' && !isNaN(price)) {
                    return price;
                }
            }

            log('Could not extract default price from result object', { productId, result });
            return 0;
        }

        extractShippingInfo(shippingBizData, productId) {
            log('Raw shippingBizData object:', shippingBizData, { productId }); // Log the full object
            const hasChoiceFreeShipping = shippingBizData?.choiceFreeShipping === 'yes';
            log(`[extractShippingInfo] choiceFreeShipping status for ${productId}:`, hasChoiceFreeShipping);
            return {
                cost: shippingBizData?.displayAmount || 0,
                // Use formattedAmount if available, otherwise format the cost
                formattedPrice: shippingBizData?.formattedAmount || utils.formatPrice(shippingBizData?.displayAmount || 0),
                // Free threshold logic might need revisiting based on bizData structure - removed for now
                freeThreshold: null, // Keep null for now, threshold *value* extraction needs review
                hasChoiceFreeShipping: hasChoiceFreeShipping // Add the boolean status
            };
        }

        extractFreeShippingThreshold(shipping) {
            // This function needs to be re-evaluated based on the new API structure.
            // It's currently not used because extractShippingInfo sets freeThreshold to null.
            log('extractFreeShippingThreshold called, but logic needs review based on SHIPPING.deliveryLayoutInfo structure', { shipping });
            return null;
        }

        addShippingInfo(variants, baseShippingInfo, deliveryGuarantee, freeShippingTextInfo, productId) {
            // baseShippingInfo is the object returned by extractShippingInfo
            // deliveryGuarantee is the result.DELIVERY_GUARANTEE_SERVICE object
            // freeShippingTextInfo is the (potentially empty) free shipping text component

            return variants.map(variant => ({
                ...variant,
                shipping: {
                    ...baseShippingInfo, // Contains cost, formattedPrice, freeThreshold (currently null)
                    guaranteedDays: deliveryGuarantee?.subContents?.[3]?.content?.match(/\d+/)?.[0] || null,
                    freeShippingText: freeShippingTextInfo?.mainText || null
                    // TODO: Re-evaluate freeThreshold extraction if needed
                }
            }));
        }

        isAccessory(name) {
            const accessoryKeywords = [
                'case', 'cover', 'protector', 'cable', 'adapter', 'charger',
                'holder', 'stand', 'accessory', 'kit', 'pedal', 'spare',
                'replacement', 'tool', 'bag', 'box'
            ];
            return accessoryKeywords.some(keyword => name.includes(keyword));
        }

        // Fetch product data directly from the product page HTML
        async fetchDataFromProductPage(productId) {
            log('Fetching product page data for ID:', productId);
            // Add log to indicate fallback
            log(`Falling back to fetching data directly from product page HTML for productId: ${productId}`, { productId });

            try {
                const productUrl = `https://www.aliexpress.us/item/${productId}.html`;
                log('Fetching product page:', productUrl);
                
                return new Promise((resolve, reject) => {
                    GM.xmlHttpRequest({
                        method: 'GET',
                        url: productUrl,
                        headers: {
                            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                            'accept-language': 'en-US,en;q=0.9',
                            'cache-control': 'no-cache',
                            'pragma': 'no-cache',
                            'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
                            'sec-ch-ua-mobile': '?0',
                            'sec-ch-ua-platform': '"macOS"',
                            'sec-fetch-dest': 'document',
                            'sec-fetch-mode': 'navigate',
                            'sec-fetch-site': 'none',
                            'sec-fetch-user': '?1',
                            'upgrade-insecure-requests': '1',
                            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
                        },
                        onload: (response) => {
                            try {
                                log('Received product page response');
                                
                                // Extract product data from HTML
                                const productData = this.extractProductDataFromHTML(response.responseText, productId);
                                
                                if (productData) {
                                    log('Successfully extracted product data from HTML');
                                    resolve(productData);
                                } else {
                                    log('Failed to extract product data from HTML');
                                    resolve(null);
                                }
                            } catch (error) {
                                log('Error processing product page response:', error);
                                resolve(null);
                            }
                        },
                        onerror: (error) => {
                            log('Error fetching product page:', error);
                            resolve(null);
                        }
                    });
                });
            } catch (error) {
                log('Error in fetchProductPageData:', error);
                return null;
            }
        }

        // Extract product data from HTML
        extractProductDataFromHTML(html, productId) {
            try {
                log('Extracting product data from HTML');
                
                // Create a temporary DOM element to parse the HTML
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                
                // Look for the product data in the page
                const scriptElements = Array.from(doc.querySelectorAll('script'));
                
                // Find the script that contains the product data
                let productData = null;
                
                // Method 1: Look for runParams.data
                for (const script of scriptElements) {
                    const content = script.textContent;
                    if (content.includes('runParams.data')) {
                        const match = content.match(/runParams\.data\s*=\s*({.*?});/s);
                        if (match && match[1]) {
                            try {
                                productData = JSON.parse(match[1]);
                                log('Found product data in runParams.data');
                                break;
                            } catch (e) {
                                log('Error parsing runParams.data:', e);
                            }
                        }
                    }
                }
                
                // Method 2: Look for window.__INITIAL_STATE__
                if (!productData) {
                    for (const script of scriptElements) {
                        const content = script.textContent;
                        if (content.includes('window.__INITIAL_STATE__')) {
                            const match = content.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});/s);
                            if (match && match[1]) {
                                try {
                                    const state = JSON.parse(match[1]);
                                    productData = state.productDetail?.data;
                                    log('Found product data in window.__INITIAL_STATE__');
                                    break;
                                } catch (e) {
                                    log('Error parsing window.__INITIAL_STATE__:', e);
                                }
                            }
                        }
                    }
                }
                
                // Method 3: Look for data-pdp-json
                if (!productData) {
                    const jsonElement = doc.querySelector('[data-pdp-json]');
                    if (jsonElement) {
                        try {
                            productData = JSON.parse(jsonElement.getAttribute('data-pdp-json'));
                            log('Found product data in data-pdp-json attribute');
                        } catch (e) {
                            log('Error parsing data-pdp-json:', e);
                        }
                    }
                }
                
                // Method 4: Look for window.runParams
                if (!productData) {
                    for (const script of scriptElements) {
                        const content = script.textContent;
                        if (content.includes('window.runParams')) {
                            const match = content.match(/window\.runParams\s*=\s*({.*?});/s);
                            if (match && match[1]) {
                                try {
                                    const runParams = JSON.parse(match[1]);
                                    productData = runParams.data;
                                    log('Found product data in window.runParams');
                                    break;
                                } catch (e) {
                                    log('Error parsing window.runParams:', e);
                                }
                            }
                        }
                    }
                }
                
                if (!productData) {
                    log('Could not find product data in HTML');
                    return null;
                }
                
                // Extract title
                const title = productData.title || productData.subject || 
                              doc.querySelector('h1')?.textContent?.trim() || '';
                
                // Extract variants
                let variants = [];
                
                // Try to extract variants from skuModule
                const skuModule = productData.skuModule || productData.skuInfo || {};
                const skuPriceModule = productData.priceModule || productData.priceInfo || {};
                
                if (skuModule.skuPriceList || skuModule.skuList) {
                    const skuList = skuModule.skuPriceList || skuModule.skuList || [];
                    
                    variants = skuList.map(sku => {
                        const skuId = sku.skuId || sku.id;
                        const skuName = sku.skuAttr?.split('#')[1] || 'Default';
                        const priceInfo = sku.skuVal || sku;
                        
                        return {
                            id: skuId,
                            name: skuName,
                            price: {
                                value: priceInfo.skuAmount?.value || priceInfo.skuPrice || 0,
                                formattedPrice: utils.formatPrice(priceInfo.skuAmount?.value || priceInfo.skuPrice || 0),
                                discountedValue: priceInfo.skuActivityAmount?.value || priceInfo.actSkuPrice || priceInfo.skuPrice || 0,
                                discountedFormattedPrice: utils.formatPrice(priceInfo.skuActivityAmount?.value || priceInfo.actSkuPrice || priceInfo.skuPrice || 0),
                                discount: priceInfo.discount || ''
                            },
                            shipping: {
                                cost: 0, // We don't have shipping info from HTML
                                formattedPrice: '$0.00',
                                freeThreshold: null
                            },
                            stock: sku.skuVal?.availQuantity || sku.inventory || 999,
                            isMainProduct: true
                        };
                    });
                }
                
                // If no variants found, create a default one
                if (variants.length === 0) {
                    const priceInfo = skuPriceModule.formatedActivityPrice || skuPriceModule.formatedPrice || '';
                    const priceValue = parseFloat(priceInfo.replace(/[^\d.]/g, '')) || 0;
                    
                    variants = [{
                        id: 'default',
                        name: 'Default',
                        price: {
                            value: priceValue,
                            formattedPrice: utils.formatPrice(priceValue),
                            discountedValue: priceValue,
                            discountedFormattedPrice: utils.formatPrice(priceValue),
                            discount: skuPriceModule.discount || ''
                        },
                        shipping: {
                            cost: 0,
                            formattedPrice: '$0.00',
                            freeThreshold: null
                        },
                        stock: 999,
                        isMainProduct: true
                    }];
                }
                
                return {
                    productId,
                    title,
                    variants
                };
            } catch (error) {
                log('Error extracting product data from HTML:', error);
                return null;
            }
        }
    }

    // Price Context Calculator
    class PriceContextCalculator {
        calculatePageContext(productCards) {
            const prices = [];
            for (const card of productCards) {
                const priceElement = card.querySelector(SELECTORS.price);
                if (priceElement) {
                    const price = this.extractPriceValue(priceElement.textContent);
                    if (price) prices.push(price);
                }
            }

            if (prices.length === 0) return null;

            prices.sort((a, b) => a - b);
            const median = this.calculateMedian(prices);
            const threshold = median * 0.3;

            return {
                median,
                lowerBound: median - threshold,
                upperBound: median + threshold,
                distribution: this.calculateDistribution(prices)
            };
        }

        calculateMedian(prices) {
            const mid = Math.floor(prices.length / 2);
            return prices.length % 2 === 0
                ? (prices[mid - 1] + prices[mid]) / 2
                : prices[mid];
        }

        calculateDistribution(prices) {
            return {
                min: Math.min(...prices),
                max: Math.max(...prices),
                clusters: this.findPriceClusters(prices)
            };
        }

        findPriceClusters(prices) {
            // Simple clustering based on price ranges
            const range = prices[prices.length - 1] - prices[0];
            const step = range / 5;
            const clusters = [];

            for (let i = 0; i < 5; i++) {
                const min = prices[0] + (step * i);
                const max = prices[0] + (step * (i + 1));
                const clusterPrices = prices.filter(p => p >= min && p < max);

                if (clusterPrices.length > 0) {
                    clusters.push({
                        centerPrice: (min + max) / 2,
                        count: clusterPrices.length,
                        variance: this.calculateVariance(clusterPrices)
                    });
                }
            }

            return clusters;
        }

        calculateVariance(prices) {
            const mean = prices.reduce((a, b) => a + b) / prices.length;
            return Math.sqrt(
                prices.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / prices.length
            );
        }

        findBestMatchingVariant(variants, context) {
            if (!context || variants.length === 0) return variants[0];

            return variants
                .map(variant => ({
                    ...variant,
                    score: this.calculateVariantScore(variant, context)
                }))
                .sort((a, b) => b.score - a.score)[0];
        }

        calculateVariantScore(variant, context) {
            const { median, lowerBound, upperBound } = context;
            const price = variant.price.discountedValue;

            const distanceScore = 1 / (Math.abs(price - median) + 1);
            const inRange = price >= lowerBound && price <= upperBound ? 1.5 : 0.5;
            const productTypeMultiplier = variant.isMainProduct ? 1.3 : 0.7;

            return distanceScore * inRange * productTypeMultiplier;
        }

        extractPriceValue(text) {
            const match = text.match(/[\d,.]+/);
            return match ? parseFloat(match[0].replace(/,/g, '')) : 0;
        }
    }

    // DOM Enhancement Manager
    class DOMEnhancer {
        constructor(dataManager, priceContextCalculator) {
            this.dataManager = dataManager;
            this.priceContextCalculator = priceContextCalculator;
            this.setupIntersectionObserver();
            this.pendingEnhancements = new Set();
            this.processedCards = new WeakSet(); // Track processed cards
        }

        setupIntersectionObserver() {
            this.observer = new IntersectionObserver(
                (entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting) {
                            const productCard = entry.target;
                            const productId = utils.extractProductId(productCard);
                            if (productId) {
                                this.pendingEnhancements.add(productId);
                                this.enhanceProductCard(productCard, productId);
                                this.observer.unobserve(productCard);
                            }
                        }
                    });
                },
                { rootMargin: '200px' }
            );
        }

        async enhanceProductCard(card, productId) {
            // Check if we've already processed this card
            log(`[ARP_EnhanceFlow] [enhanceProductCard START] Processing card ${productId}`, { productId });
            if (this.processedCards.has(card)) {
                log('Card already processed:', productId, { productId });
                this.pendingEnhancements.delete(productId);
                loadingManager.itemComplete();
                return;
            }

            log('Enhancing product card:', productId, { productId });
            let priceElement = null;

            try {
                // Try multiple strategies to find the price element
                const priceSelectors = SELECTORS.price.split(',');
                
                // Log all potential price elements for debugging
                log('Searching for price element with selectors:', priceSelectors, { productId });
                
                for (const selector of priceSelectors) {
                    const elements = card.querySelectorAll(selector.trim());
                    if (elements.length > 0) {
                        // Take the most specific (deepest) price element
                        priceElement = Array.from(elements).reduce((best, current) => {
                            const bestDepth = this.getElementDepth(best);
                            const currentDepth = this.getElementDepth(current);
                            return currentDepth > bestDepth ? current : best;
                        });
                        log('Found price element using selector:', selector, {
                            productId,
                            elementHtml: priceElement.outerHTML,
                            elementClass: priceElement.className
                        });
                        break;
                    }
                }

                if (!priceElement) {
                    // If still not found, try searching deeper in the card
                    log('No price element found with selectors, trying text pattern search', { productId });
                    const allElements = card.getElementsByTagName('*');
                    for (const element of allElements) {
                        const text = element.textContent;
                        // Look for price-like patterns (e.g., $XX.XX)
                        if (/\$\d+(\.\d{2})?/.test(text) && !element.querySelector('*')) {
                            priceElement = element;
                            log('Found price element using text pattern:', {
                                productId,
                                text,
                                elementHtml: element.outerHTML,
                                elementClass: element.className
                            });
                            break;
                        }
                    }
                }

                if (!priceElement) {
                    log('No price element found for product:', productId, {
                        productId,
                        cardHtml: card.outerHTML
                    });
                    this.pendingEnhancements.delete(productId);
                    loadingManager.itemComplete();
                    return;
                }

                // Verify the element is still in the DOM
                if (!document.contains(priceElement)) {
                    log('Price element is no longer in the DOM:', {
                        productId,
                        elementHtml: priceElement.outerHTML
                    });
                    this.pendingEnhancements.delete(productId);
                    loadingManager.itemComplete();
                    return;
                }

                // Mark the card as being processed
                this.processedCards.add(card);

                // Fetch data with rate limiting
                const productData = await rateLimiter.executeWithBackoff(async () => {
                    return await this.dataManager.fetchProductData(productId);
                });
                log(`[ARP_EnhanceFlow] [enhanceProductCard] Got productData (cached or fetched) for ${productId}`, { productId });
                
                // Verify element is still valid after async operation
                if (!document.contains(priceElement)) {
                    log('Price element was removed during async operation', { productId });
                    this.pendingEnhancements.delete(productId);
                    loadingManager.itemComplete();
                    return;
                }

                log('Received product data for enhancement:', productData, { productId });

                const context = this.priceContextCalculator.calculatePageContext(
                    Array.from(document.querySelectorAll(SELECTORS.productCard))
                );

                const bestVariant = this.priceContextCalculator.findBestMatchingVariant(
                    productData.variants,
                    context
                );

                this.updatePriceDisplay(priceElement, bestVariant, productData, context, productId);

            } catch (error) {
                log('Error enhancing product card:', productId, error, { productId });
                if (priceElement && document.contains(priceElement)) {
                    try {
                        // Add error class instead of replacing completely
                        priceElement.classList.add('ali-real-price-error'); 
                        priceElement.textContent = 'Price data unavailable';
                    } catch (displayError) {
                        log('Error showing error state:', displayError, { productId });
                    }
                }
            } finally {
                // *** This SHOULD always run ***
                log(`[ARP_EnhanceFlow] [enhanceProductCard finally] Reached finally block for ${productId}`, { productId });
                this.pendingEnhancements.delete(productId);
                loadingManager.itemComplete(); // This is the call that updates the counter
            }
        }

        updatePriceDisplay(element, bestVariant, productData, context, productId) {
            if (!element) {
                log('Cannot update price display - element is null');
                return;
            }

            if (!element.parentNode) {
                log('Cannot update price display - element has no parent', {
                    elementHtml: element.outerHTML,
                    elementClass: element.className,
                    elementId: element.id
                });
                return;
            }

            // Get total price range (includes shipping)
            const priceRange = this.getPriceRange(productData.variants, productId);
            const displayOptions = {
                showShipping: true, // Keep flag for potential future use, but won't add text now
                showMedianIndicator: true,
                showPriceRange: true,
                showDistributionGraph: true
            };

            // Start with the total price of the best matching variant
            const bestVariantTotal = (bestVariant.price?.discountedValue || 0) + (bestVariant.shipping?.cost || 0);
            let displayText = utils.formatPrice(bestVariantTotal);

            if (displayOptions.showPriceRange && priceRange.min !== priceRange.max) {
                // Display the total price range
                displayText = `${utils.formatPrice(priceRange.min)} - ${utils.formatPrice(priceRange.max)}`;
            }

            // Add note about shipping being included only if:
            // 1. The base shipping cost is > 0
            // 2. There is NO "Choice Free Shipping" option available
            if (bestVariant.shipping?.cost > 0 && !bestVariant.shipping?.hasChoiceFreeShipping) {
                log(`Adding '(including shipping)' for ${productId} because cost is ${bestVariant.shipping?.cost} and hasChoiceFreeShipping is ${bestVariant.shipping?.hasChoiceFreeShipping}`);
                displayText += ' (including shipping)';
            } else {
                log(`NOT adding '(including shipping)' for ${productId} because cost is ${bestVariant.shipping?.cost} and hasChoiceFreeShipping is ${bestVariant.shipping?.hasChoiceFreeShipping}`);
            }

            if (displayOptions.showMedianIndicator) {
                displayText += ' ⊙';
            }

            // Instead of replacing the element, try to modify it in place first
            try {
                element.className = 'ali-real-price-range ' + element.className;
                element.innerHTML = displayText;

                // Add hover events for variant popup
                const card = element.closest(SELECTORS.productCard);
                if (card) {
                    let popupTimeout;
                    element.addEventListener('mouseenter', () => {
                        log('mouseenter', {productId});
                        popupTimeout = setTimeout(() => {
                            this.showVariantPopup(card, productData.variants, bestVariant, context, productId);
                        }, 200); // Small delay to prevent flicker
                    });
                    log('mouseenter event listener added', {productId});

                    element.addEventListener('mouseleave', () => {
                        clearTimeout(popupTimeout);
                        setTimeout(() => {
                            this.hideVariantPopup(card, productId);
                        }, 200); // Small delay to allow moving mouse to popup
                    });
                } else {
                    log('no card found for when establishing hover events', {productId});
                }

                if (displayOptions.showDistributionGraph) {
                    this.addPriceDistributionGraph(element, bestVariant, priceRange, productId);
                }
                return;
            } catch (modifyError) {
                log('Failed to modify element in place:', modifyError);
            }

            // If modifying in place fails, try replacement
            try {
                const container = document.createElement('div');
                container.className = 'ali-real-price-range';
                container.innerHTML = displayText;

                // Add hover events for variant popup
                const card = element.closest(SELECTORS.productCard);
                if (card) {
                    let popupTimeout;
                    container.addEventListener('mouseenter', () => {
                        log('mouseenter (container)', {productId});
                        popupTimeout = setTimeout(() => {
                            this.showVariantPopup(card, productData.variants, bestVariant, context, productId);
                        }, 200); // Small delay to prevent flicker
                    });

                    container.addEventListener('mouseleave', () => {
                        clearTimeout(popupTimeout);
                        setTimeout(() => {
                            this.hideVariantPopup(card, productId);
                        }, 200); // Small delay to allow moving mouse to popup
                    });
                }

                if (displayOptions.showDistributionGraph) {
                    this.addPriceDistributionGraph(container, bestVariant, priceRange, productId);
                }

                element.parentNode.replaceChild(container, element);
            } catch (error) {
                log('Error replacing price element:', error, {
                    elementHtml: element.outerHTML,
                    parentHtml: element.parentNode?.outerHTML
                });
            }
        }

        showVariantPopup(card, variants, bestVariant, context, productId) {
            log('Showing variant popup', { productId });
            // Remove any existing popup first
            this.hideVariantPopup(card, productId, false); // Don't log removal here

            const popup = document.createElement('div');
            popup.className = 'ali-real-price-popup';

            const variantList = document.createElement('ul');

            const sortedVariants = [...variants].sort((a, b) => {
                const totalA = a.price.discountedValue + a.shipping.cost;
                const totalB = b.price.discountedValue + b.shipping.cost;
                return totalA - totalB;
            });

            for (const variant of sortedVariants) {
                const variantItem = document.createElement('li');
                const isMedianMatch = variant.id === bestVariant.id;

                variantItem.innerHTML = `
                    ${isMedianMatch ? '⊙ ' : '• '}
                    ${variant.name} ${variant.price.discountedFormattedPrice}
                    ${variant.shipping.cost > 0 ? `+ ${variant.shipping.formattedPrice} shipping` : ''}
                    = ${utils.formatPrice(variant.price.discountedValue + variant.shipping.cost)} total
                `;

                if (isMedianMatch) {
                    variantItem.classList.add('median-match');
                }

                variantList.appendChild(variantItem);
            }

            popup.appendChild(variantList);

            const freeShippingThreshold = this.getFreeShippingThreshold(variants, productId);
            if (freeShippingThreshold) {
                const thresholdInfo = document.createElement('div');
                thresholdInfo.className = 'free-shipping-threshold';
                thresholdInfo.textContent = `Free shipping over ${utils.formatPrice(freeShippingThreshold)}`;
                popup.appendChild(thresholdInfo);
            }

            this.positionPopup(popup, card);
            card.appendChild(popup);
        }

        hideVariantPopup(card, productId, shouldLog = true) {
            const popup = card.querySelector('.ali-real-price-popup');
            if (popup) {
                if (shouldLog) log('Hiding variant popup', { productId });
                popup.remove();
            }
        }

        positionPopup(popup, card) {
            const cardRect = card.getBoundingClientRect();
            popup.style.left = '100%';
            popup.style.top = '0';

            // Reposition if popup would go off screen
            requestAnimationFrame(() => {
                const popupRect = popup.getBoundingClientRect();
                if (popupRect.right > window.innerWidth) {
                    popup.style.left = 'auto';
                    popup.style.right = '100%';
                }
            });
        }

        getPriceRange(variants, productId) {
            if (!variants || variants.length === 0) {
                log('No variants provided to getPriceRange', { productId });
                return { min: 0, max: 0 };
            }
            // Calculate total price (item + shipping) for each variant
            const totalPrices = variants.map(v => {
                const itemPrice = v.price?.discountedValue || 0;
                const shippingCost = v.shipping?.cost || 0;
                return itemPrice + shippingCost;
            });

            if (totalPrices.length === 0) {
               log('Calculated totalPrices array is empty', { productId, variants });
               return { min: 0, max: 0 };
            }

            return {
                min: Math.min(...totalPrices),
                max: Math.max(...totalPrices)
            };
        }

        getFreeShippingThreshold(variants, productId) {
            return variants.reduce((threshold, variant) => {
                return variant.shipping.freeThreshold !== null
                    ? Math.min(threshold || Infinity, variant.shipping.freeThreshold)
                    : threshold;
            }, null);
        }

        addPriceDistributionGraph(container, bestVariant, priceRange, productId) {
            const graph = document.createElement('div');
            graph.className = 'ali-real-price-distribution';

            const marker = document.createElement('div');
            marker.className = 'ali-real-price-distribution-marker';

            const position = ((bestVariant.price.discountedValue - priceRange.min) /
                (priceRange.max - priceRange.min)) * 100;
            marker.style.left = `${position}%`;

            graph.appendChild(marker);
            container.appendChild(graph);
        }

        // Helper method to get element depth in DOM
        getElementDepth(element) {
            let depth = 0;
            let current = element;
            while (current.parentNode) {
                depth++;
                current = current.parentNode;
            }
            return depth;
        }
    }

    // Initialize the userscript
    async function init() {
        log('Initializing script...');
        
        // --- Load Cache Disable Preference FIRST --- 
        const storedValue = await GM.getValue('aliexpress_disable_cache', false);
        log(`[init] Loaded 'aliexpress_disable_cache' from GM.getValue: ${storedValue} (Type: ${typeof storedValue})`);
        isCacheDisabled = storedValue;
        log(`[init] Set global isCacheDisabled to: ${isCacheDisabled}`);

        // --- Instantiate LoadingManager AFTER loading preference --- // MOVED LATER
        // const loadingManager = new LoadingManager(); // Instance is global now

        // Add styles
        try {
            GM_addStyle(STYLES);
            log('Styles added successfully');
        } catch (error) {
            log('Error adding styles:', error);
        }

        // Create instances of main classes (except DOMEnhancer)
        const dataManager = new DataManager();
        globalCache = dataManager.cache; // Store cache instance globally
        const priceContextCalculator = new PriceContextCalculator();
        // const domEnhancer = new DOMEnhancer(dataManager, priceContextCalculator); // MOVED LATER

        // Initialize token
        await dataManager.initializeToken();
        log('Token initialized (or checked)');

        // Start observing product cards - COUNT FIRST
        const productCards = document.querySelectorAll(SELECTORS.productCard);
        log('Found initial product cards:', productCards.length);
        
        // Initialize loading manager with total number of products
        // Uses the GLOBAL loadingManager instance implicitly now
        if (productCards.length > 0) {
            loadingManager.completedItems = 0;
            loadingManager.startLoading(productCards.length);
            log(`Loading manager initialized: total=${loadingManager.totalItems}, completed=${loadingManager.completedItems}`);
        } else {
            // Ensure totalItems is 0 if no cards found initially
            loadingManager.totalItems = 0;
            loadingManager.completedItems = 0;
            loadingManager.updateProgress(); // Show 0/0
            log(`Loading manager initialized: total=0 (no initial cards)`);
        }
 
        // --- Create DOMEnhancer AFTER initializing loadingManager ---
        const domEnhancer = new DOMEnhancer(dataManager, priceContextCalculator);
        log('DOMEnhancer created');
 
        // --- Observe Initial Cards ---
        productCards.forEach(card => {
            const productId = utils.extractProductId(card);
            if (productId) {
                log('Observing and immediately enhancing initial card:', productId, { productId });
                domEnhancer.observer.observe(card); // Still observe in case manual call fails or for other reasons
                domEnhancer.enhanceProductCard(card, productId); // Start processing immediately, do not await
            } else {
                log('Skipping initial card - no product ID found', card);
                // If no ID, we can't process, and don't need to increment total/complete counts for it.
                // Adjust loading manager counts if necessary (though startLoading already set the total based on querySelectorAll count)
                // Maybe decrement totalItems if an initial card lacks an ID? Or handle it gracefully in itemComplete?
                // For now, just log and skip.
            }
        });

        // --- Handle dynamic content loading (MutationObserver) ---
        const observer = new MutationObserver((mutations) => {
            log('DOM mutation detected');
            let newCards = [];
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Check if the added node itself is a product card
                        if (node.matches(SELECTORS.productCard)) {
                            newCards.push(node);
                        } else {
                            // Check if the added node contains product cards
                            const cards = node.querySelectorAll(SELECTORS.productCard);
                            if (cards.length > 0) {
                                newCards.push(...Array.from(cards));
                            }
                        }
                    }
                });
            });
            
            // Filter out cards that might have already been processed 
            // (e.g., if mutation observer fires multiple times rapidly)
            newCards = newCards.filter(card => !domEnhancer.processedCards.has(card));

            if (newCards.length > 0) {
                log('Found new product cards via MutationObserver:', newCards.length);
                // Update loading manager with new total
                const newTotal = loadingManager.totalItems + newCards.length;
                // Reset completed count only if starting from zero
                if (loadingManager.totalItems === 0) {
                    log('First batch of dynamic items detected, resetting completed count.');
                    loadingManager.completedItems = 0;
                }
                loadingManager.startLoading(newTotal); // Sets new total, updates display
                
                newCards.forEach(card => {
                    const productId = utils.extractProductId(card);
                    if (productId) { // Ensure we have an ID before observing
                       log('Observing new card found by MutationObserver:', productId, { productId });
                       domEnhancer.observer.observe(card);
                    } else {
                       log('Skipping observation for new card - no product ID found', card);
                    }
                });
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        log('Mutation observer started');
    }

    // Start the script
    if (document.readyState === 'loading') {
        log('Document still loading, waiting for DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', init);
    } else {
        log('Document already loaded, initializing immediately');
        init();
    }

    // --- Function to handle cache disable checkbox change ---
    async function handleDisableCacheChange(event) {
        isCacheDisabled = event.target.checked;
        log('Cache disabled preference changed:', isCacheDisabled);
        await GM.setValue('aliexpress_disable_cache', isCacheDisabled);
        // Optional: Clear cache when disabling?
        if (isCacheDisabled && globalCache) {
             await globalCache.clear();
             log('Cache cleared because it was disabled.');
             // Optionally alert the user or reload
             // alert('Cache disabled and cleared.');
        }
    }
})(); 