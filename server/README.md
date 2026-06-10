# 課金バックエンド (Cloudflare Workers + Stripe)

「いまここ！」のプレミアム課金を処理する軽量バックエンドです。
**データベース不要**: 課金状態はStripeを正として、HMAC署名付きライセンス
トークンをクライアントに渡し、30日ごとにStripe APIで再検証・再発行します。

## API

| エンドポイント | 役割 |
|---|---|
| `POST /api/checkout` | `{plan: "monthly"\|"yearly"}` → Stripe Checkout URLを返す |
| `POST /api/activate` | 決済後の`session_id`を検証してライセンストークンを発行 |
| `POST /api/refresh`  | トークンを検証し、サブスクが有効なら再発行 |
| `POST /api/portal`   | 解約・カード変更用のStripeカスタマーポータルURLを返す |

## デプロイ手順

### 1. Stripe側の準備

1. [Stripeダッシュボード](https://dashboard.stripe.com/)で商品「いまここ！プレミアム」を作成
2. 価格を2つ追加: 月額 ¥240(recurring) と 年額 ¥1,800(recurring)
3. それぞれの **Price ID** (`price_...`) を控える
4. **開発者 → APIキー** からシークレットキー (`sk_...`) を控える
   （動作確認はテストモードのキーで行う）
5. **設定 → Billing → カスタマーポータル** を有効化（解約導線に必要）

### 2. Workerのデプロイ

```bash
cd server
npm install -g wrangler   # 未導入の場合
wrangler login

# wrangler.toml の APP_URL / PRICE_MONTHLY / PRICE_YEARLY を書き換える

wrangler secret put STRIPE_SECRET_KEY   # sk_... を入力
wrangler secret put LICENSE_SECRET      # openssl rand -hex 32 の出力などを入力
wrangler deploy
```

デプロイ後に表示されるURL (`https://imakoko-billing.<account>.workers.dev`) を
アプリ側の `config.js` の `backendUrl` に設定すれば課金が有効になります。

## セキュリティ上の注意

- `STRIPE_SECRET_KEY` と `LICENSE_SECRET` は必ず `wrangler secret` で登録し、
  リポジトリにコミットしない
- ライセンストークンは署名済みのため改ざんできず、期限切れ後は
  Stripe上のサブスク状態が有効でないと再発行されない
- 端末をまたぐ復元（機種変更）は現状非対応。必要になったら
  Stripeの`customer_email`を使った再ログイン導線を追加する

## 将来の拡張

- Stripe Webhook (`customer.subscription.deleted` 等) で即時失効を反映
  （現状は最大30日のトークン期限で自然失効）
- KVを追加してレート制限・監査ログを実装
