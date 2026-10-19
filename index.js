/** LanguageTool UI extension for SillyTavern. */

const EXTENSION_NAME = 'languagetool';
const EXTENSION_FOLDER_FALLBACK = 'third-party/SillyTavern-LanguageTool';
const LOG = '[LanguageTool]';
const API_BASE = '/api/plugins/languagetool';
const MAX_LANGUAGES = 8;
const MAX_CHECK_LENGTH = 20000;
const SERVICE_RETRY_MS = 5000;
const ERROR_TOAST_INTERVAL_MS = 30000;
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    languages: ['auto'],
    inputSelector: '#send_textarea',
    checkDelay: 700,
    ignoreProtected: true,
    ignoredWords: [],
});
// Text that is not prose in a roleplay context: {{macros}}, HTML tags, URLs, `inline code`.
const PROTECTED_PATTERN = /\{\{[^\n]*?\}\}|<\/?[a-z][^>\n]*>|https?:\/\/[^\s<>"']+|`[^`\n]+`/gi;
const WORD_CHAR = /[\p{L}\p{N}_'’-]/u;
const OWN_SELECTOR = '.lt_text_highlights, .lt_text_measure, .lt_panel_toggle, .lt_results_panel, .lt_extension_settings';
const MIRROR_PROPERTIES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'textTransform', 'textIndent', 'textAlign', 'direction', 'tabSize', 'wordBreak',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
];
const LANGUAGE_OPTIONS = [
    ['auto', 'Auto-detect'],
    ['ar', 'Arabic'], ['ast-ES', 'Asturian'], ['be-BY', 'Belarusian'], ['br-FR', 'Breton'],
    ['ca-ES', 'Catalan'], ['ca-ES-balear', 'Catalan (Balearic)'], ['ca-ES-valencia', 'Catalan (Valencian)'],
    ['crh-UA', 'Crimean Tatar'], ['da-DK', 'Danish'], ['de', 'German'], ['de-AT', 'German (Austria)'],
    ['de-CH', 'German (Switzerland)'], ['de-DE', 'German (Germany)'], ['de-LU', 'German (Luxembourg)'],
    ['de-DE-x-simple-language', 'German (Simple)'], ['de-DE-x-simple-language-DE', 'German (Simple DE)'],
    ['el-GR', 'Greek'], ['en', 'English'], ['en-AU', 'English (Australia)'], ['en-CA', 'English (Canada)'],
    ['en-GB', 'English (UK)'], ['en-NZ', 'English (New Zealand)'], ['en-US', 'English (US)'], ['en-ZA', 'English (South Africa)'],
    ['eo', 'Esperanto'], ['es', 'Spanish'], ['es-AR', 'Spanish (Argentina)'], ['es-ES', 'Spanish (Spain)'],
    ['fa', 'Persian'], ['fa-IR', 'Persian (Iran)'], ['fr', 'French'], ['fr-BE', 'French (Belgium)'],
    ['fr-CA', 'French (Canada)'], ['fr-CH', 'French (Switzerland)'], ['fr-FR', 'French (France)'],
    ['ga-IE', 'Irish'], ['gl-ES', 'Galician'], ['it', 'Italian'], ['it-IT', 'Italian (Italy)'],
    ['ja-JP', 'Japanese'], ['km-KH', 'Khmer'], ['nl', 'Dutch'], ['nl-BE', 'Dutch (Belgium)'], ['nl-NL', 'Dutch (Netherlands)'],
    ['pl-PL', 'Polish'], ['pt', 'Portuguese'], ['pt-AO', 'Portuguese (Angola)'], ['pt-BR', 'Portuguese (Brazil)'],
    ['pt-MZ', 'Portuguese (Mozambique)'], ['pt-PT', 'Portuguese (Portugal)'], ['ro-RO', 'Romanian'], ['ru-RU', 'Russian'],
    ['sk-SK', 'Slovak'], ['sl-SI', 'Slovenian'], ['sv', 'Swedish'], ['sv-SE', 'Swedish (Sweden)'],
    ['ta-IN', 'Tamil'], ['tl-PH', 'Tagalog'], ['uk-UA', 'Ukrainian'], ['zh-CN', 'Chinese (Simplified)'],
];

let settingsCache = null;
let csrfToken;
let serviceAvailable;
let serviceCheckedAt = 0;
let serviceStatusPromise;
let settingsReady = false;
let initialized = false;
let targetsInitialized = false;
let refreshTimer = null;
let viewportQueued = false;
let lastErrorToast = 0;
const targets = new Set();
const states = new WeakMap();

/* ------------------------------------------------------------------ */
/* Context, settings                                                   */
/* ------------------------------------------------------------------ */

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function extensionFolder() {
    try {
        const match = new URL(import.meta.url).pathname.match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
        if (match) return decodeURIComponent(match[1]);
    } catch { /* fall through */ }
    return EXTENSION_FOLDER_FALLBACK;
}

function normalizeSelectorList(value) {
    return String(value ?? '').split(/[\r\n,]+/).map(selector => selector.trim()).filter(Boolean).join(',');
}

function normalizeWordList(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[\r\n,]+/);
    return [...new Set(list.map(word => String(word).trim().toLowerCase()).filter(Boolean))];
}

