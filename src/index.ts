export class AlgoServiceContainer {
  constructor(state: any, env: any) {}
  async fetch(request: Request) {
    return new Response("Container DO Disabled", { status: 404 });
  }
}

export interface Env {
  AI: any;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  ALGO_API_KEY?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === "/health" || path === "/") {
      return jsonResponse({
        status: "ok",
        service: "culinari-algorithm-worker",
        version: "v2",
        features: {
          gemini_moderation: true,
          workers_ai_embeddings: Boolean(env.AI),
          upstash_redis: Boolean(env.UPSTASH_REDIS_REST_URL),
          qdrant_vector_db: Boolean(env.QDRANT_URL)
        }
      }, 200, corsHeaders);
    }

    // Optional API Key Auth Middleware
    const authHeader = request.headers.get("Authorization");
    const requiredApiKey = env.ALGO_API_KEY;
    if (requiredApiKey) {
      if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== requiredApiKey) {
        return jsonResponse({ detail: "Invalid or missing authentication token" }, 401, corsHeaders);
      }
    }

    try {
      // 1. Food Check Moderation Endpoint (Gemini API)
      if (path === "/moderation/food-check" && method === "POST") {
        const body: any = await request.json();
        const title = body.title || "";
        const description = body.description || "";
        let imageBase64 = body.image_base64 || null;
        let mimeType = body.mime_type || "image/jpeg";

        if (body.image_url && !imageBase64) {
          try {
            const imgRes = await fetch(body.image_url);
            if (imgRes.ok) {
              const contentTypeHeader = imgRes.headers.get("content-type");
              if (contentTypeHeader && contentTypeHeader.startsWith("image/")) {
                mimeType = contentTypeHeader;
              }
              const arrayBuffer = await imgRes.arrayBuffer();
              imageBase64 = arrayBufferToBase64(arrayBuffer);
            }
          } catch (err) {
            console.error("Failed to fetch image URL:", err);
          }
        }

        const geminiApiKey = env.GEMINI_API_KEY;
        const geminiModel = env.GEMINI_MODEL || "gemini-flash-latest";

        if (!geminiApiKey) {
          return jsonResponse({
            is_food: true,
            confidence: 0.5,
            reason: "GEMINI_API_KEY is not configured yet in Worker secrets/environment."
          }, 200, corsHeaders);
        }

        const promptText = `You are a content moderation AI for "Culinari", a culinary and recipe social video/photo platform.
Analyze the following post title, description, and image (if provided).
Determine if the content is related to food, cooking, recipes, dining, beverages, or culinary arts.

Post Title: "${title}"
Post Description: "${description}"

Respond strictly in valid JSON format with three keys:
1. "is_food": boolean (true if culinary/food related, false if off-topic like cars, finance, sports, tech, hate speech, etc.)
2. "confidence": number (between 0.0 and 1.0)
3. "reason": string (brief 1-sentence explanation of your evaluation)`;

        const parts: any[] = [{ text: promptText }];

        if (imageBase64) {
          parts.push({
            inlineData: {
              mimeType: mimeType,
              data: imageBase64
            }
          });
        }

        const geminiPayload = {
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                is_food: { type: "BOOLEAN" },
                confidence: { type: "NUMBER" },
                reason: { type: "STRING" }
              },
              required: ["is_food", "confidence", "reason"]
            }
          }
        };

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiPayload)
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          console.error("Gemini API Error:", errText);
          return jsonResponse({ detail: `Gemini API error: HTTP ${geminiRes.status}` }, 502, corsHeaders);
        }

        const geminiData: any = await geminiRes.json();
        const responseText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) {
          return jsonResponse({ detail: "Empty response from Gemini API" }, 500, corsHeaders);
        }

        let parsed: any;
        try {
          parsed = JSON.parse(responseText);
        } catch (e) {
          parsed = { is_food: true, confidence: 0.5, reason: responseText };
        }

        return jsonResponse({
          is_food: Boolean(parsed.is_food),
          confidence: Number(parsed.confidence || 0),
          reason: String(parsed.reason || "No explanation provided")
        }, 200, corsHeaders);
      }

      // 2. Event Tracking Endpoint & Upstash Leaderboard Updates
      if ((path === "/event" || path === "/event/batch") && method === "POST") {
        const body: any = await request.json();
        const events = Array.isArray(body) ? body : [body];

        // Process event weights for trending leaderboard
        for (const evt of events) {
          const contentId = evt.content_id;
          const eventType = evt.event_type;
          if (!contentId || !eventType) continue;

          let weight = evt.weight || 1.0;
          if (eventType === "like") weight = 1.0;
          else if (eventType === "comment") weight = 2.0;
          else if (eventType === "save") weight = 3.0;
          else if (eventType === "share") weight = 4.0;
          else if (eventType === "watch_complete") weight = 2.5;
          else if (eventType === "skip" || eventType === "not_interested") weight = -2.0;

          // Increment content score in Upstash Redis Sorted Set
          if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
            await redisCommand(env, ["ZINCRBY", "trending_content", weight.toString(), contentId]);
          }
        }

        return jsonResponse({ ok: true, count: events.length }, 200, corsHeaders);
      }

      // 3. GET /trending Endpoint (Retrieves Top Trending Content from Upstash Redis)
      if ((path === "/trending" || path === "/feed/trending") && method === "GET") {
        const limit = Number(url.searchParams.get("limit") || 20);
        let trendingItems: { content_id: string; score: number }[] = [];

        if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
          // ZREVRANGE trending_content 0 (limit - 1) WITHSCORES
          const redisRes = await redisCommand(env, ["ZREVRANGE", "trending_content", "0", (limit - 1).toString(), "WITHSCORES"]);
          if (Array.isArray(redisRes?.result)) {
            const raw: string[] = redisRes.result;
            for (let i = 0; i < raw.length; i += 2) {
              trendingItems.push({
                content_id: raw[i],
                score: parseFloat(raw[i + 1] || "0")
              });
            }
          }
        }

        return jsonResponse({
          ok: true,
          algo_version: "v2-redis-trending",
          items: trendingItems
        }, 200, corsHeaders);
      }

      // 4. Embed Content Endpoint (Workers AI + Qdrant Cloud Vector Indexing)
      if (path === "/embed/content" && method === "POST") {
        const body: any = await request.json();
        const contentId = body.content_id;
        const textToEmbed = [body.title, body.caption, body.description, body.cuisine, ...(body.tags || [])].filter(Boolean).join(" ");
        let vector: number[] | null = null;

        if (textToEmbed && env.AI) {
          try {
            const aiRes = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [textToEmbed] });
            vector = aiRes?.data?.[0] || null;
          } catch (aiErr) {
            console.error("Workers AI embedding error:", aiErr);
          }
        }

        // Upsert vector into Qdrant Cloud collection "culinari_content"
        let qdrantUpsertOk = false;
        if (vector && contentId && env.QDRANT_URL && env.QDRANT_API_KEY) {
          await ensureQdrantCollection(env);
          const qdrantRes = await qdrantRequest(env, "/collections/culinari_content/points", "PUT", {
            points: [
              {
                id: hashStringToUuid(contentId),
                vector: vector,
                payload: {
                  content_id: contentId,
                  content_type: body.content_type || "video",
                  creator_id: body.creator_id || "",
                  cuisine: body.cuisine || "",
                  title: body.title || ""
                }
              }
            ]
          });
          qdrantUpsertOk = qdrantRes?.status === "ok";
        }

        return jsonResponse({
          ok: true,
          content_id: contentId,
          vector_dimensions: vector ? vector.length : 0,
          qdrant_indexed: qdrantUpsertOk
        }, 200, corsHeaders);
      }

      // 5. Recommend Endpoint (Qdrant Vector Similarity Search)
      if (path === "/recommend" && method === "POST") {
        const body: any = await request.json();
        const userId = body.user_id || "anonymous";
        const limit = body.limit || 20;
        let recommendedItems: any[] = [];

        // If query_text is passed or we generate a default vector
        const queryText = body.query_text || body.cuisine || "popular recipe video";
        let queryVector: number[] | null = null;

        if (queryText && env.AI) {
          try {
            const aiRes = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [queryText] });
            queryVector = aiRes?.data?.[0] || null;
          } catch (aiErr) {
            console.error("Workers AI query vector error:", aiErr);
          }
        }

        if (queryVector && env.QDRANT_URL && env.QDRANT_API_KEY) {
          await ensureQdrantCollection(env);
          const searchRes = await qdrantRequest(env, "/collections/culinari_content/points/search", "POST", {
            vector: queryVector,
            limit: limit,
            with_payload: true
          });

          if (Array.isArray(searchRes?.result)) {
            recommendedItems = searchRes.result.map((pt: any) => ({
              content_id: pt.payload?.content_id || pt.id,
              content_type: pt.payload?.content_type || "video",
              score: pt.score,
              title: pt.payload?.title || ""
            }));
          }
        }

        const abBucket = Math.abs(hashString(userId)) % 100;
        return jsonResponse({
          user_id: userId,
          algo_version: "v2-qdrant-vector",
          ab_bucket: abBucket,
          items: recommendedItems
        }, 200, corsHeaders);
      }

      return jsonResponse({ detail: "Not Found" }, 404, corsHeaders);

    } catch (err: any) {
      console.error("Worker Error:", err);
      return jsonResponse({ detail: err.message || "Internal Server Error" }, 500, corsHeaders);
    }
  }
};

