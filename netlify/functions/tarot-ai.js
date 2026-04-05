const crypto = require('crypto');

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const AUTHORIZED_USERS = new Set(['friend_001', 'friend_002', 'friend_003']);

const BLOCKED_PATTERNS = [
    /hack|exploit|sql\s*inject|xss|csrf/i,
    /\b(malware|virus|phishing)\b/i,
    /政治|色情|赌博|毒品/i
];

function validateInput(question, cards) {
    if (!question || typeof question !== 'string') {
        return { valid: false, error: '问题不能为空' };
    }

    if (question.length > 500) {
        return { valid: false, error: '问题长度不能超过500个字符' };
    }

    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(question)) {
            return { valid: false, error: '请提出与塔罗占卜相关的问题' };
        }
    }

    if (!Array.isArray(cards) || cards.length === 0 || cards.length > 10) {
        return { valid: false, error: '牌卡数据无效' };
    }

    return { valid: true };
}

function checkRateLimit(clientId) {
    const now = Date.now();
    const record = rateLimitMap.get(clientId);

    if (!record) {
        rateLimitMap.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
    }

    if (now > record.resetTime) {
        rateLimitMap.set(clientId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
        return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
    }

    if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
        return {
            allowed: false,
            remaining: 0,
            retryAfter: Math.ceil((record.resetTime - now) / 1000)
        };
    }

    record.count++;
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - record.count };
}

function verifyUser(userId) {
    if (!userId) return false;
    return AUTHORIZED_USERS.has(userId) || userId.startsWith('user_');
}

function buildTarotPrompt(question, cards, spreadType) {
    const spreadName = {
        'single': '单张牌',
        'three': '三张牌阵（过去-现在-未来）',
        'celtic': '凯尔特十字六牌阵'
    };

    const cardsInfo = cards.map((card, index) => {
        const position = spreadType === 'celtic'
            ? ['现状', '阻碍', '基础', '过去', '未来', '建议'][index]
            : spreadType === 'three'
            ? ['过去', '现在', '未来'][index]
            : '当前状况';

        const orientation = card.isReversed ? '逆位' : '正位';
        const keywords = card.isReversed ? card.keywords.reversed.join('、') : card.keywords.upright.join('、');
        const meaning = card.isReversed ? card.reversed : card.upright;

        return `
【第${index + 1}张牌 - ${position}】
牌名：${card.name} (${card.nameEn})
方向：${orientation}
关键词：${keywords}
牌面含义：${meaning}`;
    }).join('\n');

    return `你是资深塔罗占卜师，精通78张韦特塔罗牌的解读。你需要结合东方哲学与现代心理学，为用户提供专业、温暖且富有洞察力的指引。

占卜阵型：${spreadName[spreadType] || '单张牌'}
用户问题：${question}

抽取的牌卡：
${cardsInfo}

请按以下框架进行解读：

1. 【牌面总览】
   - 分析各张牌的核心含义与象征
   - 阐述正逆位对解读的影响

2. 【牌卡组合】
   - 分析牌卡之间的关联与互动
   - 探讨牌阵位置与牌义的结合
   - 识别关键主题与能量流动

3. 【时空脉络】
   - 解读过去、现在、未来的能量演变
   - 揭示阻碍与支持因素

4. 【智慧指引】
   - 基于用户问题给出具体建议
   - 提供1-3个可行的行动方案
   - 指出需要注意的时机与方向

5. 【深层启示】
   - 提供超越表面解读的洞见
   - 融入东方智慧与心理学视角
   - 以温暖鼓励的语气结束

解读要求：
- 语言优美流畅，富有诗意与神秘感
- 避免过于技术性的术语，保持通俗易懂
- 结合直觉与理性，提供平衡的视角
- 关注用户的情感需求，给予正向支持
- 字数控制在300-500字`;
}

async function callAI(messages, apiKey) {
    const endpoint = process.env.VOLCENGINE_API_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    const model = process.env.VOLCENGINE_MODEL || 'doubao-seed-2-0-mini-260215';

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            max_tokens: 800,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error:', response.status, errorText);
        throw new Error(`API调用失败: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

exports.handler = async function(event, context) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-User-ID',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: '仅支持POST请求' })
        };
    }

    const clientId = event.headers['x-forwarded-for'] ||
                    event.headers['x-real-ip'] ||
                    'unknown';

    const rateCheck = checkRateLimit(clientId);
    if (!rateCheck.allowed) {
        return {
            statusCode: 429,
            headers: {
                ...headers,
                'X-RateLimit-Remaining': '0',
                'Retry-After': rateCheck.retryAfter.toString()
            },
            body: JSON.stringify({
                error: '请求过于频繁，请稍后再试',
                retryAfter: rateCheck.retryAfter
            })
        };
    }

    const userId = event.headers['x-user-id'];
    if (!verifyUser(userId)) {
        return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: '未授权访问，请联系网站管理员获取授权' })
        };
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: '请求格式错误' })
        };
    }

    const { question, cards, spreadType } = body;

    const validation = validateInput(question, cards);
    if (!validation.valid) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: validation.error })
        };
    }

    const apiKey = process.env.VOLCENGINE_API_KEY;
    if (!apiKey) {
        console.error('VOLCENGINE_API_KEY未配置');
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: '服务暂不可用，请稍后再试' })
        };
    }

    try {
        const systemPrompt = '你是一位经验丰富的塔罗占卜师，精通78张韦特塔罗牌。';
        const userPrompt = buildTarotPrompt(question, cards, spreadType);

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];

        const interpretation = await callAI(messages, apiKey);

        return {
            statusCode: 200,
            headers: {
                ...headers,
                'X-RateLimit-Remaining': rateCheck.remaining.toString()
            },
            body: JSON.stringify({
                success: true,
                interpretation,
                cards: cards.map(c => ({
                    name: c.name,
                    nameEn: c.nameEn,
                    isReversed: c.isReversed,
                    position: c.position
                })),
                timestamp: new Date().toISOString()
            })
        };
    } catch (error) {
        console.error('AI服务调用失败:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: '解读服务暂时不可用，请稍后再试',
                details: error.message
            })
        };
    }
};