function getSettings() {
    const store = getContext()?.extensionSettings;
    if (!store) return structuredClone(DEFAULT_SETTINGS);
    // Normalise once; afterwards hand out the cached object (this is called very often).
    if (settingsCache && store[EXTENSION_NAME] === settingsCache) return settingsCache;
    const settings = store[EXTENSION_NAME] ??= {};
    // Migrate the old single-language setting before defaults are applied.
    if (!Array.isArray(settings.languages) && typeof settings.language === 'string' && settings.language) settings.languages = [settings.language];
    delete settings.language;
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) settings[key] ??= structuredClone(value);
    settings.languages = [...new Set(settings.languages.filter(language => typeof language === 'string' && language))].slice(0, MAX_LANGUAGES);
    if (!settings.languages.length) settings.languages = ['auto'];
    settings.inputSelector = normalizeSelectorList(settings.inputSelector) || DEFAULT_SETTINGS.inputSelector;
    settings.ignoredWords = normalizeWordList(settings.ignoredWords);
    settingsCache = settings;
    return settings;
}

function saveSettings() {
    getContext()?.saveSettingsDebounced?.();
}

/* ------------------------------------------------------------------ */
/* Plugin status + requests                                            */
/* ------------------------------------------------------------------ */

function updateServiceStatus() {
    const status = document.querySelector('#lt_service_status');
    if (!status) return;
    status.classList.toggle('lt_status_ok', serviceAvailable === true);
    status.classList.toggle('lt_status_error', serviceAvailable === false);
    status.textContent = serviceAvailable === true
        ? 'LanguageTool plugin is ready.'
        : serviceAvailable === false
            ? 'LanguageTool plugin is unavailable. Start or restart the server plugin (click to re-check).'
            : 'Checking LanguageTool plugin…';
}

function markServiceDown() {
    serviceAvailable = false;
    serviceCheckedAt = Date.now();
    updateServiceStatus();
}

async function checkServiceStatus(force = false) {
    if (serviceStatusPromise) return serviceStatusPromise;
    // Don't hammer the status endpoint on every keystroke while the plugin is down.
    if (!force && serviceAvailable === false && Date.now() - serviceCheckedAt < SERVICE_RETRY_MS) return false;
    serviceStatusPromise = (async () => {
        updateServiceStatus();
        try {
            const response = await fetch(`${API_BASE}/status?t=${Date.now()}`, { cache: 'no-store' });
            serviceAvailable = response.ok && (await response.json()).ok === true;
        } catch (error) {
            serviceAvailable = false;
            console.warn(LOG, 'Plugin status check failed:', error);
        }
        serviceCheckedAt = Date.now();
        updateServiceStatus();
        return serviceAvailable;
    })().finally(() => { serviceStatusPromise = undefined; });
    return serviceStatusPromise;
}

async function getCsrfToken() {
    if (!csrfToken) {
        const response = await fetch('/csrf-token');
        if (!response.ok) throw new Error(`Could not get CSRF token (${response.status})`);
        csrfToken = (await response.json()).token;
    }
    if (typeof csrfToken !== 'string' || !csrfToken) throw new Error('Server returned an invalid CSRF token.');
    return csrfToken;
}

async function requestHeaders(forceOwnToken) {
    // Prefer SillyTavern's own headers; fall back to fetching a token ourselves.
    const fromContext = forceOwnToken ? null : getContext()?.getRequestHeaders?.();
    if (fromContext?.['X-CSRF-Token']) return { ...fromContext, 'Content-Type': 'application/json' };
    return { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() };
}

async function checkGrammar(text, signal) {
    const body = JSON.stringify({ text, languages: getSettings().languages });
    for (let attempt = 0; attempt < 2; attempt++) {
        const headers = await requestHeaders(attempt > 0);
        let response;
        try {
            response = await fetch(`${API_BASE}/check`, { method: 'POST', headers, body, signal });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            markServiceDown();
            throw new Error('Could not reach the LanguageTool plugin.');
        }
        if (response.status === 403 && attempt === 0) {
            csrfToken = undefined;
            continue;
        }
        if (response.status === 404) markServiceDown();
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `LanguageTool request failed (${response.status})`);
        }
        return response.json();
    }
    throw new Error('LanguageTool request was rejected after refreshing the CSRF token.');
}