// Helper Functions
function jsonResponse(data: any, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

function hashStringToUuid(str: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)) {
    return str.toLowerCase();
  }
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0xfae12345, h4 = 0x12345678;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 2246822507);
    h4 = Math.imul(h4 ^ ch, 3266489917);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(4, "0").slice(0, 4);
  const hex3 = (h3 >>> 0).toString(16).padStart(4, "0").slice(0, 4);
  const hex4 = (h4 >>> 0).toString(16).padStart(4, "0").slice(0, 4);
  const part1 = ((h1 ^ h4) >>> 0).toString(16).padStart(8, "0");
  const part2 = ((h2 ^ h3) >>> 0).toString(16).padStart(4, "0").slice(0, 4);
  const hex5 = (part1 + part2).slice(0, 12);
  return `${hex1}-${hex2}-4${hex3.slice(1)}-8${hex4.slice(1)}-${hex5}`;
}

async function redisCommand(env: Env, command: string[]): Promise<any> {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command)
    });
    return await res.json();
  } catch (err) {
    console.error("Upstash Redis error:", err);
    return null;
  }
}

async function qdrantRequest(env: Env, path: string, method: string = "GET", body: any = null): Promise<any> {
  if (!env.QDRANT_URL || !env.QDRANT_API_KEY) return null;
  try {
    const options: any = {
      method,
      headers: {
        "api-key": env.QDRANT_API_KEY,
        "Content-Type": "application/json"
      }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${env.QDRANT_URL}${path}`, options);
    return await res.json();
  } catch (err) {
    console.error("Qdrant Cloud error:", err);
    return null;
  }
}

async function ensureQdrantCollection(env: Env) {
  const getRes: any = await qdrantRequest(env, "/collections/culinari_content");
  if (getRes?.status !== "ok") {
    await qdrantRequest(env, "/collections/culinari_content", "PUT", {
      vectors: {
        size: 384,
        distance: "Cosine"
      }
    });
  }
}
