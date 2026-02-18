// supabase/functions/analyze-menu/index.ts
// 用 Claude Vision 辨識菜單圖片，回傳結構化 JSON
//
// 部署方式：
//   1. 安裝 Supabase CLI: npm i -g supabase
//   2. 登入: supabase login
//   3. 設定 API Key: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   4. 部署: supabase functions deploy analyze-menu --project-ref <your-project-ref>

import "https://deno.land/x/xhr@0.3.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: '未設定 ANTHROPIC_API_KEY' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { image_base64, image_url } = await req.json();

    if (!image_base64 && !image_url) {
      return new Response(JSON.stringify({ error: '請提供 image_base64 或 image_url' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 組裝 Claude API 訊息
    const imageContent = image_base64
      ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image_base64 } }
      : { type: "image", source: { type: "url", url: image_url } };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            imageContent,
            {
              type: "text",
              text: `請分析這張菜單圖片，提取所有菜品資料。

回傳 JSON 格式如下（不要加 markdown code block，直接回傳 JSON）：
{
  "store_name": "商店名稱（如果看得到）",
  "categories": [
    { "name": "分類名稱", "icon": "對應的 emoji（一個字）" }
  ],
  "items": [
    {
      "name": "品項名稱",
      "description": "描述（外文名/英文名/簡述，沒有就空字串）",
      "price": 數字（主要價格）,
      "category": "所屬分類名稱",
      "tags": ["推薦"或"熱銷"等標籤，沒有就空陣列],
      "sizes": [{"name":"尺寸名","price":數字}] 或 null（沒有尺寸選項就 null）,
      "options": [{"group":"選項組名","items":[{"name":"選項名","price":附加價格}]}] 或 []
    }
  ]
}

規則：
- price 填最高價（如有尺寸就填最大尺寸的價格）
- 如果有多種尺寸（大/小、L/M），放在 sizes 陣列
- 如果有選項（飲料選擇、加料等），放在 options
- 套餐如果含飲料選擇，把飲料選項放在 options
- tags 只放特別標記的（推薦、熱銷、新品、人氣等）
- 如果有劃掉的原價和特價，用特價作為 price
- 確保所有價格都是數字，不是字串`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: 'Claude API 錯誤: ' + errText }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const result = await response.json();
    const text = result.content?.[0]?.text || '';

    // 嘗試解析 JSON
    let menuData;
    try {
      // 移除可能的 markdown code block
      const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      menuData = JSON.parse(jsonStr);
    } catch {
      return new Response(JSON.stringify({ error: 'AI 回傳格式錯誤', raw: text }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, data: menuData }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