function reportError(error) {
    console.error(LOG, error);
    const now = Date.now();
    if (now - lastErrorToast < ERROR_TOAST_INTERVAL_MS) return;
    lastErrorToast = now;
    globalThis.toastr?.warning(String(error?.message ?? error), 'LanguageTool');
}

/* ------------------------------------------------------------------ */
/* Match helpers (pure)                                                */
/* ------------------------------------------------------------------ */

function protectedRanges(text) {
    return [...text.matchAll(PROTECTED_PATTERN)].map(match => [match.index, match.index + match[0].length]);
}

/** Drop malformed matches, matches inside protected text, and ignored misspellings. */
function filterMatches(text, matches) {
    const settings = getSettings();
    const ignored = new Set(settings.ignoredWords);
    const ranges = settings.ignoreProtected ? protectedRanges(text) : [];
    return matches.filter(match => {
        if (!Number.isInteger(match?.offset) || !Number.isInteger(match?.length)) return false;
        const end = match.offset + match.length;
        if (match.offset < 0 || match.length <= 0 || end > text.length) return false;
        if (ranges.some(([from, to]) => match.offset < to && end > from)) return false;
        if (match.rule?.issueType === 'misspelling' && ignored.has(text.slice(match.offset, end).toLowerCase())) return false;
        return true;
    });
}

function splitTextForCheck(text) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + MAX_CHECK_LENGTH, text.length);
        if (end < text.length) {
            const newline = text.lastIndexOf('\n', end);
            const space = text.lastIndexOf(' ', end);
            const boundary = Math.max(newline, space);
            if (boundary > start + Math.floor(MAX_CHECK_LENGTH * 0.5)) end = boundary + 1;
        }
        chunks.push({ text: text.slice(start, end), start });
        start = end;
    }
    return chunks;
}

/**
 * Keep old matches usable while the user types: shift matches that sit after the edit,
 * keep those before it, and drop the ones the edit touches (fresh results replace them soon).
 */
function rebaseMatches(matches, oldText, newText) {
    if (!matches.length || oldText === newText) return matches;
    let start = 0;
    const shortest = Math.min(oldText.length, newText.length);
    while (start < shortest && oldText[start] === newText[start]) start++;
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    const delta = newEnd - oldEnd;
    const inserted = newText.slice(start, newEnd);
    // An edit that touches a word's edge only matters if the inserted character is part of a word.
    const extendsAfter = WORD_CHAR.test(inserted.charAt(0));
    const extendsBefore = WORD_CHAR.test(inserted.charAt(inserted.length - 1));
    const result = [];
    for (const match of matches) {
        const end = match.offset + match.length;
        if (end < start || (end === start && !extendsAfter)) result.push(match);
        else if (match.offset > oldEnd || (match.offset === oldEnd && !extendsBefore)) result.push({ ...match, offset: match.offset + delta });
    }
    return result;
}

function isSpelling(match) {
    return match.rule?.issueType === 'misspelling';
}

/* ------------------------------------------------------------------ */
/* Target discovery                                                    */
/* ------------------------------------------------------------------ */

function eachState(callback) {
    for (const input of targets) {
        const state = states.get(input);
        if (state) callback(state);
    }
}

function isSupportedTextInput(element) {
    if (element.closest('.lt_extension_settings')) return false;
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    // Never send password fields to a grammar service.
    return ['text', 'search', 'email', 'url', 'tel'].includes(element.type);
}

function matchedInputs() {
    try {
        return [...document.querySelectorAll(getSettings().inputSelector)].filter(isSupportedTextInput);
    } catch (error) {
        console.warn(LOG, 'Invalid input selector:', error);
        return [];
    }
}

function refreshTargets() {
    const matched = new Set(matchedInputs());
    for (const input of [...targets]) {
        const state = states.get(input);
        if (!matched.has(input) || !input.isConnected || state?.parent !== input.parentElement) disposeState(input);
    }
    for (const input of matched) {
        if (targets.has(input)) continue;
        const state = createState(input);
        if (targetsInitialized) scheduleCheck(state);
    }
    targetsInitialized = true;
}

function queueRefreshTargets() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshTargets();
    }, 100);
}

function isOwnNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return !!element?.closest?.(OWN_SELECTOR);
}

function mightContainInput(node) {
    return node?.nodeType === 1 && !isOwnNode(node) && (node.matches('textarea, input') || !!node.querySelector('textarea, input'));
}

function isRelevantMutation(mutation) {
    if (isOwnNode(mutation.target)) return false;
    if (mutation.type === 'attributes') return true;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(mightContainInput);
}

