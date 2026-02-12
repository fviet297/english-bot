require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');

// --- CẤU HÌNH ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const myChatId = process.env.MY_CHAT_ID;
const DATA_FILE = process.env.DATA_PATH || 'data.json';
const TTS_SPEED = 0.7; // Tốc độ đọc (0.25 đến 4.0). Dưới 1.0 là chậm, trên 1.0 là nhanh.

const bot = new TelegramBot(token, { polling: true });
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

// Cho phép cấu hình đường dẫn cache qua biến môi trường (để mount Volume trên Railway/Docker)
const AUDIO_CACHE_DIR = process.env.AUDIO_CACHE_DIR || process.env.AUDIO_CACHE_PATH || path.join(__dirname, 'audio_cache');

if (!fs.existsSync(AUDIO_CACHE_DIR)) {
    try {
        fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
    } catch (err) {
        console.error("Lỗi tạo thư mục cache:", err);
    }
}

// --- DUMMY SERVER CHO RENDER & UI ---
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));
app.use('/audio', express.static(AUDIO_CACHE_DIR));

// API: Lấy danh sách dữ liệu
app.get('/api/data', (req, res) => {
    const data = loadData();
    const dataWithHash = data.map(item => {
        const text = typeof item === 'string' ? item : item.text;
        const hash = crypto.createHash('md5').update(text + TTS_SPEED).digest('hex');
        return {
            ...(typeof item === 'string' ? { text: item } : item),
            audioUrl: `/audio/${hash}.mp3`
        };
    });
    res.json(dataWithHash);
});

// API: Dịch và lưu mới
app.post('/api/translate', async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Thiếu nội dung' });

    const translatedText = await translateToEnglish(text);
    if (!translatedText) return res.status(500).json({ error: 'Lỗi dịch thuật' });

    let currentData = loadData();
    const exists = currentData.some(item => (typeof item === 'string' ? item : item.text) === translatedText);

    if (!exists) {
        const newItem = { text: translatedText, lastSentAt: 0 };
        currentData.push(newItem);
        saveData(currentData);
        // Tạo audio sẵn luôn
        await sendPronunciation(null, translatedText);
        res.json({ success: true, data: newItem });
    } else {
        res.status(400).json({ error: 'Câu này đã tồn tại' });
    }
});

// API: Xoá một câu
app.delete('/api/delete/:index', (req, res) => {
    const idx = parseInt(req.params.index);
    let currentData = loadData();

    if (idx >= 0 && idx < currentData.length) {
        const item = currentData[idx];
        const content = typeof item === 'string' ? item : item.text;
        deleteAudioFile(content);
        currentData.splice(idx, 1);
        saveData(currentData);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Không tìm thấy' });
    }
});

// API: Xoá nhiều câu
app.post('/api/delete-multiple', (req, res) => {
    const { indices } = req.body;
    if (!Array.isArray(indices) || indices.length === 0) {
        return res.status(400).json({ error: 'Danh sách chỉ số không hợp lệ' });
    }

    let currentData = loadData();
    // Sắp xếp giảm dần để tránh lệch index khi xoá
    const sortedIndices = [...indices].sort((a, b) => b - a);
    let deletedCount = 0;

    sortedIndices.forEach(idx => {
        if (idx >= 0 && idx < currentData.length) {
            const item = currentData[idx];
            const content = typeof item === 'string' ? item : item.text;
            deleteAudioFile(content);
            currentData.splice(idx, 1);
            deletedCount++;
        }
    });

    saveData(currentData);
    res.json({ success: true, deletedCount });
});

