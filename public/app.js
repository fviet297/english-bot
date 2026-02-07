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

    // Library Elements
    const libraryBtn = document.getElementById('library-btn');
    const libraryModal = document.getElementById('library-modal');
    const libraryList = document.getElementById('library-list');
    const closeLibraryBtn = document.getElementById('close-library');
    const selectAllCb = document.getElementById('select-all-cb');
    const deleteSelectedBtn = document.getElementById('delete-selected-btn');
    const selectedCountSpan = document.getElementById('selected-count');

    // Confirmation Modal Elements
    const modal = document.getElementById('modal');
    const confirmClearBtn = document.getElementById('confirm-clear');
    const cancelClearBtn = document.getElementById('cancel-clear');

    let isProcessing = false;
    let currentAudio = null;
    let lastAudioUrl = '';
    let selectedIndices = new Set();
    let currentData = [];

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
        textDisplay.style.animation = 'none';
        textDisplay.offsetHeight;
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
    }

    // Library / History Logic
    async function openLibrary() {
        libraryModal.classList.remove('hidden');
        await fetchAndRenderLibrary();
    }

    async function fetchAndRenderLibrary() {
        try {
            const response = await fetch('/api/data');
            currentData = await response.json();
            selectedIndices.clear();
            renderLibraryItems();
            updateSelectedUI();
        } catch (error) {
            console.error('Error loading library:', error);
        }
    }

    function renderLibraryItems() {
        libraryList.innerHTML = '';
        if (currentData.length === 0) {
            libraryList.innerHTML = '<div style="text-align: center; padding: 3rem; color: var(--text-muted);">No history found.</div>';
            return;
        }

        currentData.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'library-item';
            div.innerHTML = `
                <label class="checkbox-container">
                    <input type="checkbox" data-index="${index}" ${selectedIndices.has(index) ? 'checked' : ''}>
                    <span class="checkmark"></span>
                </label>
                <div class="item-content">${item.text}</div>
                <button class="icon-btn play-item-btn" title="Play"><i class="fas fa-play"></i></button>
            `;

            const cb = div.querySelector('input');
            cb.onchange = (e) => {
                if (e.target.checked) selectedIndices.add(index);
                else selectedIndices.delete(index);
                updateSelectedUI();
            };

            div.querySelector('.play-item-btn').onclick = () => playAudio(item.audioUrl);

            libraryList.appendChild(div);
        });
    }

    function updateSelectedUI() {
        const count = selectedIndices.size;
        selectedCountSpan.textContent = count;
        deleteSelectedBtn.classList.toggle('hidden', count === 0);
        selectAllCb.checked = count === currentData.length && currentData.length > 0;
    }

    selectAllCb.onchange = (e) => {
        if (e.target.checked) {
            currentData.forEach((_, i) => selectedIndices.add(i));
        } else {
            selectedIndices.clear();
        }
        renderLibraryItems();
        updateSelectedUI();
    }

    async function deleteSelected() {
        if (!confirm(`Are you sure you want to delete ${selectedIndices.size} items?`)) return;

        try {
            const indices = Array.from(selectedIndices);
            const response = await fetch('/api/delete-multiple', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ indices })
            });

            if (response.ok) {
                await fetchAndRenderLibrary();
                showStatus('Items deleted successfully');
            }
        } catch (error) {
            showStatus('Failed to delete items', 'error');
        }
    }

    // Clear All (Global Reset)
    async function clearAll() {
        modal.classList.add('hidden');
        loader.classList.remove('hidden');
        try {
            const response = await fetch('/api/clear', { method: 'DELETE' });
            if (response.ok) {
                welcomeMsg.classList.remove('hidden');
                translationResult.classList.add('hidden');
                showStatus('Library reset successfully');
                if (!libraryModal.classList.contains('hidden')) fetchAndRenderLibrary();
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
        setTimeout(() => {
            if (statusMsg.textContent === msg) statusMsg.textContent = '';
        }, 3000);
    }

    function setLoadingState(isLoading) {
        addBtn.disabled = isLoading;
        loader.classList.toggle('hidden', !isLoading);
    }

    // Event Listeners
    addBtn.onclick = addSentence;
    newTextInput.onkeypress = (e) => { if (e.key === 'Enter') addSentence(); };
    replayBtn.onclick = () => lastAudioUrl && playAudio(lastAudioUrl);

    libraryBtn.onclick = openLibrary;
    closeLibraryBtn.onclick = () => libraryModal.classList.add('hidden');
    deleteSelectedBtn.onclick = deleteSelected;

    clearAllBtn.onclick = () => modal.classList.remove('hidden');
    cancelClearBtn.onclick = () => modal.classList.add('hidden');
    confirmClearBtn.onclick = clearAll;

    newTextInput.focus();
});