function watchInputValues() {
    if (document.hidden || !getSettings().enabled) return;
    eachState(state => {
        if (!state.input.isConnected) return;
        const value = state.input.value;
        if (value === state.lastValue) return;
        state.lastValue = value;
        scheduleCheck(state);
    });
}

/* ------------------------------------------------------------------ */
/* Per-input state                                                     */
/* ------------------------------------------------------------------ */

function createState(input) {
    const state = {
        input, parent: input.parentElement, lastValue: input.value, timer: null, requestId: 0, abort: null,
        text: '', matches: [], selectedMatch: null, panelAnchor: null, panelVisible: false, checking: false,
        borderLeft: 0, borderTop: 0,
        toggle: null, panel: null, overlay: null, inner: null, mirror: null, observer: null,
        onInput: null, onScroll: null, onClick: null, onFocus: null,
    };
    states.set(input, state);
    targets.add(input);
    state.onInput = () => { state.lastValue = input.value; scheduleCheck(state); };
    state.onScroll = () => syncScroll(state);
    state.onClick = () => handleCaretClick(state);
    state.onFocus = () => {
        scheduleCheck(state);
        queueViewportUpdate();
    };
    input.addEventListener('input', state.onInput);
    input.addEventListener('change', state.onInput);
    input.addEventListener('scroll', state.onScroll, { passive: true });
    input.addEventListener('click', state.onClick);
    input.addEventListener('focus', state.onFocus);
    createToggle(state);
    createHighlightLayer(state);
    return state;
}

function stateFor(input) {
    return states.get(input) ?? createState(input);
}

function disposeState(input) {
    const state = states.get(input);
    if (!state) return;
    clearTimeout(state.timer);
    state.abort?.abort();
    input.removeEventListener('input', state.onInput);
    input.removeEventListener('change', state.onInput);
    input.removeEventListener('scroll', state.onScroll);
    input.removeEventListener('click', state.onClick);
    input.removeEventListener('focus', state.onFocus);
    state.observer?.disconnect();
    state.toggle?.remove();
    state.panel?.remove();
    state.overlay?.remove();
    state.mirror?.remove();
    targets.delete(input);
    states.delete(input);
}

function positionedParent(input) {
    const parent = input.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    return parent;
}

/* ------------------------------------------------------------------ */
/* Toggle button, highlight layer                                      */
/* ------------------------------------------------------------------ */

function createToggle(state) {
    const parent = positionedParent(state.input);
    if (!parent) return;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lt_panel_toggle';
    toggle.innerHTML = '<i class="fa-solid fa-spell-check"></i><span></span>';
    toggle.addEventListener('click', () => {
        if (!state.matches.length) return;
        if (state.panelVisible && state.selectedMatch === null) closePanel(state);
        else openPanel(state, null, toggle);
    });
    parent.append(toggle);
    state.toggle = toggle;
    state.observer = new ResizeObserver(() => {
        renderHighlights(state);
        positionToggle(state);
        positionPanel(state);
    });
    state.observer.observe(state.input);
    if (parent !== state.input) state.observer.observe(parent);
    positionToggle(state);
}

function positionToggle(state) {
    if (!state.toggle || !state.input.isConnected) return;
    const input = state.input;
    state.toggle.style.left = `${input.offsetLeft + input.clientWidth - state.toggle.offsetWidth - 6}px`;
    state.toggle.style.top = `${input.offsetTop + input.clientHeight - state.toggle.offsetHeight - 6}px`;
}

function updateToggle(state) {
    if (!state.toggle) return;
    const count = state.matches.length;
    state.toggle.hidden = !getSettings().enabled;
    state.toggle.disabled = state.checking || count === 0;
    state.toggle.classList.toggle('loading', state.checking);
    const icon = state.toggle.querySelector('i');
    if (icon) icon.className = state.checking ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-spell-check';
    state.toggle.classList.toggle('has_errors', count > 0);
    state.toggle.classList.toggle('active', count > 0 && state.panelVisible);
    state.toggle.querySelector('span').textContent = count ? String(count) : '';
    state.toggle.title = state.checking
        ? 'Checking with LanguageTool…'
        : count
            ? `${count} LanguageTool issue${count === 1 ? '' : 's'}`
            : 'No LanguageTool issues';
    positionToggle(state);
}

function createHighlightLayer(state) {
    const parent = positionedParent(state.input);
    if (!parent) return;
    // overlay clips to the input's scrollable area; inner is shifted to follow scrolling,
    // so scrolling only changes one transform instead of re-measuring every match.
    state.overlay = document.createElement('div');
    state.overlay.className = 'lt_text_highlights';
    state.overlay.setAttribute('aria-hidden', 'true');
    state.inner = document.createElement('div');
    state.inner.className = 'lt_text_highlights_inner';
    state.overlay.append(state.inner);
    state.mirror = document.createElement('div');
    state.mirror.className = 'lt_text_measure';
    state.mirror.setAttribute('aria-hidden', 'true');
    parent.append(state.overlay, state.mirror);
}

