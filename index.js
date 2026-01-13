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
        source: 'default',
        preset: '',
        url: 'http://localhost:11434',
        model: '',
        openai_url: 'http://localhost:1234/v1',
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

    // Livestream state
    let livestreamQueue = []; // Queue of messages to display
    let livestreamTimer = null; // Timer for displaying next message
    let livestreamActive = false; // Whether livestream is currently displaying messages

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
                // Stop any current livestream and start a new batch
                stopLivestream();
                generateDebounced();
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
        if (metadata && metadata.generatedHtml) {
            setDiscordText(metadata.generatedHtml);
            log('Restored cached commentary from metadata, length:', metadata.generatedHtml.length);
        } else {
            setDiscordText('');
            log('No cached commentary found');
        }
    }

    // ============================================================
    // LIVESTREAM FUNCTIONS
    // ============================================================

    function stopLivestream() {
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
            log('Livestream completed');

            // If in onComplete mode, trigger next batch generation
            if (settings.livestream && settings.livestreamMode === 'onComplete') {
                log('Livestream onComplete mode: triggering next batch');
                generateDebounced();
            }
            return;
        }

        const message = livestreamQueue.shift();

        // Get current content
        const currentContent = discordContent ? discordContent.html() : '';

        // Prepend new message with animation class
        const messageHtml = `<div class="ec_livestream_message">${message}</div>`;
        const newContent = messageHtml + currentContent;

        setDiscordText(newContent);

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
    // GENERATION FUNCTIONS
    // ============================================================

    function saveGeneratedCommentary(html, messageCommentaries) {
        const chatId = SillyTavern.getContext().chatId;
        log('Saving generated commentary for chatId:', chatId, 'html length:', html?.length);
        saveChatMetadata({
            generatedHtml: html,
            messageCommentaries: messageCommentaries || {},
            timestamp: Date.now()
        });
        log('Saved generated commentary to metadata');
    }

    // ============================================================
    // GENERATION
    // ============================================================

    async function generateDiscordChat() {
        if (!settings.enabled) {
            if (discordBar) discordBar.hide();
            return;
        }

        if (discordBar) discordBar.show();

        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return;

        const lastMessage = chat[chat.length - 1];

        if (lastMessage.is_user) {
            setStatus('<span style="color:var(--ec-accent);"><i class="fa-solid fa-keyboard fa-fade"></i> AI is typing...</span>');
            return;
        }

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
        jQuery(document).off('click', '#ec_cancel_btn').on('click', '#ec_cancel_btn', function(e) {
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
            const depth = Math.max(2, Math.min(20, settings.contextDepth || 4));
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
        let history = '';

        if (settings.includePastEchoChambers && metadata && metadata.messageCommentaries) {
            // Include past generated commentary
            for (let i = 0; i < historyMessages.length; i++) {
                const msg = historyMessages[i];
                const msgIndex = chat.indexOf(msg);
                history += `<message="${msgIndex}">\n${msg.name}: ${cleanMessage(msg.mes)}\n</message="${msgIndex}">\n`;

                // Add commentary if it exists for this message
                if (messageCommentaries[msgIndex]) {
                    history += `<commentary="${msgIndex}">\n${messageCommentaries[msgIndex]}\n</commentary="${msgIndex}">\n`;
                }
                if (i < historyMessages.length - 1) history += '\n';
            }
            log('Including past EchoChambers commentary');
        } else {
            // Just messages without past commentary
            history = historyMessages.map(msg => `${msg.name}: ${cleanMessage(msg.mes)}`).join('\n');
        }

        log('History messages:', historyMessages.map(m => ({ name: m.name, is_user: m.is_user })));

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

        // Simple system message
        const systemMessage = 'You are an excellent creator of fake chat feeds that react dynamically to the user\'s conversation context.';

        // Build dynamic prefix based on style type and mode
        let countInstruction = '';
        if (!isNarratorStyle) {
            if (settings.livestream) {
                countInstruction = `IMPORTANT: You MUST generate EXACTLY ${messageCount} chat messages from EXACTLY ${actualUserCount} different users. Each user can post multiple messages. Not fewer, not more - exactly ${messageCount} messages from ${actualUserCount} users.\n\n`;
            } else {
                countInstruction = `IMPORTANT: You MUST generate EXACTLY ${userCount} chat messages. Not fewer, not more - exactly ${userCount}.\n\n`;
            }
        }

        const truePrompt = `<story_context>
${history}
</story_context>

<instructions>
${countInstruction}${stylePrompt}
</instructions>

How do you react to the story context above?

Think about it first.

STRICTLY follow the format defined in the instruction. ${isNarratorStyle ? '' : settings.livestream ? `Output exactly ${messageCount} messages from ${actualUserCount} users.` : `Output exactly ${userCount} messages.`} Do NOT continue the story or roleplay as the characters. The created by you people are allowed to interact with each other over your generated feed. Do NOT output preamble like "Here are the messages". Just output the content directly.`;

        try {
            let result = '';

            if (settings.source === 'profile' && settings.preset) {
                // PROFILE GENERATION
                const cm = context.extensionSettings?.connectionManager;
                const profile = cm?.profiles?.find(p => p.name === settings.preset);
                if (!profile) throw new Error(`Profile '${settings.preset}' not found`);

                // Use ConnectionManagerRequestService
                if (!context.ConnectionManagerRequestService) throw new Error('ConnectionManagerRequestService not available');

                const messages = [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: truePrompt }
                ];

                log(`Generating with profile: ${profile.name}`);
                const response = await context.ConnectionManagerRequestService.sendRequest(
                    profile.id,
                    messages,
                    512, // max_tokens
                    {
                        stream: false,
                        signal: abortController.signal,
                        extractData: true,
                        includePreset: true,
                        includeInstruct: true
                    }
                );

                // Parse response
                if (response?.content) result = response.content;
                else if (typeof response === 'string') result = response;
                else if (response?.choices?.[0]?.message?.content) result = response.choices[0].message.content;
                else result = JSON.stringify(response);

            } else if (settings.source === 'ollama') {
                const baseUrl = settings.url.replace(/\/$/, '');
                let modelToUse = settings.model;
                if (!modelToUse) {
                    warn('No Ollama model selected');
                    return;
                }
                const response = await fetch(`${baseUrl}/api/generate`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: modelToUse,
                        system: systemMessage,
                        prompt: truePrompt,
                        stream: false,
                        options: { num_ctx: 2048, num_predict: 512, stop: ["</discordchat>"] }
                    }),
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`Ollama API Error(${response.status})`);
                const data = await response.json();
                result = data.response;
            } else if (settings.source === 'openai') {
                const baseUrl = settings.openai_url.replace(/\/$/, '');
                const targetEndpoint = `${baseUrl}/chat/completions`;

                const payload = {
                    model: settings.openai_model || 'local-model',
                    messages: [
                        { role: 'system', content: systemMessage },
                        { role: 'user', content: truePrompt }
                    ],
                    temperature: 0.7, max_tokens: 500, stream: false
                };

                const response = await fetch(targetEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: abortController.signal
                });
                if (!response.ok) throw new Error(`API Error: ${response.status}`);
                const data = await response.json();
                result = data.choices[0].message.content;
            } else {
                // Default ST generation using context
                const { generateRaw } = context;
                if (generateRaw) {
                    result = await generateRaw({ systemPrompt: systemMessage, prompt: truePrompt, streaming: false });
                } else {
                    throw new Error('generateRaw not available in context');
                }
            }

            // Check if generation was aborted before parsing
            if (abortController.signal.aborted || userCancelled) {
                log('Generation was cancelled, skipping result parsing');
                throw new Error('Generation cancelled by user');
            }

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
                    log('Livestream mode: queuing', messages.length, 'messages');

                    // Save to metadata for persistence
                    const lastMsgIndex = chat.length - 1;
                    const updatedCommentaries = { ...(messageCommentaries || {}) };
                    updatedCommentaries[lastMsgIndex] = cleanResult;
                    saveGeneratedCommentary(htmlBuffer, updatedCommentaries);

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

        } catch (err) {
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

        // Header Left - Toggle button and Live indicator
        const leftGroup = jQuery('<div class="ec_header_left"></div>');
        const toggleBtn = jQuery('<div class="ec_toggle_btn" title="Toggle On/Off"><i class="fa-solid fa-power-off"></i></div>');
        const liveIndicator = jQuery('<div class="ec_live_indicator" id="ec_live_indicator"><i class="fa-solid fa-circle"></i> LIVE</div>');
        leftGroup.append(toggleBtn).append(liveIndicator);

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

        // Hide panel completely if disabled
        if (!settings.enabled) {
            discordBar.hide();
        } else {
            discordBar.show();
        }

        updateToggleIcon();
    }

    function updateToggleIcon() {
        if (!discordBar) return;
        const btn = discordBar.find('.ec_toggle_btn i');
        // Icon shows collapse state, not enabled state
        if (settings.collapsed) {
            btn.removeClass('fa-power-off').addClass('fa-power-off');
            discordBar.find('.ec_toggle_btn').css('color', 'rgba(255, 255, 255, 0.4)');
        } else {
            btn.removeClass('fa-power-off').addClass('fa-power-off');
            discordBar.find('.ec_toggle_btn').css('color', 'var(--ec-accent)');
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

        // QuickBar Toggle - only toggles panel collapse state
        jQuery(document).on('click', '.ec_toggle_btn', function () {
            settings.collapsed = !settings.collapsed;

            // Immediately apply/remove collapsed class
            if (settings.collapsed) {
                discordBar.addClass('ec_collapsed');
            } else {
                discordBar.removeClass('ec_collapsed');
            }

            updateToggleIcon();
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
                // Position menu below the trigger
                const rect = trigger[0].getBoundingClientRect();
                menu.css({
                    position: 'fixed',
                    top: rect.bottom + 'px',
                    left: rect.left + 'px',
                    width: rect.width + 'px',
                    display: 'block'
                });
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
                if (settings.enabled) {
                    const styleObj = getAllStyles().find(s => s.val === val);
                    const styleName = styleObj ? styleObj.label : val;
                    if (typeof toastr !== 'undefined') toastr.info(`Style: ${styleName}`);
                    generateDebounced();
                }
            } else if (parent.hasClass('ec_layout_menu')) {
                settings.position = val;
                saveSettings();
                updateApplyLayout();
                jQuery('#discord_position').val(val);
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

        // Settings Panel Bindings
        jQuery('#discord_enabled').on('change', function () {
            settings.enabled = jQuery(this).prop('checked');
            saveSettings();
            updateApplyLayout();
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
            settings.position = jQuery(this).val();
            saveSettings();
            updateApplyLayout();
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

        // OpenAI Compatible - URL
        jQuery('#discord_openai_url').on('change', function () {
            settings.openai_url = jQuery(this).val();
            saveSettings();
            log('OpenAI URL:', settings.openai_url);
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
