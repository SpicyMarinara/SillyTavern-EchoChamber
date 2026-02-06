// EchoChamber Extension - Import-free version using SillyTavern.getContext()
// No ES6 imports - uses the stable SillyTavern global object

(function () {
    'use strict';

    // Module identification
    const MODULE_NAME = 'discord_chat';
    const EXTENSION_NAME = 'EchoChamber';

    // Get BASE_URL from script tag
    const scripts = document.querySelectorAll('script[src*="index.js"]');
    let BASE_URL = '';
    for (const script of scripts) {
        if (script.src.includes('EchoChamber') || script.src.includes('DiscordChat')) {
            BASE_URL = script.src.split('/').slice(0, -1).join('/');
            break;
        }
    }

    const defaultSettings = {
        enabled: true,
        paused: false,
        source: 'default',
        preset: '',
        url: 'http://localhost:11434',
        model: '',
        openai_url: 'http://localhost:1234/v1',
        openai_key: '',
        openai_model: 'local-model',
        openai_preset: 'custom',
        userCount: 5,
        fontSize: 15,
        chatHeight: 250,
        style: 'twitch',
        position: 'bottom',
        panelWidth: 350,
        opacity: 85,
        collapsed: false,
        autoUpdateOnMessages: true,
        includeUserInput: false,
        contextDepth: 4,
        includePastEchoChambers: false,
        includePersona: false,
        includeCharacterDescription: false,
        includeSummary: false,
        includeWorldInfo: false,
        livestream: false,
        livestreamBatchSize: 20,
        livestreamMode: 'manual',
        livestreamMinWait: 5,
        livestreamMaxWait: 60,
        custom_styles: {},
        deleted_styles: []
    };

    let settings = JSON.parse(JSON.stringify(defaultSettings));
    let discordBar = null;
    let discordContent = null;
    let discordQuickBar = null;
    let abortController = null;
    let generateTimeout = null;
    let debounceTimeout = null;
    let eventsBound = false;  // Prevent duplicate event listener registration
    let userCancelled = false; // Track user-initiated cancellations
    let isLoadingChat = false; // Track when we're loading/switching chats to prevent auto-generation
    let isGenerating = false; // Track when generation is in progress to prevent concurrent requests

    // Livestream state
    let livestreamQueue = []; // Queue of messages to display
    let livestreamTimer = null; // Timer for displaying next message
    let livestreamActive = false; // Whether livestream is currently displaying messages

    // Pop-out window state
    let popoutWindow = null; // Reference to pop-out window
    let popoutDiscordBar = null; // Reference to panel in pop-out window
    let popoutDiscordContent = null; // Reference to content in pop-out window

    // Simple debounce
    function debounce(func, wait) {
        return function (...args) {
            clearTimeout(debounceTimeout);
            debounceTimeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    const generateDebounced = debounce(() => generateDiscordChat(), 500);

    // ============================================================
    // UTILITY FUNCTIONS
    // ============================================================

    // Debug logging disabled for production
    // Enable by uncommenting the console calls below
    function log(...args) { /* console.log(`[${EXTENSION_NAME}]`, ...args); */ }
    function warn(...args) { /* console.warn(`[${EXTENSION_NAME}]`, ...args); */ }
    function error(...args) { console.error(`[${EXTENSION_NAME}]`, ...args); } // Keep errors visible

    /**
     * Extract text content from any API response format.
     * Handles: Anthropic content arrays (extended thinking), OpenAI format,
     * raw strings, and unknown shapes with deep extraction.
     */
    function extractTextFromResponse(response) {
        if (!response) return '';

        // 1. Response is already a plain string
        if (typeof response === 'string') return response;

        // 2. Response itself is an array of content blocks (e.g. extractData returned the content array directly)
        if (Array.isArray(response)) {
            const textParts = response
                .filter(block => block && block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text);
            if (textParts.length > 0) return textParts.join('\n');
            // Fallback: maybe it's an array of strings
            const stringParts = response.filter(item => typeof item === 'string');
            if (stringParts.length > 0) return stringParts.join('\n');
            return JSON.stringify(response);
        }

        // 3. response.content exists
        if (response.content !== undefined && response.content !== null) {
            // 3a. content is a string
            if (typeof response.content === 'string') return response.content;
            // 3b. content is an array of content blocks (Anthropic extended thinking format)
            if (Array.isArray(response.content)) {
                const textParts = response.content
                    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
                    .map(block => block.text);
                if (textParts.length > 0) return textParts.join('\n');
            }
        }

        // 4. OpenAI choices format
        if (response.choices?.[0]?.message?.content) {
            const choiceContent = response.choices[0].message.content;
            if (typeof choiceContent === 'string') return choiceContent;
            if (Array.isArray(choiceContent)) {
                const textParts = choiceContent
                    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
                    .map(block => block.text);
                if (textParts.length > 0) return textParts.join('\n');
            }
        }

        // 5. Other common fields
        if (typeof response.text === 'string') return response.text;
        if (typeof response.message === 'string') return response.message;
        if (response.message?.content && typeof response.message.content === 'string') return response.message.content;

        // 6. Last resort - stringify
        console.error('[EchoChamber] Could not extract text from response, stringifying:', response);
        return JSON.stringify(response);
    }

    function setDiscordText(html) {
        if (!discordContent) return;

        const chatBlock = jQuery('#chat');
        const originalScrollBottom = chatBlock.length ?
            chatBlock[0].scrollHeight - (chatBlock.scrollTop() + chatBlock.outerHeight()) : 0;

        discordContent.html(html);

        // Scroll to top of the EchoChamber panel
        if (discordContent[0]) {
            discordContent[0].scrollTo({ top: 0, behavior: 'smooth' });
        }

        if (chatBlock.length) {
            const newScrollTop = chatBlock[0].scrollHeight - (chatBlock.outerHeight() + originalScrollBottom);
            chatBlock.scrollTop(newScrollTop);
        }

        // Sync to popout window if active
        if (popoutWindow && !popoutWindow.closed && popoutDiscordContent) {
            popoutDiscordContent.innerHTML = html;
            popoutDiscordContent.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function setStatus(html) {
        const overlay = jQuery('.ec_status_overlay');
        if (overlay.length > 0) {
            if (html) {
                overlay.html(html).addClass('active');
            } else {
                overlay.removeClass('active');
                setTimeout(() => { if (!overlay.hasClass('active')) overlay.empty(); }, 200);
            }
        }
    }

    function applyFontSize(size) {
        let styleEl = jQuery('#discord_font_size_style');
        if (styleEl.length === 0) {
            styleEl = jQuery('<style id="discord_font_size_style"></style>').appendTo('head');
        }
        styleEl.text(`
            .discord_container { font-size: ${size}px !important; }
            .discord_username { font-size: ${size / 15}rem !important; }
            .discord_content { font-size: ${(size / 15) * 0.95}rem !important; }
            .discord_timestamp { font-size: ${(size / 15) * 0.75}rem !important; }
        `);
    }

    function formatMessage(username, content) {
        // Use DOMPurify from SillyTavern's shared libraries
        const { DOMPurify } = SillyTavern.libs;

        let hash = 0;
        for (let i = 0; i < username.length; i++) {
            hash = username.charCodeAt(i) + ((hash << 5) - hash);
        }
        const color = `hsl(${Math.abs(hash) % 360}, 75%, 70%)`;
        const now = new Date();
        const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Sanitize both username and content using DOMPurify
        const safeUsername = DOMPurify.sanitize(username, { ALLOWED_TAGS: [] });
        const safeContent = DOMPurify.sanitize(content, { ALLOWED_TAGS: [] });

        // Apply markdown-style formatting after sanitization
        const formattedContent = safeContent
            .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/__(.*?)__/g, '<u>$1</u>')
            .replace(/_(.*?)_/g, '<em>$1</em>')
            .replace(/~~(.*?)~~/g, '<del>$1</del>')
            .replace(/`(.+?)`/g, '<code>$1</code>');

        return `
        <div class="discord_message">
            <div class="discord_avatar" style="background-color: ${color};">${safeUsername.substring(0, 1).toUpperCase()}</div>
            <div class="discord_body">
                <div class="discord_header">
                    <span class="discord_username" style="color: ${color};">${safeUsername}</span>
                    <span class="discord_timestamp">${time}</span>
                </div>
                <div class="discord_content">${formattedContent}</div>
            </div>
        </div>`;
    }

    function onChatEvent(clear, autoGenerate = true) {
        if (clear) {
            setDiscordText('');
            clearCachedCommentary();
            stopLivestream();
        }
        // Cancel any pending generation
        if (abortController) abortController.abort();
        clearTimeout(debounceTimeout);

        // Only auto-generate if triggered by a new message, not by loading a chat
        if (autoGenerate) {
            // If livestream is enabled and in onMessage mode, don't use regular generation
            if (settings.livestream && settings.livestreamMode === 'onMessage') {
                // Only start new batch if livestream isn't actively displaying
                // If it's active, let it finish first
                if (!livestreamActive) {
                    generateDebounced();
                } else {
                    log('Livestream active, skipping new generation trigger');
                }
            } else if (!settings.livestream) {
                // Regular mode
                generateDebounced();
            }
            // If livestream is in onComplete mode, let it handle its own generation cycle
        } else {
            // When loading a chat, restore cached commentary
            stopLivestream();
            restoreCachedCommentary();
        }
    }

    // ============================================================
    // METADATA MANAGEMENT FOR PERSISTENCE
    // ============================================================

    function getChatMetadata() {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;
        if (!chatId) return null;

        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = {};
        }
        if (!context.extensionSettings[MODULE_NAME].chatMetadata) {
            context.extensionSettings[MODULE_NAME].chatMetadata = {};
        }

        return context.extensionSettings[MODULE_NAME].chatMetadata[chatId] || null;
    }

    function saveChatMetadata(data) {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;
        if (!chatId) {
            log('Cannot save metadata: no chatId');
            return;
        }

        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = {};
        }
        if (!context.extensionSettings[MODULE_NAME].chatMetadata) {
            context.extensionSettings[MODULE_NAME].chatMetadata = {};
        }

        context.extensionSettings[MODULE_NAME].chatMetadata[chatId] = data;
        log('Saved metadata for chatId:', chatId, 'data keys:', Object.keys(data));
        context.saveSettingsDebounced();
    }

    function clearCachedCommentary() {
        saveChatMetadata(null);
        log('Cleared cached commentary for current chat');
    }

    function restoreCachedCommentary() {
        const metadata = getChatMetadata();
        log('Attempting to restore cached commentary, metadata:', metadata);

        if (!metadata) {
            setDiscordText('');
            log('No cached commentary found');
            return;
        }

        // Check if we need to resume a livestream that was interrupted
        if (settings.livestream && metadata.fullGeneratedHtml && !metadata.livestreamComplete) {
            // Livestream was in progress - figure out what's been shown vs what's remaining
            const fullMessages = parseLivestreamMessages(metadata.fullGeneratedHtml);
            const displayedHtml = metadata.generatedHtml || '';
            const displayedMessages = displayedHtml ? parseLivestreamMessages(displayedHtml) : [];

            log('Livestream restore check: full messages:', fullMessages.length, 'displayed:', displayedMessages.length);

            if (fullMessages.length > displayedMessages.length) {
                // There are remaining messages to show
                // First, display what was already shown (if any)
                if (displayedHtml) {
                    setDiscordText(displayedHtml);
                }

                // Calculate remaining messages (they're at the end of fullMessages since we prepend)
                // Messages are prepended, so displayed ones are at the start of the container
                // We need to find which ones from fullMessages haven't been shown yet
                const remainingCount = fullMessages.length - displayedMessages.length;
                const remainingMessages = fullMessages.slice(0, remainingCount); // First N are the ones not yet shown

                log('Resuming livestream with', remainingMessages.length, 'remaining messages');

                // Resume the livestream with remaining messages
                livestreamQueue = remainingMessages;
                livestreamActive = true;

                // Start displaying remaining messages
                displayNextLivestreamMessage();
                return;
            }
        }

        // Normal restore - either not livestream mode, or livestream was complete, or no fullGeneratedHtml
        if (metadata.generatedHtml) {
            setDiscordText(metadata.generatedHtml);
            log('Restored cached commentary from metadata, length:', metadata.generatedHtml.length);
        } else if (metadata.fullGeneratedHtml) {
            // Livestream complete but generatedHtml not set - use full
            setDiscordText(metadata.fullGeneratedHtml);
            log('Restored from fullGeneratedHtml, length:', metadata.fullGeneratedHtml.length);
        } else {
            setDiscordText('');
            log('No commentary to restore');
        }
    }

    function getActiveCharacters(includeDisabled = false) {
        const context = SillyTavern.getContext();

        // Check if we're in a group chat
        if (context.groupId && context.groups) {
            const group = context.groups.find(g => g.id === context.groupId);
            if (group && group.members) {
                const characters = group.members
                    .map(memberId => context.characters.find(c => c.avatar === memberId))
                    .filter(char => char !== undefined);

                if (includeDisabled) {
                    return characters;
                }

                // Filter out disabled characters
                return characters.filter(char => !group.disabled_members?.includes(char.avatar));
            }
        }

        // Single character chat - return character at current index
        if (context.characterId !== undefined && context.characters[context.characterId]) {
            return [context.characters[context.characterId]];
        }

        return [];
    }

    // ============================================================
    // LIVESTREAM FUNCTIONS
    // ============================================================

    function stopLivestream() {
        if (livestreamTimer || livestreamQueue.length > 0) {
            console.warn(`[EchoChamber] stopLivestream called! Queue had ${livestreamQueue.length} messages remaining. Caller:`, new Error().stack?.split('\n')[2]?.trim());
        }
        if (livestreamTimer) {
            clearTimeout(livestreamTimer);
            livestreamTimer = null;
        }
        livestreamQueue = [];
        livestreamActive = false;
        log('Livestream stopped');
    }

    function startLivestream(messages) {
        stopLivestream(); // Clear any existing livestream

        if (!messages || messages.length === 0) {
            log('No messages to livestream');
            return;
        }

        livestreamQueue = [...messages];
        livestreamActive = true;

        log('Starting livestream with', livestreamQueue.length, 'messages');

        // Display first message immediately
        displayNextLivestreamMessage();
    }

    function displayNextLivestreamMessage() {
        if (livestreamQueue.length === 0) {
            livestreamActive = false;
            console.warn('[EchoChamber] Livestream completed - all messages displayed');
            log('Livestream completed');

            // Mark livestream as complete in metadata
            const metadata = getChatMetadata();
            if (metadata) {
                metadata.livestreamComplete = true;
                saveChatMetadata(metadata);
            }

            // If in onComplete mode, trigger next batch generation
            if (settings.livestream && settings.livestreamMode === 'onComplete') {
                log('Livestream onComplete mode: triggering next batch');
                generateDebounced();
            }
            return;
        }

        try {
            const message = livestreamQueue.shift();
            console.warn(`[EchoChamber] Displaying livestream message. Remaining in queue: ${livestreamQueue.length}`);

            // Get or create the container
            let container = discordContent ? discordContent.find('.discord_container') : null;

            if (!container || !container.length) {
                // No container exists - create one with current content
                const currentContent = discordContent ? discordContent.html() : '';
                discordContent.html(`<div class="discord_container" style="padding-top: 10px;">${currentContent}</div>`);
                container = discordContent.find('.discord_container');
            }

            // Remove animation class from existing messages first
            container.find('.ec_livestream_message').removeClass('ec_livestream_message');

            // Create and prepend new message
            const tempWrapper = jQuery('<div class="ec_livestream_message"></div>').append(jQuery(message));
            container.prepend(tempWrapper);

            // Scroll to top of the EchoChamber panel to show new message
            if (discordContent[0]) {
                discordContent[0].scrollTo({ top: 0, behavior: 'smooth' });
            }

            // Sync to popout window if active
            if (popoutWindow && !popoutWindow.closed && popoutDiscordContent) {
                try {
                    let popoutContainer = popoutDiscordContent.querySelector('.discord_container');
                    if (!popoutContainer) {
                        // Create container in popout too
                        const wrapper = document.createElement('div');
                        wrapper.className = 'discord_container';
                        wrapper.style.paddingTop = '10px';
                        wrapper.innerHTML = popoutDiscordContent.innerHTML;
                        popoutDiscordContent.innerHTML = '';
                        popoutDiscordContent.appendChild(wrapper);
                        popoutContainer = wrapper;
                    }

                    // Remove animation class from popout messages
                    popoutContainer.querySelectorAll('.ec_livestream_message').forEach(el => {
                        el.classList.remove('ec_livestream_message');
                    });

                    // Create clone for popout
                    const popoutWrapper = document.createElement('div');
                    popoutWrapper.className = 'ec_livestream_message';
                    popoutWrapper.innerHTML = message;
                    popoutContainer.insertBefore(popoutWrapper, popoutContainer.firstChild);

                    popoutDiscordContent.scrollTo({ top: 0, behavior: 'smooth' });
                } catch (popoutErr) {
                    // Ignore popout errors, don't let them break the livestream
                    log('Popout sync error (ignored):', popoutErr);
                }
            }

            // Update saved HTML with current displayed state (don't let this break livestream)
            try {
                const currentDisplayedHtml = discordContent.html();
                const metadata = getChatMetadata();
                if (metadata) {
                    metadata.generatedHtml = currentDisplayedHtml;
                    // Keep fullGeneratedHtml and livestreamComplete status
                    saveChatMetadata(metadata);
                }
            } catch (metaErr) {
                log('Metadata save error (ignored):', metaErr);
            }

        } catch (err) {
            error('Error displaying livestream message:', err);
            // Continue to next message even if this one failed
        }

        // Schedule next message with random delay between user-configured min/max seconds
        const minWait = (settings.livestreamMinWait || 5) * 1000;
        const maxWait = (settings.livestreamMaxWait || 60) * 1000;
        const randomValue = Math.random();
        const delay = randomValue * (maxWait - minWait) + minWait;
        log('Next livestream message in', (delay / 1000).toFixed(1), 'seconds (random:', randomValue.toFixed(3), '). Queue:', livestreamQueue.length, 'remaining');

        livestreamTimer = setTimeout(() => displayNextLivestreamMessage(), delay);
    }

    function parseLivestreamMessages(html) {
        // Parse the generated HTML to extract individual messages
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        const messages = [];
        const messageElements = tempDiv.querySelectorAll('.discord_message');

        messageElements.forEach(el => {
            messages.push(el.outerHTML);
        });

        log('Parsed', messages.length, 'messages from generated HTML');
        return messages;
    }

    // ============================================================
    // POP-OUT WINDOW FUNCTIONS
    // ============================================================

    function openPopoutWindow() {
        // Check if window is already open
        if (popoutWindow && !popoutWindow.closed) {
            popoutWindow.focus();
            return;
        }

        // Get current content
        const currentContent = discordContent ? discordContent.html() : '';

        // Create popup window
        const width = 450;
        const height = 700;
        const left = window.screenX + window.outerWidth; // Position to the right of main window
        const top = window.screenY;

        popoutWindow = window.open('', 'EchoChamber_Popout',
            `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);

        if (!popoutWindow) {
            alert('Pop-up blocked! Please allow pop-ups for this site to use the pop-out feature.');
            return;
        }

        // Build the popup HTML
        popoutWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
    <title>EchoChamber - Pop Out</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #1a1a2e;
            color: #e0e0e0;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .popout-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .popout-title {
            font-size: 16px;
            font-weight: 600;
            color: white;
        }
        .popout-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .popout-btn {
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
        }
        .popout-btn:hover {
            background: rgba(255,255,255,0.3);
        }
        .style-select {
            background: rgba(255,255,255,0.2);
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
        }
        .style-select option {
            background: #2a2a4e;
            color: white;
        }
        .popout-content {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            background: #16213e;
        }
        /* Discord-style message styling */
        .discord_container { display: flex; flex-direction: column; gap: 8px; }
        .discord_message {
            display: flex;
            gap: 10px;
            padding: 8px 12px;
            border-radius: 6px;
            background: rgba(255,255,255,0.03);
            animation: fadeIn 0.3s ease-out;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .discord_avatar {
            width: 36px;
            height: 36px;
            border-radius: 50%;
            flex-shrink: 0;
            background: linear-gradient(135deg, #667eea, #764ba2);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
            color: white;
        }
        .discord_content { flex: 1; min-width: 0; }
        .discord_header { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
        .discord_username { font-weight: 600; color: #7289da; font-size: 14px; }
        .discord_timestamp { font-size: 11px; color: #72767d; }
        .discord_text { font-size: 14px; line-height: 1.4; word-wrap: break-word; }
        .ec_livestream_message {
            animation: slideIn 0.5s ease-out;
        }
        @keyframes slideIn {
            from { opacity: 0; transform: translateY(-20px); }
            to { opacity: 1; transform: translateY(0); }
        }
    </style>
</head>
<body>
    <div class="popout-header">
        <span class="popout-title">🗣️ EchoChamber</span>
        <div class="popout-controls">
            <select class="style-select" id="popout-style-select">
                <option value="">Loading styles...</option>
            </select>
            <button class="popout-btn" id="dock-btn" title="Return to SillyTavern">📌 Dock to ST</button>
        </div>
    </div>
    <div class="popout-content" id="popout-discord-content">
        ${currentContent}
    </div>
</body>
</html>
        `);
        popoutWindow.document.close();

        // Get references to popout elements
        popoutDiscordContent = popoutWindow.document.getElementById('popout-discord-content');

        // Setup dock button
        const dockBtn = popoutWindow.document.getElementById('dock-btn');
        dockBtn.addEventListener('click', () => {
            closePopoutWindow();
        });

        // Setup style selector
        const styleSelect = popoutWindow.document.getElementById('popout-style-select');
        populatePopoutStyleSelector(styleSelect);

        // Handle window close
        popoutWindow.addEventListener('beforeunload', () => {
            popoutWindow = null;
            popoutDiscordBar = null;
            popoutDiscordContent = null;
        });

        log('Popout window opened');
    }

    function closePopoutWindow() {
        if (popoutWindow && !popoutWindow.closed) {
            popoutWindow.close();
        }
        popoutWindow = null;
        popoutDiscordBar = null;
        popoutDiscordContent = null;
        log('Popout window closed');
    }

    async function populatePopoutStyleSelector(selectElement) {
        if (!selectElement) return;

        // Get built-in styles
        const builtInStyles = [
            { value: 'twitch', label: '🎮 Discord/Twitch' },
            { value: 'twitter', label: '🐦 Twitter/X' },
            { value: 'ao3_wattpad', label: '📚 AO3/Wattpad' },
            { value: 'breaking_news', label: '📺 Breaking News' },
            { value: 'mst3k', label: '🎬 MST3K' },
            { value: 'nsfw_ava', label: '💋 NSFW Ava' },
            { value: 'nsfw_kai', label: '🔥 NSFW Kai' },
            { value: 'hypebot', label: '🤖 HypeBot' },
            { value: 'thoughtful', label: '🤔 Thoughtful' },
            { value: 'dumb_and_dumber', label: '🤪 Dumb & Dumber' },
            { value: 'doomscrollers', label: '😰 Doomscrollers' }
        ];

        // Clear and populate
        selectElement.innerHTML = '';

        // Add built-in styles
        builtInStyles.forEach(style => {
            const option = document.createElement('option');
            option.value = style.value;
            option.textContent = style.label;
            if (style.value === settings.style) option.selected = true;
            selectElement.appendChild(option);
        });

        // Add custom styles if any
        if (settings.custom_styles && Object.keys(settings.custom_styles).length > 0) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = '✨ Custom Styles';
            Object.keys(settings.custom_styles).forEach(styleName => {
                const option = document.createElement('option');
                option.value = styleName;
                option.textContent = styleName;
                if (styleName === settings.style) option.selected = true;
                optgroup.appendChild(option);
            });
            selectElement.appendChild(optgroup);
        }

        // Handle style change from popout
        selectElement.addEventListener('change', (e) => {
            const newStyle = e.target.value;
            settings.style = newStyle;

            // Update main window selector if exists
            const mainSelector = document.querySelector('#discord_style_select');
            if (mainSelector) mainSelector.value = newStyle;

            // Update quick bar selector if exists
            const quickSelector = document.querySelector('.ec_quick_bar select');
            if (quickSelector) quickSelector.value = newStyle;

            // Save settings
            SillyTavern.getContext().saveSettingsDebounced();

            log('Style changed from popout to:', newStyle);
        });
    }

    // ============================================================
    // GENERATION FUNCTIONS
    // ============================================================

    function saveGeneratedCommentary(html, messageCommentaries, fullHtml = null, livestreamComplete = true) {
        const chatId = SillyTavern.getContext().chatId;
        log('Saving generated commentary for chatId:', chatId, 'html length:', html?.length);
        const metadata = {
            generatedHtml: html,
            messageCommentaries: messageCommentaries || {},
            timestamp: Date.now(),
            livestreamComplete: livestreamComplete
        };
        // Save fullGeneratedHtml for livestream resume capability
        if (fullHtml) {
            metadata.fullGeneratedHtml = fullHtml;
        }
        saveChatMetadata(metadata);
        log('Saved generated commentary to metadata, livestreamComplete:', livestreamComplete);
    }

    // ============================================================
    // GENERATION
    // ============================================================

    async function generateDiscordChat() {
        if (!settings.enabled) {
            if (discordBar) discordBar.hide();
            return;
        }

        // If paused, don't generate but keep panel visible
        if (settings.paused) {
            return;
        }

        // If already generating, abort the previous request first
        if (isGenerating && abortController) {
            abortController.abort();
            // Wait a tiny bit for the abort to process
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        if (discordBar) discordBar.show();

        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return;

        // Mark generation as in progress
        isGenerating = true;

        // Create new AbortController BEFORE setting up the Cancel button
        userCancelled = false;
        abortController = new AbortController();

        setStatus(`
            <span><i class="fa-solid fa-circle-notch fa-spin"></i> Processing...</span>
            <div class="ec_status_btn" id="ec_cancel_btn" title="Cancel Generation">
                 <i class="fa-solid fa-ban"></i> Cancel
            </div>
        `);

        // Use event delegation to ensure the handler works even if button is recreated
        jQuery(document).off('click', '#ec_cancel_btn').on('click', '#ec_cancel_btn', function (e) {
            e.preventDefault();
            e.stopPropagation();
            log('Cancel button clicked');

            // Clear debounce timeout in case generation hasn't started yet
            clearTimeout(debounceTimeout);

            if (abortController) {
                log('Aborting generation...');
                userCancelled = true;
                jQuery('#ec_cancel_btn').html('<i class="fa-solid fa-hourglass"></i> Stopping...').css('pointer-events', 'none');
                abortController.abort();
                log('AbortController.abort() called, signal.aborted:', abortController.signal.aborted);

                // Also trigger SillyTavern's built-in stop generation
                const stopButton = jQuery('#mes_stop');
                if (stopButton.length && !stopButton.is('.disabled')) {
                    log('Triggering SillyTavern stop button');
                    stopButton.trigger('click');
                }
            } else {
                log('No abortController, showing cancel message');
                // If abortController doesn't exist yet, just clear the status
                userCancelled = true;
                setStatus('');
                setDiscordText(`<div class="discord_status ec_cancelled"><i class="fa-solid fa-hand"></i> Processing cancelled</div>`);
                setTimeout(() => {
                    const cancelledMsg = jQuery('.ec_cancelled');
                    if (cancelledMsg.length) {
                        cancelledMsg.addClass('fade-out');
                        setTimeout(() => cancelledMsg.remove(), 500);
                    }
                }, 3000);
            }
        });

        const cleanMessage = (text) => {
            if (!text) return '';
            // Strip all thinking/reasoning tags: thinking, think, thought, reasoning, reason
            let cleaned = text.replace(/<(thinking|think|thought|reasoning|reason)>[\s\S]*?<\/\1>/gi, '').trim();
            cleaned = cleaned.replace(/<[^>]*>/g, '');
            const txt = document.createElement("textarea");
            txt.innerHTML = cleaned;
            return txt.value;
        };

        // Build context history based on settings
        // includeUserInput OFF: Only the last message (AI response)
        // includeUserInput ON: Use contextDepth to include multiple exchanges
        // Note: Filter out hidden messages (is_system === true)
        let historyMessages;

        if (settings.includeUserInput) {
            // Allow context depth up to 500 messages (no artificial cap)
            const depth = Math.max(2, Math.min(500, settings.contextDepth || 4));
            // Filter out hidden messages first
            const visibleChat = chat.filter(msg => !msg.is_system);

            // Find the starting user message based on depth
            let startIdx = visibleChat.length - 1;

            // Walk backwards to find how far back we need to go
            for (let i = visibleChat.length - 1; i >= 0 && (visibleChat.length - i) <= depth; i--) {
                startIdx = i;
            }

            // Now find the nearest user message at or before startIdx
            for (let i = startIdx; i >= 0; i--) {
                if (visibleChat[i].is_user) {
                    startIdx = i;
                    break;
                }
            }

            historyMessages = visibleChat.slice(startIdx);
            // Limit to depth messages
            if (historyMessages.length > depth) {
                historyMessages = historyMessages.slice(-depth);
            }
            log('includeUserInput ON - depth:', depth, 'startIdx:', startIdx, 'count:', historyMessages.length, '(excluding hidden)');
        } else {
            // Only the last message (AI response), excluding hidden messages
            const visibleChat = chat.filter(msg => !msg.is_system);
            historyMessages = visibleChat.slice(-1);
            log('includeUserInput OFF - using last visible message only');
        }

        // Build history with past commentary if enabled
        const metadata = getChatMetadata();
        const messageCommentaries = (metadata && metadata.messageCommentaries) || {};

        log('History messages:', historyMessages.map(m => ({ name: m.name, is_user: m.is_user })), 'count:', historyMessages.length);

        // Determine user count and message count
        const isNarratorStyle = ['nsfw_ava', 'nsfw_kai', 'hypebot'].includes(settings.style);

        let actualUserCount; // Number of different users
        let messageCount; // Number of messages to generate

        if (settings.livestream) {
            // In livestream mode, use user count for number of users, batch size for messages
            actualUserCount = isNarratorStyle ? 1 : Math.max(1, Math.min(20, parseInt(settings.userCount) || 5));
            messageCount = isNarratorStyle ? 1 : Math.max(5, Math.min(50, parseInt(settings.livestreamBatchSize) || 20));
            log('Livestream mode - users:', actualUserCount, 'messages:', messageCount);
        } else {
            // Regular mode - user count determines both
            actualUserCount = isNarratorStyle ? 1 : (parseInt(settings.userCount) || 5);
            messageCount = actualUserCount;
        }

        const userCount = Math.max(1, Math.min(50, messageCount));
        log('generateDiscordChat - userCount:', userCount, isNarratorStyle ? '(narrator style)' : '', settings.livestream ? '(livestream batch)' : '');

        const stylePrompt = await loadChatStyle(settings.style || 'twitch');

        // Build additional context for system message (persona, characters, summary, world info)
        let additionalSystemContext = '';
        const systemContextParts = [];

        // Include persona if enabled - use {{persona}} macro which ST substitutes automatically
        if (settings.includePersona) {
            const personaName = context.name1 || 'User';
            // Use the {{persona}} macro - generateRaw will substitute it with actual persona description
            systemContextParts.push(`<user_persona name="${personaName}">\n{{persona}}\n</user_persona>`);
            log('Added persona macro to system message');
        }

        // Include character descriptions if enabled
        if (settings.includeCharacterDescription) {
            const activeCharacters = getActiveCharacters();
            if (activeCharacters.length > 0) {
                const charDescriptions = activeCharacters
                    .filter(char => char.description)
                    .map(char => `<character name="${char.name}">\n${char.description}\n</character>`)
                    .join('\n\n');
                if (charDescriptions) {
                    systemContextParts.push(charDescriptions);
                    log('Added character descriptions for', activeCharacters.length, 'characters');
                }
            }
        }

        // Include summary if enabled (from Summarize extension)
        if (settings.includeSummary) {
            try {
                // Try to get summary from chat metadata or extension settings
                const memorySettings = context.extensionSettings?.memory;
                if (memorySettings) {
                    // Look for summary in recent chat messages
                    const chatWithSummary = context.chat?.slice().reverse().find(m => m.extra?.memory);
                    if (chatWithSummary?.extra?.memory) {
                        systemContextParts.push(`<summary>\n${chatWithSummary.extra.memory}\n</summary>`);
                        log('Added summary from chat memory');
                    }
                }
            } catch (e) {
                log('Could not get summary:', e);
            }
        }

        // Include world info (lorebook) if enabled - fetch using getWorldInfoPrompt like RPG Companion
        if (settings.includeWorldInfo) {
            try {
                // Use SillyTavern's getWorldInfoPrompt to get activated lorebook entries
                const getWorldInfoFn = context.getWorldInfoPrompt || (typeof window !== 'undefined' && window.getWorldInfoPrompt);
                const currentChat = context.chat || chat;

                if (typeof getWorldInfoFn === 'function' && currentChat && currentChat.length > 0) {
                    const chatForWI = currentChat.map(x => x.mes || x.message || x).filter(m => m && typeof m === 'string');
                    const result = await getWorldInfoFn(chatForWI, 8000, false);
                    const worldInfoString = result?.worldInfoString || result;

                    if (worldInfoString && typeof worldInfoString === 'string' && worldInfoString.trim()) {
                        systemContextParts.push(`<world_info>\n${worldInfoString.trim()}\n</world_info>`);
                        log('Added world info, length:', worldInfoString.length);
                    } else {
                        log('World info enabled but getWorldInfoPrompt returned empty');
                    }
                } else {
                    // Fallback to activatedWorldInfo
                    if (context.activatedWorldInfo && Array.isArray(context.activatedWorldInfo) && context.activatedWorldInfo.length > 0) {
                        const worldInfoContent = context.activatedWorldInfo
                            .filter(entry => entry && entry.content)
                            .map(entry => entry.content)
                            .join('\n\n');
                        if (worldInfoContent.trim()) {
                            systemContextParts.push(`<world_info>\n${worldInfoContent.trim()}\n</world_info>`);
                            log('Added world info from activatedWorldInfo, entries:', context.activatedWorldInfo.length);
                        }
                    } else {
                        log('World info enabled but no getWorldInfoPrompt function and no activatedWorldInfo');
                    }
                }
            } catch (e) {
                log('Error getting world info:', e);
            }
        }

        if (systemContextParts.length > 0) {
            additionalSystemContext = '\n\n<lore>\n' + systemContextParts.join('\n\n') + '\n</lore>';
        }

        // Build the system message with base prompt and additional context
        const systemMessage = `<role>
You are an excellent creator of fake chat feeds that react dynamically to the user's conversation context.
</role>${additionalSystemContext}

<chat_history>`;

        // Build dynamic count instruction based on style type and mode
        let countInstruction = '';
        if (!isNarratorStyle) {
            if (settings.livestream) {
                countInstruction = `IMPORTANT: You MUST generate EXACTLY ${messageCount} chat messages from EXACTLY ${actualUserCount} different users. Each user can post multiple messages. Not fewer, not more - exactly ${messageCount} messages from ${actualUserCount} users.\n\n`;
            } else {
                countInstruction = `IMPORTANT: You MUST generate EXACTLY ${userCount} chat messages. Not fewer, not more - exactly ${userCount}.\n\n`;
            }
        }

        // Build the chat history as proper message array for APIs that support it
        // This creates user/assistant turns from the conversation
        const chatHistoryMessages = [];

        if (settings.includePastEchoChambers && metadata && metadata.messageCommentaries) {
            // Include past generated commentary interleaved with messages
            for (let i = 0; i < historyMessages.length; i++) {
                const msg = historyMessages[i];
                const msgIndex = chat.indexOf(msg);
                const role = msg.is_user ? 'user' : 'assistant';
                let content = cleanMessage(msg.mes);

                // Add commentary if it exists for this message
                if (messageCommentaries[msgIndex]) {
                    content += `\n\n[Previous EchoChamber commentary: ${messageCommentaries[msgIndex]}]`;
                }

                chatHistoryMessages.push({ role, content });
            }
            log('Including past EchoChambers commentary in chat history');
        } else {
            // Build chat history with proper user/assistant roles (no names, just message content)
            for (const msg of historyMessages) {
                const role = msg.is_user ? 'user' : 'assistant';
                const content = cleanMessage(msg.mes);
                chatHistoryMessages.push({ role, content });
            }
        }

        // Build the final user prompt (instructions only, context is in chat history)
        const instructionsPrompt = `</chat_history>

        <instructions>
${countInstruction}${stylePrompt}
</instructions>

<task>
Based on the chat history above, generate fake chat feed reactions. Remember to think about them step-by-step first.
STRICTLY follow the format defined in the instruction. ${isNarratorStyle ? '' : settings.livestream ? `Output exactly ${messageCount} messages from ${actualUserCount} users.` : `Output exactly ${userCount} messages.`} Do NOT continue the story or roleplay as the characters. The created by you people are allowed to interact with each other over your generated feed. Do NOT output preamble like "Here are the messages". Just output the content directly.
</task>`;

        // Calculate appropriate max_tokens based on message count
        // Each message typically needs 50-100 tokens, so we allocate ~200 per message with a minimum of 2048 for safety
        const calculatedMaxTokens = Math.max(2048, userCount * 200 + 1024);
        log('Calculated max_tokens:', calculatedMaxTokens, 'for', userCount, 'messages');

        try {
            let result = '';

            if (settings.source === 'profile' && settings.preset) {
                // PROFILE GENERATION - Build proper message array with chat history
                const cm = context.extensionSettings?.connectionManager;
                const profile = cm?.profiles?.find(p => p.name === settings.preset);
                if (!profile) throw new Error(`Profile '${settings.preset}' not found`);

                // Use ConnectionManagerRequestService
                if (!context.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService not available');

                // Build message array: system, chat history, then instructions
                const messages = [
                    { role: 'system', content: systemMessage }
                ];

                // Add chat history as proper user/assistant turns
                for (const histMsg of chatHistoryMessages) {
                    messages.push({ role: histMsg.role, content: histMsg.content });
                }

                // Add final instruction as user message
                messages.push({ role: 'user', content: instructionsPrompt });

                log(`Generating with profile: ${profile.name}, max_tokens: ${calculatedMaxTokens}, messages: ${messages.length}`);
                const response = await context.ConnectionManagerRequestService.sendRequest(
                    profile.id,
                    messages,
                    calculatedMaxTokens, // Dynamic max_tokens based on message count
                    {
                        stream: false,
                        signal: abortController.signal,
                        extractData: true,
                        includePreset: true,
                        includeInstruct: true
                    }
                );

                // DEBUG: Log the actual response shape from sendRequest
                console.error('[EchoChamber DEBUG] sendRequest response type:', typeof response);
                console.error('[EchoChamber DEBUG] isArray:', Array.isArray(response));
                console.error('[EchoChamber DEBUG] response keys:', response ? Object.keys(response) : 'null/undefined');
                if (response?.content) {
                    console.error('[EchoChamber DEBUG] content type:', typeof response.content, 'isArray:', Array.isArray(response.content));
                    if (Array.isArray(response.content)) {
                        console.error('[EchoChamber DEBUG] content blocks:', response.content.map(b => ({ type: b.type, hasText: !!b.text, textLen: b.text?.length })));
                    }
                }

                // Parse response - handle all possible formats from different API backends
                result = extractTextFromResponse(response);

            } else if (settings.source === 'ollama') {
                const baseUrl = settings.url.replace(/\/$/, '');
                let modelToUse = settings.model;
                if (!modelToUse) {
                    warn('No Ollama model selected');
                    return;
                }

                // Build message array for Ollama chat endpoint (multi-turn)
                const messages = [
                    { role: 'system', content: systemMessage }
                ];

                // Add chat history as proper user/assistant turns
                for (const histMsg of chatHistoryMessages) {
                    messages.push({ role: histMsg.role, content: histMsg.content });
                }

                // Add final instruction as user message
                messages.push({ role: 'user', content: instructionsPrompt });

                log(`Generating with Ollama: ${modelToUse}, messages: ${messages.length}`);

                // Use Ollama's chat endpoint for proper multi-turn conversation
                const response = await fetch(`${baseUrl}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: modelToUse,
                        messages: messages,
                        stream: false,
                        options: { num_ctx: context.main?.context_size || 4096, num_predict: calculatedMaxTokens }
                    }),
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`Ollama API Error(${response.status})`);
                const data = await response.json();
                result = data.message?.content || data.response || '';
            } else if (settings.source === 'openai') {
                const baseUrl = settings.openai_url.replace(/\/$/, '');
                const targetEndpoint = `${baseUrl}/chat/completions`;

                // Build message array: system, chat history, then instructions
                const messages = [
                    { role: 'system', content: systemMessage }
                ];

                // Add chat history as proper user/assistant turns
                for (const histMsg of chatHistoryMessages) {
                    messages.push({ role: histMsg.role, content: histMsg.content });
                }

                // Add final instruction as user message
                messages.push({ role: 'user', content: instructionsPrompt });

                const payload = {
                    model: settings.openai_model || 'local-model',
                    messages: messages,
                    temperature: 0.7,
                    max_tokens: calculatedMaxTokens,
                    stream: false
                };

                log(`Generating with OpenAI compatible: ${settings.openai_model}, messages: ${messages.length}`);
                const response = await fetch(targetEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(settings.openai_key ? { 'Authorization': `Bearer ${settings.openai_key}` } : {})
                    },
                    body: JSON.stringify(payload),
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`API Error: ${response.status}`);
                const data = await response.json();
                result = extractTextFromResponse(data);
            } else {
                // Default ST generation using context - build message array like RPG Companion
                const { generateRaw } = context;
                if (generateRaw) {
                    // Build message array: system, chat history, then instructions
                    const messages = [
                        { role: 'system', content: systemMessage }
                    ];

                    // Add chat history as proper user/assistant turns
                    for (const histMsg of chatHistoryMessages) {
                        messages.push({ role: histMsg.role, content: histMsg.content });
                    }

                    // Add final instruction as user message
                    messages.push({ role: 'user', content: instructionsPrompt });

                    log(`Generating with ST generateRaw, messages: ${messages.length}`);

                    // Temporarily intercept fetch to capture the raw API response.
                    // This is needed because SillyTavern's generateRaw uses extractMessageFromData
                    // which calls .find() to get the FIRST type:'text' block. With Claude extended
                    // thinking, the first text block is just '\n\n' (empty), and the actual content
                    // is in a later text block. generateRaw then throws "No message generated".
                    // By capturing the raw response, we can extract the text ourselves on failure.
                    let capturedRawData = null;
                    const originalFetch = window.fetch;
                    window.fetch = async function (...args) {
                        const response = await originalFetch.apply(this, args);
                        try {
                            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                            if (url.includes('/api/backends/chat-completions/generate') ||
                                url.includes('/api/backends/') && url.includes('/generate')) {
                                const clone = response.clone();
                                capturedRawData = await clone.json();
                            }
                        } catch (e) { /* ignore clone/parse errors */ }
                        return response;
                    };

                    try {
                        result = await generateRaw({ prompt: messages, quietToLoud: false });

                        // generateRaw's cleanUpMessage may mangle our output or return near-empty
                        // content when extended thinking is used (first text block is just '\n\n').
                        // Always check if captured raw data has more content.
                        if (capturedRawData) {
                            const rawExtracted = extractTextFromResponse(capturedRawData);
                            const rawTrimmed = rawExtracted?.trim() || '';
                            const resultTrimmed = result?.trim() || '';
                            if (rawTrimmed.length > resultTrimmed.length + 50) {
                                console.warn('[EchoChamber] generateRaw returned truncated/mangled result (' +
                                    resultTrimmed.length + ' chars). Using raw API data instead (' + rawTrimmed.length + ' chars).');
                                result = rawExtracted;
                            }
                        }
                    } catch (genErr) {
                        if (genErr.message?.includes('No message generated') && capturedRawData) {
                            console.warn('[EchoChamber] generateRaw failed to parse response (likely extended thinking format). Extracting from raw API data.');
                            result = extractTextFromResponse(capturedRawData);
                            if (!result || !result.trim()) {
                                throw new Error('Could not extract text from API response');
                            }
                        } else {
                            throw genErr;
                        }
                    } finally {
                        window.fetch = originalFetch; // Always restore original fetch
                    }
                } else {
                    throw new Error('generateRaw not available in context');
                }
            }

            // Check if generation was aborted before parsing
            if (abortController.signal.aborted || userCancelled) {
                log('Generation was cancelled, skipping result parsing');
                throw new Error('Generation cancelled by user');
            }

            // Safety: ensure result is a string before string operations
            if (typeof result !== 'string') {
                console.error('[EchoChamber] result is not a string after extraction! Type:', typeof result, 'Value:', result);
                result = extractTextFromResponse(result) || String(result);
            }
            console.error('[EchoChamber DEBUG] Final result (first 200 chars):', result?.substring?.(0, 200));

            // Parse result - strip thinking/reasoning tags and discordchat wrapper
            let cleanResult = result
                .replace(/<(thinking|think|thought|reasoning|reason)>[\s\S]*?<\/\1>/gi, '')
                .replace(/<\/?discordchat>/gi, '')
                .trim();
            const lines = cleanResult.split('\n');
            let htmlBuffer = '<div class="discord_container" style="padding-top: 10px;">';
            let messageCount = 0;
            let currentMsg = null;
            let parsedMessages = [];

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) {
                    if (currentMsg && !currentMsg.content.endsWith('\n\n')) currentMsg.content += '\n\n';
                    continue;
                }
                if (/^[\.\…\-\_]+$/.test(trimmedLine)) continue;

                // More flexible regex: matches "Name: Msg", "Name (Info): Msg", "@Name: Msg", etc.
                // Captures everything before the LAST colon followed by optional space as the username
                const match = trimmedLine.match(/^(?:[\d\.\-\*]*\s*)?(.+?):\s*(.+)$/);
                if (match) {
                    let name = match[1].trim().replace(/[\*_\"`]/g, '');
                    // Limit displayed name to reasonable length
                    if (name.length > 40) name = name.substring(0, 40);
                    let content = match[2].trim();
                    currentMsg = { name, content };
                    parsedMessages.push(currentMsg);
                } else if (currentMsg) {
                    currentMsg.content += ' ' + trimmedLine;
                } else {
                    // Last resort: use entire line as content with generic name
                    currentMsg = { name: 'User', content: trimmedLine };
                    parsedMessages.push(currentMsg);
                }
            }

            for (const msg of parsedMessages) {
                if (messageCount >= userCount) break;
                if (msg.content.trim().length < 2) continue;
                htmlBuffer += formatMessage(msg.name, msg.content.trim());
                messageCount++;
            }

            console.warn(`[EchoChamber] Parsed ${parsedMessages.length} messages, displayed ${messageCount}/${userCount}`);
            log(`Parsed ${parsedMessages.length} messages, displayed ${messageCount}/${userCount}`);

            htmlBuffer += '</div>';
            setStatus('');

            if (messageCount === 0) {
                setDiscordText('<div class=\"discord_status\">No valid chat lines generated.</div>');
            } else {
                // Check if livestream mode is enabled
                if (settings.livestream) {
                    // Parse individual messages for livestream
                    const messages = parseLivestreamMessages(htmlBuffer);
                    console.warn('[EchoChamber] Livestream mode: queuing', messages.length, 'messages for display');
                    log('Livestream mode: queuing', messages.length, 'messages');

                    // Save to metadata for persistence - save full html and mark as incomplete
                    const lastMsgIndex = chat.length - 1;
                    const updatedCommentaries = { ...(messageCommentaries || {}) };
                    updatedCommentaries[lastMsgIndex] = cleanResult;
                    // Save with fullGeneratedHtml for resume and mark livestream as not complete yet
                    // generatedHtml starts empty since no messages displayed yet
                    saveGeneratedCommentary('', updatedCommentaries, htmlBuffer, false);

                    // Start livestream display
                    startLivestream(messages);
                } else {
                    // Regular mode - display all at once
                    setDiscordText(htmlBuffer);

                    // Save to metadata for persistence
                    const lastMsgIndex = chat.length - 1;
                    const updatedCommentaries = { ...(messageCommentaries || {}) };
                    updatedCommentaries[lastMsgIndex] = cleanResult; // Store the raw commentary text
                    saveGeneratedCommentary(htmlBuffer, updatedCommentaries);
                }
            }

            // Mark generation as complete
            isGenerating = false;

        } catch (err) {
            // Mark generation as complete (even on error)
            isGenerating = false;
            setStatus('');
            const isAbort = err.name === 'AbortError' || err.message?.includes('aborted') || userCancelled;
            if (isAbort || userCancelled) {
                // User cancelled - show toast notification, keep previous content
                if (typeof toastr !== 'undefined') {
                    toastr.info('Generation cancelled', 'EchoChamber');
                }
                log('Generation cancelled by user');
            } else {
                // Actual error occurred - show error toast, keep previous content
                error('Generation failed:', err);
                if (typeof toastr !== 'undefined') {
                    toastr.error(err.message || 'Unknown error occurred', 'EchoChamber Generation Error');
                }
            }
        }
    }

    // ============================================================
    // PROMPT LOADING
    // ============================================================

    let promptCache = {};
    const STYLE_FILES = {
        'twitch': 'discordtwitch.md', 'verbose': 'thoughtfulverbose.md', 'twitter': 'twitterx.md', 'news': 'breakingnews.md',
        'mst3k': 'mst3k.md', 'nsfw_ava': 'nsfwava.md', 'nsfw_kai': 'nsfwkai.md', 'hypebot': 'hypebot.md',
        'doomscrollers': 'doomscrollers.md', 'dumbanddumber': 'dumbanddumber.md', 'ao3wattpad': 'ao3wattpad.md'
    };
    const BUILT_IN_STYLES = [
        { val: 'twitch', label: 'Discord / Twitch' }, { val: 'verbose', label: 'Thoughtful' },
        { val: 'twitter', label: 'Twitter / X' }, { val: 'news', label: 'Breaking News' },
        { val: 'mst3k', label: 'MST3K' }, { val: 'nsfw_ava', label: 'Ava NSFW' },
        { val: 'nsfw_kai', label: 'Kai NSFW' }, { val: 'hypebot', label: 'HypeBot' },
        { val: 'doomscrollers', label: 'Doomscrollers' }, { val: 'dumbanddumber', label: 'Dumb & Dumber' },
        { val: 'ao3wattpad', label: 'AO3 / Wattpad' }
    ];

    function getAllStyles() {
        let styles = [...BUILT_IN_STYLES];
        if (settings.custom_styles) {
            Object.keys(settings.custom_styles).forEach(id => styles.push({ val: id, label: settings.custom_styles[id].name }));
        }
        if (settings.deleted_styles) styles = styles.filter(s => !settings.deleted_styles.includes(s.val));
        return styles;
    }

    async function loadChatStyle(style) {
        if (settings.custom_styles && settings.custom_styles[style]) return settings.custom_styles[style].prompt;
        if (promptCache[style]) return promptCache[style];
        const filename = STYLE_FILES[style] || 'discordtwitch.md';
        try {
            const response = await fetch(`${BASE_URL}/chat-styles/${filename}?v=${Date.now()}`);
            if (!response.ok) throw new Error('Fetch failed');
            const content = await response.text();
            promptCache[style] = content;
            return content;
        } catch (e) {
            warn('Failed to load style:', style, e);
            return `Generate chat messages. Output: username: message`;
        }
    }

    // ============================================================
    // SETTINGS MANAGEMENT
    // ============================================================

    function saveSettings() {
        const context = SillyTavern.getContext();
        // Preserve chatMetadata when saving settings
        const existingMetadata = context.extensionSettings[MODULE_NAME]?.chatMetadata;

        // Create a clean copy of settings without chatMetadata
        const settingsToSave = Object.assign({}, settings);
        delete settingsToSave.chatMetadata;

        context.extensionSettings[MODULE_NAME] = settingsToSave;
        if (existingMetadata) {
            context.extensionSettings[MODULE_NAME].chatMetadata = existingMetadata;
        }
        context.saveSettingsDebounced();
    }

    function loadSettings() {
        const context = SillyTavern.getContext();

        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = JSON.parse(JSON.stringify(defaultSettings));
        }

        // Don't copy chatMetadata into settings - it should stay in extensionSettings only
        const savedSettings = Object.assign({}, context.extensionSettings[MODULE_NAME]);
        delete savedSettings.chatMetadata;

        settings = Object.assign({}, defaultSettings, savedSettings);
        settings.userCount = parseInt(settings.userCount) || 5;
        settings.opacity = parseInt(settings.opacity) || 85;

        // Update UI
        jQuery('#discord_enabled').prop('checked', settings.enabled);
        jQuery('#discord_user_count').val(settings.userCount);
        jQuery('#discord_source').val(settings.source);
        jQuery('#discord_url').val(settings.url);
        jQuery('#discord_openai_url').val(settings.openai_url);
        jQuery('#discord_openai_key').val(settings.openai_key);
        jQuery('#discord_openai_model').val(settings.openai_model);
        jQuery('#discord_openai_preset').val(settings.openai_preset || 'custom');
        jQuery('#discord_preset_select').val(settings.preset || '');
        jQuery('#discord_font_size').val(settings.fontSize || 15);
        jQuery('#discord_position').val(settings.position || 'bottom');
        jQuery('#discord_style').val(settings.style || 'twitch');
        jQuery('#discord_opacity').val(settings.opacity);
        jQuery('#discord_opacity_val').text(settings.opacity + '%');
        jQuery('#discord_auto_update').prop('checked', settings.autoUpdateOnMessages !== false);
        jQuery('#discord_include_user').prop('checked', settings.includeUserInput);
        jQuery('#discord_context_depth').val(settings.contextDepth || 4);
        jQuery('#discord_include_past_echo').prop('checked', settings.includePastEchoChambers || false);
        jQuery('#discord_include_persona').prop('checked', settings.includePersona || false);
        jQuery('#discord_include_character_description').prop('checked', settings.includeCharacterDescription || false);
        jQuery('#discord_include_summary').prop('checked', settings.includeSummary || false);
        jQuery('#discord_include_world_info').prop('checked', settings.includeWorldInfo || false);

        // Livestream settings
        jQuery('#discord_livestream').prop('checked', settings.livestream || false);
        jQuery('#discord_livestream_batch_size').val(settings.livestreamBatchSize || 20);
        jQuery('#discord_livestream_min_wait').val(settings.livestreamMinWait || 5);
        jQuery('#discord_livestream_max_wait').val(settings.livestreamMaxWait || 60);
        jQuery('#discord_livestream_settings').toggle(settings.livestream || false);

        // Set livestream mode radio button
        const livestreamMode = settings.livestreamMode || 'manual';
        if (livestreamMode === 'manual') {
            jQuery('#discord_livestream_manual').prop('checked', true);
        } else if (livestreamMode === 'onMessage') {
            jQuery('#discord_livestream_onmessage').prop('checked', true);
        } else {
            jQuery('#discord_livestream_oncomplete').prop('checked', true);
        }

        // Show/hide context depth based on include user input setting
        jQuery('#discord_context_depth_container').toggle(settings.includeUserInput);

        applyFontSize(settings.fontSize || 15);
        updateSourceVisibility();
        updateAllDropdowns();

        if (discordBar) {
            updateApplyLayout();
            updateToggleIcon();
        }
    }

    function updateSourceVisibility() {
        jQuery('#discord_ollama_settings').hide();
        jQuery('#discord_openai_settings').hide();
        jQuery('#discord_profile_settings').hide();

        const source = settings.source || 'default';
        if (source === 'ollama') jQuery('#discord_ollama_settings').show();
        else if (source === 'openai') jQuery('#discord_openai_settings').show();
        else if (source === 'profile') jQuery('#discord_profile_settings').show();
    }

    function updateAllDropdowns() {
        const styles = getAllStyles();

        // Update settings panel dropdown
        const sSelect = jQuery('#discord_style');
        const currentVal = sSelect.val();
        sSelect.empty();
        styles.forEach(s => sSelect.append(`<option value="${s.val}">${s.label}</option>`));
        sSelect.val(currentVal || settings.style);

        // Update QuickBar style menu if exists
        const styleMenu = jQuery('.ec_style_menu');
        if (styleMenu.length) {
            populateStyleMenu(styleMenu);
        }

        // Populate connection profiles dropdown
        populateConnectionProfiles();
    }

    function populateConnectionProfiles() {
        const select = jQuery('#discord_preset_select');
        if (!select.length) return;

        select.empty();
        select.append('<option value="">-- Select Profile --</option>');

        try {
            const context = SillyTavern.getContext();
            const connectionManager = context.extensionSettings?.connectionManager;

            if (connectionManager?.profiles?.length) {
                connectionManager.profiles.forEach(profile => {
                    const isSelected = settings.preset === profile.name ? ' selected' : '';
                    select.append(`<option value="${profile.name}"${isSelected}>${profile.name}</option>`);
                });
                log(`Loaded ${connectionManager.profiles.length} connection profiles`);
            } else {
                select.append('<option value="" disabled>No profiles found</option>');
                log('No connection profiles available');
            }
        } catch (err) {
            warn('Error loading connection profiles:', err);
            select.append('<option value="" disabled>Error loading profiles</option>');
        }
    }

    // ============================================================
    // STYLE EDITOR MODAL
    // ============================================================

    let styleEditorModal = null;
    let currentEditingStyle = null;

    function createStyleEditorModal() {
        if (jQuery('#ec_style_editor_modal').length) return;

        const modalHtml = `
        <div id="ec_style_editor_modal" class="ec_modal_overlay">
            <div class="ec_modal_content">
                <div class="ec_modal_header">
                    <h3><i class="fa-solid fa-palette"></i> Style Editor</h3>
                    <button class="ec_modal_close" id="ec_style_editor_close">&times;</button>
                </div>
                <div class="ec_modal_body">
                    <div class="ec_style_sidebar">
                        <div class="ec_style_sidebar_header">
                            <button class="menu_button" id="ec_style_new" title="Create New Style">
                                <i class="fa-solid fa-plus"></i> New
                            </button>
                        </div>
                        <div class="ec_style_list" id="ec_style_list"></div>
                    </div>
                    <div class="ec_style_main" id="ec_style_main">
                        <div class="ec_empty_state">
                            <i class="fa-solid fa-palette"></i>
                            <div>Select a style to edit or create a new one</div>
                        </div>
                    </div>
                </div>
                <div class="ec_modal_footer">
                    <div class="ec_modal_footer_left">
                        <button class="menu_button ec_btn_danger" id="ec_style_delete" style="display:none;">
                            <i class="fa-solid fa-trash"></i> Delete
                        </button>
                        <button class="menu_button" id="ec_style_export" style="display:none;">
                            <i class="fa-solid fa-download"></i> Export
                        </button>
                    </div>
                    <div class="ec_modal_footer_right">
                        <button class="menu_button" id="ec_style_cancel">Cancel</button>
                        <button class="menu_button ec_btn_primary" id="ec_style_save" style="display:none;">
                            <i class="fa-solid fa-save"></i> Save
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

        jQuery('body').append(modalHtml);
        styleEditorModal = jQuery('#ec_style_editor_modal');

        // Bind events
        jQuery('#ec_style_editor_close, #ec_style_cancel').on('click', closeStyleEditor);
        jQuery('#ec_style_new').on('click', createNewStyle);
        jQuery('#ec_style_save').on('click', saveStyleFromEditor);
        jQuery('#ec_style_delete').on('click', deleteStyleFromEditor);
        jQuery('#ec_style_export').on('click', () => exportStyle(currentEditingStyle));

        // Close on overlay click
        styleEditorModal.on('click', function (e) {
            if (e.target === this) closeStyleEditor();
        });
    }

    function openStyleEditor() {
        createStyleEditorModal();
        populateStyleList();
        currentEditingStyle = null;
        showEmptyState();
        styleEditorModal.addClass('active');
    }

    function closeStyleEditor() {
        if (styleEditorModal) {
            styleEditorModal.removeClass('active');
        }
        currentEditingStyle = null;
        updateAllDropdowns();
    }

    function populateStyleList() {
        const list = jQuery('#ec_style_list');
        list.empty();

        const styles = getAllStyles();
        const builtInIds = BUILT_IN_STYLES.map(s => s.val);

        styles.forEach(style => {
            const isBuiltIn = builtInIds.includes(style.val);
            const isCustom = settings.custom_styles && settings.custom_styles[style.val];
            const typeClass = isCustom ? 'custom' : 'builtin';
            const icon = isCustom ? 'fa-user' : 'fa-cube';

            // Sanitize style label to prevent XSS
            const { DOMPurify } = SillyTavern.libs;
            const safeLabel = DOMPurify.sanitize(style.label, { ALLOWED_TAGS: [] });
            const safeVal = DOMPurify.sanitize(style.val, { ALLOWED_TAGS: [] });

            const item = jQuery(`
                <div class="ec_style_item ${typeClass}" data-id="${safeVal}">
                    <i class="fa-solid ${icon}"></i>
                    <span>${safeLabel}</span>
                </div>
            `);

            item.on('click', () => selectStyleInEditor(style.val));
            list.append(item);
        });
    }

    function showEmptyState() {
        jQuery('#ec_style_main').html(`
            <div class="ec_empty_state">
                <i class="fa-solid fa-palette"></i>
                <div>Select a style to edit or create a new one</div>
            </div>
        `);
        jQuery('#ec_style_save, #ec_style_delete, #ec_style_export').hide();
    }

    async function selectStyleInEditor(styleId) {
        currentEditingStyle = styleId;

        // Update sidebar selection
        jQuery('.ec_style_item').removeClass('active');
        jQuery(`.ec_style_item[data-id="${styleId}"]`).addClass('active');

        const isCustom = settings.custom_styles && settings.custom_styles[styleId];
        const style = getAllStyles().find(s => s.val === styleId);
        const styleName = style ? style.label : styleId;

        // Load content
        let content = '';
        if (isCustom) {
            content = settings.custom_styles[styleId].prompt || '';
        } else {
            content = await loadChatStyle(styleId);
        }

        // Escape styleName for safe HTML insertion
        const safeStyleName = styleName.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Render editor (textarea content set separately to avoid HTML injection issues)
        jQuery('#ec_style_main').html(`
            <div class="ec_style_name_row">
                <input type="text" class="ec_style_name_input" id="ec_style_name"
                       value="${safeStyleName}" placeholder="Style Name" ${!isCustom ? 'readonly' : ''}>
                ${!isCustom ? '<small style="opacity:0.6;">(Built-in styles cannot be renamed)</small>' : ''}
            </div>
            <textarea class="ec_style_textarea" id="ec_style_content"
                      placeholder="Enter the prompt/instructions for this style..."></textarea>
        `);

        // Set textarea content safely (avoids HTML parsing issues with special characters)
        jQuery('#ec_style_content').val(content);

        // Show appropriate buttons
        jQuery('#ec_style_save, #ec_style_export').show();
        jQuery('#ec_style_delete').toggle(!!isCustom);
    }

    // ============================================================
    // TEMPLATE CREATOR MODAL
    // ============================================================

    let templateCreatorModal = null;

    const defaultAdvancedTemplate = `You will be acting as a chat feed audience. Your goal is to simulate messages reacting to the unfolding events.

<usernames>
- Generate NEW random usernames each time
- Make them creative and varied
- Align them with the conversation context
</usernames>

<personalities>
- Mix different personality types and reactions
- Include enthusiasts, skeptics, comedians, and analysts
- Vary the tone and engagement level
</personalities>

<style>
- Keep messages short and natural
- React to events as they happen
- Use platform-appropriate language and emojis
</style>

<interactions>
- Users may respond to each other
- Reference what others said
- Create natural conversation flow
</interactions>

You must format your responses using the following format:
<format>
username: message
</format>
`;

    function createTemplateCreatorModal() {
        if (jQuery('#ec_template_creator_modal').length) return;

        const modalHtml = `
        <div id="ec_template_creator_modal" class="ec_modal_overlay">
            <div class="ec_modal_content ec_template_creator">
                <div class="ec_modal_header">
                    <h3><i class="fa-solid fa-wand-magic-sparkles"></i> Create New Style</h3>
                    <button class="ec_modal_close" id="ec_template_close">&times;</button>
                </div>
                <div class="ec_template_tabs">
                    <button class="ec_tab_btn active" data-tab="easy"><i class="fa-solid fa-magic"></i> Easy Mode</button>
                    <button class="ec_tab_btn" data-tab="advanced"><i class="fa-solid fa-code"></i> Advanced</button>
                </div>
                <div class="ec_modal_body ec_template_body">
                    <!-- Easy Mode -->
                    <div class="ec_tab_content active" data-tab="easy">
                        <div class="ec_form_group">
                            <label>Style Name</label>
                            <input type="text" id="ec_tpl_name" placeholder="My Custom Chat" />
                        </div>
                        <div class="ec_form_group">
                            <label>Style Type</label>
                            <select id="ec_tpl_type">
                                <option value="chat">Chat (Multiple Users)</option>
                                <option value="narrator">Narrator (Single Voice)</option>
                            </select>
                        </div>
                        <div class="ec_form_group">
                            <label>Output Format</label>
                            <input type="text" id="ec_tpl_format" placeholder="username: message" value="username: message" />
                            <small>How each message should be formatted</small>
                        </div>
                        <div class="ec_form_group">
                            <label>Identity / Setting</label>
                            <textarea id="ec_tpl_identity" rows="2" placeholder="Who are the participants? What's the context?"></textarea>
                            <small>e.g., "Discord users reacting live to events" or "A sarcastic AI commentator"</small>
                        </div>
                        <div class="ec_form_group">
                            <label>Personality Guidelines</label>
                            <textarea id="ec_tpl_personality" rows="3" placeholder="Describe the tone, vocabulary, and behavior"></textarea>
                            <small>e.g., "Chaotic, uses emojis, internet slang, varying excitement levels"</small>
                        </div>
                        <div class="ec_form_group">
                            <label>Tone</label>
                            <select id="ec_tpl_tone">
                                <option value="custom">Custom (enter below)</option>
                                <option value="chaotic">Chaotic / Energetic</option>
                                <option value="calm">Calm / Thoughtful</option>
                                <option value="sarcastic">Sarcastic / Witty</option>
                                <option value="wholesome">Wholesome / Supportive</option>
                                <option value="cynical">Cynical / Tired</option>
                                <option value="explicit">Explicit / NSFW</option>
                            </select>
                            <input type="text" id="ec_tpl_custom_tone" placeholder="Enter your custom tone description..." style="margin-top: 8px;" />
                        </div>
                        <div class="ec_form_row">
                            <div class="ec_form_group">
                                <label>Message Length</label>
                                <select id="ec_tpl_length">
                                    <option value="short">Short (1-2 sentences)</option>
                                    <option value="medium">Medium (2-3 sentences)</option>
                                    <option value="long">Long (paragraphs)</option>
                                </select>
                            </div>
                            <div class="ec_form_group">
                                <label>User Interactions</label>
                                <select id="ec_tpl_interact">
                                    <option value="yes">Users respond to each other</option>
                                    <option value="no">Independent messages</option>
                                </select>
                            </div>
                        </div>
                        <div class="ec_form_group">
                            <label>Style Elements (select all that apply)</label>
                            <div class="ec_checkbox_row">
                                <label><input type="checkbox" id="ec_tpl_emoji" checked /> Emojis</label>
                                <label><input type="checkbox" id="ec_tpl_slang" checked /> Internet Slang</label>
                                <label><input type="checkbox" id="ec_tpl_lowercase" /> Lowercase preferred</label>
                                <label><input type="checkbox" id="ec_tpl_typos" /> Occasional typos</label>
                            </div>
                            <div class="ec_checkbox_row" style="margin-top: 8px;">
                                <label><input type="checkbox" id="ec_tpl_allcaps" /> ALL CAPS moments</label>
                                <label><input type="checkbox" id="ec_tpl_hashtags" /> Hashtags</label>
                                <label><input type="checkbox" id="ec_tpl_mentions" /> @mentions</label>
                                <label><input type="checkbox" id="ec_tpl_formal" /> Formal grammar</label>
                            </div>
                        </div>
                    </div>
                    <!-- Advanced Mode -->
                    <div class="ec_tab_content" data-tab="advanced">
                        <div class="ec_form_group">
                            <label>Style Name</label>
                            <input type="text" id="ec_tpl_adv_name" placeholder="My Custom Chat" />
                        </div>
                        <div class="ec_form_group ec_full_height">
                            <label>System Prompt</label>
                            <div class="ec_prompt_actions">
                                <button class="menu_button ec_small_btn" id="ec_tpl_copy"><i class="fa-solid fa-copy"></i> Copy</button>
                                <button class="menu_button ec_small_btn" id="ec_tpl_paste"><i class="fa-solid fa-paste"></i> Paste</button>
                                <button class="menu_button ec_small_btn" id="ec_tpl_clear"><i class="fa-solid fa-eraser"></i> Clear</button>
                                <button class="menu_button ec_small_btn" id="ec_tpl_reset"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                            </div>
                            <textarea id="ec_tpl_adv_prompt" placeholder="Write your complete system prompt here..."></textarea>
                            <small>The extension will prepend "Generate X messages" based on user count setting.</small>
                        </div>
                    </div>
                </div>
                <div class="ec_modal_footer">
                    <div class="ec_modal_footer_left"></div>
                    <div class="ec_modal_footer_right">
                        <button class="menu_button" id="ec_template_cancel">Cancel</button>
                        <button class="menu_button ec_btn_primary" id="ec_template_create">
                            <i class="fa-solid fa-plus"></i> Create
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

        jQuery('body').append(modalHtml);
        templateCreatorModal = jQuery('#ec_template_creator_modal');

        // Tab switching
        templateCreatorModal.on('click', '.ec_tab_btn', function () {
            const tab = jQuery(this).data('tab');
            templateCreatorModal.find('.ec_tab_btn').removeClass('active');
            templateCreatorModal.find('.ec_tab_content').removeClass('active');
            jQuery(this).addClass('active');
            templateCreatorModal.find(`.ec_tab_content[data-tab="${tab}"]`).addClass('active');
        });

        // Tone dropdown - show/hide custom input
        templateCreatorModal.on('change', '#ec_tpl_tone', function () {
            const isCustom = jQuery(this).val() === 'custom';
            jQuery('#ec_tpl_custom_tone').toggle(isCustom);
            if (isCustom) jQuery('#ec_tpl_custom_tone').focus();
        });

        // Advanced mode buttons
        jQuery('#ec_tpl_clear').on('click', function () {
            jQuery('#ec_tpl_adv_prompt').val('').focus();
        });

        jQuery('#ec_tpl_copy').on('click', async function () {
            try {
                const text = jQuery('#ec_tpl_adv_prompt').val();
                await navigator.clipboard.writeText(text);
                if (typeof toastr !== 'undefined') toastr.success('Prompt copied to clipboard');
            } catch (err) {
                if (typeof toastr !== 'undefined') toastr.error('Could not copy to clipboard');
            }
        });

        jQuery('#ec_tpl_paste').on('click', async function () {
            try {
                const text = await navigator.clipboard.readText();
                jQuery('#ec_tpl_adv_prompt').val(text);
            } catch (err) {
                if (typeof toastr !== 'undefined') toastr.error('Could not access clipboard');
            }
        });

        jQuery('#ec_tpl_reset').on('click', function () {
            jQuery('#ec_tpl_adv_prompt').val(defaultAdvancedTemplate);
        });

        // Close handlers
        jQuery('#ec_template_close, #ec_template_cancel').on('click', closeTemplateCreator);
        jQuery('#ec_template_create').on('click', createStyleFromTemplate);

        templateCreatorModal.on('click', function (e) {
            if (e.target === this) closeTemplateCreator();
        });
    }

    function openTemplateCreator() {
        createTemplateCreatorModal();
        // Reset form
        templateCreatorModal.find('input[type="text"], textarea').val('');
        templateCreatorModal.find('select').each(function () {
            this.selectedIndex = 0;
        });
        templateCreatorModal.find('input[type="checkbox"]').prop('checked', false);
        jQuery('#ec_tpl_emoji, #ec_tpl_slang').prop('checked', true);
        jQuery('#ec_tpl_format').val('username: message');

        // Set tone to chaotic (not custom) and hide custom input
        jQuery('#ec_tpl_tone').val('chaotic');
        jQuery('#ec_tpl_custom_tone').hide().val('');

        // Pre-populate Advanced mode with template
        jQuery('#ec_tpl_adv_prompt').val(defaultAdvancedTemplate);

        // Reset to Easy tab
        templateCreatorModal.find('.ec_tab_btn').removeClass('active').first().addClass('active');
        templateCreatorModal.find('.ec_tab_content').removeClass('active').first().addClass('active');

        templateCreatorModal.addClass('active');
    }

    function closeTemplateCreator() {
        if (templateCreatorModal) templateCreatorModal.removeClass('active');
    }

    function createStyleFromTemplate() {
        const activeTab = templateCreatorModal.find('.ec_tab_btn.active').data('tab');
        let styleName, stylePrompt;

        if (activeTab === 'advanced') {
            // Advanced mode - use raw prompt
            styleName = jQuery('#ec_tpl_adv_name').val().trim() || 'Custom Style';
            stylePrompt = jQuery('#ec_tpl_adv_prompt').val().trim();
            if (!stylePrompt) {
                if (typeof toastr !== 'undefined') toastr.warning('Please enter a system prompt.');
                return;
            }
        } else {
            // Easy mode - build prompt from form
            styleName = jQuery('#ec_tpl_name').val().trim() || 'Custom Style';
            const type = jQuery('#ec_tpl_type').val();
            const format = jQuery('#ec_tpl_format').val().trim() || 'username: message';
            const identity = jQuery('#ec_tpl_identity').val().trim();
            const personality = jQuery('#ec_tpl_personality').val().trim();
            const toneSelect = jQuery('#ec_tpl_tone').val();
            const customTone = jQuery('#ec_tpl_custom_tone').val().trim();
            const length = jQuery('#ec_tpl_length').val();
            const interact = jQuery('#ec_tpl_interact').val() === 'yes';
            const useEmoji = jQuery('#ec_tpl_emoji').is(':checked');
            const useSlang = jQuery('#ec_tpl_slang').is(':checked');
            const useLowercase = jQuery('#ec_tpl_lowercase').is(':checked');
            const useTypos = jQuery('#ec_tpl_typos').is(':checked');
            const useAllCaps = jQuery('#ec_tpl_allcaps').is(':checked');
            const useHashtags = jQuery('#ec_tpl_hashtags').is(':checked');
            const useMentions = jQuery('#ec_tpl_mentions').is(':checked');
            const useFormal = jQuery('#ec_tpl_formal').is(':checked');

            // Build the prompt
            const toneDescriptions = {
                chaotic: 'chaotic, energetic, and excitable',
                calm: 'calm, thoughtful, and reflective',
                sarcastic: 'sarcastic, witty, and playfully mocking',
                wholesome: 'wholesome, supportive, and kind',
                cynical: 'cynical, tired, and darkly humorous',
                explicit: 'explicit, unfiltered, and provocative'
            };

            const lengthDescriptions = {
                short: '1-2 sentences maximum',
                medium: '2-3 complete sentences',
                long: '1-3 paragraphs with 3-5 sentences each'
            };

            // Get tone description - use custom if selected
            const toneDescription = toneSelect === 'custom' && customTone
                ? customTone
                : (toneDescriptions[toneSelect] || 'varied and natural');

            // Build prompt with XML format
            let prompt = '';

            // Opening
            if (identity) {
                prompt += `${identity}\n\n`;
            } else {
                prompt += `You will be acting as a ${type === 'chat' ? 'chat feed audience' : 'narrator'}. Your goal is to simulate ${type === 'chat' ? 'messages' : 'commentary'} reacting to the unfolding events.\n\n`;
            }

            // Usernames section
            if (type === 'chat') {
                prompt += `<usernames>\n`;
                prompt += `- Generate NEW random usernames each time\n`;
                prompt += `- Make them creative, varied, and contextually appropriate\n`;
                prompt += `- Align them with the conversation context\n`;
                prompt += `</usernames>\n\n`;
            }

            // Personality section
            if (personality) {
                prompt += `<personalities>\n`;
                prompt += `- ${personality}\n`;
                prompt += `- Messages should be ${toneDescription}\n`;
                prompt += `</personalities>\n\n`;
            } else {
                prompt += `<personalities>\n`;
                prompt += `- Messages should be ${toneDescription}\n`;
                prompt += `- Mix different personality types and reactions\n`;
                prompt += `- Vary the tone and engagement level\n`;
                prompt += `</personalities>\n\n`;
            }

            // Style section
            const styleElements = [];
            if (useEmoji) styleElements.push('Use emojis');
            if (useSlang) styleElements.push('Use internet slang');
            if (useLowercase) styleElements.push('Prefer lowercase');
            if (useTypos) styleElements.push('Include occasional typos');
            if (useAllCaps) styleElements.push('Use ALL CAPS for emphasis occasionally');
            if (useHashtags) styleElements.push('Include hashtags');
            if (useMentions) styleElements.push('Use @mentions between users');
            if (useFormal) styleElements.push('Use proper grammar and punctuation');
            styleElements.push(`Each message should be ${lengthDescriptions[length]}`);

            prompt += `<style>\n`;
            styleElements.forEach(element => prompt += `- ${element}\n`);
            prompt += `</style>\n\n`;

            // Interactions section
            if (type === 'chat') {
                prompt += `<interactions>\n`;
                if (interact) {
                    prompt += `- Users may respond to each other\n`;
                    prompt += `- Users can agree, disagree, or build on previous comments\n`;
                    prompt += `- Reference what others said\n`;
                } else {
                    prompt += `- Each message is independent\n`;
                    prompt += `- No direct replies between users\n`;
                }
                prompt += `</interactions>\n\n`;
            }

            // Format instruction at the end
            prompt += `You must format your responses using the following format:\n`;
            prompt += `<format>\n`;
            prompt += `${format}\n`;
            prompt += `</format>`;

            stylePrompt = prompt.trim();
        }

        // Validate input types
        if (typeof styleName !== 'string' || typeof stylePrompt !== 'string') {
            if (typeof toastr !== 'undefined') toastr.error('Invalid input type');
            return;
        }

        // Create the style
        const id = 'custom_' + Date.now();
        if (!settings.custom_styles) settings.custom_styles = {};
        settings.custom_styles[id] = {
            name: styleName,
            prompt: stylePrompt
        };
        saveSettings();

        closeTemplateCreator();

        // Refresh style list and select new style
        populateStyleList();
        selectStyleInEditor(id);

        // Sanitize style name for display
        const { DOMPurify } = SillyTavern.libs;
        const safeStyleName = DOMPurify.sanitize(styleName, { ALLOWED_TAGS: [] });
        if (typeof toastr !== 'undefined') toastr.success(`Style "${safeStyleName}" created!`);
    }

    function createNewStyle() {
        openTemplateCreator();
    }

    function saveStyleFromEditor() {
        if (!currentEditingStyle) return;

        const name = jQuery('#ec_style_name').val().trim();
        const content = jQuery('#ec_style_content').val();

        // Validate input types
        if (typeof name !== 'string' || typeof content !== 'string') {
            if (typeof toastr !== 'undefined') toastr.error('Invalid input type');
            return;
        }

        if (!name) {
            if (typeof toastr !== 'undefined') toastr.error('Style name cannot be empty');
            return;
        }

        const isCustom = settings.custom_styles && settings.custom_styles[currentEditingStyle];

        if (isCustom) {
            // Update existing custom style
            settings.custom_styles[currentEditingStyle].name = name;
            settings.custom_styles[currentEditingStyle].prompt = content;
        } else {
            // Save modified built-in as new custom style
            // Check if content differs from original
            const id = 'custom_' + currentEditingStyle + '_' + Date.now();
            if (!settings.custom_styles) settings.custom_styles = {};
            settings.custom_styles[id] = {
                name: name + ' (Custom)',
                prompt: content
            };
            currentEditingStyle = id;
        }

        saveSettings();
        populateStyleList();

        // Sanitize currentEditingStyle for safe DOM query
        const { DOMPurify } = SillyTavern.libs;
        const safeId = DOMPurify.sanitize(currentEditingStyle, { ALLOWED_TAGS: [] });
        jQuery(`.ec_style_item[data-id="${safeId}"]`).addClass('active');

        const safeName = DOMPurify.sanitize(name, { ALLOWED_TAGS: [] });
        if (typeof toastr !== 'undefined') toastr.success(`Style "${safeName}" saved!`);
        log('Style saved:', currentEditingStyle);
    }

    function deleteStyleFromEditor() {
        if (!currentEditingStyle) return;

        const isCustom = settings.custom_styles && settings.custom_styles[currentEditingStyle];

        if (isCustom) {
            if (!confirm('Delete this custom style? This cannot be undone.')) return;
            delete settings.custom_styles[currentEditingStyle];
        } else {
            if (!confirm('Hide this built-in style? You can restore it by clearing deleted styles.')) return;
            if (!settings.deleted_styles) settings.deleted_styles = [];
            settings.deleted_styles.push(currentEditingStyle);
        }

        saveSettings();
        currentEditingStyle = null;
        populateStyleList();
        showEmptyState();

        if (typeof toastr !== 'undefined') toastr.info('Style removed');
    }

    function exportStyle(styleId) {
        if (!styleId) return;

        const content = jQuery('#ec_style_content').val();
        const name = jQuery('#ec_style_name').val() || styleId;

        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (typeof toastr !== 'undefined') toastr.success('Style exported!');
    }

    // ============================================================
    // UI RENDERING
    // ============================================================

    function renderPanel() {
        jQuery('#discordBar').remove();

        discordBar = jQuery('<div id="discordBar"></div>');
        discordQuickBar = jQuery('<div id="discordQuickSettings"></div>');

        // Header Left - Power button (enable/disable), Collapse arrow, and Live indicator
        const leftGroup = jQuery('<div class="ec_header_left"></div>');
        const powerBtn = jQuery('<div class="ec_power_btn" title="Enable/Disable EchoChamber"><i class="fa-solid fa-power-off"></i></div>');
        const collapseBtn = jQuery('<div class="ec_collapse_btn" title="Collapse/Expand Panel"><i class="fa-solid fa-chevron-down"></i></div>');
        const liveIndicator = jQuery('<div class="ec_live_indicator" id="ec_live_indicator"><i class="fa-solid fa-circle"></i> LIVE</div>');
        leftGroup.append(powerBtn).append(collapseBtn).append(liveIndicator);

        // Header Right - All icon buttons (Refresh first, then layout, users, font)
        const rightGroup = jQuery('<div class="ec_header_right"></div>');
        const createBtn = (icon, title, menuClass) => {
            const btn = jQuery(`<div class="ec_btn" title="${title}"><i class="${icon}"></i></div>`);
            if (menuClass) btn.append(`<div class="ec_popup_menu ${menuClass}"></div>`);
            return btn;
        };

        const refreshBtn = createBtn('fa-solid fa-rotate-right', 'Regenerate Chat', null);
        const layoutBtn = createBtn('fa-solid fa-table-columns', 'Panel Position', 'ec_layout_menu');
        const usersBtn = createBtn('fa-solid fa-users', 'User Count', 'ec_user_menu');
        const fontBtn = createBtn('fa-solid fa-font', 'Font Size', 'ec_font_menu');
        const clearBtn = createBtn('fa-solid fa-trash-can', 'Clear Chat & Cache', null);

        // Refresh is first on the left, then layout, users, font, and clear button last
        rightGroup.append(refreshBtn).append(layoutBtn).append(usersBtn).append(fontBtn).append(clearBtn);

        discordQuickBar.append(leftGroup).append(rightGroup);

        // Style Indicator - shows current style name AND acts as dropdown
        const styleIndicator = jQuery('<div class="ec_style_indicator ec_style_dropdown_trigger" id="ec_style_indicator"></div>');
        // Create style menu and append to body to avoid clipping issues
        jQuery('#ec_style_menu_body').remove(); // Remove any existing
        const styleMenu = jQuery('<div id="ec_style_menu_body" class="ec_popup_menu ec_style_menu ec_indicator_menu"></div>');
        jQuery('body').append(styleMenu);
        updateStyleIndicator(styleIndicator);
        populateStyleMenu(styleMenu);

        // Status overlay - separate from content so it persists across updates
        const statusOverlay = jQuery('<div class="ec_status_overlay"></div>');

        discordContent = jQuery('<div id="discordContent"></div>');

        const resizeHandle = jQuery('<div class="ec_resize_handle"></div>');

        discordBar.append(discordQuickBar).append(styleIndicator).append(statusOverlay).append(discordContent).append(resizeHandle);

        // Populate Layout Menu
        const layoutMenu = layoutBtn.find('.ec_layout_menu');
        const currentPos = settings.position || 'bottom';
        ['Top', 'Bottom', 'Left', 'Right'].forEach(pos => {
            const icon = pos === 'Top' ? 'up' : pos === 'Bottom' ? 'down' : pos === 'Left' ? 'left' : 'right';
            const isSelected = pos.toLowerCase() === currentPos ? ' selected' : '';
            layoutMenu.append(`<div class="ec_menu_item${isSelected}" data-val="${pos.toLowerCase()}"><i class="fa-solid fa-arrow-${icon}"></i> ${pos}</div>`);
        });
        // Add Pop Out option
        const popoutSelected = currentPos === 'popout' ? ' selected' : '';
        layoutMenu.append(`<div class="ec_menu_item${popoutSelected}" data-val="popout"><i class="fa-solid fa-arrow-up-right-from-square"></i> Pop Out</div>`);

        // Populate User Count Menu with current selection highlighted
        const userMenu = usersBtn.find('.ec_user_menu');
        const currentUsers = settings.userCount || 5;
        for (let i = 1; i <= 20; i++) {
            const isSelected = i === currentUsers ? ' selected' : '';
            userMenu.append(`<div class="ec_menu_item${isSelected}" data-val="${i}">${i} users</div>`);
        }

        // Populate Font Size Menu with current selection highlighted
        const fontMenu = fontBtn.find('.ec_font_menu');
        const currentFont = settings.fontSize || 15;
        for (let i = 8; i <= 24; i++) {
            const isSelected = i === currentFont ? ' selected' : '';
            fontMenu.append(`<div class="ec_menu_item${isSelected}" data-val="${i}">${i}px</div>`);
        }


        updateApplyLayout();
        log('Panel rendered');
    }

    function populateStyleMenu(menu) {
        menu.empty();
        const styles = getAllStyles();
        const { DOMPurify } = SillyTavern.libs;
        styles.forEach(s => {
            const isSelected = s.val === settings.style ? ' selected' : '';
            const safeVal = DOMPurify.sanitize(s.val, { ALLOWED_TAGS: [] });
            const safeLabel = DOMPurify.sanitize(s.label, { ALLOWED_TAGS: [] });
            menu.append(`<div class="ec_menu_item${isSelected}" data-val="${safeVal}"><i class="fa-solid fa-masks-theater"></i> ${safeLabel}</div>`);
        });
    }

    function updateStyleIndicator(indicator) {
        const el = indicator || jQuery('#ec_style_indicator');
        if (!el.length) return;

        const styles = getAllStyles();
        const currentStyle = styles.find(s => s.val === settings.style);
        const styleName = currentStyle ? currentStyle.label : (settings.style || 'Default');

        // Sanitize style name to prevent XSS
        const { DOMPurify } = SillyTavern.libs;
        const safeStyleName = DOMPurify.sanitize(styleName, { ALLOWED_TAGS: [] });

        // Keep existing menu if present
        const existingMenu = el.find('.ec_indicator_menu');
        el.html(`<i class="fa-solid fa-masks-theater"></i> <span>Style: ${safeStyleName}</span> <i class="fa-solid fa-caret-down ec_dropdown_arrow"></i>`);
        if (existingMenu.length) el.append(existingMenu);
    }

    function updateApplyLayout() {
        if (!discordBar) return;

        // If fully disabled (via settings checkbox), hide the panel entirely
        if (!settings.enabled) {
            discordBar.hide();
            return;
        }

        // Show panel if enabled
        discordBar.show();

        const pos = settings.position || 'bottom';

        // Remove all position classes
        discordBar.removeClass('ec_top ec_bottom ec_left ec_right ec_collapsed');
        discordBar.addClass(`ec_${pos}`);

        // Detach and re-append depending on mode
        discordBar.detach();

        // Reset inline styles
        discordBar.css({ top: '', bottom: '', left: '', right: '', width: '', height: '' });
        discordContent.attr('style', '');

        // Apply opacity to backgrounds
        const opacity = (settings.opacity || 85) / 100;
        const bgWithOpacity = `rgba(20, 20, 25, ${opacity})`;
        const headerBgWithOpacity = `rgba(0, 0, 0, ${opacity * 0.3})`;
        discordBar.css('background', bgWithOpacity);
        discordQuickBar.css('background', headerBgWithOpacity);

        if (pos === 'bottom') {
            // On mobile, insert BEFORE send_form; on desktop, insert AFTER
            const sendForm = jQuery('#send_form');
            const isMobile = window.innerWidth <= 768;

            if (sendForm.length) {
                if (isMobile) {
                    sendForm.before(discordBar);
                } else {
                    sendForm.after(discordBar);
                }
            } else {
                // Fallback: try form_sheld
                const formSheld = jQuery('#form_sheld');
                if (formSheld.length) {
                    formSheld.append(discordBar);
                } else {
                    jQuery('body').append(discordBar);
                }
            }
            // Reset styles for flow layout
            discordBar.css({ width: '100%', height: '' });
            // Strict height control: disable flex growth, force pixel height
            discordContent.css({
                'height': `${settings.chatHeight || 200}px`,
                'flex-grow': '0'
            });
            log('Bottom panel placed, content height:', settings.chatHeight);
        } else {
            // Top, Left, Right all append to body (fixed positioning via CSS)
            jQuery('body').append(discordBar);

            if (pos === 'top') {
                discordContent.css({
                    'height': `${settings.chatHeight || 200}px`,
                    'flex-grow': '0'
                });
                log('Top panel placed, content height:', settings.chatHeight);
            } else {
                // Side layouts - don't set width, let CSS handle it with calc()
                // Only apply panelWidth if position is not left/right
                discordContent.css({
                    'height': '100%',
                    'flex-grow': '1'
                });
            }
        }

        // Apply Collapsed State
        if (settings.collapsed) {
            discordBar.addClass('ec_collapsed');
        } else {
            discordBar.removeClass('ec_collapsed');
        }

        // Add paused visual state class (panel stays visible, generation is paused)
        if (settings.paused) {
            discordBar.addClass('ec_disabled');
        } else {
            discordBar.removeClass('ec_disabled');
        }

        updatePanelIcons();
    }

    function updatePanelIcons() {
        if (!discordBar) return;

        // Update power button - shows paused state
        const powerBtn = discordBar.find('.ec_power_btn');
        if (!settings.paused) {
            powerBtn.css('color', 'var(--ec-accent)');
            powerBtn.attr('title', 'Toggle On/Off (Currently ON)');
        } else {
            powerBtn.css('color', 'rgba(255, 255, 255, 0.3)');
            powerBtn.attr('title', 'Toggle On/Off (Currently OFF)');
        }

        // Update collapse button - shows collapsed state with arrow direction
        const collapseBtn = discordBar.find('.ec_collapse_btn i');
        const pos = settings.position || 'bottom';
        if (settings.collapsed) {
            // When collapsed, arrow points toward expansion direction
            if (pos === 'bottom') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-up');
            else if (pos === 'top') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-down');
            else if (pos === 'left') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-right');
            else if (pos === 'right') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-left');
            discordBar.find('.ec_collapse_btn').css('opacity', '0.5');
        } else {
            // When expanded, arrow points toward collapse direction
            if (pos === 'bottom') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-down');
            else if (pos === 'top') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-up');
            else if (pos === 'left') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-left');
            else if (pos === 'right') collapseBtn.removeClass('fa-chevron-down fa-chevron-up fa-chevron-left fa-chevron-right').addClass('fa-chevron-right');
            discordBar.find('.ec_collapse_btn').css('opacity', '1');
        }

        updateLiveIndicator();
    }

    function updateLiveIndicator() {
        const indicator = jQuery('#ec_live_indicator');
        if (!indicator.length) return;

        if (settings.livestream) {
            indicator.removeClass('ec_live_off').addClass('ec_live_on');
        } else {
            indicator.removeClass('ec_live_on').addClass('ec_live_off');
        }
    }

    // ============================================================
    // RESIZE LOGIC
    // ============================================================

    function initResizeLogic() {
        let isResizing = false;
        let startX, startY, startSize;

        jQuery(document).on('mousedown touchstart', '.ec_resize_handle', function (e) {
            e.preventDefault();
            e.stopPropagation();

            isResizing = true;
            startX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const pos = settings.position;

            if (pos === 'left' || pos === 'right') {
                startSize = settings.panelWidth || 350;
                jQuery('body').css('cursor', 'ew-resize');
            } else {
                // Use saved setting as start size (more reliable than DOM read)
                startSize = settings.chatHeight || 200;
                jQuery('body').css('cursor', 'ns-resize');
            }

            log('Resize started:', pos, 'startSize:', startSize, 'startY:', startY);
            jQuery(this).addClass('resizing');
        });

        jQuery(document).on('mousemove touchmove', function (e) {
            if (!isResizing) return;

            const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
            const clientY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
            const deltaX = clientX - startX;
            const deltaY = clientY - startY;
            const pos = settings.position;

            if (pos === 'bottom') {
                // Bottom panel: drag up = bigger, drag down = smaller
                const newHeight = Math.max(80, Math.min(600, startSize - deltaY));
                discordContent.css('height', newHeight + 'px');
                settings.chatHeight = newHeight;
            } else if (pos === 'top') {
                // Top panel: drag down = bigger, drag up = smaller
                const newHeight = Math.max(80, Math.min(600, startSize + deltaY));
                discordContent.css('height', newHeight + 'px');
                settings.chatHeight = newHeight;
            } else if (pos === 'left') {
                const newWidth = Math.max(200, Math.min(window.innerWidth - 50, startSize + deltaX));
                discordBar.css('width', newWidth + 'px');
                settings.panelWidth = newWidth;
            } else if (pos === 'right') {
                const newWidth = Math.max(200, Math.min(window.innerWidth - 50, startSize - deltaX));
                discordBar.css('width', newWidth + 'px');
                settings.panelWidth = newWidth;
            }
        });

        jQuery(document).on('mouseup touchend', function () {
            if (isResizing) {
                isResizing = false;
                jQuery('.ec_resize_handle').removeClass('resizing');
                jQuery('body').css('cursor', '');
                log('Resize ended, chatHeight:', settings.chatHeight);
                saveSettings();
            }
        });
    }

    // ============================================================
    // EVENT HANDLERS
    // ============================================================

    function bindEventHandlers() {
        // Prevent duplicate event listener registration
        if (eventsBound) return;
        eventsBound = true;

        // Power Button - toggles paused state (keeps panel visible, just pauses generation)
        jQuery(document).on('click', '.ec_power_btn', function () {
            settings.paused = !settings.paused;

            if (settings.paused) {
                // Pause: stop any ongoing generation (but keep panel visible)
                stopLivestream();
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
                discordBar.addClass('ec_disabled');
            } else {
                // Unpause: remove disabled state
                discordBar.removeClass('ec_disabled');
            }

            updatePanelIcons();
            saveSettings();
        });

        // Collapse Button - only toggles panel collapse state (visual only)
        jQuery(document).on('click', '.ec_collapse_btn', function () {
            settings.collapsed = !settings.collapsed;

            // Immediately apply/remove collapsed class
            if (settings.collapsed) {
                discordBar.addClass('ec_collapsed');
            } else {
                discordBar.removeClass('ec_collapsed');
            }

            updatePanelIcons();
            saveSettings();
        });

        // Menu Button Clicks
        jQuery(document).on('click', '.ec_btn', function (e) {
            const btn = jQuery(this);
            const wasActive = btn.hasClass('active');

            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide();

            if (btn.find('.ec_popup_menu').length > 0) {
                if (!wasActive) {
                    btn.addClass('open active');
                    btn.find('.ec_popup_menu').show();
                }
            } else if (btn.find('.fa-rotate-right').length) {
                btn.find('i').addClass('fa-spin');
                setTimeout(() => btn.find('i').removeClass('fa-spin'), 1000);
                generateDebounced();
            } else if (btn.find('.fa-trash-can').length) {
                // Clear button clicked
                if (confirm('Clear generated chat and all cached commentary?')) {
                    setDiscordText('');
                    clearCachedCommentary();
                    if (typeof toastr !== 'undefined') toastr.success('Chat and cache cleared');
                }
            }
            e.stopPropagation();
        });

        // Style Indicator Dropdown Click - menu is in body, position dynamically
        jQuery(document).on('click', '.ec_style_dropdown_trigger', function (e) {
            const trigger = jQuery(this);
            const wasActive = trigger.hasClass('active');
            const menu = jQuery('#ec_style_menu_body');

            // Close other menus
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').not('#ec_style_menu_body').hide();

            if (!wasActive) {
                trigger.addClass('active');
                // Position menu - check if panel is at bottom position
                const rect = trigger[0].getBoundingClientRect();
                const isBottomPosition = settings.position === 'bottom';
                const menuHeight = menu.outerHeight() || 300; // Estimate if not visible

                if (isBottomPosition) {
                    // Open upward when panel is at bottom
                    menu.css({
                        position: 'fixed',
                        bottom: (window.innerHeight - rect.top) + 'px',
                        top: 'auto',
                        left: rect.left + 'px',
                        width: Math.max(rect.width, 200) + 'px',
                        display: 'block',
                        maxHeight: (rect.top - 20) + 'px',
                        overflowY: 'auto'
                    });
                } else {
                    // Open downward for other positions
                    menu.css({
                        position: 'fixed',
                        top: rect.bottom + 'px',
                        bottom: 'auto',
                        left: rect.left + 'px',
                        width: Math.max(rect.width, 200) + 'px',
                        display: 'block',
                        maxHeight: (window.innerHeight - rect.bottom - 20) + 'px',
                        overflowY: 'auto'
                    });
                }
            } else {
                trigger.removeClass('active');
                menu.hide();
            }
            e.stopPropagation();
        });

        jQuery(document).on('click', function () {
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide();
            jQuery('#ec_style_menu_body').hide();
            jQuery('.ec_style_dropdown_trigger').removeClass('active');
        });

        // Menu Item Clicks
        jQuery(document).on('click', '.ec_menu_item', function (e) {
            e.stopPropagation();
            const parent = jQuery(this).closest('.ec_popup_menu');
            const val = jQuery(this).data('val');

            if (parent.hasClass('ec_style_menu')) {
                settings.style = val;
                saveSettings();
                jQuery('#discord_style').val(val);
                // Update style menu selection
                parent.find('.ec_menu_item').removeClass('selected');
                jQuery(this).addClass('selected');
                updateStyleIndicator();
                // Show toast notification about style change
                const styleObj = getAllStyles().find(s => s.val === val);
                const styleName = styleObj ? styleObj.label : val;
                if (typeof toastr !== 'undefined') toastr.info(`Style: ${styleName}`);
            } else if (parent.hasClass('ec_layout_menu')) {
                if (val === 'popout') {
                    // Open popout window
                    openPopoutWindow();
                    // Don't change the position setting, just close menu
                } else {
                    settings.position = val;
                    saveSettings();
                    updateApplyLayout();
                    jQuery('#discord_position').val(val);
                }
            } else if (parent.hasClass('ec_user_menu')) {
                settings.userCount = parseInt(val);
                saveSettings();
                jQuery('#discord_user_count').val(settings.userCount);
            } else if (parent.hasClass('ec_font_menu')) {
                const size = parseInt(val);
                settings.fontSize = size;
                applyFontSize(size);
                saveSettings();
                jQuery('#discord_font_size').val(size);
            }

            parent.find('.ec_menu_item').removeClass('selected');
            jQuery(this).addClass('selected');

            // Close all menus and reset all active states
            jQuery('.ec_btn').removeClass('open active');
            jQuery('.ec_popup_menu').hide();
            jQuery('.ec_style_dropdown_trigger').removeClass('active');
        });

        // Settings Panel Bindings - this fully enables/disables the extension (shows/hides panel)
        jQuery('#discord_enabled').on('change', function () {
            settings.enabled = jQuery(this).prop('checked');

            if (!settings.enabled) {
                // Full disable: stop generation and hide panel
                stopLivestream();
                if (abortController) {
                    abortController.abort();
                    abortController = null;
                }
                if (discordBar) discordBar.hide();
            } else {
                // Enable: remove paused state and reapply layout (which shows the panel)
                settings.paused = false;
                if (discordBar) {
                    discordBar.removeClass('ec_disabled');
                }
                updateApplyLayout();
            }

            saveSettings();
            updatePanelIcons();
        });

        jQuery('#discord_style').on('change', function () {
            const val = jQuery(this).val();
            settings.style = val;
            saveSettings();
            updateStyleIndicator();
            if (discordQuickBar) discordQuickBar.find('.ec_style_select').val(val);
        });

        jQuery('#discord_source').on('change', function () {
            settings.source = jQuery(this).val();
            saveSettings();
            updateSourceVisibility();
        });

        jQuery('#discord_position').on('change', function () {
            const newPosition = jQuery(this).val();
            if (newPosition === 'popout') {
                // Open popout window
                openPopoutWindow();
                // Reset to previous position (don't actually set position to 'popout')
                jQuery(this).val(settings.position || 'bottom');
            } else {
                settings.position = newPosition;
                saveSettings();
                updateApplyLayout();
            }
        });

        jQuery('#discord_user_count').on('change', function () {
            settings.userCount = parseInt(jQuery(this).val()) || 5;
            saveSettings();
        });

        jQuery('#discord_font_size').on('change', function () {
            settings.fontSize = parseInt(jQuery(this).val()) || 15;
            applyFontSize(settings.fontSize);
            saveSettings();
        });

        jQuery('#discord_opacity').on('input change', function () {
            settings.opacity = parseInt(jQuery(this).val()) || 85;
            jQuery('#discord_opacity_val').text(settings.opacity + '%');
            if (discordBar && discordQuickBar) {
                const opacity = settings.opacity / 100;
                const bgWithOpacity = `rgba(20, 20, 25, ${opacity})`;
                const headerBgWithOpacity = `rgba(0, 0, 0, ${opacity * 0.3})`;
                discordBar.css('background', bgWithOpacity);
                discordQuickBar.css('background', headerBgWithOpacity);
            }
            saveSettings();
        });

        // Connection Profile selection
        jQuery('#discord_preset_select').on('change', function () {
            settings.preset = jQuery(this).val();
            saveSettings();
            log('Selected connection profile:', settings.preset);
        });

        jQuery('#discord_openai_url').on('change', function () {
            settings.openai_url = jQuery(this).val();
            saveSettings();
            log('OpenAI URL:', settings.openai_url);
        });

        // OpenAI Compatible - Key
        jQuery('#discord_openai_key').on('change', function () {
            settings.openai_key = jQuery(this).val();
            saveSettings();
            log('OpenAI Key saved');
        });

        // OpenAI Compatible - Model
        jQuery('#discord_openai_model').on('change', function () {
            settings.openai_model = jQuery(this).val();
            saveSettings();
            log('OpenAI Model:', settings.openai_model);
        });

        // OpenAI Compatible - Preset
        jQuery('#discord_openai_preset').on('change', function () {
            settings.openai_preset = jQuery(this).val();
            saveSettings();
            log('OpenAI Preset:', settings.openai_preset);
        });

        // Ollama - URL
        jQuery('#discord_url').on('change', function () {
            settings.url = jQuery(this).val();
            saveSettings();
            log('Ollama URL:', settings.url);
        });

        // Ollama - Model selection
        jQuery('#discord_model_select').on('change', function () {
            settings.model = jQuery(this).val();
            saveSettings();
            log('Ollama Model:', settings.model);
        });

        // Include User Input toggle
        jQuery('#discord_include_user').on('change', function () {
            settings.includeUserInput = jQuery(this).prop('checked');
            // Show/hide context depth dropdown
            jQuery('#discord_context_depth_container').toggle(settings.includeUserInput);
            saveSettings();
            log('Include user input:', settings.includeUserInput);
        });

        // Context Depth selection
        jQuery('#discord_context_depth').on('change', function () {
            settings.contextDepth = parseInt(jQuery(this).val()) || 4;
            saveSettings();
            log('Context depth:', settings.contextDepth);
        });

        // Auto-update On Messages toggle
        jQuery('#discord_auto_update').on('change', function () {
            settings.autoUpdateOnMessages = jQuery(this).prop('checked');
            saveSettings();
            log('Auto-update on messages:', settings.autoUpdateOnMessages);
        });

        // Include Past Generated EchoChambers toggle
        jQuery('#discord_include_past_echo').on('change', function () {
            settings.includePastEchoChambers = jQuery(this).prop('checked');
            saveSettings();
            log('Include past EchoChambers:', settings.includePastEchoChambers);
        });

        // Include Persona toggle
        jQuery('#discord_include_persona').on('change', function () {
            settings.includePersona = jQuery(this).prop('checked');
            saveSettings();
            log('Include persona:', settings.includePersona);
        });

        // Include Character Description toggle
        jQuery('#discord_include_character_description').on('change', function () {
            settings.includeCharacterDescription = jQuery(this).prop('checked');
            saveSettings();
            log('Include character description:', settings.includeCharacterDescription);
        });

        // Include Summary toggle
        jQuery('#discord_include_summary').on('change', function () {
            settings.includeSummary = jQuery(this).prop('checked');
            saveSettings();
            log('Include summary:', settings.includeSummary);
        });

        // Include World Info toggle
        jQuery('#discord_include_world_info').on('change', function () {
            settings.includeWorldInfo = jQuery(this).prop('checked');
            saveSettings();
            log('Include world info:', settings.includeWorldInfo);
        });

        // Livestream toggle
        jQuery('#discord_livestream').on('change', function () {
            settings.livestream = jQuery(this).prop('checked');
            saveSettings();
            log('Livestream:', settings.livestream);

            // Show/hide livestream settings
            jQuery('#discord_livestream_settings').toggle(settings.livestream);

            // Update live indicator
            updateLiveIndicator();

            // Stop any active livestream when toggled off
            if (!settings.livestream) {
                stopLivestream();
            }
        });

        // Livestream batch size
        jQuery('#discord_livestream_batch_size').on('change', function () {
            settings.livestreamBatchSize = parseInt(jQuery(this).val()) || 20;
            saveSettings();
            log('Livestream batch size:', settings.livestreamBatchSize);
        });

        // Livestream minimum wait time
        jQuery('#discord_livestream_min_wait').on('change', function () {
            settings.livestreamMinWait = parseInt(jQuery(this).val()) || 5;
            saveSettings();
            log('Livestream min wait:', settings.livestreamMinWait);
        });

        // Livestream maximum wait time
        jQuery('#discord_livestream_max_wait').on('change', function () {
            settings.livestreamMaxWait = parseInt(jQuery(this).val()) || 60;
            saveSettings();
            log('Livestream max wait:', settings.livestreamMaxWait);
        });

        // Livestream mode radio buttons
        jQuery('input[name=\"discord_livestream_mode\"]').on('change', function () {
            settings.livestreamMode = jQuery(this).val();
            saveSettings();
            log('Livestream mode:', settings.livestreamMode);
        });

        // Style Editor button
        jQuery(document).on('click', '#discord_open_style_editor', function () {
            openStyleEditor();
        });

        // Import Style file
        jQuery(document).on('click', '#discord_import_btn', function () {
            jQuery('#discord_import_file').click();
        });

        // Export Style button
        jQuery(document).on('click', '#discord_export_btn', async function () {
            const currentStyle = settings.style || 'twitch';
            const styles = getAllStyles();
            const styleObj = styles.find(s => s.val === currentStyle);
            const styleName = styleObj ? styleObj.label : currentStyle;

            // Get the prompt content
            let content = '';
            if (settings.custom_styles && settings.custom_styles[currentStyle]) {
                content = settings.custom_styles[currentStyle].prompt;
            } else {
                content = await loadChatStyle(currentStyle);
            }

            const blob = new Blob([content], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `echochamber_${styleName.toLowerCase().replace(/[^a-z0-9]/g, '_')}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            if (typeof toastr !== 'undefined') toastr.success(`Style "${styleName}" exported!`);
        });

        jQuery(document).on('change', '#discord_import_file', function () {
            const file = this.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function (e) {
                const content = e.target.result;
                const name = file.name.replace(/\.md$/i, '');
                const id = 'custom_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();

                if (!settings.custom_styles) settings.custom_styles = {};
                settings.custom_styles[id] = { name: name, prompt: content };
                saveSettings();
                updateAllDropdowns();

                if (typeof toastr !== 'undefined') toastr.success(`Imported style: ${name}`);
                log('Imported style:', id);
            };
            reader.readAsText(file);
            this.value = '';  // Reset to allow re-importing same file
        });

        // SillyTavern Events
        const context = SillyTavern.getContext();
        if (context.eventSource && context.eventTypes) {
            // Only auto-generate on new message if autoUpdateOnMessages is enabled
            context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
                // Don't auto-generate if there's no chat or it's empty (fresh chat)
                const ctx = SillyTavern.getContext();
                if (!ctx.chat || ctx.chat.length === 0) return;

                // Don't auto-generate if we're currently loading/switching chats
                if (isLoadingChat) return;

                // Don't auto-generate if character editor is open (editing character cards)
                const characterEditor = document.querySelector('#character_popup');
                const isCharacterEditorOpen = characterEditor && characterEditor.style.display !== 'none' && characterEditor.offsetParent !== null;
                if (isCharacterEditorOpen) return;

                // Don't auto-generate if we're in the character creation/management area
                const charCreatePanel = document.querySelector('#rm_ch_create_block');
                const isCreatingCharacter = charCreatePanel && charCreatePanel.style.display !== 'none' && charCreatePanel.offsetParent !== null;
                if (isCreatingCharacter) return;

                // Don't auto-generate if there's no valid chatId (indicates we're not in an actual conversation)
                if (!ctx.chatId) return;

                // Only trigger on AI character messages, not user messages
                const lastMessage = ctx.chat[ctx.chat.length - 1];
                if (!lastMessage || lastMessage.is_user) {
                    // This is a user message or no message - don't auto-generate
                    return;
                }

                // Determine if we should auto-generate
                let shouldAutoGenerate = false;

                if (settings.livestream && settings.livestreamMode === 'onMessage') {
                    // Livestream in onMessage mode takes priority
                    shouldAutoGenerate = true;
                } else if (!settings.livestream && settings.autoUpdateOnMessages === true) {
                    // Regular auto-update (only if livestream is off)
                    shouldAutoGenerate = true;
                }

                onChatEvent(false, shouldAutoGenerate);
            });
            // On chat change (loading a conversation), clear display and try to restore from metadata
            context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
                // Set flag to prevent MESSAGE_RECEIVED from triggering during chat load
                isLoadingChat = true;
                onChatEvent(false, false);
                // Clear the flag after a short delay to allow legitimate new messages
                setTimeout(() => { isLoadingChat = false; }, 1000);
            });
            context.eventSource.on(context.eventTypes.GENERATION_STOPPED, () => setStatus(''));
            // Refresh profiles when settings change (handles async loading)
            context.eventSource.on(context.eventTypes.SETTINGS_UPDATED, () => populateConnectionProfiles());
        }
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    async function init() {
        log('Initializing...');

        // Wait for SillyTavern to be ready
        if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
            warn('SillyTavern not ready, retrying in 500ms...');
            setTimeout(init, 500);
            return;
        }

        const context = SillyTavern.getContext();
        log('Context available:', !!context);

        // Note: FontAwesome is already included by SillyTavern - do not inject a duplicate

        // Load settings HTML template
        try {
            if (context.renderExtensionTemplateAsync) {
                // Try to find the correct module name from script path
                const scripts = document.querySelectorAll('script[src*="index.js"]');
                let moduleName = 'third-party/SillyTavern-EchoChamber';
                for (const script of scripts) {
                    const match = script.src.match(/extensions\/(.+?)\/index\.js/);
                    if (match && (match[1].includes('EchoChamber') || match[1].includes('DiscordChat'))) {
                        moduleName = match[1];
                        break;
                    }
                }
                log('Detected module name:', moduleName);

                const settingsHtml = await context.renderExtensionTemplateAsync(moduleName, 'settings');
                jQuery('#extensions_settings').append(settingsHtml);
                log('Settings template loaded');
            }
        } catch (err) {
            error('Failed to load settings template:', err);
        }

        // Initialize - load settings FIRST so panel can use them
        loadSettings();
        renderPanel();
        initResizeLogic();
        bindEventHandlers();

        // Restore cached commentary if there's an active chat
        if (context.chatId) {
            restoreCachedCommentary();
        }

        log('Initialization complete');
    }

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