function syncScroll(state) {
    if (state.inner) state.inner.style.transform = `translate(${-state.input.scrollLeft}px, ${-state.input.scrollTop}px)`;
}

function syncLayers(state) {
    const { input, overlay, mirror } = state;
    if (!overlay || !mirror || !input.isConnected) return;
    const style = getComputedStyle(input);
    for (const property of MIRROR_PROPERTIES) mirror.style[property] = style[property];
    const singleLine = input instanceof HTMLInputElement;
    state.borderLeft = parseFloat(style.borderLeftWidth) || 0;
    state.borderTop = parseFloat(style.borderTopWidth) || 0;
    const borderX = state.borderLeft + (parseFloat(style.borderRightWidth) || 0);
    const borderY = state.borderTop + (parseFloat(style.borderBottomWidth) || 0);
    Object.assign(mirror.style, {
        boxSizing: 'border-box',
        borderStyle: 'solid',
        borderColor: 'transparent',
        whiteSpace: singleLine ? 'pre' : 'pre-wrap',
        overflowWrap: singleLine ? 'normal' : (style.overflowWrap || 'break-word'),
        display: singleLine ? 'flex' : 'block',
        alignItems: singleLine ? 'center' : '',
        left: `${input.offsetLeft}px`,
        top: `${input.offsetTop}px`,
        // clientWidth excludes the scrollbar, so wrapping matches the real text area.
        width: `${input.clientWidth + borderX}px`,
        height: `${input.clientHeight + borderY}px`,
    });
    Object.assign(overlay.style, {
        left: `${input.offsetLeft + state.borderLeft}px`,
        top: `${input.offsetTop + state.borderTop}px`,
        width: `${input.clientWidth}px`,
        height: `${input.clientHeight}px`,
    });
    syncScroll(state);
}

function clearHighlights(state) {
    state.inner?.replaceChildren();
}

