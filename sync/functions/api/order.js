'use strict';

/**
 * EconRadar 排序同步 API（Cloudflare Pages Functions + KV）
 *
 * GET  /api/order  -> { updatedAt, orders } 或 null
 * PUT  /api/order  -> 覆盖保存排序快照
 *
 * 网页托管在 GitHub Pages，跨域访问，因此所有响应都带 CORS 头。
 */

const STORAGE_KEY = 'order:default';
const MAX_BYTES = 64 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ env }) {
  const value = await env.ORDER_KV.get(STORAGE_KEY);
  return new Response(value || 'null', {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export async function onRequestPut({ request, env }) {
  const body = await request.text();
  if (body.length > MAX_BYTES) return json({ error: 'payload too large' }, 413);

  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    return json({ error: 'invalid json' }, 400);
  }
  if (
    !data ||
    typeof data !== 'object' ||
    typeof data.updatedAt !== 'number' ||
    !data.orders ||
    typeof data.orders !== 'object'
  ) {
    return json({ error: 'invalid payload' }, 400);
  }

  await env.ORDER_KV.put(STORAGE_KEY, JSON.stringify(data));
  return json({ ok: true, updatedAt: data.updatedAt });
}
