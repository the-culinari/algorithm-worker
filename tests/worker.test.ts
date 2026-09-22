import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const request = (path: string, init?: RequestInit) => new Request(`https://algo.test${path}`, init);
const body = async (response: Response) => response.json() as Promise<any>;

describe("algorithm worker", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes health capabilities and handles CORS preflight", async () => {
    const env: Env = { AI: undefined };
    const health = await worker.fetch(request("/health"), env);
    const options = await worker.fetch(request("/anything", { method: "OPTIONS" }), env);

    expect(health.status).toBe(200);
    await expect(body(health)).resolves.toMatchObject({
      status: "ok",
      service: "culinari-algorithm-worker",
      version: "v2",
      features: { workers_ai_embeddings: false, upstash_redis: false, qdrant_vector_db: false },
    });
    expect(options.status).toBe(200);
    expect(options.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("protects algorithm routes when an API key is configured", async () => {
    const env = { AI: undefined, ALGO_API_KEY: "worker-secret" } as Env;

    const missing = await worker.fetch(request("/recommend", { method: "POST", body: "{}" }), env);
    const wrong = await worker.fetch(request("/recommend", { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" }), env);
    const valid = await worker.fetch(request("/recommend", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "user-1", limit: 5 }),
    }), env);

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(valid.status).toBe(200);
    await expect(body(valid)).resolves.toMatchObject({ user_id: "user-1", items: [] });
  });

  it("returns an explicit moderation fallback when Gemini is unavailable", async () => {
    const response = await worker.fetch(request("/moderation/food-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Jollof rice", description: "Recipe" }),
    }), { AI: undefined });

    expect(response.status).toBe(200);
    await expect(body(response)).resolves.toMatchObject({ is_food: true, confidence: 0.5 });
  });

  it("maps event types to Redis scores and reports the batch size", async () => {
    const redis = vi.fn(async () => new Response(JSON.stringify({ result: "OK" }), { status: 200 }));
    vi.stubGlobal("fetch", redis);
    const env = { AI: undefined, UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "redis-token" } as Env;
    const events = [
      { content_id: "a", event_type: "like" },
      { content_id: "b", event_type: "share" },
      { content_id: "c", event_type: "skip" },
    ];

    const response = await worker.fetch(request("/event/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(events),
    }), env);

    expect(response.status).toBe(200);
    await expect(body(response)).resolves.toEqual({ ok: true, count: 3 });
    expect(redis).toHaveBeenCalledTimes(3);
    const commands = redis.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(commands).toEqual([
      ["ZINCRBY", "trending_content", "1", "a"],
      ["ZINCRBY", "trending_content", "4", "b"],
      ["ZINCRBY", "trending_content", "-2", "c"],
    ]);
  });

  it("reads sorted trending items and applies the requested limit", async () => {
    const redis = vi.fn(async () => new Response(JSON.stringify({ result: ["a", "9.5", "b", "7"] }), { status: 200 }));
    vi.stubGlobal("fetch", redis);
    const env = { AI: undefined, UPSTASH_REDIS_REST_URL: "https://redis.test", UPSTASH_REDIS_REST_TOKEN: "redis-token" } as Env;

    const response = await worker.fetch(request("/feed/trending?limit=2"), env);

    expect(response.status).toBe(200);
    await expect(body(response)).resolves.toMatchObject({
      items: [{ content_id: "a", score: 9.5 }, { content_id: "b", score: 7 }],
    });
    expect(JSON.parse(String((redis.mock.calls[0][1] as RequestInit).body))).toEqual([
      "ZREVRANGE", "trending_content", "0", "1", "WITHSCORES",
    ]);
  });

  it("embeds content and indexes the vector in Qdrant", async () => {
    const ai = { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) };
    const network = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" })));
    vi.stubGlobal("fetch", network);
    const env = { AI: ai, QDRANT_URL: "https://qdrant.test", QDRANT_API_KEY: "qdrant-key" } as Env;

    const response = await worker.fetch(request("/embed/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_id: "article-1", title: "Jollof", tags: ["rice"] }),
    }), env);
    const result = await body(response);

    expect(response.status).toBe(200);
    expect(result).toMatchObject({ content_id: "article-1", vector_dimensions: 3, qdrant_indexed: true });
    expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-small-en-v1.5", { text: ["Jollof rice"] });
    expect(network).toHaveBeenCalledTimes(2);
    expect((network.mock.calls[1][1] as RequestInit).method).toBe("PUT");
  });

  it("returns ranked Qdrant recommendations with a stable AB bucket", async () => {
    const ai = { run: vi.fn(async () => ({ data: [[0.4, 0.5]] })) };
    const network = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [{ id: "point-1", score: 0.91, payload: { content_id: "article-1", title: "Jollof" } }] })));
    vi.stubGlobal("fetch", network);
    const env = { AI: ai, QDRANT_URL: "https://qdrant.test", QDRANT_API_KEY: "qdrant-key" } as Env;

    const response = await worker.fetch(request("/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "user-1", query_text: "rice", limit: 1 }),
    }), env);
    const result = await body(response);

    expect(response.status).toBe(200);
    expect(result.items).toEqual([{ content_id: "article-1", content_type: "video", score: 0.91, title: "Jollof" }]);
    expect(result.ab_bucket).toBeGreaterThanOrEqual(0);
    expect(result.ab_bucket).toBeLessThan(100);
  });

  it("returns JSON errors for unknown routes and malformed payloads", async () => {
    const unknown = await worker.fetch(request("/missing"), { AI: undefined });
    const malformed = await worker.fetch(request("/event", { method: "POST", body: "not-json" }), { AI: undefined });

    expect(unknown.status).toBe(404);
    expect((await body(unknown)).detail).toBe("Not Found");
    expect(malformed.status).toBe(500);
    expect((await body(malformed)).detail).toBeTruthy();
  });
});