// API: Xoá tất cả
app.delete('/api/clear', (req, res) => {
    clearAudioCache();
    saveData([]);
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server & UI running on port ${PORT}`));

// --- HÀM HỖ TRỢ ĐỌC/GHI FILE ---
function loadData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return [];
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Lỗi đọc file:", err);
        return [];
    }
}

function saveData(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error("Lỗi lưu file:", err);
    }
}

const ttsClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// --- HÀM DỊCH BẰNG OPENAI (OpenRouter) ---
async function translateToEnglish(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "openai/gpt-4.1-nano",
            messages: [
                {
                    role: "system",
                    content: "You are a professional translator. Translate the following text to English at a A2 (Beginner) level. Use simple and clear vocabulary, suitable for intermediate learners. Respond ONLY with the translated text and nothing else."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            temperature: 0.3,
        });
        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error("Lỗi OpenAI:", error);
        return null;
    }
}

// --- HÀM GỬI VOICE (OpenAI TTS) ---
// --- HÀM GỬI VOICE (OpenAI TTS + Caching) ---
async function sendPronunciation(chatId, text) {
    if (!text) return;
    try {
        // 1. Tạo tên file dựa trên hash nội dung (MD5) + tốc độ để cache
        const hash = crypto.createHash('md5').update(text + TTS_SPEED).digest('hex');
        const fileName = `${hash}.mp3`;
        const filePath = path.join(AUDIO_CACHE_DIR, fileName);

        // 2. Kiểm tra cache
        if (fs.existsSync(filePath)) {
            console.log(`[Cache Hit] Sử dụng audio có sẵn: ${fileName}`);
            const shortTitle = text.length > 50 ? text.substring(0, 47) + '...' : text;
            await bot.sendAudio(chatId, fs.createReadStream(filePath), {
                caption: text,
                title: shortTitle,
                performer: ''
            });
            return;
        }

        // 3. Nếu chưa có, gọi API
        console.log(`[Cache Miss] Đang tạo audio mới...`);
        const mp3 = await ttsClient.audio.speech.create({
            model: "tts-1",
            voice: "sage",
            input: text,
            speed: TTS_SPEED,
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());

        // 4. Lưu vào cache
        fs.writeFileSync(filePath, buffer);
        console.log(`[Cache Saved] Đã lưu: ${fileName}`);

        // 5. Gửi file từ cache
        // Thêm title để hiển thị tên đẹp trên thông báo thay vì tên file hash
        const shortTitle = text.length > 50 ? text.substring(0, 47) + '...' : text;

        // Chỉ gửi Telegram nếu có chatId
        if (chatId) {
            await bot.sendAudio(chatId, fs.createReadStream(filePath), {
                caption: text,
                title: shortTitle,
                performer: ''
            });
        }

        return filePath;

    } catch (err) {
        console.error("Lỗi gửi voice (OpenAI):", err);
        // Fallback: gửi text nếu voice lỗi
        if (chatId) await bot.sendMessage(chatId, text);
        return null;
    }
}

// --- HÀM XOÁ AUDIO TRONG CACHE ---
function deleteAudioFile(text) {
    if (!text) return;
    try {
        const hash = crypto.createHash('md5').update(text + TTS_SPEED).digest('hex');
        const fileName = `${hash}.mp3`;
        const filePath = path.join(AUDIO_CACHE_DIR, fileName);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[Cache Deleted] Đã xoá file: ${fileName}`);
        }
    } catch (err) {
        console.error("Lỗi khi xoá file audio:", err);
    }
}

function clearAudioCache() {
    try {
        if (fs.existsSync(AUDIO_CACHE_DIR)) {
            const files = fs.readdirSync(AUDIO_CACHE_DIR);
            for (const file of files) {
                fs.unlinkSync(path.join(AUDIO_CACHE_DIR, file));
            }
            console.log(`[Cache Cleared] Đã dọn dẹp toàn bộ thư mục audio_cache.`);
        }
    } catch (err) {
        console.error("Lỗi khi dọn dẹp cache:", err);
    }
}

// --- PHẦN 1: XỬ LÝ TIN NHẮN ĐẾN (DỊCH VÀ LƯU TRỮ) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/test') {
        sendDailyLesson();
        return;
    }

    if (text === '/start') {
        bot.sendMessage(chatId, `Xin chào! Hãy gửi câu bất kỳ, tôi sẽ dịch sang tiếng Anh và lưu lại.`);
        return;
    }

    if (text.startsWith('/voice')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
            bot.sendMessage(chatId, `⚠️ Cú pháp: \`/voice [số thứ tự]\`\n(Xem số thứ tự bằng lệnh \`/list\`)`, { parse_mode: 'Markdown' });
            return;
        }

        const idx = parseInt(parts[1]);
        if (isNaN(idx)) {
            bot.sendMessage(chatId, `⚠️ Số thứ tự không hợp lệ.`, { parse_mode: 'Markdown' });
            return;
        }

        const currentData = loadData();
        const arrayIdx = idx - 1;

        if (arrayIdx >= 0 && arrayIdx < currentData.length) {
            const item = currentData[arrayIdx];
            const content = typeof item === 'string' ? item : item.text;
            sendPronunciation(chatId, content);
        } else {
            bot.sendMessage(chatId, `⚠️ Không tìm thấy câu số ${idx}.`);
        }
        return;
    }

    if (text === '/list') {
        const currentData = loadData();
        if (currentData.length === 0) {
            bot.sendMessage(chatId, `📭 Kho dữ liệu hiện đang trống.`);
            return;
        }

        const listText = currentData.map((item, index) => {
            const content = typeof item === 'string' ? item : item.text;
            return `${index + 1}. ${content}`;
        }).join('\n');
        bot.sendMessage(chatId, `📚 *Danh sách câu đã lưu:*\n\n${listText}`, { parse_mode: 'Markdown' });
        return;
    }

    if (text.startsWith('/delete')) {
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
            bot.sendMessage(chatId, "⚠️ Vui lòng nhập số thứ tự cần xoá. VD: `/delete 1 3 5` hoặc `/delete 1,2,3`", { parse_mode: 'Markdown' });
            return;
        }

        // Lấy danh sách index, chuyển sang số, lọc bỏ cái không hợp lệ, sắp xếp giảm dần
        const indicesToDelete = text.replace('/delete', '')
            .split(/[\s,]+/)
            .map(p => parseInt(p.trim()))
            .filter(n => !isNaN(n))
            .sort((a, b) => b - a);

        if (indicesToDelete.length === 0) {
            bot.sendMessage(chatId, "⚠️ Không tìm thấy số thứ tự hợp lệ.");
            return;
        }

        let currentData = loadData();
        let deletedCount = 0;

        // Xoá từ dưới lên để không làm thay đổi index của các phần tử bên trên
        indicesToDelete.forEach(idx => {
            const arrayIdx = idx - 1;
            if (arrayIdx >= 0 && arrayIdx < currentData.length) {
                const item = currentData[arrayIdx];
                const content = typeof item === 'string' ? item : item.text;

                // Xoá file audio tương ứng trong cache
                deleteAudioFile(content);

                currentData.splice(arrayIdx, 1);
                deletedCount++;
            }
        });

        if (deletedCount > 0) {
            saveData(currentData);
            bot.sendMessage(chatId, `✅ Đã xoá ${deletedCount} câu. Hiện còn ${currentData.length} câu trong kho.`);
        } else {
            bot.sendMessage(chatId, "⚠️ Không tìm thấy vị trí nào tương ứng trong danh sách.");
        }
        return;
    }

    if (text === '/clear') {
        bot.sendMessage(chatId, "⚠️ Bạn có chắc chắn muốn xoá *TOÀN BỘ* dữ liệu không?", {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Có, xoá hết", callback_data: 'confirm_clear_all' },
                        { text: "❌ Không, huỷ bỏ", callback_data: 'cancel_clear' }
                    ]
                ]
            }
        });
        return;
    }

    if (!text) return;

    // bot.sendMessage(chatId, `⏳ Đang dịch và xử lý...`);

    // 1. Dịch sang tiếng Anh
    const translatedText = await translateToEnglish(text);

    if (!translatedText) {
        bot.sendMessage(chatId, `❌ Lỗi khi dịch nội dung. Vui lòng kiểm tra API Key.`);
        return;
    }

    // 2. Đọc dữ liệu cũ
    let currentData = loadData();

    // 3. Kiểm tra trùng lặp và lưu (Hỗ trợ cả String cũ và Object mới)
    const exists = currentData.some(item => {
        const itemText = typeof item === 'string' ? item : item.text;
        return itemText === translatedText;
    });

    if (!exists) {
        currentData.push({ text: translatedText, lastSentAt: 0 });
        saveData(currentData);
        // Gửi audio kèm caption (gộp text vào đây)
        await sendPronunciation(chatId, translatedText);
    } else {
        bot.sendMessage(chatId, `⚠️ Câu này đã có trong kho rồi!`);
    }
});

