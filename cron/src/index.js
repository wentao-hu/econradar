'use strict';

/**
 * EconRadar 抓取调度器（Cloudflare Worker Cron）
 *
 * GitHub Actions 的 schedule 触发器对低频仓库极不守信：配置为每 15 分钟，
 * 实测实际触发间隔 4-8 小时，网页数据因此长时间停在旧快照。
 * 本 Worker 每 10 分钟调用一次 workflow_dispatch，让抓取与部署按时执行；
 * 网页与数据仍托管在 GitHub Pages，用户端不经过 Cloudflare。
 *
 * 需要 secret：GITHUB_TOKEN（fine-grained PAT，仅本仓库 Actions: Read and write）
 */

const REPO = 'wentao-hu/econradar';
const WORKFLOW = 'deploy-pages.yml';

async function dispatch(env) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'econradar-cron',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );
  const body = res.status === 204 ? '' : (await res.text()).slice(0, 200);
  console.log('[cron] workflow_dispatch', res.status, body);
  return res.status;
}

export default {
  async scheduled(controller, env) {
    await dispatch(env);
  },

  /** 手动触发入口：GET /trigger，便于部署后立刻验证 */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/trigger') {
      return new Response('econradar-cron', { status: 200 });
    }
    const status = await dispatch(env);
    return new Response(JSON.stringify({ status }), {
      status: status === 204 ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
