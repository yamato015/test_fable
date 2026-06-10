// 「いまここ！」課金バックエンド (Cloudflare Workers)
//
// DBを持たない軽量設計:
//   - 決済はStripe Checkout (サブスクリプション) に委譲
//   - 課金状態はHMAC署名付きライセンストークンとしてクライアントに渡し、
//     有効期限が近づいたらStripe APIでサブスク状態を再確認して再発行する
//
// 必要な環境変数 (wrangler.toml / wrangler secret):
//   STRIPE_SECRET_KEY ... Stripeのシークレットキー (secret)
//   LICENSE_SECRET    ... トークン署名用のランダム文字列 (secret)
//   APP_URL           ... アプリの公開URL (CORSと決済後リダイレクトに使用)
//   PRICE_MONTHLY     ... 月額プランのStripe Price ID
//   PRICE_YEARLY      ... 年額プランのStripe Price ID

"use strict";

const TOKEN_TTL_S = 30 * 24 * 3600; // ライセンストークンの有効期間 (30日)
const te = new TextEncoder();

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    const body = await request.json().catch(() => ({}));
    try {
      switch (new URL(request.url).pathname) {
        case "/api/checkout":
          return json(await checkout(env, body), 200, cors);
        case "/api/activate":
          return json(await activate(env, body), 200, cors);
        case "/api/refresh":
          return json(await refresh(env, body), 200, cors);
        case "/api/portal":
          return json(await portal(env, body), 200, cors);
        default:
          return json({ error: "not found" }, 404, cors);
      }
    } catch (e) {
      return json({ error: e.message }, e.status || 500, cors);
    }
  },
};

// ---- ハンドラ ----

// Stripe Checkoutセッションを作成し、決済ページURLを返す
async function checkout(env, { plan }) {
  const price = plan === "yearly" ? env.PRICE_YEARLY : env.PRICE_MONTHLY;
  if (!price) throw fail(500, "価格IDが設定されていません");
  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    locale: "ja",
    success_url: `${env.APP_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: env.APP_URL,
  });
  return { url: session.url };
}

// 決済完了後のリダイレクトで受け取ったsession_idを検証し、ライセンスを発行
async function activate(env, { session_id }) {
  if (!session_id) throw fail(400, "session_idが必要です");
  const session = await stripe(
    env,
    "GET",
    `/checkout/sessions/${encodeURIComponent(session_id)}`
  );
  if (session.payment_status !== "paid" || !session.subscription) {
    throw fail(402, "決済が完了していません");
  }
  return issueLicense(env, session.customer, session.subscription);
}

// 既存トークンの署名を検証し、Stripeでサブスクが生きていれば再発行
async function refresh(env, { token }) {
  const payload = await verifyToken(token, env.LICENSE_SECRET);
  const sub = await stripe(
    env,
    "GET",
    `/subscriptions/${encodeURIComponent(payload.sub)}`
  );
  // past_due (支払いリトライ中) は猶予としてプレミアムを維持する
  if (!["active", "trialing", "past_due"].includes(sub.status)) {
    throw fail(402, "サブスクリプションが有効ではありません");
  }
  return issueLicense(env, payload.cus, payload.sub);
}

// 解約・支払い方法変更のためのStripeカスタマーポータルURLを返す
async function portal(env, { token }) {
  const payload = await verifyToken(token, env.LICENSE_SECRET);
  const session = await stripe(env, "POST", "/billing_portal/sessions", {
    customer: payload.cus,
    return_url: env.APP_URL,
  });
  return { url: session.url };
}

// ---- Stripe API (SDK不使用・REST直叩き) ----

async function stripe(env, method, path, params) {
  let url = "https://api.stripe.com/v1" + path;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  };
  if (params && method === "GET") {
    url += "?" + new URLSearchParams(params);
  } else if (params) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(params).toString();
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw fail(502, data.error?.message || "Stripe APIエラー");
  return data;
}

// ---- ライセンストークン (HMAC-SHA256署名) ----

async function issueLicense(env, customerId, subscriptionId) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const token = await signToken(
    { cus: customerId, sub: subscriptionId, exp },
    env.LICENSE_SECRET
  );
  return { token, exp };
}

async function signToken(payload, secret) {
  const body = b64url(te.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), te.encode(body))
  );
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) throw fail(401, "トークンが不正です");
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    b64urlToBytes(sig),
    te.encode(body)
  );
  if (!ok) throw fail(401, "トークンが不正です");
  return JSON.parse(b64urlDecode(body));
}

function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

function b64urlToBytes(s) {
  return Uint8Array.from(b64urlDecode(s), (c) => c.charCodeAt(0));
}

// ---- ユーティリティ ----

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function corsHeaders(env) {
  let origin = "*";
  try {
    origin = new URL(env.APP_URL).origin;
  } catch {
    /* APP_URL未設定時は開発用にワイルドカード */
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
