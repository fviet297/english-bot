require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const OpenAI = require('openai');

// --- CẤU HÌNH ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const myChatId = process.env.MY_CHAT_ID;
const DATA_FILE = 'data.json';

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

// --- PHẦN 1: XỬ LÝ TIN NHẮN ĐẾN (DỊCH VÀ LƯU TRỮ) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === '/start') {
        bot.sendMessage(chatId, `Xin chào! Hãy gửi câu bất kỳ, tôi sẽ dịch sang tiếng Anh và lưu lại.`);
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
    const currentData = loadData();

    // 3. Kiểm tra trùng lặp và lưu
    if (!currentData.includes(translatedText)) {
        currentData.push(translatedText);
        saveData(currentData);
        bot.sendMessage(chatId, `✅ Đã lưu tiếng Anh: "${translatedText}"\n(Tổng: ${currentData.length} câu)`);
    } else {
        bot.sendMessage(chatId, `⚠️ Câu này ("${translatedText}") đã có trong kho rồi!`);
    }
});

// --- PHẦN 2: TỰ ĐỘNG GỬI THEO LỊCH ---
function sendDailyLesson() {
    const lessons = loadData();

    if (lessons.length === 0) {
        console.log("Kho dữ liệu trống.");
        return;
    }

    const randomSentence = lessons[Math.floor(Math.random() * lessons.length)];

    const message = `
📝 Lesson: ${randomSentence}
`;

    bot.sendMessage(myChatId, message, { parse_mode: 'Markdown' })
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