function renderHighlights(state) {
    clearHighlights(state);
    if (!state.matches.length || !state.inner || !state.mirror || !state.input.isConnected) return;
    syncLayers(state);
    state.mirror.textContent = state.text;
    const textNode = state.mirror.firstChild;
    if (!textNode) return;
    const box = state.mirror.getBoundingClientRect();
    // Account for CSS transforms (e.g. scaled popups) on ancestors.
    const scaleX = box.width && state.mirror.offsetWidth ? box.width / state.mirror.offsetWidth : 1;
    const scaleY = box.height && state.mirror.offsetHeight ? box.height / state.mirror.offsetHeight : 1;
    const range = document.createRange();
    const fragment = document.createDocumentFragment();
    for (const [matchIndex, match] of state.matches.entries()) {
        if (match.offset + match.length > textNode.length) continue;
        range.setStart(textNode, match.offset);
        range.setEnd(textNode, match.offset + match.length);
        for (const rect of range.getClientRects()) {
            if (!rect.width || !rect.height) continue;
            const marker = document.createElement('span');
            marker.className = isSpelling(match) ? 'spelling' : 'grammar';
            marker.dataset.matchIndex = String(matchIndex);
            marker.style.left = `${(rect.left - box.left) / scaleX - state.borderLeft}px`;
            marker.style.top = `${(rect.top - box.top) / scaleY - state.borderTop}px`;
            marker.style.width = `${rect.width / scaleX}px`;
            marker.style.height = `${rect.height / scaleY}px`;
            fragment.append(marker);
        }
    }
    state.inner.append(fragment);
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

function scheduleCheck(state) {
    clearTimeout(state.timer);
    state.requestId++;
    state.abort?.abort();
    state.abort = null;
    const settings = getSettings();
    const text = state.input.value;
    if (!settings.enabled || !text.trim()) {
        clearResult(state);
        return;
    }
    // Keep the previous results on screen (shifted to match the edit) instead of flickering.
    if (state.matches.length && state.text !== text) {
        state.matches = rebaseMatches(state.matches, state.text, text);
        state.text = text;
        if (state.selectedMatch !== null) state.panelVisible = false;
        state.selectedMatch = null;
        renderHighlights(state);
        renderPanel(state);
        updateToggle(state);
    }
    state.timer = setTimeout(() => checkTarget(state), settings.checkDelay);
}

function scheduleAll() {
    eachState(scheduleCheck);
}

async function checkTarget(state) {
    const requestId = ++state.requestId;
    state.checking = true;
    updateToggle(state);
    const controller = new AbortController();
    state.abort = controller;
    try {
        if (serviceAvailable !== true && !(await checkServiceStatus())) return;
        if (requestId !== state.requestId || !targets.has(state.input)) return;
        const text = state.input.value;
        if (!text.trim()) {
            clearResult(state);
            return;
        }
        const matches = [];
        for (const chunk of splitTextForCheck(text)) {
            const result = await checkGrammar(chunk.text, controller.signal);
            for (const match of Array.isArray(result?.matches) ? result.matches : []) {
                matches.push({ ...match, offset: match.offset + chunk.start });
            }
            if (requestId !== state.requestId || !targets.has(state.input)) return;
        }
        if (requestId !== state.requestId || state.input.value !== text || !targets.has(state.input)) return;
        state.text = text;
        state.matches = filterMatches(text, matches);
        state.selectedMatch = null;
        renderHighlights(state);
        renderPanel(state);
        updateToggle(state);
    } catch (error) {
        if (error?.name !== 'AbortError') reportError(error);
    } finally {
        if (state.abort === controller) state.abort = null;
        if (requestId === state.requestId) {
            state.checking = false;
            updateToggle(state);
        }
    }
}

function clearResult(state) {
    state.matches = [];
    state.text = state.input.value;
    state.selectedMatch = null;
    state.panelAnchor = null;
    state.panelVisible = false;
    state.panel?.remove();
    state.panel = null;
    clearHighlights(state);
    updateToggle(state);
}

function refilterAll() {
    eachState(state => {
        if (!state.matches.length) return;
        state.matches = filterMatches(state.text, state.matches);
        if (state.selectedMatch !== null) state.panelVisible = false;
        state.selectedMatch = null;
        renderHighlights(state);
        renderPanel(state);
        updateToggle(state);
    });
}

/* ------------------------------------------------------------------ */
/* Results panel                                                       */
/* ------------------------------------------------------------------ */

function openPanel(state, matchIndex, anchor) {
    eachState(other => { if (other !== state && other.panelVisible) closePanel(other); });
    state.selectedMatch = matchIndex;
    state.panelAnchor = anchor;
    state.panelVisible = true;
    renderPanel(state);
    updateToggle(state);
}

function closePanel(state) {
    state.panelVisible = false;
    state.panel?.classList.remove('visible');
    updateToggle(state);
}

function closeAllPanels() {
    eachState(state => { if (state.panelVisible) closePanel(state); });
}

function handleCaretClick(state) {
    const { input } = state;
    if (typeof input.selectionStart !== 'number' || input.selectionStart !== input.selectionEnd) return;
    if (!state.matches.length || input.value !== state.text) return;
    const caret = input.selectionStart;
    let index = state.matches.findIndex(match => caret > match.offset && caret < match.offset + match.length);
    if (index < 0) index = state.matches.findIndex(match => caret >= match.offset && caret <= match.offset + match.length);
    if (index >= 0) {
        const marker = state.inner?.querySelector(`[data-match-index="${index}"]`);
        openPanel(state, index, marker ?? state.toggle);
    } else if (state.panelVisible && state.selectedMatch !== null) {
        closePanel(state);
    }
}

function replacementLabel(value) {
    if (value === '') return '(delete)';
    return value.trim() === '' ? '␣' : value;
}

function renderPanel(state) {
    state.panel?.remove();
    state.panel = null;
    if (!state.matches.length) return;
    if (state.selectedMatch !== null && !state.matches[state.selectedMatch]) state.selectedMatch = null;
    const visibleMatches = state.selectedMatch !== null
        ? [[state.matches[state.selectedMatch], state.selectedMatch]]
        : state.matches.map((match, index) => [match, index]);
    const panel = document.createElement('section');
    panel.className = `lt_results_panel${state.panelVisible ? ' visible' : ''}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'LanguageTool issues');
    panel.innerHTML = `<header class="lt_panel_header"><span><i class="fa-solid fa-spell-check"></i> ${visibleMatches.length} issue${visibleMatches.length === 1 ? '' : 's'}</span><span class="lt_panel_actions">${state.selectedMatch !== null ? '<button type="button" class="lt_panel_all">All</button>' : ''}<button type="button" class="lt_panel_close" title="Hide results (Esc)"><i class="fa-solid fa-xmark"></i></button></span></header><div class="lt_matches_list"></div>`;
    panel.querySelector('.lt_panel_close').addEventListener('click', () => closePanel(state));
    panel.querySelector('.lt_panel_all')?.addEventListener('click', () => { state.selectedMatch = null; renderPanel(state); });
    const list = panel.querySelector('.lt_matches_list');
    for (const [match, index] of visibleMatches) {
        const item = document.createElement('article');
        item.className = `lt_match_item ${isSpelling(match) ? 'spelling' : 'grammar'}`;
        const heading = document.createElement('div');
        heading.className = 'lt_match_header';
        const value = document.createElement('code');
        const original = state.text.slice(match.offset, match.offset + match.length);
        value.textContent = original || ' ';
        const message = document.createElement('span');
        message.textContent = match.shortMessage || match.message || 'Possible issue';
        if (match.message) message.title = match.message;
        heading.append(value, message);
        const replacements = document.createElement('div');
        replacements.className = 'lt_replacements';
        for (const replacement of (match.replacements || []).slice(0, 5)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'lt_replacement_chip';
            button.textContent = replacementLabel(String(replacement.value ?? ''));
            button.addEventListener('click', () => applyReplacement(state, index, String(replacement.value ?? '')));
            replacements.append(button);
        }
        if (!replacements.childElementCount) {
            const none = document.createElement('span');
            none.textContent = 'No automatic replacement';
            replacements.append(none);
        }
        if (isSpelling(match)) {
            const ignore = document.createElement('button');
            ignore.type = 'button';
            ignore.className = 'lt_replacement_chip lt_ignore_chip';
            ignore.textContent = 'Ignore word';
            ignore.title = 'Never flag this word again';
            ignore.addEventListener('click', () => ignoreWord(original));
            replacements.append(ignore);
        }
        item.append(heading, replacements);
        list.append(item);
    }
    document.body.append(panel);
    state.panel = panel;
    positionPanel(state);
}

function positionPanel(state) {
    if (!state.panel || !state.panelVisible || !state.input.isConnected) return;
    const input = state.input;
    let anchor = state.panelAnchor?.isConnected ? state.panelAnchor : input;
    let anchorRect = anchor.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    // A highlighted word that was scrolled out of view can't anchor the panel any more.
    if (anchor !== input && anchor !== state.toggle && (anchorRect.bottom < inputRect.top || anchorRect.top > inputRect.bottom)) {
        anchor = state.toggle?.isConnected ? state.toggle : input;
        anchorRect = anchor.getBoundingClientRect();
    }
    const viewportPadding = 8;
    const gap = 6;
    const panelWidth = Math.min(Math.max(input.clientWidth, 280), Math.max(180, window.innerWidth - viewportPadding * 2));
    const leftInViewport = Math.max(viewportPadding, Math.min(anchorRect.left, window.innerWidth - panelWidth - viewportPadding));
    const belowSpace = window.innerHeight - anchorRect.bottom - viewportPadding - gap;
    const aboveSpace = anchorRect.top - viewportPadding - gap;
    state.panel.style.width = `${panelWidth}px`;
    state.panel.style.maxHeight = 'none';
    const naturalHeight = state.panel.scrollHeight;
    const listLimit = Math.min(360, window.innerHeight * 0.4);
    const wordLimit = Math.max(160, window.innerHeight - viewportPadding * 2);
    const cappedHeight = Math.min(naturalHeight || 240, state.selectedMatch === null ? listLimit : wordLimit);
    const placeAbove = belowSpace < cappedHeight && aboveSpace > belowSpace;
    const availableHeight = Math.max(120, placeAbove ? aboveSpace : belowSpace);
    const panelHeight = Math.min(cappedHeight, availableHeight);
    const topInViewport = placeAbove
        ? Math.max(viewportPadding, anchorRect.top - gap - panelHeight)
        : anchorRect.bottom + gap;
    state.panel.style.left = `${leftInViewport}px`;
    state.panel.style.top = `${topInViewport}px`;
    state.panel.style.maxHeight = `${panelHeight}px`;
}

function queueViewportUpdate() {
    if (viewportQueued) return;
    viewportQueued = true;
    requestAnimationFrame(() => {
        viewportQueued = false;
        // Only the fixed-position panel needs to follow scrolling/resizing.
        eachState(state => { if (state.panelVisible) positionPanel(state); });
    });
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function applyReplacement(state, matchIndex, replacement) {
    const match = state.matches[matchIndex];
    const input = state.input;
    if (!match || input.value !== state.text) return;
    const end = match.offset + match.length;
    let applied = false;
    // execCommand keeps the browser's undo history (Ctrl+Z) intact and fires a native input event.
    try {
        input.focus();
        input.setSelectionRange(match.offset, end);
        applied = document.execCommand('insertText', false, replacement);
    } catch { /* fall back below */ }
    if (!applied) {
        input.value = `${input.value.slice(0, match.offset)}${replacement}${input.value.slice(end)}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

function ignoreWord(word) {
    const value = String(word).trim().toLowerCase();
    if (!value) return;
    const settings = getSettings();
    if (!settings.ignoredWords.includes(value)) settings.ignoredWords.push(value);
    const field = document.querySelector('#lt_ignored_words');
    if (field) field.value = settings.ignoredWords.join('\n');
    saveSettings();
    refilterAll();
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

async function initSettings() {
    if (settingsReady) return;
    const context = getContext();
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!host || !context?.renderExtensionTemplateAsync) {
        console.warn(LOG, 'Settings panel could not be created (host or template renderer missing).');
        return;
    }
    settingsReady = true;
    let html;
    try {
        html = await context.renderExtensionTemplateAsync(extensionFolder(), 'settings', {
            languages: LANGUAGE_OPTIONS.map(([value, label]) => ({ value, label })),
        });
    } catch (error) {
        settingsReady = false;
        console.error(LOG, 'Could not load the settings template:', error);
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    const panel = wrapper.querySelector('.lt_extension_settings');
    if (!panel) return;
    host.append(panel);
    updateServiceStatus();

    const settings = getSettings();
    const enabled = panel.querySelector('#lt_enabled');
    const status = panel.querySelector('#lt_service_status');
    const languages = panel.querySelector('#lt_languages');
    const selector = panel.querySelector('#lt_input_selector');
    const protectedBox = panel.querySelector('#lt_ignore_protected');
    const ignored = panel.querySelector('#lt_ignored_words');
    const delay = panel.querySelector('#lt_check_delay');
    const languageInputs = [...languages.querySelectorAll('input[type="checkbox"]')];

    enabled.checked = settings.enabled;
    protectedBox.checked = settings.ignoreProtected;
    for (const option of languageInputs) option.checked = settings.languages.includes(option.value);
    selector.value = settings.inputSelector.split(',').join('\n');
    ignored.value = settings.ignoredWords.join('\n');
    delay.value = settings.checkDelay;

    enabled.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        scheduleAll();
        saveSettings();
    });
    status.addEventListener('click', async () => {
        if (await checkServiceStatus(true)) scheduleAll();
    });
    languages.addEventListener('change', () => {
        const picked = languageInputs.filter(option => option.checked).map(option => option.value);
        if (picked.length > MAX_LANGUAGES) globalThis.toastr?.info(`LanguageTool can check up to ${MAX_LANGUAGES} languages at once.`);
        settings.languages = picked.slice(0, MAX_LANGUAGES);
        if (!settings.languages.length) settings.languages = ['auto'];
        for (const option of languageInputs) option.checked = settings.languages.includes(option.value);
        scheduleAll();
        saveSettings();
    });
    selector.addEventListener('change', () => {
        settings.inputSelector = normalizeSelectorList(selector.value) || DEFAULT_SETTINGS.inputSelector;
        selector.value = settings.inputSelector.split(',').join('\n');
        refreshTargets();
        saveSettings();
    });
    protectedBox.addEventListener('change', () => {
        settings.ignoreProtected = protectedBox.checked;
        scheduleAll();
        saveSettings();
    });
    ignored.addEventListener('change', () => {
        settings.ignoredWords = normalizeWordList(ignored.value);
        ignored.value = settings.ignoredWords.join('\n');
        scheduleAll();
        saveSettings();
    });
    delay.addEventListener('change', () => {
        settings.checkDelay = Math.max(100, Math.min(10000, Number(delay.value) || DEFAULT_SETTINGS.checkDelay));
        delay.value = settings.checkDelay;
        scheduleAll();
        saveSettings();
    });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** Manifest hook: runs when the user chooses to clean this extension's data. */
export function onClean() {
    const store = getContext()?.extensionSettings;
    if (!store) return;
    delete store[EXTENSION_NAME];
    settingsCache = null;
    saveSettings();
}

function init() {
    if (initialized) return;
    initialized = true;
    initSettings();
    checkServiceStatus();
    refreshTargets();
    setInterval(watchInputValues, 300);
    window.addEventListener('resize', queueViewportUpdate);
    window.addEventListener('scroll', queueViewportUpdate, { capture: true, passive: true });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAllPanels(); });
    document.addEventListener('pointerdown', event => {
        const target = event.target;
        if (target?.closest?.('.lt_results_panel, .lt_panel_toggle')) return;
        eachState(state => { if (state.panelVisible && target !== state.input) closePanel(state); });
    });
    new MutationObserver(mutations => {
        if (mutations.some(isRelevantMutation)) queueRefreshTargets();
    }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['id', 'class', 'type'],
    });
}

const context = getContext();
if (context?.eventSource && context.event_types?.APP_READY) {
    // APP_READY auto-fires for late listeners; defer so we don't block the app becoming ready.
    context.eventSource.on(context.event_types.APP_READY, () => setTimeout(init, 0));
} else {
    jQuery(init);
}