// --- PHẦN 1.1: XỬ LÝ XÁC NHẬN (CALLBACK QUERY) ---
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (query.data === 'confirm_clear_all') {
        // Xoá toàn bộ file trong cache
        clearAudioCache();

        saveData([]);
        bot.answerCallbackQuery(query.id, { text: "Đã xoá sạch kho dữ liệu và cache!" });
        bot.editMessageText("🗑️ *Đã xoá toàn bộ dữ liệu và file âm thanh.*", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
    } else if (query.data === 'cancel_clear') {
        bot.answerCallbackQuery(query.id, { text: "Đã huỷ thao tác." });
        bot.editMessageText("♻️ *Đã huỷ lệnh xoá tất cả.*", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
    }
});

// --- PHẦN 2: TỰ ĐỘNG GỬI THEO LỊCH ---
function sendDailyLesson() {
    let lessons = loadData();
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const now = Date.now();

    if (lessons.length === 0) {
        console.log("Kho dữ liệu trống.");
        return;
    }

    // Lọc những câu thỏa mãn: chưa gửi bao giờ HOẶC gửi cách đây > 2 giờ
    const availableLessons = lessons.filter(item => {
        const lastSentAt = typeof item === 'string' ? 0 : (item.lastSentAt || 0);
        return (now - lastSentAt) > TWO_HOURS;
    });

    if (availableLessons.length === 0) {
        console.log("Tất cả các câu đều đã được gửi trong 2h qua.");
        return;
    }

    const selectedItem = availableLessons[Math.floor(Math.random() * availableLessons.length)];
    const message = typeof selectedItem === 'string' ? selectedItem : selectedItem.text;

    // Thay vì gửi tin nhắn riêng, gọi luôn hàm gửi audio (có caption)
    sendPronunciation(myChatId, message)
        .then(async () => {
            // Cập nhật lastSentAt cho item đã chọn
            const index = lessons.findIndex(item => {
                const itemText = typeof item === 'string' ? item : item.text;
                return itemText === message;
            });

            if (index !== -1) {
                lessons[index] = { text: message, lastSentAt: now };
                saveData(lessons);
            }
        })
        .catch((error) => console.error('Lỗi gửi tin:', error));
}

// Lập lịch: Mỗi 30 phút từ 8h00 - 23h59
// Cron: minute hour dayOfMonth month dayOfWeek
cron.schedule('0,30 8-23 * * *', () => {
    console.log(`[${new Date().toLocaleTimeString()}] Đến giờ gửi bài...`);
    sendDailyLesson();
}, {
    scheduled: true,
    timezone: "Asia/Ho_Chi_Minh"
});

console.log("🤖 Bot dịch thuật & Gửi bài tự động đã chạy (8h-23h, 30p/lần)...");
