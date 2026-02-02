require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const OpenAI = require('openai');

// --- CẤU HÌNH ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const myChatId = process.env.MY_CHAT_ID;
const DATA_FILE = process.env.DATA_PATH || 'data.json';

const bot = new TelegramBot(token, { polling: true });
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});

// --- DUMMY SERVER CHO RENDER ---
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

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

const googleTTS = require('google-tts-api');

// --- HÀM DỊCH BẰNG OPENAI ---
async function translateToEnglish(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "google/gemini-2.0-flash-001",
            messages: [
                {
                    role: "system",
                    content: "You are a professional translator. Translate the following text to English. Respond ONLY with the translated text and nothing else."
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

// --- HÀM GỬI VOICE ---
async function sendPronunciation(chatId, text) {
    if (!text) return;
    try {
        // google-tts-api limit is 200 chars. 
        // For simplicity in this bot (usually short sentences), we just take the first 200 chars or handle splitting if strictly needed.
        // But let's assume short sentences for now or let it truncate.
        const audioUrl = googleTTS.getAudioUrl(text, {
            lang: 'en',
            slow: true,
            host: 'https://translate.google.com',
        });
        await bot.sendAudio(chatId, audioUrl);
    } catch (err) {
        console.error("Lỗi gửi voice:", err);
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

    bot.sendMessage(chatId, `⏳ Đang dịch và xử lý...`);

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
        await bot.sendMessage(chatId, `${translatedText}`);
        // Gửi kèm audio
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
        saveData([]);
        bot.answerCallbackQuery(query.id, { text: "Đã xoá sạch kho dữ liệu!" });
        bot.editMessageText("🗑️ *Đã xoá toàn bộ dữ liệu trong kho.*", {
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

    bot.sendMessage(myChatId, message)
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
            // Gửi kèm audio
            await sendPronunciation(myChatId, message);
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
