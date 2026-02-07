document.addEventListener('DOMContentLoaded', () => {
    const newTextInput = document.getElementById('new-text');
    const addBtn = document.getElementById('add-btn');
    const clearAllBtn = document.getElementById('clear-all-btn');
    const statusMsg = document.getElementById('status-msg');
    const loader = document.getElementById('loader');

    // Result Display Elements
    const welcomeMsg = document.getElementById('welcome-msg');
    const translationResult = document.getElementById('translation-result');
    const textDisplay = document.getElementById('text-display');
    const replayBtn = document.getElementById('replay-btn');

    // Modal Elements
    const modal = document.getElementById('modal');
    const confirmClearBtn = document.getElementById('confirm-clear');
    const cancelClearBtn = document.getElementById('cancel-clear');

    let isProcessing = false;
    let currentAudio = null;
    let lastAudioUrl = '';

    // Add New Sentence
    async function addSentence() {
        const text = newTextInput.value.trim();
        if (!text || isProcessing) return;

        isProcessing = true;
        setLoadingState(true);
        showStatus('Thinking...');

        try {
            const response = await fetch('/api/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            const result = await response.json();

            if (response.ok) {
                newTextInput.value = '';
                showResult(result.data.text);

                // Get audio URL (need to construct it since /api/translate might not return hash based URL directly yet)
                // Actually, the server creates it. Let's fetch data to get the latest item's audioUrl or just wait for server update.
                // For now, let's fetch all data to find the new item's audio URL (most reliable)
                await syncAndPlayLatest(result.data.text);

                showStatus('', '');
            } else {
                showStatus(result.error || 'Something went wrong', 'error');
            }
        } catch (error) {
            showStatus('Network error happened', 'error');
        } finally {
            isProcessing = false;
            setLoadingState(false);
            newTextInput.focus();
        }
    }

    async function syncAndPlayLatest(text) {
        try {
            const response = await fetch('/api/data');
            const data = await response.json();
            const item = data.find(i => i.text === text);
            if (item && item.audioUrl) {
                lastAudioUrl = item.audioUrl;
                playAudio(item.audioUrl);
            }
        } catch (e) {
            console.error('Error playing audio:', e);
        }
    }

    function showResult(text) {
        welcomeMsg.classList.add('hidden');
        translationResult.classList.remove('hidden');
        textDisplay.textContent = text;

        // Simple animation trigger
        textDisplay.style.animation = 'none';
        textDisplay.offsetHeight; // trigger reflow
        textDisplay.style.animation = null;
    }

    function playAudio(url) {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }
        currentAudio = new Audio(url);
        currentAudio.play();

        const icon = replayBtn.querySelector('i');
        icon.className = 'fas fa-spinner fa-spin';
        currentAudio.onplaying = () => icon.className = 'fas fa-volume-up';
        currentAudio.onended = () => icon.className = 'fas fa-volume-up';
        currentAudio.onerror = () => icon.className = 'fas fa-exclamation-triangle';
    }

    // Clear All
    async function clearAll() {
        modal.classList.add('hidden');
        loader.classList.remove('hidden');
        try {
            const response = await fetch('/api/clear', { method: 'DELETE' });
            if (response.ok) {
                welcomeMsg.classList.remove('hidden');
                translationResult.classList.add('hidden');
                showStatus('Library reset successfully', '');
            }
        } catch (error) {
            showStatus('Failed to clear library', 'error');
        } finally {
            loader.classList.add('hidden');
            newTextInput.focus();
        }
    }

    // Helpers
    function showStatus(msg, type = '') {
        statusMsg.textContent = msg;
        statusMsg.style.color = type === 'error' ? 'var(--danger)' : 'var(--text-muted)';
    }

    function setLoadingState(isLoading) {
        addBtn.disabled = isLoading;
        loader.classList.toggle('hidden', !isLoading);
        if (isLoading) {
            translationResult.classList.add('hidden');
        }
    }

    // Event Listeners
    addBtn.onclick = addSentence;
    newTextInput.onkeypress = (e) => { if (e.key === 'Enter') addSentence(); };
    replayBtn.onclick = () => lastAudioUrl && playAudio(lastAudioUrl);

    clearAllBtn.onclick = () => modal.classList.remove('hidden');
    cancelClearBtn.onclick = () => modal.classList.add('hidden');
    confirmClearBtn.onclick = clearAll;

    // Ensure focus on load
    newTextInput.focus();
});
